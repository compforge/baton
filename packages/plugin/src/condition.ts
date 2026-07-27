/** Kubernetes-compatible tri-state used by current-state conditions. */
export type ConditionStatus = "True" | "False" | "Unknown";

/**
 * One current observation about a Resource.
 *
 * Conditions are keyed by `type`; they describe current predicates rather
 * than an event history or a Resource lifecycle state machine.
 */
export interface ResourceCondition {
  readonly type: string;
  readonly status: ConditionStatus;
  /** Resource spec generation used to calculate this condition. */
  readonly observedGeneration: number;
  /** RFC 3339 timestamp of the most recent `status` transition. */
  readonly lastTransitionTime: string;
  /** Stable, machine-readable explanation for the current status. */
  readonly reason: string;
  /** Human-readable details for operators and Board presentation. */
  readonly message: string;
}

/** Opt-in base shape for Plugin-owned status schemas that expose conditions. */
export interface ConditionedStatus {
  readonly conditions?: readonly ResourceCondition[];
}
