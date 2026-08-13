import type { ReconcileSnapshot } from "./snapshot.ts";
import type { PluginVerbs } from "./reconcile-context.ts";

export type HookBoundary = "human" | "harness";
export type HookDirection = "inbound" | "outbound";
export type HookPhase = "before" | "after";

export type HookStage =
  | "human.inbound.before"
  | "human.inbound.after"
  | "human.outbound.before"
  | "human.outbound.after"
  | "harness.inbound.before"
  | "harness.inbound.after"
  | "harness.outbound.before"
  | "harness.outbound.after";

export type HumanIntentKind =
  | "prompt"
  | "command"
  | "configuration"
  | "interaction_response"
  | "interrupt";

/** Core-owned Human intent after it has a stable intake identity. */
export interface HumanIntent {
  readonly intentId: string;
  readonly kind: HumanIntentKind;
  readonly text?: string;
  readonly command?: string;
  readonly argument?: string;
  readonly harnessTargetId?: string;
  readonly setting?: "harness" | "model" | "effort" | "mode";
  readonly value?: string | null;
  readonly interactionId?: string;
}

/** A Core presentation update; this deliberately does not expose a TUI DTO. */
export interface HumanPresentation {
  readonly presentationId: string;
  readonly kind:
    | "transcript"
    | "queue"
    | "interaction"
    | "status"
    | "toast"
    | "board"
    | "picker";
  readonly revision?: number;
}

/** One Core attempt to send a prepared Input to a Harness Adapter. */
export interface HarnessDelivery {
  readonly attemptId: string;
  readonly harnessTargetId: string;
  readonly laneId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly operation: "new_turn" | "steer";
  readonly outcome?: "accepted" | "rejected" | "error";
  readonly reason?: string;
}

/** Normalized Harness input before it receives ledger identity. */
export interface HarnessEventDraft {
  readonly kind: string;
  readonly harnessTargetId: string;
  readonly laneId: string;
  readonly turnId?: string;
}

/** Normalized Harness input after it is persisted in the Session ledger. */
export interface HarnessEventRecord extends HarnessEventDraft {
  readonly eventId: string;
  readonly seq: number;
}

export interface HookSubjectMap {
  readonly "human.inbound.before": HumanIntent;
  readonly "human.inbound.after": HumanIntent;
  readonly "human.outbound.before": HumanPresentation;
  readonly "human.outbound.after": HumanPresentation;
  readonly "harness.inbound.before": HarnessEventDraft;
  readonly "harness.inbound.after": HarnessEventRecord;
  readonly "harness.outbound.before": HarnessDelivery;
  readonly "harness.outbound.after": HarnessDelivery;
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
