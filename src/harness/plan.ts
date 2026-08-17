import type {
  EventDraft,
  PlanEntry,
} from "../event/index.ts";

export type PlanSnapshotDraft =
  | EventDraft<"plan_update">
  | EventDraft<"plan_remove">;

/** Harness 完整快照 → Baton Plan upsert/remove。空快照显式撤下当前 Plan。 */
export function planSnapshotDraft(
  planId: string,
  entries: readonly PlanEntry[],
  raw?: unknown,
): PlanSnapshotDraft {
  const trace = raw === undefined ? {} : { raw };
  return entries.length === 0
    ? { kind: "plan_remove", payload: { planId }, ...trace }
    : {
        kind: "plan_update",
        payload: { planId, entries: [...entries] },
        ...trace,
      };
}
