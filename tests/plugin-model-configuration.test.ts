import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginCommandInput, PluginCommandResult } from "@compforge/baton-plugin";
import type { Controller } from "../src/controller/index.ts";
import type { Manager } from "../src/plugin/manager.ts";
import type { Channel } from "../src/channel/index.ts";
import { DEFAULT_CONFIG } from "../src/config/config.ts";
import { loadModelPreferences } from "../src/config/model-preferences.ts";
import { loadEffortPreferences } from "../src/config/effort-preferences.ts";
import { SessionStore } from "../src/store/store.ts";
import { BatonChatProtocol } from "../src/view/chat-tui/protocol/index.ts";

describe("Plugin model configuration lowering", () => {
  for (const failure of [false, true]) {
    test(`resolves affinity before catalog and configuration; failure=${failure}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "baton-preset-"));
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, {
        ...DEFAULT_CONFIG,
        targets: { ...DEFAULT_CONFIG.targets, codex2: { harness: "codex" } },
      }, { session, resumed: false }, () => {});
      const internal = protocol as unknown as { controller: Controller; plugins: Manager; channel: Channel };
      const calls: string[] = [];
      let effective = "codex";
      const dispatch = internal.channel.dispatchCommand.bind(internal.channel);
      internal.channel.dispatchCommand = (input, execute) => dispatch(input, async (record) => {
        effective = "codex2"; // Simulates the awaited inline assignment hook.
        calls.push("balance");
        return execute(record);
      });
      internal.plugins.listCommands = () => [{ pluginId: "compforge/boost", commandId: "easy", name: "easy", description: "Fast" }];
      internal.plugins.resolveHarnessTargetId = () => effective;
      internal.plugins.executeCommand = async (_name: string, input: PluginCommandInput): Promise<PluginCommandResult> => {
        expect(input.target).toEqual({ id: "codex2", harness: "codex" });
        return { kind: "model_configuration", model: "fast", effort: "medium", prompt: input.argument };
      };
      internal.controller.setModelConfiguration = async (target, pair) => {
        calls.push(`configure:${target}:${pair.model}:${pair.effort}`);
        if (failure) throw new Error("invalid pair");
      };
      internal.controller.sendTurn = async (target, _blocks, options) => {
        calls.push(`prompt:${target}`);
        expect(options?.followUp).toBe(true);
        return { effective: "new_turn", queued: false, outcome: Promise.resolve("completed") };
      };
      try {
        if (failure) await expect(protocol.command("easy", "hello")).rejects.toThrow("invalid pair");
        else await protocol.command("easy", "hello");
        expect(calls).toEqual(["balance", "configure:codex2:fast:medium", ...(failure ? [] : ["prompt:codex2"])]);
        expect(loadModelPreferences(root)).toEqual(failure ? {} : { codex2: "fast" });
        expect(loadEffortPreferences(root)).toEqual(failure ? {} : { codex2: "medium" });
        expect(session.ledger.read().filter((event) => event.kind === "input.received").map((event) => event.payload.input.kind)).toEqual(failure ? ["command", "configuration"] : ["command", "configuration", "prompt"]);
      } finally {
        await protocol.exit();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
