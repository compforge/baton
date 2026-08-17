import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BatonEventReference,
  HarnessInputDispatch,
} from "@compforge/baton-plugin";

import {
  Controller,
  type HarnessHookGateway,
} from "../src/controller/index.ts";
import type { AnyEventDraft, PromptBlock } from "../src/event/index.ts";
import type {
  AdapterCapabilities,
  HarnessEventSink,
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
  sink?: HarnessEventSink;
  inputs: PromptInput[] = [];
  private active?: PromptInput;

  async open(_options: OpenOptions, sink: HarnessEventSink): Promise<HarnessSessionHandle> {
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
  test("observes each new-turn and steer HarnessInput before Adapter dispatch", async () => {
    const adapter = new ProbeAdapter();
    let releaseNewTurn!: () => void;
    let releaseSteer!: () => void;
    const newTurnGate = new Promise<void>((resolve) => {
      releaseNewTurn = resolve;
    });
    const steerGate = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });
    const inputs: HarnessInputDispatch[] = [];
    const hooks = {
      has: (stage) => stage === "harness.input",
      inline: async (stage, subject) => {
        if (stage !== "harness.input") return;
        const input = subject as HarnessInputDispatch;
        inputs.push(input);
        await (input.operation === "new_turn" ? newTurnGate : steerGate);
      },
      defer: () => {},
    } satisfies HarnessHookGateway;
    const control = controller(adapter, hooks);

    const first = control.submit("codex", text("one"));
    await until(() => inputs.length === 1);
    expect(adapter.inputs).toHaveLength(0);
    expect(inputs[0]).toMatchObject({
      harnessTargetId: "codex",
      laneId: "main",
      operation: "new_turn",
    });
    expect(inputs[0]?.attemptId).toMatch(/^att_/);

    releaseNewTurn();
    await until(() => adapter.inputs.length === 1);

    const steering = control.sendTurn("codex", text("two"));
    await until(() => inputs.length === 2);
    expect(adapter.inputs).toHaveLength(1);
    expect(inputs[1]).toMatchObject({
      operation: "steer",
      turnId: adapter.inputs[0]?.turnId,
    });

    releaseSteer();
    expect((await steering).effective).toBe("steer");
    adapter.finish();
    await first;
    await control.close();
  });

  test("records Harness output before notifying Plugins", async () => {
    const adapter = new ProbeAdapter();
    const records: BatonEventReference[] = [];
    const hooks = {
      has: (stage) => stage === "harness.output",
      inline: async () => {},
      defer: (stage, subject) => {
        if (stage === "harness.output") {
          records.push(subject as BatonEventReference);
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
    await until(() => records.some((event) => event.kind === "agent_message"));
    const observed = records.find((event) => event.kind === "agent_message");
    expect(observed).toMatchObject({
      kind: "agent_message",
      harnessTargetId: "codex",
      laneId: "main",
      turnId,
    });
    expect(observed?.eventId).toMatch(/^ev_/);
    expect(observed?.seq).toBeNumber();
    expect(session.ledger.read().find((event) => event.kind === "agent_message")?.eventId)
      .toBe(observed?.eventId);

    adapter.finish();
    await outcome;
    await control.close();
  });
});
