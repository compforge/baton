import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "bun:test";

import type { AnyEventDraft } from "../src/event/types.ts";
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
  const queryFactory: NonNullable<ClaudeAdapterOptions["queryFactory"]> = ((params) => {
    queryCount++;
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
  expect(promptText((await promptIterator?.next())?.value as SDKUserMessage)).toBe("run five commands");

  expect(
    await adapter.sendTurn(ref, {
      turnId: "t_1",
      messageId: "m_2",
      blocks: [{ type: "text", text: "actually run fifteen" }],
    }),
  ).toEqual({ accepted: true, effective: "steer" });
  expect(queryCount).toBe(1);
  expect(promptText((await promptIterator?.next())?.value as SDKUserMessage)).toBe("actually run fifteen");
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "user_message",
      turnId: "t_1",
      payload: expect.objectContaining({
        messageId: "m_2",
        delivery: "steer",
        deliveryState: "pending",
      }),
    }),
  );

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
  expect(promptText((await promptIterator?.next())?.value as SDKUserMessage)).toBe("high effort turn");

  await adapter.close(ref);
  expect(closes).toBe(2);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "user_message",
      payload: expect.objectContaining({
        messageId: "m_2",
        deliveryState: "failed",
      }),
    }),
  );
});

test("Claude lifecycle start moves a delayed steer into a new observed turn", async () => {
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
    (event) => event.kind === "user_message" && event.payload.messageId === "m_delayed" &&
      event.payload.deliveryState === "applied",
  );
  expect(applied).toMatchObject({
    turnId: expect.not.stringMatching(/^t_original$/),
    payload: {
      content: [{ type: "text", text: "run after this turn" }],
      delivery: "steer",
      deliveryState: "applied",
    },
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
