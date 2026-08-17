import { describe, expect, test } from "bun:test";

import { planEntriesWithIds } from "../src/event/plan.ts";
import { planSnapshotDraft } from "../src/harness/plan.ts";

describe("Plan normalization", () => {
  test("preserves native IDs and derives stable IDs for identity-free snapshots", () => {
    const first = planEntriesWithIds("pl1", [
      { id: "native-1", content: "native", priority: "medium", status: "pending" },
      { content: "derived", priority: "medium", status: "pending" },
      { content: "derived", priority: "medium", status: "pending" },
    ]);
    const updated = planEntriesWithIds("pl1", [
      { content: "derived", priority: "medium", status: "completed" },
      { id: "native-1", content: "native", priority: "medium", status: "completed" },
      { content: "derived", priority: "medium", status: "in_progress" },
    ]);

    expect(first[0]?.id).toBe("native-1");
    expect(updated[1]?.id).toBe("native-1");
    expect(updated[0]?.id).toBe(first[1]?.id);
    expect(updated[2]?.id).toBe(first[2]?.id);
    expect(first[1]?.id).not.toBe(first[2]?.id);
  });

  test("does not let native entries perturb derived duplicate ordinals", () => {
    const withNative = planEntriesWithIds("pl1", [
      { id: "native-1", content: "same", priority: "medium", status: "pending" },
      { content: "same", priority: "medium", status: "pending" },
    ]);
    const withoutNative = planEntriesWithIds("pl1", [
      { content: "same", priority: "medium", status: "completed" },
    ]);

    expect(withNative[1]?.id).toBe(withoutNative[0]?.id);
  });

  test("maps non-empty and empty snapshots to upsert and remove", () => {
    const entries = planEntriesWithIds("pl1", [
      { content: "step", priority: "medium", status: "pending" },
    ]);
    expect(planSnapshotDraft("pl1", entries).kind).toBe("plan_update");
    expect(planSnapshotDraft("pl1", []).kind).toBe("plan_remove");
  });
});
