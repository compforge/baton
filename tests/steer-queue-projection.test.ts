import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Controller } from "../src/controller/index.ts";
import { projectChatState } from "../src/view/chat-tui/protocol/state.ts";
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

function appendQueuedInput(input: {
  messageId: string;
  turnId: string;
  laneId: string;
  blocks: { type: "text"; text: string }[];
  source?: { type: "user" } | { type: "plugin"; pluginInstanceId: string };
  harnessInvocationId?: string;
  status?: "queued" | "steering";
  delivery?: "prompt" | "steer";
}) {
  const source = input.source ?? { type: "user" as const };
  session.appendEvent({
    kind: "harness_input.updated",
    source,
    harness: "codex",
    harnessTargetId: "codex",
    laneId: input.laneId,
    turnId: input.turnId,
    payload: {
      messageId: input.messageId,
      turnId: input.turnId,
      harnessTargetId: "codex",
      laneId: input.laneId,
      blocks: input.blocks,
      source,
      status: input.status ?? "queued",
      delivery: input.delivery ?? "prompt",
      ...(input.harnessInvocationId
        ? { harnessInvocationId: input.harnessInvocationId }
        : {}),
    },
  });
}

describe("steer queue projection", () => {
  test("projects only the main Lane Queue into the composer", () => {
    appendQueuedInput({
      messageId: "m_main",
      turnId: "t_main",
      laneId: MAIN_LANE_ID,
      blocks: [{ type: "text", text: "main follow-up" }],
    });
    appendQueuedInput({
      messageId: "m_side",
      turnId: "t_side",
      laneId: "hl_side",
      blocks: [{ type: "text", text: "side follow-up" }],
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      harnessInvocationId: "hinv_side",
    });
    const controller = {
      activeHarnessTargetId: undefined,
      activeTurnId: undefined,
      currentModel: () => null,
      currentEffort: () => null,
      currentMode: () => "default",
      approvalRoute: () => null,
      preservesPendingSteers: () => true,
      isBusy: false,
      harnessQueueLength: 2,
    } as unknown as Controller;

    expect(project(controller).composer.queued?.map((item) => item.id)).toEqual(["m_main"]);
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
    appendQueuedInput({
      messageId: "m_steer",
      turnId,
      laneId: MAIN_LANE_ID,
      blocks: [{ type: "text", text: "prefer approach B" }],
      status: "steering",
      delivery: "steer",
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
      },
    });
    const controller = {
      activeHarnessTargetId: "codex",
      activeTurnId: turnId,
      activeStartedAt: Date.now(),
      currentModel: () => null,
      currentEffort: () => null,
      currentMode: () => "default",
      approvalRoute: () => null,
      preservesPendingSteers: () => true,
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
    // Pending delivery remains future state until the delivery receipt arrives.
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
      kind: "input_delivery_update",
      source: { type: "harness", harnessTargetId: "codex" },
      harness: "codex",
      harnessTargetId: "codex",
      laneId: MAIN_LANE_ID,
      turnId,
      payload: { messageId: "m_steer", state: "applied" },
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

  test("hides an orphaned pending steer when its Adapter cannot preserve a native queue", () => {
    const turnId = "t_interrupted";
    appendQueuedInput({
      messageId: "m_orphaned",
      turnId,
      laneId: MAIN_LANE_ID,
      blocks: [{ type: "text", text: "stale interrupted steer" }],
      status: "steering",
      delivery: "steer",
    });
    session.appendEvent({
      kind: "user_message",
      source: { type: "harness", harnessTargetId: "codex" },
      harness: "codex",
      harnessTargetId: "codex",
      laneId: MAIN_LANE_ID,
      turnId,
      payload: {
        messageId: "m_orphaned",
        content: [{ type: "text", text: "stale interrupted steer" }],
        delivery: "steer",
      },
    });
    const controller = {
      activeHarnessTargetId: undefined,
      activeTurnId: undefined,
      currentModel: () => null,
      currentEffort: () => null,
      currentMode: () => "default",
      approvalRoute: () => null,
      preservesPendingSteers: () => false,
      isBusy: false,
      harnessQueueLength: 0,
    } as unknown as Controller;

    const projected = project(controller);
    expect(projected.composer.queued).toEqual([]);
    expect(projected.footer.text).toContain("queue:0");
  });

  test("removes failed native steer without presenting it as applied history", () => {
    const turnId = "t_failed";
    appendQueuedInput({
      messageId: "m_failed",
      turnId,
      laneId: MAIN_LANE_ID,
      blocks: [{ type: "text", text: "do not lose this" }],
      status: "steering",
      delivery: "steer",
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
        content: [{ type: "text", text: "do not lose this" }],
        delivery: "steer",
      },
    });
    session.appendEvent({
      kind: "input_delivery_update",
      source: { type: "harness", harnessTargetId: "codex" },
      harness: "codex",
      harnessTargetId: "codex",
      laneId: MAIN_LANE_ID,
      turnId,
      payload: { messageId: "m_failed", state: "failed" },
    });
    const controller = {
      activeHarnessTargetId: undefined,
      activeTurnId: undefined,
      currentModel: () => null,
      currentEffort: () => null,
      currentMode: () => "default",
      approvalRoute: () => null,
      preservesPendingSteers: () => true,
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

  test("legacy ledger: bridges user_message deliveryState into the input projection", () => {
    const turnId = "t_legacy";
    session.appendEvent({
      kind: "state_update",
      source: { type: "baton" },
      harness: "codex",
      harnessTargetId: "codex",
      laneId: MAIN_LANE_ID,
      turnId,
      payload: { state: "running" },
    });
    // 老 ledger 没有 harness_input.updated 记录？不——accepted_steer 归一为 steering。
    session.appendEvent({
      kind: "harness_input.updated",
      source: { type: "user" },
      harness: "codex",
      harnessTargetId: "codex",
      laneId: MAIN_LANE_ID,
      turnId,
      payload: {
        messageId: "m_legacy",
        turnId,
        harnessTargetId: "codex",
        laneId: MAIN_LANE_ID,
        blocks: [{ type: "text", text: "legacy steer" }],
        source: { type: "user" },
        // 老 ledger 的接受态词汇；replay 归一到 steering。
        status: "accepted_steer" as never,
        delivery: "steer",
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
        messageId: "m_legacy",
        content: [{ type: "text", text: "legacy steer" }],
        delivery: "steer",
        deliveryState: "pending",
      },
    });
    const controller = {
      activeHarnessTargetId: "codex",
      activeTurnId: turnId,
      activeStartedAt: Date.now(),
      currentModel: () => null,
      currentEffort: () => null,
      currentMode: () => "default",
      approvalRoute: () => null,
      preservesPendingSteers: () => true,
      isBusy: true,
      harnessQueueLength: 0,
    } as unknown as Controller;

    const pending = project(controller);
    expect(pending.composer.queued).toEqual([{
      id: "m_legacy",
      text: "legacy steer",
      tag: "codex · current turn",
    }]);

    // 老 applied 补丁桥接成 deliveryOutcome，Transcript 随之可见。
    session.appendEvent({
      kind: "user_message",
      source: { type: "harness", harnessTargetId: "codex" },
      harness: "codex",
      harnessTargetId: "codex",
      laneId: MAIN_LANE_ID,
      turnId,
      payload: {
        messageId: "m_legacy",
        delivery: "steer",
        deliveryState: "applied",
      },
    });
    const applied = project(controller);
    expect(applied.composer.queued).toEqual([]);
    expect(
      applied.timeline.items.some(
        (item) => item.type === "message" && item.role === "user" && item.text === "legacy steer",
      ),
    ).toBe(true);
  });
});
