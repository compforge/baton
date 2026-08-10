import type { Snapshot as InteractionSnapshot } from "./interaction.ts";
import type { ResourceRef } from "./resource.ts";

export type SessionRunState = "running" | "idle" | "requires_action";

export type InputStatus =
  | "queued"
  | "admitted"
  | "accepted_steer"
  | "finalized"
  | "recalled"
  | "interrupted";

/** Identifies who caused a prompt Input to enter Baton. */
export type InputSource =
  | { readonly type: "user" }
  | {
      readonly type: "plugin";
      readonly pluginInstanceId: string;
      readonly turnRequestId: string;
    };

export type InteractionRequester =
  | {
      readonly type: "harness";
      readonly harnessTargetId: string;
      readonly laneId?: string;
    }
  | { readonly type: "plugin"; readonly pluginInstanceId: string }
  | { readonly type: "baton" };

export interface TurnSummaryToolCall {
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: string;
  readonly status?: string;
}

export interface TurnSummary {
  readonly turnId: string;
  readonly stopReason?: string;
  readonly userText?: string;
  readonly agentText?: string;
  readonly toolCalls: readonly TurnSummaryToolCall[];
  readonly usage?: Readonly<{
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    isEstimated?: boolean;
  }>;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

export interface BatonSessionSnapshot {
  readonly batonSessionId: string;
  readonly cwd?: string;
  readonly runState: SessionRunState;
  readonly revision: number;
}

export interface BatonActiveTurnSnapshot {
  readonly turnId: string;
  readonly role: "driven" | "observed";
  readonly state: "running" | "requires_action";
  readonly harness?: string;
  readonly harnessTargetId?: string;
  readonly laneId?: string;
  readonly startedAt?: number;
}

export interface BatonInputSnapshot {
  readonly messageId: string;
  readonly turnId: string;
  readonly harnessTargetId: string;
  readonly laneId: string;
  readonly harness: string;
  readonly status: InputStatus;
  readonly delivery: "prompt" | "steer";
  readonly source: InputSource;
}

export type TurnRequestPhase =
  | "pending_approval"
  | "declined"
  | "queued"
  | "running"
  | "uncertain"
  | "completed"
  | "cancelled";

/** A Resource-scoped view of a request to create one new driven Turn. */
export interface TurnRequestSnapshot {
  readonly requestId: string;
  readonly requestKey: string;
  readonly resource: ResourceRef;
  readonly phase: TurnRequestPhase;
  readonly harnessTargetId?: string;
  readonly laneId?: string;
  readonly turnId?: string;
  /** Present after admission has produced and closed the driven Turn. */
  readonly result?: TurnSummary;
}

export interface BatonHarnessTargetSnapshot {
  readonly id: string;
  readonly harness: string;
  readonly label?: string;
}

export interface BatonPendingInteractionSnapshot {
  readonly interactionId: string;
  readonly kind: "permission" | "question" | "hook_trust";
  readonly requester: InteractionRequester;
  readonly turnId?: string;
}

export interface BatonSnapshot {
  readonly session: BatonSessionSnapshot;
  readonly activeTurns: readonly BatonActiveTurnSnapshot[];
  readonly inputs: readonly BatonInputSnapshot[];
  readonly harnessTargets: readonly BatonHarnessTargetSnapshot[];
  readonly pendingInteractions: readonly BatonPendingInteractionSnapshot[];
  /**
   * Durable decisions requested by the Resource currently being reconciled.
   * Baton scopes this list to that PluginInstance and Resource before invocation.
   */
  readonly pluginInteractions: readonly InteractionSnapshot[];
  /** Durable Turns requested by the Resource currently being reconciled. */
  readonly turnRequests: readonly TurnRequestSnapshot[];
  readonly latestTurn?: TurnSummary;
  readonly turns: readonly TurnSummary[];
}
