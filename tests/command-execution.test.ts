import { expect, test } from "bun:test";
import type { CommandContext, ViewInputRecord } from "@compforge/baton-plugin";
import type { Channel } from "../src/channel/index.ts";
import { executeCommand } from "../src/commands/execution.ts";

const record = { eventId: "e_command" } as ViewInputRecord;
const target = { id: "codex", harness: "codex" };

for (const namespace of ["baton", "example/boost"]) {
  test(`${namespace}: invocation capabilities expire when the command settles`, async () => {
    let captured: CommandContext | undefined;
    const channel = { lifecycle: "open", controller: {} } as Channel;
    expect(await executeCommand(channel, {
      namespace, name: "example", description: "Example",
      async execute(_input, context) {
        captured = context;
        expect(context.command).toEqual({ namespace, name: "example" });
        expect(context.target).toEqual(target);
        return { kind: "message", text: "ready" };
      },
    }, { argument: "" }, record, target)).toEqual({ kind: "message", text: "ready" });
    await expect(captured!.verbs.submit({ prompt: "late" })).rejects.toThrow("no longer active");
    await expect(captured!.verbs.configureModel({ model: "late" })).rejects.toThrow("no longer active");
  });
}

test("search has presentation access but cannot invoke actions", async () => {
  await executeCommand({ lifecycle: "open", controller: {} } as Channel, {
    namespace: "example/boost", name: "example", description: "Example",
    async execute(_input, context) {
      await expect(context.verbs.submit({ prompt: "search side effect" })).rejects.toThrow("search cannot");
      await expect(context.verbs.configureModel({ model: "fast" })).rejects.toThrow("search cannot");
    },
  }, { argument: "", searchQuery: "fast" }, record, target);
});

test("admission rejects an empty prompt before sending", async () => {
  let sends = 0;
  const channel = {
    lifecycle: "open",
    controller: { sendTurn: () => { sends++; } },
  } as unknown as Channel;
  await executeCommand(channel, {
    namespace: "example/boost", name: "example", description: "Example",
    async execute(_input, context) {
      await expect(context.verbs.submit({ prompt: " " })).rejects.toThrow("must not be empty");
    },
  }, { argument: "" }, record, target);
  expect(sends).toBe(0);
});
