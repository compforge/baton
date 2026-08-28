// DeepSeek Harness Agent SDK adapter：DSH 原生 session/event 协议只在本目录出现，
// controller / store / TUI 继续只消费 Baton Event。当前上游 stdio 协议没有 steer、
// interaction 或细粒度 cancel；取消通过关闭 runtime 收口，后续 turn 用同一 session id 重连。

import {
  DshClient,
  type ContentBlock as DshContentBlock,
  type DshClientOptions,
  type DshEvent,
  type DshInput,
  type DshRunResult,
} from "@compforge/dsh-agent-sdk";

import { newId } from "../../event/ids.ts";
import { planEntriesWithIds } from "../../event/plan.ts";
import type {
  ContentBlock,
  StopReason,
  ToolKind,
  UsageUpdate,
} from "../../event/index.ts";
import type { LogSink } from "../../logging.ts";
import {
  type AdapterCapabilities,
  type HarnessEventSink,
  type HarnessAdapter,
  type HarnessSessionBindingSink,
  type HarnessSessionHandle,
  type NativeEventSink,
  type OpenOptions,
  type PromptInput,
  type SendTurnReceipt,
  unsupportedPromptBlocks,
} from "../adapter.ts";
import {
  type HarnessResumeState,
  sessionIdFromResumeState,
  sessionIdResumeState,
} from "../resume.ts";
import { planSnapshotDraft } from "../plan.ts";

const DSH_REQUEST_TIMEOUT_MS = 15_000;
const DSH_SHUTDOWN_TIMEOUT_MS = 1_000;
const DSH_DISPOSE_EOF_GRACE_MS = 6_000;
const DSH_DISPOSE_GRACE_MS = 3_000;

function dshSetupError(): Error {
  const technical = new Error(
    "DeepSeek Harness Target command is missing; expected command to contain the JSON-RPC runtime executable and Cordis config path",
  );
  // Controller displays the outer message in the timeline and preserves this
  // technical cause in session.log for troubleshooting.
  return new Error([
    "DeepSeek Harness needs a one-time setup before it can run.",
    "",
    "1. Install the runtime:",
    "   python -m pip install deepseek-harness-sdk",
    "2. Print the installed runtime and Cordis config paths:",
    "   python -c \"from deepseek_harness_runtime import bundled_runtime_path, bundled_default_config_path; print(bundled_runtime_path()); print(bundled_default_config_path())\"",
    "3. Open ~/.baton/config.yaml and copy those two paths into:",
    "   targets:",
    "     dsh:",
    "       harness: dsh",
    "       command: [/runtime/path/from-step-2, /cordis/config/path/from-step-2]",
    "4. Set DEEPSEEK_API_KEY, restart Baton, then run /dsh again.",
    "",
    "Guide: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.md",
  ].join("\n"), { cause: technical });
}

export interface DshTurnLike extends AsyncIterable<DshEvent> {
  readonly result: Promise<DshRunResult>;
}

export interface DshSessionLike {
  readonly id: string;
  send(input: DshInput): DshTurnLike;
}

export interface DshClientLike {
  start(): Promise<void>;
  session(sessionId?: string): DshSessionLike;
  close(): Promise<void>;
}

export type DshClientFactory = (options: DshClientOptions) => DshClientLike;

export interface DshAdapterOptions {
  /** 完整启动 argv，例如 ["dsh-jsonrpc-agent", "/path/to/cordis.yml"]。 */
  command?: string[];
  provider?: string;
  model?: string;
  maxTokens?: number;
  log?: LogSink;
  nativeEvent?: NativeEventSink;
  /** HarnessTarget 固定环境；同名项覆盖每次 open 传入的动态环境。 */
  env?: Readonly<Record<string, string>>;
  /** 测试注入点；生产始终创建 @compforge/dsh-agent-sdk DshClient。 */
  clientFactory?: DshClientFactory;
}

interface DshTurnState {
  readonly turnId: string;
  finalized: boolean;
  cancelRequested: boolean;
  sawAgentOutput: boolean;
  stopReason?: StopReason;
  failure?: { code?: string; message: string };
  errorEmitted?: boolean;
  planId?: string;
  readonly assistantMessageIds: Map<string, string>;
  readonly thoughtMessageIds: Map<string, string>;
  readonly toolCallIds: Map<string, string>;
  readonly toolArguments: Map<string, string>;
  readonly usageSteps: Set<string>;
}

interface DshRuntime {
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly sink: HarnessEventSink;
  readonly bindingSink?: HarnessSessionBindingSink;
  sessionId?: string;
  client?: DshClientLike;
  session?: DshSessionLike;
  activeTurn?: DshTurnState;
  requestContext?: DshRequestContext;
  closed: boolean;
}

interface DshRequestContext {
  readonly model: string;
  readonly contextWindow?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textBlocks(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const block = record(candidate);
    return block?.type === "text" && typeof block.text === "string"
      ? [{ type: "text", text: block.text } satisfies ContentBlock]
      : [];
  });
}

function reasoningBlocks(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const block = record(candidate);
    return block?.type === "reasoning" && typeof block.text === "string"
      ? [{ type: "text", text: block.text } satisfies ContentBlock]
      : [];
  });
}

function contentText(value: unknown): string {
  return textBlocks(value)
    .map((block) => text(record(block)?.text))
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

function usagePayload(value: unknown): UsageUpdate | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const mapped: UsageUpdate = {
    inputTokens: finiteNumber(usage.inputTokens),
    outputTokens: finiteNumber(usage.outputTokens),
    cacheReadTokens: finiteNumber(usage.cacheReadTokens),
    cacheWriteTokens: finiteNumber(usage.cacheWriteTokens),
    reasoningTokens: finiteNumber(usage.reasoningTokens),
  };
  return Object.values(mapped).some((count) => count !== undefined) ? mapped : undefined;
}

function contextUsed(usage: UsageUpdate | undefined): number | undefined {
  if (usage?.inputTokens === undefined) return undefined;
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

function requestContextFromResumeState(
  state: HarnessResumeState | undefined,
): DshRequestContext | undefined {
  if (state?.version !== 1) return undefined;
  const data = record(state.data);
  const requestContext = record(data?.requestContext);
  const model = text(requestContext?.model);
  if (!model) return undefined;
  const contextWindow = finiteNumber(requestContext?.contextWindow);
  return {
    model,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

function dshResumeState(
  sessionId: string,
  requestContext?: DshRequestContext,
): HarnessResumeState {
  if (!requestContext) return sessionIdResumeState(sessionId);
  return {
    version: 1,
    data: { sessionId, requestContext },
  };
}

function dshStopReason(reason: unknown): StopReason {
  const kind = text(record(reason)?.kind);
  switch (kind) {
    case "completed":
      return "end_turn";
    case "max-tokens":
      return "max_tokens";
    case "aborted":
    case "interrupted":
      return "cancelled";
    case "blocked":
      return "refusal";
    case "error":
      return "error";
    default:
      return (kind ?? "unknown") as StopReason;
  }
}

function dshFailure(reason: unknown): { code?: string; message: string } | undefined {
  const error = record(record(reason)?.error);
  const message = text(error?.message);
  if (!message) return undefined;
  const code = text(error?.code);
  return { ...(code ? { code } : {}), message };
}

function nativeStepKey(data: Record<string, unknown>): string {
  return `${String(data.turn ?? "unknown")}:${String(data.step ?? "unknown")}`;
}

function mappedId(map: Map<string, string>, nativeId: string, prefix: "m" | "tc"): string {
  const existing = map.get(nativeId);
  if (existing) return existing;
  const id = newId(prefix);
  map.set(nativeId, id);
  return id;
}

function toolKind(name: string): ToolKind {
  const normalized = name.toLowerCase();
  if (/read|cat|view/.test(normalized)) return "read";
  if (/write|edit|patch/.test(normalized)) return "edit";
  if (/grep|glob|search|find/.test(normalized)) return "search";
  if (/bash|shell|terminal|exec|run/.test(normalized)) return "execute";
  if (/fetch|http|web/.test(normalized)) return "fetch";
  return "other";
}

/** Baton PromptBlock admission and DSH content lowering, exported for contract tests. */
export function dshPromptInput(blocks: PromptInput["blocks"]): DshContentBlock[] {
  return blocks.map((block) => {
    if (block.type !== "text") {
      throw new Error(`dsh prompt block was not admitted: ${block.type}`);
    }
    return { type: "text", text: block.text };
  });
}

export class DshAdapter implements HarnessAdapter {
  readonly harness = "deepseek-harness";
  readonly capabilities: AdapterCapabilities = { prompt: {} };

  private readonly sessions = new Map<string, DshRuntime>();

  constructor(private readonly options: DshAdapterOptions = {}) {}

  async open(
    opts: OpenOptions,
    sink: HarnessEventSink,
    binding?: HarnessSessionBindingSink,
  ): Promise<HarnessSessionHandle> {
    const handleId = newId("hs");
    const requestedSessionId = opts.resumeState
      ? sessionIdFromResumeState(opts.resumeState)
      : opts.resumeSessionId;
    const requestContext = requestContextFromResumeState(opts.resumeState);
    const runtime: DshRuntime = {
      cwd: opts.cwd,
      ...(opts.env || this.options.env
        ? { env: { ...opts.env, ...this.options.env } }
        : {}),
      sink,
      ...(binding ? { bindingSink: binding } : {}),
      ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
      ...(requestContext ? { requestContext } : {}),
      closed: false,
    };
    this.sessions.set(handleId, runtime);
    try {
      await this.ensureSession(runtime);
      return {
        harness: this.harness,
        handleId,
        resumed: requestedSessionId !== undefined,
      };
    } catch (error) {
      this.sessions.delete(handleId);
      await this.disposeClient(runtime);
      throw error;
    }
  }

  async sendTurn(
    ref: HarnessSessionHandle,
    input: PromptInput,
  ): Promise<SendTurnReceipt> {
    const runtime = this.mustSession(ref);
    const unsupported = unsupportedPromptBlocks(input.blocks, this.capabilities);
    if (unsupported.length) {
      throw new Error(`dsh adapter does not support prompt block type(s): ${unsupported.join(", ")}`);
    }
    if (runtime.activeTurn && !runtime.activeTurn.finalized) {
      return {
        accepted: false,
        effective: "rejected",
        reason: "DeepSeek Harness stdio runtime does not support same-turn steering",
      };
    }

    const session = await this.ensureSession(runtime);
    const turn: DshTurnState = {
      turnId: input.turnId,
      finalized: false,
      cancelRequested: false,
      sawAgentOutput: false,
      assistantMessageIds: new Map(),
      thoughtMessageIds: new Map(),
      toolCallIds: new Map(),
      toolArguments: new Map(),
      usageSteps: new Set(),
    };
    const nativeTurn = session.send(dshPromptInput(input.blocks));
    runtime.activeTurn = turn;
    void this.consumeTurn(runtime, turn, nativeTurn);
    return { accepted: true, effective: "new_turn" };
  }

  async cancel(ref: HarnessSessionHandle): Promise<void> {
    const runtime = this.mustSession(ref);
    const turn = runtime.activeTurn;
    if (!turn || turn.finalized) return;
    turn.cancelRequested = true;
    await this.disposeClient(runtime);
    this.finishTurn(runtime, turn, "cancelled");
  }

  async close(ref: HarnessSessionHandle): Promise<void> {
    const runtime = this.sessions.get(ref.handleId);
    if (!runtime) return;
    this.sessions.delete(ref.handleId);
    runtime.closed = true;
    const turn = runtime.activeTurn;
    if (turn) turn.cancelRequested = true;
    await this.disposeClient(runtime);
    if (turn) this.finishTurn(runtime, turn, "cancelled");
  }

  private mustSession(ref: HarnessSessionHandle): DshRuntime {
    const runtime = this.sessions.get(ref.handleId);
    if (!runtime || runtime.closed) throw new Error(`unknown dsh session: ${ref.handleId}`);
    return runtime;
  }

  private clientOptions(runtime: DshRuntime): DshClientOptions {
    const [command, ...args] = this.options.command ?? [];
    if (!command?.trim()) {
      throw dshSetupError();
    }
    return {
      runtime: {
        command,
        ...(args.length ? { args } : {}),
        cwd: runtime.cwd,
        env: { ...process.env, ...runtime.env },
        // session activity itself remains unbounded; this timeout only bounds
        // initialize and other finite JSON-RPC request/receipt exchanges.
        requestTimeoutMs: DSH_REQUEST_TIMEOUT_MS,
        shutdownTimeoutMs: DSH_SHUTDOWN_TIMEOUT_MS,
        disposeEofGraceMs: DSH_DISPOSE_EOF_GRACE_MS,
        disposeGraceMs: DSH_DISPOSE_GRACE_MS,
      },
      cwd: runtime.cwd,
      ...(this.options.provider ? { provider: this.options.provider } : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens }),
    };
  }

  private async ensureSession(runtime: DshRuntime): Promise<DshSessionLike> {
    if (runtime.session) return runtime.session;
    const factory = this.options.clientFactory ?? ((options) => new DshClient(options));
    const client = factory(this.clientOptions(runtime));
    runtime.client = client;
    try {
      await client.start();
      const session = client.session(runtime.sessionId);
      runtime.session = session;
      runtime.sessionId = session.id;
      this.publishBinding(runtime);
      return session;
    } catch (error) {
      runtime.client = undefined;
      runtime.session = undefined;
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async disposeClient(runtime: DshRuntime): Promise<void> {
    const client = runtime.client;
    runtime.client = undefined;
    runtime.session = undefined;
    if (!client) return;
    try {
      await client.close();
    } catch (error) {
      this.options.log?.({
        level: "warn",
        source: "harness",
        component: "dsh.runtime.close",
        harness: this.harness,
        turnId: runtime.activeTurn?.turnId,
        message: "DeepSeek Harness runtime did not close cleanly",
        error: { message: errorMessage(error) },
      });
    }
  }

  private async consumeTurn(
    runtime: DshRuntime,
    turn: DshTurnState,
    nativeTurn: DshTurnLike,
  ): Promise<void> {
    try {
      for await (const notification of nativeTurn) {
        if (turn.finalized) continue;
        this.handleNotification(runtime, turn, notification);
      }
      const result = await nativeTurn.result;
      if (!turn.sawAgentOutput && result.finalResponse.trim()) {
        turn.sawAgentOutput = true;
        this.emit(
          runtime,
          turn,
          {
            kind: "agent_message",
            payload: {
              messageId: mappedId(turn.assistantMessageIds, "result", "m"),
              content: [{ type: "text", text: result.finalResponse }],
            },
          },
          result,
        );
      }
      if (turn.failure) this.emitTurnError(runtime, turn, turn.failure);
      this.finishTurn(
        runtime,
        turn,
        turn.cancelRequested ? "cancelled" : (turn.stopReason ?? "end_turn"),
      );
    } catch (error) {
      if (turn.cancelRequested || runtime.closed) {
        this.finishTurn(runtime, turn, "cancelled");
        return;
      }
      this.emitTurnError(runtime, turn, { message: errorMessage(error) });
      this.finishTurn(runtime, turn, "error");
    }
  }

  private handleNotification(runtime: DshRuntime, turn: DshTurnState, notification: DshEvent): void {
    this.options.nativeEvent?.({
      direction: "in",
      name: notification.method,
      payload: notification,
    });
    const params = notification.params;
    if (notification.method === "subagent.started") {
      const childSessionId = text(params.childSessionId);
      if (!childSessionId) return;
      this.emit(
        runtime,
        turn,
        {
          kind: "task_update",
          payload: {
            taskId: childSessionId,
            status: "in_progress",
            title: "DeepSeek Harness subagent",
            taskType: "dsh-subagent",
            skipTranscript: true,
          },
          parentSessionId: text(params.parentSessionId),
          agentId: childSessionId,
        },
        notification,
      );
      return;
    }
    if (notification.method === "subagent.finished") {
      const childSessionId = text(params.childSessionId);
      if (!childSessionId) return;
      const summary = contentText(params.lastAssistantMessage);
      this.emit(
        runtime,
        turn,
        {
          kind: "task_update",
          payload: {
            taskId: childSessionId,
            status: params.status === "ok" ? "completed" : "failed",
            title: "DeepSeek Harness subagent",
            taskType: text(params.provider) ?? "dsh-subagent",
            ...(summary ? { summary } : {}),
            skipTranscript: true,
          },
          parentSessionId: text(params.parentSessionId),
          agentId: text(params.agentId) ?? childSessionId,
        },
        notification,
      );
      return;
    }
    if (notification.method !== "session.event") return;
    // SDK 同时转发已发现子 agent 的 session.event；子 agent 只投影为 task_update，
    // 避免把其内部 transcript 混入根会话时间线。完整 wire 仍保留在 native trace。
    if (text(params.sessionId) !== runtime.sessionId) return;
    const event = record(params.event);
    const data = record(event?.data);
    const eventType = text(event?.type);
    if (!data || !eventType) return;
    this.handleSessionEvent(runtime, turn, eventType, data, notification);
  }

  private handleSessionEvent(
    runtime: DshRuntime,
    turn: DshTurnState,
    eventType: string,
    data: Record<string, unknown>,
    raw: DshEvent,
  ): void {
    const stepKey = nativeStepKey(data);
    if (eventType === "request/context") {
      const model = text(data.model);
      if (!model) return;
      const contextWindow = finiteNumber(data.contextWindow);
      runtime.requestContext = {
        model,
        ...(contextWindow === undefined ? {} : { contextWindow }),
      };
      // DSH only records request/context when the route changes. Persist the
      // latest value with the native session checkpoint so a resumed Adapter
      // can keep reporting the window even when DSH correctly deduplicates it.
      this.publishBinding(runtime);
      return;
    }

    if (eventType === "assistant/chunk") {
      const chunk = record(data.chunk);
      const chunkType = text(chunk?.type);
      if (chunkType === "text-delta" && typeof chunk?.text === "string") {
        turn.sawAgentOutput = true;
        this.emit(runtime, turn, {
          kind: "agent_message_chunk",
          payload: {
            messageId: mappedId(turn.assistantMessageIds, stepKey, "m"),
            content: { type: "text", text: chunk.text },
          },
        }, raw);
      } else if (chunkType === "reasoning-delta" && typeof chunk?.text === "string") {
        this.emit(runtime, turn, {
          kind: "agent_thought_chunk",
          payload: {
            messageId: mappedId(turn.thoughtMessageIds, stepKey, "m"),
            content: { type: "text", text: chunk.text },
          },
        }, raw);
      } else if (chunkType === "tool-call-delta" && typeof chunk?.id === "string") {
        const nativeId = chunk.id;
        const toolCallId = mappedId(turn.toolCallIds, nativeId, "tc");
        const rawInput = `${turn.toolArguments.get(nativeId) ?? ""}${text(chunk.argumentsDelta) ?? ""}`;
        turn.toolArguments.set(nativeId, rawInput);
        const name = text(chunk.name);
        this.emit(runtime, turn, {
          kind: "tool_call_update",
          payload: {
            toolCallId,
            ...(name ? { title: name, kind: toolKind(name) } : {}),
            status: "in_progress",
            rawInput,
          },
        }, raw);
      } else if (chunkType === "usage") {
        const usage = usagePayload(chunk?.usage);
        if (usage) {
          turn.usageSteps.add(stepKey);
          this.emit(runtime, turn, { kind: "usage_update", payload: usage }, raw);
        }
      }
      return;
    }

    if (eventType === "assistant/message") {
      const message = record(data.message);
      const content = message?.content;
      const visible = textBlocks(content);
      if (visible.length) {
        turn.sawAgentOutput = true;
        this.emit(runtime, turn, {
          kind: "agent_message",
          payload: { messageId: mappedId(turn.assistantMessageIds, stepKey, "m"), content: visible },
        }, raw);
      }
      const reasoning = reasoningBlocks(content);
      if (reasoning.length) {
        this.emit(runtime, turn, {
          kind: "agent_thought",
          payload: { messageId: mappedId(turn.thoughtMessageIds, stepKey, "m"), content: reasoning },
        }, raw);
      }
      const usage = usagePayload(data.usage);
      if (usage) {
        if (!turn.usageSteps.has(stepKey)) {
          turn.usageSteps.add(stepKey);
          this.emit(runtime, turn, { kind: "usage_update", payload: usage }, raw);
        }
        const used = contextUsed(usage);
        if (used !== undefined && runtime.requestContext?.contextWindow !== undefined) {
          this.emit(runtime, turn, {
            kind: "context_window_update",
            payload: {
              modelSelection: this.options.model ?? "default",
              effectiveModel: runtime.requestContext.model,
              usedTokens: used,
              capacityTokens: runtime.requestContext.contextWindow,
            },
          }, raw);
        }
      }
      return;
    }

    if (eventType === "tool/call") {
      const nativeId = text(data.callId);
      const name = text(data.name);
      if (!nativeId || !name) return;
      this.emit(runtime, turn, {
        kind: "tool_call_update",
        payload: {
          toolCallId: mappedId(turn.toolCallIds, nativeId, "tc"),
          title: name,
          kind: toolKind(name),
          status: "in_progress",
          rawInput: data.arguments,
        },
      }, raw);
      return;
    }

    if (eventType === "tool/result") {
      const message = record(data.message);
      const resultBlock = Array.isArray(message?.content) ? record(message.content[0]) : undefined;
      const nativeId = text(resultBlock?.toolCallId);
      if (!nativeId) return;
      const content = textBlocks(resultBlock?.content);
      const failed = resultBlock?.isError === true || data.error !== undefined;
      this.emit(runtime, turn, {
        kind: "tool_call_update",
        payload: {
          toolCallId: mappedId(turn.toolCallIds, nativeId, "tc"),
          status: failed ? "failed" : "completed",
          ...(content.length ? { content } : {}),
          rawOutput: resultBlock?.content,
        },
      }, raw);
      return;
    }

    if (eventType === "todo/write" && Array.isArray(data.todos)) {
      turn.planId ??= newId("pl");
      const entries = planEntriesWithIds(turn.planId, data.todos.flatMap((candidate) => {
        const todo = record(candidate);
        const content = text(todo?.content);
        const status = text(todo?.status);
        if (
          !content ||
          (status !== "pending" && status !== "in_progress" && status !== "completed")
        ) {
          return [];
        }
        return [{ content, status, priority: "medium" }];
      }));
      this.emit(runtime, turn, planSnapshotDraft(turn.planId, entries), raw);
      return;
    }

    if (eventType === "turn/end") {
      turn.stopReason = dshStopReason(data.reason);
      turn.failure = dshFailure(data.reason);
    }
  }

  private emitTurnError(
    runtime: DshRuntime,
    turn: DshTurnState,
    failure: { code?: string; message: string },
  ): void {
    if (turn.errorEmitted || turn.finalized) return;
    turn.errorEmitted = true;
    this.emit(runtime, turn, {
      kind: "_baton_error_update",
      payload: { ...(failure.code ? { code: failure.code } : {}), message: failure.message },
    });
  }

  private publishBinding(runtime: DshRuntime): void {
    if (!runtime.sessionId) return;
    runtime.bindingSink?.({
      identity: { id: runtime.sessionId },
      resumeState: dshResumeState(runtime.sessionId, runtime.requestContext),
    });
  }

  private finishTurn(runtime: DshRuntime, turn: DshTurnState, stopReason: StopReason): void {
    if (turn.finalized) return;
    turn.finalized = true;
    this.emit(runtime, turn, {
      kind: "state_update",
      payload: { state: "idle", stopReason },
    });
    if (runtime.activeTurn === turn) runtime.activeTurn = undefined;
  }

  private emit(
    runtime: DshRuntime,
    turn: DshTurnState,
    event: Parameters<HarnessEventSink>[0],
    raw?: unknown,
  ): void {
    runtime.sink({
      ...event,
      harnessSessionId: runtime.sessionId,
      turnId: turn.turnId,
      ...(raw === undefined ? {} : { raw }),
    });
  }
}
