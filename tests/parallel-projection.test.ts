import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptBlockItem, TranscriptItem } from "chat-tui";

import type { Controller } from "../src/controller/index.ts";
import { MAIN_LANE_ID } from "../src/lane.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";
import { projectChatState } from "../src/view/chat-tui/protocol/state.ts";

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-parallel-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const controller = {
  activeHarnessTargetId: undefined,
  activeTurnId: undefined,
  queuedHarnessInputs: [],
  currentModel: () => null,
  currentEffort: () => null,
  currentMode: () => "default",
  approvalRoute: () => null,
  preservesPendingSteers: () => true,
  isBusy: false,
  harnessQueueLength: 0,
} as unknown as Controller;

function project() {
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

function transcriptBlock(
  items: readonly TranscriptItem[],
  id: string,
): TranscriptBlockItem | undefined {
  for (const item of items) {
    if (item.type === "block" && item.id === id) return item;
    if (item.type === "group") {
      const member = item.members.find((member) => member.id === id);
      if (member) return member;
    }
  }
  return undefined;
}

describe("Parallel projection", () => {
  test("keeps a native subagent out of Timeline until it completes", () => {
    const coordinate = {
      harness: "claude-code",
      harnessTargetId: "claude",
      laneId: MAIN_LANE_ID,
      turnId: "t_main",
    } as const;
    session.appendEvent({
      source: { type: "harness", harnessTargetId: "claude" },
      kind: "task_update",
      ...coordinate,
      payload: {
        taskId: "task-1",
        status: "in_progress",
        title: "Inspect adapter",
        taskType: "Explore",
        lastToolName: "Read",
        usage: { totalTokens: 12_345, toolUses: 2, durationMs: 30 },
      },
    });

    const running = project();
    expect(running.parallel).toMatchObject({
      items: [{
        id: "task:task-1",
        icon: "◇",
        name: "claude/Explore",
        description: "Inspect adapter",
        progress: "running · Read",
        tokens: 12_345,
      }],
    });
    expect(transcriptBlock(running.timeline.items, "task-1")).toBeUndefined();

    session.appendEvent({
      source: { type: "harness", harnessTargetId: "claude" },
      kind: "task_update",
      ...coordinate,
      payload: { taskId: "task-1", status: "completed", summary: "Found it" },
    });
    const completed = project();
    expect(completed.parallel).toBeUndefined();
    expect(transcriptBlock(completed.timeline.items, "task-1")).toMatchObject({
      kind: "task",
      status: "completed",
      title: "Inspect adapter",
    });
  });

  test("keeps a provider task generic when it has no agent type", () => {
    session.appendEvent({
      source: { type: "harness", harnessTargetId: "deepseek" },
      kind: "task_update",
      harness: "deepseek-harness",
      harnessTargetId: "deepseek",
      laneId: MAIN_LANE_ID,
      turnId: "t_main",
      payload: {
        taskId: "task-generic",
        status: "in_progress",
        title: "Index repository",
        usage: { totalTokens: 800 },
      },
    });

    expect(project().parallel?.items).toEqual([
      expect.objectContaining({
        id: "task:task-generic",
        icon: "•",
        name: "dsh",
        description: "Index repository",
        progress: "running",
        tokens: 800,
      }),
    ]);
  });

  test("shows a foreground subagent only after Claude backgrounds it", () => {
    const coordinate = {
      harness: "claude-code",
      harnessTargetId: "claude",
      laneId: MAIN_LANE_ID,
      turnId: "t_main",
    } as const;
    session.appendEvent({
      source: { type: "harness", harnessTargetId: "claude" },
      kind: "task_update",
      ...coordinate,
      payload: {
        taskId: "task-nested",
        status: "in_progress",
        title: "Inspect nested flow",
        taskType: "Explore",
        backgrounded: false,
        spawnDepth: 2,
      },
    });
    expect(project().parallel).toBeUndefined();

    session.appendEvent({
      source: { type: "harness", harnessTargetId: "claude" },
      kind: "task_update",
      ...coordinate,
      payload: {
        taskId: "task-nested",
        status: "in_progress",
        backgrounded: true,
      },
    });
    expect(project().parallel?.items).toEqual([
      expect.objectContaining({
        id: "task:task-nested",
        progress: "running · depth 2",
      }),
    ]);
  });

  test("shows skipTranscript tasks while live without adding terminal history", () => {
    const coordinate = {
      harness: "deepseek-harness",
      harnessTargetId: "deepseek",
      laneId: MAIN_LANE_ID,
      turnId: "t_main",
    } as const;
    session.appendEvent({
      source: { type: "harness", harnessTargetId: "deepseek" },
      kind: "task_update",
      ...coordinate,
      payload: {
        taskId: "dsh-child",
        status: "in_progress",
        title: "DeepSeek Harness subagent",
        taskType: "dsh-subagent",
        skipTranscript: true,
      },
    });

    expect(project().parallel?.items).toEqual([
      expect.objectContaining({
        id: "task:dsh-child",
        name: "dsh/dsh-subagent",
        description: "DeepSeek Harness subagent",
      }),
    ]);
    expect(project().timeline.items.find((item) => item.id === "dsh-child")).toBeUndefined();

    session.appendEvent({
      source: { type: "harness", harnessTargetId: "deepseek" },
      kind: "task_update",
      ...coordinate,
      payload: {
        taskId: "dsh-child",
        status: "completed",
        skipTranscript: true,
      },
    });

    expect(project().parallel).toBeUndefined();
    expect(project().timeline.items.find((item) => item.id === "dsh-child")).toBeUndefined();
  });

  test("shows a live side Lane as one async agent and restores its terminal card", () => {
    session.appendEvent({
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      kind: "_baton_harness_invocation_recorded",
      payload: {
        invocationId: "hinv_worker",
        executionId: "pex_worker",
        verb: "harness",
        title: "Implement requirement",
        prompt: "Implement REQ-1",
        laneId: MAIN_LANE_ID,
        newLane: true,
        harnessTargetId: "codex",
      },
    });
    session.appendEvent({
      source: { type: "baton" },
      kind: "_baton_harness_invocation_scheduled",
      payload: {
        invocationId: "hinv_worker",
        messageId: "m_worker",
        turnId: "t_worker",
        harnessTargetId: "codex",
        laneId: "hl_worker",
      },
    });
    const coordinate = {
      harness: "codex",
      harnessTargetId: "codex",
      laneId: "hl_worker",
      turnId: "t_worker",
    } as const;
    session.appendEvent({
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      kind: "user_message",
      ...coordinate,
      payload: {
        messageId: "m_worker",
        content: [{ type: "text", text: "Implement REQ-1" }],
      },
    });
    session.appendEvent({
      source: { type: "harness", harnessTargetId: "codex" },
      kind: "state_update",
      ...coordinate,
      payload: { state: "running" },
    });

    const running = project();
    expect(running.activity.items).toHaveLength(1);
    expect(running.parallel?.items).toEqual([
      expect.objectContaining({
        id: "invocation:hinv_worker",
        icon: "↗",
        name: "codex",
        description: "Implement requirement",
        progress: "running · requested by reqloop_default",
      }),
    ]);
    expect(
      transcriptBlock(running.timeline.items, "harness-invocation:hinv_worker"),
    ).toBeUndefined();

    session.appendEvent({
      source: { type: "harness", harnessTargetId: "codex" },
      kind: "state_update",
      ...coordinate,
      payload: { state: "idle", stopReason: "end_turn" },
    });
    session.appendEvent({
      source: { type: "baton" },
      kind: "_baton_turn_summary",
      ...coordinate,
      payload: {
        turnId: "t_worker",
        stopReason: "end_turn",
        agentText: "Implemented and tested.",
        toolCalls: [],
      },
    });
    const completed = project();
    expect(completed.parallel).toBeUndefined();
    expect(
      transcriptBlock(completed.timeline.items, "harness-invocation:hinv_worker"),
    ).toMatchObject({
      kind: "task",
      status: "completed",
      title: "Implement requirement · completed",
    });
  });
});
