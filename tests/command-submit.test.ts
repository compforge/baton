import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext, CommandInput, CommandResult } from "@compforge/baton-plugin";
import type { Controller } from "../src/controller/index.ts";
import type { Manager } from "../src/plugin/manager.ts";
import type { Channel } from "../src/channel/index.ts";
import { DEFAULT_CONFIG } from "../src/config/config.ts";
import { loadModelPreferences } from "../src/config/model-preferences.ts";
import { loadEffortPreferences } from "../src/config/effort-preferences.ts";
import { SessionStore } from "../src/store/store.ts";
import { BatonChatProtocol } from "../src/view/chat-tui/protocol/index.ts";

describe("Command verbs", () => {
  for (const failure of [false, true]) {
    test(`resolves affinity before configuration and submit; failure=${failure}`, async () => {
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
      internal.plugins.listCommands = () => [{ pluginId: "compforge/boost", namespace: "compforge/boost", name: "easy", description: "Fast" }];
      internal.plugins.resolveHarnessTargetId = () => effective;
      internal.plugins.executeCommand = async (_name: string, input: CommandInput, context: CommandContext): Promise<CommandResult | void> => {
        expect(context.target).toEqual({ id: "codex2", harness: "codex" });
        await context.verbs.configureModel({ model: "fast", effort: "medium" });
        const receipt = await context.verbs.submit({ prompt: input.argument });
        expect(receipt).toEqual({ messageId: expect.any(String), queued: false });
        expect(receipt).not.toHaveProperty("turnId");
      };
      internal.controller.setModelConfiguration = async (target, selection) => {
        calls.push(`configure:${target}`);
        expect(selection).toEqual({ model: "fast", effort: "medium" });
        if (failure) throw new Error("Unsupported model/effort");
      };
      internal.controller.sendTurn = async (target, _blocks, options) => {
        calls.push(`prompt:${target}`);
        expect(options?.followUp).toBe(true);
        expect(options?.identity).toBeDefined();
        expect(options?.parentEventId).toBeDefined();
        return { effective: "new_turn", queued: false, outcome: Promise.resolve("completed") };
      };
      try {
        if (failure) await expect(protocol.command("easy", "hello")).rejects.toThrow("Unsupported model/effort");
        else await protocol.command("easy", "hello");
        expect(calls).toEqual(["balance", "configure:codex2", ...(failure ? [] : ["prompt:codex2"])]);
        expect(loadModelPreferences(root)).toEqual(failure ? {} : { codex2: "fast" });
        expect(loadEffortPreferences(root)).toEqual(failure ? {} : { codex2: "medium" });
        expect(session.ledger.read().filter((event) => event.kind === "input.received").map((event) => event.payload.input.kind)).toEqual(["command", "configuration"]);
      } finally {
        await protocol.exit();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
