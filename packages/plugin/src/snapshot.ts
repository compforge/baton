export type SessionRunState = "running" | "idle" | "requires_action";

export type InputStatus =
  | "queued"
  | "admitted"
  | "accepted_steer"
  | "finalized"
  | "recalled"
  | "interrupted";

/** Identifies the actor that submitted a prompt Input to Baton. */
export type InputSource =
  | { readonly type: "user" }
  | {
      readonly type: "plugin";
      readonly pluginInstanceId: string;
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

export interface SessionSnapshot {
  readonly batonSessionId: string;
  readonly cwd?: string;
  readonly runState: SessionRunState;
  readonly revision: number;
}

export interface ActiveTurnSnapshot {
  readonly turnId: string;
  readonly role: "driven" | "observed";
  readonly state: "running" | "requires_action";
  readonly harness?: string;
  readonly harnessTargetId?: string;
  readonly laneId?: string;
  readonly startedAt?: number;
}

export interface InputSnapshot {
  readonly messageId: string;
  readonly turnId: string;
  readonly harnessTargetId: string;
  readonly laneId: string;
  readonly harness: string;
  readonly status: InputStatus;
  readonly delivery: "prompt" | "steer";
  readonly source: InputSource;
  readonly harnessInvocationId?: string;
}

export interface HarnessTargetSnapshot {
  readonly id: string;
  readonly harness: string;
  readonly label?: string;
}

export interface PendingInteractionSnapshot {
  readonly interactionId: string;
  readonly kind: "permission" | "question" | "hook_trust";
  readonly requester: InteractionRequester;
  readonly turnId?: string;
}

export interface ReconcileSnapshot {
  readonly session: SessionSnapshot;
  readonly activeTurns: readonly ActiveTurnSnapshot[];
  readonly inputs: readonly InputSnapshot[];
  readonly harnessTargets: readonly HarnessTargetSnapshot[];
  readonly pendingInteractions: readonly PendingInteractionSnapshot[];
  readonly latestTurn?: TurnSummary;
  readonly turns: readonly TurnSummary[];
}
