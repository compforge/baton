// baton 对 chat-tui 的接入层：实现 ChatProtocol，把 Controller / SessionStore
// 的状态投影成视图快照，把 TUI intents 翻译成 controller 操作。
// UI 语义（补全、分层 Ctrl+C、浮层交互）都在 chat-tui；这里只有 baton 的业务编排。

import type {
  BlockTone,
  ChatProtocol,
  ChatViewState,
  Candidate,
  CommandSpec,
  DiffOp,
  InteractionResponse,
  InteractionView,
  RunStatusItem,
  StatusMessage,
  TranscriptBlockContent,
  TranscriptBlockStatus,
  TranscriptItem,
} from "chat-tui";

import {
  COMMANDS,
  parseHarness,
  parseHarnessRoute,
  type CommandName,
} from "../commands/registry.ts";
import type { BatonConfig } from "../config/config.ts";
import { loadEffortPreferences, saveEffortPreference } from "../config/effort-preferences.ts";
import { loadModelPreferences, saveModelPreference } from "../config/model-preferences.ts";
import { expandMentions } from "../context/mention.ts";
import {
  textOf,
  type ApprovalReviewUpdate,
  type DiffBlock,
  type EventKind,
  type PromptBlock,
} from "../event/types.ts";
import {
  createHarnessAdapter,
  HARNESS_REGISTRY,
  harnessDefinitionFor,
  harnessShortName,
  resolveDefaultHarnessTarget,
  probeHarnessTarget,
} from "../harness/registry.ts";
import type {
  HookTrustInteraction,
  Interaction,
  InteractionResolution,
  PermissionOption,
} from "../interaction/types.ts";
import { createBatonSnapshot } from "../plugin/baton-snapshot.ts";
import { Manager } from "../plugin/manager.ts";
import { MarketplaceRegistry } from "../plugin/marketplace/index.ts";
import {
  GlobalPluginInstanceStore,
  PluginSettingsStore,
} from "../plugin/settings.ts";
import { ProposalStore } from "../plugin/proposal.ts";
import { openBatonSession } from "../session/open.ts";
import { Controller } from "../controller/index.ts";
import { applyEvent, isTurnRunning, type SessionState, type ToolCallState } from "../store/reduce.ts";
import { sessionDisplayTitle, type SessionHandle, type SessionStore } from "../store/store.ts";
import { sessionMentionCandidates } from "./mentions.ts";
import { sessionPickerOptions, type SessionPickerMode } from "./session-picker.tsx";
import { setTerminalTabTitle } from "./terminal-title.ts";

// OpenTUI 以 30 FPS 绘制；逐 token 同步发布完整 view 只会让 React 重复重建 transcript，
// 还会挤占 composer 的终端光标刷新。只合并高频、可安全追加的流式事件；Interaction、终态和
// 完整快照仍立即发布，并顺带冲刷此前积累的 chunk，避免交互卡片被延迟。
const STREAM_VIEW_FRAME_MS = 33;
const COALESCED_STREAM_EVENT_KINDS: ReadonlySet<EventKind> = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call_content_chunk",
  "usage_update",
]);

/**
 * 双轴 → chat-tui 既有的 `kind` 词表。双轴是 baton 的内部模型，在边界投影回接入方
 * 已消费的形状——中间重构不惊动边界契约（kernel §3）。chat-tui 把 kind 当 description
 * 渲染，所以这里的取值直接是用户看见的字；等 chat-tui 改成消费双轴，再退掉这层。
 *
 */
function approvalOptionKind(option: PermissionOption): string {
  const lasting = option.lifetime !== "once";
  return option.polarity === "allow"
    ? lasting
      ? "allow_always"
      : "allow_once"
    : lasting
      ? "reject_always"
      : "reject_once";
}

function hookTrustDescription(interaction: HookTrustInteraction): string {
  return interaction.hooks
    .map((hook) => {
      const owner = hook.pluginId ?? hook.source;
      const matcher = hook.matcher ? ` · matcher: ${hook.matcher}` : "";
      return `${owner} · ${hook.trustStatus}${matcher}\n${hook.sourcePath}\n${hook.command}`;
    })
    .join("\n\n");
}

function interactionRequester(interaction: Interaction): string {
  if (interaction.requester.type === "harness") {
    return harnessAuthor(interaction.requester.harnessTargetId) ?? interaction.requester.harnessTargetId;
  }
  if (interaction.requester.type === "plugin") return interaction.requester.pluginInstanceId;
  return "baton";
}

function interactionView(interaction: Interaction): InteractionView {
  const requester = interactionRequester(interaction);
  if (interaction.kind === "permission") {
    return {
      id: interaction.interactionId,
      kind: "approval",
      blocking: true,
      requester,
      approval: {
        title: interaction.title,
        description: interaction.description,
        options: interaction.options.map((option) => ({
          optionId: option.optionId,
          name: option.name,
          kind: approvalOptionKind(option),
        })),
      },
    };
  }
  if (interaction.kind === "question") {
    return {
      id: interaction.interactionId,
      kind: "question",
      blocking: true,
      requester,
      question: {
        questions: interaction.questions.map((prompt) => ({
          id: prompt.questionId,
          header: prompt.header,
          question: prompt.question,
          options: prompt.options,
          multiSelect: prompt.multiSelect,
          allowOther: prompt.allowOther,
          secret: prompt.secret,
        })),
      },
    };
  }
  return {
    id: interaction.interactionId,
    kind: "approval",
    blocking: true,
    requester,
    approval: {
      title: `Trust ${interaction.hooks.length} ${interaction.harnessName} hook${interaction.hooks.length === 1 ? "" : "s"}?`,
      description: hookTrustDescription(interaction),
      options: [
        {
          optionId: "trust",
          name: "Trust current definitions (ask again if changed)",
          kind: "allow_always",
        },
        { optionId: "skip", name: "Continue without Codex hooks", kind: "reject_once" },
      ],
    },
  };
}

/** harness（id 或 wire key）→ 时间线 author 展示名；归一与着色 key 统一走 registry。 */
function harnessAuthor(harness: string | undefined): string | undefined {
  if (!harness) return undefined;
  return harnessShortName(harness);
}

export const CHAT_COMMANDS: readonly CommandSpec[] = COMMANDS;

export function userVisibleText(text: string): string {
  return text.replace(/<baton-(context|sync)>[\s\S]*<\/baton-\1>\s*/g, "").trim();
}

/**
 * Run status 文案合成（design §5.9）：显式阶段 / retry / 进行中工具依次覆盖默认 thinking；
 * willRetry 错误仅当它是最新事件时显示 retrying——其后一旦有任何事件即视为已恢复，
 * 避免"重试成功后 retrying 挂到 turn 结束"。
 * phase 按 turn 取（并发 turn 各有各的阶段）；turnId 缺省时退化为任一带 phase 的 turn。
 */
export function runStatusLabel(
  state: Pick<SessionState, "activeTurns" | "toolCalls" | "lastError" | "lastSeq">,
  turnId?: string,
): string {
  const phase =
    turnId !== undefined
      ? state.activeTurns.get(turnId)?.phase
      : [...state.activeTurns.values()].find((turn) => turn.phase)?.phase;
  if (phase) return phase.title ?? `${phase.phase}…`;
  if (state.lastError?.willRetry && state.lastError.seq === state.lastSeq) return "retrying…";
  const tool = [...state.toolCalls.values()]
    .reverse()
    .find(
      (candidate) =>
        (candidate.status === "pending" || candidate.status === "in_progress") &&
        (turnId === undefined || candidate.turnId === turnId),
    );
  if (tool) {
    const labels: Record<string, string> = {
      read: "reading…",
      edit: "editing…",
      delete: "deleting…",
      move: "moving…",
      search: "searching…",
      execute: "running command…",
      think: "thinking…",
      fetch: "fetching…",
    };
    return labels[tool.kind ?? ""] ?? `${tool.title?.split(":", 1)[0]?.trim() || "using tool"}…`;
  }
  return "thinking…";
}

function contextUsageText(
  context: { model?: string; contextUsed?: number; contextSize?: number } | undefined,
  selectedModel: string,
): string {
  if (!context || (context.model && context.model !== selectedModel)) {
    return "unavailable until the harness reports this model";
  }
  if (!context.contextSize || context.contextSize < 0) return "size unavailable";
  const size = context.contextSize.toLocaleString("en-US");
  if (context.contextUsed === undefined) return `${size} tokens`;
  const percent = Math.round((context.contextUsed / context.contextSize) * 100);
  return `${context.contextUsed.toLocaleString("en-US")} / ${size} tokens (${percent}%)`;
}

function contextUsageStatusText(
  context: { model?: string; contextUsed?: number; contextSize?: number } | undefined,
  selectedModel: string,
): string | undefined {
  if (
    !context ||
    (context.model && context.model !== selectedModel) ||
    context.contextUsed === undefined ||
    !context.contextSize ||
    context.contextSize < 0
  ) {
    return undefined;
  }
  const percent = Math.round((context.contextUsed / context.contextSize) * 100);
  return `context ${context.contextUsed.toLocaleString("en-US")}/${context.contextSize.toLocaleString("en-US")} (${percent}%)`;
}

export interface ThoughtDisplayBlock {
  title: string;
  content?: string;
}

export interface BatonNavigation {
  openPlugins(): void;
}

/** 将 reasoning summary 投影成独立时间线块，并隐藏 Codex 的空正文占位符。 */
export function thoughtDisplayBlocks(text: string): ThoughtDisplayBlock[] {
  return text
    .replace(/\r?\n\r?\n<!--\s*$/, "")
    .split(/\r?\n\r?\n<!-- -->\s*(?:\r?\n)?/g)
    .flatMap((part) => {
      const content = part.trim();
      if (!content) return [];
      const summary = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n([\s\S]*))?$/);
      if (summary) {
        const body = summary[2]?.trim();
        return [{ title: summary[1]!.trim(), ...(body ? { content: body } : {}) }];
      }
      const [title, ...body] = content.split(/\r?\n/);
      const detail = body.join("\n").trim();
      return [{ title: title!.trim(), ...(detail ? { content: detail } : {}) }];
    });
}

interface PendingPicker {
  id: string;
  title: string;
  options: Array<{ name: string; description: string; value: string }>;
  onSelect: (value: string) => void | Promise<void>;
}

export class BatonChatProtocol implements ChatProtocol {
  readonly marketplace: MarketplaceRegistry;
  private session: SessionHandle;
  private state: SessionState;
  private controller: Controller;
  private plugins: Manager;
  /** 当前输入与控制命令的具体配置目标；默认 Target ID 与 Harness ID 相同。 */
  private harnessTargetId: string;
  private status: StatusMessage | null = null;
  private commandOutput: TranscriptItem | null = null;
  private picker: PendingPicker | null = null;
  private boardMode: "auto" | "open" | "hidden" = "auto";
  private nextOverlayId = 1;
  private listeners = new Set<() => void>();
  private view: ChatViewState;
  private unsubscribeSession: () => void;
  private streamViewTimer: ReturnType<typeof setTimeout> | undefined;
  // 输入历史（shell 式 ↑/↓ 回溯）：会话级，从事件流的 user 消息种入、提交时追加。
  // 事件流是真相源——不另存磁盘文件；resume/切换会话后 loadState 重建 state 即可重新种入。
  private history: string[] = [];
  private historyCursor: number | null = null; // null = 未浏览（正在编辑草稿）
  private historyStash: string | null = null; // 进入浏览前暂存的草稿，越过最新时恢复
  private lastHistoryText: string | null = null; // 上次召回的条目，判定用户是否改动过
  private readonly modelPreferences: Record<string, string>;
  private readonly effortPreferences: Record<string, string>;

  constructor(
    private readonly store: SessionStore,
    private readonly config: BatonConfig,
    opened: { session: SessionHandle; resumed: boolean; recovered?: boolean },
    private readonly quit: (sessionId?: string) => void,
    private readonly navigation?: BatonNavigation,
  ) {
    this.session = opened.session;
    this.syncTerminalTitle();
    this.harnessTargetId = config.defaultAgent;
    this.modelPreferences = loadModelPreferences(store.rootDir);
    this.effortPreferences = loadEffortPreferences(store.rootDir);
    this.marketplace = new MarketplaceRegistry({
      rootDir: store.rootDir,
      cwd: this.session.meta.cwd,
    });
    if (opened.recovered) {
      this.status = { text: "Recovered an interrupted turn from a previous baton run", tone: "info" };
    }
    this.controller = this.createController();
    // 投影单通道：live 与 resume 走同一条 reduce 路径（loadState 补历史 + subscribe 跟增量），
    // 不从 per-turn 回调取事件——harness 自发回合（observed turn）没有对应的 submit 调用。
    this.state = this.session.loadState();
    this.seedHistoryFromState();
    this.unsubscribeSession = this.subscribeSession(this.session);
    this.plugins = this.createPluginManager();
    this.view = this.buildView();
    this.startPluginManager();
  }

  /** 接入事件流增量投影；调用前 state 必须已 loadState 到当前水位 */
  private subscribeSession(session: SessionHandle): () => void {
    return session.subscribe((envelope) => {
      applyEvent(this.state, envelope);
      if (COALESCED_STREAM_EVENT_KINDS.has(envelope.kind)) this.scheduleStreamViewChanged();
      else this.changed();
    });
  }

  // ===== 输出：baton → TUI =====

  getView(): ChatViewState {
    return this.view;
  }

  get pluginManager(): Manager {
    return this.plugins;
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  // ===== 输入：TUI → baton =====

  async submit(text: string): Promise<void> {
    const route = parseHarnessRoute(text);
    if (route?.kind === "ambiguous") {
      this.status = null;
      this.commandOutput = this.batonTranscriptItem(
        "_baton_harness_route_error",
        `Error: harness prefix "/${route.token}" is ambiguous; matches ${route.harnesses.join(", ")}. Use a longer harness name or alias.`,
      );
      this.changed();
      return;
    }
    if (route?.kind === "matched") {
      this.harnessTargetId = route.harness;
      this.status = null;
      this.commandOutput = null;
      this.changed();
      if (!route.message) return;
      return this.submitMessage(route.message);
    }
    return this.submitMessage(text);
  }

  private async submitMessage(
    text: string,
    options?: { sourceProposedPlanId?: string },
  ): Promise<void> {
    // 用户实际提交的内容进历史；一次新提交结束当前的 ↑ 浏览会话。
    this.recordHistory(text);
    this.resetHistoryNav();
    const target = this.harnessTargetId;
    this.status = null;
    this.commandOutput = null;
    const previousTitle = sessionDisplayTitle(this.session.meta);
    if (this.session.meta.forkedFrom) this.session.setTitleIfEmpty(text);
    else this.session.setPreviewIfEmpty(text);
    if (sessionDisplayTitle(this.session.meta) !== previousTitle) this.syncTerminalTitle();
    const { prompt } = expandMentions(this.store, text, this.config.mentionBudgetChars);
    const blocks: PromptBlock[] = [{ type: "text", text: prompt }];

    // 所有 prompt 都走统一 sendTurn；Adapter 依据原生运行态决定 new turn / steer / reject，
    // Controller 只在 reject 或已有队列时维持 follow-up 顺序。
    const sent = await this.controller.sendTurn(target, blocks, options);
    if (sent.effective === "steer") {
      this.status = { text: `steering ${target} — applies at the next safe point`, tone: "info" };
      this.changed();
      return;
    }
    if (sent.reason) {
      this.status = {
        text: `${target} same-turn send rejected (${sent.reason}); queued as follow-up`,
        tone: "info",
      };
    } else if (sent.queued) {
      this.status = { text: `${target} turn queued`, tone: "info" };
    }
    this.changed();
    const outcome = await sent.outcome;
    if (outcome === "completed" && this.status?.tone !== "error") {
      this.status = null;
      this.changed();
    }
  }

  async command(name: string, argument: string): Promise<void> {
    if (name !== "status") this.commandOutput = null;
    const harness = parseHarness(name);
    if (harness) {
      this.harnessTargetId = harness;
      this.status = null;
      this.changed();
      if (argument) await this.submitMessage(argument);
      return;
    }
    const command = name as CommandName;
    switch (command) {
      case "exit":
        return this.exit();
      case "new": {
        if (argument) throw new Error("/new takes no arguments");
        return this.switchSession(() => {
          const next = this.store.createSession({ cwd: this.session.meta.cwd });
          next.acquireLock();
          return { session: next };
        });
      }
      case "sessions": {
        // chat-tui Picker 没有自定义按键，模式经参数选择（启动 picker 则用 Tab 就地切换）
        const mode = argument || "list";
        if (mode !== "list" && mode !== "tree") {
          throw new Error(`/sessions takes 'tree' or 'list' (got: ${argument})`);
        }
        this.openSessionsPicker(mode);
        return;
      }
      case "status": {
        if (argument) throw new Error("/status takes no arguments");
        this.status = null;
        this.commandOutput = this.sessionStatusItem();
        this.changed();
        return;
      }
      case "compact": {
        if (argument) throw new Error("/compact takes no arguments");
        const target = this.harnessTargetId;
        this.status = null;
        await this.controller.compactContext(target);
        this.status = { text: `${target} context compacted`, tone: "info" };
        this.changed();
        return;
      }
      case "implement-plan": {
        const explicitId = argument.trim();
        const proposal = explicitId
          ? this.state.proposedPlans.get(explicitId)
          : [...this.state.timeline]
              .reverse()
              .find((entry) => {
                if (entry.type !== "proposed_plan") return false;
                return !this.state.proposedPlans.get(entry.id)?.implementationTurnId;
              })
              ?.id;
        const resolved =
          typeof proposal === "string"
            ? this.state.proposedPlans.get(proposal)
            : proposal;
        if (!resolved) {
          throw new Error(
            explicitId
              ? `Proposed plan not found: ${explicitId}`
              : "No unimplemented proposed plan found",
          );
        }
        if (resolved.implementationTurnId) {
          throw new Error(`Proposed plan already has an implementation turn: ${resolved.planId}`);
        }
        return this.submitMessage(
          `Implement the following proposed plan:\n\n${resolved.content}`,
          { sourceProposedPlanId: resolved.planId },
        );
      }
      case "board": {
        const mode = argument.trim().toLowerCase() || "open";
        if (mode !== "open" && mode !== "hide" && mode !== "auto") {
          throw new Error(`/board takes 'open', 'hide', or 'auto' (got: ${argument})`);
        }
        this.boardMode = mode === "hide" ? "hidden" : mode;
        this.status = null;
        this.changed();
        return;
      }
      case "plugins": {
        if (argument) throw new Error("/plugins takes no arguments");
        if (!this.navigation) throw new Error("Plugin manager is not available in this client");
        this.navigation.openPlugins();
        return;
      }
      case "reload-plugins": {
        if (argument) throw new Error("/reload-plugins takes no arguments");
        this.status = { text: "Reloading plugins…", tone: "info" };
        this.changed();
        const result = await this.plugins.reload();
        if (result.failures.length === 0) {
          this.status = {
            text: `Reloaded ${result.activated.length} plugin instance${result.activated.length === 1 ? "" : "s"}`,
            tone: "info",
          };
        } else {
          const failures = result.failures
            .map(({ pluginInstanceId, error }) =>
              `${pluginInstanceId}: ${error instanceof Error ? error.message : String(error)}`,
            )
            .join("; ");
          this.status = {
            text: `Reloaded ${result.activated.length}; ${result.failures.length} failed — ${failures}`,
            tone: "error",
          };
        }
        this.changed();
        return;
      }
      case "model": {
        const target = this.harnessTargetId;
        const models = await this.controller.listModels(target);
        if (!argument) {
          this.openPicker({
            title: `Select ${target} model`,
            options: models.map((m) => ({ name: m.label, description: m.description ?? m.id, value: m.id })),
            onSelect: async (value) => {
              const model = models.find((candidate) => candidate.id === value);
              if (model) await this.configureModel(target, model);
            },
          });
          return;
        }
        const normalized = argument.toLowerCase();
        const model = models.find(
          (candidate) => candidate.id.toLowerCase() === normalized || candidate.label.toLowerCase() === normalized,
        );
        if (!model) throw new Error(`Unknown ${target} model: ${argument}`);
        return this.configureModel(target, model);
      }
      case "effort": {
        const target = this.harnessTargetId;
        const efforts = await this.controller.listEfforts(target);
        if (!argument) {
          this.openPicker({
            title: `Select ${target} effort`,
            options: efforts.map((effort) => ({
              name: effort.label,
              description: effort.description ?? effort.id,
              value: effort.id,
            })),
            onSelect: async (value) => {
              const effort = efforts.find((candidate) => candidate.id === value);
              if (effort) await this.configureEffort(target, effort);
            },
          });
          return;
        }
        const normalized = argument.toLowerCase();
        const effort = efforts.find(
          (candidate) => candidate.id.toLowerCase() === normalized || candidate.label.toLowerCase() === normalized,
        );
        if (!effort) throw new Error(`Unknown ${target} effort: ${argument}`);
        return this.configureEffort(target, effort);
      }
      default:
        throw new Error(`Unknown command: /${name}`);
    }
  }

  cancel(): void {
    void this.controller.control({ kind: "interrupt" });
  }

  dismissSidecar(): void {
    this.boardMode = "hidden";
    this.changed();
  }

  /** 优雅退出：先关掉 agent 子进程再退（对应 /exit、双击 Ctrl+C、Ctrl+D） */
  async exit(): Promise<void> {
    this.status = { text: "Exiting…", tone: "info" };
    this.changed();
    await this.controller.close();
    await this.plugins.close();
    this.marketplace.close();
    this.unsubscribeSession();
    this.session.releaseLock();
    this.quit(this.session.id);
  }

  resolvePicker(id: string, value: string | null): void {
    const picker = this.picker;
    if (!picker || picker.id !== id) return;
    this.picker = null;
    this.changed();
    if (value === null) return;
    void (async () => {
      try {
        await picker.onSelect(value);
      } catch (error) {
        this.status = { text: error instanceof Error ? error.message : String(error), tone: "error" };
        this.changed();
      }
    })();
  }

  async resolveInteraction(id: string, response: InteractionResponse): Promise<void> {
    if (response.kind === "suggested_input") {
      const pending = this.plugins
        .listPendingProposals()
        .find((proposal) => proposal.proposalId === id);
      if (!pending) {
        this.status = { text: "plugin suggestion is no longer pending", tone: "info" };
        this.changed();
        return;
      }
      this.plugins.resolveProposal(id, response.outcome);
      this.changed();
      if (response.outcome === "submitted") await this.submit(response.text);
      return;
    }

    const interaction = this.state.interactions.get(id)?.interaction;
    let resolution: InteractionResolution | undefined;
    if (response.kind === "approval" && interaction?.kind === "permission") {
      resolution = { kind: "permission", outcome: "selected", optionId: response.optionId };
    } else if (response.kind === "approval" && interaction?.kind === "hook_trust") {
      resolution = {
        kind: "hook_trust",
        outcome: response.optionId === "trust" ? "trusted" : "skipped",
      };
    } else if (response.kind === "question" && interaction?.kind === "question") {
      resolution = { kind: "question", outcome: "answered", answers: response.answers };
    }
    if (!resolution || !this.controller.resolveInteraction(id, resolution)) {
      // 无 resolver：请求已被应答，或是崩溃残留（新进程没有等待中的 adapter）
      this.status = { text: "interaction request is no longer pending", tone: "info" };
      this.changed();
    }
  }

  recallQueued(): { text: string } | null {
    const recalled = this.controller.recallLatestQueued();
    if (!recalled) return null;
    // 召回队列是另一种取回动作，结束进行中的历史浏览，避免游标错位。
    this.resetHistoryNav();
    this.harnessTargetId = recalled.harnessTargetId;
    this.status = { text: `Recalled queued message for ${recalled.harnessTargetId}; edit and resend`, tone: "info" };
    this.changed();
    return { text: userVisibleText(textOf(recalled.blocks)) };
  }

  /**
   * ↑ 历史回溯（shell 式）。current 为输入框当前内容：首次进入浏览时暂存为草稿并跳到
   * 最新一条；连续浏览时若 current 已偏离上次召回的条目，说明用户改过 → 返回 null 让
   * TUI 放行为普通光标移动。已到最旧则停住（返回 null）。
   */
  historyPrev(current: string): { text: string } | null {
    if (this.history.length === 0) return null;
    if (this.historyCursor === null) {
      this.historyStash = current;
      this.historyCursor = this.history.length - 1;
    } else {
      if (this.lastHistoryText !== null && current !== this.lastHistoryText) return null;
      if (this.historyCursor === 0) return null;
      this.historyCursor -= 1;
    }
    const text = this.history[this.historyCursor]!;
    this.lastHistoryText = text;
    return { text };
  }

  /** ↓ 历史前进，与 historyPrev 对称；越过最新条目时恢复进入浏览前暂存的草稿并退出浏览。 */
  historyNext(current: string): { text: string } | null {
    if (this.historyCursor === null) return null;
    if (this.lastHistoryText !== null && current !== this.lastHistoryText) return null;
    if (this.historyCursor + 1 >= this.history.length) {
      const stash = this.historyStash ?? "";
      this.resetHistoryNav();
      return { text: stash };
    }
    this.historyCursor += 1;
    const text = this.history[this.historyCursor]!;
    this.lastHistoryText = text;
    return { text };
  }

  /** 追加一条输入历史（相邻去重、跳过空白）；提交与从事件流种入共用。 */
  private recordHistory(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.history[this.history.length - 1] === trimmed) return;
    this.history.push(trimmed);
  }

  private resetHistoryNav(): void {
    this.historyCursor = null;
    this.historyStash = null;
    this.lastHistoryText = null;
  }

  /** 从当前 state 的 user 消息重建输入历史（resume / 切换会话后重新种入 ↑ 回溯来源）。 */
  private seedHistoryFromState(): void {
    this.history = [];
    for (const entry of this.state.timeline) {
      if (entry.type !== "message") continue;
      const msg = this.state.messages.get(entry.id);
      if (!msg || msg.role !== "user") continue;
      this.recordHistory(userVisibleText(textOf(msg.content)));
    }
    this.resetHistoryNav();
  }

  /** @ 候选源，注入给 ChatShell */
  mentionCandidates = (prefix: string): Candidate[] =>
    sessionMentionCandidates(this.store.listSessions(), prefix, { excludeSessionId: this.session.id });

  // ===== 内部 =====

  private createController(): Controller {
    return new Controller({
      session: this.session,
      mentionBudgetChars: this.config.mentionBudgetChars,
      modelPreferences: this.modelPreferences,
      effortPreferences: this.effortPreferences,
      // 交互回调由 controller 提供（resolver 注册表）：protocol 不再持有交互状态
      createAdapter: (target, handlers) =>
        createHarnessAdapter(target, {
          ...handlers,
          config: this.config,
          rootDir: this.store.rootDir,
        }),
      resolveTarget: resolveDefaultHarnessTarget,
      probeTarget: (target, cwd) =>
        probeHarnessTarget(target, {
          cwd,
          config: this.config,
          diagnostic: (entry) =>
            this.session.diagnostic({ ...entry, harnessTargetId: target.id }),
        }),
      onChange: () => this.changed(),
    });
  }

  private createPluginManager(): Manager {
    const settings = new PluginSettingsStore(this.store.rootDir);
    return new Manager({
      session: this.session,
      proposals: new ProposalStore({ session: this.session }),
      instances: new GlobalPluginInstanceStore({
        settings,
        session: this.session,
      }),
      snapshot: () =>
        createBatonSnapshot({
          batonSessionId: this.session.id,
          cwd: this.session.meta.cwd,
          state: this.state,
          inputs: this.controller.inputs,
          harnessTargets: HARNESS_REGISTRY.map((definition) => ({
            id: definition.id,
            harness: definition.id,
            label: definition.label,
          })),
        }),
      loadPackage: (pluginId, version, options) => {
        if (!options?.marketplace) {
          throw new Error(`marketplace is required to load ${pluginId}`);
        }
        return this.marketplace.load(pluginId, options.marketplace, version, options);
      },
      onProposal: () => {
        this.changed();
      },
      onBoardChanged: () => {
        this.changed();
      },
      onActivationError: ({ pluginInstanceId, error }) => {
        this.status = {
          text: `Plugin ${pluginInstanceId} activation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          tone: "error",
        };
        this.changed();
      },
      onReconcileError: ({ key, error }) => {
        let resourceLabel = `${key.resourceKind}/${key.resourceId}`;
        // 为 baton.turn 提供更友好的展示信息
        if (key.resourceKind === "baton.turn") {
          try {
            const turnResource = this.plugins.getBuiltinResource(
              "baton.turn",
              key.resourceId,
            );
            const userText = turnResource.data.userText;
            if (userText) {
              // 截取前 30 个字符作为摘要，避免状态栏过长
              const summary =
                userText.length > 30 ? `${userText.slice(0, 30)}...` : userText;
              resourceLabel = `turn "${summary}"`;
            }
          } catch {
            // 如果获取失败，使用默认的 resourceId
          }
        }
        this.status = {
          text: `Plugin reconcile failed for ${resourceLabel}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          tone: "error",
        };
        this.changed();
      },
    });
  }

  private startPluginManager(): void {
    void this.plugins.start().catch((error) => {
      this.status = {
        text: `Could not start plugins: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      };
      this.changed();
    });
  }

  private syncTerminalTitle(): void {
    setTerminalTabTitle(sessionDisplayTitle(this.session.meta));
  }

  /**
   * open 以回调传入且在 busy 检查之后才执行：目标会话的锁在 openBatonSession 里
   * 获取，若先锁后检查，busy 抛错会把已锁的目标泄漏给当前进程。
   */
  private async switchSession(
    open: () => { session: SessionHandle; recovered?: boolean },
  ): Promise<void> {
    if (this.controller.isBusy || this.controller.queueLength > 0) {
      throw new Error("Wait for the current turn to finish before switching BatonSession");
    }
    const next = open();
    await this.controller.close();
    await this.plugins.close();
    this.unsubscribeSession();
    this.session.releaseLock();
    this.session = next.session;
    this.syncTerminalTitle();
    this.commandOutput = null;
    this.controller = this.createController();
    this.state = next.session.loadState();
    this.seedHistoryFromState();
    this.unsubscribeSession = this.subscribeSession(next.session);
    this.status = next.recovered
      ? { text: `Opened session ${next.session.id} (recovered an interrupted turn)`, tone: "info" }
      : { text: `Opened session ${next.session.id}`, tone: "info" };
    this.plugins = this.createPluginManager();
    this.startPluginManager();
    this.changed();
  }

  private async configureModel(target: string, model: { id: string; label: string }): Promise<void> {
    await this.controller.setModel(target, model.id);
    saveModelPreference(this.store.rootDir, target, model.id);
    if (model.id === "default") delete this.modelPreferences[target];
    else this.modelPreferences[target] = model.id;
    this.status = { text: `${target} model: ${model.label} (takes effect next turn)`, tone: "info" };
    this.changed();
  }

  private async configureEffort(target: string, effort: { id: string; label: string }): Promise<void> {
    await this.controller.setEffort(target, effort.id);
    saveEffortPreference(this.store.rootDir, target, effort.id);
    if (effort.id === "default") delete this.effortPreferences[target];
    else this.effortPreferences[target] = effort.id;
    this.status = { text: `${target} effort: ${effort.label} (takes effect next turn)`, tone: "info" };
    this.changed();
  }

  /** 控制命令输出只进入当前 view，不写 session.jsonl，避免污染可恢复的会话历史。 */
  private sessionStatusItem(): TranscriptItem {
    const meta = this.session.meta;
    const activeTargetId = this.controller.activeHarnessTargetId;
    const selectedModel = this.controller.currentModel(this.harnessTargetId) ?? "default";
    const selectedEffort = this.controller.currentEffort(this.harnessTargetId) ?? "default";
    const context = this.state.perTarget.get(this.harnessTargetId)?.contextUsage;
    const contextText = contextUsageText(context, selectedModel);
    const targets = meta.harnessSessions
      ? Object.keys(meta.harnessSessions).join(", ")
      : "-";
    const text = [
      `Session: ${meta.batonSessionId}`,
      `Name: ${sessionDisplayTitle(meta)}`,
      ...(meta.description ? [`Description: ${meta.description}`] : []),
      `Directory: ${meta.cwd}`,
      `Current: ${this.harnessTargetId} - model ${selectedModel} - effort ${selectedEffort}`,
      `Context: ${contextText}`,
      `Targets: ${targets}`,
      `Turns: ${this.state.turnSummaries.length} - tokens in ${this.state.usage.inputTokens} / out ${this.state.usage.outputTokens}`,
      `State: ${activeTargetId ? `running (${activeTargetId})` : "idle"} - queue ${this.controller.queueLength}`,
    ].join("\n");
    return this.batonTranscriptItem("_baton_status", text);
  }

  /** baton 自身也是 transcript author；这类 UI 反馈不写入 harness 会话历史。 */
  private batonTranscriptItem(id: string, text: string): TranscriptItem {
    return { type: "message", id, role: "agent", author: "baton", text, format: "plain" };
  }

  /** /sessions 会话内切换浮层；行投影与启动 session picker 共用 sessionPickerOptions */
  private openSessionsPicker(mode: SessionPickerMode = "list"): void {
    this.openPicker({
      title: `Select BatonSession${mode === "tree" ? " (tree)" : ""}`,
      options: sessionPickerOptions(this.store.listSessions({ cwd: this.session.meta.cwd }), {
        currentSessionId: this.session.id,
        mode,
      }),
      onSelect: async (value) => {
        if (value === this.session.id) return;
        await this.switchSession(() =>
          openBatonSession(this.store, { cwd: this.session.meta.cwd, sessionId: value }),
        );
      },
    });
  }

  private openPicker(picker: Omit<PendingPicker, "id">): void {
    this.picker = { ...picker, id: `pk_${this.nextOverlayId++}` };
    this.changed();
  }

  /** 高频流式事件按 renderer 帧合并；state 已同步 reduce，这里只延迟昂贵的完整 view 投影。 */
  private scheduleStreamViewChanged(): void {
    if (this.streamViewTimer !== undefined) return;
    this.streamViewTimer = setTimeout(() => {
      this.streamViewTimer = undefined;
      this.changed();
    }, STREAM_VIEW_FRAME_MS);
  }

  /** 快照式更新：每次变更整体替换 view 再通知（getView 引用稳定性要求） */
  private changed(): void {
    if (this.streamViewTimer !== undefined) {
      clearTimeout(this.streamViewTimer);
      this.streamViewTimer = undefined;
    }
    this.view = this.buildView();
    for (const listener of this.listeners) listener();
  }

  private buildView(): ChatViewState {
    const v = this.state;
    const activeTargetId = this.controller.activeHarnessTargetId;
    const boardItems = this.plugins.listBoardItems();
    const boardSections = new Map<
      string,
      {
        id: string;
        title: string;
        items: Array<{
          id: string;
          title: string;
          status?: string;
          detail?: string;
          tone?: "default" | "muted" | "success" | "warning" | "error";
        }>;
      }
    >();
    for (const item of boardItems) {
      let section = boardSections.get(item.pluginInstanceId);
      if (!section) {
        section = {
          id: item.pluginInstanceId,
          title: item.pluginId,
          items: [],
        };
        boardSections.set(item.pluginInstanceId, section);
      }
      section.items.push({
        id: item.id,
        title: item.title,
        ...(item.status === undefined ? {} : { status: item.status }),
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        ...(item.tone === undefined ? {} : { tone: item.tone }),
      });
    }
    // Baton Interaction 保持阻塞生命周期；Plugin Proposal 只在 UI 投影层加入同一 Dock，
    // 不伪造 interaction.opened/resolved。阻塞项在前，避免建议遮住 harness 等待。
    const interactions: InteractionView[] = [
      ...[...v.interactions.values()]
        .filter((item) => !item.resolution)
        .map((item) => interactionView(item.interaction)),
      ...this.plugins.listPendingProposals().map((proposal) => ({
        id: proposal.proposalId,
        kind: "suggested_input" as const,
        blocking: false,
        requester: proposal.key.pluginInstanceId,
        title: "Suggested follow-up",
        text: proposal.text,
      })),
    ];
    const observedRuns = [...v.activeTurns.values()].filter((turn) => turn.role === "observed");
    const observedRun = observedRuns.at(-1);
    // baton 当前只呈现一个 Target 的状态：driven turn 优先，其次是 Harness 自发的
    // background turn，完全空闲时才回落到当前输入目标。状态本体与附加信息可拆成两行，
    // 但仍是同一个 Target；多运行者并发尚未进入产品范围。
    const activeTurnId = this.controller.activeTurnId;
    const activeTurn = activeTurnId ? v.activeTurns.get(activeTurnId) : undefined;
    const statusTargetId =
      activeTargetId ??
      observedRun?.harnessTargetId ??
      this.harnessTargetId;
    const targetState = v.perTarget.get(statusTargetId);
    const statusHarness =
      activeTurn?.harness ??
      observedRun?.harness ??
      targetState?.harness ??
      harnessDefinitionFor(statusTargetId)?.sessionKey ??
      statusTargetId;
    // observed turn 可能来自恢复的事件流，当前 Controller 并未创建该 Target 的 binding；
    // 此时只消费事件已报告的 model，不为展示反向启动或解析 Harness。
    const statusModel =
      statusTargetId === activeTargetId || statusTargetId === this.harnessTargetId
        ? (this.controller.currentModel(statusTargetId) ?? "default")
        : (targetState?.contextUsage?.model ?? "default");
    const statusEffort =
      statusTargetId === activeTargetId || statusTargetId === this.harnessTargetId
        ? this.controller.currentEffort(statusTargetId)
        : this.session.meta.harnessSessions[statusTargetId]?.effort;
    // default effort 的实际值由 harness/model 决定；拿不到权威值时省略，不把
    // "default" 冒充成当前正在使用的 low/medium/high。
    const modelAndEffort = statusEffort ? `${statusModel} · ${statusEffort}` : statusModel;
    const contextStatus = contextUsageStatusText(targetState?.contextUsage, statusModel);
    // 审批路由问 adapter 要（harness 自己报的生效值），不读 config——config 是意图，
    // 且投影层不得按 harness 分支（不变量 #3）。曾经这里硬编码 codexApprovalReviewer，
    // 于是跟 claude 对话时 footer 照样显示 codex 的委托状态。
    const approvalStatus =
      this.controller.approvalRoute(statusTargetId) === "delegated"
        ? "approvals:auto-review"
        : undefined;
    const statusDetails = [contextStatus, approvalStatus].filter((detail): detail is string => detail !== undefined);
    const splitStatus = (item: RunStatusItem): RunStatusItem[] => {
      if (statusDetails.length === 0) return [item];
      const { startedAt, hint, ...primary } = item;
      return [
        primary,
        {
          id: `${item.id}:details`,
          label: statusDetails.join(" · "),
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(hint ? { hint } : {}),
        },
      ];
    };
    const runStatus: RunStatusItem[] = activeTargetId
      ? splitStatus({
          id: `run:${activeTargetId}`,
          author: harnessAuthor(statusHarness),
          label: `${modelAndEffort} · ${runStatusLabel(v, activeTurnId)}`,
          startedAt: this.controller.activeStartedAt,
          hint: "Esc to interrupt",
        })
      : observedRun
        ? splitStatus({
            id: `run:observed:${observedRun.turnId}`,
            author: harnessAuthor(statusHarness),
            label: `${modelAndEffort} · ${runStatusLabel(v, observedRun.turnId)} · background`,
            startedAt: observedRun.startedAt,
          })
        : splitStatus({
            id: `agent:${this.harnessTargetId}`,
            author: harnessAuthor(
              v.perTarget.get(this.harnessTargetId)?.harness ??
                harnessDefinitionFor(this.harnessTargetId)?.sessionKey ??
                this.harnessTargetId,
            ),
            label: `${modelAndEffort} · idle`,
          });
    const busy = activeTargetId !== undefined || observedRuns.length > 0;
    // plan 互补显示（design §5.9）：同一时刻只出现在一个地方——进行中归 pin（现在时），
    // 盖棺归 transcript（过去时）。pin 显示期间 transcript 不渲染该 plan 卡（避免同屏两份、
    // 且过去时区域不该有实时改写的块）；全部完成 pin 停发，终态卡在 timeline 原位出现供回看。
    // pin 绑定当前输入 Target：切换 Target 即表示放弃上一家的现在时，
    // 上一家未完成的 plan 回到 transcript；切回且该 Target 仍在运行时可恢复 pin。
    // 同时以同 Target 的运行态门控：idle 后未完成的 plan 也归 transcript，
    // 避免别的 Target 回合让已搁置的 plan 重新上 pin。
    const lastPlanId = v.perTarget.get(this.harnessTargetId)?.lastPlanId;
    const lastPlan = lastPlanId ? v.plans.get(lastPlanId) : undefined;
    const planEntries = (lastPlan?.entries ?? []).map((entry) => ({
      content: entry.content,
      status: normalizePlanStatus(entry.status),
    }));
    const targetRunning = [...v.activeTurns.values()].some(
      (turn) => turn.harnessTargetId === this.harnessTargetId,
    );
    const planActive = targetRunning && planEntries.some((entry) => entry.status !== "completed");
    const pinnedPlanId = planActive ? lastPlan?.planId : undefined;
    return {
      transcript: [...buildTranscript(v, pinnedPlanId), ...(this.commandOutput ? [this.commandOutput] : [])],
      busy,
      runStatus,
      plan: planActive ? planEntries : undefined,
      queued: this.controller.queuedTurns.map((turn) => ({
        id: String(turn.id),
        text: userVisibleText(textOf(turn.blocks)),
        tag: turn.harnessTargetId,
      })),
      picker: this.picker
        ? { id: this.picker.id, title: this.picker.title, options: this.picker.options }
        : null,
      interactions,
      sidecar:
        boardItems.length > 0
          ? {
              title: "Board",
              mode: this.boardMode,
              sections: [...boardSections.values()],
            }
          : undefined,
      status: this.status,
      footer: `session: ${this.session.id}  in:${v.usage.inputTokens} out:${v.usage.outputTokens}  turns:${v.turnSummaries.length}  queue:${this.controller.queueLength}${planActive ? `  plan:${planEntries.filter((entry) => entry.status === "completed").length}/${planEntries.length}` : ""}${boardItems.length > 0 ? `  board:${boardItems.length}` : ""}  cwd:${this.session.meta.cwd}`,
      // ↑ 召回提示只在"可召回"时出现：交互发生地是 composer（placeholder 天然只在空输入时可见）
      // busy 时由 Adapter 决定 same-turn send 或由 Controller 保序排队。
      composerPlaceholder: `Message ${this.harnessTargetId} (/ commands, @ mentions, ${
        this.controller.queueLength > 0
          ? "↑ recall queued"
          : this.controller.isBusy
            ? "Enter sends or queues"
            : "Ctrl+J newline"
      })`,
      header: `baton · session ${this.session.id}\ntype to chat · /codex or /claude switch · /sessions open · @bs_xxx reference another session\n`,
      showThoughts: this.config.showThoughts,
    };
  }
}

// baton 的状态类型是开放联合（容忍未知 wire 值），chat-tui 是闭集；
// 未知值回落到与旧 TUI 相同的展示形态（工具 ⋯ / 计划 ☐）。
const TOOL_STATUSES = new Set(["pending", "in_progress", "completed", "failed", "declined"]);
const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);

function normalizeToolStatus(status: string): "pending" | "in_progress" | "completed" | "failed" | "declined" {
  return (TOOL_STATUSES.has(status) ? status : "in_progress") as ReturnType<typeof normalizeToolStatus>;
}

function normalizePlanStatus(status: string): "pending" | "in_progress" | "completed" {
  return (PLAN_STATUSES.has(status) ? status : "pending") as ReturnType<typeof normalizePlanStatus>;
}

function commandOf(tc: ToolCallState, fallback: string): string {
  const input = tc.rawInput as Record<string, unknown> | undefined;
  return typeof input?.command === "string" ? input.command : fallback;
}

const DIFF_OPS = new Set<DiffOp>(["add", "modify", "delete", "move"]);

/** 事件模型的开放 operation → chat-tui 的闭合 DiffOp；未知操作按 modify 处理（最保守的展示待遇） */
function diffOpOf(operation: string): DiffOp {
  if (operation === "update") return "modify";
  if (operation === "rename") return "move";
  return DIFF_OPS.has(operation as DiffOp) ? (operation as DiffOp) : "modify";
}

/** 命令卡标题的时态即事实：declined 的命令没有跑过，不能写 Ran */
function executeTitleOf(status: ReturnType<typeof normalizeToolStatus>): string {
  if (status === "in_progress") return "Running";
  if (status === "declined") return "Declined";
  return "Ran";
}

/** 工具状态 → chat-tui 展示块；命令源码和 diff 保持结构化，避免组件层猜字符串。 */
export function toolTranscriptItem(tc: ToolCallState): Extract<TranscriptItem, { type: "block" }> {
  const status = normalizeToolStatus(tc.status);
  const rawTitle = tc.title ?? tc.toolCallId;
  const content: TranscriptBlockContent[] = [];

  if (tc.kind === "execute") {
    // language 不写死：chat-tui 对 command 缺省按 shell 高亮
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
        // DiffBlock 契约：patch 归 changes[0]（adapter 按单文件发块）
        patch: index === 0 ? diff.patch : undefined,
      });
    }
  }

  // 输出传全量行不预截断；output 类型的展示待遇（弱化色、全量渲染）归 chat-tui
  const outputLines = textOf(tc.content).split("\n").filter(Boolean);
  if (outputLines.length > 0) content.push({ type: "output", lines: outputLines });

  return {
    type: "block",
    id: tc.toolCallId,
    kind: "tool",
    author: harnessAuthor(tc.harness),
    title: tc.kind === "execute" ? executeTitleOf(status) : rawTitle,
    status,
    content: content.length > 0 ? content : undefined,
  };
}

/**
 * auto-review 决策 → chat-tui 展示双轴（kernel.md §6 展示轴）。decision 已在 adapter 边界收口为
 * 闭合三态（§2 不变量 #2），所以这里是对**闭集的穷尽查表**而非条件链——新增 decision 成员时
 * TS 直接报表不完整，比三元链更难漏：
 * - outcome（status）= 本次 review 的结局：approved 审到底了 / denied 被拒 / aborted 未决异常；
 * - tone = 是否需留痕：仅 approved 带 warning——委托代批**放行**的操作要留审计痕。
 * 双轴的意义正在这条：approved 不再被遮成一个 warning 而丢掉"它审完了"，✓ 与警示色各说各的。
 */
const REVIEW_DISPLAY: Record<
  ApprovalReviewUpdate["decision"],
  { status: TranscriptBlockStatus; tone?: BlockTone }
> = {
  approved: { status: "completed", tone: "warning" },
  denied: { status: "declined" },
  aborted: { status: "failed" },
};

function approvalReviewTranscriptItem(review: ApprovalReviewUpdate): TranscriptItem {
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
 * SessionState → chat-tui 展示形状。harness 内容在这里收敛为通用 command/output/diff/lines，块语义不出 baton。
 * pinnedPlanId：正被 pin 区承载的 plan——按互补显示规则跳过其 transcript 卡（见 buildView 处注释）。
 */
function buildTranscript(state: SessionState, pinnedPlanId?: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const noticesById = new Map(state.notices.map((notice) => [`n_${notice.seq}`, notice]));
  for (const entry of state.timeline) {
    if (entry.type === "notice") {
      const notice = noticesById.get(entry.id);
      if (!notice) continue;
      // warning/error 用 failed（红色 ✗）：打断标记等要像 Codex 一样醒目；info 用 pending（低调 ○）
      items.push({
        type: "block",
        id: entry.id,
        kind: "notice",
        status: notice.level === "info" ? "pending" : "failed",
        title: notice.detail ? `${notice.title} · ${notice.detail}` : notice.title,
      });
      continue;
    }
    if (entry.type === "error") {
      const error = state.errors.get(entry.id);
      if (!error) continue;
      // 错误用 failed 状态（红色 ✗）醒目展示
      items.push({
        type: "block",
        id: entry.id,
        kind: "error",
        status: "failed",
        title: error.code ? `Error: ${error.code}` : "Error",
        content: { type: "text", text: error.message },
      });
      continue;
    }
    if (entry.type === "message") {
      const msg = state.messages.get(entry.id);
      if (!msg) continue;
      if (msg.role === "thought") {
        const turnCompleted = state.turnSummaries.some((summary) => summary.turnId === msg.turnId);
        const status =
          msg.streamStatus === "completed" || turnCompleted || !isTurnRunning(state, msg.turnId)
            ? "completed"
            : "in_progress";
        for (const [index, block] of thoughtDisplayBlocks(textOf(msg.content)).entries()) {
          items.push({
            type: "block",
            id: `${entry.id}:${index}`,
            kind: "thought",
            status,
            author: harnessAuthor(msg.harness),
            title: block.title,
            content: block.content ? { type: "text", text: block.content } : undefined,
          });
        }
        continue;
      }
      const author = msg.role === "user" ? "you" : (harnessAuthor(msg.harness) ?? "agent");
      items.push({
        type: "message",
        id: entry.id,
        role: msg.role === "user" ? "user" : "agent",
        author,
        text: msg.role === "user" ? userVisibleText(textOf(msg.content)) : textOf(msg.content),
        ...(msg.role === "agent"
          ? {
              format: "markdown" as const,
              // 流式指示按消息所属 turn 判：并发 turn 下别人收口不打断自己的流
              streaming: msg.streamStatus === "in_progress" && isTurnRunning(state, msg.turnId),
            }
          : { format: "plain" as const }),
      });
      continue;
    }
    if (entry.type === "tool_call") {
      const tc = state.toolCalls.get(entry.id);
      if (!tc) continue;
      items.push(toolTranscriptItem(tc));
      continue;
    }
    if (entry.type === "approval_review") {
      // 回执是 timeline 一等公民（自带位置），不再作为工具卡的附属查找。
      const review = state.approvalReviews.get(entry.id);
      if (review) items.push(approvalReviewTranscriptItem(review));
      continue;
    }
    if (entry.type === "proposed_plan") {
      const proposal = state.proposedPlans.get(entry.id);
      if (!proposal) continue;
      items.push({
        type: "block",
        id: entry.id,
        kind: "proposed_plan",
        status: "completed",
        author: harnessAuthor(proposal.harness),
        title: proposal.implementationTurnId
          ? `Proposed plan · implementation started`
          : "Proposed plan",
        content: { type: "text", text: proposal.content },
      });
      continue;
    }
    if (entry.type === "task") {
      const task = state.tasks.get(entry.id);
      if (!task) continue;
      const status =
        task.status === "stopped"
          ? "failed"
          : task.status;
      const details = [
        task.summary,
        task.lastToolName ? `Last tool: ${task.lastToolName}` : undefined,
      ].filter((value): value is string => Boolean(value));
      items.push({
        type: "block",
        id: entry.id,
        kind: "task",
        status,
        author: harnessAuthor(task.harness),
        title: task.title ?? task.taskType ?? "Background task",
        ...(details.length ? { content: { type: "lines", lines: details } } : {}),
      });
      continue;
    }
    if (entry.type !== "plan") continue;
    const plan = state.plans.get(entry.id);
    if (!plan) continue;
    if (plan.planId === pinnedPlanId) continue; // 进行中归 pin，transcript 只在盖棺后展示终态卡
    const entries = plan.entries.map((e) => ({ content: e.content, status: normalizePlanStatus(e.status) }));
    const status =
      entries.length > 0 && entries.every((entry) => entry.status === "completed")
        ? "completed"
        : entries.some((entry) => entry.status === "in_progress" || entry.status === "completed")
          ? "in_progress"
          : "pending";
    items.push({
      type: "block",
      id: entry.id,
      kind: "plan",
      title: "Plan",
      status,
      content: { type: "plan", entries },
    });
  }
  return items;
}
