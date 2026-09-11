import type {
  DeepSeekHarnessOptions as DshClientOptions,
  HarnessNotification as DshEvent,
  RunResult as DshRunResult,
  NotificationSubscription,
  SdkPromptContentBlock,
} from "@deepseek-ai/dsh-sdk-client";
import { describe, expect, test } from "bun:test";

import type { AnyEventDraft } from "../src/event/index.ts";
import {
  DshAdapter,
  type DshClientLike,
  type DshSessionLike,
} from "../src/harness/dsh/adapter.ts";
import {
  type HarnessResumeState,
  sessionIdResumeState,
} from "../src/harness/resume.ts";

import { dshPromptInput } from "../src/harness/dsh/prompt.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type DshInput = SdkPromptContentBlock[];
interface DshTurnLike extends AsyncIterable<DshEvent> {
  readonly result: Promise<DshRunResult>;
}

function result(sessionId: string, finalResponse = ""): DshRunResult {
  return {
    sessionId,
    finalResponse,
    events: [],
    notifications: [],
  } as DshRunResult;
}

function sessionEvent(
  sessionId: string,
  type: string,
  data: Record<string, unknown>,
): DshEvent {
  return {
    method: "session.event",
    params: {
      sessionId,
      event: { type, seq: 1, time: Date.now(), data },
    },
  };
}

class StaticTurn implements DshTurnLike {
  readonly result: Promise<DshRunResult>;

  constructor(
    private readonly events: DshEvent[],
    runResult: DshRunResult,
  ) {
    this.result = Promise.resolve(runResult);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<DshEvent> {
    for (const event of this.events) yield event;
  }
}

class ControlledTurn implements DshTurnLike {
  readonly result: Promise<DshRunResult>;
  private resolveResult!: (value: DshRunResult) => void;
  private rejectResult!: (error: Error) => void;

  constructor() {
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    void this.result.catch(() => undefined);
  }

  resolve(value: DshRunResult): void {
    this.resolveResult(value);
  }

  reject(error: Error): void {
    this.rejectResult(error);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<DshEvent> {
    await this.result;
  }
}

class FakeSession implements DshSessionLike {
  readonly inputs: DshInput[] = [];

  constructor(
    readonly id: string,
    private readonly turns: DshTurnLike[],
  ) {}

  next(input: DshInput): DshTurnLike {
    this.inputs.push(input);
    const turn = this.turns.shift();
    if (!turn) throw new Error("no fake DSH turn queued");
    return turn;
  }

}

class FakeSubscription implements NotificationSubscription {
  private queue: DshEvent[] = [];
  private waiter?: { resolve: (event: DshEvent) => void; reject: (error: Error) => void };
  private error?: Error;
  push(event: DshEvent): void {
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve(event); }
    else this.queue.push(event);
  }
  fail(error: Error): void { this.error = error; this.waiter?.reject(error); this.waiter = undefined; }
  next(): Promise<DshEvent> {
    const event = this.queue.shift();
    if (event) return Promise.resolve(event);
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  tryNext(): DshEvent | undefined { return this.queue.shift(); }
  close(): void { this.fail(new Error("subscription closed")); }
  async *[Symbol.asyncIterator](): AsyncIterator<DshEvent> { while (true) yield await this.next(); }
}

class FakeClient implements DshClientLike {
  starts = 0;
  closes = 0;
  requestedSessionIds: Array<string | undefined> = [];
  createdSessions: FakeSession[] = [];
  subscription?: FakeSubscription;
  private serial = 0;
  readonly client = {
    subscribeSessionTree: (_id: string): NotificationSubscription => this.subscription = new FakeSubscription(),
    prompt: async (sessionId: string, input: DshInput): Promise<string> => {
      const nativeId = `native-${++this.serial}`;
      const turn = this.createdSessions.at(-1)!.next(input);
      const subscription = this.subscription!;
      void (async () => {
        subscription.push(sessionEvent(sessionId, "agent/inbox/spliced", { inserted: [{ id: nativeId }] }));
        let sawMessage = false;
        for await (const event of turn) {
          if ((event.params.event as { type?: string })?.type === "assistant/message") sawMessage = true;
          subscription.push(event);
        }
        const result = await turn.result;
        if (result.finalResponse && !sawMessage) subscription.push(sessionEvent(sessionId, "assistant/message", {
          message: { content: [{ type: "text", text: result.finalResponse }] },
        }));
        subscription.push({ method: "session.status", params: { sessionId, status: "idle" } });
      })().catch((error) => subscription.fail(error));
      return nativeId;
    },
  };

  constructor(
    private readonly nativeSessionId: string,
    private readonly turns: DshTurnLike[],
    private readonly onClose?: () => void,
  ) {}

  async start(): Promise<void> {
    this.starts += 1;
  }

  session(sessionId?: string): DshSessionLike {
    this.requestedSessionIds.push(sessionId);
    const session = new FakeSession(sessionId ?? this.nativeSessionId, this.turns);
    this.createdSessions.push(session);
    return session;
  }

  async close(): Promise<void> {
    this.closes += 1;
    this.onClose?.();
    this.subscription?.close();
  }
}

async function waitForIdle(events: AnyEventDraft[], turnId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (events.some((event) => event.kind === "state_update" && event.turnId === turnId)) return;
    await Bun.sleep(1);
  }
  throw new Error(`turn ${turnId} did not reach idle`);
}

describe("DshAdapter", () => {
  test("uses the SDK-owned runtime without a custom launch command", async () => {
    const client = new FakeClient("default-runtime", []);
    let options: DshClientOptions | undefined;
    const adapter = new DshAdapter({ clientFactory: (value) => { options = value; return client; } });
    const ref = await adapter.open({ cwd: "/repo" }, () => undefined);
    expect(options?.dshBin).toBeUndefined();
    expect(options?.profile).toBeUndefined();
    expect(options?.initializeTimeoutMs).toBe(15_000);
    expect(options?.processCwd).toBe("/repo");
    await adapter.close(ref);
  });

  test("opens a native session, publishes its binding, and lowers text prompts", async () => {
    const client = new FakeClient("dsh-native-1", [new StaticTurn([], result("dsh-native-1", "done"))]);
    const options: DshClientOptions[] = [];
    const bindings: unknown[] = [];
    const events: AnyEventDraft[] = [];
    const adapter = new DshAdapter({
      dshBin: "/tmp/dsh/lib/bin.js",
      patches: ["/tmp/cordis.patch.yml"],
      provider: "deepseek-official",
      model: "prod",
      maxTokens: 32_768,
      env: { DSH_TARGET: "2", DSH_TEST: "target" },
      clientFactory: (value) => {
        options.push(value);
        return client;
      },
    });

    const ref = await adapter.open(
      { cwd: "/repo", env: { DSH_TEST: "open" } },
      (event) => events.push(event),
      (binding) => bindings.push(binding),
    );
    expect(ref).toMatchObject({ harness: "deepseek-harness", resumed: false });
    expect(client.starts).toBe(1);
    expect(options[0]).toMatchObject({
      dshBin: "/tmp/dsh/lib/bin.js",
      patches: ["/tmp/cordis.patch.yml"],
      processCwd: "/repo",
      env: { DSH_TEST: "target", DSH_TARGET: "2" },
      initializeTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
      shutdownTimeoutMs: 1_000,
      disposeEofGraceMs: 6_000,
      disposeGraceMs: 3_000,
      cwd: "/repo",
      provider: "deepseek-official",
      model: "prod",
      maxTokens: 32_768,
    });
    expect(bindings).toEqual([
      { identity: { id: "dsh-native-1" }, resumeState: sessionIdResumeState("dsh-native-1") },
    ]);

    expect(await adapter.sendTurn(ref, {
      turnId: "t_text",
      messageId: "m_user",
      blocks: [{ type: "text", text: "hello" }],
    })).toEqual({ accepted: true, effective: "new_turn" });
    await waitForIdle(events, "t_text");
    expect(client.createdSessions[0]?.inputs).toEqual([[{ type: "text", text: "hello" }]]);
    expect(events.find((event) => event.kind === "agent_message")?.payload).toMatchObject({
      content: [{ type: "text", text: "done" }],
    });
    await adapter.close(ref);
  });

  test("maps streaming messages, tools, usage, todo, subagents, and one terminal event", async () => {
    const sessionId = "dsh-native-2";
    const notifications: DshEvent[] = [
      sessionEvent(sessionId, "request/context", {
        turn: 1,
        step: 1,
        provider: "deepseek-official",
        model: "prod",
        contextWindow: 128_000,
      }),
      sessionEvent(sessionId, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "reasoning-delta", index: 0, text: "thinking" },
      }),
      sessionEvent(sessionId, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "text-delta", index: 1, text: "partial" },
      }),
      sessionEvent(sessionId, "tool/call", {
        turn: 1,
        step: 1,
        callId: "call-1",
        name: "bash",
        arguments: '{"cmd":"pwd"}',
      }),
      sessionEvent(sessionId, "tool/result", {
        turn: 1,
        step: 1,
        message: {
          content: [{
            type: "tool-result",
            toolCallId: "call-1",
            content: [{ type: "text", text: "/repo" }],
          }],
        },
      }),
      sessionEvent(sessionId, "todo/write", {
        todos: [{ content: "Inspect repository", status: "completed" }],
      }),
      sessionEvent(sessionId, "todo/write", { todos: [] }),
      sessionEvent(sessionId, "assistant/message", {
        turn: 1,
        step: 1,
        message: {
          id: "assistant-1",
          role: "assistant",
          content: [
            { type: "reasoning", text: "complete thought" },
            { type: "text", text: "complete answer" },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 },
      }),
      {
        method: "subagent.started",
        params: { parentSessionId: sessionId, childSessionId: "child-1" },
      },
      sessionEvent("child-1", "assistant/message", {
        turn: 1,
        step: 1,
        message: { content: [{ type: "text", text: "must stay out of root transcript" }] },
      }),
      {
        method: "subagent.finished",
        params: {
          parentSessionId: sessionId,
          childSessionId: "child-1",
          agentId: "child-1",
          provider: "deepseek-official",
          status: "ok",
          stopReason: "stop",
          lastAssistantMessage: [{ type: "text", text: "child summary" }],
        },
      },
      sessionEvent(sessionId, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ];
    const client = new FakeClient(sessionId, [new StaticTurn(notifications, result(sessionId, "complete answer"))]);
    const events: AnyEventDraft[] = [];
    const native: unknown[] = [];
    const adapter = new DshAdapter({
      dshBin: "/tmp/dsh/lib/bin.js",
      patches: ["/tmp/cordis.patch.yml"],
      clientFactory: () => client,
      nativeEvent: (event) => native.push(event),
    });
    const ref = await adapter.open({ cwd: "/repo" }, (event) => events.push(event));

    await adapter.sendTurn(ref, {
      turnId: "t_mapping",
      messageId: "m_user",
      blocks: [{ type: "text", text: "inspect" }],
    });
    await waitForIdle(events, "t_mapping");

    const chunk = events.find((event) => event.kind === "agent_message_chunk");
    const message = events.find((event) => event.kind === "agent_message");
    expect(chunk?.payload).toMatchObject({ content: { type: "text", text: "partial" } });
    expect(message?.payload).toMatchObject({ content: [{ type: "text", text: "complete answer" }] });
    expect((chunk?.payload as { messageId: string }).messageId).toBe(
      (message?.payload as { messageId: string }).messageId,
    );
    expect(events.find((event) => event.kind === "agent_thought")?.payload).toMatchObject({
      content: [{ type: "text", text: "complete thought" }],
    });

    const tools = events.filter((event) => event.kind === "tool_call_update");
    expect(tools).toHaveLength(2);
    expect(tools[0]?.payload).toMatchObject({ title: "bash", kind: "execute", status: "in_progress" });
    expect(tools[1]?.payload).toMatchObject({ status: "completed", content: [{ type: "text", text: "/repo" }] });
    expect((tools[0]?.payload as { toolCallId: string }).toolCallId).toBe(
      (tools[1]?.payload as { toolCallId: string }).toolCallId,
    );
    expect(events.find((event) => event.kind === "usage_update")?.payload).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: undefined,
      reasoningTokens: undefined,
    });
    expect(
      events
        .filter((event) => event.kind === "context_window_update")
        .map((event) => event.payload),
    ).toEqual([{
      modelSelection: "default",
      effectiveModel: "prod",
      usedTokens: 12,
      capacityTokens: 128_000,
    }]);
    const planUpdate = events.find((event) => event.kind === "plan_update");
    expect(planUpdate?.payload).toMatchObject({
      entries: [{ id: expect.stringMatching(/^pe_/), content: "Inspect repository", status: "completed", priority: "medium" }],
    });
    expect(events.find((event) => event.kind === "plan_remove")?.payload).toEqual({
      planId: (planUpdate?.payload as { planId: string }).planId,
    });
    expect(events.filter((event) => event.kind === "task_update")).toHaveLength(2);
    expect(
      events.filter((event) => event.kind === "agent_message" && JSON.stringify(event).includes("must stay out")),
    ).toHaveLength(0);
    expect(events.filter((event) => event.kind === "state_update")).toEqual([
      expect.objectContaining({
        turnId: "t_mapping",
        harnessSessionId: sessionId,
        payload: { state: "idle", stopReason: "end_turn" },
      }),
    ]);
    expect(native).toHaveLength(notifications.length + 2);
    await adapter.close(ref);
  });

  test("restores the last request context when DSH deduplicates it after resume", async () => {
    const sessionId = "dsh-native-context-resume";
    const firstClient = new FakeClient(sessionId, [new StaticTurn([
      sessionEvent(sessionId, "request/context", {
        turn: 1,
        step: 1,
        provider: "deepseek-official",
        model: "prod",
        contextWindow: 128_000,
      }),
      sessionEvent(sessionId, "assistant/message", {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [{ type: "text", text: "first" }] },
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 2 },
      }),
      sessionEvent(sessionId, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ], result(sessionId, "first"))]);
    const bindings: Array<{ resumeState?: HarnessResumeState }> = [];
    const firstEvents: AnyEventDraft[] = [];
    const firstAdapter = new DshAdapter({
      dshBin: "/tmp/dsh/lib/bin.js",
      patches: ["/tmp/cordis.patch.yml"],
      model: "prod",
      clientFactory: () => firstClient,
    });
    const firstRef = await firstAdapter.open(
      { cwd: "/repo" },
      (event) => firstEvents.push(event),
      (binding) => bindings.push(binding),
    );
    await firstAdapter.sendTurn(firstRef, {
      turnId: "t_context_first",
      messageId: "m_context_first",
      blocks: [{ type: "text", text: "first" }],
    });
    await waitForIdle(firstEvents, "t_context_first");
    await firstAdapter.close(firstRef);

    const resumeState = bindings.at(-1)?.resumeState;
    expect(resumeState).toEqual({
      version: 1,
      data: {
        sessionId,
        requestContext: { model: "prod", contextWindow: 128_000 },
      },
    });
    if (!resumeState) throw new Error("expected DSH request context checkpoint");

    // The route is unchanged, so DSH does not emit request/context again.
    const secondClient = new FakeClient(sessionId, [new StaticTurn([
      sessionEvent(sessionId, "assistant/message", {
        turn: 2,
        step: 1,
        message: { role: "assistant", content: [{ type: "text", text: "second" }] },
        usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 5 },
      }),
      sessionEvent(sessionId, "turn/end", { turn: 2, reason: { kind: "completed" } }),
    ], result(sessionId, "second"))]);
    const events: AnyEventDraft[] = [];
    const secondAdapter = new DshAdapter({
      dshBin: "/tmp/dsh/lib/bin.js",
      patches: ["/tmp/cordis.patch.yml"],
      model: "prod",
      clientFactory: () => secondClient,
    });
    const secondRef = await secondAdapter.open(
      { cwd: "/repo", resumeState },
      (event) => events.push(event),
    );
    await secondAdapter.sendTurn(secondRef, {
      turnId: "t_context_second",
      messageId: "m_context_second",
      blocks: [{ type: "text", text: "second" }],
    });
    await waitForIdle(events, "t_context_second");

    expect(events.find((event) => event.kind === "context_window_update")?.payload).toEqual({
      modelSelection: "prod",
      effectiveModel: "prod",
      usedTokens: 25,
      capacityTokens: 128_000,
    });
    await secondAdapter.close(secondRef);
  });

  test("pairs each usage sample with the effective model route active for that request", async () => {
    const sessionId = "dsh-native-context-routes";
    const client = new FakeClient(sessionId, [new StaticTurn([
      sessionEvent(sessionId, "request/context", {
        turn: 1,
        step: 1,
        model: "deepseek-chat",
        contextWindow: 128_000,
      }),
      sessionEvent(sessionId, "assistant/message", {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [] },
        usage: { inputTokens: 20, cacheReadTokens: 5, outputTokens: 4 },
      }),
      sessionEvent(sessionId, "request/context", {
        turn: 1,
        step: 2,
        model: "deepseek-long",
        contextWindow: 256_000,
      }),
      sessionEvent(sessionId, "assistant/message", {
        turn: 1,
        step: 2,
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        usage: { inputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 2, outputTokens: 8 },
      }),
      sessionEvent(sessionId, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ], result(sessionId, "done"))]);
    const events: AnyEventDraft[] = [];
    const adapter = new DshAdapter({
      dshBin: "/tmp/dsh/lib/bin.js",
      patches: ["/tmp/cordis.patch.yml"],
      model: "auto",
      clientFactory: () => client,
    });
    const ref = await adapter.open({ cwd: "/repo" }, (event) => events.push(event));
    await adapter.sendTurn(ref, {
      turnId: "t_context_routes",
      messageId: "m_context_routes",
      blocks: [{ type: "text", text: "route" }],
    });
    await waitForIdle(events, "t_context_routes");

    expect(events.filter((event) => event.kind === "context_window_update").map((event) => event.payload)).toEqual([
      {
        modelSelection: "auto",
        effectiveModel: "deepseek-chat",
        usedTokens: 25,
        capacityTokens: 128_000,
      },
      {
        modelSelection: "auto",
        effectiveModel: "deepseek-long",
        usedTokens: 52,
        capacityTokens: 256_000,
      },
    ]);
    await adapter.close(ref);
  });

  test("rejects unsupported prompts and mismatched turn steering before accepting responsibility", async () => {
    const turn = new ControlledTurn();
    const sessionId = "dsh-native-3";
    const client = new FakeClient(sessionId, [turn]);
    const events: AnyEventDraft[] = [];
    const adapter = new DshAdapter({
      dshBin: "/tmp/dsh/lib/bin.js",
      patches: ["/tmp/cordis.patch.yml"],
      clientFactory: () => client,
    });
    const ref = await adapter.open({ cwd: "/repo" }, (event) => events.push(event));

    await expect(adapter.sendTurn(ref, {
      turnId: "t_image",
      messageId: "m_image",
      blocks: [{ type: "audio", mimeType: "audio/wav", data: "AA==" }],
    })).rejects.toThrow("audio");
    await adapter.sendTurn(ref, {
      turnId: "t_busy",
      messageId: "m_busy",
      blocks: [{ type: "text", text: "first" }],
    });
    expect(await adapter.sendTurn(ref, {
      turnId: "t_wrong",
      messageId: "m_steer",
      blocks: [{ type: "text", text: "steer" }],
    })).toMatchObject({ accepted: false, effective: "rejected" });
    turn.resolve(result(sessionId));
    await waitForIdle(events, "t_busy");
    await adapter.close(ref);
  });

  test("cancel closes the coarse runtime, emits cancelled once, and resumes the same native session", async () => {
    const firstTurn = new ControlledTurn();
    const sessionId = "dsh-resume-1";
    const first = new FakeClient(sessionId, [firstTurn], () => firstTurn.reject(new Error("runtime closed")));
    const second = new FakeClient(sessionId, [new StaticTurn([], result(sessionId, "continued"))]);
    const clients = [first, second];
    const events: AnyEventDraft[] = [];
    const adapter = new DshAdapter({
      dshBin: "/tmp/dsh/lib/bin.js",
      patches: ["/tmp/cordis.patch.yml"],
      clientFactory: () => clients.shift()!,
    });
    const ref = await adapter.open(
      { cwd: "/repo", resumeState: sessionIdResumeState(sessionId) },
      (event) => events.push(event),
    );
    expect(ref.resumed).toBe(true);
    expect(first.requestedSessionIds).toEqual([sessionId]);

    await adapter.sendTurn(ref, {
      turnId: "t_cancel",
      messageId: "m_cancel",
      blocks: [{ type: "text", text: "long task" }],
    });
    await adapter.cancel(ref);
    await waitForIdle(events, "t_cancel");
    expect(events.filter((event) => event.kind === "state_update" && event.turnId === "t_cancel")).toEqual([
      expect.objectContaining({ payload: { state: "idle", stopReason: "cancelled" } }),
    ]);
    expect(events.filter((event) => event.kind === "_baton_error_update")).toHaveLength(0);

    await adapter.sendTurn(ref, {
      turnId: "t_after_cancel",
      messageId: "m_after_cancel",
      blocks: [{ type: "text", text: "continue" }],
    });
    await waitForIdle(events, "t_after_cancel");
    expect(second.requestedSessionIds).toEqual([sessionId]);
    expect(events.find((event) => event.kind === "agent_message" && event.turnId === "t_after_cancel")?.payload)
      .toMatchObject({ content: [{ type: "text", text: "continued" }] });
    await adapter.close(ref);
  });
});

describe("dshPromptInput", () => {
  test("keeps text block boundaries", async () => {
    expect(await dshPromptInput([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ])).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]);
  });
});


describe("DSH image prompts", () => {
  test("loads archived clipboard images and preserves mixed block order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baton-dsh-image-"));
    try {
      const path = join(dir, "clipboard.png");
      await writeFile(path, Buffer.from("image-bytes"));
      expect(await dshPromptInput([
        { type: "text", text: "Describe this" },
        { type: "image", path, mimeType: "image/png" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/jpeg" },
      ])).toEqual([
        { type: "text", text: "Describe this" },
        { type: "image", data: Buffer.from("image-bytes").toString("base64"), mimeType: "image/png" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/jpeg" },
      ]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("rejects unsupported MIME types and missing content before submission", async () => {
    await expect(dshPromptInput([{ type: "image", data: "abc", mimeType: "image/svg+xml" }])).rejects.toThrow("mime type");
    await expect(dshPromptInput([{ type: "image", mimeType: "image/png" }])).rejects.toThrow("path or base64");
  });
});
