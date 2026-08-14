import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  HookStage,
  HookSubjectMap,
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
  test("records inbound facts before notifying Plugins and handling the input", async () => {
    let fixture!: ReturnType<typeof channel>;
    const calls: string[] = [];
    fixture = channel(gateway({
      before: async () => {
        calls.push("before");
        expect(fixture.readKinds()).toEqual(["input.received"]);
      },
      after: () => {
        calls.push("after");
        expect(fixture.readKinds()).toEqual(["input.received", "input.settled"]);
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

    expect(calls).toEqual(["before", "handle", "after"]);
  });

  test("publishes outbound state between before and after notifications", async () => {
    const calls: string[] = [];
    const fixture = channel(gateway({
      has: () => true,
      before: async () => {
        calls.push("before");
      },
      after: () => {
        calls.push("after");
      },
    }));

    await fixture.channel.outbound("transcript", () => {
      calls.push("publish");
      return true;
    });

    expect(calls).toEqual(["before", "publish", "after"]);
  });

  test("runs before Hooks for unrelated concurrent outbound presentations", async () => {
    let releaseTranscript!: () => void;
    const transcriptGate = new Promise<void>((resolve) => {
      releaseTranscript = resolve;
    });
    let transcriptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      transcriptStarted = resolve;
    });
    const beforeKinds: string[] = [];
    const fixture = channel(gateway({
      has: () => true,
      before: async (_stage, subject) => {
        const kind = (subject as { kind?: string }).kind;
        if (!kind) return;
        beforeKinds.push(kind);
        if (kind === "transcript") {
          transcriptStarted();
          await transcriptGate;
        }
      },
    }));

    const transcript = fixture.channel.outbound("transcript", () => true);
    await started;
    const board = fixture.channel.outbound("board", () => true);
    await board;
    releaseTranscript();
    await transcript;

    expect(beforeKinds).toEqual(["transcript", "board"]);
  });

  test("skips the same before Hook only for causally reentrant publication", async () => {
    let fixture!: ReturnType<typeof channel>;
    const calls: string[] = [];
    fixture = channel(gateway({
      has: () => true,
      before: async (_stage, subject) => {
        const kind = (subject as { kind?: string }).kind;
        calls.push(`before:${kind}`);
        if (kind === "transcript") {
          await fixture.channel.outbound("interaction", () => {
            calls.push("publish:interaction");
            return true;
          });
        }
      },
    }));

    await fixture.channel.outbound("transcript", () => {
      calls.push("publish:transcript");
      return true;
    });

    expect(calls).toEqual([
      "before:transcript",
      "publish:interaction",
      "publish:transcript",
    ]);
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
  before?: (stage: HookStage, subject: Readonly<unknown>) => Promise<void>;
  after?: (stage: HookStage, subject: Readonly<unknown>) => void;
}): ChannelHookGateway {
  return {
    has: overrides.has ?? (() => false),
    before: async <S extends Extract<HookStage, `${string}.before`>>(
      stage: S,
      subject: Readonly<HookSubjectMap[S]>,
    ) => await overrides.before?.(stage, subject),
    after: <S extends Extract<HookStage, `${string}.after`>>(
      stage: S,
      subject: Readonly<HookSubjectMap[S]>,
    ) => overrides.after?.(stage, subject),
  };
}
