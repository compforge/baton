// 队列管理：Queue/Controller 的按 id 召回 typed path（/queue 浮层的领域语义），
// 以及 BatonChatProtocol 的两级 picker 浮层编排。召回/删除共用 recallLatestQueued
// 的 recalled 终态语义（见 docs/workflow.md "recall→recalled"）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import { Controller } from "../src/controller/index.ts";
import { textOf, type PromptBlock } from "../src/event/index.ts";
import type {
  AdapterCapabilities,
  HarnessAdapter,
  HarnessEventSink,
  HarnessSessionHandle,
  OpenOptions,
  PromptInput,
  SendTurnReceipt,
} from "../src/harness/adapter.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";
import type { QueueSnapshot } from "../src/queue.ts";
import { BatonChatProtocol } from "../src/view/chat-tui/protocol/index.ts";
import { resolveTestTarget } from "./harness-target.ts";

/** turn 停在进行中，直到 finish()；submit 的后续输入停留在 Queue。 */
class HoldingAdapter implements HarnessAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  readonly steering: HarnessAdapter["steering"] = {
    deliveryTracking: "ack-only",
    cancelOwnership: "survives",
  };
  sink?: HarnessEventSink;
  prompts: string[] = [];
  protected active?: PromptInput;
  acceptSteer = false;

  constructor(readonly harness: string) {}

  async open(_opts: OpenOptions, sink: HarnessEventSink): Promise<HarnessSessionHandle> {
    this.sink = sink;
    return { harness: this.harness, handleId: `${this.harness}-ref`, resumed: false };
  }

  async sendTurn(_ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt> {
    if (this.active) {
      if (this.acceptSteer) {
        this.prompts.push(textOf(input.blocks));
        return { accepted: true, effective: "steer" };
      }
      return { accepted: false, effective: "rejected" };
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
  async close(_ref: HarnessSessionHandle): Promise<void> {
    this.finish("cancelled");
  }
}

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-queue-recall-"));
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

describe("queue recall by id", () => {
  test("recalls a specific queued input, not just the latest", async () => {
    const adapter = new HoldingAdapter("codex");
    const controller = controllerWith(adapter);
    const first = controller.submit("codex", text("active"));
    await until(() => adapter.prompts.length === 1);
    const second = controller.submit("codex", text("second"));
    const third = controller.submit("codex", text("third"));
    await until(() => controller.harnessQueueLength === 2);

    const [queuedSecond, queuedThird] = controller.listQueued();
    expect(queuedSecond?.blocks && textOf(queuedSecond.blocks)).toBe("second");
    expect(queuedThird?.blocks && textOf(queuedThird.blocks)).toBe("third");

    // 召回中间那条（非最新）：与 recallLatestQueued 同样的 recalled 终态。
    const recalled = controller.recallQueuedById(queuedSecond!.messageId);
    expect(recalled?.messageId).toBe(queuedSecond!.messageId);
    expect(recalled?.blocks && textOf(recalled.blocks)).toBe("second");
    expect(await second).toBe("recalled");

    // 剩下的队列顺序不变，最新一条召回仍可用。
    expect(controller.listQueued().map((input) => textOf(input.blocks))).toEqual(["third"]);
    expect(controller.harnessInputs.map((input) => input.status).sort()).toEqual([
      "admitted",
      "queued",
    ]);
    const latest = controller.recallLatestQueued();
    expect(latest?.blocks && textOf(latest.blocks)).toBe("third");
    expect(await third).toBe("recalled");

    adapter.finish("end_turn");
    expect(await first).toBe("completed");
  });

  test("rejects unknown, already-recalled, and non-queued ids", async () => {
    const adapter = new HoldingAdapter("codex");
    const controller = controllerWith(adapter);
    const first = controller.submit("codex", text("active"));
    await until(() => adapter.prompts.length === 1);
    const second = controller.submit("codex", text("second"));
    await until(() => controller.harnessQueueLength === 1);

    const queued = controller.listQueued()[0]!;
    const activeInput = controller.harnessInputs.find((input) => input.status === "admitted")!;

    expect(controller.recallQueuedById("m_missing")).toBeUndefined();
    // active turn 的输入已被 drain 取走，不在召回域内。
    expect(controller.recallQueuedById(activeInput.messageId)).toBeUndefined();
    expect(controller.harnessQueueLength).toBe(1);

    expect(controller.recallQueuedById(queued.messageId)?.messageId).toBe(queued.messageId);
    // 同一条不能召回两次。
    expect(controller.recallQueuedById(queued.messageId)).toBeUndefined();
    expect(await second).toBe("recalled");

    adapter.finish("end_turn");
    expect(await first).toBe("completed");
  });

  test("does not recall plugin-requested queued inputs", async () => {
    // Queue 级单测：predicate 与 recallLatestUser 一致，Plugin/Invocation 排队项
    // 走 cancelHarnessInvocation，不走用户召回。
    const { Queue } = await import("../src/queue.ts");
    let seq = 0;
    const queue = new Queue("main", () => ++seq);
    const target = resolveTestTarget("codex")!;
    queue.enqueue(target, text("user follow-up"));
    queue.enqueue(target, text("plugin request"), {
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      harnessInvocationId: "hinv_1",
    });

    expect(queue.snapshots.map((input) => input.messageId)).toHaveLength(2);
    const pluginItem = queue.snapshots[1]!;
    expect(queue.recallUserById(pluginItem.messageId)).toBeUndefined();
    expect(queue.length).toBe(2);

    const userItem = queue.snapshots[0]!;
    expect(queue.recallUserById(userItem.messageId)?.messageId).toBe(userItem.messageId);
    expect(queue.length).toBe(1);
  });

  test("reorders adjacent user inputs and restores the durable order", async () => {
    const adapter = new HoldingAdapter("codex");
    const controller = controllerWith(adapter);
    const first = controller.submit("codex", text("active"));
    await until(() => adapter.prompts.length === 1);
    void controller.submit("codex", text("second"));
    void controller.submit("codex", text("third"));
    await until(() => controller.listQueued().length === 2);

    const thirdId = controller.listQueued()[1]!.messageId;
    expect(controller.moveQueuedById(thirdId, "up")?.map((item) => textOf(item.blocks))).toEqual([
      "third",
      "second",
    ]);
    const reorder = session.ledger.read().findLast(
      (event) => event.kind === "_baton_queue_reordered",
    );
    expect(reorder?.kind).toBe("_baton_queue_reordered");
    if (reorder?.kind === "_baton_queue_reordered") {
      expect(reorder.payload.orderedMessageIds[0]).toBe(thirdId);
    }

    await controller.close();
    expect(await first).toBe("completed");
    const restored = controllerWith(new HoldingAdapter("codex"));
    expect(restored.listQueued().map((item) => textOf(item.blocks))).toEqual([
      "third",
      "second",
    ]);
    await restored.close();
  });

  test("dispatch-now promotes a selected item and reuses same-turn steer admission", async () => {
    const adapter = new HoldingAdapter("codex");
    const controller = controllerWith(adapter);
    const first = controller.submit("codex", text("active"));
    await until(() => adapter.prompts.length === 1);
    const second = controller.submit("codex", text("second"));
    const third = controller.submit("codex", text("third"));
    await until(() => controller.listQueued().length === 2);

    adapter.acceptSteer = true;
    const thirdId = controller.listQueued()[1]!.messageId;
    expect(await controller.dispatchQueuedNow(thirdId)).toEqual({ effective: "steer" });
    expect(controller.listQueued().map((item) => textOf(item.blocks))).toEqual(["second"]);
    expect(controller.harnessInputs.find((input) => input.messageId === thirdId)?.status).toBe(
      "steering",
    );

    adapter.finish("end_turn");
    expect(await first).toBe("completed");
    expect(await third).toBe("completed");
    await until(() => adapter.prompts.at(-1) === "second");
    adapter.finish("end_turn");
    expect(await second).toBe("completed");
  });

  test("does not move user input across Plugin-owned queued work", async () => {
    const { Queue } = await import("../src/queue.ts");
    let seq = 0;
    const queue = new Queue("main", () => ++seq, () => undefined);
    const target = resolveTestTarget("codex")!;
    queue.enqueue(target, text("plugin"), {
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      harnessInvocationId: "hinv_1",
    });
    const user = queue.enqueue(target, text("user")).input;

    expect(queue.moveUserById(user.messageId, "up")).toBeUndefined();
    expect(queue.promoteUserById(user.messageId)).toBeUndefined();
    expect(queue.snapshots.map((item) => textOf(item.blocks))).toEqual(["plugin", "user"]);
  });
});

describe("/queue manager overlay", () => {
  function protocolWithQueue(
    store: SessionStore,
    opened: SessionHandle,
    queued: Array<{ messageId: string; text: string; plugin?: string }>,
  ): {
    protocol: BatonChatProtocol;
    recalled: string[];
  } {
    const protocol = new BatonChatProtocol(
      store,
      DEFAULT_CONFIG,
      { session: opened, resumed: false },
      () => undefined,
    );
    const recalled: string[] = [];
    const internals = protocol as unknown as {
      controller: {
        listQueued(): QueueSnapshot[];
        recallQueuedById(messageId: string): QueueSnapshot | undefined;
        discardQueuedById(messageId: string): QueueSnapshot | undefined;
        moveQueuedById(messageId: string, direction: "up" | "down"): QueueSnapshot[] | undefined;
        dispatchQueuedNow(messageId: string): Promise<{ effective: "steer" } | undefined>;
      };
    };
    let snapshots: QueueSnapshot[] = queued.map((item, index) => ({
      messageId: item.messageId,
      enqueueSeq: index + 1,
      turnId: `t_${item.messageId}`,
      harnessTargetId: "codex",
      laneId: "main",
      harness: "codex",
      blocks: text(item.text),
      source: item.plugin
        ? { type: "plugin", pluginInstanceId: item.plugin }
        : { type: "user" },
      ...(item.plugin ? { harnessInvocationId: "hinv_1" } : {}),
    }));
    internals.controller.listQueued = () => snapshots;
    internals.controller.recallQueuedById = (messageId: string) => {
      const index = snapshots.findIndex((item) => item.messageId === messageId);
      const snapshot = snapshots[index];
      if (!snapshot || snapshot.source.type !== "user" || snapshot.harnessInvocationId) {
        return undefined;
      }
      recalled.push(messageId);
      snapshots.splice(index, 1);
      return snapshot;
    };
    internals.controller.discardQueuedById = internals.controller.recallQueuedById;
    internals.controller.moveQueuedById = (messageId, direction) => {
      const index = snapshots.findIndex((item) => item.messageId === messageId);
      const target = direction === "up" ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= snapshots.length) return undefined;
      [snapshots[index], snapshots[target]] = [snapshots[target]!, snapshots[index]!];
      return snapshots;
    };
    internals.controller.dispatchQueuedNow = async (messageId) => {
      const index = snapshots.findIndex((item) => item.messageId === messageId);
      if (index < 0) return undefined;
      snapshots.splice(index, 1);
      return { effective: "steer" };
    };
    return { protocol, recalled };
  }

  test("lists queued items and recalls the chosen one into the composer", async () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "baton-queue-overlay-")));
    const opened = store.createSession({ cwd: "/repo" });
    try {
      const { protocol, recalled } = protocolWithQueue(store, opened, [
        { messageId: "m_a", text: "first follow-up" },
        { messageId: "m_b", text: "second follow-up", plugin: "reqloop_default" },
      ]);
      await protocol.command("queue", "");
      const queue = protocol.stateStore.getState("queue")!;
      expect(queue.manager?.title).toBe("Queued follow-ups");
      expect(queue.items).toEqual([
        {
          id: "m_a",
          text: "first follow-up",
          tag: "codex · next turn",
          actions: ["recall", "discard", "dispatch-now"],
        },
        {
          id: "m_b",
          text: "second follow-up",
          tag: "reqloop_default · request",
          actions: [],
        },
      ]);

      const result = await protocol.resolveQueue({ kind: "recall", itemId: "m_a" });
      expect(recalled).toEqual(["m_a"]);
      expect(result).toEqual({ kind: "recalled", text: "first follow-up" });
      expect(protocol.stateStore.getState("footer").toast).toMatchObject({
        tone: "info",
      });
      expect(protocol.stateStore.getState("queue")?.manager).toBeNull();

      await protocol.exit();
    } finally {
      rmSync(store.rootDir, { recursive: true, force: true });
    }
  });

  test("deletes the chosen item without touching the composer", async () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "baton-queue-overlay-")));
    const opened = store.createSession({ cwd: "/repo" });
    try {
      const { protocol, recalled } = protocolWithQueue(store, opened, [
        { messageId: "m_a", text: "first follow-up" },
      ]);
      await protocol.command("queue", "");
      await protocol.resolveQueue({ kind: "discard", itemId: "m_a" });

      expect(recalled).toEqual(["m_a"]);
      expect(protocol.stateStore.getState("footer").toast?.text).toContain("Deleted queued message");

      await protocol.exit();
    } finally {
      rmSync(store.rootDir, { recursive: true, force: true });
    }
  });

  test("reports an empty queue and rejects non-recallable items", async () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "baton-queue-overlay-")));
    const opened = store.createSession({ cwd: "/repo" });
    try {
      const empty = protocolWithQueue(store, opened, []);
      await empty.protocol.command("queue", "");
      expect(empty.protocol.stateStore.getState("queue")?.manager).toBeNull();
      expect(empty.protocol.stateStore.getState("footer").toast?.text).toBe("Queue is empty");
      await empty.protocol.exit();

      const { protocol } = protocolWithQueue(store, opened, [
        { messageId: "m_b", text: "plugin request", plugin: "reqloop_default" },
      ]);
      await protocol.command("queue", "");
      const result = await protocol.resolveQueue({ kind: "recall", itemId: "m_b" });
      expect(result.kind).toBe("rejected");
      await protocol.exit();
    } finally {
      rmSync(store.rootDir, { recursive: true, force: true });
    }
  });
});
