import type { ResourceRef } from "./resource.ts";

export type OptionRole = "default" | "reject";

export interface Option {
  /** Stable domain value returned to the Plugin when the user selects this option. */
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
  /** Presentation hint only; domain behavior must still branch on optionId. */
  readonly role?: OptionRole;
}

/**
 * A durable question whose answer belongs to the requesting Plugin Resource.
 * Omit options for free text; provide options for a single-choice decision.
 */
export interface Output {
  readonly kind: "interaction";
  /** Stable within one Resource decision. Change it only when asking a new decision. */
  readonly decisionKey: string;
  readonly title: string;
  readonly prompt: string;
  readonly options?: readonly Option[];
  /** With options present, also allow a user-supplied value. */
  readonly allowOther?: boolean;
}

export type CancellationReason =
  | "user"
  | "requester"
  | "turn"
  | "timeout"
  | "recovery";

export type Outcome =
  | {
      readonly kind: "answered";
      /** Selected optionId values, or the user-supplied free text. */
      readonly values: readonly string[];
    }
  | {
      readonly kind: "cancelled";
      readonly reason: CancellationReason;
    };

/** A decision previously requested by the Resource currently being reconciled. */
export interface Snapshot {
  readonly interactionId: string;
  readonly decisionKey: string;
  readonly resource: ResourceRef;
  readonly outcome?: Outcome;
}
