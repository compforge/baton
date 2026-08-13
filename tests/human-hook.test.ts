import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  HookStage,
  HookSubjectMap,
  HumanInputRecord,
  HumanInputSettlement,
} from "@compforge/baton-plugin";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import type { SendTurnOptions } from "../src/controller/index.ts";
import type { PromptBlock } from "../src/event/index.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";
import { BatonChatProtocol } from "../src/tui/protocol/index.ts";

const roots: string[] = [];

function protocol(): BatonChatProtocol {
  const root = mkdtempSync(join(tmpdir(), "baton-human-hook-"));
  roots.push(root);
  const store = new SessionStore(root);
  return new BatonChatProtocol(
    store,
    DEFAULT_CONFIG,
    { session: store.createSession({ cwd: "/repo" }), resumed: false },
    () => undefined,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Human Hook integration", () => {
  test("correlates prompt intake before and after Input enqueue", async () => {
    const chat = protocol();
    await chat.pluginManager.start();
    const calls: string[] = [];
    let inputId = "";
    let inputEventId = "";
    const plugins = chat.pluginManager as typeof chat.pluginManager & {
      beforeHook<S extends Extract<HookStage, `${string}.before`>>(
        stage: S,
        subject: Readonly<HookSubjectMap[S]>,
      ): Promise<void>;
      afterHook<S extends Extract<HookStage, `${string}.after`>>(
        stage: S,
        subject: Readonly<HookSubjectMap[S]>,
      ): void;
    };
    plugins.beforeHook = async (stage, subject) => {
      if (stage !== "human.inbound.before") return;
      const record = subject as unknown as HumanInputRecord;
      calls.push("before");
      inputId = record.inputId;
      inputEventId = record.eventId;
      expect(record.input).toMatchObject({
        kind: "prompt", text: "ship it", harnessTargetId: "codex",
      });
      expect(record.eventId).toMatch(/^ev_/);
      const durable = (chat as unknown as { session: SessionHandle })
        .session.ledger.read()
        .find((event) => event.eventId === record.eventId);
      expect(durable?.kind).toBe("input.received");
    };
    plugins.afterHook = (stage, subject) => {
      if (stage !== "human.inbound.after") return;
      calls.push("after");
      expect(subject as unknown as HumanInputSettlement).toMatchObject({
        inputId,
        outcome: "succeeded",
      });
    };
    const controller = (chat as unknown as {
      controller: {
        sendTurn(
          target: string,
          blocks: PromptBlock[],
          options?: SendTurnOptions,
        ): Promise<{
          effective: "new_turn";
          queued: false;
          outcome: Promise<"completed">;
        }>;
      };
    }).controller;
    controller.sendTurn = async (_target, _blocks, options) => {
      calls.push("enqueue");
      expect(options?.parentEventId).toBe(inputEventId);
      return {
        effective: "new_turn",
        queued: false,
        outcome: Promise.resolve("completed"),
      };
    };

    await chat.submit("ship it");
    expect(calls).toEqual(["before", "enqueue", "after"]);
    await chat.exit();
  });

  test("notifies command, configuration, interaction, and interrupt intents", async () => {
    const chat = protocol();
    await chat.pluginManager.start();
    const kinds: string[] = [];
    const plugins = chat.pluginManager;
    plugins.beforeHook = async (stage, subject) => {
      if (stage === "human.inbound.before") {
        kinds.push((subject as unknown as HumanInputRecord).input.kind);
      }
    };
    plugins.afterHook = () => {};

    await chat.command("status", "");
    await chat.submit("/cc");
    await chat.resolveInteraction("ix_missing", { kind: "cancelled" });
    chat.cancel();
    await Bun.sleep(0);

    expect(kinds).toEqual([
      "command",
      "configuration",
      "interaction_response",
      "interrupt",
    ]);
    await chat.exit();
  });

  test("publishes state between outbound before and after notifications", async () => {
    const chat = protocol();
    await chat.pluginManager.start();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const plugins = chat.pluginManager;
    plugins.hasHook = (stage) => stage === "human.outbound.before";
    plugins.beforeHook = async (stage) => {
      if (stage !== "human.outbound.before") return;
      calls.push("before");
      await wait;
    };
    plugins.afterHook = (stage) => {
      if (stage === "human.outbound.after") calls.push("after");
    };

    await chat.command("status", "");
    expect(calls).toEqual(["before"]);

    release();
    for (let attempt = 0; attempt < 20 && calls.length < 2; attempt += 1) {
      await Bun.sleep(5);
    }
    expect(calls).toEqual(["before", "after"]);
    await chat.exit();
  });
});
