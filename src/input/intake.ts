import type {
  HookStage,
  HookSubjectMap,
  HumanInput,
  HumanInputRecord,
  HumanInputSettlement,
} from "@compforge/baton-plugin";

import { newId } from "../event/ids.ts";
import { logError } from "../logging.ts";
import type { SessionHandle } from "../store/store.ts";

type HumanHookStage = Extract<HookStage, `human.${string}`>;

/** Narrow Human Hook notification boundary used by Core input intake. */
export interface HumanHookGateway {
  before<S extends Extract<HumanHookStage, `${string}.before`>>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): Promise<void>;
  after<S extends Extract<HumanHookStage, `${string}.after`>>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): void;
}

interface HumanInputIntakeOptions {
  readonly session: SessionHandle;
  readonly hooks?: HumanHookGateway;
}

/**
 * Core-owned Human input WAL boundary.
 *
 * The received fact is appended before a Hook can emit Verbs or lowering can
 * mutate Core state. The settled fact is appended before the after Hook is
 * notified. A Hook failure is diagnostic only and never blocks Human input.
 */
export class HumanInputIntake {
  constructor(private readonly options: HumanInputIntakeOptions) {}

  async run<T>(input: HumanInput, lower: (record: HumanInputRecord) => Promise<T>): Promise<T> {
    const inputId = newId("in");
    const received = this.options.session.appendEvent({
      kind: "input.received",
      source: { type: "user" },
      payload: { inputId, input },
    });
    const record: HumanInputRecord = Object.freeze({
      inputId,
      eventId: received.eventId,
      seq: received.seq,
      input,
    });

    await this.before(record);
    try {
      const result = await lower(record);
      this.settle(record, "succeeded");
      return result;
    } catch (error) {
      this.settle(
        record,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async before(record: HumanInputRecord): Promise<void> {
    try {
      await this.options.hooks?.before("human.inbound.before", record);
    } catch (error) {
      this.logFailure("human.inbound.before", error);
    }
  }

  private settle(
    record: HumanInputRecord,
    outcome: HumanInputSettlement["outcome"],
    detail?: string,
  ): void {
    const settled = this.options.session.appendEvent({
      kind: "input.settled",
      source: { type: "baton" },
      parentEventId: record.eventId,
      payload: {
        inputId: record.inputId,
        outcome,
        ...(detail === undefined ? {} : { detail }),
      },
    });
    const settlement: HumanInputSettlement = Object.freeze({
      inputId: record.inputId,
      eventId: settled.eventId,
      seq: settled.seq,
      outcome,
      ...(detail === undefined ? {} : { detail }),
    });
    try {
      this.options.hooks?.after("human.inbound.after", settlement);
    } catch (error) {
      this.logFailure("human.inbound.after", error);
    }
  }

  private logFailure(stage: HumanHookStage, error: unknown): void {
    this.options.session.log({
      level: "warn",
      source: "baton",
      component: "input.intake",
      message: "Human Hook gateway failed open",
      error: logError(error),
      attributes: { stage },
    });
  }
}
