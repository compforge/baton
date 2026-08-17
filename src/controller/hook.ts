import type {
  BatonEventReference,
  HarnessInputDispatch,
  HookStage,
  HookSubjectMap,
} from "@compforge/baton-plugin";

import type {
  HarnessEvent,
  HarnessSessionHandle,
  PromptInput,
  SendTurnReceipt,
} from "../harness/adapter.ts";
import type { AnyEventEnvelope } from "../event/index.ts";
import type { HarnessBinding } from "../harness/binding.ts";
import { logError, type LogSink } from "../logging.ts";

type HarnessHookStage = Extract<HookStage, `harness.${string}`>;

/** Narrow Hook notification boundary used by Controller without owning Plugin Manager. */
export interface HarnessHookGateway {
  has(stage: HarnessHookStage): boolean;
  inline(
    stage: "harness.input",
    subject: Readonly<HookSubjectMap["harness.input"]>,
  ): Promise<void>;
  defer(
    stage: "harness.output",
    subject: Readonly<HookSubjectMap["harness.output"]>,
  ): void;
}

interface HarnessHookCoordinatorOptions {
  readonly gateway?: HarnessHookGateway;
  readonly append: (
    binding: HarnessBinding,
    event: HarnessEvent,
  ) => AnyEventEnvelope;
  readonly log: LogSink;
}

/** Owns Harness Hook correlation, fail-open delivery, and ordered event intake. */
export class HarnessHookCoordinator {
  constructor(private readonly options: HarnessHookCoordinatorOptions) {}

  dispatch(
    binding: HarnessBinding,
    input: PromptInput,
    attemptId: string,
    operation: HarnessInputDispatch["operation"],
  ): HarnessInputDispatch {
    return Object.freeze({
      attemptId,
      harnessTargetId: binding.target.id,
      laneId: binding.laneId,
      turnId: input.turnId,
      messageId: input.messageId,
      operation,
    });
  }

  beforeInput(dispatch: HarnessInputDispatch): Promise<void> | undefined {
    if (!this.has("harness.input")) return undefined;
    return this.inline("harness.input", dispatch);
  }

  async send(
    binding: HarnessBinding,
    ref: HarnessSessionHandle,
    input: PromptInput,
    attemptId: string,
    operation: HarnessInputDispatch["operation"],
    notifyInput = true,
  ): Promise<SendTurnReceipt> {
    const dispatch = this.dispatch(binding, input, attemptId, operation);
    const before = notifyInput ? this.beforeInput(dispatch) : undefined;
    if (before) await before;
    return await binding.adapter.sendTurn(ref, input);
  }

  acceptHarnessEvent(binding: HarnessBinding, event: HarnessEvent): void {
    // BatonSession records and reduces the Harness output before Plugin
    // notification. Hooks can emit Verbs, so notifying them first would allow
    // durable effects whose triggering Harness fact was lost on crash.
    const envelope = this.options.append(binding, event);
    const record: BatonEventReference = Object.freeze({
      kind: event.kind,
      harnessTargetId: binding.target.id,
      laneId: binding.laneId,
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      eventId: envelope.eventId,
      seq: envelope.seq,
    });
    this.defer("harness.output", record);
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

  private async inline(
    stage: "harness.input",
    subject: Readonly<HookSubjectMap["harness.input"]>,
  ): Promise<void> {
    try {
      await this.options.gateway?.inline(stage, subject);
    } catch (error) {
      this.logFailure(stage, error);
    }
  }

  private defer(
    stage: "harness.output",
    subject: Readonly<HookSubjectMap["harness.output"]>,
  ): void {
    try {
      this.options.gateway?.defer(stage, subject);
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
