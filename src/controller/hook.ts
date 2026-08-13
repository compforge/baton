import type {
  HarnessDelivery,
  HarnessEventDraft,
  HarnessEventRecord,
  HookStage,
  HookSubjectMap,
} from "@compforge/baton-plugin";

import type {
  HarnessSessionHandle,
  PromptInput,
  SendTurnReceipt,
} from "../harness/adapter.ts";
import type { AnyEventDraft, AnyEventEnvelope } from "../event/types.ts";
import type { HarnessBinding } from "../harness/binding.ts";
import { logError, type LogSink } from "../logging.ts";

type HarnessHookStage = Extract<HookStage, `harness.${string}`>;

/** Narrow Hook notification boundary used by Controller without owning Plugin Manager. */
export interface HarnessHookGateway {
  has(stage: HarnessHookStage): boolean;
  before<S extends Extract<HarnessHookStage, `${string}.before`>>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): Promise<void>;
  after<S extends Extract<HarnessHookStage, `${string}.after`>>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): void;
}

interface HarnessHookCoordinatorOptions {
  readonly gateway?: HarnessHookGateway;
  readonly append: (
    binding: HarnessBinding,
    event: AnyEventDraft,
  ) => AnyEventEnvelope;
  readonly log: LogSink;
}

/** Owns Harness Hook correlation, fail-open delivery, and ordered event intake. */
export class HarnessHookCoordinator {
  private readonly inboundQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: HarnessHookCoordinatorOptions) {}

  delivery(
    binding: HarnessBinding,
    input: PromptInput,
    attemptId: string,
    operation: HarnessDelivery["operation"],
  ): HarnessDelivery {
    return Object.freeze({
      attemptId,
      harnessTargetId: binding.target.id,
      laneId: binding.laneId,
      turnId: input.turnId,
      messageId: input.messageId,
      operation,
    });
  }

  beforeDelivery(delivery: HarnessDelivery): Promise<void> | undefined {
    if (!this.has("harness.outbound.before")) return undefined;
    return this.before("harness.outbound.before", delivery);
  }

  async send(
    binding: HarnessBinding,
    ref: HarnessSessionHandle,
    input: PromptInput,
    attemptId: string,
    operation: HarnessDelivery["operation"],
    notifyBefore = true,
  ): Promise<SendTurnReceipt> {
    const delivery = this.delivery(binding, input, attemptId, operation);
    const before = notifyBefore ? this.beforeDelivery(delivery) : undefined;
    if (before) await before;
    try {
      const receipt = await binding.adapter.sendTurn(ref, input);
      this.after("harness.outbound.after", Object.freeze({
        ...delivery,
        outcome: receipt.accepted ? "accepted" : "rejected",
        ...(receipt.accepted || !receipt.reason ? {} : { reason: receipt.reason }),
      }));
      return receipt;
    } catch (error) {
      this.after("harness.outbound.after", Object.freeze({
        ...delivery,
        outcome: "error",
        reason: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }
  }

  acceptEvent(binding: HarnessBinding, event: AnyEventDraft): void {
    const draft: HarnessEventDraft = Object.freeze({
      kind: event.kind,
      harnessTargetId: binding.target.id,
      laneId: binding.laneId,
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    });
    if (!this.has("harness.inbound.before")) {
      this.persistEvent(binding, event, draft);
      return;
    }

    // EventSink stays synchronous for Adapter authors. Preserve native order
    // with one bounded async chain per binding; unrelated Lanes remain independent.
    const key = `${binding.laneId}\0${binding.target.id}`;
    const previous = this.inboundQueues.get(key) ?? Promise.resolve();
    const queued = previous
      .catch(() => {})
      .then(async () => {
        await this.before("harness.inbound.before", draft);
        this.persistEvent(binding, event, draft);
      });
    this.inboundQueues.set(key, queued);
    void queued.then(
      () => this.finishInbound(key, queued),
      (error) => {
        this.options.log({
          level: "error",
          source: "baton",
          component: "controller.hook",
          harness: binding.adapter.harness,
          harnessTargetId: binding.target.id,
          message: "harness inbound event persistence failed",
          error: logError(error),
        });
        this.finishInbound(key, queued);
      },
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.inboundQueues.values()]);
  }

  private persistEvent(
    binding: HarnessBinding,
    event: AnyEventDraft,
    draft: HarnessEventDraft,
  ): void {
    const envelope = this.options.append(binding, event);
    const record: HarnessEventRecord = Object.freeze({
      ...draft,
      eventId: envelope.eventId,
      seq: envelope.seq,
    });
    this.after("harness.inbound.after", record);
  }

  private finishInbound(key: string, queued: Promise<void>): void {
    if (this.inboundQueues.get(key) === queued) this.inboundQueues.delete(key);
  }

  private has(stage: HarnessHookStage): boolean {
    try {
      return this.options.gateway?.has(stage) ?? false;
    } catch (error) {
      this.logFailure(stage, error);
      return false;
    }
  }

  private async before<S extends Extract<HarnessHookStage, `${string}.before`>>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): Promise<void> {
    try {
      await this.options.gateway?.before(stage, subject);
    } catch (error) {
      this.logFailure(stage, error);
    }
  }

  private after<S extends Extract<HarnessHookStage, `${string}.after`>>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): void {
    try {
      this.options.gateway?.after(stage, subject);
    } catch (error) {
      this.logFailure(stage, error);
    }
  }

  private logFailure(stage: HarnessHookStage, error: unknown): void {
    this.options.log({
      level: "warn",
      source: "baton",
      component: "controller.hook",
      message: "Harness Hook gateway failed open",
      error: logError(error),
      attributes: { stage },
    });
  }
}
