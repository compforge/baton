import type {
  HarnessDelivery,
  HarnessEventRecord,
  HookStage,
  HookSubjectMap,
} from "@compforge/baton-plugin";

import type {
  HarnessSessionHandle,
  PromptInput,
  SendTurnReceipt,
} from "../harness/adapter.ts";
import type { AnyEventDraft, AnyEventEnvelope } from "../event/index.ts";
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
    if (!this.has("harness.inbound.before")) return undefined;
    return this.before("harness.inbound.before", delivery);
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
      this.after("harness.inbound.after", Object.freeze({
        ...delivery,
        outcome: receipt.accepted ? "accepted" : "rejected",
        ...(receipt.accepted || !receipt.reason ? {} : { reason: receipt.reason }),
      }));
      return receipt;
    } catch (error) {
      this.after("harness.inbound.after", Object.freeze({
        ...delivery,
        outcome: "error",
        reason: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }
  }

  acceptEvent(binding: HarnessBinding, event: AnyEventDraft): void {
    // BatonSession records and reduces the Harness output before Plugin
    // notification. Hooks can emit Verbs, so notifying them first would allow
    // durable effects whose triggering Harness fact was lost on crash.
    const envelope = this.options.append(binding, event);
    const record: HarnessEventRecord = Object.freeze({
      kind: event.kind,
      harnessTargetId: binding.target.id,
      laneId: binding.laneId,
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      eventId: envelope.eventId,
      seq: envelope.seq,
    });
    if (!this.has("harness.outbound.before")) {
      this.after("harness.outbound.after", record);
      return;
    }
    void this.before("harness.outbound.before", record)
      .finally(() => this.after("harness.outbound.after", record));
  }

  async close(): Promise<void> {}

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
