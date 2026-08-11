import type { ReconcileSnapshot, TurnSummary } from "./snapshot.ts";

/** Session-scoped reserved ID for Baton's default task line. */
export const MAIN_LANE_ID = "main" as const;

/**
 * Terminal outcome of a Plugin verb.
 *
 * `dismissed` is reserved for an explicit user escape/close. A negative answer
 * such as declining a confirmation is still a successful business value.
 */
export type VerbResult<T> =
  | { readonly state: "success"; readonly value: T }
  | { readonly state: "dismissed" }
  | { readonly state: "timeout" }
  | { readonly state: "failure"; readonly error?: string };

interface VerbInput {
  /** Maximum time Baton may wait for the Interaction and any resulting work. */
  readonly timeoutMs: number;
}

export interface AskChoice<TValue extends string = string> {
  /** Stable domain value returned when the user selects this choice. */
  readonly value: TValue;
  readonly label: string;
  readonly description?: string;
}

interface AskBaseInput extends VerbInput {
  readonly title: string;
  readonly prompt: string;
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
 * @spec Closed-choice asks preserve their choice value union, while any ask that permits free text returns string because the answer may be outside those choices.
 * @rule Keep allowOther as the type discriminant; allowOther:true must never expose a choice-only result type.
 */
export type AskInput<TValue extends string = string> =
  | ChoiceAskInput<TValue>
  | FreeTextAskInput;

export type AskValue<TInput extends AskInput> =
  TInput extends ChoiceAskInput<infer TValue> ? TValue : string;

export type AskResult<TValue extends string = string> = VerbResult<TValue>;

export interface ConfirmInput extends VerbInput {
  readonly title: string;
  readonly prompt: string;
  readonly confirmLabel?: string;
  readonly declineLabel?: string;
}

export type ConfirmValue = "accepted" | "declined";
export type ConfirmResult = VerbResult<ConfirmValue>;

export interface HarnessInput extends VerbInput {
  readonly title: string;
  readonly prompt: string;
  /** Existing Baton Lane to continue, including the reserved main Lane ID `main`. */
  readonly laneId: string;
  /** Create a new side Lane from laneId instead of continuing it. Defaults to false. */
  readonly newLane?: boolean;
  /** Omit to use the host's selected HarnessTarget when scheduling. */
  readonly harnessTargetId?: string;
}

export interface DraftInput extends VerbInput {
  readonly title: string;
  readonly prompt: string;
  /** Omit to use the host's selected HarnessTarget on submission. */
  readonly harnessTargetId?: string;
}

export interface CompletedHarnessValue {
  readonly outcome: "completed";
  readonly laneId: string;
  readonly turn: TurnSummary;
}

export type HarnessValue =
  | { readonly outcome: "declined" }
  | CompletedHarnessValue;

export type HarnessResult = VerbResult<HarnessValue>;
export type DraftResult = VerbResult<CompletedHarnessValue>;

/**
 * One live Plugin execution's host view and capabilities. Every verb opens an
 * Interaction and suspends this async continuation until a terminal result is
 * available. Waiting yields scheduler capacity; it does not requeue a Resource.
 */
export interface ReconcileContext {
  readonly snapshot: ReconcileSnapshot;
  ask<const TInput extends AskInput>(
    input: TInput,
  ): Promise<AskResult<AskValue<TInput>>>;
  confirm(input: ConfirmInput): Promise<ConfirmResult>;
  draft(input: DraftInput): Promise<DraftResult>;
  harness(input: HarnessInput): Promise<HarnessResult>;
}
