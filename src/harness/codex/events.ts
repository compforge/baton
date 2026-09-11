import { newId } from "../../event/ids.ts";
import { planEntriesWithIds } from "../../event/plan.ts";
import type { SessionConfigOption } from "../../event/index.ts";
import { closedTerminal } from "../normalize.ts";
import { planSnapshotDraft } from "../plan.ts";
import type { LogSink } from "../../logging.ts";
import type { InteractionDraft, QuestionPrompt } from "../../interaction/types.ts";
import type { HarnessEventSink, NativeEventSink, OpenInteraction } from "../adapter.ts";
import {
  asRecord,
  codexApprovalChoices,
  codexItemLifecycleDrafts,
  codexToolTerminalStatus,
  toolTitleOf,
} from "./mapping.ts";
import { isFastServiceTier, type CodexTurn, type ThreadRuntime } from "./runtime.ts";

const CODEX_REVIEW_DECISION: Record<string, "approved" | "denied" | "aborted"> = {
  approved: "approved",
  denied: "denied",
  aborted: "aborted",
};

interface CodexEventHandlerOptions {
  openInteraction: OpenInteraction;
  nativeEvent?: NativeEventSink;
  log?: LogSink;
  emit(runtime: ThreadRuntime, event: Parameters<HarnessEventSink>[0], raw?: unknown, turn?: CodexTurn): void;
  finishTurn(runtime: ThreadRuntime, turn: CodexTurn | undefined, turnStatus: string): void;
  publishConfigSnapshot(runtime: ThreadRuntime, options: SessionConfigOption[], raw?: unknown): void;
  flushPendingCancel(runtime: ThreadRuntime): void;
}

/** Maps Codex app-server notifications and server requests into Baton protocol events. */
export class CodexEventHandler {
  constructor(private options: CodexEventHandlerOptions) {}
  /**
   * codex 给了 baton 认不出的审批候选 → 显式提示，不静默降级。
   *
   * 悲观丢弃（structuredApprovalChoice 读不出就不给）保证了"不猜"，但那只是不变量 #2 的
   * 前半句；"绝不失声"要求把降级本身说出来：codex 迭代频繁、新增 decision 属于常态，
   * 静默丢弃会让用户在毫不知情下长期少一个本可用的选项，也让 baton 落后于上游这件事
   * 无人发现。按形状键在 thread 内去重——否则新增一种 decision 会让每次审批都刷屏。
   */
  private noticeUnmappedDecisions(
    rt: ThreadRuntime,
    unmapped: string[],
    fellBack: boolean,
    params: unknown,
  ): void {
    if (unmapped.length === 0) return;
    const seen = (rt.unmappedDecisionKeys ??= new Set<string>());
    const novel = unmapped.filter((key) => !seen.has(key));
    if (novel.length === 0) return;
    novel.forEach((key) => seen.add(key));
    this.options.emit(
      rt,
      {
        kind: "_baton_notice",
        payload: {
          level: "warning",
          title: "Unrecognized approval choices from codex",
          detail: `baton does not understand ${novel.join(", ")} — ${
            fellBack
              ? "showing baton's standard options instead of codex's own"
              : "those choices are hidden from the card"
          }. Upgrade baton if codex added new approval types.`,
        },
      },
      params,
    );
  }

  /** 错误路径终态：先留结构化 error，再合成 idle（见 docs/workflow.md） */
  failTurn(rt: ThreadRuntime, turn: CodexTurn | undefined, message: string): void {
    if (!turn || turn.finalized) return;
    this.options.emit(rt, { kind: "_baton_error_update", payload: { message } }, undefined, turn);
    this.options.finishTurn(rt, turn, "failed");
  }

  handleNotification(rt: ThreadRuntime, method: string, params: unknown): void {
    this.options.nativeEvent?.({ direction: "in", name: method, payload: params });
    const p = (params ?? {}) as Record<string, unknown>;
    if (p.threadId !== undefined && p.threadId !== rt.threadId) return;

    switch (method) {
      case "thread/settings/updated": {
        const settings = asRecord(p.threadSettings);
        rt.serviceTier = typeof settings?.serviceTier === "string" ? settings.serviceTier : null;
        if (rt.configOptions) {
          const options = rt.configOptions.map((option) =>
            option.id === "fast" && option.type === "boolean"
              ? { ...option, value: isFastServiceTier(rt.serviceTier) }
              : option,
          );
          this.options.publishConfigSnapshot(rt, options, params);
        }
        break;
      }
      case "turn/started": {
        const turn = p.turn as Record<string, unknown> | undefined;
        rt.codexTurnId = turn ? String(turn.id) : undefined;
        this.options.flushPendingCancel(rt);
        break;
      }
      case "item/agentMessage/delta":
        this.options.emit(
          rt,
          {
            kind: "agent_message_chunk",
            payload: { messageId: String(p.itemId), content: { type: "text", text: String(p.delta) } },
          },
          params,
        );
        break;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const messageId =
          method === "item/reasoning/summaryTextDelta" && p.summaryIndex !== undefined
            ? `${String(p.itemId)}:summary:${String(p.summaryIndex)}`
            : String(p.itemId);
        this.options.emit(
          rt,
          {
            kind: "agent_thought_chunk",
            payload: { messageId, content: { type: "text", text: String(p.delta) } },
          },
          params,
        );
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = (p.item ?? {}) as Record<string, unknown>;
        const itemType = String(item.type ?? "");
        const lifecycle = method === "item/started" ? "started" : "completed";
        if (itemType === "commandExecution" && item.id != null) {
          const itemId = String(item.id);
          if (lifecycle === "started") {
            const pid = Number(item.processId);
            if (Number.isSafeInteger(pid) && pid > 0) {
              (rt.activeCommandProcesses ??= new Map()).set(itemId, pid);
            }
          } else {
            rt.activeCommandProcesses?.delete(itemId);
          }
        }
        if (itemType === "userMessage" && lifecycle === "completed") {
          const clientId = typeof item.clientId === "string" ? item.clientId : undefined;
          if (clientId && rt.pendingSteerMessageIds?.delete(clientId)) {
            if (rt.inFlightSteerMessageIds?.has(clientId)) {
              (rt.appliedSteerMessageIds ??= new Set()).add(clientId);
            }
            this.options.emit(
              rt,
              {
                kind: "input_delivery_update",
                payload: { messageId: clientId, state: "applied" },
              },
              params,
            );
          }
          break;
        }
        const terminal = lifecycle === "completed" ? codexToolTerminalStatus(item.status) : undefined;
        const isTool =
          itemType &&
          !["agentMessage", "reasoning", "userMessage", "plan", "contextCompaction", "collabAgentToolCall"].includes(
            itemType,
          );
        // 对账：declined 却从未向 baton 发过 requestApproval → 决策权被 harness 侧
        // 策略（auto-review 等）截走了，用户全程不知情。显式提示，不静默渲染。
        if (
          isTool &&
          terminal === "declined" &&
          !rt.approvalSeenItemIds?.has(String(item.id)) &&
          !rt.autoReviewedItemIds?.has(String(item.id))
        ) {
          this.options.emit(
            rt,
            {
              kind: "_baton_notice",
              payload: {
                level: "warning",
                title: "Approval bypassed by harness-side policy",
                detail: `codex declined "${toolTitleOf(item)}" without asking you — check approvals_reviewer / auto-review in codex config`,
              },
            },
            params,
          );
        }
        for (const draft of codexItemLifecycleDrafts(lifecycle, item)) {
          this.options.emit(rt, draft, params);
        }
        break;
      }
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed": {
        // UNSTABLE wire shape：所有字段都在 adapter 边界容错，原始 params 仍随 envelope.raw 保留。
        const review = (p.review ?? {}) as Record<string, unknown>;
        const action = (p.action ?? {}) as Record<string, unknown>;
        // `== null` 同时挡 undefined 与 null：UNSTABLE wire 显式送 null 时 String(null) 会造出
        // 假 id "null"，把回执挂到不存在的工具卡上（§3.3：UNSTABLE 字段一律按可选、缺失容忍）。
        const targetItemId = p.targetItemId == null ? undefined : String(p.targetItemId);
        if (targetItemId) (rt.autoReviewedItemIds ??= new Set()).add(targetItemId);
        // 一等回执只在**终态**铸造：started 只驱动运行相位（见下方 run_status），completed 才落一条
        // 带独立 reviewId 的审计回执（见 docs/approval-lifecycle.md）。这样无需关联 started/completed，无 target /
        // 同一操作多次决策都各自成条。codex 不给 review 自身 id，reviewId 由 adapter 铸。
        if (method.endsWith("/completed")) {
          const decision = closedTerminal(review.status, CODEX_REVIEW_DECISION, "aborted");
          this.options.emit(
            rt,
            {
              kind: "approval_review_update",
              payload: {
                reviewId: newId("arv"),
                ...(targetItemId ? { toolCallId: targetItemId } : {}),
                decision,
                ...(review.riskLevel !== undefined ? { riskLevel: String(review.riskLevel) } : {}),
                ...(review.userAuthorization !== undefined
                  ? { userAuthorization: String(review.userAuthorization) }
                  : {}),
                ...(review.rationale !== undefined ? { rationale: String(review.rationale) } : {}),
                ...(action.type !== undefined ? { actionType: String(action.type) } : {}),
              },
            },
            params,
          );
        }
        this.options.emit(
          rt,
          {
            kind: "_baton_run_status",
            payload: method.endsWith("/started")
              ? { phase: "reviewing_approval", title: "Reviewing approval…" }
              : { phase: null },
          },
          params,
        );
        break;
      }
      case "item/commandExecution/outputDelta":
        // 命令实时输出 → 统一的工具输出流
        this.options.emit(
          rt,
          {
            kind: "tool_call_content_chunk",
            payload: { toolCallId: String(p.itemId), content: { type: "text", text: String(p.delta) } },
          },
          params,
        );
        break;
      case "turn/plan/updated": {
        const planId = `pl_${rt.codexTurnId ?? "turn"}`;
        const entries = planEntriesWithIds(planId, (Array.isArray(p.plan) ? p.plan : []).map((e) => {
          const entry = e as Record<string, unknown>;
          return {
            content: String(entry.step ?? entry.content ?? ""),
            priority: "medium",
            status: String(entry.status ?? "pending"),
          };
        }));
        this.options.emit(rt, planSnapshotDraft(planId, entries), params);
        break;
      }
      case "thread/tokenUsage/updated": {
        const usage = (p.tokenUsage ?? {}) as Record<string, unknown>;
        const total = (usage.total ?? {}) as Record<string, number>;
        const last = (usage.last ?? {}) as Record<string, number>;
        const prev = rt.prevUsage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
        const cur = {
          inputTokens: total.inputTokens ?? 0,
          cachedInputTokens: total.cachedInputTokens ?? 0,
          outputTokens: total.outputTokens ?? 0,
          reasoningOutputTokens: total.reasoningOutputTokens ?? 0,
        };
        rt.prevUsage = cur;
        const delta = {
          inputTokens: Math.max(0, cur.inputTokens - prev.inputTokens),
          cacheReadTokens: Math.max(0, cur.cachedInputTokens - prev.cachedInputTokens),
          outputTokens: Math.max(0, cur.outputTokens - prev.outputTokens),
          reasoningTokens: Math.max(0, cur.reasoningOutputTokens - prev.reasoningOutputTokens),
        };
        if (delta.inputTokens || delta.outputTokens || delta.cacheReadTokens || delta.reasoningTokens) {
          this.options.emit(rt, { kind: "usage_update", payload: delta }, params);
        }
        const capacityTokens = typeof usage.modelContextWindow === "number" ? usage.modelContextWindow : undefined;
        const usedTokens = typeof last.inputTokens === "number" ? last.inputTokens : undefined;
        if (capacityTokens !== undefined && usedTokens !== undefined) {
          this.options.emit(
            rt,
            {
              kind: "context_window_update",
              payload: {
                modelSelection: rt.model ?? "default",
                usedTokens,
                capacityTokens,
              },
            },
            params,
          );
        }
        break;
      }
      case "turn/completed": {
        const turn = (p.turn ?? {}) as Record<string, unknown>;
        // 通知流单连接有序：此刻的 activeTurn 就是该通知所属的 turn
        this.options.finishTurn(rt, rt.activeTurn, String(turn.status ?? "completed"));
        break;
      }
      case "error": {
        const error = (p.error ?? {}) as Record<string, unknown>;
        const willRetry = p.willRetry === true;
        const code = typeof error.codexErrorInfo === "string" ? error.codexErrorInfo : undefined;
        this.options.emit(
          rt,
          {
            kind: "_baton_error_update",
            payload: {
              message: String(error.message ?? "Codex turn failed"),
              ...(code ? { code } : {}),
              willRetry,
            },
          },
          params,
        );
        // app-server 明确保证 willRetry=true 不打断 turn；反之 error 本身就是终态，
        // 立即收口可避免依赖随后可能丢失的 turn/completed，迟到终态由 finalized 幂等吸收。
        if (!willRetry) this.options.finishTurn(rt, rt.activeTurn, "failed");
        break;
      }
      case "hook/completed": {
        // 只关心会吞掉整个 turn 的拦截：UserPromptSubmit / SessionStart 被 block 时
        // codex core 静默空结束（prompt 不进 history、无任何 error 事件），block 原因只在
        // 这条通知里。其余 hook 事件（stop/preToolUse…）的 block 是流程控制语义，不上报。
        const run = (p.run ?? {}) as Record<string, unknown>;
        const status = String(run.status ?? "");
        const eventName = String(run.eventName ?? "");
        if (
          (status !== "blocked" && status !== "stopped") ||
          (eventName !== "userPromptSubmit" && eventName !== "sessionStart")
        ) {
          break;
        }
        const entries = (Array.isArray(run.entries) ? run.entries : []) as Array<Record<string, unknown>>;
        const reason =
          entries.map((entry) => String(entry.text ?? "")).filter(Boolean).join("; ") ||
          (run.statusMessage ? String(run.statusMessage) : "") ||
          undefined;
        const source = String(run.sourcePath ?? "unknown hook");
        if (rt.activeTurn && !rt.activeTurn.finalized) rt.activeTurn.hookBlock = { source, reason };
        this.options.emit(
          rt,
          {
            kind: "_baton_notice",
            payload: {
              level: "warning",
              title: `Codex ${eventName} hook blocked the prompt`,
              detail: reason ? `${source}: ${reason}` : source,
            },
          },
          params,
        );
        break;
      }
      default:
        {
          const counts = (rt.unmappedNotificationCounts ??= new Map<string, number>());
          const count = (counts.get(method) ?? 0) + 1;
          counts.set(method, count);
          if (count === 1 || count % 100 === 0) {
            this.options.log?.({
              level: "warn",
              source: "harness",
              component: "codex.notification",
              harness: "codex",
              turnId: rt.activeTurn?.turnId,
              message: `unmapped codex notification: ${method}`,
              attributes: { method, count },
            });
          }
          break;
        }
    }
  }

  async handleServerRequest(rt: ThreadRuntime, method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      // v2 与 v1 两代审批请求都回 {decision}
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
      case "execCommandApproval":
      case "applyPatchApproval": {
        // 登记"问过 baton"的 item：declined 对账（见 approvalSeenItemIds）以此判定
        // 拒绝是否出自用户之手。v1 两代方法用 callId 指代 item，一并登记。
        for (const idField of [p.itemId, p.callId]) {
          if (idField === undefined) continue;
          (rt.approvalSeenItemIds ??= new Set()).add(String(idField));
        }
        const presentation = approvalPresentationOf(method, p);
        const { choices, unmapped, fellBack } = codexApprovalChoices(p);
        this.noticeUnmappedDecisions(rt, unmapped, fellBack, params);
        const interaction: InteractionDraft = {
          kind: "permission",
          ...presentation,
          toolCallId: p.itemId !== undefined ? String(p.itemId) : undefined,
          options: choices.map((choice) => choice.option),
        };
        if (rt.activeTurn) rt.activeTurn.sawOutput = true;
        const result = await this.options.openInteraction(interaction, {
          ...(rt.activeTurn?.turnId ? { turnId: rt.activeTurn.turnId } : {}),
          raw: params,
        });
        if (result.kind === "cancelled") {
          return { decision: "cancel" };
        }
        // result 按 interactionId 路由回来，kind 必配对 permission；意外不配保守拒绝。
        const optionId = result.kind === "permission" ? result.optionId : "";
        // 选不中就回 decline，不把 optionId 原样透传：结构化候选的 optionId 是 baton 铸的
        // 合成 id（acceptWithExecpolicyAmendment:1），不是 codex wire 值；空串更不是"拒绝"，
        // 而是个非法 wire 值——曾经这里以为透传就等于 fail-closed，其实没有。
        return {
          decision: choices.find((choice) => choice.option.optionId === optionId)?.decision ?? "decline",
        };
      }
      case "item/tool/requestUserInput": {
        const source = Array.isArray(p.questions) ? p.questions : [];
        const questions: QuestionPrompt[] = source.map((value, index) => {
          const question = (value ?? {}) as Record<string, unknown>;
          return {
            questionId: String(question.id ?? `q${index}`),
            header: String(question.header ?? `Question ${index + 1}`),
            question: String(question.question ?? ""),
            choices: Array.isArray(question.options)
              ? question.options.map((option) => {
                  const item = (option ?? {}) as Record<string, unknown>;
                  const label = String(item.label ?? "");
                  return {
                    value: label,
                    label,
                    description: String(item.description ?? ""),
                  };
                })
              : undefined,
            allowOther: question.isOther === true,
            secret: question.isSecret === true,
          };
        });
        const interaction: InteractionDraft = {
          kind: "question",
          questions,
        };
        if (rt.activeTurn) rt.activeTurn.sawOutput = true;
        const result = await this.options.openInteraction(interaction, {
          ...(rt.activeTurn?.turnId ? { turnId: rt.activeTurn.turnId } : {}),
          raw: params,
        });
        if (result.kind === "cancelled") {
          return { answers: {} };
        }
        const decisionAnswers = result.kind === "question" ? result.answers : {};
        return {
          answers: Object.fromEntries(
            Object.entries(decisionAnswers).map(([questionId, answers]) => [questionId, { answers }]),
          ),
        };
      }
      default:
        throw new Error(`unsupported server request: ${method}`);
    }
  }
}

function approvalPresentationOf(
  method: string,
  p: Record<string, unknown>,
): { title: string; description?: string } {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    return {
      title: "Run command?",
      description: String(p.command ?? p.reason ?? "(see details)"),
    };
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    return { title: "Apply file changes?" };
  }
  return { title: "Codex requests permission" };
}
