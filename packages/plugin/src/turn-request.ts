/**
 * A durable control-plane intent to create one new driven Turn outside the
 * direct-user Input path. The current producer is the Resource being
 * reconciled; after authorization Baton materializes the request as Input and
 * owns admission, routing and execution.
 */
export interface TurnRequestOutput {
  readonly kind: "turn-request";
  /** Stable within one intended request. Change it to request another Turn. */
  readonly requestKey: string;
  /** Short user-facing authorization title. */
  readonly title: string;
  /** Optional user-facing explanation; the prompt itself remains read-only. */
  readonly description?: string;
  /** Prompt submitted to the Harness after authorization. */
  readonly prompt: string;
  /** Omit to use the Baton host's selected HarnessTarget at authorization time. */
  readonly harnessTargetId?: string;
}
