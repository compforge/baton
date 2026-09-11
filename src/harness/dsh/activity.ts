import { JsonRpcResponseError, type HarnessClient, type HarnessNotification, type NotificationSubscription, type SdkPromptContentBlock } from "@deepseek-ai/dsh-sdk-client";

export type DshTransport = Pick<HarnessClient, "prompt" | "subscribeSessionTree">;
type Delivery = "applied" | "failed" | "uncertain";
interface PendingInput { messageId: string; steer: boolean; nativeId?: string }
type InboxTarget = "next-turn" | "next-step";

/**
 * One Baton turn can contain several DSH inbox messages; only their receipts prove consumption.
 *
 * @spec Durable inbox insertion keeps a steer pending; only a claimed entry that reaches
 * user/message is applied. A claimed entry missing at idle is failed instead of hanging.
 * @see {@link ../../../docs/harness/deepseek-harness.md}
 */
export class DshActivity {
  readonly done: Promise<void>;
  private resolve!: () => void;
  private reject!: (error: unknown) => void;
  private readonly subscription: NotificationSubscription;
  private readonly pending = new Set<PendingInput>();
  private readonly receipts = new Map<string, HarnessNotification>();
  private readonly failedReceipts = new Map<string, string>();
  private readonly inbox: Record<InboxTarget, Array<string | undefined>> = {
    "next-turn": [],
    "next-step": [],
  };
  private readonly claimed: Array<string | undefined> = [];
  private idle = false;
  private settled = false;
  private started = false;

  constructor(
    private readonly client: DshTransport,
    private readonly sessionId: string,
    private readonly notify: (event: HarnessNotification) => void,
    private readonly delivery: (messageId: string, state: Delivery, detail?: string, raw?: HarnessNotification) => void,
  ) {
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.subscription = client.subscribeSessionTree(sessionId);
    void this.collect();
  }

  submit(messageId: string, blocks: SdkPromptContentBlock[], steer: boolean): void {
    if (this.settled) throw new Error("DSH activity has already ended");
    this.started = true;
    const input: PendingInput = { messageId, steer };
    this.pending.add(input);
    // The notification can precede the RPC response containing its native message ID.
    void this.client.prompt(this.sessionId, blocks).then((nativeId) => {
      if (this.settled) return;
      input.nativeId = nativeId;
      this.settleReceipt(input);
      this.finishIfIdle();
    }, (error: unknown) => {
      if (this.settled) return;
      if (steer && error instanceof JsonRpcResponseError) {
        this.pending.delete(input);
        this.delivery(messageId, "failed", error.message);
        this.finishIfIdle();
      } else {
        this.fail(error);
      }
    });
  }

  abandon(detail: string): void {
    for (const input of this.pending) {
      if (input.steer) this.delivery(input.messageId, "uncertain", detail);
    }
    this.pending.clear();
    this.subscription.close();
  }

  private settleReceipt(input: PendingInput): void {
    const failure = input.nativeId ? this.failedReceipts.get(input.nativeId) : undefined;
    if (failure) {
      this.pending.delete(input);
      if (input.steer) this.delivery(input.messageId, "failed", failure);
      return;
    }
    const receipt = input.nativeId ? this.receipts.get(input.nativeId) : undefined;
    if (!receipt) return;
    this.pending.delete(input);
    if (input.steer) this.delivery(input.messageId, "applied", undefined, receipt);
  }

  /**
   * DSH persists inbox insertion before admission. Only the later pure deletion
   * claims a batch for a step, and the following user/message makes one claimed
   * entry model-visible. Keep that distinction so Baton's Queue does not retire
   * an input merely because DSH durably queued it.
   */
  private observeSessionEvent(notification: HarnessNotification): void {
    const event = notification.params.event;
    if (event === null || typeof event !== "object" || Array.isArray(event)) return;
    const envelope = event as Record<string, unknown>;
    const data = envelope.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return;
    const payload = data as Record<string, unknown>;

    if (envelope.type === "agent/inbox/spliced") {
      const target = payload.target;
      const start = payload.start;
      const removedCount = payload.removedCount ?? 0;
      if (
        (target !== "next-turn" && target !== "next-step") ||
        typeof start !== "number" ||
        !Number.isSafeInteger(start) ||
        start < 0 ||
        typeof removedCount !== "number" ||
        !Number.isSafeInteger(removedCount) ||
        removedCount < 0
      ) return;
      const queue = this.inbox[target];
      while (queue.length < start + removedCount) {
        queue.push(undefined);
      }
      const inserted = Array.isArray(payload.inserted)
        ? payload.inserted.map((candidate) => {
          if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
            return undefined;
          }
          const id = (candidate as Record<string, unknown>).id;
          return typeof id === "string" ? id : undefined;
        })
        : [];
      const removed = queue.splice(start, removedCount, ...inserted);
      if (
        removed.length > 0 &&
        inserted.length === 0 &&
        payload.outcome === undefined
      ) {
        this.claimed.push(...removed);
      }
      return;
    }

    if (envelope.type !== "user/message") return;
    const nativeId = this.claimed.shift();
    if (!nativeId) return;
    this.receipts.set(nativeId, notification);
    for (const input of this.pending) this.settleReceipt(input);
  }

  private failUnappliedClaims(): void {
    if (this.claimed.length === 0) return;
    const detail = "DSH claimed the input but ended before it became model-visible";
    for (const nativeId of this.claimed.splice(0)) {
      if (nativeId) this.failedReceipts.set(nativeId, detail);
    }
    for (const input of this.pending) this.settleReceipt(input);
  }

  private async collect(): Promise<void> {
    try {
      for await (const notification of this.subscription) {
        if (this.settled) return;
        const params = notification.params;
        if (params.sessionId === this.sessionId) {
          if (notification.method === "session.event") {
            this.observeSessionEvent(notification);
            this.idle = false;
          } else if (notification.method === "session.status") {
            this.idle = params.status === "idle";
            if (this.idle) this.failUnappliedClaims();
          }
        }
        this.notify(notification);
        this.finishIfIdle();
        if (this.settled) return;
      }
      this.fail(new Error("DSH notification stream ended before idle"));
    } catch (error) {
      this.fail(error);
    }
  }

  private finishIfIdle(): void {
    if (this.settled || !this.started || !this.idle || this.pending.size !== 0) return;
    this.settled = true;
    this.subscription.close();
    this.resolve();
  }

  private fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.reject(error);
  }
}
