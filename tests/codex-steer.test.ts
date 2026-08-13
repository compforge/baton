// codex sendTurn 的 active-turn 映射（见 docs/harness/codex.md）：baton turnId → codex turn id、
// RPC 接受后先落 pending steer，原生 userMessage 回执再转 applied；stale/finalized/wire 失败
// 一律 rejected 且不发事件（降级由 controller 决定）。
import type { OpenInteraction } from "../src/harness/adapter.ts";
import { expect, test } from "bun:test";

import { CodexAdapter, codexPromptInput } from "../src/harness/codex/adapter.ts";
import type { PromptInput, HarnessSessionHandle } from "../src/harness/adapter.ts";
import type { AnyEventDraft } from "../src/event/index.ts";

const openInteraction: OpenInteraction = async (req) =>
  req.kind === "permission"
    ? { kind: "permission", outcome: "selected", optionId: "decline" }
    : { kind: "question", outcome: "answered", answers: {} };

interface FakeRt {
  threadId: string;
  turnId?: string;
  activeTurn?: { turnId: string; finalized: boolean };
  codexTurnId?: string;
  peer: { request: (method: string, params?: unknown) => Promise<unknown> };
  sink: (ev: AnyEventDraft) => void;
}

function harness(opts: { requestError?: Error } = {}) {
  const adapter = new CodexAdapter({ openInteraction });
  const events: Array<AnyEventDraft & { turnId?: string }> = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const rt: FakeRt = {
    threadId: "th1",
    turnId: "t_A",
    activeTurn: { turnId: "t_A", finalized: false },
    codexTurnId: "codex-turn-1",
    peer: {
      request: async (method, params) => {
        requests.push({ method, params });
        if (opts.requestError) throw opts.requestError;
        return {};
      },
    },
    sink: (ev) => events.push(ev as never),
  };
  // 私有 threads 表注入 seam：绕开真实子进程（同 codex-turn-race.test.ts 的做法）
  (adapter as unknown as { threads: Map<string, FakeRt> }).threads.set("th1", rt);
  const ref: HarnessSessionHandle = { harness: "codex", handleId: "th1" };
  const notify = (method: string, params: unknown) =>
    (adapter as unknown as {
      handleNotification(runtime: FakeRt, method: string, params: unknown): void;
    }).handleNotification(rt, method, params);
  return { adapter, events, requests, rt, ref, notify };
}

const input: PromptInput = {
  turnId: "t_A",
  messageId: "m_steer",
  blocks: [{ type: "text", text: "prefer approach B" }],
};

test("codex steer: stays pending until codex emits the correlated userMessage", async () => {
  const { adapter, events, requests, ref, notify } = harness();

  const receipt = await adapter.sendTurn(ref, input);

  expect(receipt).toEqual({ accepted: true, effective: "steer" });
  expect(requests).toEqual([
    {
      method: "turn/steer",
      params: {
        threadId: "th1",
        expectedTurnId: "codex-turn-1",
        input: [{ type: "text", text: "prefer approach B" }],
        clientUserMessageId: "m_steer",
      },
    },
  ]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "user_message",
    turnId: "t_A",
    payload: {
      messageId: "m_steer",
      delivery: "steer",
      deliveryState: "pending",
    },
  });

  notify("item/completed", {
    threadId: "th1",
    item: {
      type: "userMessage",
      id: "native-user-1",
      clientId: "m_steer",
      content: [{ type: "text", text: "prefer approach B" }],
    },
  });

  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    kind: "user_message",
    turnId: "t_A",
    payload: {
      messageId: "m_steer",
      delivery: "steer",
      deliveryState: "applied",
    },
  });
});

test("codex steer: stale expectedTurnId is rejected without any wire call or event", async () => {
  const { adapter, events, requests, ref } = harness();

  const receipt = await adapter.sendTurn(ref, { ...input, turnId: "t_B" });

  expect(receipt).toEqual({ accepted: false, effective: "rejected" });
  expect(requests).toHaveLength(0);
  expect(events).toHaveLength(0);
});

test("codex sendTurn: a finalized previous turn opens a new turn", async () => {
  const { adapter, events, requests, rt, ref } = harness();
  rt.activeTurn = { turnId: "t_A", finalized: true };

  expect(await adapter.sendTurn(ref, input)).toEqual({ accepted: true, effective: "new_turn" });
  expect(requests[0]?.method).toBe("turn/start");
  expect(events).toHaveLength(0);
});

test("codex steer: missing codex turn id (turn/start response not yet arrived) is rejected", async () => {
  const { adapter, events, requests, rt, ref } = harness();
  rt.codexTurnId = undefined;

  expect(await adapter.sendTurn(ref, input)).toEqual({ accepted: false, effective: "rejected" });
  expect(requests).toHaveLength(0);
  expect(events).toHaveLength(0);
});

test("codex steer: wire rejection (stale turn on codex side) maps to rejected, no event", async () => {
  const { adapter, events, ref } = harness({ requestError: new Error("turn already completed") });

  expect(await adapter.sendTurn(ref, input)).toEqual({
    accepted: false,
    effective: "rejected",
    reason: "turn already completed",
  });
  expect(events).toHaveLength(0);
});

test("codex steer: unsupported prompt blocks fail admission before the wire", async () => {
  const { adapter, requests, ref } = harness();

  expect(
    adapter.sendTurn(
      ref,
      { ...input, blocks: [{ type: "audio", mimeType: "audio/wav", data: "aGk=" }] },
    ),
  ).rejects.toThrow(/audio/);
  expect(requests).toHaveLength(0);
});

test("codex prompt images use native localImage or data URL inputs", () => {
  expect(codexPromptInput([
    { type: "text", text: "inspect" },
    { type: "image", mimeType: "image/png", path: "/tmp/screenshot.png" },
    { type: "image", mimeType: "image/webp", data: "aGk=" },
  ])).toEqual([
    { type: "text", text: "inspect" },
    { type: "localImage", path: "/tmp/screenshot.png" },
    { type: "image", url: "data:image/webp;base64,aGk=" },
  ]);
});
