import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let sessionId;
let serial = 0;
let busy = false;
const event = (type, data) => send({ method: "session.event", params: { sessionId, event: { type, data } } });
const status = (state) => send({ method: "session.status", params: { sessionId, status: state } });
for await (const line of lines) {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { serverInfo: { name: "dsh-queue-test", version: "1" } } });
  if (method === "session/prompt") {
    sessionId = params.sessionId;
    const text = params.contentBlocks.filter((b) => b.type === "text").at(-1)?.text;
    if (text === "crash") process.exit(1);
    if (text === "reject") { send({ id, error: { code: -32602, message: "prompt rejected" } }); continue; }
    const messageId = `native-${++serial}`;
    const reply = () => send({ id, result: { messageId } });
    if (text !== "receipt-before-ack") reply();
    if (text === "pending") continue;
    const target = busy ? "next-step" : "next-turn";
    event("agent/inbox/spliced", { target, start: 0, inserted: [{ id: messageId }] });
    if (text === "queued-steer") continue;
    event("agent/inbox/spliced", { target, start: 0, removedCount: 1, inserted: [] });
    if (text === "claim-without-apply") {
      event("turn/end", { reason: { kind: "blocked" } });
      busy = false;
      status("idle");
      continue;
    }
    event("user/message", { content: params.contentBlocks, source: { kind: "user" } });
    if (text === "hold") { busy = true; status("busy"); continue; }
    event("assistant/message", { turn: serial, step: 1, message: { content: [{ type: "text", text: text ?? "done" }] } });
    event("turn/end", { reason: { kind: "completed" } });
    busy = false;
    status("idle");
    if (text === "receipt-before-ack") setTimeout(reply, 50);
  }
  if (method === "shutdown") {
    // A run may finish before the process has exited. Hold the process alive after EOF.
    status("idle");
    send({ id, result: {} });
    setTimeout(() => process.exit(0), 150);
  }
}
