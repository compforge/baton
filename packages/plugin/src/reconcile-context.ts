import type { ReconcileSnapshot, TurnSummary } from "./snapshot.ts";

/** Session-scoped reserved ID for Baton's default task line. */
export const MAIN_LANE_ID = "main" as const;

export type CancellationReason =
  | "user"
  | "requester"
  | "turn"
  | "timeout"
  | "recovery";

export type ReconcileOperationVerb =
  | "ask"
  | "confirm"
  | "draft"
  | "harness";

/**
 * Stable identity of one level-based capability call within a Resource incarnation.
 * Reconstruct the verb and key deterministically on every reconcile from durable
 * Resource state or stable, re-observable facts.
 */
export interface ReconcileOperationRef<
  TVerb extends ReconcileOperationVerb = ReconcileOperationVerb,
> {
  readonly verb: TVerb;
  readonly key: string;
}

export interface AskChoice<TValue extends string = string> {
  /** Stable domain value returned when the user selects this choice. */
  readonly value: TValue;
  readonly label: string;
  readonly description?: string;
}

interface AskBaseInput {
  /**
   * Deterministically derived from durable Resource state or stable, re-observable facts.
   * Change it only to ask a new question.
   */
  readonly key: string;
  readonly title: string;
  readonly prompt: string;
  /** Absolute ISO 8601 deadline. Baton durably cancels the question when it expires. */
  readonly expiresAt?: string;
}

export interface ChoiceAskInput<TValue extends string = string>
  extends AskBaseInput {
  readonly choices: readonly AskChoice<TValue>[];
  readonly allowOther?: false;
}

export interface FreeTextAskInput extends AskBaseInput {
  /** Optional suggested values; the user may still answer with other non-empty text. */
  readonly choices?: readonly AskChoice[];
  readonly allowOther: true;
}

/**
 * @spec Closed-choice asks preserve their choice value union, while any ask that permits free text returns string because the durable answer may be outside those choices.
 * @rule Keep allowOther as the type discriminant; allowOther:true must never expose a choice-only result type.
 */
export type AskInput<TValue extends string = string> =
  | ChoiceAskInput<TValue>
  | FreeTextAskInput;

export type AskValue<TInput extends AskInput> =
  TInput extends ChoiceAskInput<infer TValue> ? TValue : string;

export type AskResult<TValue extends string = string> =
  | {
      /** Waiting for an external answer; this operation has no Harness execution. */
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
  /**
   * Deterministically derived from durable Resource state or stable, re-observable facts.
   * Change it only to request new consent.
   */
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
      /** Waiting for an external decision; this operation has no Harness execution. */
      readonly state: "waiting";
    }
  | {
      readonly state: "accepted" | "declined";
    }
  | {
      readonly state: "cancelled";
      readonly reason: CancellationReason;
    };

export type WithdrawInput = ReconcileOperationRef<"ask" | "confirm">;

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
  /**
   * Deterministically derived from durable Resource state or stable, re-observable facts.
   * Change it only to start another Turn.
   */
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
  /**
   * Deterministically derived from durable Resource state or stable, re-observable facts.
   * Change it only to offer another draft.
   */
  readonly key: string;
  readonly prompt: string;
  /** Omit to use the host's selected HarnessTarget on submission. */
  readonly harnessTargetId?: string;
}

/** Stable reasons a gated Harness request or HarnessInvocation can be cancelled. */
export type HarnessCancellationReason = CancellationReason | "resource";

/** Stable failure classes; detail is diagnostic and must not drive Plugin control flow. */
export type HarnessFailureReason = "dispatch";

/** Result after an Interaction gate has allowed creation of a HarnessInvocation. */
export type HarnessInvocationResult =
  | {
      /** A durable HarnessInvocation exists without a terminal result; phase tracks its progress. */
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
      readonly reason: HarnessCancellationReason;
      readonly detail?: string;
    }
  | {
      readonly state: "failed";
      readonly reason: HarnessFailureReason;
      readonly detail: string;
    };

export type HarnessResult =
  | {
      /** Its mandatory Interaction gate is still waiting for a decision. */
      readonly state: "waiting";
    }
  | {
      /** Its Interaction gate declined execution; no HarnessInvocation was created. */
      readonly state: "declined";
    }
  | HarnessInvocationResult;

export type DraftResult =
  | {
      /** Waiting for edited input; no Harness Input has been submitted. */
      readonly state: "editing";
    }
  | {
      /** The user closed this draft before submitting a Harness Input. */
      readonly state: "dismissed";
    }
  | HarnessInvocationResult;

/**
 * Reconcile-scoped host view and capabilities. Calls are durable and
 * level-based: an unresolved call returns its current state, then the host
 * re-enqueues the Resource after the corresponding ledger result changes.
 */
export interface ReconcileContext {
  readonly snapshot: ReconcileSnapshot;
  ask<const TInput extends AskInput>(
    input: TInput,
  ): Promise<AskResult<AskValue<TInput>>>;
  confirm(input: ConfirmInput): Promise<ConfirmResult>;
  withdraw(input: WithdrawInput): Promise<WithdrawResult>;
  draft(input: DraftInput): Promise<DraftResult>;
  harness(input: HarnessInput): Promise<HarnessResult>;
}
