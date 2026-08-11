import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import { textOf, type AnyEventDraft } from "../src/event/types.ts";
import { ClaudeAdapter } from "../src/harness/claude/adapter.ts";
import { claudeNativeTurns } from "../src/harness/claude/native-session.ts";
import { CodexAdapter } from "../src/harness/codex/adapter.ts";
import { codexNativeTurns } from "../src/harness/codex/native-session.ts";
import {
  materializeNativeSession,
  nativeSessionTurns,
  resolveNativeSession,
  type NativeSessionInfo,
  type NativeSessionProvider,
  type NativeSessionSource,
  type ResolvedNativeSession,
} from "../src/harness/native-session.ts";
import type { OpenInteraction } from "../src/harness/adapter.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

const roots: string[] = [];
const openInteraction: OpenInteraction = async (interaction) =>
  interaction.kind === "permission"
    ? { kind: "permission", outcome: "selected", optionId: "decline" }
    : { kind: "question", outcome: "answered", answers: {} };

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
    inspector: provider,
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

function logicalContent(session: SessionHandle) {
  const state = session.loadState();
  return {
    timeline: state.timeline.map((item) => item.type),
    messages: [...state.messages.values()].map((message) => ({
      role: message.role,
      content: textOf(message.content),
      streamStatus: message.streamStatus,
      harness: message.harness,
      harnessTargetId: message.harnessTargetId,
    })),
    toolCalls: [...state.toolCalls.values()].map((tool) => ({
      toolCallId: tool.toolCallId,
      title: tool.title,
      kind: tool.kind,
      status: tool.status,
      content: tool.content,
      locations: tool.locations,
      harness: tool.harness,
      harnessTargetId: tool.harnessTargetId,
    })),
    proposedPlans: [...state.proposedPlans.values()].map((plan) => ({
      planId: plan.planId,
      content: plan.content,
      harness: plan.harness,
      harnessTargetId: plan.harnessTargetId,
    })),
    turnSummaries: state.turnSummaries.map((summary) => ({
      stopReason: summary.stopReason,
      userText: summary.userText,
      agentText: summary.agentText,
      toolCalls: summary.toolCalls,
    })),
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
    expect(match.snapshot.identity?.id).toBe("native-1");
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
    ).rejects.toThrow("HarnessSession not found: missing");
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

  test("bare id fails closed when another Harness lookup errors", async () => {
    await expect(
      resolveNativeSession("native-1", {
        ...options,
        sources: [
          source("codex", provider({ "native-1": info("native-1") })),
          source("claude", {
            async inspect() {
              throw new Error("claude lookup unavailable");
            },
          }),
        ],
      }),
    ).rejects.toThrow(/lookup incomplete.*claude lookup unavailable.*use cx: or cc:/);
  });

  test("provider failures are not reported as session not found", async () => {
    await expect(
      resolveNativeSession("native-1", {
        ...options,
        sources: [
          source("codex", {
            async inspect() {
              throw new Error("codex app-server unavailable");
            },
          }),
          source("claude", provider({})),
        ],
      }),
    ).rejects.toThrow("HarnessSession lookup failed for native-1: codex app-server unavailable");
  });
});

describe("native session ownership", () => {
  test("resume reconstructs ordinary Baton turns once and then reuses the Baton owner", () => {
    const root = mkdtempSync(`${tmpdir()}/baton-native-resume-`);
    roots.push(root);
    const store = new SessionStore(root);
    const match: ResolvedNativeSession = {
      ...source("codex", provider({})),
      snapshot: info("thread-1", "Fix cache isolation"),
    };

    const first = materializeNativeSession(store, match, { cwd: "/fallback" });
    const second = materializeNativeSession(store, match, { cwd: "/fallback" });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.session.id).toBe(first.session.id);
    expect(first.session.meta.cwd).toBe("/repo");
    expect(first.session.meta.adoptedFrom).toMatchObject({
      session: {
        harnessTargetId: "codex",
        harness: "codex",
        identity: { id: "thread-1" },
      },
      importedThrough: {
        turnId: "history-2",
        turnCount: 2,
      },
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

  test("explicit native resume reconciles a newly written native tail into the existing owner", () => {
    const root = mkdtempSync(`${tmpdir()}/baton-native-reconcile-`);
    roots.push(root);
    const store = new SessionStore(root);
    const base = {
      harnessTargetId: "codex",
      harness: "codex",
      nativeSessionId: "thread-1",
      cwd: "/repo",
      turns: [
        { userText: "one", agentText: "answer one" },
        { userText: "two", agentText: "answer two" },
      ],
    };
    const first = store.materializeNativeSession(base);
    const refreshed = store.materializeNativeSession({
      ...base,
      turns: [...base.turns, { userText: "three", agentText: "answer three" }],
    });
    const repeated = store.materializeNativeSession({
      ...base,
      turns: [...base.turns, { userText: "three", agentText: "answer three" }],
    });

    expect(refreshed.reused).toBe(true);
    expect(refreshed.session.id).toBe(first.session.id);
    expect(repeated.session.loadState().turnSummaries.map((turn) => turn.agentText)).toEqual([
      "answer one",
      "answer two",
      "answer three",
    ]);
    expect(store.forkSession(first.session.id).loadState().turnSummaries).toHaveLength(3);
  });

  test("adoptedFrom remains the owner index when the current binding changes", () => {
    const root = mkdtempSync(`${tmpdir()}/baton-adopted-owner-`);
    roots.push(root);
    const store = new SessionStore(root);
    const source = {
      harnessTargetId: "codex",
      harness: "codex",
      nativeSessionId: "thread-origin",
      cwd: "/repo",
      turns: [{ userText: "one", agentText: "answer one" }],
    };
    const first = store.materializeNativeSession(source);
    first.session.setHarnessSession("codex", {
      harnessTargetId: "codex",
      harness: "codex",
      harnessSessionId: "thread-current",
    });

    const reopened = store.materializeNativeSession(source);

    expect(reopened.reused).toBe(true);
    expect(reopened.session.id).toBe(first.session.id);
    expect(store.listSessions()).toHaveLength(1);
    expect(reopened.session.meta.adoptedFrom?.session.identity.id).toBe("thread-origin");
    expect(reopened.session.meta.harnessSessions.codex?.harnessSessionId).toBe("thread-origin");
  });

  test("native tail reconcile fails closed on divergence or another live Baton owner", () => {
    const root = mkdtempSync(`${tmpdir()}/baton-native-reconcile-guard-`);
    roots.push(root);
    const store = new SessionStore(root);
    const source = {
      harnessTargetId: "codex",
      harness: "codex",
      nativeSessionId: "thread-1",
      cwd: "/repo",
      turns: [{ userText: "one", agentText: "answer one" }],
    };
    const first = store.materializeNativeSession(source);

    expect(() =>
      store.materializeNativeSession({
        ...source,
        turns: [{ userText: "one", agentText: "different answer" }],
      }),
    ).toThrow(/history diverged at turn 1/);
    expect(first.session.loadState().turnSummaries).toHaveLength(1);

    writeFileSync(join(first.session.dir, "lock"), "1");
    expect(() =>
      store.materializeNativeSession({
        ...source,
        turns: [...source.turns, { userText: "two", agentText: "answer two" }],
      }),
    ).toThrow(/in use by another baton process/);
    expect(first.session.loadState().turnSummaries).toHaveLength(1);
  });

  test("history reconciliation detects tool fact divergence even when summary text is unchanged", () => {
    const root = mkdtempSync(`${tmpdir()}/baton-history-boundary-`);
    roots.push(root);
    const store = new SessionStore(root);
    const turn = (output: string) => codexNativeTurns([{
      id: "turn-1",
      itemsView: "full",
      status: "completed",
      items: [
        { type: "userMessage", id: "u1", content: [{ type: "text", text: "inspect" }] },
        {
          type: "commandExecution",
          id: "cmd1",
          status: "completed",
          command: "cat result",
          aggregatedOutput: output,
        },
        { type: "agentMessage", id: "a1", text: "done" },
      ],
    }]);
    const source = {
      harnessTargetId: "codex",
      harness: "codex",
      nativeSessionId: "thread-1",
      cwd: "/repo",
      turns: turn("first"),
    };
    store.materializeNativeSession(source);

    expect(() =>
      store.materializeNativeSession({ ...source, turns: turn("changed") }),
    ).toThrow(/history diverged at turn 1/);
  });

  test("Codex live capture and full native import reduce to the same Baton content", () => {
    const root = mkdtempSync(`${tmpdir()}/baton-native-equivalence-`);
    roots.push(root);
    const store = new SessionStore(root);
    const items = [
      { type: "userMessage", id: "u1", content: [{ type: "text", text: "inspect the cache" }] },
      { type: "reasoning", id: "r1", summary: ["Tracing the cache key"] },
      {
        type: "commandExecution",
        id: "cmd1",
        status: "completed",
        command: "rg cache_key",
        aggregatedOutput: "src/cache.ts\n",
      },
      { type: "plan", id: "plan1", text: "Add the tenant to the key" },
      { type: "agentMessage", id: "a1", text: "The tenant is missing from the cache key." },
    ];
    const [nativeTurn] = codexNativeTurns([
      {
        id: "codex-turn-1",
        itemsView: "full",
        status: "completed",
        items,
      },
    ]);
    const imported = store.materializeNativeSession({
      harnessTargetId: "codex",
      harness: "codex",
      nativeSessionId: "thread-imported",
      cwd: "/repo",
      turns: [nativeTurn!],
    }).session;

    const live = store.createSession({ cwd: "/repo" });
    const turnId = "t-live";
    live.append({
      kind: "user_message",
      source: { type: "user" },
      harness: "codex",
      harnessTargetId: "codex",
      turnId,
      payload: {
        messageId: "u1",
        content: [{ type: "text", text: "inspect the cache" }],
      },
    });
    live.append({
      kind: "state_update",
      source: { type: "baton" },
      harness: "codex",
      harnessTargetId: "codex",
      turnId,
      payload: { state: "running" },
    });
    const adapter = new CodexAdapter({ openInteraction });
    const drafts: AnyEventDraft[] = [];
    const runtime = {
      threadId: "thread-live",
      turnId,
      activeTurn: { turnId, finalized: false, sawOutput: false },
      sink: (event: AnyEventDraft) => drafts.push(event),
    };
    const notify = (
      adapter as unknown as {
        handleNotification: (runtime: unknown, method: string, params: unknown) => void;
      }
    ).handleNotification.bind(adapter, runtime);
    for (const item of items.slice(1)) {
      notify("item/started", { threadId: "thread-live", turnId: "codex-turn-1", item });
      notify("item/completed", { threadId: "thread-live", turnId: "codex-turn-1", item });
    }
    notify("turn/completed", {
      threadId: "thread-live",
      turn: { id: "codex-turn-1", status: "completed" },
    });
    for (const draft of drafts) {
      live.append({
        ...draft,
        source: { type: "harness", harnessTargetId: "codex" },
        harness: "codex",
        harnessTargetId: "codex",
      });
    }
    live.summarizeTurnEvent(turnId);

    expect(logicalContent(imported)).toEqual(logicalContent(live));
  });

  test("Claude live capture and full native import reduce to the same Baton content", () => {
    const root = mkdtempSync(`${tmpdir()}/baton-claude-native-equivalence-`);
    roots.push(root);
    const store = new SessionStore(root);
    const messages: Parameters<typeof claudeNativeTurns>[0] = [
      {
        type: "user",
        uuid: "u1",
        session_id: "claude-session",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          content: [{
            type: "text",
            text: "<baton-sync>injected context</baton-sync>\n\ninspect the cache",
          }],
        },
      },
      {
        type: "assistant",
        uuid: "a1",
        session_id: "claude-session",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          content: [
            { type: "thinking", thinking: "Tracing the cache key" },
            { type: "text", text: "The tenant is missing from the cache key." },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "rg cache_key" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "r1",
        session_id: "claude-session",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "src/cache.ts\n",
          }],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        session_id: "claude-session",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          content: [{
            type: "tool_use",
            id: "plan-1",
            name: "ExitPlanMode",
            input: { plan: "Add the tenant to the key" },
          }],
        },
      },
      {
        type: "user",
        uuid: "r2",
        session_id: "claude-session",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "plan-1",
            content: "Plan accepted",
          }],
        },
      },
    ];
    const [nativeTurn] = claudeNativeTurns(messages);
    const imported = store.materializeNativeSession({
      harnessTargetId: "claude",
      harness: "claude-code",
      nativeSessionId: "claude-imported",
      cwd: "/repo",
      turns: [nativeTurn!],
    }).session;

    const live = store.createSession({ cwd: "/repo" });
    const turnId = "t-live";
    live.append({
      kind: "user_message",
      source: { type: "user" },
      harness: "claude-code",
      harnessTargetId: "claude",
      turnId,
      payload: {
        messageId: "u1",
        content: [{ type: "text", text: "inspect the cache" }],
      },
    });
    live.append({
      kind: "state_update",
      source: { type: "baton" },
      harness: "claude-code",
      harnessTargetId: "claude",
      turnId,
      payload: { state: "running" },
    });
    const adapter = new ClaudeAdapter({ openInteraction });
    const drafts: AnyEventDraft[] = [];
    const runtime = {
      cwd: "/repo",
      suppressedToolIds: new Set<string>(),
      capturedProposedPlanKeys: new Set<string>(),
      claudeSessionId: "claude-session",
      tasks: new Map(),
      pendingTaskOps: new Map(),
    };
    const turn = { turnId, finalized: false, cancelRequested: false };
    const feed = (
      adapter as unknown as {
        handleMessage: (
          runtime: unknown,
          emit: (event: AnyEventDraft) => void,
          message: unknown,
          turn: unknown,
        ) => void;
      }
    ).handleMessage.bind(adapter, runtime, (event) => drafts.push(event));
    feed({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Tracing the cache key" },
      },
    }, turn);
    for (const message of messages.slice(1)) feed(message, turn);
    feed({
      type: "result",
      subtype: "success",
      usage: undefined,
      modelUsage: {},
    }, turn);
    for (const draft of drafts) {
      live.append({
        ...draft,
        source: { type: "harness", harnessTargetId: "claude" },
        harness: "claude-code",
        harnessTargetId: "claude",
        turnId,
      });
    }
    live.summarizeTurnEvent(turnId);

    const liveContent = logicalContent(live);
    expect(logicalContent(imported)).toEqual({
      ...liveContent,
      turnSummaries: liveContent.turnSummaries.map((summary) => ({
        ...summary,
        stopReason: "unknown",
      })),
    });
  });

  test("forking a native id materializes a source, then uses ordinary Baton fork", () => {
    const root = mkdtempSync(`${tmpdir()}/baton-native-fork-`);
    roots.push(root);
    const store = new SessionStore(root);
    const match: ResolvedNativeSession = {
      ...source("claude", provider({})),
      snapshot: info("claude-source"),
    };

    const imported = materializeNativeSession(store, match, { cwd: "/fallback" });
    const batonChild = store.forkSession(imported.session.id, { cwd: "/target" });

    expect(imported.session.meta.adoptedFrom?.session.identity.id).toBe("claude-source");
    expect(imported.session.meta.harnessSessions.claude?.harnessSessionId).toBe("claude-source");
    expect(batonChild.meta.forkedFrom?.batonSessionId).toBe(imported.session.id);
    expect(batonChild.meta.adoptedFrom).toBeUndefined();
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

  test("store materialization atomically reuses one native session owner", () => {
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
    const first = store.materializeNativeSession(materialization);
    const second = store.materializeNativeSession(materialization);

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.meta.adoptedFrom?.session.identity.id).toBe("thread-1");
    expect(second.session.meta.harnessSessions.codex?.harnessSessionId).toBe("thread-1");
  });

  test("a live cross-process materialization lock fails before creating an owner", () => {
    const root = mkdtempSync(`${tmpdir()}/baton-native-lock-`);
    roots.push(root);
    writeFileSync(`${root}/native-session.lock`, String(process.pid));
    const store = new SessionStore(root);

    expect(() =>
      store.materializeNativeSession({
        harnessTargetId: "codex",
        harness: "codex",
        nativeSessionId: "thread-1",
        cwd: "/repo",
        turns: [],
      }),
    ).toThrow(/another baton process is adopting/);
    expect(store.listSessions()).toHaveLength(0);
  });
});
