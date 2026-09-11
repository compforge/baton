import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { DshAdapter } from "../src/harness/dsh/adapter.ts";
import type { AnyEventDraft } from "../src/event/index.ts";
import { Controller } from "../src/controller/index.ts";
import { SessionStore } from "../src/store/store.ts";

const dshBin = fileURLToPath(new URL("./fixtures/dsh-queue-runtime.mjs", import.meta.url));
const blocks = (text: string) => [{ type: "text" as const, text }];
const input = (turnId: string, messageId: string, text: string) => ({ turnId, messageId, blocks: blocks(text) });
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i++) await Bun.sleep(2);
  expect(predicate()).toBe(true);
}

test("DSH native steer correlates receipts before RPC acknowledgements and waits for every pending input", async () => {
  const events: AnyEventDraft[] = [];
  const adapter = new DshAdapter({ dshBin });
  const ref = await adapter.open({ cwd: tmpdir() }, (event) => events.push(event));
  try {
    await adapter.sendTurn(ref, input("t", "m1", "hold"));
    expect(await adapter.sendTurn(ref, input("t", "m2", "receipt-before-ack"))).toEqual({ accepted: true, effective: "steer" });
    await until(() => events.some((event) => event.kind === "state_update"));
    expect(events.filter((event) => event.kind === "input_delivery_update").map((e) => e.payload)).toEqual([{ messageId: "m2", state: "applied" }]);
    expect(events.filter((event) => event.kind === "agent_message")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "state_update")).toHaveLength(1);
  } finally { await adapter.close(ref); }
});

test("DSH steer emits the delivery-marked user message so applied steers reach the transcript", async () => {
  const events: AnyEventDraft[] = [];
  const adapter = new DshAdapter({ dshBin });
  const ref = await adapter.open({ cwd: tmpdir() }, (event) => events.push(event));
  try {
    await adapter.sendTurn(ref, input("t", "m1", "hold"));
    await adapter.sendTurn(ref, input("t", "m2", "steer-body"));
    await until(() => events.some((event) => event.kind === "state_update"));
    // Core only writes user_message when it dequeues a new Turn; same-turn steers
    // must carry it from the Adapter, otherwise an applied steer leaves Queue
    // without ever entering the Transcript.
    expect(events.filter((event) => event.kind === "user_message").map((event) => event.payload)).toEqual([
      { messageId: "m2", content: blocks("steer-body"), delivery: "steer" },
    ]);
    expect(events.filter((event) => event.kind === "input_delivery_update").map((e) => e.payload)).toEqual([
      { messageId: "m2", state: "applied" },
    ]);
  } finally { await adapter.close(ref); }
});

test("DSH cancellation waits for runtime exit and leaves unapplied native input uncertain", async () => {
  const events: AnyEventDraft[] = [];
  const adapter = new DshAdapter({ dshBin });
  const ref = await adapter.open({ cwd: tmpdir() }, (event) => events.push(event));
  try {
    await adapter.sendTurn(ref, input("t", "m1", "hold"));
    await adapter.sendTurn(ref, input("t", "m2", "pending"));
    const cancelled = adapter.cancel(ref);
    await Bun.sleep(60);
    expect(events.filter((e) => e.kind === "state_update")).toHaveLength(0);
    expect(await adapter.sendTurn(ref, input("t", "m3", "late"))).toMatchObject({ accepted: false });
    await cancelled;
    expect(events.filter((e) => e.kind === "state_update")).toHaveLength(1);
    expect(events.find((e) => e.kind === "input_delivery_update")?.payload).toMatchObject({ messageId: "m2", state: "uncertain" });
    await adapter.sendTurn(ref, input("t2", "m4", "continued"));
    await until(() => events.filter((e) => e.kind === "state_update").length === 2);
    expect(events.filter((e) => e.kind === "state_update").map((e) => e.harnessSessionId)[0]).toBe(events.at(-1)?.harnessSessionId);
  } finally { await adapter.close(ref); }
});

test("DSH transport loss reaps the old client and resumes the same session for the next input", async () => {
  const events: AnyEventDraft[] = [];
  let clients = 0;
  const adapter = new DshAdapter({ dshBin, clientFactory: (options) => { clients++; return new DeepSeekHarness(options); } });
  const ref = await adapter.open({ cwd: tmpdir() }, (event) => events.push(event));
  try {
    await adapter.sendTurn(ref, input("t", "m1", "crash"));
    await until(() => events.some((e) => e.kind === "state_update"));
    await adapter.sendTurn(ref, input("t2", "m2", "recovered"));
    await until(() => events.filter((e) => e.kind === "state_update").length === 2);
    expect(clients).toBe(2);
    expect(events.filter((e) => e.kind === "state_update").map((e) => e.payload)).toEqual([
      { state: "idle", stopReason: "error" }, { state: "idle", stopReason: "end_turn" },
    ]);
  } finally { await adapter.close(ref); }
});

test("Baton queue dispatch-now uses DSH steer; cancellation preserves queued work without replaying uncertain native input", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-dsh-queue-"));
  const session = new SessionStore(root).createSession({ cwd: root });
  const target = { id: "dsh", harness: "deepseek-harness" };
  let ready = false;
  const options = { session, mentionBudgetChars: 4096, cancelGraceMs: 20, resolveTarget: (id: string) => id === "dsh" ? target : undefined,
    createAdapter: () => new DshAdapter({ dshBin, nativeEvent: (event) => { if (event.name === "session.status") ready = true; } }) };
  const controller = new Controller(options);
  try {
    const first = controller.submit("dsh", blocks("hold"));
    await until(() => ready);
    const second = controller.submit("dsh", blocks("continued"));
    const third = controller.submit("dsh", blocks("pending"));
    await until(() => controller.listQueued().length === 2);
    const thirdId = controller.listQueued()[1]!.messageId;
    expect(await controller.dispatchQueuedNow(thirdId)).toEqual({ effective: "steer" });
    expect(controller.listQueued()).toHaveLength(1);
    await controller.control({ kind: "interrupt" });
    await first;
    await third;
    expect(await second).toBe("completed");
    expect([...session.loadState().messages.values()].some((message) => message.role === "agent" && message.content.some((block) => block.type === "text" && block.text === "continued"))).toBe(true);
    expect(session.loadState().harnessInputs.get(thirdId)?.deliveryOutcome).toBe("uncertain");
    await controller.close();
    const restored = new Controller(options);
    expect(restored.listQueued()).toHaveLength(0);
    await restored.close();
  } finally { await controller.close(); await rm(root, { recursive: true, force: true }); }
});

test("DSH explicit prompt rejection settles only that steer and keeps the current turn usable", async () => {
  const events: AnyEventDraft[] = [];
  const adapter = new DshAdapter({ dshBin });
  const ref = await adapter.open({ cwd: tmpdir() }, (event) => events.push(event));
  try {
    await adapter.sendTurn(ref, input("t", "m1", "hold"));
    await adapter.sendTurn(ref, input("t", "m2", "reject"));
    await until(() => events.some((e) => e.kind === "input_delivery_update"));
    expect(events.find((e) => e.kind === "input_delivery_update")?.payload).toMatchObject({ messageId: "m2", state: "failed" });
    expect(events.filter((e) => e.kind === "state_update")).toHaveLength(0);
    await adapter.sendTurn(ref, input("t", "m3", "finish"));
    await until(() => events.some((e) => e.kind === "state_update"));
    expect(events.filter((e) => e.kind === "input_delivery_update").at(-1)?.payload).toEqual({ messageId: "m3", state: "applied" });
  } finally { await adapter.close(ref); }
});

test("DSH failed cleanup blocks replacement clients instead of reporting a successful cancellation", async () => {
  const events: AnyEventDraft[] = [];
  let clients = 0;
  const adapter = new DshAdapter({ dshBin, clientFactory: (options) => {
    clients++;
    const harness = new DeepSeekHarness(options);
    return {
      get client() { return harness.client; },
      start: () => harness.start(), session: (id) => harness.session(id),
      close: async () => { await harness.close(); throw new Error("exit unproved"); },
    };
  } });
  const ref = await adapter.open({ cwd: tmpdir() }, (event) => events.push(event));
  await adapter.sendTurn(ref, input("t", "m1", "hold"));
  await expect(adapter.cancel(ref)).rejects.toThrow("exit unproved");
  expect(events.filter((e) => e.kind === "state_update").map((e) => e.payload)).toEqual([{ state: "idle", stopReason: "error" }]);
  await expect(adapter.sendTurn(ref, input("t2", "m2", "retry"))).rejects.toThrow("exit unproved");
  expect(clients).toBe(1);
  await expect(adapter.close(ref)).rejects.toThrow("exit unproved");
});

test("queue recovery does not resend consumed or uncertain steer inputs after a crash before turn finalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-dsh-recovery-"));
  const session = new SessionStore(root).createSession({ cwd: root });
  for (const outcome of ["applied", "uncertain"] as const) {
    for (const status of ["queued", "steering"] as const) session.appendEvent({
      kind: "harness_input.updated", source: { type: "user" }, harness: "deepseek-harness", harnessTargetId: "dsh", laneId: "main", turnId: "t",
      payload: { messageId: outcome, turnId: "t", harnessTargetId: "dsh", laneId: "main", blocks: blocks(outcome),
        source: { type: "user" }, status, delivery: status === "queued" ? "prompt" : "steer" },
    });
    session.appendEvent({ kind: "input_delivery_update", source: { type: "harness", harnessTargetId: "dsh" }, harness: "deepseek-harness",
      harnessTargetId: "dsh", laneId: "main", turnId: "t", payload: { messageId: outcome, state: outcome } });
  }
  let created = 0;
  const controller = new Controller({ session, mentionBudgetChars: 4096,
    resolveTarget: (id) => id === "dsh" ? { id, harness: "deepseek-harness" } : undefined,
    createAdapter: () => { created++; return new DshAdapter({ dshBin }); },
  });
  try {
    expect(controller.listQueued()).toHaveLength(0);
    await Bun.sleep(10);
    expect(created).toBe(0);
  } finally { await controller.close(); await rm(root, { recursive: true, force: true }); }
});
