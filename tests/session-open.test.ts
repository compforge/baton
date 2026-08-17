import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CRASH_RECOVERY_NOTICE_TITLE,
  PENDING_DELIVERY_RECOVERY_NOTICE_TITLE,
  openBatonSession,
} from "../src/session/open.ts";
import { SessionStore } from "../src/store/store.ts";

let root: string;
let store: SessionStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-open-"));
  store = new SessionStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("openBatonSession", () => {
  test("creates a new session by default", () => {
    const result = openBatonSession(store, { cwd: "/repo", title: "chat" });
    expect(result.resumed).toBe(false);
    expect(result.session.meta.cwd).toBe("/repo");
  });

  test("opens an explicit session and keeps its cwd", () => {
    const existing = store.createSession({ cwd: "/original" });
    const result = openBatonSession(store, { cwd: "/ignored", sessionId: existing.id });
    expect(result.resumed).toBe(true);
    expect(result.session.id).toBe(existing.id);
    expect(result.session.meta.cwd).toBe("/original");
  });

  test("continues the most recently active session in the cwd", () => {
    const older = store.createSession({ cwd: "/repo" });
    older.updateMeta({ updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = store.createSession({ cwd: "/repo" });
    newer.updateMeta({ updatedAt: "2026-01-02T00:00:00.000Z" });
    store.createSession({ cwd: "/other" }).updateMeta({ updatedAt: "2026-01-03T00:00:00.000Z" });

    const result = openBatonSession(store, { cwd: "/repo", continueLast: true });
    expect(result.resumed).toBe(true);
    expect(result.session.id).toBe(newer.id);
  });

  test("continue creates a session when the cwd has no history", () => {
    const result = openBatonSession(store, { cwd: "/empty", continueLast: true });
    expect(result.resumed).toBe(false);
    expect(result.session.meta.cwd).toBe("/empty");
  });

  test("rejects conflicting selectors", () => {
    expect(() =>
      openBatonSession(store, { cwd: "/repo", sessionId: "bs_x", continueLast: true }),
    ).toThrow(/cannot be used together/);
  });
});

describe("crash recovery on open", () => {
  test("fails a native steer queue that lost its Adapter process", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.appendEvent({
      source: { type: "baton" },
      kind: "state_update",
      payload: { state: "running" },
      harness: "claude-code",
      harnessTargetId: "claude",
      turnId: "t1",
    });
    // 新式 ledger：steering input + 正文 upsert，投递事实在 input 投影。
    h.appendEvent({
      source: { type: "user" },
      kind: "harness_input.updated",
      payload: {
        messageId: "m_pending",
        turnId: "t1",
        harnessTargetId: "claude",
        laneId: "hl_main",
        blocks: [{ type: "text", text: "queued after this turn" }],
        source: { type: "user" },
        status: "steering",
        delivery: "steer",
      },
      harness: "claude-code",
      harnessTargetId: "claude",
      turnId: "t1",
    });
    h.appendEvent({
      source: { type: "harness", harnessTargetId: "claude" },
      kind: "user_message",
      payload: {
        messageId: "m_pending",
        content: [{ type: "text", text: "queued after this turn" }],
        delivery: "steer",
      },
      harness: "claude-code",
      harnessTargetId: "claude",
      turnId: "t1",
    });
    // 老 ledger 形态：投递状态寄生在 user_message.deliveryState。
    h.appendEvent({
      source: { type: "harness", harnessTargetId: "claude" },
      kind: "user_message",
      payload: {
        messageId: "m_legacy_pending",
        content: [{ type: "text", text: "legacy queued steer" }],
        delivery: "steer",
        deliveryState: "pending",
      },
      harness: "claude-code",
      harnessTargetId: "claude",
      turnId: "t1",
    });
    h.appendEvent({
      source: { type: "harness", harnessTargetId: "claude" },
      kind: "state_update",
      payload: { state: "idle", stopReason: "end_turn" },
      harness: "claude-code",
      harnessTargetId: "claude",
      turnId: "t1",
    });
    h.summarizeTurnEvent("t1");

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });

    expect(result.recovered).toBe(true);
    // 新式：投递事实收在 input 投影。
    expect(
      result.session.loadState().harnessInputs.get("m_pending")?.deliveryOutcome,
    ).toBe("failed");
    // 老 ledger：回执镜像到 legacy deliveryState。
    expect(result.session.loadState().messages.get("m_legacy_pending")?.deliveryState).toBe("failed");
    expect(
      result.session
        .loadState()
        .notices.some((notice) => notice.title === PENDING_DELIVERY_RECOVERY_NOTICE_TITLE),
    ).toBe(true);

    const count = result.session.ledger.read().length;
    const second = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(second.recovered).toBe(false);
    expect(second.session.ledger.read()).toHaveLength(count);
  });

  test("does not infer a stable HarnessSession identity from event envelopes", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.setHarnessSession("claude", {
      harnessTargetId: "claude",
      harness: "claude-code",
      harnessSessionId: "hs_runtime_only",
      resumeState: {
        version: 1,
        data: { sessionId: "hs_runtime_only" },
      },
    });
    h.appendEvent({
      source: { type: "harness", harnessTargetId: "claude" },
      kind: "state_update",
      payload: { state: "running" },
      harness: "claude-code",
      harnessTargetId: "claude",
      harnessSessionId: "4bc983eb-f25c-4857-9ac2-28ac6442e74c",
      turnId: "t1",
    });
    h.appendEvent({
      source: { type: "harness", harnessTargetId: "claude" },
      kind: "state_update",
      payload: { state: "idle", stopReason: "end_turn" },
      harness: "claude-code",
      harnessTargetId: "claude",
      harnessSessionId: "4bc983eb-f25c-4857-9ac2-28ac6442e74c",
      turnId: "t1",
    });
    h.summarizeTurn("t1");

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });

    expect(result.recovered).toBe(false);
    expect(result.session.meta.harnessSessions.claude?.harnessSessionId).toBe("hs_runtime_only");
    expect(result.session.meta.harnessSessions.claude?.resumeState).toEqual({
      version: 1,
      data: { sessionId: "hs_runtime_only" },
    });
  });

  test("does not apply provider-specific handle recovery in session core", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.setHarnessSession("claude", {
      harnessTargetId: "claude",
      harness: "claude-code",
      harnessSessionId: "hs_runtime_only",
      resumeState: {
        version: 1,
        data: { sessionId: "hs_runtime_only" },
      },
    });
    h.appendEvent({
      source: { type: "baton" },
      kind: "state_update",
      payload: { state: "running" },
      harness: "claude-code",
      harnessTargetId: "claude",
      harnessSessionId: "hs_runtime_only",
      turnId: "t1",
    });
    h.appendEvent({
      source: { type: "baton" },
      kind: "state_update",
      payload: { state: "idle", stopReason: "error" },
      harness: "claude-code",
      harnessTargetId: "claude",
      harnessSessionId: "hs_runtime_only",
      turnId: "t1",
    });
    h.summarizeTurn("t1");

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });

    expect(result.recovered).toBe(false);
    expect(result.session.meta.harnessSessions.claude?.harnessSessionId).toBe("hs_runtime_only");
    expect(result.session.meta.harnessSessions.claude?.resumeState).toEqual({
      version: 1,
      data: { sessionId: "hs_runtime_only" },
    });
  });

  test("normalizes an interrupted turn: idle + notice + summary", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.appendEvent({
      source: { type: "baton" },
      kind: "state_update",
      payload: { state: "running" },
      harness: "codex",
      harnessTargetId: "codex-work",
      turnId: "t1",
    });
    h.appendEvent({
      source: { type: "baton" },
      kind: "user_message",
      payload: { messageId: "m1", content: [{ type: "text", text: "hi" }] },
      harness: "codex",
      harnessTargetId: "codex-work",
      turnId: "t1",
    });
    h.appendEvent({
      source: { type: "baton" },
      kind: "agent_message_chunk",
      payload: { messageId: "m2", content: { type: "text", text: "partial" } },
      harness: "codex",
      harnessTargetId: "codex-work",
      turnId: "t1",
    });

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.recovered).toBe(true);
    const state = result.session.loadState();
    expect(state.runState).toBe("idle");
    expect(state.lastStopReason).toBe("cancelled");
    expect(state.notices.some((n) => n.title === CRASH_RECOVERY_NOTICE_TITLE)).toBe(true);
    // 中断 turn 补上 summary：catch-up / @ 引用只读 summary，缺失即永久盲区
    expect(state.turnSummaries.map((s) => s.turnId)).toEqual(["t1"]);
    expect(state.turnSummaries[0]!.stopReason).toBe("cancelled");
    expect(
      result.session
        .ledger.read()
        .filter((event) => event.turnId === "t1")
        .every((event) => event.harnessTargetId === "codex-work"),
    ).toBe(true);
  });

  test("concurrent interrupted turns each get idle + notice + summary", () => {
    const h = store.createSession({ cwd: "/repo" });
    // Queue-driven Turn 与同 Harness 的 Harness-started Turn 并行时崩溃。
    h.appendEvent({ source: { type: "baton" }, kind: "state_update", payload: { state: "running" }, harness: "codex", turnId: "t_driven" });
    h.appendEvent({
      source: { type: "baton" },
      kind: "agent_message_chunk",
      payload: { messageId: "m1", content: { type: "text", text: "partial" } },
      harness: "codex",
      turnId: "t_driven",
    });
    h.appendEvent({
      source: { type: "harness", harnessTargetId: "claude" },
      kind: "state_update",
      payload: { state: "running" },
      harness: "claude-code",
      turnId: "t_obs",
    });
    h.appendEvent({
      source: { type: "baton" },
      kind: "agent_message",
      payload: { messageId: "m2", content: [{ type: "text", text: "bg partial" }] },
      harness: "claude-code",
      turnId: "t_obs",
    });

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.recovered).toBe(true);
    const state = result.session.loadState();
    expect(state.activeTurns.size).toBe(0); // 每个 turn 各自收口，不是只收最后一个
    expect(state.runState).toBe("idle");
    expect(state.stopReasons.get("t_driven")).toBe("cancelled");
    expect(state.stopReasons.get("t_obs")).toBe("cancelled");
    expect(state.notices.filter((n) => n.title === CRASH_RECOVERY_NOTICE_TITLE)).toHaveLength(2);
    expect(state.turnSummaries.map((s) => s.turnId).sort()).toEqual(["t_driven", "t_obs"]);
    for (const summary of state.turnSummaries) expect(summary.stopReason).toBe("cancelled");
    // 恢复合成的终态恒带 turnId（per-turn reducer 的精确收口依赖它）
    const recoveryIdles = result.session
      .ledger.read()
      .filter((ev) => ev.kind === "state_update" && (ev.payload as { state?: string }).state === "idle");
    for (const idle of recoveryIdles) expect(idle.turnId).toBeTruthy();
  });

  test("recovery is idempotent: second open changes nothing", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.appendEvent({ source: { type: "baton" }, kind: "state_update", payload: { state: "running" }, harness: "codex", turnId: "t1" });

    openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    const count = store.openSession(h.id).ledger.read().length;
    const second = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(second.recovered).toBe(false);
    expect(second.session.ledger.read()).toHaveLength(count);
  });

  test("completed turn missing its summary gets one, without an interruption notice", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.appendEvent({ source: { type: "baton" }, kind: "state_update", payload: { state: "running" }, harness: "codex", turnId: "t1" });
    h.appendEvent({
      source: { type: "baton" },
      kind: "agent_message_chunk",
      payload: { messageId: "m1", content: { type: "text", text: "done" } },
      harness: "codex",
      turnId: "t1",
    });
    h.appendEvent({ source: { type: "baton" }, kind: "state_update", payload: { state: "idle", stopReason: "end_turn" }, harness: "codex", turnId: "t1" });

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.recovered).toBe(true);
    const state = result.session.loadState();
    expect(state.notices).toHaveLength(0);
    expect(state.turnSummaries.map((s) => s.turnId)).toEqual(["t1"]);
    expect(state.turnSummaries[0]!.stopReason).toBe("end_turn");
  });

  test("dangling permission Interactions are cancelled", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.appendEvent({ source: { type: "baton" }, kind: "state_update", payload: { state: "running" }, harness: "codex", turnId: "t1" });
    h.appendEvent({
      source: { type: "baton" },
      kind: "interaction.requested",
      payload: {
        kind: "permission",
        interactionId: "ix1",
        requester: { type: "harness", harnessTargetId: "codex" },
        title: "Run rm -rf?",
        options: [{ optionId: "yes", name: "Yes", polarity: "allow", lifetime: "once" }],
      },
      harness: "codex",
      turnId: "t1",
    });

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.recovered).toBe(true);
    expect(result.session.loadState().interactions.get("ix1")?.result).toEqual({
      kind: "cancelled",
      reason: "recovery",
    });
  });

  test("dangling question Interactions are cancelled", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.appendEvent({ source: { type: "baton" }, kind: "state_update", payload: { state: "running" }, harness: "codex", turnId: "t1" });
    h.appendEvent({
      source: { type: "baton" },
      kind: "interaction.requested",
      payload: {
        kind: "question",
        interactionId: "ix2",
        requester: { type: "harness", harnessTargetId: "codex" },
        questions: [{ questionId: "mode", header: "Mode", question: "Which mode?" }],
      },
      harness: "codex",
      turnId: "t1",
    });

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.recovered).toBe(true);
    expect(result.session.loadState().interactions.get("ix2")?.result).toEqual({
      kind: "cancelled",
      reason: "recovery",
    });
  });

  test("dangling Plugin Interactions fail with their interrupted execution", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.appendEvent({
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      kind: "interaction.requested",
      payload: {
        kind: "question",
        interactionId: "ix_plugin",
        requester: {
          type: "plugin",
          pluginInstanceId: "reqloop_default",
        },
        pluginContext: { executionId: "pex_plugin", verb: "ask" },
        questions: [
          {
            questionId: "decision",
            header: "Associate pull request",
            question: "Choose a requirement",
          },
        ],
      },
    });

    const result = openBatonSession(store, {
      cwd: "/repo",
      sessionId: h.id,
    });
    expect(result.recovered).toBe(true);
    expect(
      result.session.loadState().interactions.get("ix_plugin")?.result,
    ).toEqual({
      kind: "cancelled",
      reason: "recovery",
      detail: "Plugin execution was interrupted by Core restart",
    });
  });

  test("dangling hook trust Interactions are cancelled", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.appendEvent({ source: { type: "baton" }, kind: "state_update", payload: { state: "running" }, harness: "codex", turnId: "t1" });
    h.appendEvent({
      source: { type: "baton" },
      kind: "interaction.requested",
      payload: {
        kind: "hook_trust",
        interactionId: "ix3",
        requester: { type: "harness", harnessTargetId: "codex" },
        harnessName: "Codex",
        hooks: [
          {
            key: "hook1",
            source: "plugin",
            sourcePath: "/plugins/devloop/hooks.json",
            trustStatus: "modified",
            command: "python hook.py",
          },
        ],
      },
      harness: "codex",
      turnId: "t1",
    });

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.recovered).toBe(true);
    expect(result.session.loadState().interactions.get("ix3")?.result).toEqual({
      kind: "cancelled",
      reason: "recovery",
    });
  });

  test("clean session is untouched", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.appendEvent({ source: { type: "baton" }, kind: "state_update", payload: { state: "running" }, harness: "codex", turnId: "t1" });
    h.appendEvent({ source: { type: "baton" }, kind: "state_update", payload: { state: "idle", stopReason: "end_turn" }, harness: "codex", turnId: "t1" });
    h.summarizeTurn("t1");
    const count = h.ledger.read().length;

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.recovered).toBe(false);
    expect(result.session.ledger.read()).toHaveLength(count);
  });
});

describe("session lock", () => {
  test("open fails while another live process holds the lock", () => {
    const h = store.createSession({ cwd: "/repo" });
    writeFileSync(join(h.dir, "lock"), "1"); // pid 1 一定存活（launchd/init），且 kill 探测返回 EPERM
    expect(() => openBatonSession(store, { cwd: "/repo", sessionId: h.id })).toThrow(/in use/);
  });

  test("stale lock from a dead process is taken over", () => {
    const h = store.createSession({ cwd: "/repo" });
    const dead = spawnSync("true").pid; // 已退出进程的 pid
    writeFileSync(join(h.dir, "lock"), String(dead));
    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.session.id).toBe(h.id);
    expect(readFileSync(join(h.dir, "lock"), "utf8")).toBe(String(process.pid));
  });

  test("re-entrant within the same process", () => {
    const h = store.createSession({ cwd: "/repo" });
    openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(() => openBatonSession(store, { cwd: "/repo", sessionId: h.id })).not.toThrow();
  });

  test("releaseLock only removes our own lock", () => {
    const h = store.createSession({ cwd: "/repo" });
    writeFileSync(join(h.dir, "lock"), "1");
    h.releaseLock();
    expect(readFileSync(join(h.dir, "lock"), "utf8")).toBe("1");
  });
});

describe("lock hardening (codex review)", () => {
  test("corrupt lock content is treated as stale and taken over", () => {
    const h = store.createSession({ cwd: "/repo" });
    writeFileSync(join(h.dir, "lock"), "not-a-pid");
    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.session.id).toBe(h.id);
    expect(readFileSync(join(h.dir, "lock"), "utf8")).toBe(String(process.pid));
  });

  test("recovery failure releases the lock before rethrowing", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.appendEvent({ source: { type: "baton" }, kind: "state_update", payload: { state: "running" }, harness: "codex", turnId: "t1" });
    // 中间行损坏：recovery 读取 Event Ledger 时会抛错。
    appendFileSync(join(h.dir, "session.jsonl"), "garbage\n");
    h.appendEvent({ source: { type: "baton" }, kind: "state_update", payload: { state: "running" }, harness: "codex", turnId: "t1" });

    expect(() => openBatonSession(store, { cwd: "/repo", sessionId: h.id })).toThrow(/corrupt/);
    // 锁必须已释放：否则本进程存活期间该会话被永久判"在用"
    expect(existsSync(join(h.dir, "lock"))).toBe(false);
  });
});
