import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReconcileTurnRequest } from "../src/plugin/controller.ts";
import { TurnRequestStore } from "../src/plugin/turn-request.ts";
import { SessionStore } from "../src/store/store.ts";

const roots: string[] = [];

function session() {
  const root = mkdtempSync(join(tmpdir(), "baton-turn-request-"));
  roots.push(root);
  return new SessionStore(root).createSession({ cwd: "/repo" });
}

function draft(
  batonSessionId: string,
  overrides: Partial<ReconcileTurnRequest["request"]> = {},
): ReconcileTurnRequest {
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
    request: {
      kind: "turn-request",
      requestKey: "implement",
      title: "Implement requirement",
      description: "The requirement is ready for implementation.",
      prompt: "Implement REQ-1 and run its focused tests.",
      ...overrides,
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("TurnRequest Store", () => {
  test("persists identity, fixes the selected Target at approval, and projects completion", () => {
    const handle = session();
    const store = new TurnRequestStore(handle);
    const request = draft(handle.id);

    const pending = store.record(request);
    expect(store.record(request).requestId).toBe(pending.requestId);
    expect(pending).toMatchObject({
      requestKey: "implement",
      phase: "pending_approval",
    });
    expect(
      handle.readEvents().filter((event) =>
        event.kind === "_baton_turn_request_recorded"
      ),
    ).toHaveLength(1);

    const opened = handle.readEvents().find((event) =>
      event.kind === "interaction.opened" &&
      event.payload.turnRequestContext?.turnRequestId === pending.requestId
    );
    expect(opened?.kind).toBe("interaction.opened");
    if (!opened || opened.kind !== "interaction.opened") {
      throw new Error("TurnRequest authorization was not opened");
    }
    if (opened.payload.kind !== "permission") {
      throw new Error("TurnRequest authorization is not a permission");
    }
    expect(opened.payload.description).toContain("Prompt (read-only):");
    expect(opened.payload.description).toContain(request.request.prompt);

    const resolved = store.resolve(
      opened.payload.interactionId,
      { kind: "permission", outcome: "selected", optionId: "allow_once" },
      "claude",
      new Set(["codex", "claude"]),
    );
    expect(resolved?.scheduled).toMatchObject({
      requestId: pending.requestId,
      pluginInstanceId: "reqloop_default",
      harnessTargetId: "claude",
      prompt: request.request.prompt,
    });
    expect(resolved?.scheduled?.laneId).toMatch(/^hl_/);
    expect(store.list()[0]).toMatchObject({
      phase: "queued",
      harnessTargetId: "claude",
      turnId: resolved?.scheduled?.turnId,
    });

    const scheduled = resolved?.scheduled;
    if (!scheduled) throw new Error("TurnRequest was not scheduled");
    handle.append({
      kind: "user_message",
      source: {
        type: "plugin",
        pluginInstanceId: scheduled.pluginInstanceId,
      },
      harness: "claude",
      harnessTargetId: scheduled.harnessTargetId,
      turnId: scheduled.turnId,
      payload: {
        messageId: scheduled.messageId,
        content: [{ type: "text", text: scheduled.prompt }],
      },
    });
    expect(store.list()[0]?.phase).toBe("running");

    handle.append({
      kind: "_baton_delivery_attempt_update",
      source: { type: "baton" },
      harness: "claude",
      harnessTargetId: scheduled.harnessTargetId,
      turnId: scheduled.turnId,
      payload: {
        attemptId: "att_plugin",
        phase: "prepared",
        inputId: scheduled.messageId,
        launchSnapshot: {
          harnessTargetId: "claude",
          harness: "claude",
          harnessSessionKey: "claude-code",
          cwd: "/repo",
        },
      },
    });
    handle.append({
      kind: "_baton_delivery_attempt_update",
      source: { type: "baton" },
      harness: "claude",
      harnessTargetId: scheduled.harnessTargetId,
      turnId: scheduled.turnId,
      payload: { attemptId: "att_plugin", phase: "dispatching" },
    });
    handle.append({
      kind: "_baton_delivery_attempt_update",
      source: { type: "baton" },
      harness: "claude",
      harnessTargetId: scheduled.harnessTargetId,
      turnId: scheduled.turnId,
      payload: {
        attemptId: "att_plugin",
        phase: "uncertain",
        detail: "transport closed before admission could be confirmed",
      },
    });
    expect(store.list()[0]?.phase).toBe("uncertain");
    expect(store.restore()).toEqual([]);

    handle.append({
      kind: "_baton_turn_summary",
      source: { type: "baton" },
      harness: "claude",
      harnessTargetId: scheduled.harnessTargetId,
      turnId: scheduled.turnId,
      payload: {
        turnId: scheduled.turnId,
        stopReason: "error",
        userText: scheduled.prompt,
        agentText: "The focused test failed.",
        toolCalls: [{ toolCallId: "tc_1", status: "failed" }],
      },
    });
    expect(store.list()[0]).toMatchObject({
      phase: "completed",
      result: {
        stopReason: "error",
        agentText: "The focused test failed.",
      },
    });
    store.close();

    const restored = new TurnRequestStore(handle);
    expect(restored.restore()).toEqual([]);
    expect(restored.list()[0]?.phase).toBe("completed");
    restored.close();
  });

  test("rejects a changed envelope for the same requestKey without writing facts", () => {
    const handle = session();
    const store = new TurnRequestStore(handle);
    store.record(draft(handle.id));
    const before = handle.readEvents().length;

    expect(() =>
      store.record(draft(handle.id, { prompt: "Use a different prompt." }))
    ).toThrow("TurnRequest identity conflict");
    expect(handle.readEvents()).toHaveLength(before);
    store.close();
  });

  test("isolates a replacement Resource with the same name by UID", () => {
    const handle = session();
    const store = new TurnRequestStore(handle);
    const original = draft(handle.id);
    const first = store.record(original);
    const replacement: ReconcileTurnRequest = {
      ...original,
      resource: { ...original.resource, uid: "requirement_uid_2" },
    };
    const second = store.record(replacement);

    expect(second.requestId).not.toBe(first.requestId);
    expect(store.snapshots(replacement.key, original.resource)).toEqual([first]);
    expect(store.snapshots(replacement.key, replacement.resource)).toEqual([second]);
    store.close();
  });

  test("restores one persisted schedule without creating a second identity", () => {
    const handle = session();
    const first = new TurnRequestStore(handle);
    const pending = first.record(draft(handle.id, { harnessTargetId: "codex" }));
    const opened = handle.readEvents().find((event) =>
      event.kind === "interaction.opened" &&
      event.payload.turnRequestContext?.turnRequestId === pending.requestId
    );
    if (!opened || opened.kind !== "interaction.opened") {
      throw new Error("TurnRequest authorization was not opened");
    }
    const approved = first.resolve(
      opened.payload.interactionId,
      { kind: "permission", outcome: "selected", optionId: "allow_once" },
      "claude",
      new Set(["codex", "claude"]),
    );
    if (!approved?.scheduled) throw new Error("TurnRequest was not scheduled");
    first.close();

    const restored = new TurnRequestStore(handle);
    expect(restored.restore()).toEqual([approved.scheduled]);
    expect(
      handle.readEvents().filter((event) =>
        event.kind === "_baton_turn_request_scheduled"
      ),
    ).toHaveLength(1);
    expect(restored.list()[0]).toMatchObject({
      requestId: pending.requestId,
      harnessTargetId: "codex",
      phase: "queued",
    });
    restored.close();
  });

  test("declines or cancels only before admission", () => {
    const handle = session();
    const store = new TurnRequestStore(handle);
    const declined = store.record(draft(handle.id, { requestKey: "decline" }));
    const declineInteraction = handle.readEvents().find((event) =>
      event.kind === "interaction.opened" &&
      event.payload.turnRequestContext?.turnRequestId === declined.requestId
    );
    if (!declineInteraction || declineInteraction.kind !== "interaction.opened") {
      throw new Error("TurnRequest authorization was not opened");
    }
    store.resolve(
      declineInteraction.payload.interactionId,
      { kind: "permission", outcome: "selected", optionId: "reject" },
      "codex",
      new Set(["codex"]),
    );
    expect(store.list().find((item) => item.requestId === declined.requestId)?.phase)
      .toBe("declined");

    const cancelled = store.record(draft(handle.id, { requestKey: "cancel" }));
    expect(store.cancelBeforeAdmission(cancelled.requestId, "user")).toBeDefined();
    expect(store.list().find((item) => item.requestId === cancelled.requestId)?.phase)
      .toBe("cancelled");
    expect(store.cancelBeforeAdmission(cancelled.requestId, "user")).toBeUndefined();
    store.close();
  });
});
