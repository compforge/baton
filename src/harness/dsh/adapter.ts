// DeepSeek Harness Agent SDK adapter：DSH 原生 session/event 协议只在本目录出现，
// controller / store / TUI 继续只消费 Baton Event。追加走 SDK 原生 inbox；
// 取消仍通过关闭 runtime 收口，后续 turn 用同一 session id 重连。

import {
  DeepSeekHarness,
  type DeepSeekHarnessOptions,
  type HarnessNotification,
} from "@deepseek-ai/dsh-sdk-client";

import type { DshTargetConfig } from "./config.ts";
import { dshPromptInput } from "./prompt.ts";
import { DshActivity, type DshTransport } from "./activity.ts";

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

export interface DshSessionLike {
  readonly id: string;
}

export interface DshClientLike {
  readonly client: DshTransport;
  start(): Promise<void>;
  session(sessionId?: string): DshSessionLike;
  close(): Promise<void>;
}

export type DshClientFactory = (options: DeepSeekHarnessOptions) => DshClientLike;

export interface DshAdapterOptions extends DshTargetConfig {
  log?: LogSink;
  nativeEvent?: NativeEventSink;
  /** HarnessTarget 固定环境；同名项覆盖每次 open 传入的动态环境。 */
  env?: Readonly<Record<string, string>>;
  /** 测试注入点；生产直接使用官方 DeepSeekHarness。 */
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
  activity?: DshActivity;
  closing?: Promise<void>;
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

/** DSH persists tool arguments as JSON text; normalize them at the wire boundary. */
function toolInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return record(parsed) ?? value;
  } catch {
    // Streaming argument fragments are intentionally retained until valid JSON arrives.
    return value;
  }
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

export class DshAdapter implements HarnessAdapter {
  readonly harness = "deepseek-harness";
  readonly capabilities: AdapterCapabilities = { prompt: { image: { supported: true } } };

  readonly steering = { deliveryTracking: "explicit", cancelOwnership: "survives" } as const;

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
    // Core may release a cancelled turn after its grace period. A different turn
    // must wait for teardown rather than losing its queued input to a busy rejection.
    if (runtime.closing && runtime.activeTurn?.turnId !== input.turnId) await runtime.closing;
    const active = runtime.activeTurn;
    const blocks = await dshPromptInput(input.blocks);
    if (active) {
      if (runtime.activeTurn !== active || active.finalized || active.cancelRequested || runtime.closing || active.turnId !== input.turnId) {
        return { accepted: false, effective: "rejected", reason: "DSH turn is ending or does not match" };
      }
      runtime.activity!.submit(input.messageId, blocks, true);
      // 原生接受只代表 Baton 承担投递责任；ack 之后是否 applied 由
      // input_delivery_update 决定。Core 只为 Queue 驱动的新 Turn 落 user_message，
      // same-turn steer 必须由 Adapter 补 delivery:"steer" 的用户消息，
      // 否则 applied 后它既离开 Queue 又无从进入 Transcript。
      this.emit(runtime, active, {
        kind: "user_message",
        payload: {
          messageId: input.messageId,
          content: input.blocks,
          delivery: "steer",
        },
      });
      return { accepted: true, effective: "steer" };
    }
    const session = await this.ensureSession(runtime);
    if (runtime.closed) throw new Error("DSH session was closed during admission");
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
    runtime.activeTurn = turn;
    const activity = new DshActivity(runtime.client!.client, session.id,
      (notification) => { if (!turn.finalized) this.handleNotification(runtime, turn, notification); },
      (messageId, state, detail, raw) => {
        this.emit(runtime, turn, { kind: "input_delivery_update", payload: { messageId, state, ...(detail ? { detail } : {}) } }, raw);
        if (state === "uncertain") this.emit(runtime, turn, { kind: "_baton_notice", payload: {
          level: "warning", title: "DSH input delivery is uncertain",
          detail: `${messageId}: ${detail}. Confirm its result before sending it again.`,
        } });
      },
    );
    runtime.activity = activity;
    activity.submit(input.messageId, blocks, false);
    void this.consumeTurn(runtime, turn, activity);
    return { accepted: true, effective: "new_turn" };
  }

  async cancel(ref: HarnessSessionHandle): Promise<void> {
    const runtime = this.mustSession(ref);
    const turn = runtime.activeTurn;
    if (!turn || turn.finalized) return;
    turn.cancelRequested = true;
    await this.stopTurn(runtime, turn);
  }

  async close(ref: HarnessSessionHandle): Promise<void> {
    const runtime = this.sessions.get(ref.handleId);
    if (!runtime) return;
    this.sessions.delete(ref.handleId);
    runtime.closed = true;
    const turn = runtime.activeTurn;
    if (turn) turn.cancelRequested = true;
    if (turn) await this.stopTurn(runtime, turn);
    else await this.disposeClient(runtime);
  }

  private mustSession(ref: HarnessSessionHandle): DshRuntime {
    const runtime = this.sessions.get(ref.handleId);
    if (!runtime || runtime.closed) throw new Error(`unknown dsh session: ${ref.handleId}`);
    return runtime;
  }

  private clientOptions(runtime: DshRuntime): DeepSeekHarnessOptions {
    return {
      dshBin: this.options.dshBin,
      profile: this.options.profile,
      patches: this.options.patches,
      dshHome: this.options.dshHome,
      processCwd: runtime.cwd,
      env: { ...process.env, ...runtime.env },
      // Bound handshakes and enqueue receipts, not the duration of an agent run.
      initializeTimeoutMs: DSH_REQUEST_TIMEOUT_MS,
      requestTimeoutMs: DSH_REQUEST_TIMEOUT_MS,
      shutdownTimeoutMs: DSH_SHUTDOWN_TIMEOUT_MS,
      disposeEofGraceMs: DSH_DISPOSE_EOF_GRACE_MS,
      disposeGraceMs: DSH_DISPOSE_GRACE_MS,
      cwd: runtime.cwd,
      provider: this.options.provider,
      model: this.options.model,
      reasoningEffort: this.options.reasoningEffort as DeepSeekHarnessOptions["reasoningEffort"],
      maxTokens: this.options.maxTokens,
    };
  }

  private async ensureSession(runtime: DshRuntime): Promise<DshSessionLike> {
    if (runtime.closing) await runtime.closing;
    if (runtime.closed) throw new Error("DSH session is closed");
    if (runtime.session) return runtime.session;
    const factory = this.options.clientFactory ?? ((options) => new DeepSeekHarness(options));
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
      try { await this.disposeClient(runtime); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "DSH startup and cleanup failed"); }
      throw error;
    }
  }

  private disposeClient(runtime: DshRuntime): Promise<void> {
    if (runtime.closing) return runtime.closing;
    const client = runtime.client;
    if (!client) return Promise.resolve();
    // Keep the client and the failed close promise until exit is proved. New admission
    // waits here even if Core's cancel grace period has already released its queue.
    runtime.closing = Promise.resolve().then(() => client.close()).then(() => {
      runtime.client = undefined;
      runtime.session = undefined;
      runtime.closing = undefined;
    }, (error: unknown) => {
      this.options.log?.({ level: "error", source: "harness", component: "dsh.runtime.close",
        harness: this.harness, turnId: runtime.activeTurn?.turnId,
        message: "DSH runtime cleanup failed; replacement runtime is blocked",
        error: { message: errorMessage(error) } });
      throw error;
    });
    return runtime.closing;
  }

  private async stopTurn(runtime: DshRuntime, turn: DshTurnState): Promise<void> {
    try {
      await this.disposeClient(runtime);
      runtime.activity?.abandon("runtime closed before a consumption receipt was observed");
      this.finishTurn(runtime, turn, "cancelled");
    } catch (error) {
      runtime.activity?.abandon("runtime cleanup failed; consumption is unknown");
      this.emitTurnError(runtime, turn, { message: errorMessage(error) });
      this.finishTurn(runtime, turn, "error");
      throw error;
    }
  }

  private async consumeTurn(runtime: DshRuntime, turn: DshTurnState, activity: DshActivity): Promise<void> {
    try {
      await activity.done;
      // cancel/close owns the terminal boundary while teardown is in flight.
      if (turn.cancelRequested || runtime.closed) return;
      if (turn.failure) this.emitTurnError(runtime, turn, turn.failure);
      this.finishTurn(runtime, turn, turn.stopReason ?? "end_turn");
    } catch (error) {
      if (turn.cancelRequested || runtime.closed) return;
      this.emitTurnError(runtime, turn, { message: errorMessage(error) });
      try { await this.disposeClient(runtime); }
      catch { /* The retained close promise quarantines this runtime. */ }
      activity.abandon("transport failed before consumption could be confirmed");
      this.finishTurn(runtime, turn, "error");
    }
  }

  private handleNotification(runtime: DshRuntime, turn: DshTurnState, notification: HarnessNotification): void {
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
    raw: HarnessNotification,
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
            rawInput: toolInput(rawInput),
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
          rawInput: toolInput(data.arguments),
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
