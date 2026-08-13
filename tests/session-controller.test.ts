import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdapterCapabilities,
  HarnessAdapter,
  EffortOption,
  EventSink,
  HarnessSessionBindingSink,
  ModelOption,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  SendTurnReceipt,
  HarnessSessionHandle,
} from "../src/harness/adapter.ts";
import { sessionIdResumeState } from "../src/harness/resume.ts";
import type { AnyEventDraft, AnyEventEnvelope, PromptBlock } from "../src/event/index.ts";
import { textOf } from "../src/event/index.ts";
import { Controller, type HarnessAdapterPorts } from "../src/controller/index.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";
import { resolveTestTarget } from "./harness-target.ts";

class FakeAdapter implements HarnessAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  openOptions?: OpenOptions;
  sink?: EventSink;
  model: string | null = null;
  effort: string | null = null;
  synced: string[] = [];
  prompts: string[] = [];

  constructor(
    readonly harness: string,
    private readonly hooks: { enter?: () => void; leave?: () => void; delayMs?: number } = {},
  ) {}

  async open(
    opts: OpenOptions,
    sink: EventSink,
    binding?: HarnessSessionBindingSink,
  ): Promise<HarnessSessionHandle> {
    this.openOptions = opts;
    this.sink = sink;
    const sessionId = `${this.harness}-native`;
    binding?.({ identity: { id: sessionId }, resumeState: sessionIdResumeState(sessionId) });
    return {
      harness: this.harness,
      handleId: `${this.harness}-controller-ref`,
      resumed: Boolean(opts.resumeSessionId),
    };
  }

  async syncContext(_ref: HarnessSessionHandle, blocks: PromptBlock[]): Promise<void> {
    this.synced.push(textOf(blocks));
  }

  async listModels(_ref: HarnessSessionHandle): Promise<ModelOption[]> {
    return [{ id: "default", label: "Default" }, { id: "fast", label: "Fast" }];
  }

  async setModel(_ref: HarnessSessionHandle, modelId: string | null): Promise<void> {
    this.model = modelId === "default" ? null : modelId;
  }

  currentModel(_ref: HarnessSessionHandle): string | null {
    return this.model;
  }

  async listEfforts(_ref: HarnessSessionHandle): Promise<EffortOption[]> {
    return [{ id: "default", label: "Default" }, { id: "high", label: "High" }];
  }

  async setEffort(_ref: HarnessSessionHandle, effortId: string | null): Promise<void> {
    this.effort = effortId === "default" ? null : effortId;
  }

  currentEffort(_ref: HarnessSessionHandle): string | null {
    return this.effort;
  }

  /** sendTurn 立即回执；事件（含终态）异步经 open 绑定的 sink 上报。user_message 由 controller 落盘 */
  async sendTurn(_ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt> {
    this.hooks.enter?.();
    this.prompts.push(textOf(input.blocks));
    void (async () => {
      if (this.hooks.delayMs) await Bun.sleep(this.hooks.delayMs);
      this.sink?.({
        kind: "agent_message",
        turnId: input.turnId,
        payload: { messageId: `${input.turnId}-agent`, content: [{ type: "text", text: "done" }] },
      });
      this.hooks.leave?.();
      this.sink?.({
        kind: "state_update",
        turnId: input.turnId,
        payload: { state: "idle", stopReason: "end_turn" },
      });
    })();
    return { accepted: true, effective: "new_turn" };
  }

  async cancel(_ref: HarnessSessionHandle): Promise<void> {}
  async close(_ref: HarnessSessionHandle): Promise<void> {}
}

class TargetedFakeAdapter extends FakeAdapter {
  constructor(readonly instanceId: string) {
    super("codex");
  }

  override async open(
    opts: OpenOptions,
    sink: EventSink,
    binding?: HarnessSessionBindingSink,
  ): Promise<HarnessSessionHandle> {
    this.openOptions = opts;
    this.sink = sink;
    const sessionId = `${this.instanceId}-native`;
    binding?.({ identity: { id: sessionId }, resumeState: sessionIdResumeState(sessionId) });
    return {
      harness: this.harness,
      handleId: `${this.instanceId}-controller-ref`,
      resumed: Boolean(opts.resumeSessionId),
    };
  }

}

class DelayedNativeIdAdapter extends FakeAdapter {
  nativeId?: string;
  turnId?: string;
  beforeNativeId?: () => void;
  binding?: HarnessSessionBindingSink;

  constructor() {
    super("claude-code");
  }

  override async open(
    opts: OpenOptions,
    sink: EventSink,
    binding?: HarnessSessionBindingSink,
  ): Promise<HarnessSessionHandle> {
    this.openOptions = opts;
    this.sink = sink;
    this.binding = binding;
    return {
      harness: this.harness,
      handleId: "hs_runtime_only",
      resumed: false,
    };
  }

  override async sendTurn(
    _ref: HarnessSessionHandle,
    input: PromptInput,
  ): Promise<SendTurnReceipt> {
    this.prompts.push(textOf(input.blocks));
    this.turnId = input.turnId;
    this.beforeNativeId?.();
    this.nativeId = "4bc983eb-f25c-4857-9ac2-28ac6442e74c";
    this.binding?.({
      identity: { id: this.nativeId },
      resumeState: sessionIdResumeState(this.nativeId),
    });
    this.sink?.({
      kind: "agent_message",
      turnId: input.turnId,
      harnessSessionId: this.nativeId,
      payload: {
        messageId: `${input.turnId}-agent`,
        content: [{ type: "text", text: "working" }],
      },
    });
    return { accepted: true, effective: "new_turn" };
  }

  finish(): void {
    if (!this.turnId) throw new Error("turn not started");
    this.sink?.({
      kind: "state_update",
      turnId: this.turnId,
      harnessSessionId: this.nativeId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
  }
}

class CompactAdapter extends FakeAdapter {
  override readonly capabilities: AdapterCapabilities = { prompt: {}, compact: { supported: true } };
  compactCalls: string[] = [];

  async compactContext(_ref: HarnessSessionHandle, turnId: string): Promise<PromptReceipt> {
    this.compactCalls.push(turnId);
    this.sink?.({
      kind: "_baton_run_status",
      turnId,
      payload: { phase: "compacting", title: "Compacting context…" },
    });
    this.sink?.({
      kind: "state_update",
      turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
    return { accepted: true };
  }
}

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-controller-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function completedTurn(handle: SessionHandle, harness: string, turnId: string, text: string): void {
  handle.ledger.append({
    source: { type: "baton" },
    kind: "user_message",
    harness,
    turnId,
    payload: { messageId: `${turnId}-user`, content: [{ type: "text", text }] },
  });
  handle.ledger.append({
    source: { type: "baton" },
    kind: "agent_message",
    harness,
    turnId,
    payload: { messageId: `${turnId}-agent`, content: [{ type: "text", text: `${text}-done` }] },
  });
  handle.ledger.append({
    source: { type: "baton" },
    kind: "state_update",
    harness,
    turnId,
    payload: { state: "idle", stopReason: "end_turn" },
  });
  handle.summarizeTurn(turnId);
}

describe("Controller", () => {
  test("uses HarnessTarget probe for discovery without opening an Adapter session", async () => {
    let adaptersCreated = 0;
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: () => {
        adaptersCreated++;
        return new FakeAdapter("example-harness");
      },
      probeTarget: async () => ({
        models: [{ id: "target-model", label: "Target model" }],
      }),
    });

    expect(await controller.listModels("example")).toEqual([
      { id: "target-model", label: "Target model" },
    ]);
    expect(adaptersCreated).toBe(0);
  });

  test("links an accepted implementation turn back to its proposed plan", async () => {
    session.ledger.append({
      source: { type: "harness", harnessTargetId: "example" },
      harness: "example-harness",
      harnessTargetId: "example",
      turnId: "t-plan",
      kind: "proposed_plan",
      payload: { planId: "plan-1", content: "Implement safely" },
    });
    const adapter = new FakeAdapter("example-harness");
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: () => adapter,
    });

    await controller.submit(
      "example",
      [{ type: "text", text: "Implement the plan" }],
      { sourceProposedPlanId: "plan-1" },
    );

    const link = session
      .ledger.read()
      .find((event) => event.kind === "proposed_plan_implementation_started");
    expect(link).toMatchObject({
      source: { type: "baton" },
      harnessTargetId: "example",
      payload: { planId: "plan-1" },
    });
    expect(session.loadState().proposedPlans.get("plan-1")?.implementationTurnId).toBe(
      link?.turnId,
    );
  });

  test("admits at most one pending implementation turn per proposed plan", async () => {
    session.ledger.append({
      source: { type: "harness", harnessTargetId: "example" },
      harness: "example-harness",
      harnessTargetId: "example",
      turnId: "t-plan",
      kind: "proposed_plan",
      payload: { planId: "plan-1", content: "Implement once" },
    });
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: () => new FakeAdapter("example-harness", { delayMs: 20 }),
    });

    const first = controller.submit(
      "example",
      [{ type: "text", text: "Implement" }],
      { sourceProposedPlanId: "plan-1" },
    );
    expect(() =>
      controller.submit(
        "example",
        [{ type: "text", text: "Implement again" }],
        { sourceProposedPlanId: "plan-1" },
      ),
    ).toThrow(/pending implementation turn/);
    await first;
  });

  test("overrides adapter-supplied event attribution at the trusted host boundary", async () => {
    class SpoofingAdapter extends FakeAdapter {
      override async sendTurn(_ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt> {
        this.sink?.({
          kind: "agent_message",
          turnId: input.turnId,
          payload: { messageId: "forged", content: [{ type: "text", text: "done" }] },
          source: { type: "plugin", pluginInstanceId: "forged-plugin" },
          harness: "forged-harness",
          harnessTargetId: "forged-target",
        } as unknown as AnyEventDraft);
        this.sink?.({
          kind: "state_update",
          turnId: input.turnId,
          payload: { state: "idle", stopReason: "end_turn" },
        });
        return { accepted: true, effective: "new_turn" };
      }
    }

    const adapter = new SpoofingAdapter("example-harness");
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: () => adapter,
    });

    await controller.submit("example", [{ type: "text", text: "hello" }]);

    const event = session.ledger.read().find(
      (candidate) => candidate.kind === "agent_message" && candidate.payload.messageId === "forged",
    );
    expect(event).toMatchObject({
      source: { type: "harness", harnessTargetId: "example" },
      harness: "example-harness",
      harnessTargetId: "example",
    });
  });

  test("does not publish a second controller change for persisted streaming events", async () => {
    class ManualAdapter extends FakeAdapter {
      turnId?: string;

      override async sendTurn(_ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt> {
        this.turnId = input.turnId;
        return { accepted: true, effective: "new_turn" };
      }
    }

    const adapter = new ManualAdapter("codex");
    let controllerChanges = 0;
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: () => adapter,
      onChange: () => controllerChanges++,
    });

    const turn = controller.submit("codex", [{ type: "text", text: "hello" }]);
    while (!adapter.sink || !adapter.turnId) await Bun.sleep(0);

    const beforeChunk = controllerChanges;
    adapter.sink({
      kind: "agent_message_chunk",
      turnId: adapter.turnId,
      payload: { messageId: "m_stream", content: { type: "text", text: "a" } },
    });
    expect(controllerChanges).toBe(beforeChunk);

    adapter.sink({
      kind: "state_update",
      turnId: adapter.turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
    await turn;
  });

  test("accepts an explicitly resolved Target outside the bundled registry", async () => {
    const adapter = new FakeAdapter("example-harness");
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: (target) => {
        expect(target).toEqual({ id: "example", harness: "example" });
        return adapter;
      },
    });

    await controller.submit("example", [{ type: "text", text: "hello" }]);

    expect(adapter.prompts).toEqual(["hello"]);
    expect(session.meta.harnessSessions.example).toMatchObject({
      harnessTargetId: "example",
      harness: "example-harness",
      harnessSessionId: "example-harness-native",
    });
  });

  test("isolates two targets backed by the same Harness and preserves launch provenance", async () => {
    const adapters: TargetedFakeAdapter[] = [];
    const createdTargets: Array<{ id: string; harness: string }> = [];
    const targets = new Map([
      ["codex-a", { id: "codex-a", harness: "codex" }],
      ["codex-b", { id: "codex-b", harness: "codex" }],
    ]);
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      modelPreferences: { "codex-a": "fast" },
      resolveTarget: (harnessTargetId) => targets.get(harnessTargetId),
      createAdapter: (target) => {
        createdTargets.push(target);
        const adapter = new TargetedFakeAdapter(`instance-${adapters.length + 1}`);
        adapters.push(adapter);
        return adapter;
      },
    });
    session.setHarnessSession("codex-b", {
      harnessTargetId: "codex-b",
      harness: "codex",
      harnessSessionId: "instance-2-old",
      syncedSeq: 0,
    });

    await controller.submit("codex-a", [{ type: "text", text: "first target" }]);
    await controller.submit("codex-b", [{ type: "text", text: "second target" }]);

    expect(adapters).toHaveLength(2);
    expect(createdTargets).toEqual([
      { id: "codex-a", harness: "codex" },
      { id: "codex-b", harness: "codex" },
    ]);
    expect(adapters[0]?.prompts).toEqual(["first target"]);
    expect(adapters[1]?.prompts).toEqual(["second target"]);
    expect(adapters[0]?.model).toBe("fast");
    expect(adapters[1]?.model).toBeNull();
    expect(adapters[1]?.openOptions?.resumeSessionId).toBe("instance-2-old");
    expect(adapters[1]?.openOptions?.resumeState).toEqual({
      version: 1,
      data: { sessionId: "instance-2-old" },
    });
    expect(adapters[1]?.synced[0]).toContain("first target");
    expect(session.meta.harnessSessions["codex-a"]).toMatchObject({
      harnessTargetId: "codex-a",
      harness: "codex",
      harnessSessionId: "instance-1-native",
      model: "fast",
      launchSnapshot: {
        harnessTargetId: "codex-a",
        harness: "codex",
        harnessSessionKey: "codex",
        cwd: "/repo",
        model: "fast",
      },
    });
    expect(session.meta.harnessSessions["codex-b"]).toMatchObject({
      harnessTargetId: "codex-b",
      harness: "codex",
      harnessSessionId: "instance-2-native",
    });

    const summaries = session
      .ledger.read()
      .filter((event) => event.kind === "_baton_turn_summary");
    expect(summaries.map((event) => event.harnessTargetId)).toEqual(["codex-a", "codex-b"]);
    const harnessSources = session
      .ledger.read()
      .filter((event) => event.kind === "agent_message")
      .map((event) => event.source);
    expect(harnessSources).toEqual([
      { type: "harness", harnessTargetId: "codex-a" },
      { type: "harness", harnessTargetId: "codex-b" },
    ]);

    const launchSnapshot = session.meta.harnessSessions["codex-a"]?.launchSnapshot;
    await controller.setModel("codex-a", null);
    expect(session.meta.harnessSessions["codex-a"]?.model).toBeUndefined();
    expect(session.meta.harnessSessions["codex-a"]?.launchSnapshot).toEqual(launchSnapshot);
  });

  test("rejects unknown or mismatched Target identities before creating an Adapter", () => {
    let adapterCreations = 0;
    const createAdapter = () => {
      adapterCreations++;
      return new FakeAdapter("codex");
    };
    const unknown = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: () => undefined,
      createAdapter,
    });
    expect(() =>
      unknown.submit("missing", [{ type: "text", text: "hello" }]),
    ).toThrow("HarnessTarget not registered: missing");
    expect(() => unknown.currentModel("missing")).toThrow(
      "HarnessTarget not registered: missing",
    );
    expect(() => unknown.currentEffort("missing")).toThrow(
      "HarnessTarget not registered: missing",
    );

    const mismatched = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: () => ({ id: "codex", harness: "codex" }),
      createAdapter,
    });
    expect(() =>
      mismatched.submit("codex-a", [{ type: "text", text: "hello" }]),
    ).toThrow("invalid HarnessTarget for codex-a: id=codex, harness=codex");
    expect(adapterCreations).toBe(0);
  });

  test("publishes the persisted turn summary to event-stream subscribers", async () => {
    const adapter = new FakeAdapter("codex");
    const events: AnyEventEnvelope[] = [];
    // 投影单通道：消费者订阅事件流（append 即广播），不从 submit 的回调取事件
    session.ledger.subscribe((event) => events.push(event));
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: () => adapter,
    });

    await controller.submit("codex", [{ type: "text", text: "hello" }]);

    expect(events.filter((event) => event.kind === "_baton_turn_summary")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "agent_message")).toHaveLength(1);
  });

  test("serializes turns across harnesses into one BatonSession timeline", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const adapters = new Map<string, FakeAdapter>();
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: (target) => {
        const adapter = new FakeAdapter(target.harness === "claude" ? "claude-code" : target.harness, {
          delayMs: 10,
          enter: () => {
            active++;
            maxActive = Math.max(maxActive, active);
            order.push(`start:${target.id}`);
          },
          leave: () => {
            order.push(`end:${target.id}`);
            active--;
          },
        });
        adapters.set(target.id, adapter);
        return adapter;
      },
    });

    await Promise.all([
      controller.submit("codex", [{ type: "text", text: "one" }]),
      controller.submit("claude", [{ type: "text", text: "two" }]),
    ]);

    expect(maxActive).toBe(1);
    expect(order).toEqual(["start:codex", "end:codex", "start:claude", "end:claude"]);
    expect(session.loadState().turnSummaries).toHaveLength(2);
    expect(adapters.get("codex")?.prompts).toEqual(["one"]);
  });

  test("exposes queued turns and recalls the latest one before it starts", async () => {
    const adapter = new FakeAdapter("codex", { delayMs: 20 });
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: () => adapter,
    });

    const active = controller.submit("codex", [{ type: "text", text: "one" }]);
    const queued = controller.submit("codex", [{ type: "text", text: "two" }]);
    const latest = controller.submit("claude", [{ type: "text", text: "three" }]);

    expect(controller.queuedHarnessInputs.map((turn) => textOf(turn.blocks))).toEqual(["two", "three"]);
    const recalled = controller.recallLatestQueued();
    expect(recalled && textOf(recalled.blocks)).toBe("three");
    expect(controller.harnessQueueLength).toBe(1);
    expect(await latest).toBe("recalled");
    expect(await active).toBe("completed");
    expect(await queued).toBe("completed");
    expect(adapter.prompts).toEqual(["one", "two"]);
  });

  test("rebuilds full BatonSession history for a fresh harness before prompting", async () => {
    completedTurn(session, "codex", "t_old", "existing work");
    const claude = new FakeAdapter("claude-code");
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: () => claude,
    });

    await controller.submit("claude", [{ type: "text", text: "continue" }]);

    expect(claude.synced).toHaveLength(1);
    expect(claude.synced[0]).toContain("BatonSession history");
    expect(claude.synced[0]).toContain("existing work");
    expect(claude.prompts).toEqual(["continue"]);
    expect(session.meta.harnessSessions.claude?.syncedSeq).toBeGreaterThan(0);
  });

  test("persists a delayed native session id before the first turn finalizes", async () => {
    completedTurn(session, "codex", "t_old", "existing work");
    const claude = new DelayedNativeIdAdapter();
    claude.beforeNativeId = () => {
      expect(session.meta.harnessSessions.claude?.harnessSessionId).toBeUndefined();
    };
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: () => claude,
    });

    const turn = controller.submit("claude", [{ type: "text", text: "continue" }]);
    while (!claude.turnId) await Bun.sleep(0);

    expect(session.meta.harnessSessions.claude?.harnessSessionId).toBe(
      "4bc983eb-f25c-4857-9ac2-28ac6442e74c",
    );
    expect(session.meta.harnessSessions.claude?.resumeState).toEqual({
      version: 1,
      data: { sessionId: "4bc983eb-f25c-4857-9ac2-28ac6442e74c" },
    });

    claude.finish();
    await turn;
  });

  test("resumes native session, restores config, and syncs only other-harness progress", async () => {
    completedTurn(session, "codex", "t_codex", "old codex work");
    const watermark = session.ledger.read().at(-1)?.seq ?? 0;
    session.setHarnessSession("codex", {
      harnessTargetId: "codex",
      harness: "codex",
      harnessSessionId: "thread-old",
      contextEpochId: "ctxe_existing",
      model: "fast",
      effort: "high",
      syncedSeq: watermark,
    });
    completedTurn(session, "claude-code", "t_claude", "new claude work");
    const codex = new FakeAdapter("codex");
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      modelPreferences: { codex: "remembered-global-model" },
      effortPreferences: { codex: "remembered-global-effort" },
      createAdapter: () => codex,
    });

    await controller.submit("codex", [{ type: "text", text: "next" }]);

    expect(codex.openOptions?.resumeSessionId).toBe("thread-old");
    expect(codex.openOptions?.resumeState).toEqual({
      version: 1,
      data: { sessionId: "thread-old" },
    });
    expect(codex.model).toBe("fast");
    expect(codex.effort).toBe("high");
    expect(codex.synced[0]).toContain("new claude work");
    expect(codex.synced[0]).not.toContain("old codex work");
    expect(session.meta.harnessSessions.codex?.harnessSessionId).toBe("codex-native");
    expect(session.meta.harnessSessions.codex?.resumeState).toEqual({
      version: 1,
      data: { sessionId: "codex-native" },
    });
    expect(session.meta.harnessSessions.codex?.contextEpochId).toBe("ctxe_existing");
  });

  test("uses the remembered Target model for a new BatonSession", async () => {
    const codex = new FakeAdapter("codex");
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      modelPreferences: { codex: "fast" },
      createAdapter: () => codex,
    });

    await controller.submit("codex", [{ type: "text", text: "next" }]);

    expect(codex.model).toBe("fast");
    expect(session.meta.harnessSessions.codex?.model).toBe("fast");
  });

  test("uses the remembered Target effort for a new BatonSession", async () => {
    const codex = new FakeAdapter("codex");
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      effortPreferences: { codex: "high" },
      createAdapter: () => codex,
    });

    await controller.submit("codex", [{ type: "text", text: "next" }]);

    expect(codex.effort).toBe("high");
    expect(session.meta.harnessSessions.codex?.effort).toBe("high");
  });

  test("compacts through a control turn without persisting a user message", async () => {
    const adapter = new CompactAdapter("codex");
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: () => adapter,
    });

    await controller.compactContext("codex");

    expect(adapter.compactCalls).toHaveLength(1);
    const events = session.ledger.read();
    expect(events.filter((event) => event.kind === "user_message")).toHaveLength(0);
    expect(events.filter((event) => event.kind === "state_update").map((event) => event.payload)).toEqual([
      { state: "running" },
      { state: "idle", stopReason: "end_turn" },
    ]);
    expect(events.filter((event) => event.kind === "_baton_turn_summary")).toHaveLength(1);
  });

  test("rejects /compact when the harness does not declare the capability", async () => {
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: () => new FakeAdapter("example"),
    });

    await expect(controller.compactContext("example")).rejects.toThrow("does not support /compact");
    expect(session.ledger.read()).toHaveLength(0);
  });
});

// ---- Interaction 注册表：adapter 的 await 点由统一 completeInteraction() 唤醒 ----
// identity、requested / terminal 事件与 waiter 全部由 Controller 持有。

describe("interaction completion registry", () => {
  /** 先审批、后提问、再收口的交互式 fake adapter；handlers 由 controller 经 createAdapter 注入 */
  class InteractiveAdapter implements HarnessAdapter {
    readonly harness = "codex";
    readonly capabilities: AdapterCapabilities = { prompt: {} };
    sink?: EventSink;

    constructor(private readonly handlers: HarnessAdapterPorts) {}

    async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionHandle> {
      this.sink = sink;
      return { harness: this.harness, handleId: "ia-ref", resumed: false };
    }

    async sendTurn(_ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt> {
      const emit = (ev: Parameters<EventSink>[0]) => this.sink?.({ ...ev, turnId: input.turnId });
      emit({ kind: "state_update", payload: { state: "running" } });
      void (async () => {
        const decision = await this.handlers.openInteraction({
          kind: "permission",
          title: "Run command?",
          options: [
            { optionId: "allow", name: "Allow", polarity: "allow" as const, lifetime: "once" as const },
          ],
        }, { turnId: input.turnId });
        expect(decision).toMatchObject({ kind: "permission", optionId: "allow" });

        const answers = await this.handlers.openInteraction({
          kind: "question",
          questions: [{ questionId: "q1", header: "Scope", question: "Which scope?" }],
        }, { turnId: input.turnId });
        expect(answers).toMatchObject({ kind: "question", answers: { q1: ["prod"] } });

        emit({ kind: "state_update", payload: { state: "idle", stopReason: "end_turn" } });
      })();
      return { accepted: true, effective: "new_turn" };
    }

    async cancel(_ref: HarnessSessionHandle): Promise<void> {}
    async close(_ref: HarnessSessionHandle): Promise<void> {}
  }

  test("completion wakes the adapter exactly once; unknown/stale ids report false", async () => {
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: (_target, handlers) => new InteractiveAdapter(handlers),
    });

    const turn = controller.submit("codex", [{ type: "text", text: "do it" }]);
    await Bun.sleep(5); // permission Interaction 已落盘、continuation 已注册

    expect(controller.completeInteraction("ix_unknown", {
      kind: "permission",
      outcome: "selected",
      optionId: "allow",
    })).toBe(false);
    const permission = session.ledger.read().find(
      (event) => event.kind === "interaction.requested" && event.payload.kind === "permission",
    );
    expect(permission?.kind).toBe("interaction.requested");
    const permissionId = permission?.kind === "interaction.requested" ? permission.payload.interactionId : "";
    expect(controller.completeInteraction(permissionId, {
      kind: "permission",
      outcome: "selected",
      optionId: "allow",
    })).toBe(true);
    expect(controller.completeInteraction(permissionId, {
      kind: "permission",
      outcome: "selected",
      optionId: "allow",
    })).toBe(false); // completion 一次性

    await Bun.sleep(5); // question Interaction 已落盘
    const question = session.ledger.read().find(
      (event) => event.kind === "interaction.requested" && event.payload.kind === "question",
    );
    const questionId = question?.kind === "interaction.requested" ? question.payload.interactionId : "";
    expect(controller.completeInteraction(questionId, {
      kind: "question",
      outcome: "answered",
      answers: { q1: ["prod"] },
    })).toBe(true);
    await turn;

    const events = session.ledger.read();
    expect(events.find(
      (event) => event.kind === "interaction.answered" && event.payload.interactionId === permissionId,
    )?.payload).toMatchObject({
      answer: { kind: "permission", outcome: "selected", optionId: "allow" },
    });
    expect(events.find(
      (event) => event.kind === "interaction.answered" && event.payload.interactionId === questionId,
    )?.payload).toMatchObject({
      answer: { kind: "question", outcome: "answered", answers: { q1: ["prod"] } },
    });
    // 事件流收支平衡：所有 Interaction 最终都有 result
    const state = session.loadState();
    expect([...state.interactions.values()].every((value) => value.result)).toBe(true);
  });

  test("a harness-startup hook trust request belongs to the preparing turn", async () => {
    class StartupTrustAdapter implements HarnessAdapter {
      readonly harness = "codex";
      readonly capabilities: AdapterCapabilities = { prompt: {} };
      private sink?: EventSink;

      constructor(private readonly handlers: HarnessAdapterPorts) {}

      async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionHandle> {
        this.sink = sink;
        const response = await this.handlers.openInteraction({
          kind: "hook_trust" as const,
          harnessName: "Codex",
          hooks: [
            {
              key: "hook1",
              source: "plugin",
              sourcePath: "/plugins/devloop/hooks.json",
              trustStatus: "modified" as const,
              command: "python hook.py",
            },
          ],
        });
        expect(response).toEqual({ kind: "hook_trust", outcome: "trusted" });
        return { harness: this.harness, handleId: "startup-trust", resumed: false };
      }

      async sendTurn(_ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt> {
        this.sink?.({
          kind: "state_update",
          turnId: input.turnId,
          payload: { state: "idle", stopReason: "end_turn" },
        });
        return { accepted: true, effective: "new_turn" };
      }

      async cancel(): Promise<void> {}
      async close(): Promise<void> {}
    }

    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: (_target, handlers) => new StartupTrustAdapter(handlers),
    });
    const outcome = controller.submit("codex", [{ type: "text", text: "go" }]);
    await Bun.sleep(5);
    const interaction = session.ledger.read().find(
      (event) => event.kind === "interaction.requested" && event.payload.kind === "hook_trust",
    );
    expect(interaction?.turnId).toBeDefined();
    const interactionId = interaction?.kind === "interaction.requested" ? interaction.payload.interactionId : "";
    expect(controller.completeInteraction(interactionId, {
      kind: "hook_trust",
      outcome: "trusted",
    })).toBe(true);
    await outcome;
    expect(session.loadState().interactions.get(interactionId)?.result).toEqual({
      kind: "hook_trust",
      outcome: "trusted",
    });
  });

  test("setup-phase attribution covers any Interaction kind, not just hook trust", async () => {
    // setup 阶段（binding 创建 → open 完成）的归属规则按 Interaction 判断：
    // 新 harness 的冷启动若阻塞征询 permission / question，不需要再回 controller 加 kind 特判。
    class SetupPermissionAdapter implements HarnessAdapter {
      readonly harness = "codex";
      readonly capabilities: AdapterCapabilities = { prompt: {} };
      private sink?: EventSink;

      constructor(private readonly handlers: HarnessAdapterPorts) {}

      async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionHandle> {
        this.sink = sink;
        const response = await this.handlers.openInteraction({
          kind: "permission" as const,
          title: "Allow launch profile?",
          options: [
            { optionId: "allow", name: "Allow once", polarity: "allow" as const, lifetime: "once" as const },
          ],
        });
        expect(response).toMatchObject({ kind: "permission", optionId: "allow" });
        return { harness: this.harness, handleId: "setup-permission", resumed: false };
      }

      async sendTurn(_ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt> {
        this.sink?.({
          kind: "state_update",
          turnId: input.turnId,
          payload: { state: "idle", stopReason: "end_turn" },
        });
        return { accepted: true, effective: "new_turn" };
      }

      async cancel(): Promise<void> {}
      async close(): Promise<void> {}
    }

    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: (_target, handlers) => new SetupPermissionAdapter(handlers),
    });
    const outcome = controller.submit("codex", [{ type: "text", text: "go" }]);
    await Bun.sleep(5);
    const interaction = session.ledger.read().find(
      (event) => event.kind === "interaction.requested" && event.payload.kind === "permission",
    );
    expect(interaction?.turnId).toBeDefined();
    const interactionId = interaction?.kind === "interaction.requested" ? interaction.payload.interactionId : "";
    expect(controller.completeInteraction(interactionId, {
      kind: "permission",
      outcome: "selected",
      optionId: "allow",
    })).toBe(true);
    await outcome;
    expect(session.loadState().interactions.get(interactionId)?.result).toEqual({
      kind: "permission",
      outcome: "selected",
      optionId: "allow",
    });
  });
});

// 委托状态必须对当前活跃 harness 可见（见 docs/approval-lifecycle.md），但可见性的来源只能是
// harness 自己报的生效路由——不是 baton 的配置意图。曾经投影层直接读
// config.codexApprovalReviewer，于是跟 claude 对话时 footer 也显示 codex 的委托状态。
describe("controller.approvalRoute reports the harness's own effective route", () => {
  class RoutableAdapter extends FakeAdapter {
    readonly capabilities: AdapterCapabilities = { prompt: {}, approvalRouting: { supported: true } };
    constructor(
      harness: string,
      private readonly route: "user" | "delegated" | null,
    ) {
      super(harness);
    }
    approvalRoute(): "user" | "delegated" | null {
      return this.route;
    }
  }

  const routeAfterOpen = async (adapter: HarnessAdapter, harness: string) => {
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: () => adapter,
    });
    await controller.submit(harness, [{ type: "text", text: "hi" }]);
    return controller.approvalRoute(harness);
  };

  test("a delegated route is visible", async () => {
    expect(await routeAfterOpen(new RoutableAdapter("codex", "delegated"), "codex")).toBe("delegated");
  });

  test("a user route is visible and is not delegation", async () => {
    expect(await routeAfterOpen(new RoutableAdapter("codex", "user"), "codex")).toBe("user");
  });

  test("a harness that cannot report stays null — never guessed", async () => {
    expect(await routeAfterOpen(new RoutableAdapter("codex", null), "codex")).toBeNull();
  });

  // 不声明 approvalRouting 的 harness（如 claude）不该被安上别家的委托状态
  test("a harness without the capability stays null (no cross-harness bleed)", async () => {
    expect(await routeAfterOpen(new FakeAdapter("claude-code"), "claude")).toBeNull();
  });
});
