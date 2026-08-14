import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Controller } from "../src/controller/index.ts";
import { projectChatState } from "../src/tui/protocol/state.ts";
import { MAIN_LANE_ID } from "../src/lane.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

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
  test("uses message identity for queued Inputs from different Lane Queues", () => {
    const controller = {
      activeHarnessTargetId: undefined,
      activeTurnId: undefined,
      queuedHarnessInputs: [
        {
          messageId: "m_main",
          enqueueSeq: 1,
          turnId: "t_main",
          harnessTargetId: "codex",
          laneId: MAIN_LANE_ID,
          harness: "codex",
          blocks: [{ type: "text", text: "main follow-up" }],
          source: { type: "user" },
        },
        {
          messageId: "m_side",
          enqueueSeq: 2,
          turnId: "t_side",
          harnessTargetId: "codex",
          laneId: "hl_side",
          harness: "codex",
          blocks: [{ type: "text", text: "side follow-up" }],
          source: { type: "plugin", pluginInstanceId: "reqloop_default" },
          harnessInvocationId: "hinv_side",
        },
      ],
      currentModel: () => null,
      currentEffort: () => null,
      currentMode: () => "default",
      approvalRoute: () => null,
      isBusy: false,
      harnessQueueLength: 2,
    } as unknown as Controller;

    expect(project(controller).composer.queued?.map((item) => item.id)).toEqual([
      "m_main",
      "m_side",
    ]);
  });

  test("keeps a pending native steer in Queue until the correlated apply receipt", () => {
    const turnId = "t_active";
    session.appendEvent({
      kind: "state_update",
      source: { type: "baton" },
      harness: "codex",
      harnessTargetId: "codex",
      laneId: MAIN_LANE_ID,
      turnId,
      payload: { state: "running" },
    });
    session.appendEvent({
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
      queuedHarnessInputs: [],
      currentModel: () => null,
      currentEffort: () => null,
      currentMode: () => "default",
      approvalRoute: () => null,
      isBusy: true,
      harnessQueueLength: 0,
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

    // Claude may keep a steer in its native queue after the turn it was offered to has ended.
    // Pending delivery remains future state until the lifecycle reports started/completed.
    session.appendEvent({
      kind: "state_update",
      source: { type: "harness", harnessTargetId: "codex" },
      harness: "codex",
      harnessTargetId: "codex",
      laneId: MAIN_LANE_ID,
      turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });

    const nativeQueued = project(controller);
    expect(nativeQueued.composer.queued).toEqual([{
      id: "m_steer",
      text: "prefer approach B",
      tag: "codex · native queue",
    }]);
    expect(
      nativeQueued.timeline.items.some(
        (item) => item.type === "message" && item.role === "user",
      ),
    ).toBe(false);

    session.appendEvent({
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

  test("removes failed native steer without presenting it as applied history", () => {
    const turnId = "t_failed";
    session.appendEvent({
      kind: "user_message",
      source: { type: "harness", harnessTargetId: "codex" },
      harness: "codex",
      harnessTargetId: "codex",
      laneId: MAIN_LANE_ID,
      turnId,
      payload: {
        messageId: "m_failed",
        content: [{ type: "text", text: "do not lose this" }],
        delivery: "steer",
        deliveryState: "pending",
      },
    });
    session.appendEvent({
      kind: "user_message",
      source: { type: "harness", harnessTargetId: "codex" },
      harness: "codex",
      harnessTargetId: "codex",
      laneId: MAIN_LANE_ID,
      turnId,
      payload: {
        messageId: "m_failed",
        delivery: "steer",
        deliveryState: "failed",
      },
    });
    const controller = {
      activeHarnessTargetId: undefined,
      activeTurnId: undefined,
      queuedHarnessInputs: [],
      currentModel: () => null,
      currentEffort: () => null,
      currentMode: () => "default",
      approvalRoute: () => null,
      isBusy: false,
      harnessQueueLength: 0,
    } as unknown as Controller;

    const failed = project(controller);
    expect(failed.composer.queued).toEqual([]);
    expect(
      failed.timeline.items.some(
        (item) => item.type === "message" && item.role === "user" && item.text === "do not lose this",
      ),
    ).toBe(false);
  });
});
