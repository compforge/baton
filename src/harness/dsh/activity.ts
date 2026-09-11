import { JsonRpcResponseError, type HarnessClient, type HarnessNotification, type NotificationSubscription, type SdkPromptContentBlock } from "@deepseek-ai/dsh-sdk-client";

export type DshTransport = Pick<HarnessClient, "prompt" | "subscribeSessionTree">;
type Delivery = "applied" | "failed" | "uncertain";
interface PendingInput { messageId: string; steer: boolean; nativeId?: string }

/** One Baton turn can contain several DSH inbox messages; only their receipts prove consumption. */
export class DshActivity {
  readonly done: Promise<void>;
  private resolve!: () => void;
  private reject!: (error: unknown) => void;
  private readonly subscription: NotificationSubscription;
  private readonly pending = new Set<PendingInput>();
  private readonly receipts = new Map<string, HarnessNotification>();
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
      this.applyReceipt(input);
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

  private applyReceipt(input: PendingInput): void {
    const receipt = input.nativeId ? this.receipts.get(input.nativeId) : undefined;
    if (!receipt) return;
    this.pending.delete(input);
    if (input.steer) this.delivery(input.messageId, "applied", undefined, receipt);
  }

  private async collect(): Promise<void> {
    try {
      for await (const notification of this.subscription) {
        if (this.settled) return;
        const params = notification.params;
        if (params.sessionId === this.sessionId) {
          if (notification.method === "session.event") {
            const event = params.event as { type?: string; data?: { inserted?: Array<{ id?: string }> } } | undefined;
            if (event?.type === "agent/inbox/spliced") {
              this.idle = false;
              for (const message of event.data?.inserted ?? []) {
                if (typeof message.id === "string") this.receipts.set(message.id, notification);
              }
              for (const input of this.pending) this.applyReceipt(input);
            }
          } else if (notification.method === "session.status") {
            this.idle = params.status === "idle";
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
