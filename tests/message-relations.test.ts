import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENVELOPE_VERSION, type AnyEventEnvelope, type EventEnvelope, type EventKind, type EventPayloadMap } from "../src/event/index.ts";
import { MessageReplies } from "../src/harness/message-replies.ts";
import { applyEvent, emptySessionState, reduceEvents } from "../src/store/reduce.ts";
import { buildTranscript } from "../src/view/chat-tui/protocol/transcript.ts";
import { SessionStore } from "../src/store/store.ts";
import { buildTargetCatchUpContext } from "../src/context/mention.ts";

function fixture() {
  let seq = 0;
  const state = emptySessionState();
  const events: AnyEventEnvelope[] = [];
  const append = <K extends EventKind>(kind: K, payload: EventPayloadMap[K], turnId = "t1") => {
    const event: EventEnvelope<K> = {
      v: ENVELOPE_VERSION, kind, payload, turnId, seq: ++seq, eventId: `e${seq}`,
      ts: new Date(seq).toISOString(), scope: { type: "session", batonSessionId: "s" },
      source: { type: "harness", harnessTargetId: "test" }, harness: "test", harnessTargetId: "test", laneId: "main",
    };
    events.push(event as AnyEventEnvelope);
    applyEvent(state, event as AnyEventEnvelope);
  };
  const user = (messageId: string, turnId = "t1") => append("user_message", {
    messageId, content: [{ type: "text", text: messageId }],
  }, turnId);
  const queue = (messageId: string) => append("harness_input.updated", {
    messageId, turnId: "reserved", harnessTargetId: "test", laneId: "main", status: "steering",
    delivery: "steer", blocks: [{ type: "text", text: messageId }], source: { type: "user" },
  });
  const steer = (messageId: string) => {
    queue(messageId);
    append("user_message", { messageId, content: [{ type: "text", text: messageId }], delivery: "steer" });
  };
  const answer = (messageId: string, replyToMessageIds?: readonly string[], turnId = "t1") => append("agent_message", {
    messageId, content: [{ type: "text", text: messageId }], replyToMessageIds,
  }, turnId);
  const ids = () => buildTranscript(state).filter((item) => item.type === "message").map((item) => item.id);
  return { state, events, append, user, queue, steer, answer, ids };
}

describe("message replies and consumption", () => {
  test("queued input gets its slot and actual Turn only when applied; replay agrees", () => {
    const f = fixture();
    f.user("你好");
    f.steer("吃饭了吗");
    expect(f.state.timeline.map((item) => item.id)).toEqual(["你好"]);
    expect(f.state.messages.get("吃饭了吗")?.turnId).toBeUndefined();
    f.answer("你好！", ["你好"]);
    f.append("input_delivery_update", { messageId: "吃饭了吗", state: "applied" }, "t2");
    f.answer("还没", ["吃饭了吗"], "t2");
    expect(f.ids()).toEqual(["你好", "你好！", "吃饭了吗", "还没"]);
    expect(f.state.messages.get("吃饭了吗")?.turnId).toBe("t2");
    f.append("input_delivery_update", { messageId: "吃饭了吗", state: "applied" }, "t1");
    f.append("input_delivery_update", { messageId: "吃饭了吗", state: "failed" }, "t1");
    expect(f.ids()).toEqual(["你好", "你好！", "吃饭了吗", "还没"]);
    expect(f.state.messages.get("吃饭了吗")?.turnId).toBe("t2");
    expect(f.state.harnessInputs.get("吃饭了吗")?.deliveryOutcome).toBe("applied");
    expect(buildTranscript(reduceEvents(f.events))).toEqual(buildTranscript(f.state));
  });

  test("same-Turn steer keeps earlier output before the input", () => {
    const f = fixture();
    f.user("u1"); f.steer("u2"); f.answer("a1", ["u1"]);
    f.append("input_delivery_update", { messageId: "u2", state: "applied" });
    f.answer("a2", ["u1", "u2"]);
    expect(f.ids()).toEqual(["u1", "a1", "u2", "a2"]);
    expect(f.state.messages.get("a2")?.replyToMessageIds).toEqual(["u1", "u2"]);
  });

  test("late receipt uses a proven output anchor instead of arrival time", () => {
    const f = fixture();
    f.user("u1"); f.steer("u2"); f.answer("a1", ["u1"]);
    f.answer("a2", ["u2"], "t2");
    f.append("input_delivery_update", { messageId: "u2", state: "applied", beforeMessageId: "a2" }, "t2");
    expect(f.ids()).toEqual(["u1", "a1", "u2", "a2"]);
  });

  test("receipt before body and admission preserves consumption", () => {
    const f = fixture();
    f.append("input_delivery_update", { messageId: "u", state: "applied" }, "t2");
    f.queue("u");
    f.append("user_message", { messageId: "u", content: [{ type: "text", text: "body" }], delivery: "steer" });
    expect(f.ids()).toEqual(["u"]);
    expect(f.state.messages.get("u")?.turnId).toBe("t2");
    expect(f.state.harnessInputs.get("u")?.deliveryOutcome).toBe("applied");
  });

  test("cancelled steer requeues once without moving on duplicate body upserts", () => {
    const f = fixture();
    f.user("u1"); f.steer("u2");
    f.append("input_delivery_update", { messageId: "u2", state: "failed" });
    f.answer("a1");
    const payload = { messageId: "u2", content: [{ type: "text" as const, text: "u2" }], delivery: "follow_up" };
    f.append("user_message", payload, "t2"); f.answer("a2", ["u2"], "t2");
    f.append("user_message", payload, "t2");
    expect(f.ids()).toEqual(["u1", "a1", "u2", "a2"]);
  });

  test("zero, one and multiple replies preserve patch semantics without duplicating or sorting messages", () => {
    const f = fixture();
    f.user("u1"); f.user("u2");
    f.answer("unknown"); f.answer("notice", []); f.answer("single", ["u1"]);
    f.answer("combined", ["u2", "u1", "u2"]);
    f.append("agent_message", { messageId: "combined" });
    expect(f.state.messages.get("unknown")?.replyToMessageIds).toBeUndefined();
    expect(f.state.messages.get("notice")?.replyToMessageIds).toEqual([]);
    expect(f.state.messages.get("combined")?.replyToMessageIds).toEqual(["u2", "u1"]);
    expect(f.ids()).toEqual(["u1", "u2", "unknown", "notice", "single", "combined"]);
    f.append("agent_message", { messageId: "single", replyToMessageIds: [] });
    expect(f.state.messages.get("single")?.replyToMessageIds).toEqual([]);
    f.answer("invalid", ["u1", "foreign"]);
    expect(f.state.messages.get("invalid")?.replyToMessageIds).toBeUndefined();
  });
});

test("adapter attribution snapshots each streaming message and only explicit correlation can refine it", () => {
  const replies = new MessageReplies(["u1"]);
  const chunk = (messageId: string) => ({ kind: "agent_message_chunk" as const, payload: { messageId, content: { type: "text" as const, text: "x" } } });
  expect(replies.apply(chunk("a1")).payload).toMatchObject({ replyToMessageIds: ["u1"] });
  replies.current = undefined;
  expect(replies.apply(chunk("a1")).payload).toMatchObject({ replyToMessageIds: ["u1"] });
  expect(replies.apply(chunk("a2")).payload).not.toHaveProperty("replyToMessageIds");
  expect(replies.apply(chunk("a2"), ["u1", "u2"]).payload).toMatchObject({ replyToMessageIds: ["u1", "u2"] });
});

for (const late of [false, true]) {
  test(`cross-Turn consumption reaches summaries and Context, after-summary=${late}`, () => {
    const root = mkdtempSync(join(tmpdir(), "baton-replies-"));
    try {
      const h = new SessionStore(root).createSession({ cwd: "/repo" });
      const f = fixture();
      f.user("first"); f.steer("later"); f.answer("first-answer", ["first"]);
      for (const event of f.events) {
        const { v, seq, eventId, ts, scope, ...draft } = event;
        h.appendEvent(draft);
      }
      h.summarizeTurn("t1");
      const coordinates = { source: { type: "harness" as const, harnessTargetId: "test" }, harness: "test", harnessTargetId: "test", laneId: "main", turnId: "t2" };
      h.appendEvent({ ...coordinates, kind: "agent_message", payload: {
        messageId: "second-answer", content: [{ type: "text", text: "second answer" }], replyToMessageIds: ["later"],
      } });
      const before = late ? h.summarizeTurnEvent("t2").seq : 0;
      h.appendEvent({ ...coordinates, kind: "input_delivery_update", payload: {
        messageId: "later", state: "applied", beforeMessageId: "second-answer",
      } });
      if (!late) h.summarizeTurn("t2");
      expect(h.loadState().turnSummaries.find((summary) => summary.turnId === "t1")?.userText).toBe("first");
      expect(h.loadState().turnSummaries.find((summary) => summary.turnId === "t2")?.userText).toBe("later");
      expect(reduceEvents(h.ledger.read()).turnSummaries).toEqual(h.loadState().turnSummaries);
      const context = buildTargetCatchUpContext(h, {
        target: { id: "other", harness: "test" }, laneId: "main", sinceSeq: before, includeTargetTurns: true,
      });
      expect(context?.text).toContain("later");
      expect(context?.throughSeq).toBeGreaterThan(before);
      if (late) {
        const historical = h.ledger.read().find((event) => event.kind === "_baton_turn_summary" && event.turnId === "t2");
        expect(historical?.payload).not.toHaveProperty("userText");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
