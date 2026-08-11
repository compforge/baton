// Claude Code 接入：官方 Agent SDK 进程内直调（TS 宿主不需要 tutti 那样的 sidecar）。
// SDK 以子进程拉起 claude CLI；可执行文件可换成公司包装器（BATON_CLAUDE_BIN），
// 凭证零持有，复用本机登录态。见 docs/harness/claude-code.md。

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  query,
  type EffortLevel,
  type ModelInfo,
  type ModelUsage,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKControlInitializeResponse,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { newId } from "../../event/ids.ts";
import type { LogSink } from "../../logging.ts";
import { logError } from "../../logging.ts";
import { readClaudeSettings } from "./settings.ts";
import type {
  AnyEventDraft,
  ConfigValue,
  ContentBlock,
  DiffBlock,
  PlanEntry,
  PromptBlock,
  SessionConfigOption,
} from "../../event/types.ts";
import { textOf } from "../../event/types.ts";
import type {
  InteractionDraft,
  PermissionOption,
  QuestionPrompt,
} from "../../interaction/types.ts";
import type {
  AdapterCapabilities,
  HarnessAdapter,
  EffortOption,
  EventSink,
  HarnessSessionBindingSink,
  ModelOption,
  NativeEventSink,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  SendTurnReceipt,
  HarnessSessionHandle,
  InteractionHandler,
  TextgenRequest,
} from "../adapter.ts";
import { unsupportedPromptBlocks } from "../adapter.ts";
import { generateClaudeStructured } from "./textgen.ts";
import {
  sessionIdFromResumeState,
  sessionIdResumeState,
} from "../resume.ts";
import type { HarnessTargetProbeResult } from "../target.ts";

const APPROVAL_OPTIONS: PermissionOption[] = [
  { optionId: "allow", name: "Allow once", polarity: "allow", lifetime: "once" },
  { optionId: "deny", name: "Deny", polarity: "reject", lifetime: "once" },
];

/**
 * 审批候选。always 项只在 SDK 给出 permission suggestions 时提供：baton 不自造
 * 授权规则，只透传 CLI "don't ask again" 的同款路径（选中后把整组 suggestions
 * 作为 updatedPermissions 返回，规则作用域由 SDK 决定，通常是 session 级）。
 *
 * lifetime 取 `persistent` 而非 `session`：作用域实际由 SDK 定、baton 不确知，
 * 而在审批展示上低报持续性才是危险的一侧（用户以为一次性、实则长期）。悲观取强档，
 * 与 name 的 "don't ask again" 一致（不变量 #2）。
 */
export function claudeApprovalOptions(hasSuggestions: boolean): PermissionOption[] {
  if (!hasSuggestions) return APPROVAL_OPTIONS;
  return [
    APPROVAL_OPTIONS[0] as PermissionOption,
    {
      optionId: "allowAlways",
      name: "Always allow (don't ask again)",
      polarity: "allow",
      lifetime: "persistent",
    },
    APPROVAL_OPTIONS[1] as PermissionOption,
  ];
}

/** Claude 工具名 → 内部 tool kind */
export function claudeToolKind(toolName: string): string {
  switch (toolName) {
    case "Read":
    case "NotebookRead":
      return "read";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "execute";
    case "Grep":
    case "Glob":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "fetch";
    default:
      return "other";
  }
}

/** 工具调用的一行标题：工具名 + 最有辨识度的入参 */
export function claudeToolTitle(toolName: string, input: Record<string, unknown>): string {
  const detail =
    input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.skill ?? input.description;
  return detail !== undefined ? `${toolName}: ${String(detail)}` : toolName;
}

/** TodoWrite 入参 → 统一 plan entries（最大公约数规范：计划一律走 plan_update） */
export function todoWritePlan(input: Record<string, unknown>): PlanEntry[] {
  const todos = (Array.isArray(input.todos) ? input.todos : []) as Array<Record<string, unknown>>;
  return todos.map((t) => ({
    content: String(t.content ?? ""),
    priority: "medium",
    status: t.status === "in_progress" || t.status === "completed" ? (t.status as string) : "pending",
  }));
}

/** Task 工具族（新版 Claude Code 以 TaskCreate/TaskUpdate 替代 TodoWrite）登记的待落账操作 */
export type TaskToolOp =
  | { op: "create"; subject: string }
  | { op: "update"; taskId: string; subject?: string; status?: string };

/** Task 工具族的任务表条目；表跨 turn 持久（harness 的任务列表本身跨 turn） */
export interface TaskEntry {
  subject: string;
  status: "pending" | "in_progress" | "completed";
}

/** tool_use 入参 → Task 操作；非 Task 写操作（含只读的 TaskList/TaskGet）返回 null */
export function taskToolOp(toolName: string, input: Record<string, unknown>): TaskToolOp | null {
  if (toolName === "TaskCreate") {
    return { op: "create", subject: String(input.subject ?? input.description ?? "") };
  }
  if (toolName === "TaskUpdate") {
    // 真实 harness 的入参是 snake_case `task_id`（早期按 camelCase 假设实现，导致
    // update 全被丢弃、plan 永远停在 pending）；两种拼法都接受，防协议再漂移。
    const rawId = input.task_id ?? input.taskId;
    if (rawId === undefined) return null;
    return {
      op: "update",
      taskId: String(rawId),
      ...(typeof input.subject === "string" ? { subject: input.subject } : {}),
      ...(typeof input.status === "string" ? { status: input.status } : {}),
    };
  }
  return null;
}

/**
 * Task 操作在 tool_result 成功后才落账：TaskCreate 的 taskId 只出现在结果文本
 * （"Task #1 created successfully: ..."）里，TaskUpdate 也可能失败；入参阶段只登记不改表。
 */
export function applyTaskOp(
  tasks: Map<string, TaskEntry>,
  op: TaskToolOp,
  resultText: string,
  fallbackId: string,
): void {
  if (op.op === "create") {
    const id = /task #([\w-]+)/i.exec(resultText)?.[1];
    tasks.set(id ?? fallbackId, { subject: op.subject, status: "pending" });
    return;
  }
  if (op.status === "deleted") {
    tasks.delete(op.taskId);
    return;
  }
  // upsert：resume 场景下任务可能建于 baton 观察不到的历史，缺 subject 时以 id 兜底
  const prev = tasks.get(op.taskId);
  tasks.set(op.taskId, {
    subject: op.subject ?? prev?.subject ?? `Task #${op.taskId}`,
    status:
      op.status === "in_progress" || op.status === "completed" || op.status === "pending"
        ? op.status
        : (prev?.status ?? "pending"),
  });
}

/** 任务表整表投影成 plan entries（Map 迭代序 = 创建序） */
export function taskPlanEntries(tasks: Map<string, TaskEntry>): PlanEntry[] {
  return [...tasks.values()].map((t) => ({ content: t.subject, priority: "medium", status: t.status }));
}

/**
 * 编辑类工具入参 → 意图 diff（只有 op+path，不合成 patch）；非编辑类返回 null。
 * 不从 old_string/new_string 拼 patch：拼出来的不是合法 unified diff（无 +++/@@，
 * 多行内容直接破格式），而渲染层信任 patch 的合法性（行号/split 视图都建立在其上）。
 * 真 patch 在工具完成时由 claudeResultDiff 从 tool_use_result.structuredPatch 回填。
 */
export function claudeToolDiff(toolName: string, input: Record<string, unknown>): DiffBlock | null {
  const path = String(input.file_path ?? input.notebook_path ?? "");
  if (!path) return null;
  switch (toolName) {
    case "Write":
      // 入参阶段猜 add（多数 Write 是新建）；覆盖写会被 claudeResultDiff 按结果修正为 modify
      return { type: "diff", changes: [{ operation: "add", path }] };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { type: "diff", changes: [{ operation: "modify", path }] };
    default:
      return null;
  }
}

interface StructuredHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** patch 收录的 hunk 行上限：大文件 Write 的全量内容会撑爆 session.jsonl 事件行，展示层也只看头部 */
const MAX_PATCH_LINES = 400;

/**
 * Edit/Write/MultiEdit 的 tool_use_result → 带真 patch 的 diff 内容块。
 * tool_use_result 是 Claude Code 无文档的私有形状（SDK 类型就是 unknown），只允许
 * 在本函数出现：解析成功产出标准 unified diff 进 DiffBlock；任何字段不合形状即
 * 返回 null，降级为入参阶段的 changes-only 展示，不让私有格式漂移打崩事件流。
 */
export function claudeResultDiff(result: unknown): DiffBlock | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  const path = typeof r.filePath === "string" ? r.filePath : "";
  const rawHunks = Array.isArray(r.structuredPatch) ? r.structuredPatch : [];
  if (!path || rawHunks.length === 0) return null;
  const hunks: StructuredHunk[] = [];
  for (const raw of rawHunks) {
    const h = raw as Record<string, unknown>;
    if (
      typeof h.oldStart !== "number" ||
      typeof h.oldLines !== "number" ||
      typeof h.newStart !== "number" ||
      typeof h.newLines !== "number" ||
      !Array.isArray(h.lines) ||
      !h.lines.every((line) => typeof line === "string")
    ) {
      return null;
    }
    hunks.push(h as unknown as StructuredHunk);
  }
  // Write 新建文件的结果带 type:"create"；Edit / 覆盖写没有该值 → modify
  const operation = r.type === "create" ? "add" : "modify";
  const header = operation === "add" ? `--- /dev/null\n+++ ${path}` : `--- ${path}\n+++ ${path}`;
  const body: string[] = [];
  let budget = MAX_PATCH_LINES;
  for (const hunk of hunks) {
    if (budget <= 0) break;
    const lines = hunk.lines.slice(0, budget);
    budget -= lines.length;
    if (lines.length === hunk.lines.length) {
      body.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...lines);
    } else {
      // 截断后按实际收录行数重写 hunk 头：patch 保持合法（低估改动量，展示层可接受）
      const oldCount = lines.filter((line) => !line.startsWith("+")).length;
      const newCount = lines.filter((line) => !line.startsWith("-")).length;
      body.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`, ...lines);
    }
  }
  return { type: "diff", changes: [{ operation, path }], patch: `${header}\n${body.join("\n")}` };
}

function claudeToolResultBlocks(result: unknown): ContentBlock[] {
  if (typeof result === "string") return result ? [{ type: "text", text: result }] : [];
  if (!Array.isArray(result)) return [];
  return result.flatMap((raw) => {
    const block = raw as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string"
      ? [{ type: "text", text: block.text }]
      : [];
  });
}

/** Claude SDK live 消息与只读 SessionMessage 共有的 durable 内容形状。 */
export interface ClaudeDurableMessage {
  type: "assistant" | "user" | "system";
  message: unknown;
  parent_tool_use_id?: string | null;
  /** live SDK 才提供；只读历史缺失时由文本结果安全降级。 */
  tool_use_result?: unknown;
}

/** durable 消息归一所需的 session 级状态；native import 与 live adapter 共用。 */
export interface ClaudeDurableMappingState {
  suppressedToolIds: Set<string>;
  capturedProposedPlanKeys: Set<string>;
  tasks: Map<string, TaskEntry>;
  pendingTaskOps: Map<string, TaskToolOp>;
}

/**
 * ExitPlanMode → proposed_plan。tool_use id 同时是稳定 plan id，确保 live capture 与
 * native import 重放同一条 durable 消息时得到同一个逻辑对象。
 */
export function claudeProposedPlanDraft(
  state: Pick<ClaudeDurableMappingState, "capturedProposedPlanKeys">,
  turnId: string,
  input: Record<string, unknown>,
  toolUseId: string | undefined,
  raw: unknown,
): AnyEventDraft | undefined {
  const content = typeof input.plan === "string" ? input.plan.trim() : "";
  if (!content) return undefined;
  const keys = [
    `turn:${turnId}:content:${content}`,
    ...(toolUseId ? [`turn:${turnId}:tool:${toolUseId}`] : []),
  ];
  if (keys.some((key) => state.capturedProposedPlanKeys.has(key))) return undefined;
  for (const key of keys) state.capturedProposedPlanKeys.add(key);
  return {
    kind: "proposed_plan",
    payload: { planId: toolUseId ? `pl_${toolUseId}` : newId("pl"), content },
    raw,
  };
}

/**
 * Claude durable user/assistant message → Baton drafts。
 *
 * 这里只消费 live 与 getSessionMessages 都会持久化的内容块；stream delta、result
 * usage 和只存在于 live message.tool_use_result 的私有 structuredPatch 不做猜测。
 */
export function claudeDurableMessageDrafts(
  state: ClaudeDurableMappingState,
  msg: ClaudeDurableMessage,
  options: { turnId: string; messageId?: string; raw?: unknown },
): AnyEventDraft[] {
  const drafts: AnyEventDraft[] = [];
  if (msg.type !== "assistant" && msg.type !== "user") return drafts;
  const content =
    msg.message && typeof msg.message === "object"
      ? (msg.message as { content?: unknown }).content
      : undefined;
  if (!Array.isArray(content)) return drafts;
  const blocks = content as Array<Record<string, unknown>>;
  const raw = options.raw ?? msg;

  if (msg.type === "assistant") {
    if (!msg.parent_tool_use_id) {
      const messageId = options.messageId ?? newId("m");
      const thinking = blocks
        .filter((block) => block.type === "thinking")
        .map((block) => String(block.thinking ?? ""))
        .join("");
      if (thinking) {
        drafts.push({
          kind: "agent_thought",
          payload: {
            messageId: `${messageId}_thought`,
            content: [{ type: "text", text: thinking }],
          },
          raw,
        });
      }
      const text = blocks
        .filter((block) => block.type === "text")
        .map((block) => String(block.text ?? ""))
        .join("");
      if (text) {
        drafts.push({
          kind: "agent_message",
          payload: { messageId, content: [{ type: "text", text }] },
          raw,
        });
      }
    }

    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      const toolUseId = String(block.id);
      const toolName = String(block.name);
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (toolName === "ExitPlanMode") {
        state.suppressedToolIds.add(toolUseId);
        const plan = claudeProposedPlanDraft(
          state,
          options.turnId,
          input,
          toolUseId,
          raw,
        );
        if (plan) drafts.push(plan);
        continue;
      }
      if (toolName === "TodoWrite") {
        state.suppressedToolIds.add(toolUseId);
        drafts.push({
          kind: "plan_update",
          // per-turn plan 锚定当前 scrollback 位置，本 turn 内的更新原地 mark。
          payload: { planId: `pl_${options.turnId}`, entries: todoWritePlan(input) },
          raw,
        });
        continue;
      }
      const taskOp = taskToolOp(toolName, input);
      if (taskOp) {
        state.suppressedToolIds.add(toolUseId);
        state.pendingTaskOps.set(toolUseId, taskOp);
        continue;
      }
      const diff = claudeToolDiff(toolName, input);
      drafts.push({
        kind: "tool_call_update",
        payload: {
          toolCallId: toolUseId,
          title: claudeToolTitle(toolName, input),
          kind: claudeToolKind(toolName),
          status: "in_progress",
          content: diff ? [diff] : undefined,
          rawInput: input,
        },
        raw,
      });
    }
    return drafts;
  }

  const toolResultCount = blocks.filter((block) => block.type === "tool_result").length;
  const resultDiff = toolResultCount === 1 ? claudeResultDiff(msg.tool_use_result) : null;
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    const toolUseId = String(block.tool_use_id);
    const taskOp = state.pendingTaskOps.get(toolUseId);
    if (taskOp) {
      state.pendingTaskOps.delete(toolUseId);
      if (!block.is_error) {
        const text = claudeToolResultBlocks(block.content)
          .map((output) => (output.type === "text" ? output.text : ""))
          .join("");
        applyTaskOp(state.tasks, taskOp, text, toolUseId);
        drafts.push({
          kind: "plan_update",
          payload: { planId: `pl_${options.turnId}`, entries: taskPlanEntries(state.tasks) },
          raw,
        });
      } else {
        // Task 工具的 tool_use 在入参阶段被 plan_update 取代（suppressedToolIds），失败
        // 时若也静默，错误将彻底不可见（任务表不变、UI 无任何痕迹）；补一条 failed 让
        // 失败可感知。任务表不动是对的——op 没有生效。
        drafts.push({
          kind: "tool_call_update",
          payload: {
            toolCallId: toolUseId,
            title:
              taskOp.op === "create"
                ? `TaskCreate: ${taskOp.subject}`
                : `TaskUpdate: ${taskOp.subject ?? taskOp.taskId}`,
            kind: "other",
            status: "failed",
            content: claudeToolResultBlocks(block.content),
            rawOutput: block.content,
          },
          raw,
        });
      }
    }
    if (state.suppressedToolIds.has(toolUseId)) continue;
    drafts.push({
      kind: "tool_call_update",
      payload: {
        toolCallId: toolUseId,
        status: block.is_error ? "failed" : "completed",
        rawOutput: block.content,
        content: resultDiff ? [resultDiff] : undefined,
      },
      raw,
    });
    if (resultDiff) continue;
    for (const output of claudeToolResultBlocks(block.content)) {
      drafts.push({
        kind: "tool_call_content_chunk",
        payload: { toolCallId: toolUseId, content: output },
        raw,
      });
    }
  }
  return drafts;
}

/**
 * 长生命周期 query 当前消费的 turn 状态。终态标记、cancel 标记与流式 messageId
 * 必须绑定在 turn 对象上而不是散落成 runtime 字段，避免 result 之后的迟到消息
 * 被错误归到下一 turn。
 */
interface ClaudeTurn {
  turnId: string;
  /** 保证任何退出路径（result 消息 / 流异常 / 流结束无 result）只发一次终态（见 docs/harness.md） */
  finalized: boolean;
  /** 用户主动中断时，SDK 会以 error result 结束消息流；该错误应归一成 cancelled。 */
  cancelRequested: boolean;
  /** 当前正在流式输出的 assistant 消息的内部 messageId（chunk 与最终 upsert 共用） */
  streamMessageId?: string;
}

/**
 * result 之后同一条消息流上再出现的活动消息，属于 harness 自发回合（observed turn）：
 * 后台任务（Agent tool 等）完成时 harness 会在无用户输入的情况下重新唤起模型，
 * 新回合的消息继续从同一条 SDK 流上到达。这里判定"该为它开一个新 turn 了"。
 * system/result 不开界：前者是瞬时相位（不构成回合），后者无活动时只是迟到终态。
 */
export function startsObservedTurn(msgType: string, current: { finalized: boolean }): boolean {
  return current.finalized && (msgType === "stream_event" || msgType === "assistant" || msgType === "user");
}

interface ClaudeRuntime extends ClaudeDurableMappingState {
  cwd: string;
  env?: Record<string, string>;
  /** open 时绑定的事件出口；session 生命周期内所有事件（含跨 turn）都走它 */
  sink: EventSink;
  /** 稳定 HarnessSession 身份一旦可知，立即发布给宿主持久化。 */
  bindingSink?: HarnessSessionBindingSink;
  /** SDK 的 session_id，首个 turn 的 init 消息里拿到；resume 靠它 */
  claudeSessionId?: string;
  publishedSessionId?: string;
  activeQuery?: Query;
  promptChannel?: ClaudePromptChannel;
  /** 当前被接受、尚未逻辑终结的 turn */
  activeTurn?: ClaudeTurn;
  /** query 消费循环当前归属的 turn；包含不占 admission 槽的 observed turn。 */
  currentTurn?: ClaudeTurn;
  /** effort 无动态控制接口；变更后在下个新 turn 前重建 streaming query。 */
  queryOptionsDirty?: boolean;
  /** 用户在 baton 中选择的模型；已有 streaming query 通过 setModel 动态更新。 */
  model?: string;
  models?: ModelOption[];
  modelInfos?: ModelInfo[];
  /** 用户在 baton 中选择的推理强度；下次 query 创建时生效。 */
  effort?: EffortLevel;
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
   * steer offer 出去、尚未在 SDK 流中确认归属的消息：uuid → 来源 turn/message。
   * CLI 可能把运行中推送的消息排队而非折进当前 turn（fold 时机是 CLI 内部时序，
   * 无回执）；凭此映射做归属对账（turn 收口时 warn）与 interrupt 回执匹配。
   * 条目在流中回显该 uuid 时移除；容量有界，满时淘汰最旧条目。
   * 懒初始化：部分调用方（测试夹具、native import）只构造最小 runtime。
   */
  pendingOfferUuids?: Map<string, { turnId: string; messageId: string }>;
  /** 主 agent 最近一次 message_start 的当次调用 usage；跨 turn 保留，compact 后由下一次 sample 覆盖。 */
  lastContextSample?: ClaudeContextSample;
  /** 从 .claude/settings.json 读取的 plugins 和 mcpServers 配置 */
  settings?: import("./settings.ts").ClaudeSettings;
}

interface ClaudePromptChannel {
  stream: AsyncGenerator<SDKUserMessage>;
  offer(message: SDKUserMessage): boolean;
  close(): void;
}

/**
 * Agent SDK 只有 streaming input 才能在一个运行中回合继续收用户输入。这个单消费者
 * channel 是 Baton 侧的最小 prompt queue：query 生命周期内持续打开，close 时丢弃
 * 尚未消费的输入并唤醒 generator。
 */
function claudePromptChannel(): ClaudePromptChannel {
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

const CLAUDE_FALLBACK_MODELS: ModelOption[] = [
  { id: "default", label: "Default", description: "Use the Claude Code default model" },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
];

const CLAUDE_SETTING_SOURCES = ["user", "project", "local"] as const;

function claudeModels(models: ModelInfo[]): ModelOption[] {
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
  const settings = await readClaudeSettings(options.cwd, options.log);
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
const CLAUDE_MODES = [
  { value: "default", name: "Default", description: "Allow normal implementation work" },
  { value: "plan", name: "Plan", description: "Plan without modifying the workspace" },
] as const;

function effortLabel(effort: string): string {
  return effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

function claudeEffortsForModel(rt: ClaudeRuntime, modelId: string | undefined): EffortOption[] {
  const defaultOption: EffortOption = {
    id: "default",
    label: "Default",
    description: "Use the Claude Code default effort",
  };
  const model = modelId
    ? rt.modelInfos?.find((candidate) => candidate.value === modelId || candidate.resolvedModel === modelId)
    : rt.modelInfos?.find((candidate) => candidate.value === "default") ?? rt.modelInfos?.[0];
  if (model?.supportsEffort === false) return [defaultOption];
  const levels = model?.supportedEffortLevels?.length ? model.supportedEffortLevels : CLAUDE_EFFORT_LEVELS;
  return [defaultOption, ...levels.map((id) => ({ id, label: effortLabel(id) }))];
}

function claudeEfforts(rt: ClaudeRuntime): EffortOption[] {
  return claudeEffortsForModel(rt, rt.model);
}

/** 主 agent 最近一次 message_start 上报的当次模型调用 usage；反映真实当前 context 占用。 */
interface ClaudeContextSample {
  model?: string;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * result.modelUsage 是整个 streaming query 跨 turn 的累计值（含子 agent/辅助模型），
 * 直接当"当前 context 占用"会随轮数虚高、compact 后也不回落。当前占用改用主 agent
 * 最近一次 message_start 的当次调用 usage（contextSample）；modelUsage 只提供
 * contextWindow 与累计 cost，并在没有 sample 时兜底（如 resume 后首个 result）。
 */
function claudeContextUsage(
  modelUsage: Record<string, ModelUsage>,
  selectedModel?: string,
  contextSample?: ClaudeContextSample,
): { contextUsed: number; contextSize: number; cost?: { amount: number; currency: string } } | undefined {
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
    contextUsed: contextSample
      ? contextSample.inputTokens + contextSample.cacheReadInputTokens + contextSample.cacheCreationInputTokens
      : used(selected[1]),
    contextSize: selected[1].contextWindow,
    ...(Number.isFinite(selected[1].costUSD)
      ? { cost: { amount: selected[1].costUSD, currency: "USD" } }
      : {}),
  };
}

export interface ClaudeAdapterOptions {
  interactionHandler: InteractionHandler;
  log?: LogSink;
  nativeEvent?: NativeEventSink;
  /** claude 可执行文件路径；默认 BATON_CLAUDE_BIN 环境变量，再默认交给 SDK 自己找 */
  executablePath?: string;
  /** 测试注入点；生产始终使用 Agent SDK 的 query。 */
  queryFactory?: typeof query;
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly harness = "claude-code";
  // 可选能力接口落地并验证后才声明对应 marker——契约测试钉住
  // "声明支持就必须实现对应接口"。
  readonly capabilities: AdapterCapabilities = {
    prompt: { image: { supported: true } },
    compact: { supported: true },
    config: { supported: true },
    textgen: { supported: true },
  };
  private sessions = new Map<string, ClaudeRuntime>();

  constructor(private options: ClaudeAdapterOptions) {}

  /** TextGeneratable：一次性 SDK query，与 HarnessSession 生命周期完全无关（见 textgen.ts）。 */
  async generateStructured(request: TextgenRequest): Promise<unknown> {
    return generateClaudeStructured(request, {
      executablePath: this.options.executablePath,
      ...(this.options.queryFactory ? { queryFactory: this.options.queryFactory } : {}),
    });
  }

  /** SDK 无独立"启动"步骤：streaming query 在首个 sendTurn 时创建，这里只登记运行时。 */
  async open(
    opts: OpenOptions,
    sink: EventSink,
    binding?: HarnessSessionBindingSink,
  ): Promise<HarnessSessionHandle> {
    const id = newId("hs");
    const requestedSessionId = opts.resumeState
      ? sessionIdFromResumeState(opts.resumeState)
      : opts.resumeSessionId;
    // 0.2.14 曾把进程内 hs_ handle 当稳定身份落盘。迁移知识留在 Claude Adapter
    // 边界：core 不解析任何 Harness 的 ID 方言；新 init 随后会发布真实 binding。
    const resumeSessionId = requestedSessionId?.startsWith("hs_")
      ? undefined
      : requestedSessionId;

    // 读取 .claude/settings.json 中的 plugins 和 mcpServers 配置
    const settings = await readClaudeSettings(opts.cwd, this.options.log);

    // 注意：虽然 SDK 通过子进程启动 Claude CLI，CLI 会自动读取配置文件层级：
    //   1. ~/.claude/settings.json (user-level)
    //   2. ${cwd}/.claude/settings.json (project-level)
    //   3. ${cwd}/.claude/settings.local.json (local override)
    //   4. managed-settings.json (policy)
    //
    // 但为了确保 plugins 和 mcpServers 能被正确加载，我们需要：
    // 1. 通过 SDK Options 显式传递 plugins 和 mcpServers（确保 SDK 能看到）
    // 2. 同时保持 cwd 正确，让 CLI 能读取 enabledPlugins 等其他配置
    //
    // 这种"双保险"策略能最大程度保证 plugin 正常工作。

    const runtime: ClaudeRuntime = {
      cwd: opts.cwd,
      env: opts.env,
      sink,
      bindingSink: binding,
      claudeSessionId: resumeSessionId,
      suppressedToolIds: new Set(),
      capturedProposedPlanKeys: new Set(),
      tasks: new Map(),
      pendingTaskOps: new Map(),
      settings,
    };
    this.sessions.set(id, runtime);
    if (resumeSessionId) this.publishSessionBinding(runtime, resumeSessionId);
    return { harness: this.harness, handleId: id, resumed: Boolean(resumeSessionId) };
  }

  async listModels(ref: HarnessSessionHandle): Promise<ModelOption[]> {
    const rt = this.mustSession(ref);
    try {
      await this.ensureModelCatalog(rt);
    } catch {
      // CLI 初始化失败时仍允许用稳定别名发起首轮，不让模型发现阻断发送链路。
    }
    return rt.models ?? CLAUDE_FALLBACK_MODELS;
  }

  async setModel(ref: HarnessSessionHandle, modelId: string | null): Promise<void> {
    const rt = this.mustSession(ref);
    const model = !modelId || modelId === "default" ? undefined : modelId;
    if (rt.effort && !claudeEffortsForModel(rt, model).some((candidate) => candidate.id === rt.effort)) {
      throw new Error(`Claude model ${model ?? "default"} does not support effort ${rt.effort}`);
    }
    if (rt.activeQuery) await rt.activeQuery.setModel(model);
    rt.model = model;
  }

  currentModel(ref: HarnessSessionHandle): string | null {
    return this.mustSession(ref).model ?? null;
  }

  async listEfforts(ref: HarnessSessionHandle): Promise<EffortOption[]> {
    const rt = this.mustSession(ref);
    try {
      await this.ensureModelCatalog(rt);
    } catch {
      // 与 model picker 一致：发现失败时使用 SDK 的稳定 effort 词表。
    }
    return claudeEfforts(rt);
  }

  async setEffort(ref: HarnessSessionHandle, effortId: string | null): Promise<void> {
    const rt = this.mustSession(ref);
    if (!effortId || effortId === "default") {
      rt.effort = undefined;
      if (rt.activeQuery) rt.queryOptionsDirty = true;
      return;
    }
    if (!claudeEfforts(rt).some((candidate) => candidate.id === effortId)) {
      throw new Error(`Claude model ${rt.model ?? "default"} does not support effort ${effortId}`);
    }
    rt.effort = effortId as EffortLevel;
    if (rt.activeQuery) rt.queryOptionsDirty = true;
  }

  currentEffort(ref: HarnessSessionHandle): string | null {
    return this.mustSession(ref).effort ?? null;
  }

  async getConfig(ref: HarnessSessionHandle): Promise<SessionConfigOption[]> {
    const [models, efforts] = await Promise.all([
      this.listModels(ref),
      this.listEfforts(ref),
    ]);
    return [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        value: this.currentModel(ref) ?? "default",
        options: models.map(({ id, label, description }) => ({
          value: id,
          name: label,
          ...(description ? { description } : {}),
        })),
      },
      {
        id: "effort",
        type: "select",
        name: "Effort",
        category: "thought_level",
        value: this.currentEffort(ref) ?? "default",
        options: efforts.map(({ id, label, description }) => ({
          value: id,
          name: label,
          ...(description ? { description } : {}),
        })),
      },
      {
        id: "mode",
        type: "select",
        name: "Mode",
        category: "mode",
        value: this.mustSession(ref).permissionMode ?? "default",
        options: [...CLAUDE_MODES],
      },
    ];
  }

  async setConfig(
    ref: HarnessSessionHandle,
    configId: string,
    value: ConfigValue,
  ): Promise<SessionConfigOption[]> {
    if (typeof value !== "string") {
      throw new Error(`Claude config ${configId} requires a string value`);
    }
    if (configId === "model") {
      await this.setModel(ref, value);
    } else if (configId === "effort") {
      await this.setEffort(ref, value);
    } else if (configId === "mode") {
      if (value !== "default" && value !== "plan") {
        throw new Error(`Unknown Claude mode: ${value}`);
      }
      const rt = this.mustSession(ref);
      if (rt.activeTurn && !rt.activeTurn.finalized) {
        throw new Error("Cannot switch Claude mode while a turn is running");
      }
      if (rt.activeQuery) await rt.activeQuery.setPermissionMode(value);
      rt.permissionMode = value === "default" ? undefined : value;
    } else {
      throw new Error(`Unknown Claude session config: ${configId}`);
    }
    return this.getConfig(ref);
  }

  private async ensureModelCatalog(rt: ClaudeRuntime): Promise<void> {
    if (rt.models) return;
    if (rt.activeQuery) {
      rt.modelInfos = await rt.activeQuery.supportedModels();
      rt.models = claudeModels(rt.modelInfos);
      return;
    }
    // 静态发现归 HarnessTarget probe；live Adapter 在尚未启动 query 时只提供稳定别名。
    rt.models = CLAUDE_FALLBACK_MODELS;
  }

  async compactContext(ref: HarnessSessionHandle, turnId: string): Promise<PromptReceipt> {
    const rt = this.mustSession(ref);
    if (!rt.claudeSessionId) throw new Error("Claude has no conversation to compact yet");
    if (rt.activeTurn && !rt.activeTurn.finalized) {
      throw new Error(`claude turn ${rt.activeTurn.turnId} still active; cannot compact`);
    }
    const receipt = await this.sendTurn(ref, {
      turnId,
      messageId: newId("m"),
      blocks: [{ type: "text", text: "/compact" }],
    });
    if (!receipt.accepted || receipt.effective !== "new_turn") {
      throw new Error(
        !receipt.accepted ? receipt.reason ?? "Claude rejected context compaction" : "Claude compact opened as steer",
      );
    }
    return { accepted: true };
  }

  /**
   * 统一输入入口，对齐 T3Code 的 Claude runtime：
   * - 空闲时在长生命周期 streaming query 上开启新 turn；
   * - 运行中且 Baton turnId 匹配时，把消息投进同一 prompt stream，作为当前 turn 的 steer；
   * - turnId 不匹配时拒绝，由 Controller 排成 follow-up，绝不误注入别的回合。
   */
  async sendTurn(
    ref: HarnessSessionHandle,
    input: PromptInput,
  ): Promise<SendTurnReceipt> {
    const rt = this.mustSession(ref);
    const unsupported = unsupportedPromptBlocks(input.blocks, this.capabilities);
    if (unsupported.length) {
      throw new Error(`claude-code adapter does not support prompt block type(s): ${unsupported.join(", ")}`);
    }

    const active = rt.activeTurn && !rt.activeTurn.finalized ? rt.activeTurn : undefined;
    if (active) {
      if (active.turnId !== input.turnId) {
        return {
          accepted: false,
          effective: "rejected",
          reason: `active Claude turn is ${active.turnId}, not ${input.turnId}`,
        };
      }
      const message = await claudeUserMessage(input.blocks);
      if (rt.activeTurn !== active || active.finalized) {
        return { accepted: false, effective: "rejected", reason: "active Claude turn completed while reading input" };
      }
      if (!rt.promptChannel?.offer(message)) {
        return {
          accepted: false,
          effective: "rejected",
          reason: "Claude streaming input is unavailable",
        };
      }
      // offer 成功不代表进入当前 turn（CLI 可能排队）；登记 uuid 供收口时对账。
      // 容量有界：淘汰最旧条目，避免回显不带 uuid 时 Map 无界增长。
      const pendingOffers = (rt.pendingOfferUuids ??= new Map());
      if (pendingOffers.size >= 64) {
        const oldest = pendingOffers.keys().next().value;
        if (oldest !== undefined) pendingOffers.delete(oldest);
      }
      pendingOffers.set(message.uuid as string, {
        turnId: active.turnId,
        messageId: input.messageId,
      });
      this.emit(
        rt,
        {
          kind: "user_message",
          payload: { messageId: input.messageId, content: input.blocks, delivery: "steer" },
        },
        active,
      );
      return { accepted: true, effective: "steer" };
    }

    // observed turn 不占 admission 槽；用户新输入到达时先明确收口，避免后续消息与
    // 新 driven turn 共用 currentTurn 而发生归属混淆。
    if (rt.currentTurn && !rt.currentTurn.finalized) {
      const observed = rt.currentTurn;
      this.finishTurn(rt, (ev) => this.emit(rt, ev, observed), observed, "end_turn");
    }
    if (rt.queryOptionsDirty) this.closeStreamingQuery(rt);

    const turn: ClaudeTurn = { turnId: input.turnId, finalized: false, cancelRequested: false };
    rt.activeTurn = turn;
    rt.currentTurn = turn;
    // user_message / state_update(running) 由 controller 在出队时落盘（用户输入是 BatonSession
    // 的事实，不等 harness 就绪）；adapter 只报告 harness 执行过程与终态。

    try {
      const message = await claudeUserMessage(input.blocks);
      this.ensureStreamingQuery(rt);
      if (!rt.promptChannel?.offer(message)) {
        throw new Error("Claude streaming input closed before prompt was accepted");
      }
    } catch (error) {
      if (rt.activeTurn === turn) rt.activeTurn = undefined;
      if (rt.currentTurn === turn) rt.currentTurn = undefined;
      throw error;
    }
    return { accepted: true, effective: "new_turn" };
  }

  private ensureStreamingQuery(rt: ClaudeRuntime): void {
    if (rt.activeQuery) return;
    const executable = this.options.executablePath ?? process.env.BATON_CLAUDE_BIN;
    const sdkOptions: Options = {
      cwd: rt.cwd,
      env: { ...(process.env as Record<string, string>), ...rt.env },
      resume: rt.claudeSessionId,
      includePartialMessages: true,
      // Agent SDK 默认使用空 system prompt；显式恢复 Claude Code 语义，确保
      // skills、auto-memory 等原生能力与直接运行 claude CLI 一致。
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: [...CLAUDE_SETTING_SOURCES],
      ...(rt.model ? { model: rt.model } : {}),
      ...(rt.effort ? { effort: rt.effort } : {}),
      ...(rt.permissionMode ? { permissionMode: rt.permissionMode } : {}),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      ...(rt.settings?.plugins ? { plugins: rt.settings.plugins } : {}),
      ...(rt.settings?.mcpServers ? { mcpServers: rt.settings.mcpServers } : {}),
      canUseTool: (toolName, toolInput, meta) =>
        this.handleCanUseTool(
          rt,
          (ev) => this.emit(rt, ev, rt.currentTurn ?? rt.activeTurn),
          () => rt.currentTurn?.turnId ?? rt.activeTurn?.turnId ?? "",
          toolName,
          toolInput,
          meta,
        ),
    };

    const channel = claudePromptChannel();
    const q = (this.options.queryFactory ?? query)({ prompt: channel.stream, options: sdkOptions });
    rt.promptChannel = channel;
    rt.activeQuery = q;
    rt.queryOptionsDirty = false;
    void q
      .initializationResult()
      .then((result) => {
        rt.modelInfos = result.models;
        rt.models = claudeModels(result.models);
      })
      .catch((error) => {
        this.options.log?.({
          level: "warn",
          source: "harness",
          component: "claude.initialization",
          harness: this.harness,
          turnId: rt.currentTurn?.turnId,
          message: "Claude SDK initialization result failed",
          error: logError(error),
        });
      });
    void this.consumeQuery(rt, q, channel);
  }

  private async consumeQuery(rt: ClaudeRuntime, q: Query, channel: ClaudePromptChannel): Promise<void> {
    try {
      for await (const msg of q) {
        this.options.nativeEvent?.({
          direction: "in",
          name: msg.type === "system" ? `system/${msg.subtype}` : msg.type,
          payload: msg,
        });
        let current = rt.currentTurn;
        if (!current) {
          if (msg.type === "system" && msg.subtype === "init") {
            this.publishSessionBinding(rt, msg.session_id);
          }
          continue;
        }
        if (startsObservedTurn(msg.type, current)) {
          current = this.mintObservedTurn(rt);
          rt.currentTurn = current;
        }
        const emit: EventSink = (ev) => this.emit(rt, ev, current);
        this.handleMessage(rt, emit, msg, current);
      }
      const current = rt.currentTurn;
      if (current) {
        this.finishTurn(
          rt,
          (ev) => this.emit(rt, ev, current),
          current,
          current.cancelRequested ? "cancelled" : "end_turn",
        );
      }
    } catch (error) {
      // effort 变更或 close 会主动替换/清掉 query；旧消费循环此时无需制造错误事件。
      if (rt.activeQuery !== q) return;
      const current = rt.currentTurn;
      if (!current) return;
      const emit: EventSink = (ev) => this.emit(rt, ev, current);
      this.options.log?.({
        level: current.cancelRequested ? "info" : "error",
        source: "harness",
        component: "claude.query",
        harness: this.harness,
        turnId: current.turnId,
        message: current.cancelRequested ? "Claude SDK query stopped after cancellation" : "Claude SDK query failed",
        error: logError(error),
      });
      if (current.cancelRequested) {
        this.finishTurn(rt, emit, current, "cancelled");
      } else {
        emit({
          kind: "_baton_error_update",
          payload: { message: error instanceof Error ? error.message : String(error) },
        });
        this.finishTurn(rt, emit, current, "error");
      }
    } finally {
      if (rt.activeQuery === q) {
        rt.activeQuery = undefined;
        rt.promptChannel = undefined;
      }
      channel.close();
    }
  }

  private closeStreamingQuery(rt: ClaudeRuntime): void {
    const queryHandle = rt.activeQuery;
    const channel = rt.promptChannel;
    rt.activeQuery = undefined;
    rt.promptChannel = undefined;
    rt.queryOptionsDirty = false;
    channel?.close();
    queryHandle?.close();
  }

  /**
   * 铸造 observed turn 并以 harness 来源的 running 开界（见 docs/workflow.md）。
   * 刻意不写 rt.activeTurn：observed turn 不占 admission 槽；新 driven turn 到达时
   * sendTurn 会先将它收口，再把用户输入送进同一个 streaming query。
   */
  private mintObservedTurn(rt: ClaudeRuntime): ClaudeTurn {
    const observed: ClaudeTurn = { turnId: newId("t"), finalized: false, cancelRequested: false };
    this.emit(
      rt,
      { kind: "state_update", payload: { state: "running" } },
      observed,
    );
    return observed;
  }

  /**
   * 每个 turn 只发一次逻辑终态；result 消息、异常、流异常结束都收敛到这里。
   * 只允许终结传入的那个 turn：上一 turn 的流耗尽兜底不能误杀已经开始的下一 turn。
   */
  private finishTurn(rt: ClaudeRuntime, emit: EventSink, turn: ClaudeTurn, stopReason: string, raw?: unknown): void {
    if (turn.finalized) return;
    turn.finalized = true;
    // steer 归属对账（观测）：offer 时乐观记了 delivery:"steer"，若 turn 收口前
    // 该 uuid 未在本 turn 流中回显，说明它被 CLI 排队（或回显不带 uuid——此时
    // 每条 steer 都会报警，本身就是机制失效的信号）。保留条目：消息可能在后续
    // turn 物化，届时 case "user" 会留痕并清理。
    let orphaned = 0;
    for (const offer of rt.pendingOfferUuids?.values() ?? []) {
      if (offer.turnId === turn.turnId) orphaned++;
    }
    if (orphaned > 0) {
      this.options.log?.({
        level: "warn",
        source: "harness",
        component: "claude.steer",
        harness: this.harness,
        turnId: turn.turnId,
        message: `${orphaned} steered message(s) not observed in turn stream before finalize; attribution may be optimistic (queued CLI-side or echo lacks uuid)`,
      });
    }
    emit({
      kind: "state_update",
      payload: { state: "idle", stopReason },
      ...(raw !== undefined ? { raw } : {}),
    });
    if (rt.activeTurn === turn) rt.activeTurn = undefined;
  }

  /** 信封补齐：open 绑定的 sink + 所属 turnId。turn 内发射必须显式传 turn；跨 turn 的事件不带 turnId */
  private emit(rt: ClaudeRuntime, ev: Parameters<EventSink>[0], turn?: ClaudeTurn): void {
    rt.sink({
      ...ev,
      harnessSessionId: rt.claudeSessionId,
      turnId: (turn ?? rt.activeTurn)?.turnId,
    });
  }

  async cancel(ref: HarnessSessionHandle): Promise<void> {
    const rt = this.sessions.get(ref.handleId);
    const turn = rt?.activeTurn;
    if (!rt?.activeQuery || !turn) return;
    turn.cancelRequested = true;
    // streaming query 本身保持存活；SDK result 仍从 consumeQuery 收口当前 turn。
    const receipt = await rt.activeQuery.interrupt().catch((error) => {
      this.options.log?.({
        level: "warn",
        source: "harness",
        component: "claude.cancel",
        harness: this.harness,
        turnId: turn.turnId,
        message: "Claude SDK interrupt failed",
        error: logError(error),
      });
      return undefined;
    });
    // interrupt 不动 CLI 侧已排队的消息：steer offer 若实际被排队而非折进当前 turn，
    // 它会在 interrupt 之后自行开新 turn 跑起来。这里只做观测（匹配自己 offer 过的
    // uuid；回执里其余内部 uuid 按 SDK 契约忽略），量化后再决定是否撤回。
    for (const uuid of receipt?.still_queued ?? []) {
      const offer = rt.pendingOfferUuids?.get(uuid);
      if (!offer) continue;
      this.options.log?.({
        level: "warn",
        source: "harness",
        component: "claude.cancel",
        harness: this.harness,
        turnId: turn.turnId,
        message: `interrupt left steered message ${offer.messageId} (offered to turn ${offer.turnId}) queued CLI-side; it may still run as a new turn`,
      });
    }
  }

  async close(ref: HarnessSessionHandle): Promise<void> {
    const rt = this.sessions.get(ref.handleId);
    if (!rt) return;
    this.sessions.delete(ref.handleId);
    const turn = rt.activeTurn;
    if (turn) turn.cancelRequested = true;
    this.closeStreamingQuery(rt);
    // 宿主主动 close 时若仍有活跃 turn，合成终态，不留"已接受未终结"的悬挂状态
    if (turn) this.finishTurn(rt, (ev) => this.emit(rt, ev, turn), turn, "cancelled");
  }

  private mustSession(ref: HarnessSessionHandle): ClaudeRuntime {
    const rt = this.sessions.get(ref.handleId);
    if (!rt) throw new Error(`unknown claude session: ${ref.handleId}`);
    return rt;
  }

  private publishSessionBinding(rt: ClaudeRuntime, sessionId: string): void {
    rt.claudeSessionId = sessionId;
    if (rt.publishedSessionId === sessionId) return;
    rt.publishedSessionId = sessionId;
    rt.bindingSink?.({
      identity: { id: sessionId },
      resumeState: sessionIdResumeState(sessionId),
    });
  }

  private async handleCanUseTool(
    rt: Pick<ClaudeRuntime, "capturedProposedPlanKeys">,
    emit: EventSink,
    turnId: () => string,
    toolName: string,
    input: Record<string, unknown>,
    meta: { title?: string; suggestions?: PermissionUpdate[]; toolUseID?: string },
  ): Promise<PermissionResult> {
    if (toolName === "AskUserQuestion") return this.handleQuestion(turnId, input, meta.toolUseID);
    if (toolName === "ExitPlanMode") {
      this.captureProposedPlan(rt, emit, turnId(), input, meta.toolUseID, { toolName, input, meta });
      return {
        behavior: "deny",
        message:
          "Baton captured the proposed plan. Stop here and wait for user feedback or a later implementation request.",
      };
    }
    const suggestions = meta.suggestions ?? [];
    const interaction: InteractionDraft = {
      kind: "permission",
      title: meta.title ?? claudeToolTitle(toolName, input),
      ...(meta.toolUseID ? { toolCallId: meta.toolUseID } : {}),
      options: claudeApprovalOptions(suggestions.length > 0),
    };
    const result = await this.options.interactionHandler(interaction, {
      turnId: turnId(),
      raw: { toolName, input, meta },
    });
    if (result.kind === "cancelled") {
      return { behavior: "deny", message: "turn interrupted before approval" };
    }
    // result 按 interactionId 路由回来，kind 必配对 permission；意外不配一律保守拒绝。
    const optionId = result.kind === "permission" ? result.optionId : "";
    if (optionId === "allow") return { behavior: "allow", updatedInput: input };
    if (optionId === "allowAlways") {
      // SDK 契约：把 canUseTool 收到的整组 suggestions 原样作为 updatedPermissions
      // 返回，即 CLI "Yes, don't ask again" 的同款授权路径
      return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions };
    }
    return { behavior: "deny", message: "denied by baton user" };
  }

  private async handleQuestion(
    turnId: () => string,
    input: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<PermissionResult> {
    const source = Array.isArray(input.questions) ? input.questions : [];
    const questions: QuestionPrompt[] = source.map((value, index) => {
      const question = (value ?? {}) as Record<string, unknown>;
      return {
        questionId: `q${index}`,
        header: String(question.header ?? `Question ${index + 1}`),
        question: String(question.question ?? ""),
        choices: Array.isArray(question.options)
          ? question.options.map((option) => {
              const item = (option ?? {}) as Record<string, unknown>;
              const label = String(item.label ?? "");
              return {
                value: label,
                label,
                description: String(item.description ?? ""),
                ...(typeof item.preview === "string" ? { preview: item.preview } : {}),
              };
            })
          : undefined,
        multiSelect: question.multiSelect === true,
        // Claude Code adds Other automatically for AskUserQuestion.
        allowOther: true,
      };
    });
    const interaction: InteractionDraft = {
      kind: "question",
      ...(toolCallId ? { toolCallId } : {}),
      questions,
    };
    const result = await this.options.interactionHandler(interaction, {
      turnId: turnId(),
      raw: input,
    });
    if (result.kind === "cancelled") {
      return { behavior: "deny", message: "turn interrupted before answer" };
    }
    const decisionAnswers = result.kind === "question" ? result.answers : {};
    const answers = Object.fromEntries(
      questions.map((question) => [question.question, (decisionAnswers[question.questionId] ?? []).join(", ")]),
    );
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  private captureProposedPlan(
    rt: Pick<ClaudeRuntime, "capturedProposedPlanKeys">,
    emit: EventSink,
    turnId: string,
    input: Record<string, unknown>,
    toolUseId: string | undefined,
    raw: unknown,
  ): void {
    const draft = claudeProposedPlanDraft(rt, turnId, input, toolUseId, raw);
    if (draft) emit(draft);
  }

  private handleMessage(rt: ClaudeRuntime, emit: EventSink, msg: SDKMessage, turn: ClaudeTurn): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") this.publishSessionBinding(rt, msg.session_id);
        else if (msg.subtype === "status") {
          // SDK 的 status 原生就是 phase-or-null 形状（'compacting' | 'requesting' | null）。
          // 只有 compacting 值得成为可见阶段；requesting 是普通运行态，与 null 一样
          // 归一成"无阶段"（回落默认 thinking），未来未知 status 同样安全降级。
          emit({
            kind: "_baton_run_status",
            payload:
              msg.status === "compacting"
                ? { phase: "compacting", title: "Compacting context…" }
                : { phase: null },
            raw: msg,
          });
        } else if (msg.subtype === "commands_changed") {
          emit({
            kind: "available_commands_update",
            payload: {
              commands: msg.commands.map((command) => ({
                name: command.name,
                ...(command.description ? { description: command.description } : {}),
                ...(command.argumentHint ? { input: { hint: command.argumentHint } } : {}),
              })),
            },
            raw: msg,
          });
        } else if (msg.subtype === "task_started") {
          emit({
            kind: "task_update",
            payload: {
              taskId: msg.task_id,
              status: "in_progress",
              title: msg.description,
              ...(msg.subagent_type ?? msg.task_type
                ? { taskType: msg.subagent_type ?? msg.task_type }
                : {}),
              ...(msg.skip_transcript !== undefined
                ? { skipTranscript: msg.skip_transcript }
                : {}),
            },
            raw: msg,
          });
        } else if (msg.subtype === "task_progress") {
          emit({
            kind: "task_update",
            payload: {
              taskId: msg.task_id,
              status: "in_progress",
              title: msg.description,
              ...(msg.subagent_type ? { taskType: msg.subagent_type } : {}),
              ...(msg.summary ? { summary: msg.summary } : {}),
              ...(msg.last_tool_name ? { lastToolName: msg.last_tool_name } : {}),
              usage: {
                totalTokens: msg.usage.total_tokens,
                toolUses: msg.usage.tool_uses,
                durationMs: msg.usage.duration_ms,
              },
            },
            raw: msg,
          });
        } else if (msg.subtype === "task_notification") {
          emit({
            kind: "task_update",
            payload: {
              taskId: msg.task_id,
              status: msg.status,
              summary: msg.summary,
              usage: msg.usage
                ? {
                    totalTokens: msg.usage.total_tokens,
                    toolUses: msg.usage.tool_uses,
                    durationMs: msg.usage.duration_ms,
                  }
                : undefined,
              ...(msg.skip_transcript !== undefined
                ? { skipTranscript: msg.skip_transcript }
                : {}),
            },
            raw: msg,
          });
        } else if (!CLAUDE_IGNORED_SYSTEM_SUBTYPES.has(msg.subtype)) {
          this.noticeUnmappedMessage(rt, `system/${msg.subtype}`);
        }
        break;
      case "stream_event": {
        // 子 agent（parent_tool_use_id 非空）的流式输出不进主时间线，内容随 tool result 汇总
        if (msg.parent_tool_use_id) break;
        const event = msg.event as {
          type: string;
          delta?: { type: string; text?: string; thinking?: string };
          message?: {
            model?: string;
            usage?: {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
        };
        if (event.type === "message_start") {
          turn.streamMessageId = newId("m");
          // 每次模型调用开端的 usage 即当时的真实 context 占用；turn 内多次调用取最后一次，
          // compact 后新 sample 自然回落。子 agent 已在上面被 parent_tool_use_id 过滤。
          const usage = event.message?.usage;
          if (usage) {
            rt.lastContextSample = {
              ...(event.message?.model ? { model: event.message.model } : {}),
              inputTokens: usage.input_tokens ?? 0,
              cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
              cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
            };
          }
        } else if (event.type === "content_block_delta" && event.delta) {
          const messageId = turn.streamMessageId ?? (turn.streamMessageId = newId("m"));
          if (event.delta.type === "text_delta" && event.delta.text) {
            emit({
              kind: "agent_message_chunk",
              payload: { messageId, content: { type: "text", text: event.delta.text } },
              raw: msg,
            });
          } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
            emit({
              kind: "agent_thought_chunk",
              payload: { messageId: `${messageId}_thought`, content: { type: "text", text: event.delta.thinking } },
              raw: msg,
            });
          }
        }
        break;
      }
      case "assistant": {
        const blocks = (msg.message.content ?? []) as unknown as Array<Record<string, unknown>>;
        const hasDurableMessage = blocks.some(
          (block) => block.type === "text" || block.type === "thinking",
        );
        const messageId = turn.streamMessageId ?? newId("m");
        for (const draft of claudeDurableMessageDrafts(rt, msg, {
          turnId: turn.turnId,
          messageId,
          raw: msg,
        })) {
          emit(draft);
        }
        if (hasDurableMessage && !msg.parent_tool_use_id) {
          // 最终全文 upsert 与 chunk 共用 messageId，完成后下一条 assistant 消息另开 id。
          turn.streamMessageId = undefined;
        }
        break;
      }
      case "user": {
        // steer offer 的 uuid 在流中回显 = 归属确认。若回显落在别的 turn，
        // 说明该消息当时被 CLI 排队、后来才自成回合——之前记的 delivery:"steer"
        // 是乐观归属，此处如实留痕。
        const echoedUuid = "uuid" in msg && typeof msg.uuid === "string" ? msg.uuid : undefined;
        const offer = echoedUuid ? rt.pendingOfferUuids?.get(echoedUuid) : undefined;
        if (offer && echoedUuid) {
          rt.pendingOfferUuids?.delete(echoedUuid);
          if (offer.turnId !== turn.turnId) {
            this.options.log?.({
              level: "info",
              source: "harness",
              component: "claude.steer",
              harness: this.harness,
              turnId: turn.turnId,
              message: `steered message ${offer.messageId} offered to turn ${offer.turnId} materialized in turn ${turn.turnId}`,
            });
          }
        }
        for (const draft of claudeDurableMessageDrafts(rt, msg, {
          turnId: turn.turnId,
          raw: msg,
        })) {
          emit(draft);
        }
        break;
      }
      case "result": {
        const usage = msg.usage;
        if (usage) {
          emit({
            kind: "usage_update",
            payload: {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            },
            raw: msg,
          });
        }
        const context = claudeContextUsage(msg.modelUsage, rt.model, rt.lastContextSample);
        if (context) {
          emit({
            kind: "context_usage_update",
            payload: { model: rt.model ?? "default", ...context },
            raw: msg,
          });
        }
        // SDK 内部重试耗尽后以 success result + api_error_status 收口（v0.3.223 起，
        // 典型为 529 过载）；结构化为错误事件，避免被当普通 end_turn 静默吞掉。
        if (msg.subtype === "success" && typeof msg.api_error_status === "number") {
          const status = msg.api_error_status;
          emit({
            kind: "_baton_error_update",
            payload: {
              code: `api_error_${status}`,
              message:
                status === 529
                  ? "Claude API overloaded (529): retries exhausted, turn ended early"
                  : `Claude API error (HTTP ${status}): turn ended early`,
              retryable: status >= 500,
              willRetry: false,
            },
            raw: msg,
          });
        }
        this.finishTurn(
          rt,
          emit,
          turn,
          turn.cancelRequested ? "cancelled" : msg.subtype === "success" ? "end_turn" : msg.subtype,
          msg,
        );
        break;
      }
      default:
        if (!CLAUDE_IGNORED_MESSAGE_TYPES.has(msg.type)) {
          this.noticeUnmappedMessage(rt, msg.type);
        }
    }
  }

  private noticeUnmappedMessage(rt: ClaudeRuntime, key: string): void {
    const seen = (rt.unmappedMessageKeys ??= new Set());
    if (seen.has(key)) return;
    seen.add(key);
    this.options.log?.({
      level: "warn",
      source: "harness",
      component: "claude.protocol",
      harness: this.harness,
      turnId: rt.currentTurn?.turnId,
      message: `unmapped Claude SDK message: ${key}`,
      attributes: { count: 1 },
    });
  }
}

const CLAUDE_IGNORED_SYSTEM_SUBTYPES = new Set<string>([
  "background_tasks_changed",
  "compact_boundary",
  "control_request_progress",
  "elicitation_complete",
  "hook_progress",
  "hook_response",
  "hook_started",
  "memory_recall",
  "plugin_install",
  "task_updated",
]);

const CLAUDE_IGNORED_MESSAGE_TYPES = new Set<string>([
  "api_retry",
  "auth_status",
  "control_request_progress",
  "elicitation_complete",
  "files_persisted",
  "hook_progress",
  "hook_response",
  "hook_started",
  "informational",
  "local_command_output",
  "model_refusal_fallback",
  "model_refusal_no_fallback",
  "notification",
  "permission_denied",
  "plugin_install",
  "prompt_suggestion",
  "rate_limit_event",
  "session_state_changed",
  "thinking_tokens",
  "tool_progress",
  "tool_use_summary",
  "worker_shutting_down",
]);
