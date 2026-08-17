import { createHash } from "node:crypto";

import type { PlanEntry } from "./index.ts";

export type PlanEntryInput = Omit<PlanEntry, "id"> & { id?: string };

/**
 * 保留原生 entry ID；缺失时按 planId + content + 重复序号派生确定性 ID。
 * content/status 分轴，因此状态变化和重排不换 ID；content 变化则视为 remove + add。
 */
export function planEntriesWithIds(
  planId: string,
  entries: readonly PlanEntryInput[],
): PlanEntry[] {
  const occurrences = new Map<string, number>();
  return entries.map((entry) => {
    if (entry.id) return { ...entry, id: entry.id };
    const occurrence = (occurrences.get(entry.content) ?? 0) + 1;
    occurrences.set(entry.content, occurrence);
    const digest = createHash("sha256")
      .update(planId)
      .update("\0")
      .update(entry.content)
      .digest("hex")
      .slice(0, 16);
    return { ...entry, id: `pe_${digest}_${occurrence}` };
  });
}
