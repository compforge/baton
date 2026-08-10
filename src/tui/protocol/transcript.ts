// Baton Session timeline → chat-tui TranscriptItem。
import type {
  BlockTone,
  DiffOp,
  TranscriptBlockContent,
  TranscriptBlockStatus,
  TranscriptItem,
} from "chat-tui";

import {
  textOf,
  type ApprovalReviewUpdate,
  type DiffBlock,
} from "../../event/types.ts";
import { harnessShortName } from "../../harness/registry.ts";
import {
  isTurnRunning,
  type SessionState,
  type ToolCallState,
} from "../../store/reduce.ts";
import { composerTextOf } from "../prompt-images.ts";

// Baton 的状态类型是开放联合（容忍未知 wire 值），chat-tui 是闭集；
// 未知值回落到与旧 TUI 相同的展示形态（工具 ⋯ / 计划 ☐）。
const TOOL_STATUSES = new Set(["pending", "in_progress", "completed", "failed", "declined"]);
const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);
const DIFF_OPS = new Set<DiffOp>(["add", "modify", "delete", "move"]);

function harnessAuthor(harness: string | undefined): string | undefined {
  if (!harness) return undefined;
  return harnessShortName(harness);
}

export function userVisibleText(text: string): string {
  return text.replace(/<baton-(context|sync)>[\s\S]*<\/baton-\1>\s*/g, "").trim();
}

export interface ThoughtDisplayBlock {
  title: string;
  content?: string;
}

/** 将 reasoning summary 投影成独立时间线块，并隐藏 Codex 的空正文占位符。 */
export function thoughtDisplayBlocks(text: string): ThoughtDisplayBlock[] {
  return text
    .replace(/\r?\n\r?\n<!--\s*$/, "")
    .split(/\r?\n\r?\n<!-- -->\s*(?:\r?\n)?/g)
    .flatMap((part) => {
      const content = part.trim();
      if (!content) return [];
      const summary = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n([\s\S]*))?$/);
      if (summary) {
        const body = summary[2]?.trim();
        return [{ title: summary[1]!.trim(), ...(body ? { content: body } : {}) }];
      }
      const [title, ...body] = content.split(/\r?\n/);
      const detail = body.join("\n").trim();
      return [{ title: title!.trim(), ...(detail ? { content: detail } : {}) }];
    });
}

function normalizeToolStatus(
  status: string,
): "pending" | "in_progress" | "completed" | "failed" | "declined" {
  return (TOOL_STATUSES.has(status) ? status : "in_progress") as ReturnType<
    typeof normalizeToolStatus
  >;
}

export function normalizePlanStatus(
  status: string,
): "pending" | "in_progress" | "completed" {
  return (PLAN_STATUSES.has(status) ? status : "pending") as ReturnType<
    typeof normalizePlanStatus
  >;
}

function commandOf(tc: ToolCallState, fallback: string): string {
  const input = tc.rawInput as Record<string, unknown> | undefined;
  return typeof input?.command === "string" ? input.command : fallback;
}

/** 事件模型的开放 operation → chat-tui 的闭合 DiffOp；未知操作按 modify 处理。 */
function diffOpOf(operation: string): DiffOp {
  if (operation === "update") return "modify";
  if (operation === "rename") return "move";
  return DIFF_OPS.has(operation as DiffOp) ? (operation as DiffOp) : "modify";
}

/** 命令卡标题的时态即事实：declined 的命令没有跑过，不能写 Ran。 */
function executeTitleOf(status: ReturnType<typeof normalizeToolStatus>): string {
  if (status === "in_progress") return "Running";
  if (status === "declined") return "Declined";
  return "Ran";
}

/** 工具状态 → chat-tui 展示块；命令源码和 diff 保持结构化，避免组件层猜字符串。 */
export function toolTranscriptItem(
  tc: ToolCallState,
): Extract<TranscriptItem, { type: "block" }> {
  const status = normalizeToolStatus(tc.status);
  const rawTitle = tc.title ?? tc.toolCallId;
  const content: TranscriptBlockContent[] = [];

  if (tc.kind === "execute") {
    content.push({ type: "command", command: commandOf(tc, rawTitle) });
  }

  for (const block of tc.content) {
    if (block.type !== "diff") continue;
    const diff = block as DiffBlock;
    for (const [index, change] of diff.changes.entries()) {
      content.push({
        type: "diff",
        op: diffOpOf(change.operation),
        path: change.path,
        oldPath: change.oldPath,
        patch: index === 0 ? diff.patch : undefined,
      });
    }
  }

  const outputLines = textOf(tc.content).split("\n").filter(Boolean);
  if (outputLines.length > 0) content.push({ type: "output", lines: outputLines });

  return {
    type: "block",
    id: tc.toolCallId,
    kind: "tool",
    author: harnessAuthor(tc.harness),
    title: tc.kind === "execute" ? executeTitleOf(status) : rawTitle,
    status,
    content: content.length > 0 ? content : undefined,
  };
}

const REVIEW_DISPLAY: Record<
  ApprovalReviewUpdate["decision"],
  { status: TranscriptBlockStatus; tone?: BlockTone }
> = {
  approved: { status: "completed", tone: "warning" },
  denied: { status: "declined" },
  aborted: { status: "failed" },
};

function approvalReviewTranscriptItem(review: ApprovalReviewUpdate): TranscriptItem {
  const facts = [
    review.riskLevel ? `risk: ${review.riskLevel}` : undefined,
    review.userAuthorization ? `authorization: ${review.userAuthorization}` : undefined,
  ].filter(Boolean);
  const suffix = facts.length > 0 ? ` (${facts.join(", ")})` : "";
  return {
    type: "block",
    id: `approval-review:${review.reviewId}`,
    kind: "notice",
    ...REVIEW_DISPLAY[review.decision],
    title: `Automatic approval review ${review.decision}${suffix}`,
    content: review.rationale ? { type: "text", text: review.rationale } : undefined,
  };
}

/**
 * SessionState → chat-tui 时间线。harness 内容在这里收敛为通用展示形状；
 * pinnedPlanId 对应正在由 pin 区承载的计划，避免同屏出现两份。
 */
export function buildTranscript(
  state: SessionState,
  pinnedPlanId?: string,
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const noticesById = new Map(state.notices.map((notice) => [`n_${notice.seq}`, notice]));
  for (const entry of state.timeline) {
    if (entry.type === "notice") {
      const notice = noticesById.get(entry.id);
      if (!notice) continue;
      items.push({
        type: "block",
        id: entry.id,
        kind: "notice",
        status: notice.level === "info" ? "pending" : "failed",
        title: notice.detail ? `${notice.title} · ${notice.detail}` : notice.title,
      });
      continue;
    }
    if (entry.type === "error") {
      const error = state.errors.get(entry.id);
      if (!error) continue;
      items.push({
        type: "block",
        id: entry.id,
        kind: "error",
        status: "failed",
        title: error.code ? `Error: ${error.code}` : "Error",
        content: { type: "text", text: error.message },
      });
      continue;
    }
    if (entry.type === "message") {
      const msg = state.messages.get(entry.id);
      if (!msg) continue;
      if (msg.role === "thought") {
        const turnCompleted = state.turnSummaries.some(
          (summary) => summary.turnId === msg.turnId,
        );
        const status =
          msg.streamStatus === "completed" ||
          turnCompleted ||
          !isTurnRunning(state, msg.turnId)
            ? "completed"
            : "in_progress";
        for (const [index, block] of thoughtDisplayBlocks(textOf(msg.content)).entries()) {
          items.push({
            type: "block",
            id: `${entry.id}:${index}`,
            kind: "thought",
            status,
            author: harnessAuthor(msg.harness),
            title: block.title,
            content: block.content ? { type: "text", text: block.content } : undefined,
          });
        }
        continue;
      }
      const author =
        msg.role === "user" ? "you" : (harnessAuthor(msg.harness) ?? "agent");
      items.push({
        type: "message",
        id: entry.id,
        role: msg.role === "user" ? "user" : "agent",
        author,
        text:
          msg.role === "user"
            ? userVisibleText(composerTextOf(msg.content))
            : textOf(msg.content),
        ...(msg.role === "agent"
          ? {
              format: "markdown" as const,
              streaming:
                msg.streamStatus === "in_progress" &&
                isTurnRunning(state, msg.turnId),
            }
          : { format: "plain" as const }),
      });
      continue;
    }
    if (entry.type === "tool_call") {
      const tc = state.toolCalls.get(entry.id);
      if (tc) items.push(toolTranscriptItem(tc));
      continue;
    }
    if (entry.type === "approval_review") {
      const review = state.approvalReviews.get(entry.id);
      if (review) items.push(approvalReviewTranscriptItem(review));
      continue;
    }
    if (entry.type === "proposed_plan") {
      const proposal = state.proposedPlans.get(entry.id);
      if (!proposal) continue;
      items.push({
        type: "block",
        id: entry.id,
        kind: "proposed_plan",
        status: "completed",
        author: harnessAuthor(proposal.harness),
        title: proposal.implementationTurnId
          ? "Proposed plan · implementation started"
          : "Proposed plan",
        content: { type: "text", text: proposal.content },
      });
      continue;
    }
    if (entry.type === "task") {
      const task = state.tasks.get(entry.id);
      if (!task) continue;
      const status = task.status === "stopped" ? "failed" : task.status;
      const details = [
        task.summary,
        task.lastToolName ? `Last tool: ${task.lastToolName}` : undefined,
      ].filter((value): value is string => Boolean(value));
      items.push({
        type: "block",
        id: entry.id,
        kind: "task",
        status,
        author: harnessAuthor(task.harness),
        title: task.title ?? task.taskType ?? "Background task",
        ...(details.length
          ? { content: { type: "lines", lines: details } }
          : {}),
      });
      continue;
    }
    if (entry.type !== "plan") continue;
    const plan = state.plans.get(entry.id);
    if (!plan || plan.planId === pinnedPlanId) continue;
    const entries = plan.entries.map((entry) => ({
      content: entry.content,
      status: normalizePlanStatus(entry.status),
    }));
    const status =
      entries.length > 0 && entries.every((entry) => entry.status === "completed")
        ? "completed"
        : entries.some(
              (entry) =>
                entry.status === "in_progress" || entry.status === "completed",
            )
          ? "in_progress"
          : "pending";
    items.push({
      type: "block",
      id: entry.id,
      kind: "plan",
      title: "Plan",
      status,
      content: { type: "plan", entries },
    });
  }
  return items;
}
