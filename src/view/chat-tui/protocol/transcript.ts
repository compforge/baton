// Baton Session timeline → chat-tui TranscriptItem。
import type {
  BlockTone,
  DiffOp,
  TranscriptBlockContent,
  TranscriptBlockItem,
  TranscriptBlockStatus,
  TranscriptGroupItem,
  TranscriptItem,
} from "chat-tui";

import {
  textOf,
  type ApprovalReviewUpdate,
  type DiffBlock,
} from "../../../event/index.ts";
import { harnessShortName } from "../../../harness/registry.ts";
import {
  isTurnRunning,
  type MessageState,
  type SessionState,
  type ToolCallState,
} from "../../../store/reduce.ts";
import {
  contentViewPolicy,
  toolViewPolicy,
  type ViewPolicy,
} from "../../policy.ts";
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

/**
 * 将 reasoning summary 投影成时间线块。Codex 用 `<!-- -->` 表示只有状态标题、没有
 * 可展示摘要；这类 part 不进入 transcript。带正文时沿用 Codex 的处理，只展示正文而
 * 不重复已经在 activity 中出现过的标题。
 */
export function thoughtDisplayBlocks(text: string): ThoughtDisplayBlock[] {
  return text
    .split(/\r?\n(?=\*\*[^*\n]+\*\*(?:\r?\n|$))/g)
    .flatMap((part) => {
      const content = part.trim();
      if (!content) return [];
      const summary = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n([\s\S]*))?$/);
      if (summary) {
        const body = summary[2]?.trim();
        if (body?.startsWith("<!--")) return [];
        if (body) {
          const [title, ...details] = body.split(/\r?\n/);
          const detail = details.join("\n").trim();
          return [{ title: title!.trim(), ...(detail ? { content: detail } : {}) }];
        }
        return [{ title: summary[1]!.trim() }];
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
  execute: "Ran",
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

// ViewPolicy 把信息价值与 effect 解耦：只有 background + summary 内容参加过程分组；
// important 内容保留独立位置，完整 diff / output 仍只存在于 members。

type ToolGroupFamily = "explore" | "command";

function toolGroupFamily(
  tc: ToolCallState,
  policy: ViewPolicy = toolViewPolicy(tc),
): ToolGroupFamily | undefined {
  const status = normalizeToolStatus(tc.status);
  if (status === "failed" || status === "declined") return undefined;
  if (policy.grade !== "background" || policy.detail !== "summary") return undefined;
  if (policy.family === "explore") return "explore";
  return policy.family === "command" && status === "completed" ? "command" : undefined;
}

/**
 * 可分组工具的分组键：同一 read effect（跨 read/search/fetch/execute）或命令族，
 * 再加同 turn + 同 harness target 才能并组。
 * undefined = 该调用不参与分组。failed/declined 不进组——错误详情必须单独成块显眼展示。
 */
export function toolGroupKey(
  tc: ToolCallState,
  policy: ViewPolicy = toolViewPolicy(tc),
): string | undefined {
  if (!tc.kind) return undefined;
  const family = toolGroupFamily(tc, policy);
  if (!family) return undefined;
  return JSON.stringify([
    family,
    tc.turnId ?? "",
    tc.harnessTargetId ?? "",
    tc.laneId ?? "",
    tc.harness ?? "",
  ]);
}

function thoughtGroupKey(msg: MessageState): string {
  return JSON.stringify([
    "thought",
    msg.turnId ?? "",
    msg.harnessTargetId ?? "",
    msg.laneId ?? "",
    msg.harness ?? "",
  ]);
}

function transcriptGroup(
  members: TranscriptBlockItem[],
  title: string,
): TranscriptGroupItem {
  const first = members[0]!;
  const running = members.some((member) =>
    member.status === "pending" || member.status === "in_progress"
  );
  return {
    type: "group",
    id: `group:${first.id}`,
    collapsedByDefault: true,
    summary: {
      type: "block",
      id: `group:${first.id}:summary`,
      kind: first.kind,
      author: first.author,
      title,
      status: running ? "in_progress" : "completed",
    },
    members,
  };
}

/** 独立事实也先进入稳定的透明 group；渲染上不增加标题或行数。 */
function standaloneTranscriptGroup(block: TranscriptBlockItem): TranscriptGroupItem {
  return {
    type: "group",
    id: `group:${block.id}`,
    members: [block],
  };
}

/**
 * Successful tool facts keep their high-signal title visible while the full
 * command, output, and diff stay one Ctrl+O away. Failures use the transparent
 * group above so their diagnostics remain visible without another action.
 */
function summarizedBlockGroup(block: TranscriptBlockItem): TranscriptGroupItem {
  return transcriptGroup([block], block.title);
}

/**
 * 每个可分组调用从第一条起就由稳定 TranscriptGroupItem 承载；N≥2 时只追加 member block
 * 并更新 group 摘要，不改变顶层节点类型。完整成员保留在 members，默认只占摘要一行，
 * Ctrl+O 后仍能查看每次调用的命令、输出与状态。
 */
export function toolGroupTranscriptItem(
  tcs: readonly ToolCallState[],
): TranscriptGroupItem {
  const first = tcs[0]!;
  const last = tcs[tcs.length - 1]!;
  const label = TOOL_KIND_LABELS[first.kind ?? ""] ?? first.kind;
  const detail = toolKeyArg(last, last.title ?? last.toolCallId);
  const family = toolGroupFamily(first);
  const title = family === "command" && tcs.length > 1
    ? `Ran ${countLabel(tcs.length, "command")}`
    : family === "explore" && tcs.length > 1
      ? `Explored ${countLabel(tcs.length, "action")}${detail ? ` · ${detail}` : ""}`
    : `${label} ×${tcs.length}${detail ? ` · ${detail}` : ""}`;
  return transcriptGroup(
    tcs.map(toolTranscriptItem),
    title,
  );
}

type CompactBlockFamily = ToolGroupFamily | "thought";

interface CompactBlockCandidate {
  mergeKey: string;
  family: CompactBlockFamily;
  detail?: string;
  block: TranscriptBlockItem;
}

function compactBlockGroup(candidates: CompactBlockCandidate[]): TranscriptGroupItem {
  const first = candidates[0]!;
  const last = candidates[candidates.length - 1]!;
  const title = candidates.length === 1
    ? first.block.title
    : first.family === "thought"
      ? `Thought ×${candidates.length} · ${compactText(last.block.title, 48)}`
      : first.family === "command"
        ? `Ran ${countLabel(candidates.length, "command")}`
        : `Explored ${countLabel(candidates.length, "action")}${last.detail ? ` · ${last.detail}` : ""}`;
  return transcriptGroup(candidates.map((candidate) => candidate.block), title);
}

const REVIEW_DISPLAY: Record<
  ApprovalReviewUpdate["decision"],
  { status: TranscriptBlockStatus; tone?: BlockTone }
> = {
  approved: { status: "completed", tone: "warning" },
  denied: { status: "declined" },
  aborted: { status: "failed" },
};

function approvalReviewTranscriptItem(review: ApprovalReviewUpdate): TranscriptBlockItem {
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
 *
 * @rule 展示压缩只能发生在 SessionState → Transcript 的 View 投影中。不得为了 UI 少显示
 * 几行而改写、合并或丢弃 Ledger/Session 事实；完整原始记录必须保留给 resume、审计和重投影。
 * @see {@link component://docs/view.md}
 */
export function buildTranscript(
  state: SessionState,
  pinnedPlanId?: string,
  options: {
    isSideLane?: (laneId: string) => boolean;
  } = {},
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const appendStandaloneBlock = (block: TranscriptBlockItem) => {
    items.push(standaloneTranscriptGroup(block));
  };
  let pendingThoughts: CompactBlockCandidate[] = [];
  let activeToolGroup: {
    mergeKey: string;
    index: number;
    candidates: CompactBlockCandidate[];
  } | undefined;
  const flushThoughts = () => {
    if (pendingThoughts.length > 0) items.push(compactBlockGroup(pendingThoughts));
    pendingThoughts = [];
  };
  const closeToolGroup = () => {
    activeToolGroup = undefined;
  };
  const applyPolicyBoundary = (policy: ViewPolicy, compatibleKey?: string) => {
    if (policy.breaksGroup && activeToolGroup?.mergeKey !== compatibleKey) closeToolGroup();
  };
  const appendPolicyBlock = (block: TranscriptBlockItem, policy: ViewPolicy) => {
    if (policy.detail === "summary") {
      items.push(summarizedBlockGroup(block));
      return;
    }
    appendStandaloneBlock(block);
  };
  const appendThought = (candidate: CompactBlockCandidate) => {
    if (
      pendingThoughts.length > 0 &&
      pendingThoughts[0]!.mergeKey !== candidate.mergeKey
    ) {
      flushThoughts();
    }
    pendingThoughts.push(candidate);
  };
  const appendTool = (candidate: CompactBlockCandidate) => {
    flushThoughts();
    if (activeToolGroup?.mergeKey === candidate.mergeKey) {
      activeToolGroup.candidates.push(candidate);
      items[activeToolGroup.index] = compactBlockGroup(activeToolGroup.candidates);
      return;
    }
    activeToolGroup = {
      mergeKey: candidate.mergeKey,
      index: items.length,
      candidates: [candidate],
    };
    items.push(compactBlockGroup(activeToolGroup.candidates));
  };
  const hidden = (laneId: string | undefined) =>
    laneId !== undefined && options.isSideLane?.(laneId) === true;
  const noticesById = new Map(state.notices.map((notice) => [`n_${notice.seq}`, notice]));
  for (const entry of state.timeline) {
    if (entry.type === "tool_call") {
      const tc = state.toolCalls.get(entry.id);
      if (!tc || hidden(tc.laneId)) continue;
      const policy = toolViewPolicy(tc);
      const groupKey = toolGroupKey(tc, policy);
      applyPolicyBoundary(policy, groupKey);
      if (groupKey !== undefined) {
        appendTool({
          mergeKey: groupKey,
          family: toolGroupFamily(tc, policy)!,
          detail: toolKeyArg(tc, tc.title ?? tc.toolCallId),
          block: toolTranscriptItem(tc),
        });
        continue;
      }
      flushThoughts();
      const block = toolTranscriptItem(tc);
      appendPolicyBlock(block, policy);
      continue;
    }
    if (entry.type === "notice") {
      flushThoughts();
      const notice = noticesById.get(entry.id);
      if (!notice) continue;
      if (hidden(notice.laneId)) continue;
      const policy = contentViewPolicy("notice", { failed: notice.level !== "info" });
      applyPolicyBoundary(policy);
      appendPolicyBlock({
        type: "block",
        id: entry.id,
        kind: "notice",
        status: notice.level === "info" ? "pending" : "failed",
        title: notice.detail ? `${notice.title} · ${notice.detail}` : notice.title,
      }, policy);
      continue;
    }
    if (entry.type === "error") {
      flushThoughts();
      const policy = contentViewPolicy("error");
      applyPolicyBoundary(policy);
      const error = state.errors.get(entry.id);
      if (!error) continue;
      if (hidden(error.laneId)) continue;
      appendPolicyBlock({
        type: "block",
        id: entry.id,
        kind: "error",
        status: "failed",
        title: error.code ? `Error: ${error.code}` : "Error",
        content: { type: "text", text: error.message },
      }, policy);
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
        const policy = contentViewPolicy("thought");
        applyPolicyBoundary(policy);
        const turnCompleted = state.turnSummaries.some(
          (summary) => summary.turnId === msg.turnId,
        );
        const status =
          msg.streamStatus === "completed" ||
          turnCompleted ||
          !isTurnRunning(state, msg.turnId)
            ? "completed"
            : "in_progress";
        // Streaming reasoning is represented by the transient Activity/Working row. Commit only
        // the finalized summary to transcript so partial planning titles do not interrupt history.
        if (status === "in_progress") continue;
        for (const [index, block] of thoughtDisplayBlocks(textOf(msg.content)).entries()) {
          const candidate: CompactBlockCandidate = {
            mergeKey: thoughtGroupKey(msg),
            family: "thought",
            block: {
              type: "block",
              id: `${entry.id}:${index}`,
              kind: "thought",
              status,
              author: harnessAuthor(msg.harness),
              title: block.title,
              content: block.content ? { type: "text", text: block.content } : undefined,
            },
          };
          if (policy.grade === "background" && policy.detail === "summary") {
            appendThought(candidate);
          } else {
            flushThoughts();
            appendPolicyBlock(candidate.block, policy);
          }
        }
        continue;
      }
      flushThoughts();
      applyPolicyBoundary(contentViewPolicy("message"));
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
      flushThoughts();
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
      const policy = contentViewPolicy("task", {
        failed: status === "failed" || status === "declined",
      });
      applyPolicyBoundary(policy);
      const details = [
        request.pluginInstanceId ? `Requested by ${request.pluginInstanceId}` : undefined,
        request.harnessTargetId ? `Target: ${request.harnessTargetId}` : undefined,
        request.laneId ? `Lane: ${request.laneId}` : undefined,
        request.result?.agentText,
        request.failure?.detail,
        request.phase === "uncertain" ? "Delivery outcome is uncertain" : undefined,
      ].filter((value): value is string => Boolean(value));
      appendPolicyBlock({
        type: "block",
        id: `harness-invocation:${request.invocationId}`,
        kind: "task",
        status,
        author: request.pluginInstanceId,
        title: `${request.title} · ${request.phase}`,
        ...(details.length > 0
          ? { content: { type: "lines", lines: details } }
          : {}),
      }, policy);
      continue;
    }
    if (entry.type === "approval_review") {
      flushThoughts();
      const policy = contentViewPolicy("interaction");
      applyPolicyBoundary(policy);
      const review = state.approvalReviews.get(entry.id);
      if (review) {
        appendPolicyBlock(approvalReviewTranscriptItem(review), policy);
      }
      continue;
    }
    if (entry.type === "proposed_plan") {
      flushThoughts();
      const policy = contentViewPolicy("plan");
      applyPolicyBoundary(policy);
      const proposal = state.proposedPlans.get(entry.id);
      if (!proposal) continue;
      if (hidden(proposal.laneId)) continue;
      appendPolicyBlock({
        type: "block",
        id: entry.id,
        kind: "proposed_plan",
        status: "completed",
        author: harnessAuthor(proposal.harness),
        title: proposal.implementationTurnId
          ? "Proposed plan · implementation started"
          : "Proposed plan",
        content: { type: "text", text: proposal.content },
      }, policy);
      continue;
    }
    if (entry.type === "task") {
      flushThoughts();
      const task = state.tasks.get(entry.id);
      if (!task) continue;
      if (hidden(task.laneId)) continue;
      if (task.status === "in_progress") continue;
      const status = task.status === "stopped" ? "failed" : task.status;
      const policy = contentViewPolicy("task", { failed: status === "failed" });
      applyPolicyBoundary(policy);
      const details = [
        task.summary,
        task.lastToolName ? `Last tool: ${task.lastToolName}` : undefined,
      ].filter((value): value is string => Boolean(value));
      appendPolicyBlock({
        type: "block",
        id: entry.id,
        kind: "task",
        status,
        author: harnessAuthor(task.harness),
        title: task.title ?? task.taskType ?? "Background task",
        ...(details.length
          ? { content: { type: "lines", lines: details } }
          : {}),
      }, policy);
      continue;
    }
    flushThoughts();
    const policy = contentViewPolicy("plan");
    applyPolicyBoundary(policy);
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
    appendPolicyBlock({
      type: "block",
      id: entry.id,
      kind: "plan",
      title: "Plan",
      status,
      content: { type: "plan", entries },
    }, policy);
  }
  flushThoughts();
  return items;
}
