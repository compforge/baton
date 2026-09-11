import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  query,
  type EffortLevel,
  type ModelInfo,
  type ModelUsage,
  type PermissionMode,
  type Query,
  type SDKControlInitializeResponse,
  type SDKContextUsage,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { AvailableCommand, PromptBlock } from "../../event/index.ts";
import type { LogSink } from "../../logging.ts";
import type {
  EffortOption,
  HarnessEventSink,
  HarnessSessionBindingSink,
  ModelOption,
} from "../adapter.ts";
import type { HarnessTargetProbeResult } from "../target.ts";
import type { ClaudeDurableMappingState, TaskEntry, TaskToolOp } from "./mapping.ts";
import { readClaudeSettings } from "./settings.ts";

export interface ClaudeTurn {
  turnId: string;
  /** 保证任何退出路径（result 消息 / 流异常 / 流结束无 result）只发一次终态（见 docs/harness.md） */
  finalized: boolean;
  /** 用户主动中断时，SDK 会以 error result 结束消息流；该错误应归一成 cancelled。 */
  cancelRequested: boolean;
  /** 当前正在流式输出的 assistant 消息的内部 messageId（chunk 与最终 upsert 共用） */
  streamMessageId?: string;
  /** 本 Turn 已收到 SDK 的结构化 /context 快照，result 不再用累计 modelUsage 覆盖它。 */
  structuredContextReported?: boolean;
}

/**
 * result 之后同一条消息流上再出现的活动消息，属于 Harness 自行开始的新 Turn：
 * 后台任务（Agent tool 等）完成时 harness 会在无用户输入的情况下重新唤起模型，
 * 新回合的消息继续从同一条 SDK 流上到达。这里判定"该为它开一个新 turn 了"。
 * system/result 不开界：前者是瞬时相位（不构成回合），后者无活动时只是迟到终态。
 */
export function startsHarnessTurn(msgType: string, current: { finalized: boolean }): boolean {
  return current.finalized && (msgType === "stream_event" || msgType === "assistant" || msgType === "user");
}

export interface ClaudeRuntime extends ClaudeDurableMappingState {
  cwd: string;
  env?: Record<string, string>;
  /** open 时绑定的事件出口；session 生命周期内所有事件（含跨 turn）都走它 */
  sink: HarnessEventSink;
  /** 稳定 HarnessSession 身份一旦可知，立即发布给宿主持久化。 */
  bindingSink?: HarnessSessionBindingSink;
  /** SDK 的 session_id，首个 turn 的 init 消息里拿到；resume 靠它 */
  claudeSessionId?: string;
  publishedSessionId?: string;
  activeQuery?: Query;
  promptChannel?: ClaudePromptChannel;
  /** 当前被接受、尚未逻辑终结的 turn */
  activeTurn?: ClaudeTurn;
  /** query 消费循环当前归属的 Turn；包含没有 Queue item 的 Harness-started Turn。 */
  currentTurn?: ClaudeTurn;
  /** effort 无动态控制接口；变更后在下个新 turn 前重建 streaming query。 */
  queryOptionsDirty?: boolean;
  /** 用户在 baton 中选择的模型；已有 streaming query 通过 setModel 动态更新。 */
  model?: string;
  models?: ModelOption[];
  modelInfos?: ModelInfo[];
  /** 用户在 baton 中选择的推理强度；下次 query 创建时生效。 */
  effort?: EffortLevel;
  /** SDK 报告的实际 effort，仅用于解释 default，不反向固定用户选择。 */
  appliedEffort?: EffortLevel;
  /** Baton 只统一 Claude Code 与 Codex 共有的 Default / Plan 两态。 */
  permissionMode?: Extract<PermissionMode, "default" | "plan">;
  /** 已归一成 plan_update 的 tool_use id：其 tool_result 也要跳过，避免时间线出现重复工具卡 */
  suppressedToolIds: Set<string>;
  /** ExitPlanMode 可能从 assistant message 与 canUseTool 各到一次；按原生 id / 内容双重去重。 */
  capturedProposedPlanKeys: Set<string>;
  /** Task 工具族归一的任务表（跨 turn 持久）：每次成功落账后整表投影成 plan_update */
  tasks: Map<string, TaskEntry>;
  /** tool_use 已登记、等待 tool_result 落账的 Task 操作（key: tool_use_id） */
  pendingTaskOps: Map<string, TaskToolOp>;
  /** 未映射 wire 形状按 key 限流，只在每个 session 首次出现时报警。 */
  unmappedMessageKeys?: Set<string>;
  /**
   * 已 offer 给 streaming input、尚未收到终结 command_lifecycle 的 steer：uuid → 来源
   * turn/message。该表是 Queue 投影的关联事实，不能通过容量淘汰丢失条目；只有
   * started/completed/cancelled/discarded 才终结对应条目。
   * 懒初始化：部分调用方（测试夹具、native import）只构造最小 runtime。
   */
  pendingOfferUuids?: Map<string, {
    turnId: string;
    messageId: string;
    /** started 可能落在后续 harnessTurn turn；保留正文，让该 turn 的 summary 能准确承接。 */
    blocks: PromptBlock[];
  }>;
  /** 主 agent 最近一次 message_start 的当次调用 usage；跨 turn 保留，compact 后由下一次 sample 覆盖。 */
  lastContextSample?: ClaudeContextSample;
  /** 最近一次已发布的 context window；后续 message_start 复用其容量，实时刷新当前占用。 */
  lastContextWindow?: ClaudePublishedContextWindow;
  /** system/init 声明的终端专属 slash command；Baton 作为 SDK host 不展示这些命令。 */
  terminalSlashCommands?: Set<string>;
  /** 最近一次 command catalog；system/init 每 Turn 重发名称时用它保留已知描述。 */
  availableCommands?: Map<string, AvailableCommand>;
  /** 从 .claude/settings.json 读取的 plugins 和 mcpServers 配置 */
  settings?: import("./settings.ts").ClaudeSettings;
}

export interface ClaudePromptChannel {
  stream: AsyncGenerator<SDKUserMessage>;
  offer(message: SDKUserMessage): boolean;
  close(): void;
}

/**
 * Claude Code 的公开 command lifecycle frame。SDK runtime 会 yield 该 frame，但当前
 * TypeScript SDKMessage 联合尚未包含它，因此只在 Adapter wire 边界做窄化。
 */
interface ClaudeCommandLifecycleMessage {
  type: "command_lifecycle";
  uuid: string;
  /**
   * 同一命令在 queued→started→completed 全程稳定的相关联 id，等于 offer 进
   * streaming input 的用户消息 uuid；顶层 `uuid` 是每个 frame 自己的信封 id，
   * 逐帧不同，不能用于匹配 pendingOfferUuids。
   */
  command_uuid?: string;
  state: string;
}

export type ClaudeStreamMessage = SDKMessage | ClaudeCommandLifecycleMessage;

export function claudeCommandLifecycleMessage(value: unknown): ClaudeCommandLifecycleMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const frame = value as Record<string, unknown>;
  if (
    frame.type !== "command_lifecycle" ||
    typeof frame.uuid !== "string" ||
    typeof frame.state !== "string"
  ) {
    return undefined;
  }
  // 保留原始 frame 的其余字段，使 native trace 与 Event.raw 仍是完整 wire 事实。
  return value as ClaudeCommandLifecycleMessage;
}

/** command_lifecycle 的关联键：优先稳定的 command_uuid，回退旧 CLI 只有信封 uuid 的形态。 */
export function commandLifecycleKey(msg: ClaudeCommandLifecycleMessage): string {
  return msg.command_uuid ?? msg.uuid;
}

/**
 * Agent SDK 只有 streaming input 才能在一个运行中回合继续收用户输入。这个单消费者
 * channel 是 Baton 侧的最小 prompt queue：query 生命周期内持续打开，close 时丢弃
 * 尚未消费的输入并唤醒 generator。
 */
export function claudePromptChannel(): ClaudePromptChannel {
  const queued: SDKUserMessage[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const stream = (async function* () {
    while (!closed) {
      if (queued.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      while (!closed && queued.length > 0) {
        yield queued.shift() as SDKUserMessage;
      }
    }
  })();
  return {
    stream,
    offer(message) {
      if (closed) return false;
      queued.push(message);
      wake?.();
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      queued.length = 0;
      wake?.();
    },
  };
}

function claudeImageMime(
  mimeType: string,
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  if (
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/gif" ||
    mimeType === "image/webp"
  ) {
    return mimeType;
  }
  throw new Error(`claude-code adapter does not support image mime type: ${mimeType}`);
}

export async function claudeUserMessage(blocks: PromptBlock[]): Promise<SDKUserMessage> {
  const content: Exclude<SDKUserMessage["message"]["content"], string> = [];
  for (const block of blocks) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type !== "image") {
      throw new Error(`claude-code prompt block was not admitted: ${block.type}`);
    }
    let data = block.data;
    if (!data && block.path) {
      try {
        data = (await readFile(block.path)).toString("base64");
      } catch (error) {
        throw new Error(
          `failed to read Claude image prompt ${block.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!data) throw new Error("claude-code image prompt block requires path or base64 data");
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: claudeImageMime(block.mimeType),
        data,
      },
    });
  }
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    // 调用方打 uuid：CLI 的队列跟踪（interrupt 回执 still_queued、cancel_async_message）
    // 只认 uuid-stamped 消息；无 uuid 的消息入队后不可见、不可撤回。
    uuid: randomUUID(),
    message: {
      role: "user",
      content,
    },
  };
}

export const CLAUDE_FALLBACK_MODELS: ModelOption[] = [
  { id: "default", label: "Default", description: "Use the Claude Code default model" },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
];

export const CLAUDE_SETTING_SOURCES = ["user", "project", "local"] as const;

export function claudeModels(models: ModelInfo[]): ModelOption[] {
  const discovered = models.map((model) => ({
    id: model.value,
    label: model.displayName,
    description: model.description,
  }));
  return discovered.some((model) => model.id === "default")
    ? discovered
    : [CLAUDE_FALLBACK_MODELS[0] as ModelOption, ...discovered];
}

const CLAUDE_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;

/** streaming input 只为完成 initialize 握手；不 yield，因此不会创建用户消息或 turn。 */
function idleClaudeInput(): { stream: AsyncGenerator<SDKUserMessage>; close: () => void } {
  let close = () => {};
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  return {
    stream: (async function* () {
      await closed;
    })(),
    close,
  };
}

async function initializeWithTimeout(queryHandle: Query): Promise<SDKControlInitializeResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Claude model discovery timed out")),
      CLAUDE_MODEL_DISCOVERY_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([queryHandle.initializationResult(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * HarnessTarget 级只读发现。它使用独立、不可持久化、禁用工具/MCP 的 SDK query，
 * 只完成 initialize/control 握手，不创建用户消息或可恢复的 HarnessSession。
 */
export async function probeClaudeTarget(options: {
  cwd: string;
  env?: Record<string, string>;
  executablePath?: string;
  log?: LogSink;
  queryFactory?: typeof query;
}): Promise<HarnessTargetProbeResult> {
  const idleInput = idleClaudeInput();
  const settings = await readClaudeSettings(options.cwd, options.log, options.env);
  const queryHandle = (options.queryFactory ?? query)({
    prompt: idleInput.stream,
    options: {
      cwd: options.cwd,
      env: { ...(process.env as Record<string, string>), ...options.env },
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: [...CLAUDE_SETTING_SOURCES],
      ...(options.executablePath
        ? { pathToClaudeCodeExecutable: options.executablePath }
        : {}),
      ...(settings.plugins
        ? {
            plugins: settings.plugins.map((plugin) => ({
              ...plugin,
              // probe 只发现 catalog；插件的 skill/command 可加载，MCP 连接留给真实 session。
              skipMcpDiscovery: true,
            })),
          }
        : {}),
    },
  });
  try {
    const initialized = await initializeWithTimeout(queryHandle);
    const commands = await queryHandle.supportedCommands();
    const runtime = { modelInfos: initialized.models } as ClaudeRuntime;
    return {
      models: claudeModels(initialized.models),
      efforts: claudeEffortsForModel(runtime, undefined),
      commands: commands.map((command) => ({
        name: command.name,
        ...(command.description ? { description: command.description } : {}),
        ...(command.argumentHint ? { input: { hint: command.argumentHint } } : {}),
      })),
    };
  } finally {
    idleInput.close();
    queryHandle.close();
  }
}

const CLAUDE_EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
export const CLAUDE_MODES = [
  { value: "default", name: "Default", description: "Allow normal implementation work" },
  { value: "plan", name: "Plan", description: "Plan without modifying the workspace" },
] as const;

function effortLabel(effort: string): string {
  return effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function claudeCommandName(name: string): string {
  return name.replace(/^\/+/, "");
}

export function claudeAvailableCommands(
  commands: ReadonlyArray<{ name: string; description?: string; argumentHint?: string }>,
  terminalCommands?: ReadonlySet<string>,
): AvailableCommand[] {
  return commands.flatMap((command) => {
    const name = claudeCommandName(command.name);
    if (terminalCommands?.has(name)) return [];
    return [{
      name,
      ...(command.description ? { description: command.description } : {}),
      ...(command.argumentHint ? { input: { hint: command.argumentHint } } : {}),
    }];
  });
}

export function claudeEffortsForModel(rt: ClaudeRuntime, modelId: string | undefined): EffortOption[] {
  const defaultOption: EffortOption = {
    id: "default",
    label: "Default",
    description: rt.appliedEffort
      ? `Use the Claude Code default effort (currently ${effortLabel(rt.appliedEffort)})`
      : "Use the Claude Code default effort",
  };
  const model = modelId
    ? rt.modelInfos?.find((candidate) => candidate.value === modelId || candidate.resolvedModel === modelId)
    : rt.modelInfos?.find((candidate) => candidate.value === "default") ?? rt.modelInfos?.[0];
  if (model?.supportsEffort === false) return [defaultOption];
  const levels = model?.supportedEffortLevels?.length ? model.supportedEffortLevels : CLAUDE_EFFORT_LEVELS;
  return [defaultOption, ...levels.map((id) => ({ id, label: effortLabel(id) }))];
}

export function claudeEfforts(rt: ClaudeRuntime): EffortOption[] {
  return claudeEffortsForModel(rt, rt.model);
}

/** 主 agent 最近一次 message_start 上报的当次模型调用 usage；反映真实当前 context 占用。 */
export interface ClaudeContextSample {
  model?: string;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

interface ClaudeContextWindow {
  effectiveModel: string;
  usedTokens: number;
  capacityTokens: number;
}

interface ClaudePublishedContextWindow extends ClaudeContextWindow {
  modelSelection: string;
}

export function claudeContextSampleTokens(sample: ClaudeContextSample): number {
  return sample.inputTokens + sample.cacheReadInputTokens + sample.cacheCreationInputTokens;
}

export function claudeModelMatches(left: string, right: string): boolean {
  return left === right || left.includes(right) || right.includes(left);
}

/**
 * result.modelUsage 是整个 streaming query 跨 turn 的累计值（含子 agent/辅助模型），
 * 直接当"当前 context 占用"会随轮数虚高、compact 后也不回落。当前占用改用主 agent
 * 最近一次 message_start 的当次调用 usage（contextSample）；modelUsage 只提供
 * contextWindow，并在没有 sample 时兜底（如 resume 后首个 result）。
 */
export function claudeContextWindow(
  modelUsage: Record<string, ModelUsage>,
  selectedModel?: string,
  contextSample?: ClaudeContextSample,
): ClaudeContextWindow | undefined {
  const entries = Object.entries(modelUsage);
  if (entries.length === 0) return undefined;
  const used = (usage: ModelUsage): number =>
    usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  const selected =
    entries.find(([model]) => contextSample?.model && model.includes(contextSample.model)) ??
    entries.find(([model]) => selectedModel && (model === selectedModel || model.includes(selectedModel))) ??
    entries.toSorted((a, b) => used(b[1]) - used(a[1]))[0];
  if (!selected || !Number.isFinite(selected[1].contextWindow)) return undefined;
  return {
    effectiveModel: contextSample?.model ?? selected[0],
    usedTokens: contextSample
      ? claudeContextSampleTokens(contextSample)
      : used(selected[1]),
    capacityTokens: selected[1].contextWindow,
  };
}

export function claudeStructuredContextWindow(
  usage: SDKContextUsage,
): ClaudeContextWindow | undefined {
  if (
    !Number.isFinite(usage.total_tokens) ||
    usage.total_tokens < 0 ||
    !Number.isFinite(usage.raw_max_tokens) ||
    usage.raw_max_tokens <= 0
  ) {
    return undefined;
  }
  return {
    effectiveModel: usage.model,
    usedTokens: usage.total_tokens,
    capacityTokens: usage.raw_max_tokens,
  };
}

export function publishClaudeContextWindow(
  rt: ClaudeRuntime,
  emit: HarnessEventSink,
  context: ClaudeContextWindow,
  raw: unknown,
): void {
  const next: ClaudePublishedContextWindow = {
    modelSelection: rt.model ?? "default",
    ...context,
  };
  const previous = rt.lastContextWindow;
  rt.lastContextWindow = next;
  if (
    previous?.modelSelection === next.modelSelection &&
    previous.effectiveModel === next.effectiveModel &&
    previous.usedTokens === next.usedTokens &&
    previous.capacityTokens === next.capacityTokens
  ) {
    return;
  }
  emit({
    kind: "context_window_update",
    payload: next,
    raw,
  });
}
