import type { ReconcileSnapshot } from "./snapshot.ts";
import type { PluginVerbs } from "./reconcile-context.ts";
import type { ViewInputRecord, ViewOutput } from "./view.ts";

export type HookStage =
  | "view.input"
  | "view.output"
  | "harness.input"
  | "harness.output";

/** Hook stages completed inline before Core continues the observed operation. */
export type InlineHookStage =
  | "view.input"
  | "harness.input";

/** Durable or published observations delivered through the best-effort queue. */
export type DeferredHookStage = Exclude<HookStage, InlineHookStage>;

/** Read-only view of one Core dispatch of a HarnessInput to its Adapter. */
export interface HarnessInputDispatch {
  readonly attemptId: string;
  readonly harnessTargetId: string;
  readonly laneId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly operation: "new_turn" | "steer";
}

/** Reference to a Harness-originated Baton Event after Core commits it. */
export interface BatonEventReference {
  readonly kind: string;
  readonly harnessTargetId: string;
  readonly laneId: string;
  readonly turnId?: string;
  readonly eventId: string;
  readonly seq: number;
}

export interface HookSubjectMap {
  readonly "view.input": ViewInputRecord;
  readonly "view.output": ViewOutput;
  readonly "harness.input": HarnessInputDispatch;
  readonly "harness.output": BatonEventReference;
}

/**
 * One live Hook execution. Hook handlers have no decision/output channel;
 * effects must use typed Core verbs.
 */
export interface HookContext<S extends HookStage = HookStage> {
  readonly stage: S;
  readonly subject: Readonly<HookSubjectMap[S]>;
  readonly snapshot: ReconcileSnapshot;
  readonly verbs: PluginVerbs;
}

export interface Hook<S extends HookStage = HookStage> {
  readonly hookId: string;
  readonly stage: S;
  /** Optional watchdog for this handler. Defaults to the host policy. */
  readonly timeoutMs?: number;
  run(context: HookContext<S>): Promise<void> | void;
}
