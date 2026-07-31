// steer 的 controller 语义（design §4.3 / 验收矩阵 §7.6）：
// 正确 turn 成功注入且不新开 turn；不可 steer / harness 拒绝 / wire 故障一律显式
// 降级为 follow-up（effective 如实上报），输入永不静默丢失。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdapterCapabilities,
  HarnessAdapter,
  EventSink,
  OpenOptions,
  PromptInput,
  SendTurnReceipt,
  HarnessSessionHandle,
} from "../src/harness/adapter.ts";
import { textOf, type PromptBlock } from "../src/event/types.ts";
import { Controller } from "../src/controller/index.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";
import { resolveTestTarget } from "./harness-target.ts";

/** turn 不自动终结：由测试显式 finish()，制造稳定的"turn 进行中"窗口 */
class SendTurnFakeAdapter implements HarnessAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  sink?: EventSink;
  prompts: string[] = [];
  steers: Array<{ turnId: string; expectedTurnId: string; text: string }> = [];
  steerResult: SendTurnReceipt = { accepted: true, effective: "steer" };
  steerError?: Error;
  protected activeInput?: PromptInput;
  protected steerSupported = true;

  constructor(readonly harness: string) {}

  async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionHandle> {
    this.sink = sink;
    return { harness: this.harness, handleId: `${this.harness}-ref`, resumed: false };
  }

  async sendTurn(_ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt> {
    if (this.activeInput) {
      if (!this.steerSupported || this.activeInput.turnId !== input.turnId) {
        return { accepted: false, effective: "rejected" };
      }
      if (this.steerError) throw this.steerError;
      this.steers.push({
        turnId: input.turnId,
        expectedTurnId: this.activeInput.turnId,
        text: textOf(input.blocks),
      });
      if (this.steerResult.effective === "steer") {
        this.sink?.({
          kind: "user_message",
          turnId: input.turnId,
          payload: { messageId: input.messageId, content: input.blocks, delivery: "steer" },
        });
      }
      return this.steerResult;
    }
    this.activeInput = input;
    this.prompts.push(textOf(input.blocks));
    return { accepted: true, effective: "new_turn" };
  }

  /** 终结当前 turn（模拟 harness 的 idle 终态） */
  finish(): void {
    const input = this.activeInput;
    if (!input) return;
    this.activeInput = undefined;
    this.sink?.({
      kind: "agent_message",
      turnId: input.turnId,
      payload: { messageId: `${input.turnId}-agent`, content: [{ type: "text", text: "done" }] },
    });
    this.sink?.({
      kind: "state_update",
      turnId: input.turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
  }

  async cancel(_ref: HarnessSessionHandle): Promise<void> {}
  async close(_ref: HarnessSessionHandle): Promise<void> {}
}

/** 无 steer 能力的最小 adapter：验证 capability 缺失时的降级 */
class RejectingSendTurnFakeAdapter extends SendTurnFakeAdapter {
  constructor(harness: string) {
    super(harness);
    this.steerSupported = false;
  }
}

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-steer-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function controllerWith(adapter: HarnessAdapter): Controller {
  return new Controller({
    session,
    mentionBudgetChars: 4096,
    resolveTarget: resolveTestTarget,
    createAdapter: () => adapter,
  });
}

const text = (t: string): PromptBlock[] => [{ type: "text", text: t }];

/** submit 的 promise 只在 turn 完成后 resolve，中间状态按谓词轮询等待 */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(1);
  expect(cond()).toBe(true);
}

describe("Controller.sendTurn", () => {
  test("steers the active turn: no new turn, message lands in the steered turn", async () => {
    const adapter = new SendTurnFakeAdapter("codex");
    const controller = controllerWith(adapter);

    const turn = controller.submit("codex", text("build it"));
    await until(() => adapter.prompts.length === 1);
    const outcome = await controller.sendTurn("codex", text("prefer approach B"));

    expect(outcome.effective).toBe("steer");
    expect(controller.queueLength).toBe(0);
    expect(adapter.steers).toHaveLength(1);
    // expectedTurnId 与消息归属 turn 都是当前 active 的 baton turn id
    expect(adapter.steers[0]?.expectedTurnId).toBe(adapter.steers[0]?.turnId as string);

    adapter.finish();
    expect(await turn).toBe("completed");

    // steer 消息落盘在被注入的 turn 内，带 effective delivery 标记
    const state = session.loadState();
    const steerMsg = [...state.messages.values()].find((m) => m.delivery === "steer");
    expect(steerMsg).toBeDefined();
    expect(textOf(steerMsg?.content ?? [])).toBe("prefer approach B");
    expect(steerMsg?.turnId).toBe(adapter.steers[0]?.turnId as string);
    expect(state.turnSummaries).toHaveLength(1);
  });

  test("degrades to follow-up when the adapter rejects (stale turn race)", async () => {
    const adapter = new SendTurnFakeAdapter("codex");
    adapter.steerResult = { accepted: false, effective: "rejected" };
    const controller = controllerWith(adapter);

    const first = controller.submit("codex", text("one"));
    await until(() => adapter.prompts.length === 1);
    const outcome = await controller.sendTurn("codex", text("two"));

    expect(outcome.effective).toBe("new_turn");
    expect(controller.queueLength).toBe(1);
    adapter.finish(); // 结束 turn one → 降级的 follow-up 开始执行
    await first;
    await until(() => adapter.prompts.length === 2);
    adapter.finish();
    if (outcome.effective === "new_turn") expect(await outcome.outcome).toBe("completed");
    expect(adapter.prompts).toEqual(["one", "two"]);
  });

  test("degrades to follow-up when the adapter throws (wire failure)", async () => {
    const adapter = new SendTurnFakeAdapter("codex");
    adapter.steerError = new Error("peer closed");
    const controller = controllerWith(adapter);

    controller.submit("codex", text("one"));
    await until(() => adapter.prompts.length === 1);
    const outcome = await controller.sendTurn("codex", text("two"));

    expect(outcome.effective).toBe("new_turn");
    expect(controller.queueLength).toBe(1);
  });

  test("degrades when the adapter rejects same-turn send", async () => {
    const adapter = new RejectingSendTurnFakeAdapter("claude");
    const controller = controllerWith(adapter);

    controller.submit("claude", text("one"));
    await until(() => adapter.prompts.length === 1);
    const outcome = await controller.sendTurn("claude", text("two"));
    expect(outcome.effective).toBe("new_turn");
    expect(controller.queueLength).toBe(1);
  });

  test("degrades when idle (no active turn to steer)", async () => {
    const adapter = new SendTurnFakeAdapter("codex");
    const controller = controllerWith(adapter);

    const outcome = await controller.sendTurn("codex", text("hello"));
    expect(outcome.effective).toBe("new_turn");

    await until(() => adapter.prompts.length === 1);
    adapter.finish();
    if (outcome.effective === "new_turn") expect(await outcome.outcome).toBe("completed");
    expect(adapter.steers).toHaveLength(0);
    expect(adapter.prompts).toEqual(["hello"]);
  });

  test("degrades when steering a harness other than the active one", async () => {
    const codex = new SendTurnFakeAdapter("codex");
    const claude = new SendTurnFakeAdapter("claude-code");
    const adapters: Record<string, HarnessAdapter> = { codex, claude };
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: (target) => adapters[target.harness] as HarnessAdapter,
    });

    controller.submit("codex", text("one"));
    await until(() => codex.prompts.length === 1);
    const outcome = await controller.sendTurn("claude", text("two"));
    expect(outcome.effective).toBe("new_turn");
    expect(claude.steers).toHaveLength(0);
    expect(controller.queueLength).toBe(1);
  });
});
