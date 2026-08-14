// @ 引用的急切解析：Mention 统一产生当前 turn 的只读材料；
// 本文件保留 Session 摘要与旧 @bs_ token 的兼容展开。

import type { TurnSummary } from "../event/index.ts";
import type { HarnessTarget } from "../harness/target.ts";
import { MAIN_LANE_ID } from "../lane.ts";
import {
  sessionDisplayTitle,
  type SessionHandle,
  type SessionStore,
} from "../store/store.ts";
import type { Mention } from "@compforge/baton-plugin";

/** @bs_<ULID>：Mention 上线前的 Session token，继续兼容已有输入。 */
const MENTION_PATTERN = /@(bs_[0-9A-HJKMNP-TV-Z]{26})/g;

// 摘要 token 预算的初值拍 4KB 字符（design 开放问题 #4），超限丢最旧的 turn
export const DEFAULT_MENTION_BUDGET_CHARS = 4096;

export interface ParsedMention {
  batonSessionId: string;
}

interface TurnSummaryRecord {
  harness: string;
  harnessTargetId?: string;
  laneId?: string;
  seq: number;
  summary: TurnSummary;
}

export interface HarnessCatchUpContext {
  text: string;
  throughSeq: number;
}

export function parseMentions(text: string): ParsedMention[] {
  const seen = new Set<string>();
  const out: ParsedMention[] = [];
  for (const m of text.matchAll(MENTION_PATTERN)) {
    const id = m[1] as string;
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ batonSessionId: id });
    }
  }
  return out;
}

function turnBlock(
  s: TurnSummary,
  index: number,
  source?: Pick<TurnSummaryRecord, "harness">,
): string {
  const assistant = source ? `assistant[${source.harness}]` : "agent";
  const tools = source ? `tools[${source.harness}]` : "tools";
  const lines: string[] = source
    ? []
    : [`## Turn ${index + 1}${s.stopReason ? ` (${s.stopReason})` : ""}`];
  if (s.userText) lines.push(`user: ${s.userText}`);
  if (s.agentText) lines.push(`${assistant}: ${s.agentText}`);
  if (s.toolCalls.length) {
    lines.push(`${tools}: ${s.toolCalls.map((t) => `${t.title ?? t.toolCallId} [${t.status ?? "?"}]`).join("; ")}`);
  }
  if (source && s.stopReason && s.stopReason !== "end_turn") {
    lines.push(`status: ${s.stopReason}`);
  }
  return lines.join("\n");
}

/**
 * 目标会话的紧凑摘要。数据源是 turn-summary 事件（写入时已压缩，见 store.summarizeTurn）。
 * 预算内优先保最近的 turn：从最新往回装，装不下即停，再恢复时间序。
 */
export function buildSessionContext(
  store: SessionStore,
  batonSessionId: string,
  budgetChars: number = DEFAULT_MENTION_BUDGET_CHARS,
): string {
  const session = store.openSession(batonSessionId);
  const summaries = session.loadState().turnSummaries;
  const title = sessionDisplayTitle(session.meta);
  const harnesses = session.meta.harnessTargets
    ? Object.keys(session.meta.harnessTargets).join(", ")
    : "unknown";
  const header = `# Session summary: ${title} (id: ${batonSessionId}, agent: ${harnesses})`;

  if (summaries.length === 0) {
    return `${header}\n(no completed turns in this session yet)`;
  }

  const picked: string[] = [];
  let used = header.length;
  let dropped = 0;
  for (let i = summaries.length - 1; i >= 0; i--) {
    const block = turnBlock(summaries[i] as TurnSummary, i);
    if (used + block.length + 2 > budgetChars && picked.length > 0) {
      dropped = i + 1;
      break;
    }
    used += block.length + 2;
    picked.unshift(block);
    if (used > budgetChars) {
      // 单个 block 就超预算：硬截断保留尾部（最新内容在后）
      picked[0] = (picked[0] as string).slice(-(budgetChars - header.length));
      dropped = i;
      break;
    }
  }
  const parts = [header];
  if (dropped > 0) parts.push(`(${dropped} earlier turns omitted for length)`);
  parts.push(...picked);
  return parts.join("\n\n");
}

function turnSummaries(handle: SessionHandle): TurnSummaryRecord[] {
  return handle.ledger
    .read()
    .filter((e) => e.kind === "_baton_turn_summary")
    .map((e) => ({
      harness: e.harness ?? "baton",
      harnessTargetId: e.harnessTargetId,
      laneId: e.laneId,
      seq: e.seq,
      summary: e.payload as TurnSummary,
    }));
}

/**
 * 生成 Lane 尚未同步的 BatonSession 历史，并返回本批覆盖到的事件水位。
 * 新建原生会话时 includeTargetTurns=true，从零恢复完整逻辑历史；resume 时只补当前
 * Lane × HarnessTarget binding 未亲历的增量。
 *
 * 同步语义（与 controller 的注入时点水位配套，三条规则都有测试钉住）：
 * - **同一 binding 的产出不注入**：同 Lane 换到其它 Target 是接力，必须把上一棒注入；
 *   其它 Lane 的进展也必须注入；
 * - **throughSeq = 全量 summary 尾 seq（含自己的）**：亲历即已同步，水位越过它是正确的。
 *   注意 summary 事件本身不进注入文本，其 userText 已由 summarize 时的
 *   stripBatonInjectedContext 剥掉 <baton-sync> 标签——sync 块不经 summary 递归放大；
 * - **预算裁剪是有意的有损压缩**：从最新往回装，装不下的早期 turn 以
 *   "(N earlier turns omitted)" 一句代偿且不回补（throughSeq 照常推进）。
 */
export function buildTargetCatchUpContext(
  handle: SessionHandle,
  opts: {
    target: HarnessTarget;
    laneId?: string;
    sinceSeq: number;
    includeTargetTurns: boolean;
    budgetChars?: number;
  },
): HarnessCatchUpContext | null {
  const summaries = turnSummaries(handle);
  const missed = summaries.filter((item) => {
    if (item.seq <= opts.sinceSeq) return false;
    if (opts.includeTargetTurns) return true;
    if (item.laneId) {
      return !(
        item.laneId === opts.laneId &&
        item.harnessTargetId === opts.target.id
      );
    }
    // 0.2.21 and earlier had only one native session per Target and no Lane coordinate;
    // migration assigns that history to the BatonSession main Lane.
    return !(
      item.harnessTargetId === opts.target.id &&
      (opts.laneId === undefined || MAIN_LANE_ID === opts.laneId)
    );
  });
  if (missed.length === 0) return null;

  const header = opts.includeTargetTurns
    ? "# BatonSession history (auto-restored by baton)"
    : "# Latest progress from other agents in this session (auto-synced by baton)";
  const budgetChars = opts.budgetChars ?? DEFAULT_MENTION_BUDGET_CHARS;
  const picked: string[] = [];
  let used = header.length;
  let dropped = 0;
  for (let i = missed.length - 1; i >= 0; i--) {
    const m = missed[i] as (typeof missed)[number];
    const block = turnBlock(m.summary, i, m);
    if (used + block.length + 2 > budgetChars && picked.length > 0) {
      dropped = i + 1;
      break;
    }
    used += block.length + 2;
    picked.unshift(block);
  }
  const parts = [header];
  if (dropped > 0) parts.push(`(${dropped} earlier turns omitted for length)`);
  parts.push(...picked);
  return {
    text: parts.join("\n\n"),
    throughSeq: summaries.at(-1)?.seq ?? opts.sinceSeq,
  };
}

/**
 * 展开输入里的所有 @ 引用：返回最终发给 agent 的文本。
 * 注入内容以"用户提供的只读参考材料"身份出现，归属清晰，不伪造对方记忆。
 */
export function expandMentions(
  store: SessionStore,
  text: string,
  budgetChars: number = DEFAULT_MENTION_BUDGET_CHARS,
): { prompt: string; mentions: ParsedMention[] } {
  const mentions = parseMentions(text);
  if (mentions.length === 0) return { prompt: text, mentions };
  const perMentionBudget = Math.floor(budgetChars / mentions.length);
  const contexts = mentions.map((m) => buildSessionContext(store, m.batonSessionId, perMentionBudget));
  const prompt = [
    "<baton-context>",
    "Summaries of other agent sessions referenced by the user, provided as background context only:",
    ...contexts,
    "</baton-context>",
    "",
    text,
  ].join("\n\n");
  return { prompt, mentions };
}

/** Built-in explicit context; Plugin providers use the same registration path. */
export function sessionMention(
  store: SessionStore,
  options: {
    readonly excludeSessionId?: string;
  } = {},
): Mention {
  return {
    namespace: "session",
    async search(query) {
      const normalized = query.toLowerCase();
      return store
        .listSessions()
        .filter((session) =>
          session.batonSessionId !== options.excludeSessionId
        )
        .filter((session) =>
          session.batonSessionId.toLowerCase().startsWith(normalized) ||
          (
            normalized !== "" &&
            sessionDisplayTitle(session).toLowerCase().includes(normalized)
          )
        )
        .map((session) => ({
          id: session.batonSessionId,
          label: `@${session.batonSessionId.slice(0, 12)}…`,
          description: sessionDisplayTitle(session),
        }));
    },
    async resolve(id, { maxChars }) {
      if (id === options.excludeSessionId) return undefined;
      return buildSessionContext(store, id, maxChars);
    },
  };
}
