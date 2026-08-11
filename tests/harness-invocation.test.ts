import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReconcileHarnessInvocation } from "../src/plugin/harness-invocation.ts";
import { HarnessInvocationStore } from "../src/plugin/harness-invocation.ts";
import { MAIN_LANE_ID, SessionStore } from "../src/store/store.ts";

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
      operation: { verb: "harness", key: "implement" },
      title: "Implement requirement",
      prompt: "Implement REQ-1 and run its focused tests.",
      laneId: "main",
      newLane: false,
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
      operation: { verb: "harness", key: "implement" },
      phase: "queued",
      newLane: false,
      laneId: MAIN_LANE_ID,
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

  test("requires submitted Interaction blocks before recording a draft", () => {
    const handle = session();
    const store = new HarnessInvocationStore(handle);
    expect(() => store.record(invocation(handle.id, {
      operation: { verb: "draft", key: "edit-first" },
    }))).toThrow(
      "draft HarnessInvocation requires blocks from a submitted Interaction",
    );

    const pending = store.record(invocation(handle.id, {
      operation: { verb: "draft", key: "edit-first" },
      harnessTargetId: "claude",
      blocks: [{ type: "text", text: "Implement only the focused fix." }],
    }));
    expect(pending.phase).toBe("queued");
    expect(store.scheduled(pending.invocationId)).toMatchObject({
      invocationId: pending.invocationId,
      harnessTargetId: "claude",
      source: "user",
      newLane: false,
      laneId: MAIN_LANE_ID,
      blocks: [{ type: "text", text: "Implement only the focused fix." }],
    });
  });

  test("allocates a side Lane from an existing Lane and can continue it", () => {
    const handle = session();
    const store = new HarnessInvocationStore(handle);
    const pending = store.record(invocation(handle.id, {
      operation: { verb: "harness", key: "async" },
      newLane: true,
    }));
    const scheduled = store.scheduled(pending.invocationId);

    expect(scheduled?.newLane).toBe(true);
    expect(scheduled?.parentLaneId).toBe("main");
    expect(scheduled?.laneId).not.toBe(MAIN_LANE_ID);
    if (!scheduled) throw new Error("expected side Lane schedule");

    handle.ensureHarnessInvocationLane(
      scheduled.laneId,
      scheduled.invocationId,
      scheduled.parentLaneId as string,
    );
    const continued = store.record(invocation(handle.id, {
      operation: { verb: "harness", key: "continue-async" },
      laneId: scheduled.laneId,
    }));
    expect(store.scheduled(continued.invocationId)).toMatchObject({
      laneId: scheduled.laneId,
      newLane: false,
    });

    const child = store.record(invocation(handle.id, {
      operation: { verb: "harness", key: "child-async" },
      laneId: scheduled.laneId,
      newLane: true,
    }));
    expect(store.scheduled(child.invocationId)).toMatchObject({
      newLane: true,
      parentLaneId: scheduled.laneId,
    });
  });

  test("rejects an unknown base Lane before recording an invocation", () => {
    const handle = session();
    const store = new HarnessInvocationStore(handle);

    expect(() => store.record(invocation(handle.id, {
      laneId: "missing",
    }))).toThrow("Lane not found: missing");
    expect(handle.readEvents()).toEqual([]);
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

  test("namespaces the same caller key by reconcile verb", () => {
    const handle = session();
    const store = new HarnessInvocationStore(handle);
    const direct = store.record(invocation(handle.id));
    const draft = store.record(invocation(handle.id, {
      operation: { verb: "draft", key: "implement" },
      blocks: [{ type: "text", text: "Implement requirement" }],
    }));

    expect(draft.invocationId).not.toBe(direct.invocationId);
    expect(store.list().map((entry) => entry.operation)).toEqual([
      { verb: "harness", key: "implement" },
      { verb: "draft", key: "implement" },
    ]);
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
    expect(restored.list()[0]).toMatchObject({
      phase: "cancelled",
      cancellation: { reason: "user" },
    });
    expect(restored.cancelBeforeAdmission(pending.invocationId, "user"))
      .toBeUndefined();
  });

  test("persists dispatch failure as a typed terminal outcome", () => {
    const handle = session();
    const store = new HarnessInvocationStore(handle);
    const direct = store.record(invocation(handle.id, {
      operation: { verb: "harness", key: "dispatch-failure" },
    }));

    expect(
      store.failBeforeAdmission(
        direct.invocationId,
        "dispatch",
        "dispatcher unavailable",
      ),
    ).toBeDefined();
    expect(store.list()).toMatchObject([{
      phase: "failed",
      failure: { reason: "dispatch", detail: "dispatcher unavailable" },
    }]);
    store.close();

    const restored = new HarnessInvocationStore(handle);
    expect(restored.restore()).toEqual([]);
    expect(restored.list()).toMatchObject([
      { failure: { reason: "dispatch", detail: "dispatcher unavailable" } },
    ]);
  });
});
