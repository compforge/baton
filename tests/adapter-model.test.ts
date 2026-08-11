import type { OpenInteraction } from "../src/harness/adapter.ts";
import { describe, expect, test } from "bun:test";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

import {
  ClaudeAdapter,
  probeClaudeTarget,
  type ClaudeAdapterOptions,
} from "../src/harness/claude/adapter.ts";
import { CodexAdapter } from "../src/harness/codex/adapter.ts";
import { sessionIdResumeState } from "../src/harness/resume.ts";

const openInteraction: OpenInteraction = async (req) =>
  req.kind === "permission"
    ? { kind: "permission", outcome: "selected", optionId: "deny" }
    : { kind: "question", outcome: "answered", answers: {} };

describe("Claude model capability", () => {
  test("probes the target before the first turn without creating an adapter session", async () => {
    let prompt: unknown;
    let closes = 0;
    const queryFactory: NonNullable<ClaudeAdapterOptions["queryFactory"]> = ((params) => {
      prompt = params.prompt;
      return {
        initializationResult: async () => ({
          models: [
            {
              value: "default",
              resolvedModel: "claude-opus-4-8[1m]",
              displayName: "Default (recommended)",
              description: "Opus 4.8 with 1M context",
              supportedEffortLevels: ["high"],
            },
            {
              value: "claude-fable-5[1m]",
              resolvedModel: "claude-fable-5",
              displayName: "Fable",
              description: "Fable 5",
              supportedEffortLevels: ["high", "max"],
            },
            {
              value: "sonnet",
              resolvedModel: "claude-sonnet-5",
              displayName: "Sonnet",
              description: "Sonnet 5",
              supportedEffortLevels: ["high"],
            },
          ],
        }),
        supportedCommands: async () => [
          { name: "devloop:gcam", description: "Commit changes", argumentHint: "" },
        ],
        close: () => closes++,
      } as unknown as ReturnType<NonNullable<ClaudeAdapterOptions["queryFactory"]>>;
    }) as NonNullable<ClaudeAdapterOptions["queryFactory"]>;
    const discovered = await probeClaudeTarget({ cwd: "/tmp", queryFactory });

    expect(discovered.models?.map((model) => model.id)).toEqual([
      "default",
      "claude-fable-5[1m]",
      "sonnet",
    ]);
    expect(discovered.efforts?.map((effort) => effort.id)).toEqual(["default", "high"]);
    expect(discovered.commands?.map((command) => command.name)).toEqual(["devloop:gcam"]);
    expect(closes).toBe(1);
    expect(typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");

    const adapter = new ClaudeAdapter({ openInteraction });
    const ref = await adapter.open({ cwd: "/tmp" }, () => {});
    await adapter.setModel(ref, "sonnet");
    await adapter.setEffort(ref, "high");
    expect(adapter.currentModel(ref)).toBe("sonnet");
    expect(adapter.currentEffort(ref)).toBe("high");
    await adapter.setModel(ref, "default");
    await adapter.setEffort(ref, "default");
    expect(adapter.currentModel(ref)).toBeNull();
    expect(adapter.currentEffort(ref)).toBeNull();
  });

  test("records a native session id for resume", async () => {
    const adapter = new ClaudeAdapter({ openInteraction });
    const bindings: unknown[] = [];
    const ref = await adapter.open(
      { cwd: "/tmp", resumeState: sessionIdResumeState("claude-session-1") },
      () => {},
      (binding) => bindings.push(binding),
    );
    expect(ref.resumed).toBe(true);
    expect(bindings).toEqual([{
      identity: { id: "claude-session-1" },
      resumeState: sessionIdResumeState("claude-session-1"),
    }]);
  });

  test("generic config returns a full snapshot after mutation", async () => {
    const adapter = new ClaudeAdapter({ openInteraction });
    const ref = await adapter.open({ cwd: "/tmp" }, () => {});
    const runtime = (
      adapter as unknown as {
        sessions: Map<
          string,
          {
            models?: Array<{ id: string; label: string }>;
            modelInfos?: unknown[];
          }
        >;
      }
    ).sessions.get(ref.handleId);
    if (!runtime) throw new Error("missing Claude test runtime");
    runtime.models = [
      { id: "default", label: "Default" },
      { id: "sonnet", label: "Sonnet" },
    ];
    runtime.modelInfos = [
      {
        value: "sonnet",
        displayName: "Sonnet",
        supportedEffortLevels: ["high"],
      },
    ];
    const snapshot = await adapter.setConfig(ref, "model", "sonnet");

    expect(snapshot.find((option) => option.id === "model")).toMatchObject({
      value: "sonnet",
      category: "model",
    });
    expect(snapshot.find((option) => option.id === "effort")).toMatchObject({
      category: "thought_level",
    });
    expect(snapshot.find((option) => option.id === "mode")).toMatchObject({
      value: "default",
      category: "mode",
    });
  });

  test("maps Plan mode to Claude permissionMode", async () => {
    let queryOptions: Parameters<NonNullable<ClaudeAdapterOptions["queryFactory"]>>[0]["options"];
    const queryFactory: NonNullable<ClaudeAdapterOptions["queryFactory"]> = ((params) => {
      queryOptions = params.options;
      const output = (async function* () {})();
      return Object.assign(output, {
        initializationResult: async () => ({ models: [] }),
        close: () => {},
      }) as unknown as Query;
    }) as NonNullable<ClaudeAdapterOptions["queryFactory"]>;
    const adapter = new ClaudeAdapter({ openInteraction, queryFactory });
    const ref = await adapter.open({ cwd: "/tmp" }, () => {});

    const snapshot = await adapter.setConfig(ref, "mode", "plan");
    expect(snapshot.find((option) => option.id === "mode")).toMatchObject({
      value: "plan",
      category: "mode",
    });
    await adapter.sendTurn(ref, {
      turnId: "t_plan",
      messageId: "m_plan",
      blocks: [{ type: "text", text: "design this change" }],
    });
    await Bun.sleep(0);

    expect(queryOptions?.permissionMode).toBe("plan");
  });

  test("omits Claude permissionMode after returning to Default mode", async () => {
    let queryOptions: Parameters<NonNullable<ClaudeAdapterOptions["queryFactory"]>>[0]["options"];
    const queryFactory: NonNullable<ClaudeAdapterOptions["queryFactory"]> = ((params) => {
      queryOptions = params.options;
      const output = (async function* () {})();
      return Object.assign(output, {
        initializationResult: async () => ({ models: [] }),
        close: () => {},
      }) as unknown as Query;
    }) as NonNullable<ClaudeAdapterOptions["queryFactory"]>;
    const adapter = new ClaudeAdapter({ openInteraction, queryFactory });
    const ref = await adapter.open({ cwd: "/tmp" }, () => {});

    await adapter.setConfig(ref, "mode", "plan");
    const snapshot = await adapter.setConfig(ref, "mode", "default");
    expect(snapshot.find((option) => option.id === "mode")?.value).toBe("default");
    await adapter.sendTurn(ref, {
      turnId: "t_default",
      messageId: "m_default",
      blocks: [{ type: "text", text: "implement this change" }],
    });
    await Bun.sleep(0);

    expect(queryOptions?.permissionMode).toBeUndefined();
  });

  test("restores Claude Code prompt and filesystem settings for normal turns", async () => {
    let queryOptions: Parameters<NonNullable<ClaudeAdapterOptions["queryFactory"]>>[0]["options"];
    const queryFactory: NonNullable<ClaudeAdapterOptions["queryFactory"]> = ((params) => {
      queryOptions = params.options;
      return {
        initializationResult: async () => ({ models: [] }),
        close: () => {},
        async *[Symbol.asyncIterator]() {},
      } as unknown as ReturnType<NonNullable<ClaudeAdapterOptions["queryFactory"]>>;
    }) as NonNullable<ClaudeAdapterOptions["queryFactory"]>;
    const adapter = new ClaudeAdapter({ openInteraction, queryFactory });
    const ref = await adapter.open({ cwd: "/tmp" }, () => {});

    await adapter.sendTurn(ref, {
      turnId: "t_1",
      messageId: "m_1",
      blocks: [{ type: "text", text: "hello" }],
    });
    await Bun.sleep(0);

    expect(queryOptions?.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(queryOptions?.settingSources).toEqual(["user", "project", "local"]);
  });

  test("requires an existing native conversation before compacting", async () => {
    const adapter = new ClaudeAdapter({ openInteraction });
    const ref = await adapter.open({ cwd: "/tmp" }, () => {});
    await expect(adapter.compactContext(ref, "t_compact")).rejects.toThrow("no conversation to compact");
  });

  test("rejects efforts unsupported by the selected Claude model", async () => {
    const adapter = new ClaudeAdapter({ openInteraction });
    const ref = await adapter.open({ cwd: "/tmp" }, () => {});
    const runtime = (
      adapter as unknown as {
        sessions: Map<string, { modelInfos?: unknown[] }>;
      }
    ).sessions.get(ref.handleId);
    if (!runtime) throw new Error("missing Claude test runtime");
    runtime.modelInfos = [
      { value: "opus", displayName: "Opus", supportedEffortLevels: ["high"] },
      { value: "haiku", displayName: "Haiku", supportedEffortLevels: ["low"] },
    ];

    await adapter.setModel(ref, "opus");
    await adapter.setEffort(ref, "high");
    await expect(adapter.setEffort(ref, "low")).rejects.toThrow(/does not support effort low/);
    await expect(adapter.setModel(ref, "haiku")).rejects.toThrow(/does not support effort high/);
    expect(adapter.currentModel(ref)).toBe("opus");
    expect(adapter.currentEffort(ref)).toBe("high");
  });
});

describe("Codex model capability", () => {
  test("toggles Fast mode through the current thread settings", async () => {
    const adapter = new CodexAdapter({ openInteraction });
    const requests: Array<{ method: string; params: unknown }> = [];
    const events: Array<{ kind: string; payload: unknown }> = [];
    const peer = {
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "model/list") {
          return {
            data: [{
              id: "gpt-5.6",
              displayName: "GPT-5.6",
              isDefault: true,
              supportedReasoningEfforts: [],
              serviceTiers: [{ id: "priority", name: "Fast", description: "Faster" }],
            }],
          };
        }
        if (method === "thread/settings/update") return {};
        if (method === "collaborationMode/list") return { data: [] };
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const runtime = {
      threadId: "thread-1",
      peer,
      serviceTier: null,
      sink: (event: { kind: string; payload: unknown }) => events.push(event),
    };
    (adapter as unknown as { threads: Map<string, typeof runtime> }).threads.set("thread-1", runtime);
    const ref = { harness: "codex", handleId: "thread-1" };

    const enabled = await adapter.setConfig(ref, "fast", true);
    expect(requests).toContainEqual({
      method: "thread/settings/update",
      params: { threadId: "thread-1", serviceTier: "priority" },
    });
    expect(enabled.find((option) => option.id === "fast")).toMatchObject({ value: true });

    (
      adapter as unknown as {
        handleNotification: (
          runtime: unknown,
          method: string,
          params: unknown,
        ) => void;
      }
    ).handleNotification(runtime, "thread/settings/updated", {
      threadId: "thread-1",
      threadSettings: { serviceTier: "default" },
    });
    expect(events.at(-1)).toMatchObject({
      kind: "config_option_update",
      payload: { options: expect.arrayContaining([expect.objectContaining({ id: "fast", value: false })]) },
    });

    const disabled = await adapter.setConfig(ref, "fast", false);
    expect(requests).toContainEqual({
      method: "thread/settings/update",
      params: { threadId: "thread-1", serviceTier: null },
    });
    expect(disabled.find((option) => option.id === "fast")).toMatchObject({ value: false });
    expect(events.at(-1)).toMatchObject({
      kind: "config_option_update",
      payload: { options: expect.arrayContaining([expect.objectContaining({ id: "fast", value: false })]) },
    });
  });

  test("generic config returns a full snapshot after mutation", async () => {
    const adapter = new CodexAdapter({ openInteraction });
    const peer = {
      request: async (method: string) => {
        if (method === "model/list") {
          return {
            data: [
              {
                id: "gpt-5",
                displayName: "GPT-5",
                isDefault: true,
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              },
            ],
          };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const runtime = { threadId: "thread-1", peer, serviceTier: null, sink: () => undefined };
    (
      adapter as unknown as { threads: Map<string, typeof runtime> }
    ).threads.set("thread-1", runtime);
    const ref = { harness: "codex", handleId: "thread-1" };

    const snapshot = await adapter.setConfig(ref, "model", "gpt-5");
    expect(snapshot.find((option) => option.id === "model")).toMatchObject({
      value: "gpt-5",
      category: "model",
    });
    expect(snapshot.find((option) => option.id === "effort")).toMatchObject({
      category: "thought_level",
    });
  });

  test("maps context compaction to thread/compact/start", async () => {
    const adapter = new CodexAdapter({ openInteraction });
    const requests: Array<{ method: string; params: unknown }> = [];
    const runtime = {
      threadId: "thread-1",
      peer: {
        request: async (method: string, params: unknown) => {
          requests.push({ method, params });
          return {};
        },
      },
    };
    (adapter as unknown as { threads: Map<string, typeof runtime> }).threads.set("thread-1", runtime);
    const ref = { harness: "codex", handleId: "thread-1" };

    await adapter.compactContext(ref, "t_compact");
    await Bun.sleep(0);

    expect(requests).toEqual([{ method: "thread/compact/start", params: { threadId: "thread-1" } }]);
  });

  test("maps Plan mode to Codex collaborationMode", async () => {
    const adapter = new CodexAdapter({ openInteraction });
    const harnessInvocations: Record<string, unknown>[] = [];
    const peer = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "model/list") {
          return {
            data: [{
              id: "gpt-5",
              displayName: "GPT-5",
              isDefault: true,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [],
            }],
          };
        }
        if (method === "collaborationMode/list") {
          return {
            data: [
              { name: "Plan", mode: "plan", reasoning_effort: "medium" },
              { name: "Default", mode: "default", reasoning_effort: null },
            ],
          };
        }
        if (method === "turn/start") {
          harnessInvocations.push(params);
          return { turn: { id: "turn-plan", status: "inProgress" } };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const runtime = { threadId: "thread-1", peer, serviceTier: null, sink: () => undefined };
    (
      adapter as unknown as { threads: Map<string, typeof runtime> }
    ).threads.set("thread-1", runtime);
    const ref = { harness: "codex", handleId: "thread-1" };

    const snapshot = await adapter.setConfig(ref, "mode", "plan");
    expect(snapshot.find((option) => option.id === "mode")).toMatchObject({
      value: "plan",
      category: "mode",
    });
    await adapter.sendTurn(ref, {
      turnId: "t_plan",
      messageId: "m_plan",
      blocks: [{ type: "text", text: "design this change" }],
    });
    await Bun.sleep(0);

    expect(harnessInvocations[0]?.collaborationMode).toEqual({
      mode: "plan",
      settings: {
        model: "gpt-5",
        reasoning_effort: "medium",
        developer_instructions: null,
      },
    });
    expect(harnessInvocations[0]?.model).toBeUndefined();
    expect(harnessInvocations[0]?.effort).toBeUndefined();
  });

  test("rejects an invalid Codex mode before catalog requests", async () => {
    const adapter = new CodexAdapter({ openInteraction });
    const requests: string[] = [];
    const runtime = {
      threadId: "thread-1",
      peer: {
        request: async (method: string) => {
          requests.push(method);
          throw new Error(`unexpected request: ${method}`);
        },
      },
    };
    (adapter as unknown as { threads: Map<string, typeof runtime> }).threads.set("thread-1", runtime);
    const ref = { harness: "codex", handleId: "thread-1" };

    await expect(adapter.setConfig(ref, "mode", "invalid")).rejects.toThrow(
      "Unknown Codex mode: invalid",
    );
    expect(requests).toEqual([]);
  });

  test("keeps the active Codex mode visible during a catalog failure", async () => {
    const adapter = new CodexAdapter({ openInteraction });
    let modeRequests = 0;
    const peer = {
      request: async (method: string) => {
        if (method === "model/list") {
          return {
            data: [{
              id: "gpt-5",
              displayName: "GPT-5",
              isDefault: true,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [],
            }],
          };
        }
        if (method === "collaborationMode/list") {
          modeRequests++;
          if (modeRequests > 1) throw new Error("temporary catalog failure");
          return {
            data: [
              { name: "Plan", mode: "plan", reasoning_effort: "medium" },
              { name: "Default", mode: "default", reasoning_effort: null },
            ],
          };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const runtime = { threadId: "thread-1", peer, serviceTier: null, sink: () => undefined };
    (adapter as unknown as { threads: Map<string, typeof runtime> }).threads.set("thread-1", runtime);
    const ref = { harness: "codex", handleId: "thread-1" };

    const snapshot = await adapter.setConfig(ref, "mode", "plan");
    expect(snapshot.find((option) => option.id === "mode")).toMatchObject({
      value: "plan",
      options: [
        { value: "default", name: "Default" },
        { value: "plan", name: "Plan" },
      ],
    });
  });

  test("normalizes model/list and sends the selected model on the next turn", async () => {
    const adapter = new CodexAdapter({ openInteraction });
    const harnessInvocations: Record<string, unknown>[] = [];
    const peer = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "model/list") {
          return {
            data: [
              {
                id: "gpt-5",
                displayName: "GPT-5",
                description: "default",
                isDefault: true,
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [
                  { reasoningEffort: "low", description: "Fast" },
                  { reasoningEffort: "high", description: "Deep" },
                ],
              },
            ],
          };
        }
        if (method === "turn/start") {
          harnessInvocations.push(params);
          return { turn: { id: "turn-1", status: "completed" } };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const runtime = { threadId: "thread-1", peer };
    (
      adapter as unknown as { threads: Map<string, typeof runtime> }
    ).threads.set("thread-1", runtime);
    const ref = { harness: "codex", handleId: "thread-1" };

    expect((await adapter.listModels(ref)).map((model) => model.id)).toEqual(["default", "gpt-5"]);
    await adapter.setModel(ref, "gpt-5");
    expect((await adapter.listEfforts(ref)).map((effort) => effort.id)).toEqual(["default", "low", "high"]);
    await adapter.setEffort(ref, "high");
    await adapter.sendTurn(ref, {
      turnId: "t_1",
      messageId: "m_1",
      blocks: [{ type: "text", text: "hello" }],
    });
    await Bun.sleep(0); // turn/start 在 submit 回执后异步发出，等微任务刷新

    expect(harnessInvocations[0]?.model).toBe("gpt-5");
    expect(harnessInvocations[0]?.effort).toBe("high");
    await adapter.setEffort(ref, "default");
    expect(adapter.currentEffort(ref)).toBeNull();
    await adapter.sendTurn(ref, {
      turnId: "t_2",
      messageId: "m_2",
      blocks: [{ type: "text", text: "again" }],
    });
    await Bun.sleep(0);
    expect(harnessInvocations[1]?.effort).toBe("medium");
  });

  test("rejects efforts unsupported by the selected Codex model", async () => {
    const adapter = new CodexAdapter({ openInteraction });
    const catalog = {
      data: [
        {
          id: "gpt-5",
          displayName: "GPT-5",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        },
        {
          id: "gpt-5-mini",
          displayName: "GPT-5 mini",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        },
      ],
    };
    const peer = {
      request: async (method: string) => {
        if (method === "model/list") return catalog;
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const runtime = { threadId: "thread-1", peer };
    (
      adapter as unknown as { threads: Map<string, typeof runtime> }
    ).threads.set("thread-1", runtime);
    const ref = { harness: "codex", handleId: "thread-1" };

    await adapter.setModel(ref, "gpt-5");
    await adapter.setEffort(ref, "high");
    await expect(adapter.setEffort(ref, "low")).rejects.toThrow(/does not support effort low/);
    await expect(adapter.setModel(ref, "gpt-5-mini")).rejects.toThrow(/does not support effort high/);
    expect(adapter.currentModel(ref)).toBe("gpt-5");
    expect(adapter.currentEffort(ref)).toBe("high");
  });

  test("delivers BatonSession catch-up via turn/start.additionalContext", async () => {
    // 曾走 thread/inject_items 注入独立 user message：会污染 codex 原生历史（悬空
    // user message），改为随本 turn 的 additionalContext side-channel 送达。
    const adapter = new CodexAdapter({ openInteraction });
    let turnParams: Record<string, unknown> | undefined;
    const peer = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "turn/start") {
          turnParams = params;
          return { turn: { id: "turn-1", status: "inProgress" } };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const runtime = { threadId: "thread-1", peer };
    (
      adapter as unknown as { threads: Map<string, typeof runtime> }
    ).threads.set("thread-1", runtime);
    const ref = { harness: "codex", handleId: "thread-1" };

    expect(adapter.capabilities.sync?.supported).toBe(true);
    await adapter.sendTurn(ref, {
      turnId: "t_1",
      messageId: "m_1",
      blocks: [{ type: "text", text: "hello" }],
      syncBlocks: [{ type: "text", text: "handoff" }],
    });
    await Bun.sleep(0); // turn/start 在 submit 回执后异步发出，等微任务刷新

    expect(turnParams?.input).toEqual([{ type: "text", text: "hello" }]);
    expect(turnParams?.additionalContext).toEqual({
      "baton-sync": { value: "handoff", kind: "untrusted" },
    });
  });

  test("omits additionalContext when there is no catch-up", async () => {
    const adapter = new CodexAdapter({ openInteraction });
    let turnParams: Record<string, unknown> | undefined;
    const peer = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "turn/start") {
          turnParams = params;
          return { turn: { id: "turn-1", status: "inProgress" } };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const runtime = { threadId: "thread-1", peer };
    (
      adapter as unknown as { threads: Map<string, typeof runtime> }
    ).threads.set("thread-1", runtime);

    await adapter.sendTurn(
      { harness: "codex", handleId: "thread-1" },
      {
        turnId: "t_1",
        messageId: "m_1",
        blocks: [{ type: "text", text: "hello" }],
      },
    );
    await Bun.sleep(0);

    expect(turnParams && "additionalContext" in turnParams).toBe(false);
  });
});
