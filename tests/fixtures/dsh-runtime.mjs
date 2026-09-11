import { createInterface } from "node:readline";

// Exercise the published SDK's framing and receipt-to-idle collection without a model call.
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
for await (const line of lines) {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") {
    send({ id, result: { serverInfo: { name: "baton-test", version: "1" } } });
  } else if (method === "session/prompt") {
    const sessionId = params.sessionId;
    send({ id, result: { messageId: "input-1", accepted: true } });
    const event = (type, data) => send({ method: "session.event", params: { sessionId, event: { type, data } } });
    // Idle before this input's durable receipt must not finish the run.
    send({ method: "session.status", params: { sessionId, status: "idle" } });
    event("agent/inbox/spliced", { target: "next-turn", start: 0, removedCount: 0, inserted: [{ id: "input-1" }] });
    event("agent/inbox/spliced", { target: "next-turn", start: 0, removedCount: 1, inserted: [] });
    event("user/message", { content: params.contentBlocks, source: { kind: "user" } });
    event("assistant/message", { turn: 1, step: 1, message: { id: "reply-1", content: [{ type: "text", text: JSON.stringify(params.contentBlocks) }] } });
    event("turn/end", { turn: 1, reason: { kind: "completed" } });
    send({ method: "session.status", params: { sessionId, status: "idle" } });
  } else if (method === "shutdown") {
    send({ id, result: {} });
    lines.close();
    break;
  }
}
