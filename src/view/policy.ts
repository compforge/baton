import type { DiffBlock } from "../event/index.ts";
import { kindEffect } from "../harness/tool-effect.ts";
import type { ToolCallState } from "../store/reduce.ts";

export type ViewFamily = "change" | "explore" | "command" | "interaction" | "other";
export type ViewGrade = "background" | "normal" | "important";
export type ViewDetail = "summary" | "preview" | "full";

/**
 * Baton View 对一条事实的呈现决策。它不进入 Event / Session：事实保持完整，
 * View 可以随规则演进重新计算分组、默认详略和边界。
 */
export interface ViewPolicy {
  readonly family: ViewFamily;
  readonly grade: ViewGrade;
  readonly detail: ViewDetail;
  readonly breaksGroup: boolean;
}

export type ViewContentKind =
  | "message"
  | "thought"
  | "notice"
  | "error"
  | "interaction"
  | "task"
  | "plan";

const CONTENT_POLICIES: Record<ViewContentKind, ViewPolicy> = {
  message: { family: "other", grade: "important", detail: "full", breaksGroup: true },
  thought: { family: "other", grade: "background", detail: "summary", breaksGroup: false },
  notice: { family: "other", grade: "normal", detail: "preview", breaksGroup: false },
  error: { family: "other", grade: "important", detail: "preview", breaksGroup: true },
  interaction: { family: "interaction", grade: "important", detail: "preview", breaksGroup: true },
  task: { family: "other", grade: "normal", detail: "preview", breaksGroup: true },
  plan: { family: "other", grade: "normal", detail: "full", breaksGroup: true },
};

export function contentViewPolicy(
  kind: ViewContentKind,
  options: { failed?: boolean } = {},
): ViewPolicy {
  const policy = CONTENT_POLICIES[kind];
  return options.failed
    ? { ...policy, grade: "important", detail: "preview", breaksGroup: true }
    : policy;
}

function hasMaterialChange(tc: ToolCallState): boolean {
  if (tc.kind === "edit" || tc.kind === "delete" || tc.kind === "move") return true;
  return tc.content.some((block) =>
    block.type === "diff" && (block as DiffBlock).changes.length > 0
  );
}

/**
 * Tool effect 只是证据之一：read 可以把跨 kind 调用归入探索；execute 无论 effect
 * 是否缺失都稳定降级为 command。只有结构化文件变更才提升为 change，避免旧 Ledger
 * 中保守写入的 write effect 把历史探查命令误升为 important。
 */
export function toolViewPolicy(tc: ToolCallState): ViewPolicy {
  const failed = tc.status === "failed" || tc.status === "declined";
  const materialChange = hasMaterialChange(tc);
  const effect = tc.effect ?? kindEffect(tc.kind);
  const family: ViewFamily = materialChange
    ? "change"
    : effect === "read"
      ? "explore"
      : tc.kind === "execute"
        ? "command"
        : "other";

  if (failed) {
    return { family, grade: "important", detail: "preview", breaksGroup: true };
  }
  if (family === "change") {
    return { family, grade: "important", detail: "summary", breaksGroup: true };
  }
  if (family === "explore") {
    return { family, grade: "background", detail: "summary", breaksGroup: false };
  }
  if (family === "command") {
    return {
      family,
      grade: "background",
      detail: "summary",
      breaksGroup: true,
    };
  }
  if (effect === "write") {
    return { family, grade: "important", detail: "summary", breaksGroup: true };
  }
  return { family, grade: "normal", detail: "summary", breaksGroup: true };
}
