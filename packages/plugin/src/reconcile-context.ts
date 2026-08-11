import type { ReconcileSnapshot, TurnSummary } from "./snapshot.ts";

/** Session-scoped reserved ID for Baton's default task line. */
export const MAIN_LANE_ID = "main" as const;

export type CancellationReason =
  | "user"
  | "requester"
  | "turn"
  | "timeout"
  | "recovery";

export interface AskChoice<TValue extends string = string> {
  /** Stable domain value returned when the user selects this choice. */
  readonly value: TValue;
  readonly label: string;
  readonly description?: string;
}

export interface AskInput<TValue extends string = string> {
  /** Stable within the Resource operation. Change it to ask a new question. */
  readonly key: string;
  readonly title: string;
  readonly prompt: string;
  readonly choices?: readonly AskChoice<TValue>[];
  readonly allowOther?: boolean;
  /** Absolute ISO 8601 deadline. Baton durably cancels the question when it expires. */
  readonly expiresAt?: string;
}

export type AskResult<TValue extends string = string> =
  | {
      readonly state: "waiting";
    }
  | {
      readonly state: "answered";
      readonly value: TValue;
    }
  | {
      readonly state: "cancelled";
      readonly reason: CancellationReason;
    };

export interface ConfirmInput {
  /** Stable within the Resource operation. Change it to request new consent. */
  readonly key: string;
  readonly title: string;
  readonly prompt: string;
  readonly confirmLabel?: string;
  readonly declineLabel?: string;
  /** Absolute ISO 8601 deadline. Baton durably cancels the confirmation when it expires. */
  readonly expiresAt?: string;
}

export type ConfirmResult =
  | {
      readonly state: "waiting";
    }
  | {
      readonly state: "granted" | "declined";
    }
  | {
      readonly state: "cancelled";
      readonly reason: CancellationReason;
    };

export interface WithdrawInput {
  /** The Interaction-producing verb that owns the stable operation key. */
  readonly kind: "ask" | "confirm";
  readonly key: string;
}

export type WithdrawResult =
  | {
      readonly state: "cancelled";
      readonly reason: "requester";
    }
  | {
      /** No matching unresolved Interaction remains. */
      readonly state: "not-pending";
    };

export interface HarnessInput {
  /** Stable within the Resource operation. Change it to start another Turn. */
  readonly key: string;
  readonly prompt: string;
  /** Existing Baton Lane to continue, including the reserved main Lane ID `main`. */
  readonly laneId: string;
  /** Create a new side Lane from laneId instead of continuing it. Defaults to false. */
  readonly newLane?: boolean;
  /** Omit to use the host's selected HarnessTarget when scheduling. */
  readonly harnessTargetId?: string;
}

export interface DraftInput {
  /** Stable within the Resource operation. Change it to offer another draft. */
  readonly key: string;
  readonly prompt: string;
  /** Omit to use the host's selected HarnessTarget on submission. */
  readonly harnessTargetId?: string;
}

export type HarnessResult =
  | {
      readonly state: "pending";
      readonly phase: "queued" | "running" | "uncertain";
      readonly laneId?: string;
      readonly turnId?: string;
    }
  | {
      readonly state: "completed";
      readonly laneId: string;
      readonly turn: TurnSummary;
    }
  | {
      readonly state: "cancelled";
      readonly reason?: string;
    };

export type DraftResult =
  | { readonly state: "editing" }
  | { readonly state: "dismissed" }
  | HarnessResult;

/**
 * Reconcile-scoped host view and capabilities. Calls are durable and
 * level-based: an unresolved call returns its current state, then the host
 * re-enqueues the Resource after the corresponding ledger result changes.
 */
export interface ReconcileContext {
  readonly snapshot: ReconcileSnapshot;
  ask<const TValue extends string>(
    input: AskInput<TValue>,
  ): Promise<AskResult<TValue>>;
  confirm(input: ConfirmInput): Promise<ConfirmResult>;
  withdraw(input: WithdrawInput): Promise<WithdrawResult>;
  draft(input: DraftInput): Promise<DraftResult>;
  harness(input: HarnessInput): Promise<HarnessResult>;
}
