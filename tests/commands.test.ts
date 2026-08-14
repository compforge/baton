import { describe, expect, test } from "bun:test";
import { parseSlashCommand } from "chat-tui";

import { CommandRegistry } from "../src/commands/registry.ts";

function fixture() {
  const calls: Array<{ command: string; argument: string }> = [];
  const registry = new CommandRegistry();
  registry.register({
    name: "effort",
    description: "Set effort",
    scope: "harness",
    runPolicy: "always",
    input: { kind: "argument" },
    aliases: [
      {
        name: "h",
        boundArgument: "high",
        input: { kind: "none", trailingText: "submit" },
      },
      {
        name: "eh",
        boundArgument: "xhigh",
        input: { kind: "none", trailingText: "submit" },
      },
    ],
    execute: async (argument) => {
      calls.push({ command: "effort", argument });
    },
  });
  registry.register({
    name: "plan",
    description: "Switch to Plan mode",
    scope: "harness",
    runPolicy: "idle",
    input: { kind: "none", trailingText: "submit" },
    execute: async (argument) => {
      calls.push({ command: "plan", argument });
    },
  });
  registry.register({
    name: "status",
    description: "Show status",
    scope: "baton",
    runPolicy: "always",
    input: { kind: "none", trailingText: "reject" },
    execute: async (argument) => {
      calls.push({ command: "status", argument });
    },
  });
  return { registry, calls };
}

describe("CommandRegistry", () => {
  test("a Command registers its own features, handler, and Aliases", async () => {
    const { registry, calls } = fixture();
    const commandables = registry.list();

    expect(commandables.map((commandable) => commandable.name)).toEqual([
      "effort",
      "h",
      "eh",
      "plan",
      "status",
    ]);
    expect(commandables.find((commandable) => commandable.name === "effort")).toMatchObject({
      kind: "command",
      input: { kind: "argument" },
    });
    expect(commandables.find((commandable) => commandable.name === "h")).toMatchObject({
      kind: "alias",
      boundArgument: "high",
      input: { kind: "none", trailingText: "submit" },
    });

    const invocation = registry.resolve("h", "fix this")!;
    await invocation.command.execute(invocation.argument);
    expect(calls).toEqual([{ command: "effort", argument: "high" }]);
  });

  test("resolves command arguments separately from trailing text", () => {
    const { registry } = fixture();

    expect(registry.resolve("effort", "high")).toMatchObject({
      invokedAs: "effort",
      argument: "high",
    });
    expect(registry.resolve("h", "fix this")).toMatchObject({
      invokedAs: "h",
      argument: "high",
      trailingText: "fix this",
    });
    expect(registry.resolve("eh", "analyze this")).toMatchObject({
      invokedAs: "eh",
      argument: "xhigh",
      trailingText: "analyze this",
    });
    expect(registry.resolve("plan", "investigate this")).toMatchObject({
      invokedAs: "plan",
      argument: "",
      trailingText: "investigate this",
    });
    expect(() => registry.resolve("status", "unexpected")).toThrow("/status takes no arguments");
    expect(registry.resolve("missing", "text")).toBeNull();
  });

  test("exposes all Commandables to chat-tui slash matching", () => {
    const { registry } = fixture();
    const commandables = registry.list();

    expect(parseSlashCommand("/effort high", commandables)).toEqual({ name: "effort", argument: "high" });
    expect(parseSlashCommand("/h fix this", commandables)).toEqual({ name: "h", argument: "fix this" });
    expect(parseSlashCommand("/eh analyze this", commandables)).toEqual({ name: "eh", argument: "analyze this" });
    expect(parseSlashCommand("/pla investigate this", commandables)).toEqual({
      name: "plan",
      argument: "investigate this",
    });
    expect(parseSlashCommand("/unknown", commandables)).toBeNull();
  });

  test("rejects duplicate direct or Alias tokens at registration", () => {
    const { registry } = fixture();
    expect(() =>
      registry.register({
        name: "other",
        description: "Other",
        scope: "baton",
        runPolicy: "always",
        input: { kind: "argument" },
        aliases: [{ name: "h" }],
        execute: async () => undefined,
      })
    ).toThrow("duplicate commandable: /h");
    expect(registry.resolve("other", "")).toBeNull();
  });
});
