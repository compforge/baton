import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ViewInputRecord,
  ViewOutput,
} from "@compforge/baton-plugin";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import type { SendTurnOptions } from "../src/controller/index.ts";
import type { PromptBlock } from "../src/event/index.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";
import { BatonChatProtocol } from "../src/view/chat-tui/protocol/index.ts";

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

describe("View Hook integration", () => {
  test("correlates a durable ViewInput before prompt enqueue", async () => {
    const chat = protocol();
    await chat.pluginManager.start();
    const calls: string[] = [];
    let inputEventId = "";
    const plugins = chat.pluginManager;
    plugins.inlineHook = async (stage, subject) => {
      if (stage !== "view.input") return;
      const record = subject as unknown as ViewInputRecord;
      calls.push("input");
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
    expect(calls).toEqual(["input", "enqueue"]);
    await chat.exit();
  });

  test("notifies command, configuration, interaction, and interrupt intents", async () => {
    const chat = protocol();
    await chat.pluginManager.start();
    const kinds: string[] = [];
    const plugins = chat.pluginManager;
    plugins.inlineHook = async (stage, subject) => {
      if (stage === "view.input") {
        kinds.push((subject as unknown as ViewInputRecord).input.kind);
      }
    };

    await chat.command("status", "");
    await chat.command("cc", "");
    await chat.resolveInteraction("ix_missing", { kind: "cancelled" });
    chat.cancel();
    await Bun.sleep(0);

    expect(kinds).toEqual([
      "command",
      "command",
      "configuration",
      "interaction_response",
      "interrupt",
    ]);
    await chat.exit();
  });

  test("notifies Plugins after publishing a ViewOutput", async () => {
    const chat = protocol();
    await chat.pluginManager.start();
    const outputs: ViewOutput[] = [];
    const plugins = chat.pluginManager;
    plugins.deferHook = (stage, subject) => {
      if (stage === "view.output") {
        outputs.push(subject as unknown as ViewOutput);
      }
    };

    await chat.command("status", "");
    for (let attempt = 0; attempt < 20 && outputs.length === 0; attempt += 1) {
      await Bun.sleep(5);
    }
    expect(outputs).not.toHaveLength(0);
    expect(outputs[0]?.outputId).toMatch(/^vo_/);
    await chat.exit();
  });
});
