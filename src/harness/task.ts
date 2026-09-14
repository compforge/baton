export interface HarnessTaskIdentity {
  readonly laneId?: string;
  readonly harnessTargetId?: string;
  readonly harnessSessionId?: string;
  /** Harness-native identity, scoped to its Lane x HarnessTarget binding. */
  readonly taskId: string;
}

/**
 * Baton-stable key for a Harness task inside one BatonSession.
 * Different Lane, HarnessTarget, or HarnessSession owners must remain distinct even when their
 * native taskId matches; Controller actions later use this key to recover the exact owner.
 */
export function harnessTaskKey(identity: HarnessTaskIdentity): string {
  return [
    "task",
    identity.laneId ?? "",
    identity.harnessTargetId ?? "",
    identity.harnessSessionId ?? "",
    identity.taskId,
  ].map(encodeURIComponent).join(":");
}
