import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "bun:test";

import type { AnyEventDraft } from "../src/event/index.ts";
import type { OpenInteraction } from "../src/harness/adapter.ts";
import { ClaudeAdapter, type ClaudeAdapterOptions } from "../src/harness/claude/adapter.ts";

const openInteraction: OpenInteraction = async (req) =>
  req.kind === "permission"
    ? { kind: "permission", outcome: "selected", optionId: "deny" }
    : { kind: "question", outcome: "answered", answers: {} };

interface TurnState {
  turnId: string;
  finalized: boolean;
  cancelRequested: boolean;
}

function promptText(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

test("Claude sendTurn reuses one streaming query and steers the active turn", async () => {
  let queryCount = 0;
  let closes = 0;
  let promptIterator: AsyncIterator<SDKUserMessage> | undefined;
  const modelUpdates: Array<string | undefined> = [];
  const stoppedTasks: string[] = [];
  const cancelledMessageUuids: string[] = [];
  const perTaskStopDeclarations: Array<boolean | undefined> = [];
  const queryFactory: NonNullable<ClaudeAdapterOptions["queryFactory"]> = ((params) => {
    queryCount++;
    perTaskStopDeclarations.push(params.options?.perTaskStopAffordance);
    if (typeof params.prompt === "string") throw new Error("expected streaming Claude prompt");
    promptIterator = params.prompt[Symbol.asyncIterator]();
    const output = (async function* () {
      await new Promise<void>(() => {});
    })();
    return Object.assign(output, {
      initializationResult: async () => ({ models: [] }),
      setModel: async (model?: string) => {
        modelUpdates.push(model);
      },
      interrupt: async () => undefined,
      stopTask: async (taskId: string) => {
        stoppedTasks.push(taskId);
      },
      cancelAsyncMessage: async (messageUuid: string) => {
        cancelledMessageUuids.push(messageUuid);
        return true;
      },
      close: () => {
        closes++;
      },
    }) as unknown as Query;
  }) as NonNullable<ClaudeAdapterOptions["queryFactory"]>;

  const adapter = new ClaudeAdapter({ openInteraction, queryFactory });
  const events: Array<{ kind: string; turnId?: string; payload: Record<string, unknown> }> = [];
  const ref = await adapter.open({ cwd: "/tmp" }, (event) => events.push(event as never));

  expect(
    await adapter.sendTurn(ref, {
      turnId: "t_1",
      messageId: "m_1",
      blocks: [{ type: "text", text: "run five commands" }],
    }),
  ).toEqual({ accepted: true, effective: "new_turn" });
  expect(queryCount).toBe(1);
  expect(perTaskStopDeclarations).toEqual([true]);
  expect(promptText((await promptIterator?.next())?.value as SDKUserMessage)).toBe("run five commands");

  await adapter.stopTask(ref, "task-1");
  expect(stoppedTasks).toEqual(["task-1"]);

  expect(
    await adapter.sendTurn(ref, {
      turnId: "t_1",
      messageId: "m_2",
      blocks: [{ type: "text", text: "actually run fifteen" }],
    }),
  ).toEqual({ accepted: true, effective: "steer" });
  expect(queryCount).toBe(1);
  const steeredMessage = (await promptIterator?.next())?.value as SDKUserMessage;
  expect(promptText(steeredMessage)).toBe("actually run fifteen");
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "user_message",
      turnId: "t_1",
      payload: expect.objectContaining({
        messageId: "m_2",
        delivery: "steer",
      }),
    }),
  );
  expect(await adapter.cancelInput(ref, "m_2")).toBe(true);
  expect(cancelledMessageUuids).toEqual([steeredMessage.uuid as string]);
  expect(await adapter.cancelInput(ref, "m_unknown")).toBe(false);

  expect(
    await adapter.sendTurn(ref, {
      turnId: "t_stale",
      messageId: "m_3",
      blocks: [{ type: "text", text: "stale input" }],
    }),
  ).toMatchObject({ accepted: false, effective: "rejected" });

  await adapter.setModel(ref, "sonnet");
  expect(modelUpdates).toEqual(["sonnet"]);

  const seams = adapter as unknown as {
    sessions: Map<string, { activeTurn?: TurnState }>;
    emit(rt: unknown, ev: AnyEventDraft, turn?: TurnState): void;
    finishTurn(rt: unknown, emit: (ev: AnyEventDraft) => void, turn: TurnState, stopReason: string): void;
  };
  const rt = seams.sessions.get(ref.handleId);
  const firstTurn = rt?.activeTurn;
  if (!rt || !firstTurn) throw new Error("missing active Claude test turn");
  seams.finishTurn(rt, (ev) => seams.emit(rt, ev, firstTurn), firstTurn, "end_turn");

  expect(
    await adapter.sendTurn(ref, {
      turnId: "t_2",
      messageId: "m_4",
      blocks: [{ type: "text", text: "next turn" }],
    }),
  ).toEqual({ accepted: true, effective: "new_turn" });
  expect(queryCount).toBe(1);
  expect(promptText((await promptIterator?.next())?.value as SDKUserMessage)).toBe("next turn");

  const secondTurn = rt.activeTurn;
  if (!secondTurn) throw new Error("missing second Claude test turn");
  seams.finishTurn(rt, (ev) => seams.emit(rt, ev, secondTurn), secondTurn, "end_turn");
  await adapter.setEffort(ref, "high");
  expect(
    await adapter.sendTurn(ref, {
      turnId: "t_3",
      messageId: "m_5",
      blocks: [{ type: "text", text: "high effort turn" }],
    }),
  ).toEqual({ accepted: true, effective: "new_turn" });
  expect(queryCount).toBe(2);
  expect(perTaskStopDeclarations).toEqual([true, true]);
  expect(promptText((await promptIterator?.next())?.value as SDKUserMessage)).toBe("high effort turn");

  await adapter.close(ref);
  expect(closes).toBe(2);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "input_delivery_update",
      payload: expect.objectContaining({
        messageId: "m_2",
        state: "failed",
      }),
    }),
  );
});

test("Claude correlation applies every coalesced steer exactly once", async () => {
  let promptIterator: AsyncIterator<SDKUserMessage> | undefined;
  let releaseMessages: ((messages: unknown[]) => void) | undefined;
  let finishOutput: (() => void) | undefined;
  const outputFinished = new Promise<void>((resolve) => {
    finishOutput = resolve;
  });
  const queryFactory: NonNullable<ClaudeAdapterOptions["queryFactory"]> = ((params) => {
    if (typeof params.prompt === "string") throw new Error("expected streaming Claude prompt");
    promptIterator = params.prompt[Symbol.asyncIterator]();
    const messages = new Promise<unknown[]>((resolve) => {
      releaseMessages = resolve;
    });
    const output = (async function* () {
      for (const message of await messages) yield message as never;
      finishOutput?.();
    })();
    return Object.assign(output, {
      initializationResult: async () => ({ models: [] }),
      setModel: async () => undefined,
      interrupt: async () => undefined,
      close: () => undefined,
    }) as unknown as Query;
  }) as NonNullable<ClaudeAdapterOptions["queryFactory"]>;

  const adapter = new ClaudeAdapter({ openInteraction, queryFactory });
  const events: Array<{ kind: string; turnId?: string; payload: Record<string, unknown> }> = [];
  const ref = await adapter.open({ cwd: "/tmp" }, (event) => events.push(event as never));
  await adapter.sendTurn(ref, {
    turnId: "t_active",
    messageId: "m_initial",
    blocks: [{ type: "text", text: "start" }],
  });
  await promptIterator?.next();
  await adapter.sendTurn(ref, {
    turnId: "t_active",
    messageId: "m_folded_1",
    blocks: [{ type: "text", text: "use this additional context" }],
  });
  const folded1 = (await promptIterator?.next())?.value as SDKUserMessage;
  await adapter.sendTurn(ref, {
    turnId: "t_active",
    messageId: "m_folded_2",
    blocks: [{ type: "text", text: "and this constraint" }],
  });
  const folded2 = (await promptIterator?.next())?.value as SDKUserMessage;
  const correlation = {
    user_message_uuid: folded2.uuid,
    user_message_uuids: [folded1.uuid, folded2.uuid],
  };

  releaseMessages?.([
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Combined answer" }] },
      parent_tool_use_id: null,
      ...correlation,
    },
    {
      type: "result",
      subtype: "success",
      ...correlation,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
    },
  ]);
  await outputFinished;

  const appliedEvents = events.filter(
    (event) => event.kind === "input_delivery_update" && event.payload.state === "applied",
  );
  const appliedIndex = events.findIndex((event) => event === appliedEvents[0]);
  const idleIndex = events.findIndex(
    (event) => event.kind === "state_update" && event.payload.state === "idle",
  );
  expect(appliedIndex).toBeGreaterThan(-1);
  expect(idleIndex).toBeGreaterThan(appliedIndex);
  expect(appliedEvents.map((event) => event.payload.messageId)).toEqual(["m_folded_1", "m_folded_2"]);
  expect(events.find((event) => event.kind === "agent_message")?.payload.replyToMessageIds)
    .toEqual(["m_folded_1", "m_folded_2"]);
  expect(events).not.toContainEqual(
    expect.objectContaining({
      kind: "input_delivery_update",
      payload: expect.objectContaining({ state: "failed" }),
    }),
  );

  await adapter.close(ref);
});

test("Claude lifecycle start moves a delayed steer into a new Harness-started turn", async () => {
  let promptIterator: AsyncIterator<SDKUserMessage> | undefined;
  let releaseOutput: ((message: unknown) => void) | undefined;
  let finishOutput: (() => void) | undefined;
  const outputFinished = new Promise<void>((resolve) => {
    finishOutput = resolve;
  });
  const queryFactory: NonNullable<ClaudeAdapterOptions["queryFactory"]> = ((params) => {
    if (typeof params.prompt === "string") throw new Error("expected streaming Claude prompt");
    promptIterator = params.prompt[Symbol.asyncIterator]();
    const nextOutput = new Promise<unknown>((resolve) => {
      releaseOutput = resolve;
    });
    const output = (async function* () {
      yield (await nextOutput) as never;
      finishOutput?.();
    })();
    return Object.assign(output, {
      initializationResult: async () => ({ models: [] }),
      setModel: async () => undefined,
      interrupt: async () => undefined,
      close: () => undefined,
    }) as unknown as Query;
  }) as NonNullable<ClaudeAdapterOptions["queryFactory"]>;

  const adapter = new ClaudeAdapter({ openInteraction, queryFactory });
  const events: Array<{ kind: string; turnId?: string; payload: Record<string, unknown> }> = [];
  const ref = await adapter.open({ cwd: "/tmp" }, (event) => events.push(event as never));
  await adapter.sendTurn(ref, {
    turnId: "t_original",
    messageId: "m_initial",
    blocks: [{ type: "text", text: "start" }],
  });
  await promptIterator?.next();
  await adapter.sendTurn(ref, {
    turnId: "t_original",
    messageId: "m_delayed",
    blocks: [{ type: "text", text: "run after this turn" }],
  });
  const delayed = (await promptIterator?.next())?.value as SDKUserMessage;

  const seams = adapter as unknown as {
    sessions: Map<string, { activeTurn?: TurnState }>;
    emit(rt: unknown, ev: AnyEventDraft, turn?: TurnState): void;
    finishTurn(rt: unknown, emit: (ev: AnyEventDraft) => void, turn: TurnState, stopReason: string): void;
  };
  const rt = seams.sessions.get(ref.handleId);
  const original = rt?.activeTurn;
  if (!rt || !original) throw new Error("missing original Claude turn");
  seams.finishTurn(rt, (ev) => seams.emit(rt, ev, original), original, "end_turn");

  releaseOutput?.({
    type: "command_lifecycle",
    uuid: delayed.uuid,
    state: "started",
  });
  await outputFinished;

  const applied = events.find(
    (event) => event.kind === "input_delivery_update" && event.payload.messageId === "m_delayed" &&
      event.payload.state === "applied",
  );
  // 回执挂在 Harness 新起的 turn 上；正文在 offer 时已落盘（原 turn），不再随回执重复。
  expect(applied).toMatchObject({
    turnId: expect.not.stringMatching(/^t_original$/),
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "state_update",
      turnId: applied?.turnId,
      payload: expect.objectContaining({ state: "running" }),
    }),
  );

  await adapter.close(ref);
});
