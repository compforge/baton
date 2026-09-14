import { newId } from "../../event/ids.ts";
import type { AnyEventDraft, ContentBlock, DiffBlock, PlanEntry, ToolEffect } from "../../event/index.ts";
import { planEntriesWithIds } from "../../event/plan.ts";
import type { PermissionOption } from "../../interaction/types.ts";
import { planSnapshotDraft } from "../plan.ts";

const ALLOW_ONCE: PermissionOption = {
  optionId: "allow",
  name: "Allow once",
  polarity: "allow",
  lifetime: "once",
};
const DENY: PermissionOption = {
  optionId: "deny",
  name: "Deny",
  polarity: "reject",
  lifetime: "once",
};

export interface ClaudeApprovalHints {
  hasSuggestions: boolean;
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
}

/**
 * 审批候选。always 项只在 SDK 给出 permission suggestions 时提供：baton 不自造
 * 授权规则，只透传 CLI "don't ask again" 的同款路径（选中后把整组 suggestions
 * 作为 updatedPermissions 返回，规则作用域由 SDK 决定，通常是 session 级）。
 *
 * lifetime 取 `persistent` 而非 `session`：作用域实际由 SDK 定、baton 不确知，
 * 而在审批展示上低报持续性才是危险的一侧（用户以为一次性、实则长期）。悲观取强档，
 * 与 name 的 "don't ask again" 一致（不变量 #2）。SDK 要求 suppress 时删除该项；
 * defaultToNo 时把拒绝放首位，对齐 chat-tui 默认选中第一项的交互。
 */
export function claudeApprovalOptions(hints: ClaudeApprovalHints): PermissionOption[] {
  const allowOptions: PermissionOption[] = [ALLOW_ONCE];
  if (hints.hasSuggestions && !hints.suppressAlwaysAllowRule) {
    allowOptions.push({
      optionId: "allowAlways",
      name: "Always allow (don't ask again)",
      polarity: "allow",
      lifetime: "persistent",
    });
  }
  return hints.defaultToNo ? [DENY, ...allowOptions] : [...allowOptions, DENY];
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

/**
 * Claude 工具名 → effect 声明。只有工具自身语义能证明读写时才上报；Bash、
 * Task、AskUserQuestion 等不上报，由消费方保守处理。
 */
export function claudeToolEffect(
  toolName: string,
  _input: Record<string, unknown>,
): ToolEffect | undefined {
  switch (toolName) {
    case "Read":
    case "NotebookRead":
    case "Grep":
    case "Glob":
    case "WebFetch":
    case "WebSearch":
    case "BashOutput":
      return "read";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
    case "KillShell":
      return "write";
    default:
      return undefined;
  }
}

/** 工具调用的一行标题：工具名 + 最有辨识度的入参 */
export function claudeToolTitle(toolName: string, input: Record<string, unknown>): string {
  const detail =
    input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.skill ?? input.description;
  return detail !== undefined ? `${toolName}: ${String(detail)}` : toolName;
}

/** TodoWrite 入参 → 统一 plan entries（最大公约数规范：计划一律走 plan_update） */
export function todoWritePlan(planId: string, input: Record<string, unknown>): PlanEntry[] {
  const todos = (Array.isArray(input.todos) ? input.todos : []) as Array<Record<string, unknown>>;
  return planEntriesWithIds(planId, todos.map((t) => ({
    content: String(t.content ?? ""),
    priority: "medium",
    status: t.status === "in_progress" || t.status === "completed" ? (t.status as string) : "pending",
  })));
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
  return [...tasks.entries()].map(([id, task]) => ({
    id,
    content: task.subject,
    priority: "medium",
    status: task.status,
  }));
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
        const planId = `pl_${options.turnId}`;
        // per-turn plan 锚定当前 scrollback 位置，本 turn 内的更新原地 mark。
        drafts.push(planSnapshotDraft(planId, todoWritePlan(planId, input), raw));
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
          effect: claudeToolEffect(toolName, input),
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
        drafts.push(planSnapshotDraft(
          `pl_${options.turnId}`,
          taskPlanEntries(state.tasks),
          raw,
        ));
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
