import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReconcileHarnessInvocation } from "../src/plugin/harness-invocation.ts";
import { HarnessInvocationStore } from "../src/plugin/harness-invocation.ts";
import { SessionStore } from "../src/store/store.ts";

const roots: string[] = [];

function session() {
  const root = mkdtempSync(join(tmpdir(), "baton-harness-invocation-"));
  roots.push(root);
  return new SessionStore(root).createSession({ cwd: "/repo" });
}

function invocation(
  batonSessionId: string,
  overrides: Partial<ReconcileHarnessInvocation["invocation"]> = {},
): ReconcileHarnessInvocation {
  return {
    key: {
      batonSessionId,
      pluginInstanceId: "reqloop_default",
      resourceApiVersion: "reqloop.baton.dev/v1alpha1",
      resourceKind: "Requirement",
      resourceId: "REQ-1",
    },
    resource: {
      apiVersion: "reqloop.baton.dev/v1alpha1",
      kind: "Requirement",
      namespace: "reqloop_default",
      name: "REQ-1",
      uid: "requirement_uid_1",
    },
    basedOnGeneration: 1,
    basedOnResourceVersion: "1",
    invocation: {
      operationKey: "implement",
      title: "Implement requirement",
      prompt: "Implement REQ-1 and run its focused tests.",
      delivery: "direct",
      lane: "main",
      harnessTargetId: "codex",
      ...overrides,
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("HarnessInvocation Store", () => {
  test("schedules one direct Plugin invocation and projects completion", () => {
    const handle = session();
    const store = new HarnessInvocationStore(handle);
    const draft = invocation(handle.id);

    const pending = store.record(draft);
    expect(store.record(draft).invocationId).toBe(pending.invocationId);
    expect(pending).toMatchObject({
      operationKey: "implement",
      phase: "queued",
      delivery: "direct",
      lane: "main",
      laneId: handle.meta.mainLaneId,
    });
    expect(handle.readEvents().filter((event) =>
      event.kind === "_baton_harness_invocation_recorded"
    )).toHaveLength(1);

    const scheduled = store.scheduled(pending.invocationId);
    expect(scheduled).toMatchObject({
      invocationId: pending.invocationId,
      pluginInstanceId: "reqloop_default",
      harnessTargetId: "codex",
      source: "plugin",
      blocks: [{ type: "text", text: draft.invocation.prompt }],
    });
    if (!scheduled) throw new Error("expected scheduled invocation");

    handle.append({
      kind: "user_message",
      source: { type: "plugin", pluginInstanceId: scheduled.pluginInstanceId },
      harness: "codex",
      harnessTargetId: scheduled.harnessTargetId,
      laneId: scheduled.laneId,
      turnId: scheduled.turnId,
      payload: {
        messageId: scheduled.messageId,
        content: [...scheduled.blocks],
      },
    });
    expect(store.list()[0]?.phase).toBe("running");

    handle.append({
      kind: "_baton_turn_summary",
      source: { type: "baton" },
      harness: "codex",
      harnessTargetId: scheduled.harnessTargetId,
      laneId: scheduled.laneId,
      turnId: scheduled.turnId,
      payload: {
        turnId: scheduled.turnId,
        stopReason: "end_turn",
        agentText: "Implemented.",
        toolCalls: [],
      },
    });
    expect(store.list()[0]).toMatchObject({
      phase: "completed",
      result: { agentText: "Implemented." },
    });
  });

  test("holds a draft until the user submits edited Input", () => {
    const handle = session();
    const store = new HarnessInvocationStore(handle);
    const pending = store.record(invocation(handle.id, {
      operationKey: "edit-first",
      delivery: "draft",
    }));

    expect(pending.phase).toBe("awaiting_input");
    expect(store.scheduled(pending.invocationId)).toBeUndefined();
    expect(store.pendingDraftInputs()).toEqual([{
      invocationId: pending.invocationId,
      pluginInstanceId: "reqloop_default",
      title: "Implement requirement",
      prompt: "Implement REQ-1 and run its focused tests.",
    }]);

    const resolved = store.resolveDraftInput(pending.invocationId, {
      kind: "submitted",
      blocks: [{ type: "text", text: "Implement only the focused fix." }],
    });
    expect(resolved?.scheduled).toMatchObject({
      invocationId: pending.invocationId,
      source: "user",
      lane: "main",
      laneId: handle.meta.mainLaneId,
      blocks: [{ type: "text", text: "Implement only the focused fix." }],
    });
    expect(store.pendingDraftInputs()).toEqual([]);
  });

  test("allocates a side Lane only when lane is new", () => {
    const handle = session();
    const store = new HarnessInvocationStore(handle);
    const pending = store.record(invocation(handle.id, {
      operationKey: "async",
      lane: "new",
    }));
    const scheduled = store.scheduled(pending.invocationId);

    expect(scheduled?.lane).toBe("new");
    expect(scheduled?.laneId).not.toBe(handle.meta.mainLaneId);
  });

  test("rejects an envelope change for the same operation identity", () => {
    const handle = session();
    const store = new HarnessInvocationStore(handle);
    store.record(invocation(handle.id));
    const before = handle.readEvents().length;

    expect(() => store.record(invocation(handle.id, {
      prompt: "A different operation under the same key.",
    }))).toThrow("HarnessInvocation identity conflict");
    expect(handle.readEvents()).toHaveLength(before);
  });

  test("restores one schedule and supports cancellation before admission", () => {
    const handle = session();
    const first = new HarnessInvocationStore(handle);
    const pending = first.record(invocation(handle.id));
    first.close();

    const restored = new HarnessInvocationStore(handle);
    expect(restored.restore()).toHaveLength(1);
    expect(restored.restore()).toHaveLength(1);
    expect(handle.readEvents().filter((event) =>
      event.kind === "_baton_harness_invocation_scheduled"
    )).toHaveLength(1);
    expect(restored.cancelBeforeAdmission(pending.invocationId, "user"))
      .toBeDefined();
    expect(restored.list()[0]?.phase).toBe("cancelled");
    expect(restored.cancelBeforeAdmission(pending.invocationId, "user"))
      .toBeUndefined();
  });
});
