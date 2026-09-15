import { describe, expect, test } from "bun:test";

import { createReconcileSnapshot } from "../src/plugin/reconcile-snapshot.ts";
import { emptySessionState } from "../src/store/reduce.ts";

describe("ReconcileSnapshot", () => {
  test("projects and freezes the current session state for Plugin reconcile", () => {
    const state = emptySessionState();
    state.runState = "running";
    state.lastSeq = 12;
    state.activeTurns.set("t_latest", {
      turnId: "t_latest",
      state: "running",
      harness: "codex",
      harnessTargetId: "codex",
      startedAt: 1_000,
    });
    state.turnSummaries.push({
      turnId: "t_previous",
      stopReason: "end_turn",
      userText: "previous",
      agentText: "done",
      toolCalls: [],
    });
    state.turnSummaries.push({
      turnId: "t_latest",
      stopReason: "error",
      userText: "latest",
      toolCalls: [{ toolCallId: "tc_1", status: "failed" }],
    });
    state.interactions.set("ix_1", {
      request: {
        messageId: "ix_1",
        source: { kind: "harness", key: "codex" },
        target: { kind: "user", key: "local" },
        kind: "input_request",
        request: { kind: "question", questions: [] },
        status: "pending",
        createdAt: "2026-09-15T00:00:00Z",
        turnId: "t_latest",
      },
      requestedEventId: "ev_request",
    });

    const snapshot = createReconcileSnapshot({
      batonSessionId: "bs_test",
      cwd: "/tmp/project",
      state,
      harnessInputs: [{
        messageId: "m_1",
        turnId: "t_queued",
        harnessTargetId: "claude",
        laneId: "hl_input",
        harness: "claude",
        status: "queued",
        delivery: "prompt",
        source: { type: "user" },
      }],
      harnessTargets: [
        { id: "codex", harness: "codex", label: "Codex" },
        { id: "claude", harness: "claude", label: "Claude Code" },
      ],
    });

    expect(snapshot.session).toEqual({
      batonSessionId: "bs_test",
      cwd: "/tmp/project",
      runState: "running",
      revision: 12,
    });
    expect(snapshot.activeTurns).toEqual([{
      turnId: "t_latest",
      state: "running",
      harness: "codex",
      harnessTargetId: "codex",
      startedAt: 1_000,
    }]);
    expect(snapshot.harnessInputs.map((input) => input.turnId)).toEqual(["t_queued"]);
    expect(snapshot.harnessTargets.map((target) => target.id)).toEqual([
      "codex",
      "claude",
    ]);
    expect(snapshot.pendingInteractions).toEqual([{
      messageId: "ix_1",
      kind: "question",
      source: { kind: "harness", key: "codex" },
      target: { kind: "user", key: "local" },
      turnId: "t_latest",
    }]);
    expect(snapshot.latestTurn?.turnId).toBe("t_latest");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.latestTurn?.toolCalls)).toBe(true);
  });
});
