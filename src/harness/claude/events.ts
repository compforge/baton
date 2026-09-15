import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import { newId } from "../../event/ids.ts";
import { MessageReplies } from "../message-replies.ts";
import type { LogSink } from "../../logging.ts";
import type { InteractionDraft, QuestionPrompt } from "../../interaction/types.ts";
import type { HarnessEventSink, OpenInteraction } from "../adapter.ts";
import {
  claudeApprovalOptions,
  claudeDurableMessageDrafts,
  claudeProposedPlanDraft,
  claudeToolTitle,
} from "./mapping.ts";
import {
  claudeAvailableCommands,
  claudeCommandName,
  claudeContextSampleTokens,
  claudeContextWindow,
  claudeModelMatches,
  claudeStructuredContextWindow,
  commandLifecycleKey,
  publishClaudeContextWindow,
  type ClaudeContextSample,
  type ClaudeRuntime,
  type ClaudeStreamMessage,
  type ClaudeTurn,
} from "./runtime.ts";

interface ClaudeEventHandlerOptions {
  openInteraction: OpenInteraction;
  log?: LogSink;
  publishSessionBinding(runtime: ClaudeRuntime, sessionId: string): void;
  finishTurn(
    runtime: ClaudeRuntime,
    emit: HarnessEventSink,
    turn: ClaudeTurn,
    stopReason: string,
    raw?: unknown,
  ): void;
}

export type ClaudePermissionMeta = Parameters<CanUseTool>[2];

function consumedUserMessageUuids(correlation: {
  user_message_uuid?: string;
  user_message_uuids?: string[];
}): readonly string[] {
  return correlation.user_message_uuids ??
    (correlation.user_message_uuid ? [correlation.user_message_uuid] : []);
}

/** Maps Claude SDK messages and permission callbacks into Baton protocol events. */
export class ClaudeEventHandler {
  constructor(private options: ClaudeEventHandlerOptions) {}
  async handleCanUseTool(
    rt: Pick<ClaudeRuntime, "capturedProposedPlanKeys">,
    emit: HarnessEventSink,
    turnId: () => string,
    toolName: string,
    input: Record<string, unknown>,
    meta: ClaudePermissionMeta,
  ): Promise<PermissionResult> {
    if (toolName === "AskUserQuestion") return this.handleQuestion(turnId, input, meta.toolUseID);
    if (toolName === "ExitPlanMode") {
      this.captureProposedPlan(rt, emit, turnId(), input, meta.toolUseID, { toolName, input, meta });
      return {
        behavior: "deny",
        message:
          "Baton captured the proposed plan. Stop here and wait for user feedback or a later implementation request.",
      };
    }
    const suggestions = meta.suggestions ?? [];
    const interaction: InteractionDraft = {
      kind: "permission",
      title: meta.title ?? claudeToolTitle(toolName, input),
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.toolUseID ? { toolCallId: meta.toolUseID } : {}),
      options: claudeApprovalOptions({
        hasSuggestions: suggestions.length > 0,
        defaultToNo: meta.defaultToNo,
        suppressAlwaysAllowRule: meta.suppressAlwaysAllowRule,
      }),
    };
    const result = await this.options.openInteraction(interaction, {
      turnId: turnId(),
      raw: { toolName, input, meta },
    });
    if (result.kind === "cancelled") {
      return { behavior: "deny", message: "turn interrupted before approval" };
    }
    // result 按 interactionId 路由回来，kind 必配对 permission；意外不配一律保守拒绝。
    const optionId = result.kind === "permission" ? result.optionId : "";
    if (optionId === "allow") return { behavior: "allow", updatedInput: input };
    if (optionId === "allowAlways") {
      // SDK 契约：把 canUseTool 收到的整组 suggestions 原样作为 updatedPermissions
      // 返回，即 CLI "Yes, don't ask again" 的同款授权路径
      return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions };
    }
    return { behavior: "deny", message: "denied by baton user" };
  }

  private async handleQuestion(
    turnId: () => string,
    input: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<PermissionResult> {
    const source = Array.isArray(input.questions) ? input.questions : [];
    const questions: QuestionPrompt[] = source.map((value, index) => {
      const question = (value ?? {}) as Record<string, unknown>;
      return {
        questionId: `q${index}`,
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
                ...(typeof item.preview === "string" ? { preview: item.preview } : {}),
              };
            })
          : undefined,
        multiSelect: question.multiSelect === true,
        // Claude Code adds Other automatically for AskUserQuestion.
        allowOther: true,
      };
    });
    const interaction: InteractionDraft = {
      kind: "question",
      ...(toolCallId ? { toolCallId } : {}),
      questions,
    };
    const result = await this.options.openInteraction(interaction, {
      turnId: turnId(),
      raw: input,
    });
    if (result.kind === "cancelled") {
      return { behavior: "deny", message: "turn interrupted before answer" };
    }
    const decisionAnswers = result.kind === "question" ? result.answers : {};
    const answers = Object.fromEntries(
      questions.map((question) => [question.question, (decisionAnswers[question.questionId] ?? []).join(", ")]),
    );
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  private captureProposedPlan(
    rt: Pick<ClaudeRuntime, "capturedProposedPlanKeys">,
    emit: HarnessEventSink,
    turnId: string,
    input: Record<string, unknown>,
    toolUseId: string | undefined,
    raw: unknown,
  ): void {
    const draft = claudeProposedPlanDraft(rt, turnId, input, toolUseId, raw);
    if (draft) emit(draft);
  }

  /**
   * Claude may coalesce several queued user messages into one model turn. Newer SDKs report the
   * complete consumed batch in user_message_uuids; consuming only the representative singular UUID
   * leaves the other Baton inputs stuck in the Composer Queue. Delete before emitting so the
   * partial/assistant/result and command-lifecycle correlation paths remain idempotent.
   */
  private applyConsumedOffers(
    rt: Pick<ClaudeRuntime, "pendingOfferUuids">,
    emit: HarnessEventSink,
    uuids: readonly string[],
    raw: unknown,
    beforeMessageId?: string,
  ): void {
    for (const uuid of new Set(uuids)) {
      const offer = rt.pendingOfferUuids?.get(uuid);
      if (!offer) continue;
      rt.pendingOfferUuids?.delete(uuid);
      emit({
        kind: "input_delivery_update",
        payload: { messageId: offer.messageId, state: "applied", ...(beforeMessageId ? { beforeMessageId } : {}) },
        raw,
      });
    }
  }

  handleMessage(rt: ClaudeRuntime, sink: HarnessEventSink, msg: ClaudeStreamMessage, turn: ClaudeTurn): void {
    const replies = turn.replies ??= new MessageReplies();
    const correlation = msg as { user_message_uuid?: string; user_message_uuids?: string[] };
    const uuids = consumedUserMessageUuids(correlation);
    const ids = uuids.map((uuid) => rt.inputMessageIdsByUuid?.get(uuid) ?? rt.pendingOfferUuids?.get(uuid)?.messageId);
    const explicit = ids.length > 0 && ids.every((id) => id !== undefined) ? ids : undefined;
    if (uuids.length > 0) replies.current = explicit;
    const emit: HarnessEventSink = (event) => {
      if (event.kind === "input_delivery_update" && event.payload.state === "applied" && explicit === undefined) {
        // A consumption receipt does not identify all questions addressed by an answer.
        replies.current = undefined;
      }
      sink(replies.apply(event, explicit));
    };
    switch (msg.type) {
      case "command_lifecycle": {
        const key = commandLifecycleKey(msg);
        const offer = rt.pendingOfferUuids?.get(key);
        // 首轮 prompt 和 CLI 内部 command 也有 lifecycle；只处理 Baton 发出的 steer uuid。
        if (!offer) break;
        if (msg.state === "queued") break;
        if (msg.state === "started" || msg.state === "completed") {
          rt.pendingOfferUuids?.delete(key);
          emit({
            kind: "input_delivery_update",
            payload: { messageId: offer.messageId, state: "applied" },
            raw: msg,
          });
          break;
        }
        if (msg.state === "cancelled" || msg.state === "discarded" || msg.state === "refused") {
          rt.pendingOfferUuids?.delete(key);
          emit({
            kind: "input_delivery_update",
            payload: {
              messageId: offer.messageId,
              state: "failed",
              detail: `Claude reported ${msg.state}`,
            },
            raw: msg,
          });
          emit({
            kind: "_baton_notice",
            payload: {
              level: "warning",
              title: "Queued message was not applied",
              detail: `Claude reported ${msg.state} for ${offer.messageId}`,
            },
            raw: msg,
          });
          break;
        }
        this.noticeUnmappedMessage(rt, `command_lifecycle/${msg.state}`);
        break;
      }
      case "system":
        if (msg.subtype === "init") {
          this.options.publishSessionBinding(rt, msg.session_id);
          rt.appliedEffort = msg.effort ?? undefined;
          rt.terminalSlashCommands = new Set(
            (msg.terminal_slash_commands ?? []).map(claudeCommandName),
          );
          const commands = msg.slash_commands.flatMap((rawName) => {
            const name = claudeCommandName(rawName);
            if (rt.terminalSlashCommands?.has(name)) return [];
            return [rt.availableCommands?.get(name) ?? { name }];
          });
          rt.availableCommands = new Map(commands.map((command) => [command.name, command]));
          emit({
            kind: "available_commands_update",
            payload: { commands },
            raw: msg,
          });
        } else if (msg.subtype === "status") {
          // SDK 的 status 原生就是 phase-or-null 形状（'compacting' | 'requesting' | null）。
          // 只有 compacting 值得成为可见阶段；requesting 是普通运行态，与 null 一样
          // 归一成"无阶段"（回落默认 thinking），未来未知 status 同样安全降级。
          emit({
            kind: "_baton_run_status",
            payload:
              msg.status === "compacting"
                ? { phase: "compacting", title: "Compacting context…" }
                : { phase: null },
            raw: msg,
          });
        } else if (msg.subtype === "commands_changed") {
          const commands = claudeAvailableCommands(msg.commands, rt.terminalSlashCommands);
          rt.availableCommands = new Map(commands.map((command) => [command.name, command]));
          emit({
            kind: "available_commands_update",
            payload: { commands },
            raw: msg,
          });
        } else if (msg.subtype === "task_started") {
          emit({
            kind: "task_update",
            payload: {
              taskId: msg.task_id,
              status: "in_progress",
              title: msg.description,
              ...(msg.subagent_type ?? msg.task_type
                ? { taskType: msg.subagent_type ?? msg.task_type }
                : {}),
              ...(msg.skip_transcript !== undefined
                ? { skipTranscript: msg.skip_transcript }
                : {}),
              ...(msg.is_backgrounded !== undefined
                ? { backgrounded: msg.is_backgrounded }
                : {}),
              ...(msg.spawn_depth !== undefined ? { spawnDepth: msg.spawn_depth } : {}),
            },
            raw: msg,
          });
        } else if (msg.subtype === "task_updated") {
          const status = msg.patch.status;
          emit({
            kind: "task_update",
            payload: {
              taskId: msg.task_id,
              status:
                status === "completed"
                  ? "completed"
                  : status === "failed"
                    ? "failed"
                    : status === "killed"
                      ? "stopped"
                      : "in_progress",
              ...(msg.patch.description ? { title: msg.patch.description } : {}),
              ...(msg.patch.error ? { summary: msg.patch.error } : {}),
              ...(msg.patch.is_backgrounded !== undefined
                ? { backgrounded: msg.patch.is_backgrounded }
                : {}),
            },
            raw: msg,
          });
        } else if (msg.subtype === "task_progress") {
          emit({
            kind: "task_update",
            payload: {
              taskId: msg.task_id,
              status: "in_progress",
              title: msg.description,
              ...(msg.subagent_type ? { taskType: msg.subagent_type } : {}),
              ...(msg.summary ? { summary: msg.summary } : {}),
              ...(msg.last_tool_name ? { lastToolName: msg.last_tool_name } : {}),
              usage: {
                totalTokens: msg.usage.total_tokens,
                toolUses: msg.usage.tool_uses,
                durationMs: msg.usage.duration_ms,
              },
            },
            raw: msg,
          });
        } else if (msg.subtype === "task_notification") {
          emit({
            kind: "task_update",
            payload: {
              taskId: msg.task_id,
              status: msg.status,
              summary: msg.summary,
              usage: msg.usage
                ? {
                    totalTokens: msg.usage.total_tokens,
                    toolUses: msg.usage.tool_uses,
                    durationMs: msg.usage.duration_ms,
                  }
                : undefined,
              ...(msg.skip_transcript !== undefined
                ? { skipTranscript: msg.skip_transcript }
                : {}),
            },
            raw: msg,
          });
        } else if (msg.subtype === "thinking_tokens") {
          // The SDK stamps thinking progress before the first reply frame, so a single folded input
          // can leave the Composer Queue as soon as Claude demonstrably starts consuming it.
          this.applyConsumedOffers(rt, emit, consumedUserMessageUuids(msg), msg);
        } else if (!CLAUDE_IGNORED_SYSTEM_SUBTYPES.has(msg.subtype)) {
          this.noticeUnmappedMessage(rt, `system/${msg.subtype}`);
        }
        break;
      case "stream_event": {
        this.applyConsumedOffers(rt, emit, consumedUserMessageUuids(msg), msg,
          msg.event.type === "message_start" ? undefined : turn.streamMessageId);
        // 子 agent（parent_tool_use_id 非空）的流式输出不进主时间线，内容随 tool result 汇总
        if (msg.parent_tool_use_id) break;
        const event = msg.event as {
          type: string;
          delta?: { type: string; text?: string; thinking?: string };
          message?: {
            model?: string;
            usage?: {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
        };
        if (event.type === "message_start") {
          turn.streamMessageId = newId("m");
          // 每次模型调用开端的 usage 即当时的真实 context 占用；turn 内多次调用取最后一次，
          // compact 后新 sample 自然回落。子 agent 已在上面被 parent_tool_use_id 过滤。
          const usage = event.message?.usage;
          if (usage) {
            const sample: ClaudeContextSample = {
              ...(event.message?.model ? { model: event.message.model } : {}),
              inputTokens: usage.input_tokens ?? 0,
              cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
              cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
            };
            rt.lastContextSample = sample;
            const previous = rt.lastContextWindow;
            // SDK 只在 result.modelUsage 给出 contextWindow。首轮拿到容量后，后续每次
            // message_start 都能立即刷新占用，不必让长工具链一直显示上一轮的旧百分比。
            if (
              previous &&
              (!sample.model || claudeModelMatches(previous.effectiveModel, sample.model))
            ) {
              publishClaudeContextWindow(
                rt,
                emit,
                {
                  effectiveModel: sample.model ?? previous.effectiveModel,
                  usedTokens: claudeContextSampleTokens(sample),
                  capacityTokens: previous.capacityTokens,
                },
                msg,
              );
            }
          }
        } else if (event.type === "content_block_delta" && event.delta) {
          const messageId = turn.streamMessageId ?? (turn.streamMessageId = newId("m"));
          if (event.delta.type === "text_delta" && event.delta.text) {
            emit({
              kind: "agent_message_chunk",
              payload: { messageId, content: { type: "text", text: event.delta.text } },
              raw: msg,
            });
          } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
            emit({
              kind: "agent_thought_chunk",
              payload: { messageId: `${messageId}_thought`, content: { type: "text", text: event.delta.thinking } },
              raw: msg,
            });
          }
        }
        break;
      }
      case "assistant": {
        this.applyConsumedOffers(rt, emit, consumedUserMessageUuids(msg), msg, turn.streamMessageId);
        if (msg.context_usage) {
          const context = claudeStructuredContextWindow(msg.context_usage);
          if (context) {
            publishClaudeContextWindow(rt, emit, context, msg);
            turn.structuredContextReported = true;
          }
        }
        const blocks = (msg.message.content ?? []) as unknown as Array<Record<string, unknown>>;
        const hasDurableMessage = blocks.some(
          (block) => block.type === "text" || block.type === "thinking",
        );
        const messageId = turn.streamMessageId ?? newId("m");
        for (const draft of claudeDurableMessageDrafts(rt, msg, {
          turnId: turn.turnId,
          messageId,
          raw: msg,
        })) {
          emit(draft);
        }
        if (hasDurableMessage && !msg.parent_tool_use_id) {
          // 最终全文 upsert 与 chunk 共用 messageId，完成后下一条 assistant 消息另开 id。
          turn.streamMessageId = undefined;
        }
        break;
      }
      case "user": {
        for (const draft of claudeDurableMessageDrafts(rt, msg, {
          turnId: turn.turnId,
          raw: msg,
        })) {
          emit(draft);
        }
        break;
      }
      case "result": {
        // An error result's singular UUID may describe delivery failure rather than consumption;
        // user_message_uuids is present only when the turn actually ran and is safe on either subtype.
        const consumedUuids = msg.subtype === "success"
          ? consumedUserMessageUuids(msg)
          : (msg.user_message_uuids ?? []);
        this.applyConsumedOffers(rt, emit, consumedUuids, msg);
        const usage = msg.usage;
        if (usage) {
          emit({
            kind: "usage_update",
            payload: {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            },
            raw: msg,
          });
        }
        const context = turn.structuredContextReported
          ? undefined
          : claudeContextWindow(msg.modelUsage, rt.model, rt.lastContextSample);
        if (context) {
          publishClaudeContextWindow(rt, emit, context, msg);
        }
        // SDK 内部重试耗尽后以 success result + api_error_status 收口（v0.3.223 起，
        // 典型为 529 过载）；结构化为错误事件，避免被当普通 end_turn 静默吞掉。
        if (msg.subtype === "success" && typeof msg.api_error_status === "number") {
          const status = msg.api_error_status;
          emit({
            kind: "_baton_error_update",
            payload: {
              code: `api_error_${status}`,
              message:
                status === 529
                  ? "Claude API overloaded (529): retries exhausted, turn ended early"
                  : `Claude API error (HTTP ${status}): turn ended early`,
              retryable: status >= 500,
              willRetry: false,
            },
            raw: msg,
          });
        }
        this.options.finishTurn(
          rt,
          emit,
          turn,
          turn.cancelRequested ? "cancelled" : msg.subtype === "success" ? "end_turn" : msg.subtype,
          msg,
        );
        break;
      }
      default:
        if (!CLAUDE_IGNORED_MESSAGE_TYPES.has(msg.type)) {
          this.noticeUnmappedMessage(rt, msg.type);
        }
    }
  }

  private noticeUnmappedMessage(rt: ClaudeRuntime, key: string): void {
    const seen = (rt.unmappedMessageKeys ??= new Set());
    if (seen.has(key)) return;
    seen.add(key);
    this.options.log?.({
      level: "warn",
      source: "harness",
      component: "claude.protocol",
      harness: "claude-code",
      turnId: rt.currentTurn?.turnId,
      message: `unmapped Claude SDK message: ${key}`,
      attributes: { count: 1 },
    });
  }
}

const CLAUDE_IGNORED_SYSTEM_SUBTYPES = new Set<string>([
  "background_tasks_changed",
  "compact_boundary",
  "control_request_progress",
  "elicitation_complete",
  "hook_progress",
  "hook_response",
  "hook_started",
  "memory_recall",
  "plugin_install",
]);

const CLAUDE_IGNORED_MESSAGE_TYPES = new Set<string>([
  "api_retry",
  "auth_status",
  "control_request_progress",
  "elicitation_complete",
  "files_persisted",
  "hook_progress",
  "hook_response",
  "hook_started",
  "informational",
  "local_command_output",
  "model_refusal_fallback",
  "model_refusal_no_fallback",
  "notification",
  "permission_denied",
  "plugin_install",
  "prompt_suggestion",
  "rate_limit_event",
  "session_state_changed",
  "thinking_tokens",
  "tool_progress",
  "tool_use_summary",
  "worker_shutting_down",
]);
