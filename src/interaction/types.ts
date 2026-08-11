/**
 * Baton 持有的、需要外部参与者给出结果后才能继续的持久协作对象。
 *
 * Harness 与 Plugin 都通过 typed request 打开 Interaction，人通过同一 Core 生命周期作答。
 * 它不是承载任意 payload 的消息信封；permission、question、hook trust 是封闭 kind。
 * Event source 表示谁报告生命周期事实，requester 表示谁在等待结果，两者不能混用。
 */

import type {
  ReconcileOperationRef,
  ResourceRef,
} from "@compforge/baton-plugin";

export type InteractionRequester =
  | { type: "harness"; harnessTargetId: string; laneId?: string }
  | { type: "plugin"; pluginInstanceId: string }
  | { type: "baton" };

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

/** Producer 提交的 kind-specific 内容；Controller 在可信边界补 identity 与 requester。 */
export type InteractionDraft = PermissionInteraction | QuestionInteraction | HookTrustInteraction;

/**
 * Durable routing owned by Baton for an Interaction emitted from Resource reconcile.
 * The structured operation is part of identity; the basis is provenance, not callback state.
 */
export interface ReconcileInteractionContext {
  operation: ReconcileOperationRef<"ask" | "confirm">;
  resource: ResourceRef;
  resourceOwner: "plugin" | "baton";
  basedOnGeneration?: number;
  basedOnResourceVersion?: string;
  basedOnRevision?: number;
}

export type Interaction = InteractionDraft & {
  interactionId: string;
  requester: InteractionRequester;
  /** Plugin requester 恢复 Resource reconcile 所需的持久路由事实。 */
  pluginContext?: ReconcileInteractionContext;
  /** Durable absolute deadline for host-owned timeout cancellation. */
  expiresAt?: string;
};

/** 外部参与者针对 Interaction 提交的 kind-specific 答案。 */
export type InteractionAnswer =
  | { kind: "permission"; outcome: "selected"; optionId: string }
  | {
      kind: "question";
      outcome: "answered";
      /** Selected QuestionChoice.value entries or requester-owned free text. */
      answers: Record<string, string[]>;
    }
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
  | { kind: "cancelled"; reason: InteractionCancellationReason };

export interface InteractionAnswered {
  interactionId: string;
  answer: InteractionAnswer;
}

export interface InteractionCancelled {
  interactionId: string;
  reason: InteractionCancellationReason;
}
