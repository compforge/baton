import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Controller } from "../src/controller/index.ts";
import { projectChatState } from "../src/tui/protocol/state.ts";
import { MAIN_LANE_ID, SessionStore, type SessionHandle } from "../src/store/store.ts";

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-steer-queue-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function project(controller: Controller) {
  return projectChatState({
    state: session.loadState(),
    controller,
    session,
    config: { showThoughts: true },
    harnessTargetId: "codex",
    toast: null,
    commandOutput: null,
    picker: null,
    board: { items: [], mode: "auto", sidecar: undefined },
  });
}

describe("steer queue projection", () => {
  test("keeps a pending native steer in Queue until the correlated apply receipt", () => {
    const turnId = "t_active";
    session.append({
      kind: "state_update",
      source: { type: "baton" },
      harness: "codex",
      harnessTargetId: "codex",
      laneId: MAIN_LANE_ID,
      turnId,
      payload: { state: "running" },
    });
    session.append({
      kind: "user_message",
      source: { type: "harness", harnessTargetId: "codex" },
      harness: "codex",
      harnessTargetId: "codex",
      laneId: MAIN_LANE_ID,
      turnId,
      payload: {
        messageId: "m_steer",
        content: [{ type: "text", text: "prefer approach B" }],
        delivery: "steer",
        deliveryState: "pending",
      },
    });
    const controller = {
      activeHarnessTargetId: "codex",
      activeTurnId: turnId,
      activeStartedAt: Date.now(),
      queuedTurns: [],
      currentModel: () => null,
      currentEffort: () => null,
      currentMode: () => "default",
      approvalRoute: () => null,
      isBusy: true,
      queueLength: 0,
    } as unknown as Controller;

    const pending = project(controller);
    expect(pending.composer.queued).toEqual([{
      id: "m_steer",
      text: "prefer approach B",
      tag: "codex · current turn",
    }]);
    expect(
      pending.timeline.items.some((item) => item.type === "message" && item.role === "user"),
    ).toBe(false);
    expect(pending.footer.text).toContain("queue:1");

    session.append({
      kind: "user_message",
      source: { type: "harness", harnessTargetId: "codex" },
      harness: "codex",
      harnessTargetId: "codex",
      laneId: MAIN_LANE_ID,
      turnId,
      payload: {
        messageId: "m_steer",
        delivery: "steer",
        deliveryState: "applied",
      },
    });

    const applied = project(controller);
    expect(applied.composer.queued).toEqual([]);
    expect(
      applied.timeline.items.some(
        (item) => item.type === "message" && item.role === "user" && item.text === "prefer approach B",
      ),
    ).toBe(true);
    expect(applied.footer.text).toContain("queue:0");
  });
});
