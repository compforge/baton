// Input 一等抽象（InputRecord）（见 docs/workflow.md“采集与准入”）：
// 每条输入身份即其 messageId（m_）+ 显式 status；queued/dispatching/admitted/accepted_steer 可查，
// recall→recalled、cancel→interrupted（S3：不静默丢、不自动重发）。
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
import { MAIN_LANE_ID, SessionStore, type SessionHandle } from "../src/store/store.ts";
import { resolveTestTarget } from "./harness-target.ts";

/** turn 停在进行中，直到 finish() 或 cancel()；cancel 模拟 harness 的 cancelled 终态 */
class HoldingAdapter implements HarnessAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  sink?: EventSink;
  prompts: string[] = [];
  received: PromptInput[] = [];
  steerGate?: Promise<void>;
  steerResult: SendTurnReceipt = { accepted: true, effective: "steer" };
  private active?: PromptInput;

  constructor(readonly harness: string) {}

  async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionHandle> {
    this.sink = sink;
    return { harness: this.harness, handleId: `${this.harness}-ref`, resumed: false };
  }

  async sendTurn(_ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt> {
    this.received.push(input);
    if (this.active) {
      if (this.active.turnId !== input.turnId) {
        return { accepted: false, effective: "rejected" };
      }
      await this.steerGate;
      if (this.steerResult.effective !== "steer") return this.steerResult;
      this.sink?.({
        kind: "user_message",
        turnId: input.turnId,
        payload: { messageId: input.messageId, content: input.blocks, delivery: "steer" },
      });
      return this.steerResult;
    }
    this.active = input;
    this.prompts.push(textOf(input.blocks));
    return { accepted: true, effective: "new_turn" };
  }

  finish(stopReason: string): void {
    const input = this.active;
    if (!input) return;
    this.active = undefined;
    this.sink?.({
      kind: "state_update",
      turnId: input.turnId,
      payload: { state: "idle", stopReason },
    });
  }

  async cancel(_ref: HarnessSessionHandle): Promise<void> {
    this.finish("cancelled");
  }
  async close(_ref: HarnessSessionHandle): Promise<void> {}
}

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-pending-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function controllerWith(adapter: HarnessAdapter): Controller {
  return new Controller({
    session,
    mentionBudgetChars: 4096,
    resolveTarget: resolveTestTarget,
    createAdapter: () => adapter,
  });
}
const text = (t: string): PromptBlock[] => [{ type: "text", text: t }];
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(1);
  expect(cond()).toBe(true);
}

describe("Input lifecycle (InputRecord)", () => {
  test("admitted input is identified by its messageId with admitted status", async () => {
    const adapter = new HoldingAdapter("codex");
    const controller = controllerWith(adapter);
    const turn = controller.submit("codex", text("build it"));
    await until(() => adapter.prompts.length === 1);

    const inputs = controller.inputs;
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.messageId).toMatch(/^m_/);
    expect(inputs[0]).toMatchObject({ status: "admitted", delivery: "prompt", harness: "codex" });

    adapter.finish("end_turn");
    await turn;
    expect(controller.inputs).toHaveLength(0); // finalized 输入不驻内存
  });

  test("a second input while busy is a queued entity; recall marks it recalled and drops it", async () => {
    const adapter = new HoldingAdapter("codex");
    const controller = controllerWith(adapter);
    const first = controller.submit("codex", text("first"));
    await until(() => adapter.prompts.length === 1);
    const second = controller.submit("codex", text("second"));
    await until(() => controller.queueLength === 1);

    const statuses = controller.inputs.map((i) => i.status).sort();
    expect(statuses).toEqual(["admitted", "queued"]);

    const recalled = controller.recallLatestQueued();
    expect(recalled?.blocks && textOf(recalled.blocks)).toBe("second");
    expect(controller.inputs.map((i) => i.status)).toEqual(["admitted"]); // queued 已移除
    expect(await second).toBe("recalled");

    adapter.finish("end_turn");
    expect(await first).toBe("completed");
  });

  test("accepted steer is a first-class entity attached to the active turn", async () => {
    const adapter = new HoldingAdapter("codex");
    const controller = controllerWith(adapter);
    const turn = controller.submit("codex", text("build it"));
    await until(() => adapter.prompts.length === 1);

    const outcome = await controller.sendTurn("codex", text("prefer B"));
    expect(outcome.effective).toBe("steer");

    const steer = controller.inputs.find((i) => i.delivery === "steer");
    expect(steer?.messageId).toMatch(/^m_/);
    expect(steer?.status).toBe("accepted_steer");

    adapter.finish("end_turn");
    await turn;
  });

  test("creates and claims the Input before waiting for steer admission", async () => {
    const adapter = new HoldingAdapter("codex");
    let releaseSteer!: () => void;
    adapter.steerGate = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });
    const controller = controllerWith(adapter);
    const turn = controller.submit("codex", text("build it"));
    await until(() => adapter.prompts.length === 1);

    let enqueuedMessageId: string | undefined;
    const sending = controller.sendTurn("codex", text("prefer B"), {
      onEnqueued: () => {
        enqueuedMessageId = controller.inputs.find(
          (input) => input.status === "queued",
        )?.messageId;
      },
    });
    expect(enqueuedMessageId).toMatch(/^m_/);
    await until(() => controller.inputs.some((input) => input.status === "dispatching"));
    const dispatching = controller.inputs.find((input) => input.status === "dispatching");
    expect(dispatching?.messageId).toBe(enqueuedMessageId);
    expect(dispatching?.messageId).toMatch(/^m_/);
    expect(controller.recallLatestQueued()).toBeUndefined();
    expect(adapter.received[1]?.messageId).toBe(dispatching?.messageId);

    releaseSteer();
    expect((await sending).effective).toBe("steer");
    adapter.finish("end_turn");
    await turn;
  });

  test("keeps the messageId when a rejected steer falls back to a queued turn", async () => {
    const adapter = new HoldingAdapter("codex");
    adapter.steerResult = { accepted: false, effective: "rejected" };
    const controller = controllerWith(adapter);
    const first = controller.submit("codex", text("one"));
    await until(() => adapter.prompts.length === 1);

    const outcome = await controller.sendTurn("codex", text("two"));
    expect(outcome.effective).toBe("new_turn");
    const queued = controller.inputs.find((input) => input.status === "queued");
    expect(queued?.messageId).toBe(adapter.received[1]?.messageId);

    adapter.finish("end_turn");
    await first;
    await until(() => adapter.prompts.length === 2);
    expect(adapter.received[2]?.messageId).toBe(queued?.messageId);
    adapter.finish("end_turn");
    if (outcome.effective === "new_turn") await outcome.outcome;
  });

  test("keeps later input queued while an earlier steer is awaiting admission", async () => {
    const adapter = new HoldingAdapter("codex");
    let releaseSteer!: () => void;
    adapter.steerGate = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });
    const controller = controllerWith(adapter);
    const first = controller.submit("codex", text("one"));
    await until(() => adapter.prompts.length === 1);

    const steering = controller.sendTurn("codex", text("two"));
    await until(() => controller.inputs.some((input) => input.status === "dispatching"));
    const later = await controller.sendTurn("codex", text("three"));
    expect(later).toMatchObject({ effective: "new_turn", queued: true });
    expect(controller.inputs.map((input) => input.status).sort()).toEqual([
      "admitted",
      "dispatching",
      "queued",
    ]);

    releaseSteer();
    expect((await steering).effective).toBe("steer");
    adapter.finish("end_turn");
    await first;
    await until(() => adapter.prompts.length === 2);
    expect(adapter.prompts).toEqual(["one", "three"]);
    adapter.finish("end_turn");
    if (later.effective === "new_turn") await later.outcome;
  });

  test("settles a steer accepted after Esc without attaching it to the retired turn", async () => {
    const adapter = new HoldingAdapter("codex");
    let releaseSteer!: () => void;
    adapter.steerGate = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });
    const controller = controllerWith(adapter);
    const turn = controller.submit("codex", text("one"));
    await until(() => adapter.prompts.length === 1);

    const steering = controller.sendTurn("codex", text("two"));
    await until(() => controller.inputs.some((input) => input.status === "dispatching"));
    await controller.control({ kind: "interrupt" });
    await turn;

    releaseSteer();
    expect((await steering).effective).toBe("steer");
    expect(controller.inputs).toEqual([]);
    const messages = [...session.loadState().messages.values()]
      .filter((message) => message.role === "user")
      .map((message) => textOf(message.content));
    expect(messages.filter((message) => message === "two")).toHaveLength(1);
  });

  test("Esc after an accepted steer interrupts the turn without silently dropping the steer", async () => {
    const adapter = new HoldingAdapter("codex");
    const controller = controllerWith(adapter);
    const turn = controller.submit("codex", text("build it"));
    await until(() => adapter.prompts.length === 1);
    await controller.sendTurn("codex", text("also do B"));
    expect(controller.inputs.some((i) => i.status === "accepted_steer")).toBe(true);

    await controller.control({ kind: "interrupt" });
    expect(await turn).toBe("completed");

    // 无悬挂输入实体，且 steer 文本仍在事件历史里（不静默丢；不自动重发 → 只有一条 steer prompt）
    expect(controller.inputs).toHaveLength(0);
    const state = session.loadState();
    const userTexts = [...state.messages.values()]
      .filter((m) => m.role === "user")
      .map((m) => textOf(m.content));
    expect(userTexts).toContain("also do B");
    expect(userTexts.filter((t) => t === "also do B")).toHaveLength(1);
  });

  test("keeps Plugin Inputs out of user recall and persists Plugin provenance", async () => {
    const mainAdapter = new HoldingAdapter("codex");
    const sideAdapter = new HoldingAdapter("codex");
    let adapterCount = 0;
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: () => adapterCount++ === 0 ? mainAdapter : sideAdapter,
    });
    const active = controller.submit("codex", text("first"));
    await until(() => mainAdapter.prompts.length === 1);
    const plugin = controller.enqueueHarnessInvocation({
      harnessInvocationId: "trq_1",
      pluginInstanceId: "reqloop_default",
      harnessTargetId: "codex",
      laneId: "hl_request",
      newLane: true,
      parentLaneId: MAIN_LANE_ID,
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      messageId: "m_plugin",
      turnId: "t_plugin",
      blocks: text("plugin work"),
    });
    await until(() => sideAdapter.prompts.length === 1);
    const user = controller.submit("codex", text("user follow-up"));
    await until(() => controller.queueLength === 1);

    expect(controller.recallLatestQueued()?.source).toEqual({ type: "user" });
    expect(await user).toBe("recalled");
    expect(controller.queuedTurns).toEqual([]);

    mainAdapter.finish("end_turn");
    await active;
    const pluginMessage = session.readEvents().find((event) =>
      event.kind === "user_message" && event.payload.messageId === "m_plugin"
    );
    expect(pluginMessage?.source).toEqual({
      type: "plugin",
      pluginInstanceId: "reqloop_default",
    });
    expect(pluginMessage?.laneId).toBe("hl_request");
    sideAdapter.finish("end_turn");
    expect(await plugin).toBe("completed");
  });
});
