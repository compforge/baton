import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  HarnessDelivery,
  HarnessEventDraft,
  HarnessEventRecord,
} from "@compforge/baton-plugin";

import {
  Controller,
  type HarnessHookGateway,
} from "../src/controller/index.ts";
import type { AnyEventDraft, PromptBlock } from "../src/event/types.ts";
import type {
  AdapterCapabilities,
  EventSink,
  HarnessAdapter,
  HarnessSessionHandle,
  OpenOptions,
  PromptInput,
  SendTurnReceipt,
} from "../src/harness/adapter.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";
import { resolveTestTarget } from "./harness-target.ts";

class ProbeAdapter implements HarnessAdapter {
  readonly harness = "codex";
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  sink?: EventSink;
  inputs: PromptInput[] = [];
  private active?: PromptInput;

  async open(_options: OpenOptions, sink: EventSink): Promise<HarnessSessionHandle> {
    this.sink = sink;
    return { harness: this.harness, handleId: "probe", resumed: false };
  }

  async sendTurn(
    _ref: HarnessSessionHandle,
    input: PromptInput,
  ): Promise<SendTurnReceipt> {
    this.inputs.push(input);
    if (this.active) {
      return this.active.turnId === input.turnId
        ? { accepted: true, effective: "steer" }
        : { accepted: false, effective: "rejected" };
    }
    this.active = input;
    return { accepted: true, effective: "new_turn" };
  }

  emit(event: AnyEventDraft): void {
    this.sink?.(event);
  }

  finish(): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    this.emit({
      kind: "state_update",
      turnId: active.turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
  }

  async cancel(): Promise<void> {
    this.finish();
  }

  async close(): Promise<void> {}
}

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-harness-hook-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const text = (value: string): PromptBlock[] => [{ type: "text", text: value }];

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
    await Bun.sleep(1);
  }
  expect(condition()).toBe(true);
}

function controller(adapter: ProbeAdapter, hooks: HarnessHookGateway): Controller {
  return new Controller({
    session,
    mentionBudgetChars: 4096,
    createAdapter: () => adapter,
    resolveTarget: resolveTestTarget,
    hooks,
  });
}

describe("Harness Hook integration", () => {
  test("wraps new-turn and steer sends with one correlated delivery", async () => {
    const adapter = new ProbeAdapter();
    let releaseNewTurn!: () => void;
    let releaseSteer!: () => void;
    const newTurnGate = new Promise<void>((resolve) => {
      releaseNewTurn = resolve;
    });
    const steerGate = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });
    const before: HarnessDelivery[] = [];
    const after: HarnessDelivery[] = [];
    const hooks = {
      has: (stage) => stage === "harness.outbound.before",
      before: async (stage, subject) => {
        if (stage !== "harness.outbound.before") return;
        const delivery = subject as unknown as HarnessDelivery;
        before.push(delivery);
        await (delivery.operation === "new_turn" ? newTurnGate : steerGate);
      },
      after: (stage, subject) => {
        if (stage === "harness.outbound.after") {
          after.push(subject as unknown as HarnessDelivery);
        }
      },
    } satisfies HarnessHookGateway;
    const control = controller(adapter, hooks);

    const first = control.submit("codex", text("one"));
    await until(() => before.length === 1);
    expect(adapter.inputs).toHaveLength(0);
    expect(before[0]).toMatchObject({
      harnessTargetId: "codex",
      laneId: "main",
      operation: "new_turn",
    });
    expect(before[0]?.attemptId).toMatch(/^att_/);

    releaseNewTurn();
    await until(() => adapter.inputs.length === 1 && after.length === 1);
    expect(after[0]).toMatchObject({
      attemptId: before[0]?.attemptId,
      operation: "new_turn",
      outcome: "accepted",
    });

    const steering = control.sendTurn("codex", text("two"));
    await until(() => before.length === 2);
    expect(adapter.inputs).toHaveLength(1);
    expect(before[1]).toMatchObject({
      operation: "steer",
      turnId: adapter.inputs[0]?.turnId,
    });

    releaseSteer();
    expect((await steering).effective).toBe("steer");
    expect(after[1]).toMatchObject({
      attemptId: before[1]?.attemptId,
      operation: "steer",
      outcome: "accepted",
    });

    adapter.finish();
    await first;
    await control.close();
  });

  test("waits before recording a Harness event and reports its ledger identity after", async () => {
    const adapter = new ProbeAdapter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let draft: HarnessEventDraft | undefined;
    const records: HarnessEventRecord[] = [];
    const hooks = {
      has: (stage) => stage === "harness.inbound.before",
      before: async (stage, subject) => {
        if (stage !== "harness.inbound.before") return;
        const event = subject as unknown as HarnessEventDraft;
        if (event.kind !== "agent_message") return;
        draft = event;
        await gate;
      },
      after: (stage, subject) => {
        if (stage === "harness.inbound.after") {
          records.push(subject as unknown as HarnessEventRecord);
        }
      },
    } satisfies HarnessHookGateway;
    const control = controller(adapter, hooks);
    const outcome = control.submit("codex", text("one"));
    await until(() => adapter.inputs.length === 1);
    const turnId = adapter.inputs[0]?.turnId as string;

    adapter.emit({
      kind: "agent_message",
      turnId,
      payload: {
        messageId: "m_agent",
        content: [{ type: "text", text: "working" }],
      },
    });
    await until(() => draft !== undefined);
    expect(draft).toEqual({
      kind: "agent_message",
      harnessTargetId: "codex",
      laneId: "main",
      turnId,
    });
    expect(session.readEvents().some((event) => event.kind === "agent_message")).toBe(false);

    release();
    await until(() => records.some((event) => event.kind === "agent_message"));
    const recorded = records.find((event) => event.kind === "agent_message");
    expect(recorded).toMatchObject(draft as HarnessEventDraft);
    expect(recorded?.eventId).toMatch(/^ev_/);
    expect(recorded?.seq).toBeNumber();
    expect(session.readEvents().find((event) => event.kind === "agent_message")?.eventId)
      .toBe(recorded?.eventId);

    adapter.finish();
    await outcome;
    await control.close();
  });
});
