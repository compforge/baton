// Harness 自行开始的 Turn 与投影单通道契约测试（见 docs/workflow.md）。
// 回归背景：后台任务唤醒的回复曾"只持久化、不投影"——事件落了 session.jsonl，
// 但 TUI 的 SessionState 只从 per-turn 回调更新，唤醒发生在两个 Queue-driven Turn 之间，
// UI 上什么都没出现（真实事故：bs_01KXA2FP1J… seq 361 idle 之后的 551/556/631）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAdapter, startsHarnessTurn } from "../src/harness/claude/adapter.ts";
import type {
  AdapterCapabilities,
  HarnessAdapter,
  EventSink,
  ModelOption,
  OpenOptions,
  PromptInput,
  SendTurnReceipt,
  HarnessSessionHandle,
} from "../src/harness/adapter.ts";
import { DEFAULT_CONFIG } from "../src/config/config.ts";
import type { AnyEventDraft } from "../src/event/index.ts";
import { Controller } from "../src/controller/index.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";
import { BatonChatProtocol } from "../src/tui/protocol/index.ts";
import { resolveTestTarget } from "./harness-target.ts";

let root: string;
let store: SessionStore;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-harnessTurn-"));
  store = new SessionStore(root);
  session = store.createSession({ cwd: "/repo" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---- 不变量：任何 append 进 store 的事件必然到达 UI 投影 ----
// 参数化事件到达时机：无活跃 Turn / Queue-driven Turn 运行中（同 Harness）/（异 Harness）。
// 投影正确性不允许依赖 controller 的 turn 状态——这正是当年丢消息的机制。

describe("State invariant: every appended event reaches the timeline", () => {
  const arrivals: Array<{ name: string; before: AnyEventDraft[] }> = [
    { name: "while idle (between turns)", before: [] },
    {
      name: "while a Queue-driven Turn of the same Harness is running",
      before: [
        { kind: "state_update", turnId: "t_driven", payload: { state: "running" } },
      ],
    },
    {
      name: "while a Queue-driven Turn of another Harness is running",
      before: [{ kind: "state_update", turnId: "t_other", payload: { state: "running" } }],
    },
  ];

  for (const arrival of arrivals) {
    test(arrival.name, async () => {
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      for (const ev of arrival.before) session.ledger.append({ ...ev, source: { type: "baton" } } as never);
      session.ledger.append({
        source: { type: "harness", harnessTargetId: "claude" },
        kind: "agent_message",
        harness: "claude-code",
        turnId: "t_observed",
        payload: { messageId: "m_wake", content: [{ type: "text", text: "background result" }] },
      });
      expect(
        protocol.stateStore.getState("timeline").items.some((item) => item.type === "message" && item.id === "m_wake"),
      ).toBe(true);
      await protocol.exit();
    });
  }
});

describe("Harness-started Turn presentation", () => {
  test("shows one busy run-status line while a Turn runs; clears it on idle", async () => {
    const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
    session.ledger.append({
      source: { type: "harness", harnessTargetId: "claude" },
      kind: "state_update",
      harness: "claude-code",
      turnId: "t_obs",
      payload: { state: "running" },
    });
    let composer = protocol.stateStore.getState("composer");
    let runStatus = protocol.stateStore.getState("activity").items;
    expect(composer.busy).toBe(true);
    expect(runStatus).toHaveLength(1);
    const line = runStatus?.[0];
    expect(line).toBeDefined();
    expect(line?.id).toBe("run:t_obs");
    expect(line?.author).toBe("claude");
    // 该 Turn 没有对应 Queue run，Esc 没有可中断的队列所有权。
    expect(line?.hint).toBeUndefined();

    session.ledger.append({
      source: { type: "harness", harnessTargetId: "claude" },
      kind: "state_update",
      harness: "claude-code",
      turnId: "t_obs",
      payload: { state: "idle", stopReason: "end_turn" },
    });
    composer = protocol.stateStore.getState("composer");
    runStatus = protocol.stateStore.getState("activity").items;
    expect(composer.busy).toBe(false);
    expect(runStatus).toHaveLength(1);
    expect(runStatus?.[0]).toMatchObject({
      author: "codex",
      label: "default · idle",
    });
    await protocol.exit();
  });

  test("concurrent Turns still project a single latest run-status line", async () => {
    const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
    for (const turnId of ["t_obs1", "t_obs2"]) {
      session.ledger.append({
        source: { type: "harness", harnessTargetId: "claude" },
        kind: "state_update",
        harness: "claude-code",
        turnId,
        payload: { state: "running" },
      });
    }
    let composer = protocol.stateStore.getState("composer");
    let runStatus = protocol.stateStore.getState("activity").items;
    expect(composer.busy).toBe(true);
    expect(runStatus).toHaveLength(1);
    expect(runStatus?.[0]?.id).toBe("run:t_obs2");

    // 一个收口不影响另一个（单槽时代任何 idle 都会全局清空）
    session.ledger.append({
      source: { type: "harness", harnessTargetId: "claude" },
      kind: "state_update",
      harness: "claude-code",
      turnId: "t_obs1",
      payload: { state: "idle", stopReason: "end_turn" },
    });
    composer = protocol.stateStore.getState("composer");
    runStatus = protocol.stateStore.getState("activity").items;
    expect(composer.busy).toBe(true);
    expect(runStatus).toHaveLength(1);
    expect(runStatus?.[0]?.id).toBe("run:t_obs2");
    await protocol.exit();
  });
});

// ---- Controller：没有对应 Queue run 的 Turn 不碰队列 ----

/** Queue-driven Turn 正常完成后，再在同一 sink 上补发一个 Harness-started Turn。 */
class WakingAdapter implements HarnessAdapter {
  readonly harness = "claude-code";
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  sink?: EventSink;
  /** 只在首个 Queue-driven Turn 后唤醒一次，避免测试结束后仍有 pending 的异步 append。 */
  private woken = false;

  async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionHandle> {
    this.sink = sink;
    return { harness: this.harness, handleId: "waking-ref", resumed: false };
  }

  async listModels(_ref: HarnessSessionHandle): Promise<ModelOption[]> {
    return [{ id: "default", label: "Default" }];
  }

  async sendTurn(_ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt> {
    this.sink?.({
      kind: "user_message",
      turnId: input.turnId,
      payload: { messageId: input.messageId, content: input.blocks },
    });
    void (async () => {
      this.sink?.({
        kind: "state_update",
        turnId: input.turnId,
        payload: { state: "idle", stopReason: "end_turn" },
      });
      // Queue-driven Turn 已收界；稍后 Harness 自发开界（后台任务唤醒）。
      if (this.woken) return;
      this.woken = true;
      await Bun.sleep(5);
      this.sink?.({
        kind: "state_update",
        turnId: "t_wake",
        payload: { state: "running" },
      });
      this.sink?.({
        kind: "agent_message",
        turnId: "t_wake",
        payload: { messageId: "m_wake", content: [{ type: "text", text: "task finished" }] },
      });
      this.sink?.({
        kind: "state_update",
        turnId: "t_wake",
        payload: { state: "idle", stopReason: "end_turn" },
      });
    })();
    return { accepted: true, effective: "new_turn" };
  }

  async cancel(_ref: HarnessSessionHandle): Promise<void> {}
  async close(_ref: HarnessSessionHandle): Promise<void> {}
}

describe("Controller accounting for a Harness-started Turn", () => {
  test("summarizes the Turn and keeps the Queue unaffected", async () => {
    const adapter = new WakingAdapter();
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: () => adapter,
    });

    await controller.submit("claude", [{ type: "text", text: "kick off background work" }]);
    await Bun.sleep(20); // 等 Harness-started Turn 收界。

    const summaries = session
      .ledger.read()
      .filter((ev) => ev.kind === "_baton_turn_summary")
      .map((ev) => (ev.payload as { turnId: string }).turnId);
    expect(summaries).toContain("t_wake");
    expect(summaries).toHaveLength(2); // Queue-driven + Harness-started，各恰好一次。

    // 没有对应 Queue run 的 Turn 不占队列：下一个 Queue-driven Turn 照常执行。
    await controller.submit("claude", [{ type: "text", text: "next" }]);
    expect(controller.harnessQueueLength).toBe(0);
  });
});

// ---- adapter：post-final 活动的开界判定与铸造 ----

describe("Claude Adapter Harness-started Turn minting", () => {
  test("startsHarnessTurn: only activity after finalize opens a new turn", () => {
    const live = { finalized: false };
    const done = { finalized: true };
    for (const type of ["stream_event", "assistant", "user"]) {
      expect(startsHarnessTurn(type, live)).toBe(false);
      expect(startsHarnessTurn(type, done)).toBe(true);
    }
    // system 是瞬时相位、result 是迟到终态：都不构成回合
    expect(startsHarnessTurn("system", done)).toBe(false);
    expect(startsHarnessTurn("result", done)).toBe(false);
  });

  test("mintHarnessTurn opens with running under a fresh turn id", async () => {
    const adapter = new ClaudeAdapter({ openInteraction: async (req) => ({ kind: "permission", outcome: "selected", optionId: "deny" }) });
    const events: Array<{ kind: string; turnId?: string; payload: Record<string, unknown> }> = [];
    const ref = await adapter.open({ cwd: "/tmp" }, (ev) => events.push(ev as never));
    const seams = adapter as unknown as {
      sessions: Map<string, unknown>;
      mintHarnessTurn(rt: unknown): { turnId: string; finalized: boolean };
    };
    const rt = seams.sessions.get(ref.handleId);

    const harnessTurn = seams.mintHarnessTurn(rt);
    expect(harnessTurn.finalized).toBe(false);
    expect(harnessTurn.turnId).toMatch(/^t_/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "state_update",
      turnId: harnessTurn.turnId,
      payload: { state: "running" },
    });
  });
});
