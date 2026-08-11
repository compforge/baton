import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Controller } from "../src/controller/index.ts";
import { textOf, type PromptBlock } from "../src/event/types.ts";
import type {
  AdapterCapabilities,
  EventSink,
  HarnessAdapter,
  HarnessSessionBindingSink,
  HarnessSessionHandle,
  OpenOptions,
  PromptInput,
  SendTurnReceipt,
} from "../src/harness/adapter.ts";
import { sessionIdResumeState } from "../src/harness/resume.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";
import { resolveTestTarget } from "./harness-target.ts";

class LaneAdapter implements HarnessAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  readonly prompts: PromptInput[] = [];
  openOptions?: OpenOptions;
  cancelCalls = 0;
  private sink?: EventSink;

  constructor(readonly harness: string, readonly instance: number) {}

  async open(
    options: OpenOptions,
    sink: EventSink,
    binding?: HarnessSessionBindingSink,
  ): Promise<HarnessSessionHandle> {
    this.openOptions = options;
    const sessionId = `${this.harness}-lane-${this.instance}`;
    this.sink = sink;
    binding?.({ identity: { id: sessionId }, resumeState: sessionIdResumeState(sessionId) });
    return {
      harness: this.harness,
      handleId: sessionId,
      resumed: false,
    };
  }

  async sendTurn(
    _handle: HarnessSessionHandle,
    input: PromptInput,
  ): Promise<SendTurnReceipt> {
    this.prompts.push(input);
    return { accepted: true, effective: "new_turn" };
  }

  finish(stopReason: "end_turn" | "cancelled" = "end_turn"): void {
    const input = this.prompts.at(-1);
    if (!input) return;
    if (stopReason === "end_turn") {
      this.sink?.({
        kind: "agent_message",
        turnId: input.turnId,
        payload: {
          messageId: `${input.messageId}_answer`,
          content: [{ type: "text", text: `done by lane ${this.instance}` }],
        },
      });
    }
    this.sink?.({
      kind: "state_update",
      turnId: input.turnId,
      payload: { state: "idle", stopReason },
    });
  }

  async cancel(_handle: HarnessSessionHandle): Promise<void> {
    this.cancelCalls++;
    this.finish("cancelled");
  }

  async close(_handle: HarnessSessionHandle): Promise<void> {}
}

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-harness-lane-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const blocks = (text: string): PromptBlock[] => [{ type: "text", text }];

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i++) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

function laneController(
  adapters: LaneAdapter[],
  sideLaneConcurrency = 4,
): Controller {
  return new Controller({
    session,
    mentionBudgetChars: 4096,
    resolveTarget: resolveTestTarget,
    createAdapter: (target) => {
      const adapter = new LaneAdapter(target.harness, adapters.length + 1);
      adapters.push(adapter);
      return adapter;
    },
    sideLaneConcurrency,
  });
}

describe("Baton Lane scheduling", () => {
  test("HarnessInvocation placement and Input source remain independent", async () => {
    const adapters: LaneAdapter[] = [];
    const controller = laneController(adapters);
    const direct = controller.enqueueHarnessInvocation({
      harnessInvocationId: "trq_main_plugin",
      pluginInstanceId: "reqloop_default",
      harnessTargetId: "codex",
      laneId: session.meta.mainLaneId,
      lane: "main",
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      messageId: "m_main_plugin",
      turnId: "t_main_plugin",
      blocks: blocks("direct input"),
    });
    await until(() => adapters[0]?.prompts.length === 1);
    expect(controller.sideRunCount).toBe(0);
    expect(controller.inputs[0]).toMatchObject({
      laneId: session.meta.mainLaneId,
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      harnessInvocationId: "trq_main_plugin",
    });
    adapters[0]!.finish();
    expect(await direct).toBe("completed");

    const edited = controller.enqueueHarnessInvocation({
      harnessInvocationId: "trq_main_user",
      pluginInstanceId: "reqloop_default",
      harnessTargetId: "codex",
      laneId: session.meta.mainLaneId,
      lane: "main",
      source: { type: "user" },
      messageId: "m_main_user",
      turnId: "t_main_user",
      blocks: blocks("edited input"),
    });
    await until(() => adapters[0]!.prompts.length === 2);
    const editedEvent = session.readEvents().find((event) =>
      event.kind === "user_message" && event.payload.messageId === "m_main_user"
    );
    expect(editedEvent).toMatchObject({
      source: { type: "user" },
      laneId: session.meta.mainLaneId,
    });
    adapters[0]!.finish();
    expect(await edited).toBe("completed");
  });

  test("same-Target side Lanes run beside the main Lane in separate native sessions", async () => {
    const adapters: LaneAdapter[] = [];
    const controller = laneController(adapters);
    const workerOne = controller.enqueueHarnessInvocation({
      harnessInvocationId: "trq_1",
      pluginInstanceId: "reqloop_default",
      harnessTargetId: "codex",
      laneId: "hl_worker_1",
      lane: "new",
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      messageId: "m_worker_1",
      turnId: "t_worker_1",
      blocks: blocks("worker one"),
    });
    const workerTwo = controller.enqueueHarnessInvocation({
      harnessInvocationId: "trq_2",
      pluginInstanceId: "reqloop_default",
      harnessTargetId: "codex",
      laneId: "hl_worker_2",
      lane: "new",
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      messageId: "m_worker_2",
      turnId: "t_worker_2",
      blocks: blocks("worker two"),
    });
    await until(() => adapters.length === 2 && adapters.every((adapter) => adapter.prompts.length === 1));

    const main = controller.submit("codex", blocks("user work"));
    await until(() => adapters.length === 3 && adapters[2]!.prompts.length === 1);

    expect(controller.sideRunCount).toBe(2);
    expect(adapters.map((adapter) => adapter.openOptions?.cwd)).toEqual([
      "/repo",
      "/repo",
      "/repo",
    ]);
    const mainLaneId = session.meta.mainLaneId;
    expect(mainLaneId).not.toBe("hl_worker_1");
    expect(mainLaneId).not.toBe("hl_worker_2");
    expect(new Set(Object.values(session.meta.lanes).flatMap(
      (lane) => Object.values(lane.harnessSessions).map((binding) => binding.harnessSessionId),
    )).size).toBe(3);

    const inputFacts = session.readEvents().filter((event) => event.kind === "user_message");
    expect(inputFacts.map((event) => [event.payload.messageId, event.laneId])).toEqual([
      ["m_worker_1", "hl_worker_1"],
      ["m_worker_2", "hl_worker_2"],
      [expect.stringMatching(/^m_/), mainLaneId],
    ]);

    adapters[2]!.finish();
    expect(await main).toBe("completed");
    expect(controller.sideRunCount).toBe(2);
    adapters[0]!.finish();
    adapters[1]!.finish();
    expect(await Promise.all([workerOne, workerTwo])).toEqual(["completed", "completed"]);
  });

  test("one Lane can hand off serially across HarnessTargets", async () => {
    const adapters: LaneAdapter[] = [];
    const controller = laneController(adapters);
    const first = controller.submit("codex", blocks("first target"));
    await until(() => adapters[0]?.prompts.length === 1);
    adapters[0]!.finish();
    expect(await first).toBe("completed");

    const second = controller.submit("claude", blocks("second target"));
    await until(() => adapters[1]?.prompts.length === 1);
    expect(textOf(adapters[1]!.prompts[0]!.blocks)).toContain("done by lane 1");
    adapters[1]!.finish();
    expect(await second).toBe("completed");

    const mainLane = session.meta.lanes[session.meta.mainLaneId]!;
    expect(Object.keys(mainLane.harnessSessions).sort()).toEqual(["claude", "codex"]);
    expect(new Set(session.readEvents().flatMap((event) => event.laneId ? [event.laneId] : [])))
      .toEqual(new Set([session.meta.mainLaneId]));
  });

  test("main interrupt and HarnessInvocation cancellation target only their own Lane", async () => {
    const adapters: LaneAdapter[] = [];
    const controller = laneController(adapters);
    const worker = controller.enqueueHarnessInvocation({
      harnessInvocationId: "trq_cancel",
      pluginInstanceId: "reqloop_default",
      harnessTargetId: "codex",
      laneId: "hl_worker_cancel",
      lane: "new",
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      messageId: "m_worker_cancel",
      turnId: "t_worker_cancel",
      blocks: blocks("background"),
    });
    await until(() => adapters[0]?.prompts.length === 1);
    const main = controller.submit("codex", blocks("main"));
    await until(() => adapters[1]?.prompts.length === 1);

    await controller.control({ kind: "interrupt" });
    expect(await main).toBe("completed");
    expect(adapters[1]!.cancelCalls).toBe(1);
    expect(adapters[0]!.cancelCalls).toBe(0);
    expect(controller.sideRunCount).toBe(1);

    expect(controller.cancelHarnessInvocation("trq_cancel")).toBe("running");
    await until(() => adapters[0]!.cancelCalls === 1);
    expect(await worker).toBe("completed");
  });

  test("side Lane concurrency does not block the main Lane", async () => {
    const adapters: LaneAdapter[] = [];
    const controller = laneController(adapters, 1);
    const first = controller.enqueueHarnessInvocation({
      harnessInvocationId: "trq_first",
      pluginInstanceId: "reqloop_default",
      harnessTargetId: "codex",
      laneId: "hl_first",
      lane: "new",
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      messageId: "m_first",
      turnId: "t_first",
      blocks: blocks("first"),
    });
    const second = controller.enqueueHarnessInvocation({
      harnessInvocationId: "trq_second",
      pluginInstanceId: "reqloop_default",
      harnessTargetId: "codex",
      laneId: "hl_second",
      lane: "new",
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      messageId: "m_second",
      turnId: "t_second",
      blocks: blocks("second"),
    });
    await until(() => adapters[0]?.prompts.length === 1);
    expect(adapters).toHaveLength(1);
    expect(controller.queueLength).toBe(1);

    const main = controller.submit("codex", blocks("main"));
    await until(() => adapters[1]?.prompts.length === 1);
    expect(textOf(adapters[1]!.prompts[0]!.blocks)).toContain("main");

    adapters[0]!.finish();
    expect(await first).toBe("completed");
    await until(() => adapters[2]?.prompts.length === 1);
    adapters[1]!.finish();
    adapters[2]!.finish();
    expect(await main).toBe("completed");
    expect(await second).toBe("completed");
  });
});
