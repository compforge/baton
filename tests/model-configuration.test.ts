import { describe, expect, test } from "bun:test";
import { CodexAdapter } from "../src/harness/codex/adapter.ts";
import { ClaudeAdapter } from "../src/harness/claude/adapter.ts";
import type { ClaudeRuntime } from "../src/harness/claude/runtime.ts";
import { readCodexCatalog } from "../src/harness/codex/catalog.ts";
import { codexCollaborationMode, type ThreadRuntime } from "../src/harness/codex/runtime.ts";
import type { OpenInteraction } from "../src/harness/adapter.ts";

const openInteraction: OpenInteraction = async () => { throw new Error("unexpected interaction"); };
const data = [
  { id: "fast", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
  { id: "capable", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
];

describe("model and effort configuration", () => {
  test("Codex atomically switches incompatible pairs, rejects errors without mutation, and supports default", async () => {
    const adapter = new CodexAdapter({ openInteraction });
    let fail = false;
    const runtime = {
      threadId: "native",
      peer: { async request(method: string) {
        expect(method).toBe("model/list");
        if (fail) throw new Error("catalog unavailable");
        return { data };
      } },
      model: "capable",
      effort: "high",
      effortSelection: "high",
      mode: "plan",
      modeEffort: "high",
    };
    (adapter as unknown as { threads: Map<string, typeof runtime> }).threads.set("native", runtime);
    const ref = { harness: "codex", handleId: "native" };
    await adapter.setModelConfiguration(ref, { model: "fast", effort: "medium" });
    expect([adapter.currentModel(ref), adapter.currentEffort(ref)]).toEqual(["fast", "medium"]);
    expect(codexCollaborationMode(runtime as unknown as ThreadRuntime)?.settings.reasoning_effort).toBe("medium");
    for (const pair of [{ model: "unknown", effort: "high" }, { model: "capable", effort: "medium" }]) {
      await expect(adapter.setModelConfiguration(ref, pair)).rejects.toThrow();
      expect([adapter.currentModel(ref), adapter.currentEffort(ref)]).toEqual(["fast", "medium"]);
    }
    fail = true;
    await expect(adapter.setModelConfiguration(ref, { model: "capable", effort: "high" })).rejects.toThrow("catalog unavailable");
    expect([adapter.currentModel(ref), adapter.currentEffort(ref)]).toEqual(["fast", "medium"]);
    fail = false;
    await adapter.setModelConfiguration(ref, { model: "default", effort: "default" });
    expect([adapter.currentModel(ref), adapter.currentEffort(ref)]).toEqual([null, null]);
    expect(runtime.effort).toBe("medium");
  });

  test("Claude validates destination effort and defers active query replacement", async () => {
    const adapter = new ClaudeAdapter({ openInteraction });
    const ref = await adapter.open({ cwd: "/tmp" }, () => {});
    const rt = (adapter as unknown as { sessions: Map<string, ClaudeRuntime> }).sessions.get(ref.handleId)!;
    rt.models = [{ id: "fast", label: "Fast" }, { id: "capable", label: "Capable" }];
    rt.modelInfos = [
      { value: "fast", displayName: "Fast", description: "", supportedEffortLevels: ["medium"] },
      { value: "capable", displayName: "Capable", description: "", supportedEffortLevels: ["high"] },
    ];
    rt.model = "capable";
    rt.effort = "high";
    rt.activeQuery = { setModel() { throw new Error("must not mutate active query"); } } as unknown as NonNullable<ClaudeRuntime["activeQuery"]>;
    await adapter.setModelConfiguration(ref, { model: "fast", effort: "medium" });
    expect([adapter.currentModel(ref), adapter.currentEffort(ref)]).toEqual(["fast", "medium"]);
    expect(rt.queryOptionsDirty).toBe(true);
    await expect(adapter.setModelConfiguration(ref, { model: "capable", effort: "medium" })).rejects.toThrow();
    await expect(adapter.setModelConfiguration(ref, { model: "missing", effort: "high" })).rejects.toThrow();
    expect([adapter.currentModel(ref), adapter.currentEffort(ref)]).toEqual(["fast", "medium"]);
  });

  test("discovery reads every page and retains per-model efforts without opening a thread", async () => {
    const calls: unknown[] = [];
    const result = await readCodexCatalog({ async request(method, params) {
      expect(method).toBe("model/list");
      calls.push(params);
      return calls.length === 1 ? { data: [data[0]], nextCursor: "page2" } : { data: [data[1]] };
    } });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ cursor: "page2" });
    expect(result.modelCatalog?.map((model) => [model.id, model.efforts.map((effort) => effort.id)])).toEqual([
      ["default", ["default", "medium"]], ["fast", ["default", "medium"]], ["capable", ["default", "high"]],
    ]);
  });
});
