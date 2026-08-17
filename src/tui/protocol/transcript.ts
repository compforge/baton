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
} from "../../event/index.ts";
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

const TOOL_KIND_LABELS: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  fetch: "Fetch",
  think: "Think",
};

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function compactText(value: string, maxLength = 64): string {
  const [first = ""] = value.trim().split(/\r?\n/, 1);
  const suffix = value.includes("\n") ? " …" : "";
  if (first.length + suffix.length <= maxLength) return first + suffix;
  return `${first.slice(0, Math.max(1, maxLength - 1))}…`;
}

/** 路径只裁头不裁尾，让卡片在窄终端上仍保留最有辨识度的文件名。 */
function compactPath(value: string, maxLength = 64): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) return normalized;
  return `…${normalized.slice(-(maxLength - 1))}`;
}

function firstDiffPath(tc: ToolCallState): string | undefined {
  for (const block of tc.content) {
    if (block.type !== "diff") continue;
    const path = (block as DiffBlock).changes.find((change) => change.path)?.path;
    if (path) return path;
  }
  return undefined;
}

/** 已归一 tool kind + 白名单入参 → 标题里的关键参数；不递归 dump 任意 raw payload。 */
function toolKeyArg(tc: ToolCallState, fallback: string): string | undefined {
  const input = recordOf(tc.rawInput);
  const nested = recordOf(input?.arguments ?? input?.input);
  if (tc.kind === "execute") return compactText(commandOf(tc, fallback));
  if (tc.kind === "read" || tc.kind === "edit" || tc.kind === "delete" || tc.kind === "move") {
    const direct = firstString(input, ["file_path", "filePath", "path", "old_path", "oldPath"]);
    const nestedPath = firstString(nested, ["file_path", "filePath", "path"]);
    const changes = Array.isArray(input?.changes) ? input.changes : [];
    const changedPath = changes
      .map((change) => firstString(recordOf(change), ["path", "file_path"]))
      .find(Boolean);
    const path = direct ?? nestedPath ?? changedPath ?? tc.locations[0] ?? firstDiffPath(tc);
    return path ? compactPath(path) : undefined;
  }
  if (tc.kind === "search") {
    const query = firstString(input, ["pattern", "query", "glob"]) ??
      firstString(nested, ["pattern", "query", "glob"]);
    return query ? compactText(query) : undefined;
  }
  if (tc.kind === "fetch") {
    const target = firstString(input, ["url", "query"]) ?? firstString(nested, ["url", "query"]);
    return target ? compactText(target) : undefined;
  }
  const detail = firstString(input, ["description", "prompt", "skill", "query", "path"]) ??
    firstString(nested, ["description", "prompt", "skill", "query", "path"]);
  return detail ? compactText(detail) : undefined;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function patchStats(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

function toolResultStats(tc: ToolCallState, outputLines: string[]): string[] {
  const diffs = tc.content.filter((block): block is DiffBlock => block.type === "diff");
  const files = diffs.reduce((count, diff) => count + diff.changes.length, 0);
  const changes = diffs.reduce(
    (total, diff) => {
      const next = diff.patch ? patchStats(diff.patch) : { added: 0, removed: 0 };
      return { added: total.added + next.added, removed: total.removed + next.removed };
    },
    { added: 0, removed: 0 },
  );
  const stats: string[] = [];
  if (files > 0) stats.push(countLabel(files, "file"));
  if (changes.added > 0 || changes.removed > 0) stats.push(`+${changes.added} -${changes.removed}`);
  if (outputLines.length > 0) stats.push(countLabel(outputLines.length, "line"));
  return stats;
}

function toolDisplayTitle(
  tc: ToolCallState,
  status: ReturnType<typeof normalizeToolStatus>,
  rawTitle: string,
  outputLines: string[],
): string {
  const keyArg = toolKeyArg(tc, rawTitle);
  let action = rawTitle;
  if (tc.kind === "execute") {
    action = executeTitleOf(status);
  } else if (keyArg) {
    const colon = rawTitle.indexOf(":");
    action = colon > 0 ? rawTitle.slice(0, colon).trim() : (TOOL_KIND_LABELS[tc.kind ?? ""] ?? rawTitle);
  }
  return [action, keyArg, ...toolResultStats(tc, outputLines)].filter(Boolean).join(" · ");
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
    title: toolDisplayTitle(tc, status, rawTitle, outputLines),
    status,
    content: content.length > 0 ? content : undefined,
  };
}

// 只有探索类工具(read/search/fetch)允许聚合成组行:execute 的命令原文是审查面,
// edit/delete/move 的 diff 按 chat-tui 既定决策永不裁剪,折叠它们都会藏住关键信息。
const GROUPABLE_TOOL_KINDS = new Set(["read", "search", "fetch"]);

/**
 * 可分组工具的分组键:同 kind + 同 turn + 同 harness target 的连续调用才并组;
 * undefined = 该调用不参与分组。failed/declined 不进组——错误详情必须单独成块显眼展示。
 */
export function toolGroupKey(tc: ToolCallState): string | undefined {
  if (!tc.kind || !GROUPABLE_TOOL_KINDS.has(tc.kind)) return undefined;
  const status = normalizeToolStatus(tc.status);
  if (status === "failed" || status === "declined") return undefined;
  return JSON.stringify([tc.kind, tc.turnId ?? "", tc.harnessTargetId ?? ""]);
}

/**
 * N≥2 个同键调用 → 聚合 block。id 取首成员 toolCallId 并随组增长保持稳定:
 * 组从单块升级为聚合块时 chat-tui 按 key 原地复用 renderable,避免重挂载残留
 * (见 chat-tui transcript.tsx 的 OpenTUI 注释)。子行只是摘要,原始 output 不进聚合块。
 */
export function toolGroupTranscriptItem(
  tcs: readonly ToolCallState[],
): Extract<TranscriptItem, { type: "block" }> {
  const first = tcs[0]!;
  const isRunning = (tc: ToolCallState) =>
    ["pending", "in_progress"].includes(normalizeToolStatus(tc.status));
  const lines = tcs.map((tc) => {
    const keyArg = toolKeyArg(tc, tc.title ?? tc.toolCallId) ??
      compactText(tc.title ?? tc.toolCallId);
    const stats = toolResultStats(tc, textOf(tc.content).split("\n").filter(Boolean));
    return `${isRunning(tc) ? "• " : ""}${[keyArg, ...stats].filter(Boolean).join(" · ")}`;
  });
  return {
    type: "block",
    id: first.toolCallId,
    kind: "tool",
    author: harnessAuthor(first.harness),
    title: `${TOOL_KIND_LABELS[first.kind ?? ""] ?? first.kind} ×${tcs.length}`,
    status: tcs.some(isRunning) ? "in_progress" : "completed",
    content: { type: "lines", lines },
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
  options: {
    isSideLane?: (laneId: string) => boolean;
  } = {},
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let pendingToolGroup: ToolCallState[] = [];
  let pendingToolGroupKey: string | undefined;
  const flushToolGroup = () => {
    if (pendingToolGroup.length === 1) {
      items.push(toolTranscriptItem(pendingToolGroup[0]!));
    } else if (pendingToolGroup.length > 1) {
      items.push(toolGroupTranscriptItem(pendingToolGroup));
    }
    pendingToolGroup = [];
    pendingToolGroupKey = undefined;
  };
  const hidden = (laneId: string | undefined) =>
    laneId !== undefined && options.isSideLane?.(laneId) === true;
  const noticesById = new Map(state.notices.map((notice) => [`n_${notice.seq}`, notice]));
  for (const entry of state.timeline) {
    if (entry.type === "tool_call") {
      const tc = state.toolCalls.get(entry.id);
      if (!tc || hidden(tc.laneId)) continue;
      const groupKey = toolGroupKey(tc);
      if (groupKey !== undefined) {
        if (pendingToolGroupKey === groupKey) {
          pendingToolGroup.push(tc);
          continue;
        }
        flushToolGroup();
        pendingToolGroup = [tc];
        pendingToolGroupKey = groupKey;
        continue;
      }
      flushToolGroup();
      items.push(toolTranscriptItem(tc));
      continue;
    }
    flushToolGroup();
    if (entry.type === "notice") {
      const notice = noticesById.get(entry.id);
      if (!notice) continue;
      if (hidden(notice.laneId)) continue;
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
      if (hidden(error.laneId)) continue;
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
      if (hidden(msg.laneId)) continue;
      // Harness 接受 steer 只代表承担投递责任。只有 applied 才是模型已看到的
      // Transcript 历史；pending 留在 Composer Queue，failed 由诊断事件说明且不伪造历史。
      // 投递事实以 input 投影（input_delivery_update）为准：有 input 记录时 outcome
      // 未填写即未应用；没有 input 记录的老 ledger 才回落 user_message.deliveryState。
      if (msg.role === "user" && msg.delivery === "steer") {
        const input = state.harnessInputs.get(msg.messageId);
        if (input) {
          if (input.deliveryOutcome !== "applied") continue;
        } else if (msg.deliveryState !== undefined && msg.deliveryState !== "applied") {
          continue;
        }
      }
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
        msg.role === "user"
          ? msg.source?.type === "plugin"
            ? msg.source.pluginInstanceId
            : "you"
          : (harnessAuthor(msg.harness) ?? "agent");
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
    if (entry.type === "harness_invocation") {
      const request = state.harnessInvocations.get(entry.id);
      if (!request) continue;
      if (
        request.newLane &&
        (request.phase === "queued" ||
          request.phase === "running" ||
          request.phase === "uncertain")
      ) {
        continue;
      }
      const status: TranscriptBlockStatus =
        request.phase === "completed"
          ? request.result?.stopReason === "error" || request.result?.stopReason === "failed"
            ? "failed"
            : "completed"
          : request.phase === "cancelled"
            ? "declined"
            : request.phase === "failed"
              ? "failed"
              : request.phase === "running" || request.phase === "uncertain"
                ? "in_progress"
                : "pending";
      const details = [
        request.pluginInstanceId ? `Requested by ${request.pluginInstanceId}` : undefined,
        request.harnessTargetId ? `Target: ${request.harnessTargetId}` : undefined,
        request.laneId ? `Lane: ${request.laneId}` : undefined,
        request.result?.agentText,
        request.failure?.detail,
        request.phase === "uncertain" ? "Delivery outcome is uncertain" : undefined,
      ].filter((value): value is string => Boolean(value));
      items.push({
        type: "block",
        id: `harness-invocation:${request.invocationId}`,
        kind: "task",
        status,
        author: request.pluginInstanceId,
        title: `${request.title} · ${request.phase}`,
        ...(details.length > 0
          ? { content: { type: "lines", lines: details } }
          : {}),
      });
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
      if (hidden(proposal.laneId)) continue;
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
      if (hidden(task.laneId)) continue;
      if (task.status === "in_progress") continue;
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
    if (hidden(plan.laneId)) continue;
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
  flushToolGroup();
  return items;
}
