/**
 * InputRequest / InputResponse 的强类型请求、答案与执行边界。
 *
 * Interaction 是请求与答复 Message 的统称。Harness 与 Plugin 通过 typed request 打开请求，
 * 人或宿主 policy 通过同一 Core 生命周期作答；Event 直接携带 Message，View 契约独立。
 * Message 不是承载任意 payload 的信封；permission、question、suggested input、
 * HarnessInvocation gate、hook trust 是封闭 kind。
 * Event source 表示谁报告事实，Message source 表示作者，两者不能混用。
 */

import type { PromptBlock } from "../input/blocks.ts";

/**
 * 审批选项的两根正交轴都只用于忠实展示 Harness 给出的候选。
 * 授权覆盖的操作与资源属于 Permission Policy，不从这两个字段反推。
 */
export interface PermissionOption {
  optionId: string;
  /** Harness 原话标签；它是当前候选语义的权威来源。 */
  name: string;
  polarity: "allow" | "reject";
  /** 只表达持续时间，不表达授权覆盖的资源。 */
  lifetime: "once" | "session" | "persistent";
}

export interface PermissionInteraction {
  kind: "permission";
  title: string;
  description?: string;
  toolCallId?: string;
  options: PermissionOption[];
}

export interface QuestionChoice {
  /** Stable value returned to the requester when this choice is selected. */
  value: string;
  label: string;
  description?: string;
  preview?: string;
  /** Presentation hint only; answer semantics belong to the requester. */
  role?: "default" | "reject";
}

export interface QuestionPrompt {
  questionId: string;
  header: string;
  question: string;
  choices?: QuestionChoice[];
  multiSelect?: boolean;
  allowOther?: boolean;
  secret?: boolean;
}

export interface QuestionInteraction {
  kind: "question";
  /** Harness 原生 tool/request id；用于把回答与原请求关联，不参与 Interaction identity。 */
  toolCallId?: string;
  questions: QuestionPrompt[];
}

/** User-editable Input proposed by a Plugin before any HarnessInvocation exists. */
export interface SuggestedInputInteraction {
  kind: "suggested_input";
  title: string;
  text: string;
  harnessTargetId?: string;
}

/** Policy gate that must settle before a Plugin can create a HarnessInvocation. */
export interface HarnessInvocationInteraction {
  kind: "harness_invocation";
  title: string;
  prompt: string;
  laneId: string;
  newLane: boolean;
  harnessTargetId?: string;
}

export interface HookTrustCandidate {
  key: string;
  source: string;
  sourcePath: string;
  trustStatus: "untrusted" | "modified";
  command: string;
  matcher?: string;
  pluginId?: string;
  currentHash?: string;
  handlerType?: string;
  timeoutSec?: number;
  statusMessage?: string;
}

/**
 * Harness 启动前发现 hooks 尚未被信任：询问用户是否信任当前精确定义。
 * 这是启动信任，不是单次工具执行权限，故仍是独立 kind。
 */
export interface HookTrustInteraction {
  kind: "hook_trust";
  harnessName: string;
  hooks: HookTrustCandidate[];
}

/** Producer 提交的 kind-specific 内容；Core 在可信边界签发 Message 身份与 source/target。 */
export type InteractionDraft =
  | PermissionInteraction
  | QuestionInteraction
  | SuggestedInputInteraction
  | HarnessInvocationInteraction
  | HookTrustInteraction;

/** Durable correlation for an Interaction emitted by one live Plugin execution. */
export interface ReconcileInteractionContext {
  executionId: string;
  verb: "ask" | "confirm" | "draft" | "harness";
}

/** 外部参与者针对 Interaction 提交的 kind-specific 答案。 */
export type InteractionAnswer =
  | { kind: "permission"; outcome: "selected"; optionId: string }
  | {
      kind: "question";
      outcome: "answered";
      /** Selected QuestionChoice.value entries or requester-owned free text. */
      answers: Record<string, string[]>;
    }
  | {
      kind: "suggested_input";
      outcome: "submitted";
      blocks: PromptBlock[];
    }
  | { kind: "suggested_input"; outcome: "dismissed" }
  | { kind: "harness_invocation"; outcome: "approved" | "declined" }
  | { kind: "hook_trust"; outcome: "trusted" | "skipped" };

export type InteractionCancellationReason =
  | "user"
  | "requester"
  | "turn"
  | "timeout"
  | "recovery";

/**
 * Interaction 的终结结果。它只表示外部等待已经结束，不代表随后触发的 Harness 操作或
 * Plugin Action 已经成功。每个接收方都必须显式处理 cancellation。
 */
export type InteractionResult =
  | InteractionAnswer
  | {
      kind: "cancelled";
      reason: InteractionCancellationReason;
      detail?: string;
    };

export type { InputRequest, InputResponse, Interaction } from "../message/types.ts";
