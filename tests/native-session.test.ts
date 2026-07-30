import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import {
  materializeNativeSession,
  nativeSessionTurns,
  resolveNativeSession,
  type NativeSessionInfo,
  type NativeSessionProvider,
  type NativeSessionSource,
  type ResolvedNativeSession,
} from "../src/harness/native-session.ts";
import { SessionStore } from "../src/store/store.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function info(id: string, title = id): NativeSessionInfo {
  return {
    nativeSessionId: id,
    cwd: "/repo",
    title,
    transcript: [
      { role: "user", text: "investigate the cache" },
      { role: "assistant", text: "the cache key is missing the tenant" },
      { role: "user", text: "fix it" },
      { role: "assistant", text: "added the tenant to the cache key" },
    ],
  };
}

function source(
  harness: "codex" | "claude",
  provider: NativeSessionProvider,
): NativeSessionSource {
  return {
    target: { id: harness, harness },
    harness: harness === "claude" ? "claude-code" : "codex",
    provider,
  };
}

function provider(
  sessions: Record<string, NativeSessionInfo>,
): NativeSessionProvider {
  return {
    async inspect(sessionId) {
      return sessions[sessionId] ?? null;
    },
  };
}

const options = {
  config: DEFAULT_CONFIG,
  cwd: "/repo",
};

describe("native session reference resolution", () => {
  test("bare id resolves when exactly one Harness finds it", async () => {
    const match = await resolveNativeSession("native-1", {
      ...options,
      sources: [
        source("codex", provider({ "native-1": info("native-1") })),
        source("claude", provider({})),
      ],
    });

    expect(match.target.harness).toBe("codex");
    expect(match.source.nativeSessionId).toBe("native-1");
  });

  test("cx:/cc: explicitly select a Harness without probing the other one", async () => {
    let claudeInspections = 0;
    const match = await resolveNativeSession("cx:native-1", {
      ...options,
      sources: [
        source("codex", provider({ "native-1": info("native-1") })),
        source("claude", {
          async inspect() {
            claudeInspections++;
            return info("native-1");
          },
        }),
      ],
    });

    expect(match.target.harness).toBe("codex");
    expect(claudeInspections).toBe(0);
  });

  test("missing native id fails before a BatonSession can be materialized", async () => {
    await expect(
      resolveNativeSession("missing", {
        ...options,
        sources: [
          source("codex", provider({})),
          source("claude", provider({})),
        ],
      }),
    ).rejects.toThrow("native session not found: missing");
  });

  test("ambiguous bare id requires a chooser or explicit prefix", async () => {
    const sources = [
      source("codex", provider({ same: info("same", "Codex copy") })),
      source("claude", provider({ same: info("same", "Claude copy") })),
    ];
    await expect(resolveNativeSession("same", { ...options, sources })).rejects.toThrow(
      /ambiguous.*use cx: or cc:/,
    );

    const chosen = await resolveNativeSession("same", {
      ...options,
      sources,
      choose: async (matches) =>
        matches.find((match) => match.target.harness === "claude") as ResolvedNativeSession,
    });
    expect(chosen.target.harness).toBe("claude");
  });
});

describe("native session ownership", () => {
  test("resume reconstructs ordinary Baton turns once and then reuses the Baton owner", () => {
    const root = mkdtempSync(`${tmpdir()}/baton-native-resume-`);
    roots.push(root);
    const store = new SessionStore(root);
    const match: ResolvedNativeSession = {
      ...source("codex", provider({})),
      source: info("thread-1", "Fix cache isolation"),
    };

    const first = materializeNativeSession(store, match, { cwd: "/fallback" });
    const second = materializeNativeSession(store, match, { cwd: "/fallback" });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.session.id).toBe(first.session.id);
    expect(first.session.meta.cwd).toBe("/repo");
    expect(first.session.meta.nativeSessionOrigin).toEqual({
      harnessTargetId: "codex",
      harness: "codex",
      nativeSessionId: "thread-1",
    });
    expect(first.session.meta.title).toBe("Fix cache isolation");
    expect(first.session.meta.preview).toBe("investigate the cache");
    expect(first.session.meta.harnessSessions.codex?.harnessSessionId).toBe("thread-1");
    expect(first.session.meta.harnessSessions.codex?.syncedSeq).toBe(
      first.session.readEvents().at(-1)?.seq,
    );
    expect(first.session.loadState().turnSummaries).toEqual([
      expect.objectContaining({
        userText: "investigate the cache",
        agentText: "the cache key is missing the tenant",
      }),
      expect.objectContaining({
        userText: "fix it",
        agentText: "added the tenant to the cache key",
      }),
    ]);
    expect(
      first.session
        .readEvents()
        .filter((event) => event.kind === "_baton_turn_summary")
        .every((event) => event.harnessTargetId === "codex"),
    ).toBe(true);
  });

  test("forking a native id materializes a source, then uses ordinary Baton fork", () => {
    const root = mkdtempSync(`${tmpdir()}/baton-native-fork-`);
    roots.push(root);
    const store = new SessionStore(root);
    const match: ResolvedNativeSession = {
      ...source("claude", provider({})),
      source: info("claude-source"),
    };

    const imported = materializeNativeSession(store, match, { cwd: "/fallback" });
    const batonChild = store.forkSession(imported.session.id, { cwd: "/target" });

    expect(imported.session.meta.nativeSessionOrigin?.nativeSessionId).toBe("claude-source");
    expect(imported.session.meta.harnessSessions.claude?.harnessSessionId).toBe("claude-source");
    expect(batonChild.meta.forkedFrom?.batonSessionId).toBe(imported.session.id);
    expect(batonChild.meta.nativeSessionOrigin).toBeUndefined();
    expect(batonChild.meta.cwd).toBe("/target");
    expect(batonChild.loadState().turnSummaries).toHaveLength(2);
    expect(batonChild.meta.harnessSessions.claude?.harnessSessionId).toBeUndefined();
  });

  test("normalizes native messages into logical turns without collapsing history", () => {
    expect(
      nativeSessionTurns([
        { role: "assistant", text: "opening context" },
        { role: "assistant", text: "continued context" },
        { role: "user", text: "question" },
        { role: "assistant", text: "answer part one" },
        { role: "assistant", text: "answer part two" },
      ]),
    ).toEqual([
      { agentText: "opening context\n\ncontinued context" },
      { userText: "question", agentText: "answer part one\n\nanswer part two" },
    ]);
  });

  test("rejects multiple Baton owners for one native session binding", () => {
    const root = mkdtempSync(`${tmpdir()}/baton-native-duplicate-`);
    roots.push(root);
    const store = new SessionStore(root);
    const materialization = {
      harnessTargetId: "codex",
      harness: "codex",
      nativeSessionId: "thread-1",
      cwd: "/repo",
      turns: [],
    };
    store.createFromNativeSession(materialization);
    store.createFromNativeSession(materialization);

    expect(() => store.findByNativeSession("codex", "thread-1")).toThrow(
      /bound to multiple BatonSessions/,
    );
  });
});
