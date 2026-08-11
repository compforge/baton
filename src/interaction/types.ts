/**
 * Baton 持有的、需要外部参与者给出结果后才能继续的持久交互。
 *
 * Interaction 是跨 Harness / Plugin 的稳定对象；permission、question、hook trust 只是
 * kind。Event source 表示谁报告了生命周期事实，requester 表示谁在等待结果，两者不能混用。
 */

import type { ResourceRef } from "@compforge/baton-plugin";

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

export interface QuestionOption {
  /** Plugin questions use a stable value; Harness-originated questions may omit it. */
  optionId?: string;
  label: string;
  description: string;
  preview?: string;
  /** Presentation hint only; resolution semantics belong to the requester. */
  role?: "default" | "reject";
}

export interface QuestionPrompt {
  questionId: string;
  header: string;
  question: string;
  options?: QuestionOption[];
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
 * decisionKey is Plugin-defined identity; the basis is provenance, not callback state.
 */
export interface PluginResourceInteractionContext {
  decisionKey: string;
  resource: ResourceRef;
  resourceOwner: "plugin" | "baton";
  basedOnGeneration?: number;
  basedOnResourceVersion?: string;
  basedOnRevision?: number;
}

export type Interaction = InteractionDraft & {
  interactionId: string;
  requester: InteractionRequester;
  pluginContext?: PluginResourceInteractionContext;
};

/**
 * Interaction 的终结结果。resolved 只表示不再等待外部参与者，不代表随后触发的
 * Harness 操作或 Plugin Action 已经执行成功。cancelled 可由用户、turn、requester、
 * timeout 或恢复清理产生，因此每个 Interaction 接收方都必须显式收口它。
 */
export type InteractionResolution =
  | { kind: "permission"; outcome: "selected"; optionId: string }
  | { kind: "question"; outcome: "answered"; answers: Record<string, string[]> }
  | { kind: "hook_trust"; outcome: "trusted" | "skipped" }
  | {
      kind: "cancelled";
      reason: "user" | "requester" | "turn" | "timeout" | "recovery";
    };

export interface InteractionResolved {
  interactionId: string;
  resolution: InteractionResolution;
}
