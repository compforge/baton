import { requestMessage, responseMessage } from "./fixtures/messages.ts";
import { describe, expect, test } from "bun:test";
import { ENVELOPE_VERSION, type AnyEventEnvelope, type EventEnvelope, type EventKind, type EventPayloadMap, type EventSource } from "../src/event/index.ts";
import { HarnessInteractionContinuations } from "../src/interaction/harness.ts";
import type { InteractionAnswer, InteractionDraft } from "../src/interaction/types.ts";
import { validInputResult } from "../src/interaction/answer.ts";
import { getMessage } from "../src/message/query.ts";
import { applyEvent, emptySessionState, reduceEvents } from "../src/store/reduce.ts";
import { buildTranscript } from "../src/view/chat-tui/protocol/transcript.ts";

const permission: InteractionDraft = {
  kind: "permission", title: "Run checks?",
  options: [{ optionId: "allow", name: "Allow once", polarity: "allow", lifetime: "once" }],
};
const approval: InteractionAnswer = { kind: "permission", outcome: "selected", optionId: "allow" };

function fixture() {
  const state = emptySessionState();
  const events: AnyEventEnvelope[] = [];
  function append<K extends EventKind>(kind: K, payload: EventPayloadMap[K], source: EventSource = { type: "user" }, turnId?: string) {
    const seq = events.length + 1;
    const event: EventEnvelope<K> = {
      v: ENVELOPE_VERSION, kind, payload, source, turnId, seq, eventId: `ev_${seq}`,
      ts: new Date(seq).toISOString(), scope: { type: "session", batonSessionId: "s" },
      harnessTargetId: "target", laneId: "main",
    };
    events.push(event as AnyEventEnvelope);
    applyEvent(state, event as AnyEventEnvelope);
    return event;
  }
  function request(id = "request", draft = permission) {
    return append("interaction.requested", requestMessage(id, { ...draft }, { kind: "harness", key: "target" }), { type: "baton" });
  }
  return { state, events, append, request };
}

describe("Message interaction projection", () => {
  test("queued Input plus chunk echo binds execution without duplicating the original body", () => {
    const f = fixture();
    const content = [{ type: "text" as const, text: "hello" }];
    f.append("harness_input.updated", {
      messageId: "input", turnId: "reserved", harnessTargetId: "target", laneId: "main",
      status: "queued", delivery: "prompt", source: { type: "user" }, blocks: content,
    });
    const createdAt = getMessage(f.state, "input")?.createdAt;
    f.append("user_message_chunk", { messageId: "input", content: content[0]! },
      { type: "harness", harnessTargetId: "target" }, "actual");
    expect(getMessage(f.state, "input")).toMatchObject({ content, createdAt, turnId: "actual" });
    expect(f.state.timeline).toEqual([{ type: "message", id: "input" }]);
    expect(buildTranscript(f.state)).toHaveLength(1);
    expect(reduceEvents(f.events)).toEqual(f.state);
  });

  test("Queue lifecycle snapshots and transport echoes cannot overwrite Message content", () => {
    const f = fixture();
    const input = {
      messageId: "input", turnId: "turn", harnessTargetId: "target", laneId: "main",
      delivery: "prompt" as const, source: { type: "user" as const },
      blocks: [{ type: "text" as const, text: "original" }],
    };
    f.append("harness_input.updated", { ...input, status: "queued" });
    const content = [{ type: "text" as const, text: "explicit content update" }];
    f.append("user_message", { messageId: "input", content }, { type: "user" }, "turn");
    f.append("user_message", { messageId: "input", content: [{ type: "text", text: "transport-only Context" }] },
      { type: "harness", harnessTargetId: "target" }, "turn");
    f.append("harness_input.updated", { ...input, status: "finalized" });
    expect(getMessage(f.state, "input")).toMatchObject({ content, source: { kind: "user", key: "local" } });
    expect(f.state.harnessInputs.get("input")).toMatchObject({ status: "finalized", blocks: input.blocks });
    expect(reduceEvents(f.events)).toEqual(f.state);
  });

  test("a pending steer echo stays outside history until its consumption receipt", () => {
    const f = fixture();
    f.append("harness_input.updated", {
      messageId: "input", turnId: "reserved", harnessTargetId: "target", laneId: "main",
      status: "steering", delivery: "steer", source: { type: "user" },
      blocks: [{ type: "text", text: "next" }],
    });
    f.append("user_message_chunk", { messageId: "input", content: { type: "text", text: "next" } },
      { type: "harness", harnessTargetId: "target" }, "reserved");
    f.append("user_message", { messageId: "input", content: [{ type: "text", text: "next" }] },
      { type: "harness", harnessTargetId: "target" }, "reserved");
    expect(f.state.timeline).toEqual([]);
    expect(getMessage(f.state, "input")?.turnId).toBeUndefined();
    f.append("input_delivery_update", { messageId: "input", state: "applied" },
      { type: "harness", harnessTargetId: "target" }, "actual");
    expect(getMessage(f.state, "input")).toMatchObject({ turnId: "actual", content: [{ type: "text", text: "next" }] });
    expect(f.state.timeline).toEqual([{ type: "message", id: "input" }]);
    expect(reduceEvents(f.events)).toEqual(f.state);
  });

  test("Input exists in Queue before execution; authorship is not the receipt reporter", () => {
    const f = fixture();
    f.append("harness_input.updated", {
      messageId: "input", turnId: "reserved", harnessTargetId: "target", laneId: "main",
      status: "queued", delivery: "prompt", source: { type: "plugin", pluginInstanceId: "helper" },
      blocks: [{ type: "text", text: "Check this" }],
    });
    expect(getMessage(f.state, "input")).toMatchObject({
      kind: "input", source: { kind: "plugin", key: "helper" },
      target: { kind: "harness", key: "target" }, content: [{ type: "text", text: "Check this" }],
    });
    expect(getMessage(f.state, "input")?.turnId).toBeUndefined();
    expect(buildTranscript(f.state)).toEqual([]);
    const createdAt = getMessage(f.state, "input")?.createdAt;
    f.append("user_message", { messageId: "input" }, { type: "harness", harnessTargetId: "target" }, "actual");
    expect(getMessage(f.state, "input")).toMatchObject({ createdAt, turnId: "actual", source: { kind: "plugin", key: "helper" } });
    f.append("agent_message", { messageId: "output", content: [{ type: "text", text: "Done" }], replyToMessageIds: ["input"] }, { type: "harness", harnessTargetId: "target" }, "actual");
    expect(getMessage(f.state, "output")).toMatchObject({ kind: "output", source: { kind: "harness", key: "target" } });
    expect(reduceEvents(f.events)).toEqual(f.state);
  });

  test("request and response have independent identities; replay does not rewrite facts", () => {
    const f = fixture();
    f.request();
    expect(getMessage(f.state, "request")).toMatchObject({
      kind: "input_request", status: "pending", source: { kind: "harness", key: "target" },
      target: { kind: "user", key: "local" }, request: permission,
    });
    expect(buildTranscript(f.state)).toEqual([]);
    f.append("interaction.answered", responseMessage("request", approval, { kind: "harness", key: "target" }, { messageId: "response" }));
    const recorded = JSON.stringify(f.events);
    const response = getMessage(f.state, "response");
    expect(response).toMatchObject({
      kind: "input_response", replyToMessageIds: ["request"], answer: approval,
      source: { kind: "user", key: "local" }, target: { kind: "harness", key: "target" },
    });
    expect(getMessage(f.state, "request")).toMatchObject({ status: "answered" });
    expect(f.state.timeline.map((item) => item.id)).toEqual(["request", "response"]);
    expect(buildTranscript(f.state)).toHaveLength(2);
    expect(reduceEvents(f.events)).toEqual(f.state);
    expect(JSON.stringify(f.events)).toBe(recorded);
    expect(f.state.harnessInputs.size).toBe(0);
  });

  test("response identity and actors come from the Message, independent of replay sequence and reporter", () => {
    const f = fixture();
    f.request("request");
    f.append("interaction.answered", responseMessage("request", approval, { kind: "harness", key: "target" }, { messageId: "response" }), { type: "baton" });
    const replay = reduceEvents(f.events.map((event) => ({ ...event, seq: event.seq + 10 })));
    expect(getMessage(replay, "response")).toEqual(getMessage(f.state, "response"));
    expect(getMessage(replay, "response")).toMatchObject({ messageId: "response", source: { kind: "user", key: "local" } });
  });

  test("a terminal request cannot be revived; cancellation never fabricates an answer", () => {
    const f = fixture();
    f.request();
    f.append("interaction.cancelled", { messageId: "request", reason: "timeout" }, { type: "baton" });
    f.append("interaction.answered", responseMessage("request", approval, { kind: "harness", key: "target" }, { messageId: "late" }));
    f.request();
    expect(getMessage(f.state, "request")).toMatchObject({ status: "cancelled", cancellation: { reason: "timeout" } });
    expect(f.state.inputResponses.size).toBe(0);
    expect(f.state.timeline.map((item) => item.id)).toEqual(["request"]);
    expect(buildTranscript(f.state)).toHaveLength(1);
  });

  test("only a valid, authorized typed answer settles a request", () => {
    const f = fixture();
    f.request();
    f.append("user_message", { messageId: "ordinary", content: [{ type: "text", text: "allow" }], replyToMessageIds: ["request"] });
    f.append("interaction.answered", responseMessage("missing", approval, { kind: "harness", key: "target" }, { messageId: "missing-answer" }));
    f.append("interaction.answered", responseMessage("request", { ...approval, optionId: "unoffered" }, { kind: "harness", key: "target" }, { messageId: "invalid" }));
    f.append("interaction.answered", responseMessage("request", approval, { kind: "harness", key: "target" }, { messageId: "spoofed", source: { kind: "plugin", key: "other" } }), { type: "plugin", pluginInstanceId: "other" });
    f.append("interaction.answered", responseMessage("request", approval, { kind: "harness", key: "target" }, { messageId: "ordinary" }));
    f.append("interaction.answered", responseMessage("request", approval, { kind: "harness", key: "wrong-target" }, { messageId: "misdirected" }));
    expect(getMessage(f.state, "request")).toMatchObject({ status: "pending" });
    expect(f.state.inputResponses.size).toBe(0);
    f.append("interaction.answered", responseMessage("request", approval, { kind: "harness", key: "target" }, { messageId: "policy", source: { kind: "baton", key: "local" } }), { type: "baton" });
    f.append("interaction.answered", responseMessage("request", approval, { kind: "harness", key: "target" }, { messageId: "duplicate" }));
    expect(getMessage(f.state, "policy")?.source).toEqual({ kind: "baton", key: "local" });
    expect(f.state.inputResponses.size).toBe(1);
  });

  test("reply references resolve all Message variants without duplicating bodies", () => {
    const f = fixture();
    f.request();
    f.append("interaction.answered", responseMessage("request", approval, { kind: "harness", key: "target" }, { messageId: "response" }));
    f.append("agent_message", { messageId: "output", content: [{ type: "text", text: "Proceeding" }], replyToMessageIds: ["request", "response", "response"] });
    expect(getMessage(f.state, "output")?.replyToMessageIds).toEqual(["request", "response"]);
    expect(buildTranscript(f.state).filter((item) => item.id === "output")).toHaveLength(1);
    expect(JSON.stringify(buildTranscript(f.state))).toContain("Allow once");
  });

  test("secret answers never appear in history or reply previews", () => {
    const f = fixture();
    f.request("secret", { kind: "question", questions: [{ questionId: "token", header: "Secret", question: "Token?", secret: true }] });
    f.append("interaction.answered", responseMessage("secret", { kind: "question", outcome: "answered", answers: { token: ["test-secret-value"] } }, { kind: "harness", key: "target" }, { messageId: "answer" }));
    f.append("agent_message", { messageId: "output", replyToMessageIds: ["answer"] });
    const rendered = JSON.stringify(buildTranscript(f.state));
    expect(rendered).toContain("[hidden answer]");
    expect(rendered).not.toContain("test-secret-value");
  });

  test("one identity cannot change Message kind", () => {
    const f = fixture();
    f.request();
    f.append("user_message", { messageId: "request", content: [{ type: "text", text: "overwrite" }] });
    f.append("input_delivery_update", { messageId: "request", state: "applied" });
    expect(getMessage(f.state, "request")?.kind).toBe("input_request");
    expect(f.state.messages.size).toBe(0);
  });
});

test("Harness continuation rejects invalid input and resumes exactly once after persistence", async () => {
  const f = fixture();
  const continuations = new HarnessInteractionContinuations<{ target: { id: string }; laneId: string }>((_binding, event, source) => {
    f.append(event.kind, event.payload, source, event.turnId);
  }, () => {}, () => f.state);
  const pending = continuations.open({ target: { id: "target" }, laneId: "main" }, permission, "turn");
  const request = [...f.state.interactions.values()][0]!.request;
  expect(request.messageId).toStartWith("m_");
  expect(continuations.complete(request.messageId, { ...approval, optionId: "unoffered" })).toBe(false);
  expect(f.events).toHaveLength(1);
  expect(continuations.complete(request.messageId, approval)).toBe(true);
  expect(f.state.inputResponses.size).toBe(1);
  expect(continuations.complete(request.messageId, approval)).toBe(false);
  expect(await pending).toEqual(approval);
  expect(f.events).toHaveLength(2);
});

test("Harness continuation observes committed cancellation without inventing a response", async () => {
  const f = fixture();
  const continuations = new HarnessInteractionContinuations<{ target: { id: string }; laneId: string }>((_binding, event, source) => {
    f.append(event.kind, event.payload, source, event.turnId);
  }, () => {}, () => f.state);
  const pending = continuations.open({ target: { id: "target" }, laneId: "main" }, permission, "turn");
  const messageId = [...f.state.interactions.keys()][0]!;
  f.append("interaction.cancelled", { messageId: messageId, reason: "recovery" }, { type: "baton" });
  continuations.observe();
  expect(await pending).toEqual({ kind: "cancelled", reason: "recovery" });
  expect(continuations.complete(messageId, approval)).toBe(false);
  expect(f.state.inputResponses.size).toBe(0);
  expect(f.events).toHaveLength(2);
});

test("question answers honor declared identity, cardinality and choices", () => {
  const request: InteractionDraft = { kind: "question", questions: [{
    questionId: "q", header: "Choice", question: "Which?", choices: [{ value: "one", label: "First" }],
  }] };
  const answer = (answers: Record<string, string[]>): InteractionAnswer => ({ kind: "question", outcome: "answered", answers });
  expect(validInputResult(request, answer({ q: ["one"] }))).toBe(true);
  const invalid: Record<string, string[]>[] = [{}, { q: [] }, { other: ["one"] }, { q: ["unknown"] }, { q: ["one", "one"] }];
  for (const answers of invalid) {
    expect(validInputResult(request, answer(answers))).toBe(false);
  }
});
