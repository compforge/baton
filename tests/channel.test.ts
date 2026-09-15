import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DeferredHookStage,
  HookStage,
  HookSubjectMap,
  InlineHookStage,
} from "@compforge/baton-plugin";

import { Channel, type ChannelHookGateway } from "../src/channel/index.ts";
import { SessionStore } from "../src/store/store.ts";

const roots: string[] = [];

function channel(hooks?: ChannelHookGateway): {
  channel: Channel;
  session: ReturnType<SessionStore["createSession"]>;
  readKinds: () => string[];
} {
  const root = mkdtempSync(join(tmpdir(), "baton-channel-"));
  roots.push(root);
  const session = new SessionStore(root).createSession({ cwd: "/repo" });
  return {
    channel: new Channel({
      session,
      controller: {
        mentionBudgetChars: 1_000,
        createAdapter: () => {
          throw new Error("unused test adapter");
        },
        resolveTarget: () => undefined,
      },
      ...(hooks ? { hooks } : {}),
    }),
    session,
    readKinds: () => session.ledger.read().map((event) => event.kind),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Channel", () => {
  test("records ViewInput before notifying Plugins and handling it", async () => {
    let fixture!: ReturnType<typeof channel>;
    const calls: string[] = [];
    fixture = channel(gateway({
      inline: async () => {
        calls.push("input");
        expect(fixture.readKinds()).toEqual(["input.received"]);
      },
    }));

    await fixture.channel.dispatchCommand({
      kind: "command",
      command: "status",
      argument: "",
      harnessTargetId: "codex",
    }, async () => {
      calls.push("handle");
    });

    expect(calls).toEqual(["input", "handle"]);
    expect(fixture.readKinds()).toEqual(["input.received", "input.settled"]);
  });

  test("records a Parallel action before routing it to the Core owner", async () => {
    let fixture!: ReturnType<typeof channel>;
    const calls: string[] = [];
    fixture = channel(gateway({
      inline: async (_stage, subject) => {
        calls.push("input");
        expect(fixture.readKinds()).toEqual(["input.received"]);
        expect(subject).toMatchObject({
          input: {
            kind: "task_action",
            taskKey: "task:main:claude:native-1",
            action: "stop",
          },
        });
      },
    }));

    await fixture.channel.dispatchTaskAction({
      kind: "task_action",
      taskKey: "task:main:claude:native-1",
      action: "stop",
    }, async () => {
      calls.push("handle");
    });

    expect(calls).toEqual(["input", "handle"]);
    expect(fixture.readKinds()).toEqual(["input.received", "input.settled"]);
  });

  test("notifies ViewOutput only after publishing state", async () => {
    const calls: string[] = [];
    const fixture = channel(gateway({
      has: () => true,
      defer: () => {
        calls.push("output");
      },
    }));

    await fixture.channel.publishViewOutput("transcript", () => {
      calls.push("publish");
      return true;
    });

    expect(calls).toEqual(["publish", "output"]);
  });

  test("exposes the request Message reference to the ViewInput Hook before resolution", async () => {
    const calls: string[] = [];
    const input = { kind: "interaction_response" as const, messageId: "missing-request" };
    const fixture = channel(gateway({
      inline: async (stage, subject) => {
        expect(stage).toBe("view.input");
        expect(subject).toMatchObject({ input });
        calls.push("hook");
      },
    }));
    const receipt = await fixture.channel.resolveInteraction(input, async (record) => {
      expect(record.input).toEqual(input);
      expect(record.inputId).not.toBe(input.messageId);
      calls.push("resolve");
      return { kind: "cancelled", reason: "user" };
    });
    expect(calls).toEqual(["hook", "resolve"]);
    expect(receipt.result).toBe(false);
    // An observed operation is not an accepted answer or a fabricated Message.
    expect(fixture.readKinds()).toEqual(["input.received", "input.settled"]);
    expect(fixture.session.projection.inputResponses.size).toBe(0);
    await fixture.channel.close();
  });

  test("reports each published ViewOutput kind", async () => {
    const outputKinds: string[] = [];
    const fixture = channel(gateway({
      defer: (_stage, subject) => {
        const kind = (subject as { kind?: string }).kind;
        if (kind) outputKinds.push(kind);
      },
    }));

    await fixture.channel.publishViewOutput("transcript", () => true);
    await fixture.channel.publishViewOutput("board", () => true);

    expect(outputKinds).toEqual(["transcript", "board"]);
  });

  test("does not notify an output that the View skipped", async () => {
    let outputs = 0;
    const fixture = channel(gateway({ defer: () => outputs += 1 }));

    await fixture.channel.publishViewOutput("transcript", () => false);

    expect(outputs).toBe(0);
  });

  test("rejects new input while one idempotent close settlement is running", async () => {
    const fixture = channel();
    const first = fixture.channel.close();
    const second = fixture.channel.close();

    expect(second).toBe(first);
    expect(fixture.channel.lifecycle).toBe("closing");
    await expect(fixture.channel.dispatchCommand({
      kind: "command",
      command: "status",
      argument: "",
      harnessTargetId: "codex",
    }, async () => undefined)).rejects.toThrow("Channel is closing");
    await first;
    expect(fixture.channel.lifecycle).toBe("closed");
  });

  test("allows only one active Channel for a BatonSession lease", async () => {
    const fixture = channel();
    expect(() => new Channel({
      session: fixture.session,
      controller: {
        mentionBudgetChars: 1_000,
        createAdapter: () => {
          throw new Error("unused test adapter");
        },
        resolveTarget: () => undefined,
      },
    })).toThrow("already has an active Channel");
    await fixture.channel.close();
  });
});

function gateway(overrides: {
  has?: (stage: HookStage) => boolean;
  inline?: (stage: HookStage, subject: Readonly<unknown>) => Promise<void>;
  defer?: (stage: HookStage, subject: Readonly<unknown>) => void;
}): ChannelHookGateway {
  return {
    has: overrides.has ?? (() => false),
    inline: async <S extends InlineHookStage>(
      stage: S,
      subject: Readonly<HookSubjectMap[S]>,
    ) => await overrides.inline?.(stage, subject),
    defer: <S extends DeferredHookStage>(
      stage: S,
      subject: Readonly<HookSubjectMap[S]>,
    ) => overrides.defer?.(stage, subject),
  };
}
