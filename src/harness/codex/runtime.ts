import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { SessionConfigOption } from "../../event/index.ts";
import type { HookTrustStore } from "../../config/hook.ts";
import type { LogSink } from "../../logging.ts";
import type {
  ApprovalRoute,
  EffortOption,
  HarnessEventSink,
  ModelOption,
  NativeEventSink,
  OpenInteraction,
} from "../adapter.ts";
import type { JsonRpcPeer } from "./jsonrpc.ts";
import type { MessageReplies } from "../message-replies.ts";

export interface CodexAdapterOptions {
  openInteraction: OpenInteraction;
  log?: LogSink;
  nativeEvent?: NativeEventSink;
  /** HarnessTarget 固定环境；同名项覆盖每次 open 传入的动态环境。 */
  env?: Readonly<Record<string, string>>;
  /** 缺省由 auto-review 审批；显式 user 时请求进入 Baton TUI。 */
  approvalReviewer?: "user" | "auto_review";
  /** 覆盖二进制，测试用 */
  command?: string[];
  /** 用户审过的精确 hook 指纹；缺省落 ~/.baton/state/hook.json 的 trust 区。 */
  hookTrustStore?: HookTrustStore;
  /** Adapter close 等待 SIGTERM 的时间；仅测试需要覆盖。 */
  shutdownGraceMs?: number;
}

/**
 * 一次 turn/start 所属的 turn 状态（同 claude adapter 的 ClaudeTurn）：终态必须绑定
 * 所属 turn。fast-submit 下 turn/start 响应早回，但老版本 app-server 会阻塞到 turn
 * 结束才回——该响应/错误可能落在下一 turn 已 admission 之后，不能误杀新 turn。
 */
export interface CodexTurn {
  turnId: string;
  replies?: MessageReplies;
  /** 保证物理终态重复到达（响应与 turn/completed 通知都可能带终态）时只终结一次 */
  finalized: boolean;
  /**
   * 本 turn 是否产生过任何可见产出（消息/思考/工具/计划/审批…）。completed 且零产出
   * 是异常（prompt 在进模型前被丢弃，如 UserPromptSubmit hook 拦截），不能静默当正常
   * end_turn——事故形态是用户看到 baton 回 idle 但消息像被吞掉。
   */
  sawOutput?: boolean;
  /** UserPromptSubmit/SessionStart hook 拦截信息：空回合的已知原因（hook/completed 通知报告） */
  hookBlock?: { source: string; reason?: string };
}

export interface ThreadRuntime {
  child: ChildProcessWithoutNullStreams;
  peer: JsonRpcPeer;
  closing?: boolean;
  threadId: string;
  /** codex 回吐的生效审批路由（权威）；null = 本次没问出来，投影据此静默。 */
  approvalRoute: ApprovalRoute | null;
  /** app-server 回吐的当前 service tier；priority 即 Codex Fast mode。 */
  serviceTier: string | null;
  /** 最近一次发布的完整 session config 快照，供 settings 通知原地校准 Fast。 */
  configOptions?: SessionConfigOption[];
  sink: HarnessEventSink;
  /** 最近一次 submit 的 baton turn id：迟到通知（tokenUsage 等）也用它标注信封 */
  turnId?: string;
  /** 当前被接受、尚未逻辑终结的 turn */
  activeTurn?: CodexTurn;
  codexTurnId?: string;
  /** Native receipt ownership survives the active Turn changing. */
  turnsByNativeId?: Map<string, CodexTurn>;
  /** turn/steer 已接受、但尚未收到 Codex userMessage 消费回执的 Baton messageId。 */
  pendingSteerMessageIds?: Set<string>;
  /** userMessage 回执可能先于 turn/steer RPC；保留到 admission waiter 消费。 */
  appliedSteerMessageIds?: Set<string>;
  /** 只为仍在等待 turn/steer RPC 的消息保留 applied race receipt。 */
  inFlightSteerMessageIds?: Set<string>;
  /**
   * cancel 早于 codexTurnId 就位（fast-submit 后 turn/start 响应与 turn/started
   * 通知都未回）时挂起的取消意图；id 就位后由 flushPendingCancel 补发 interrupt。
   * 没有它，这个窗口内的 cancel 会被静默丢弃——controller 宽限期到点合成"已取消"
   * 并推进队列，而原生 codex turn 仍在继续跑。
   */
  pendingCancel?: boolean;
  /** Live unified-exec PTY processes reported by commandExecution items. */
  activeCommandProcesses?: Map<string, number>;
  /** 用户在 baton 中选择的模型；作为下一次 turn/start override。 */
  model?: string;
  /** 下一次 turn/start 使用的实际 effort；default 会先解析成当前模型的默认值。 */
  effort?: string;
  /** 仅显式选择返回值；default 对外仍显示为 null。 */
  effortSelection?: string;
  effortUsesDefault?: boolean;
  /** Baton 统一暴露的 Codex collaboration mode；undefined 表示沿用原生默认。 */
  mode?: "default" | "plan";
  /** mode preset 对 effort 的覆盖；Plan 当前由 app-server catalog 返回 medium。 */
  modeEffort?: string;
  /** collaborationMode 需要完整 settings，catalog 用来解析默认 model / effort。 */
  resolvedModel?: string;
  resolvedEffort?: string;
  /** 上次 tokenUsage.total 快照，差分成 usage_update 增量 */
  prevUsage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
  /**
   * 收到过 requestApproval 的 item：declined 终态的对账依据——某 item 被拒但从未
   * 问过 baton，说明有 harness 侧策略（如 auto-review）替用户做了决定，必须显式
   * 提示而不是静默渲染。启动参数注入（codexLaunchCommand）防已知配置，这里防未知。
   */
  approvalSeenItemIds?: Set<string>;
  /** 已提示过的"认不出的 decision"形状键：同一形状每 thread 只吵一次，不每次审批都刷屏。 */
  unmappedDecisionKeys?: Set<string>;
  /** 未映射 notification 计数：首见与每 100 次写诊断，避免未知高频 delta 刷爆日志。 */
  unmappedNotificationCounts?: Map<string, number>;
  /** 收到权威 auto-review 回执的 item：避免 declined 终态再触发旧的启发式旁路告警。 */
  autoReviewedItemIds?: Set<string>;
}

export interface CodexModelInfo {
  id: string;
  label: string;
  description?: string;
  isDefault: boolean;
  defaultEffort?: string;
  efforts: EffortOption[];
  /** undefined 表示旧 app-server 未提供 service tier catalog。 */
  supportsFast?: boolean;
}

export interface CodexModeInfo {
  id: "default" | "plan";
  label: string;
  effort?: string;
}

export const CODEX_FALLBACK_MODES: readonly CodexModeInfo[] = [
  { id: "default", label: "Default" },
  { id: "plan", label: "Plan" },
];

export const CODEX_FAST_SERVICE_TIER = "priority";
export const CODEX_STANDARD_SERVICE_TIER = "default";
export const CODEX_FAST_CONFIG = { "features.fast_mode": true } as const;

export function isFastServiceTier(serviceTier: string | null | undefined): boolean {
  return serviceTier === CODEX_FAST_SERVICE_TIER || serviceTier === "fast";
}

export function fastConfigOption(
  serviceTier: string | null | undefined,
  model?: CodexModelInfo,
): SessionConfigOption {
  return {
    id: "fast",
    type: "boolean",
    name: "Fast",
    category: "model",
    value: isFastServiceTier(serviceTier) && model?.supportsFast !== false,
    description: model?.supportsFast === false
      ? `${model.label} does not support Fast mode`
      : "Use Codex Fast mode for subsequent turns",
  };
}

export function effortLabel(effort: string): string {
  return effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function codexModelSupportsFast(model: Record<string, unknown>): boolean | undefined {
  const serviceTierRows = model.serviceTiers ?? model.service_tiers;
  const additionalSpeedTiers = model.additionalSpeedTiers ?? model.additional_speed_tiers;
  if (!Array.isArray(serviceTierRows) && !Array.isArray(additionalSpeedTiers)) return undefined;
  const hasFastServiceTier = Array.isArray(serviceTierRows) && serviceTierRows.some((row) => {
    const tier = typeof row === "string" ? row : (row as Record<string, unknown>).id;
    return tier === CODEX_FAST_SERVICE_TIER || tier === "fast";
  });
  return hasFastServiceTier ||
    (Array.isArray(additionalSpeedTiers) && additionalSpeedTiers.includes("fast"));
}

export function codexModelInfos(result: unknown): CodexModelInfo[] {
  const data = (result as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const models: CodexModelInfo[] = [];
  for (const raw of data) {
    const model = raw as Record<string, unknown>;
    const id = String(model.id ?? model.model ?? "").trim();
    if (!id) continue;
    const effortRows = model.supportedReasoningEfforts ?? model.supported_reasoning_efforts;
    const efforts = Array.isArray(effortRows)
      ? effortRows.flatMap((row) => {
          const item = typeof row === "string" ? { reasoningEffort: row } : (row as Record<string, unknown>);
          const effort = String(item.reasoningEffort ?? item.reasoning_effort ?? "").trim();
          return effort
            ? [
                {
                  id: effort,
                  label: effortLabel(effort),
                  description: typeof item.description === "string" ? item.description : undefined,
                },
              ]
            : [];
        })
      : [];
    models.push({
      id,
      label: String(model.displayName ?? model.display_name ?? id),
      description: typeof model.description === "string" ? model.description : undefined,
      isDefault: model.isDefault === true || model.is_default === true,
      defaultEffort: String(model.defaultReasoningEffort ?? model.default_reasoning_effort ?? "").trim() || undefined,
      efforts,
      supportsFast: codexModelSupportsFast(model),
    });
  }
  return models;
}

export function codexModels(result: unknown): ModelOption[] {
  return [
    { id: "default", label: "Default", description: "Use the Codex default model" },
    ...codexModelInfos(result).map(({ id, label, description }) => ({ id, label, description })),
  ];
}

export function selectedCodexModel(result: unknown, modelId?: string): CodexModelInfo | undefined {
  const models = codexModelInfos(result);
  return modelId ? models.find((model) => model.id === modelId) : models.find((model) => model.isDefault) ?? models[0];
}

export function codexEfforts(result: unknown, modelId?: string): EffortOption[] {
  const model = selectedCodexModel(result, modelId);
  return [
    {
      id: "default",
      label: "Default",
      description: model?.defaultEffort
        ? `Use the ${model.label} default (${model.defaultEffort})`
        : "Use the Codex default effort",
    },
    ...(model?.efforts ?? []),
  ];
}

export function codexModelSupportsEffort(model: CodexModelInfo, effort: string): boolean {
  return model.efforts.some((candidate) => candidate.id === effort);
}

export function codexModes(result: unknown): CodexModeInfo[] {
  const data = (result as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const mode = String(row.mode ?? "").toLowerCase();
    if (mode !== "default" && mode !== "plan") return [];
    const effort = row.reasoning_effort;
    return [{
      id: mode,
      label: String(row.name ?? (mode === "plan" ? "Plan" : "Default")),
      ...(typeof effort === "string" ? { effort } : {}),
    }];
  });
}

export function updateCodexResolvedSettings(rt: ThreadRuntime, catalog: unknown): void {
  const selected = selectedCodexModel(catalog, rt.model);
  rt.resolvedModel = selected?.id ?? rt.model;
  rt.resolvedEffort = rt.effort ?? selected?.defaultEffort;
}

export function codexCollaborationMode(rt: ThreadRuntime) {
  if (!rt.mode || !rt.resolvedModel) return undefined;
  return {
    mode: rt.mode,
    settings: {
      model: rt.resolvedModel,
      reasoning_effort: rt.modeEffort ?? rt.resolvedEffort ?? null,
      // null asks app-server to use its version-matched built-in instructions.
      developer_instructions: null,
    },
  };
}

// codex CommandExecutionApprovalDecision / FileChangeApprovalDecision 的字符串成员。
// 注意 cancel 的 "deny + 中断 turn"：中断属于 Control 轴，不是更强的拒绝范围——
// 两轴上它与 decline 同为 (reject, once)，差别只由 name 承载。
