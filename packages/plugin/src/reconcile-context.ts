import type { ReconcileSnapshot, TurnSummary } from "./snapshot.ts";

export type LanePlacement = "main" | "new";
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

export interface HarnessInput {
  /** Stable within the Resource operation. Change it to start another Turn. */
  readonly key: string;
  readonly prompt: string;
  readonly lane: LanePlacement;
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
  draft(input: DraftInput): Promise<DraftResult>;
  harness(input: HarnessInput): Promise<HarnessResult>;
}
