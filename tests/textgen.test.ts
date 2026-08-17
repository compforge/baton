// textgen 契约测试：路由器降级链、标题 prompt/sanitize、护栏、两家 adapter 的
// 一次性生成实现（claude 用注入的 queryFactory，codex 用注入的 execFn），以及
// maybeGenerateSessionTitle 端到端（真实 SessionStore + fake candidate）。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { query } from "@anthropic-ai/claude-agent-sdk";

import type {
  AdapterCapabilities,
  HarnessEventSink,
  HarnessAdapter,
  HarnessSessionHandle,
  OpenOptions,
  PromptInput,
  SendTurnReceipt,
  TextgenRequest,
} from "../src/harness/adapter.ts";
import { Controller } from "../src/controller/index.ts";
import {
  codexExecArgs,
  codexTextgenLaunch,
  generateCodexStructured,
} from "../src/harness/codex/textgen.ts";
import { generateClaudeStructured } from "../src/harness/claude/textgen.ts";
import type { HarnessTarget } from "../src/harness/target.ts";
import {
  buildSessionTitlePrompt,
  generateStructuredWithFallback,
  sanitizeSessionTitle,
  SESSION_TITLE_SCHEMA,
  type TextgenCandidate,
} from "../src/harness/textgen.ts";
import {
  canReplaceSessionTitle,
  maybeGenerateSessionTitle,
} from "../src/session/title.ts";
import { sessionPreview, SessionStore } from "../src/store/store.ts";

class StubAdapter implements HarnessAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {}, textgen: { supported: true } };
  requests: TextgenRequest[] = [];

  constructor(
    readonly harness: string,
    private impl: (request: TextgenRequest) => Promise<unknown>,
  ) {}

  async generateStructured(request: TextgenRequest): Promise<unknown> {
    this.requests.push(request);
    return this.impl(request);
  }

  async open(_opts: OpenOptions, _sink: HarnessEventSink): Promise<HarnessSessionHandle> {
    return { harness: this.harness, handleId: `${this.harness}-ref` };
  }
  async sendTurn(_ref: HarnessSessionHandle, _input: PromptInput): Promise<SendTurnReceipt> {
    return { accepted: false, effective: "rejected" };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

/** 未声明 textgen 的 adapter：路由器必须跳过而不是调用。 */
class PlainAdapter extends StubAdapter {
  override readonly capabilities: AdapterCapabilities = { prompt: {} };
  constructor() {
    super("plain", async () => ({}));
  }
}

/** 运行一个真实 Controller Queue-driven Turn，但不启动外部 Harness。 */
class CompletingTextgenAdapter extends StubAdapter {
  private sink?: HarnessEventSink;

  override async open(_opts: OpenOptions, sink: HarnessEventSink): Promise<HarnessSessionHandle> {
    this.sink = sink;
    return { harness: this.harness, handleId: `${this.harness}-ref` };
  }

  override async sendTurn(
    _ref: HarnessSessionHandle,
    input: PromptInput,
  ): Promise<SendTurnReceipt> {
    setTimeout(() => {
      this.sink?.({
        kind: "state_update",
        turnId: input.turnId,
        payload: { state: "idle", stopReason: "end_turn" },
      });
    }, 0);
    return { accepted: true, effective: "new_turn" };
  }
}

const REQUEST = { prompt: "p", jsonSchema: SESSION_TITLE_SCHEMA, cwd: "/repo" };

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition not met in time");
    await Bun.sleep(2);
  }
}

describe("generateStructuredWithFallback", () => {
  test("首选成功则不降级；models 按 harness id 下发", async () => {
    const first = new StubAdapter("claude", async () => ({ title: "t" }));
    const second = new StubAdapter("codex", async () => ({ title: "x" }));
    const result = await generateStructuredWithFallback(
      [
        { harness: "claude", adapter: first },
        { harness: "codex", adapter: second },
      ],
      REQUEST,
      { models: { codex: "m-codex" } },
    );
    expect(result).toEqual({ value: { title: "t" }, harness: "claude" });
    expect(first.requests[0]?.model).toBeUndefined();
    expect(second.requests).toHaveLength(0);
  });

  test("首选失败降级下一家；未声明 textgen 的跳过", async () => {
    const failing = new StubAdapter("claude", async () => {
      throw new Error("quota exhausted");
    });
    const plain = new PlainAdapter();
    const backup = new StubAdapter("codex", async () => ({ title: "backup" }));
    const result = await generateStructuredWithFallback(
      [
        { harness: "claude", adapter: failing },
        { harness: "plain", adapter: plain },
        { harness: "codex", adapter: backup },
      ],
      REQUEST,
      { models: { codex: "m-codex" } },
    );
    expect(result).toEqual({ value: { title: "backup" }, harness: "codex" });
    expect(backup.requests[0]?.model).toBe("m-codex");
  });

  test("全部失败返回 undefined（调用方保留机械兜底）", async () => {
    const a = new StubAdapter("claude", async () => {
      throw new Error("auth");
    });
    const b = new StubAdapter("codex", async () => {
      throw new Error("rate limit");
    });
    const result = await generateStructuredWithFallback(
      [
        { harness: "claude", adapter: a },
        { harness: "codex", adapter: b },
      ],
      REQUEST,
    );
    expect(result).toBeUndefined();
  });
});

describe("sanitizeSessionTitle", () => {
  test("取首行、去引号、压缩空白", () => {
    expect(sanitizeSessionTitle("  \"Fix lazy thread feed\"\nignored")).toBe("Fix lazy thread feed");
    expect(sanitizeSessionTitle("a   b\tc")).toBe("a b c");
  });

  test("超长有界截断；空/非字符串返回 undefined", () => {
    const long = sanitizeSessionTitle("x".repeat(100));
    expect([...(long ?? "")].length).toBeLessThanOrEqual(50);
    expect(long?.endsWith("...")).toBe(true);
    expect(sanitizeSessionTitle("   ")).toBeUndefined();
    expect(sanitizeSessionTitle(undefined)).toBeUndefined();
    expect(sanitizeSessionTitle(42)).toBeUndefined();
  });

  test("低信息占位标题返回 undefined，留给后续 turn 重试", () => {
    expect(sanitizeSessionTitle("开始新的协作会话")).toBeUndefined();
    expect(sanitizeSessionTitle("New Conversation")).toBeUndefined();
  });
});

describe("buildSessionTitlePrompt", () => {
  test("包含用户输入与 durable 编辑规则；超长输入有界", () => {
    const prompt = buildSessionTitlePrompt("fix the flaky login test");
    expect(prompt).toContain("fix the flaky login test");
    expect(prompt).toContain("weeks later");
    expect(prompt.length).toBeLessThan(10_000);
    const huge = buildSessionTitlePrompt("y".repeat(100_000));
    expect(huge.length).toBeLessThan(10_000);
  });
});

describe("canReplaceSessionTitle", () => {
  const userText = "帮我修一下 login 的 flaky test\n第二行补充细节";
  test("空 title 可替换；用户命名不覆盖；机械 preview 可替换", () => {
    expect(canReplaceSessionTitle(undefined, userText)).toBe(true);
    expect(canReplaceSessionTitle("  ", userText)).toBe(true);
    expect(canReplaceSessionTitle("我的会话", userText)).toBe(false);
    expect(canReplaceSessionTitle(sessionPreview(userText), userText)).toBe(true);
  });

  test("历史低信息 textgen 标题可被后续 turn 修正", () => {
    expect(canReplaceSessionTitle("开始新的协作会话", userText)).toBe(true);
  });
});

describe("codex textgen", () => {
  test("argv：ephemeral + read-only + schema/output 文件 + stdin prompt；model 可选", () => {
    const base = codexExecArgs({ ...REQUEST }, "/tmp/s.json", "/tmp/o.json");
    expect(base).toEqual([
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "--output-schema",
      "/tmp/s.json",
      "--output-last-message",
      "/tmp/o.json",
      "-",
    ]);
    const withModel = codexExecArgs({ ...REQUEST, model: "m" }, "/tmp/s.json", "/tmp/o.json");
    expect(withModel).toContain("--model");
    expect(withModel[withModel.indexOf("--model") + 1]).toBe("m");
  });

  test("launch：保留全局参数，只替换 app-server 子命令", () => {
    expect(codexTextgenLaunch(["codex", "app-server"], ["exec", "-"])).toEqual([
      "codex",
      "exec",
      "-",
    ]);
    expect(
      codexTextgenLaunch(
        ["env", "CODEX_HOME=/tmp/codex", "codex", "-c", "foo=true", "app-server", "--stdio"],
        ["exec", "-"],
      ),
    ).toEqual(["env", "CODEX_HOME=/tmp/codex", "codex", "-c", "foo=true", "exec", "-"]);
    expect(() => codexTextgenLaunch(["bun", "fake-server.ts"], ["exec"])).toThrow(
      "must contain app-server",
    );
  });

  test("execFn 注入：读取 output 文件并 parse", async () => {
    const value = await generateCodexStructured(REQUEST, {
      execFn: async (_argv, prompt, outputPath) => {
        expect(prompt).toBe("p");
        const { writeFileSync } = await import("node:fs");
        writeFileSync(outputPath, JSON.stringify({ title: "from codex" }));
      },
    });
    expect(value).toEqual({ title: "from codex" });
  });
});

describe("claude textgen", () => {
  function fakeQueryFactory(messages: unknown[], observe?: (request: unknown) => void): typeof query {
    return ((request: unknown) => {
      observe?.(request);
      const gen = (async function* () {
        for (const message of messages) yield message;
      })();
      return Object.assign(gen, {
        interrupt: async () => undefined,
        close: () => {},
      });
    }) as unknown as typeof query;
  }

  test("result success → 返回 structured_output", async () => {
    let request: unknown;
    const value = await generateClaudeStructured(REQUEST, {
      queryFactory: fakeQueryFactory([
        { type: "assistant", message: {} },
        { type: "result", subtype: "success", structured_output: { title: "from claude" }, errors: [] },
      ], (value) => {
        request = value;
      }),
    });
    expect(value).toEqual({ title: "from claude" });
    expect(request).toMatchObject({
      options: {
        allowedTools: [],
        tools: [],
        mcpServers: {},
        persistSession: false,
        settingSources: [],
      },
    });
  });

  test("error subtype → 带原文上抛（降级由路由器决定）", async () => {
    await expect(
      generateClaudeStructured(REQUEST, {
        queryFactory: fakeQueryFactory([
          { type: "result", subtype: "error_during_execution", errors: ["credit balance too low"] },
        ]),
      }),
    ).rejects.toThrow("credit balance too low");
  });

  test("success 但无 structured_output → 抛错", async () => {
    await expect(
      generateClaudeStructured(REQUEST, {
        queryFactory: fakeQueryFactory([
          {
            type: "result",
            subtype: "success",
            terminal_reason: "api_error",
            result: "Failed to authenticate",
            errors: [],
          },
        ]),
      }),
    ).rejects.toThrow("no structured output (api_error): Failed to authenticate");
  });

  test("超时会 abort 并关闭独立 query", async () => {
    let request: { options?: { abortController?: AbortController } } | undefined;
    let closed = false;
    const queryFactory = ((value: unknown) => {
      request = value as typeof request;
      const gen = (async function* () {
        await new Promise(() => {});
      })();
      return Object.assign(gen, {
        interrupt: async () => undefined,
        close: () => {
          closed = true;
        },
      });
    }) as unknown as typeof query;

    await expect(
      generateClaudeStructured({ ...REQUEST, timeoutMs: 5 }, { queryFactory }),
    ).rejects.toThrow("timed out");
    expect(request?.options?.abortController?.signal.aborted).toBe(true);
    expect(closed).toBe(true);
  });
});

describe("maybeGenerateSessionTitle", () => {
  let root: string;
  let store: SessionStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "baton-textgen-test-"));
    store = new SessionStore(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function sessionWithUserMessage(text: string) {
    const session = store.createSession({ cwd: "/repo" });
    session.appendEvent({
      kind: "user_message",
      source: { type: "user" },
      turnId: "t_1",
      payload: { messageId: "m_1", content: [{ type: "text", text }] },
    });
    return session;
  }

  test("首个用户输入 → 生成并落盘 LLM 标题", async () => {
    const session = sessionWithUserMessage("fix the flaky login test in CI");
    const candidates: TextgenCandidate[] = [
      { harness: "claude", adapter: new StubAdapter("claude", async () => ({ title: "Fix Flaky Login Test" })) },
    ];
    expect(await maybeGenerateSessionTitle({ session, candidates })).toBe(true);
    expect(session.meta.title).toBe("Fix Flaky Login Test");
  });

  test("纯问候不调用 textgen，等待后续消息出现主题", async () => {
    const session = sessionWithUserMessage("你好");
    const stub = new StubAdapter("codex", async () => ({ title: "友好问候" }));

    expect(
      await maybeGenerateSessionTitle({
        session,
        candidates: [{ harness: "codex", adapter: stub }],
      }),
    ).toBe(false);
    expect(stub.requests).toHaveLength(0);
    expect(session.meta.title).toBeUndefined();
  });

  test("后续重试时使用截至当前的用户消息", async () => {
    const session = sessionWithUserMessage("你好");
    session.updateMeta({ title: "开始新的协作会话" });
    session.appendEvent({
      kind: "user_message",
      source: { type: "user" },
      turnId: "t_2",
      payload: {
        messageId: "m_2",
        content: [{ type: "text", text: "baton DeepSeek Harness 访问报错" }],
      },
    });
    const stub = new StubAdapter("codex", async () => ({ title: "排查 DeepSeek Harness 访问报错" }));

    expect(
      await maybeGenerateSessionTitle({
        session,
        candidates: [{ harness: "codex", adapter: stub }],
      }),
    ).toBe(true);
    expect(stub.requests[0]?.prompt).toContain("你好\n\nbaton DeepSeek Harness 访问报错");
    expect(session.meta.title).toBe("排查 DeepSeek Harness 访问报错");
  });

  test("fork 只用分叉后的首个用户输入生成标题", async () => {
    const source = sessionWithUserMessage("investigate the original issue");
    const session = store.forkSession(source.id);
    const forkPrompt = "try the cache approach instead";
    session.setTitleIfEmpty(forkPrompt);
    session.appendEvent({
      kind: "user_message",
      source: { type: "user" },
      turnId: "t_fork",
      payload: { messageId: "m_fork", content: [{ type: "text", text: forkPrompt }] },
    });
    const stub = new StubAdapter("claude", async () => ({ title: "Try Cache Approach" }));

    expect(
      await maybeGenerateSessionTitle({
        session,
        candidates: [{ harness: "claude", adapter: stub }],
      }),
    ).toBe(true);
    expect(session.meta.title).toBe("Try Cache Approach");
    expect(stub.requests[0]?.prompt).toContain(forkPrompt);
    expect(stub.requests[0]?.prompt).not.toContain("investigate the original issue");
  });

  test("首选失败降级 codex；全部失败保留空 title（展示层回落 preview）", async () => {
    const session = sessionWithUserMessage("fix the flaky login test");
    const candidates: TextgenCandidate[] = [
      {
        harness: "claude",
        adapter: new StubAdapter("claude", async () => {
          throw new Error("quota");
        }),
      },
      { harness: "codex", adapter: new StubAdapter("codex", async () => ({ title: "Fix Login Test" })) },
    ];
    expect(await maybeGenerateSessionTitle({ session, candidates })).toBe(true);
    expect(session.meta.title).toBe("Fix Login Test");

    const session2 = sessionWithUserMessage("another task entirely");
    expect(await maybeGenerateSessionTitle({
      session: session2,
      candidates: [
        {
          harness: "claude",
          adapter: new StubAdapter("claude", async () => {
            throw new Error("down");
          }),
        },
      ],
    })).toBe(false);
    expect(session2.meta.title).toBeUndefined();
  });

  test("用户命名不被覆盖；生成期间用户改名后落盘前复查也不覆盖", async () => {
    const session = sessionWithUserMessage("fix the flaky login test");
    session.updateMeta({ title: "我的名字" });
    const stub = new StubAdapter("claude", async () => ({ title: "LLM Title" }));
    expect(
      await maybeGenerateSessionTitle({
        session,
        candidates: [{ harness: "claude", adapter: stub }],
      }),
    ).toBe(false);
    expect(session.meta.title).toBe("我的名字");
    expect(stub.requests).toHaveLength(0);
  });

  test("无真实用户输入（只有 Plugin prompt）不生成", async () => {
    const session = store.createSession({ cwd: "/repo" });
    session.appendEvent({
      kind: "user_message",
      source: { type: "plugin", pluginInstanceId: "reqloop_default" },
      turnId: "t_plugin",
      payload: {
        messageId: "m_plugin",
        content: [{ type: "text", text: "Plugin-scheduled work" }],
      },
    });
    const stub = new StubAdapter("claude", async () => ({ title: "x" }));
    expect(
      await maybeGenerateSessionTitle({
        session,
        candidates: [{ harness: "claude", adapter: stub }],
      }),
    ).toBe(false);
    expect(session.meta.title).toBeUndefined();
    expect(stub.requests).toHaveLength(0);
  });

  test("Controller 主 Queue Turn 触发，遵循 prefer 并在落盘后刷新投影", async () => {
    const session = store.createSession({ cwd: "/repo" });
    let finishTitle!: (value: unknown) => void;
    const titleResult = new Promise<unknown>((resolve) => {
      finishTitle = resolve;
    });
    const codex = new CompletingTextgenAdapter("codex", async () => ({ title: "Codex Title" }));
    const claude = new StubAdapter("claude", async () => titleResult);
    const targets: HarnessTarget[] = [
      { id: "codex", harness: "codex" },
      { id: "claude", harness: "claude" },
      { id: "broken", harness: "broken" },
    ];
    let changes = 0;
    let titleChanges = 0;
    const controller = new Controller({
      session,
      mentionBudgetChars: 4_096,
      resolveTarget: (id) => targets.find((target) => target.id === id),
      createAdapter: (target) => {
        if (target.id === "broken") throw new Error("broken provider config");
        return target.id === "claude" ? claude : codex;
      },
      textgenTargets: targets,
      textgenPrefer: "claude",
      onSessionTitleChange: () => {
        expect(session.meta.title).toBe("Fix Flaky Login Test");
        titleChanges++;
      },
      onChange: () => {
        changes++;
      },
    });

    expect(
      await controller.submit("codex", [{ type: "text", text: "fix the flaky login test" }]),
    ).toBe("completed");
    expect(claude.requests).toHaveLength(1);
    expect(codex.requests).toHaveLength(0);
    const changesBeforeTitle = changes;

    finishTitle({ title: "Fix Flaky Login Test" });
    await until(() => session.meta.title === "Fix Flaky Login Test");
    expect(changes).toBe(changesBeforeTitle + 1);
    expect(titleChanges).toBe(1);

    expect(
      await controller.submit("codex", [{ type: "text", text: "add another assertion" }]),
    ).toBe("completed");
    expect(claude.requests).toHaveLength(1);
    await controller.close();
  });

  test("Controller 低信息结果不锁死，下一个主 Queue Turn 重试", async () => {
    const session = store.createSession({ cwd: "/repo" });
    let generation = 0;
    const adapter = new CompletingTextgenAdapter("codex", async () => {
      generation++;
      return generation === 1
        ? { title: "开始新的协作会话" }
        : { title: "排查 DeepSeek Harness 访问报错" };
    });
    const target: HarnessTarget = { id: "codex", harness: "codex" };
    const controller = new Controller({
      session,
      mentionBudgetChars: 4_096,
      resolveTarget: () => target,
      createAdapter: () => adapter,
      textgenTargets: [target],
    });

    expect(
      await controller.submit("codex", [{ type: "text", text: "我想问个编程问题" }]),
    ).toBe("completed");
    await until(() => adapter.requests.length === 1);
    expect(session.meta.title).toBeUndefined();

    expect(
      await controller.submit("codex", [{ type: "text", text: "baton DeepSeek Harness 访问报错" }]),
    ).toBe("completed");
    await until(() => session.meta.title === "排查 DeepSeek Harness 访问报错");
    expect(adapter.requests).toHaveLength(2);
    await controller.close();
  });
});
