import { closedTerminal } from "../normalize.ts";
import type {
  AnyEventDraft,
  ContentBlock,
  DiffBlock,
  ToolCallStatus,
  ToolEffect,
} from "../../event/index.ts";
import { codexCommandActionsAreReadOnly } from "./command-effect.ts";
import type { PermissionOption } from "../../interaction/types.ts";

export const FALLBACK_APPROVAL_OPTIONS: PermissionOption[] = [
  { optionId: "accept", name: "Allow once", polarity: "allow", lifetime: "once" },
  {
    optionId: "acceptForSession",
    name: "Allow for this session",
    polarity: "allow",
    lifetime: "session",
  },
  { optionId: "decline", name: "Deny (agent continues)", polarity: "reject", lifetime: "once" },
  { optionId: "cancel", name: "Deny and interrupt turn", polarity: "reject", lifetime: "once" },
];

export interface CodexApprovalChoice {
  option: PermissionOption;
  /** Codex wire decision；结构化方言只停留在 adapter 边界。 */
  decision: unknown;
}

export function simpleApprovalChoice(decision: string): CodexApprovalChoice | undefined {
  const option = FALLBACK_APPROVAL_OPTIONS.find((candidate) => candidate.optionId === decision);
  return option ? { option, decision } : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * amendment 类候选一律"读不出就不给"（返回 undefined，由 codexApprovalChoices 丢弃）。
 *
 * 它们都是**永久**授权，标签必须说清作用对象；读不出还硬给，等于让用户为一个自己看不见
 * 的规则永久放行。更要命的是极性：`action` 读不出时若默认成 allow，一条 deny 规则就会
 * 被渲染成放行——正是本次要消灭的"最危险的选项长得最安全"。宁可少一个精确选项，
 * 也不猜（不变量 #2）；全被丢弃时还有稳定四选项兜底。
 */
export function structuredApprovalChoice(decision: unknown, index: number): CodexApprovalChoice | undefined {
  const record = asRecord(decision);
  if (!record) return undefined;
  if (record.acceptWithExecpolicyAmendment !== undefined) {
    // ExecPolicyAmendment 是 serde(transparent) 的裸字符串数组：命令前缀的 token 序列
    const amendment = asRecord(record.acceptWithExecpolicyAmendment)?.execpolicy_amendment;
    if (!Array.isArray(amendment) || amendment.length === 0) return undefined;
    return {
      option: {
        optionId: `acceptWithExecpolicyAmendment:${index}`,
        // 作用对象（命令前缀）只能进 name：它是 codex 方言，两轴表达不了。
        name: `Allow and remember: ${amendment.map(String).join(" ")}`,
        // execpolicy amendment 恒为 allow 前缀规则（codex: prefix_rule(..., decision="allow")）
        polarity: "allow",
        lifetime: "persistent",
      },
      decision,
    };
  }
  if (record.applyNetworkPolicyAmendment !== undefined) {
    const amendment = asRecord(asRecord(record.applyNetworkPolicyAmendment)?.network_policy_amendment);
    const { host, action } = amendment ?? {};
    // action 可以是 deny——codex 会提议"永久拉黑某 host"，与 allow 同为 amendment 但极性相反。
    if (typeof host !== "string" || (action !== "allow" && action !== "deny")) return undefined;
    const deny = action === "deny";
    return {
      option: {
        optionId: `applyNetworkPolicyAmendment:${index}`,
        name: `${deny ? "Deny" : "Allow"} and remember: ${host}`,
        polarity: deny ? "reject" : "allow",
        lifetime: "persistent",
      },
      decision,
    };
  }
  return undefined;
}

export interface CodexApprovalChoices {
  choices: CodexApprovalChoice[];
  /** 认不出的 decision 形状键：codex 迭代快，新增 decision 是常态，必须说出来而不是默默丢。 */
  unmapped: string[];
  /** 一项都没映射上、退回了稳定四选项（而非 codex 的真实候选集）。 */
  fellBack: boolean;
}

/** 认不出的 decision 的形状键：字符串取其本身，对象取变体名——足够让人知道 codex 新增了什么。 */
export function decisionShapeKey(decision: unknown): string {
  if (typeof decision === "string") return decision;
  const variant = asRecord(decision) ? Object.keys(asRecord(decision) ?? {})[0] : undefined;
  return variant ?? `<${typeof decision}>`;
}

/**
 * Codex 给出精确候选时逐项映射；缺字段（老版本）或**一项都认不出**时退回稳定四选项。
 *
 * 后半条是要害：availableDecisions 非空但全部不认识（codex 改了 decision 名、加了第三种
 * amendment），逐项映射会得到空数组 → 审批卡零选项 → 用户无从作答，turn 永久挂起。
 * 认不出就退回一定能作答的集合，宁可少一个精确选项也不能失去应答能力（不变量 #2）。
 *
 * 但"少给"本身必须留痕（见 unmapped）——悲观降级不等于可以失声。
 */
export function codexApprovalChoices(params: Record<string, unknown>): CodexApprovalChoices {
  const available = params.availableDecisions;
  const fallback = () => FALLBACK_APPROVAL_OPTIONS.map((option) => ({ option, decision: option.optionId }));
  // 字段缺失 = 老版本 codex 没这个能力，不是"认不出"，无须提示
  if (!Array.isArray(available) || available.length === 0) {
    return { choices: fallback(), unmapped: [], fellBack: false };
  }
  const choices: CodexApprovalChoice[] = [];
  const unmapped: string[] = [];
  available.forEach((decision, index) => {
    const choice =
      typeof decision === "string"
        ? simpleApprovalChoice(decision)
        : structuredApprovalChoice(decision, index);
    if (choice) choices.push(choice);
    else unmapped.push(decisionShapeKey(decision));
  });
  return choices.length > 0
    ? { choices, unmapped, fellBack: false }
    : { choices: fallback(), unmapped, fellBack: true };
}

/** item.type → 内部 tool kind；agentMessage/reasoning/plan 不是 tool，单独处理 */
export function toolKindOf(itemType: string): string {
  switch (itemType) {
    case "commandExecution":
      return "execute";
    case "fileChange":
      return "edit";
    case "webSearch":
      return "search";
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    default:
      return "other";
  }
}

/**
 * item → effect 声明。Codex 已把 shell 命令解析为 commandActions；只有每个
 * action 都能证明为读取时，commandExecution 才上报 read。原生 unknown 仅由
 * Codex 专属的窄命令 recognizer 兜底，其它不能证明为读取的命令仍上报 write。
 */
export function toolEffectOf(item: Record<string, unknown>): ToolEffect | undefined {
  switch (item.type) {
    case "commandExecution":
      return codexCommandActionsAreReadOnly(item.commandActions) ? "read" : "write";
    case "fileChange":
      return "write";
    case "webSearch":
      return "read";
    default:
      return undefined;
  }
}

export function toolTitleOf(item: Record<string, unknown>): string {
  switch (item.type) {
    case "commandExecution":
      return String(item.command ?? "command");
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((c) => String((c as Record<string, unknown>).path ?? "")).filter(Boolean);
      return paths.length ? `edit ${paths.join(", ")}` : "file change";
    }
    case "webSearch":
      return `search: ${String(item.query ?? "")}`;
    case "mcpToolCall":
      return `${String(item.server ?? "mcp")}.${String(item.tool ?? "tool")}`;
    case "dynamicToolCall":
      return String(item.tool ?? "tool");
    default:
      return String(item.type ?? "item");
  }
}

export function fileChangeKind(change: Record<string, unknown>): string {
  if (typeof change.kind === "string") return change.kind;
  const kind = change.kind as Record<string, unknown> | undefined;
  return typeof kind?.type === "string" ? kind.type : "update";
}

export function unifiedFilePatch(change: Record<string, unknown>): string {
  const path = String(change.path ?? "");
  const source = String(change.diff ?? "").replace(/\n$/, "");
  if (!source) return "";
  if (source.startsWith("--- ")) return source;

  const kind = fileChangeKind(change);
  if (kind === "add" || kind === "delete") {
    const lines = source.split("\n");
    const oldPath = kind === "add" ? "/dev/null" : path;
    const newPath = kind === "delete" ? "/dev/null" : path;
    const range = kind === "add" ? `-0,0 +1,${lines.length}` : `-1,${lines.length} +0,0`;
    const marker = kind === "add" ? "+" : "-";
    return `--- ${oldPath}\n+++ ${newPath}\n@@ ${range} @@\n${lines.map((line) => `${marker}${line}`).join("\n")}`;
  }

  return `--- ${path}\n+++ ${path}\n${source}`;
}

/** Codex fileChange → 每个文件一个 OpenTUI 可解析的 unified diff。 */
export function fileChangeDiffs(item: Record<string, unknown>): DiffBlock[] {
  const changes = (Array.isArray(item.changes) ? item.changes : []) as Array<Record<string, unknown>>;
  return changes.map((change) => ({
    type: "diff",
    changes: [
      {
        operation: fileChangeKind(change) === "update" ? "modify" : fileChangeKind(change),
        path: String(change.path ?? ""),
      },
    ],
    patch: unifiedFilePatch(change) || undefined,
  }));
}

/** completed item 是工具输出的自愈点：即使 outputDelta 缺失，也能回填完整命令结果。 */
export function completedToolContent(itemType: string, item: Record<string, unknown>): ContentBlock[] | undefined {
  if (itemType === "fileChange") return fileChangeDiffs(item);
  if (itemType === "commandExecution" && typeof item.aggregatedOutput === "string") {
    return item.aggregatedOutput ? [{ type: "text", text: item.aggregatedOutput }] : [];
  }
  return undefined;
}

/**
 * codex item 终态 → 内部 ToolCallStatus，白名单式（走 closedTerminal 统一纪律）：只有名单上
 * 的值有明确待遇，未知终态一律悲观归 failed；status 缺失按 completed（item/completed 方法名
 * 本身即完成语义，缺字段不是词汇漂移）。
 */
export const CODEX_TERMINAL_STATUS: Record<string, ToolCallStatus> = {
  completed: "completed",
  failed: "failed",
  declined: "declined",
};

export function codexToolTerminalStatus(rawStatus: unknown): ToolCallStatus {
  return closedTerminal(rawStatus, CODEX_TERMINAL_STATUS, "failed", "completed");
}

/**
 * Codex ThreadItem 的持久语义归一。live notification 与只读 full Turn 导入共同走这里，
 * 避免中途接管时得到一套“只有首尾文本”的缩水 BatonSession。
 */
export function codexItemLifecycleDrafts(
  lifecycle: "started" | "completed",
  item: Record<string, unknown>,
): AnyEventDraft[] {
  const itemType = String(item.type ?? "");
  if (!itemType || itemType === "userMessage") return [];

  if (itemType === "agentMessage") {
    return lifecycle === "completed"
      ? [{
          kind: "agent_message",
          payload: {
            messageId: String(item.id),
            content: [{ type: "text", text: String(item.text ?? "") }],
          },
        }]
      : [];
  }

  if (itemType === "reasoning") {
    if (lifecycle !== "completed") return [];
    const summary = Array.isArray(item.summary) ? item.summary : [];
    return summary.flatMap((value, index) => {
      const text = String(value).trim();
      return text
        ? [{
            kind: "agent_thought" as const,
            payload: {
              messageId: `${String(item.id)}:summary:${index}`,
              content: [{ type: "text" as const, text }],
            },
          }]
        : [];
    });
  }

  if (itemType === "plan") {
    const content = String(item.text ?? "").trim();
    return lifecycle === "completed" && content
      ? [{
          kind: "proposed_plan",
          payload: { planId: String(item.id), content },
        }]
      : [];
  }

  if (itemType === "contextCompaction") {
    return [{
      kind: "_baton_run_status",
      payload:
        lifecycle === "started"
          ? { phase: "compacting", title: "Compacting context…" }
          : { phase: null },
    }];
  }

  if (itemType === "collabAgentToolCall") {
    const terminal = codexToolTerminalStatus(item.status);
    const title = item.prompt ?? item.description;
    const taskType = item.agentType ?? item.subagentType;
    return [{
      kind: "task_update",
      payload: {
        taskId: String(item.id),
        status:
          lifecycle === "started"
            ? "in_progress"
            : terminal === "completed"
              ? "completed"
              : "failed",
        ...(title !== undefined
          ? { title: String(title) }
          : lifecycle === "started"
            ? { title: toolTitleOf(item) }
            : {}),
        ...(taskType !== undefined ? { taskType: String(taskType) } : {}),
        ...(lifecycle === "completed" && (item.result ?? item.output) !== undefined
          ? { summary: String(item.result ?? item.output) }
          : {}),
      },
    }];
  }

  return [{
    kind: "tool_call_update",
    payload: {
      toolCallId: String(item.id),
      title: toolTitleOf(item),
      kind: toolKindOf(itemType),
      effect: toolEffectOf(item),
      status: lifecycle === "started" ? "in_progress" : codexToolTerminalStatus(item.status),
      content:
        lifecycle === "completed"
          ? completedToolContent(itemType, item)
          : itemType === "fileChange"
            ? fileChangeDiffs(item)
            : undefined,
      rawInput: lifecycle === "started" ? item : undefined,
      rawOutput: lifecycle === "completed" ? item : undefined,
    },
  }];
}

/**
 * codex auto-review 终态 → 内部 ApprovalReviewUpdate.decision（闭合三态）。在 adapter 边界收口：
 * 未知 / 空（含 UNSTABLE 的 inProgress 混入 completed）一律保守归 aborted（投影呈 failed），
 * 绝不乐观当 approved。闭合值进事件流后，reduce / 投影不再面对开放 decision。
 */
