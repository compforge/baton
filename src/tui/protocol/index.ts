// baton 对 chat-tui 的接入层：实现 ChatProtocol，把 Controller / SessionStore
// 的状态整理成 chat-tui State，把 TUI intents 翻译成 controller 操作。
// UI 语义（补全、分层 Ctrl+C、Interaction Dock）都在 chat-tui；这里只有 baton 的业务编排。

import type {
  ChatProtocol,
  ChatState,
  WritableChatStore,
  Candidate,
  CommandSpec,
  InteractionResponse,
  PickerSearchView,
  TranscriptItem,
} from "chat-tui";
import { createChatStore } from "chat-tui";

import {
  COMMANDS,
  parseHarness,
  parseHarnessRoute,
  type CommandName,
} from "../../commands/registry.ts";
import type { BatonConfig } from "../../config/config.ts";
import { loadEffortPreferences, saveEffortPreference } from "../../config/effort-preferences.ts";
import { loadModelPreferences, saveModelPreference } from "../../config/model-preferences.ts";
import {
  expandMentions,
  parseMentions,
  sessionContextProvider,
} from "../../context/mention.ts";
import { ContextProviderRegistry } from "../../context/registry.ts";
import { logError } from "../../logging.ts";
import {
  textOf,
  type EventKind,
  type PromptBlock,
} from "../../event/types.ts";
import {
  createHarnessAdapter,
  HARNESS_REGISTRY,
  resolveDefaultHarnessTarget,
  probeHarnessTarget,
} from "../../harness/registry.ts";
import { bundledTextgenTargets } from "../../session/title.ts";
import type { InteractionResolution } from "../../interaction/types.ts";
import { createBatonSnapshot } from "../../plugin/baton-snapshot.ts";
import { Manager } from "../../plugin/manager.ts";
import { BATON_TURN_RESOURCE_KIND } from "../../plugin/builtin.ts";
import type {
  PluginCommandInput,
  PluginCommandResult,
  ToastMessage,
} from "../../plugin/package.ts";
import { MarketplaceRegistry } from "../../plugin/marketplace/index.ts";
import {
  GlobalPluginInstanceStore,
  PluginSettingsStore,
} from "../../plugin/settings.ts";
import { ProposalStore } from "../../plugin/proposal.ts";
import { PluginSupervisor } from "../../plugin/runner/index.ts";
import { openBatonSession } from "../../session/open.ts";
import { Controller } from "../../controller/index.ts";
import { applyEvent, type SessionState } from "../../store/reduce.ts";
import { sessionDisplayTitle, type SessionHandle, type SessionStore } from "../../store/store.ts";
import { sessionPickerOptions, type SessionPickerMode } from "../session-picker.tsx";
import { setTerminalTabTitle } from "../terminal-title.ts";
import { userVisibleText } from "./transcript.ts";
import {
  contextUsageText,
  projectBoardView,
  projectChatState,
  type BoardMode,
  type BoardViewProjection,
} from "./state.ts";

export {
  thoughtDisplayBlocks,
  toolTranscriptItem,
  userVisibleText,
} from "./transcript.ts";
export { runStatusLabel } from "./state.ts";

// transcript 重排与终端整帧写入比 composer 的局部绘制重；若也按 renderer 的 30 FPS 持续
// 发布，终端背压会让已进入 textarea buffer 的按键延迟显示。流式输出限制为 10 FPS，给输入
// 绘制留出帧间空隙；Interaction、终态和完整快照仍立即发布，并冲刷此前积累的 chunk。
const STREAM_STATE_FRAME_MS = 100;
const PICKER_SEARCH_DEBOUNCE_MS = 250;
const COALESCED_STREAM_EVENT_KINDS: ReadonlySet<EventKind> = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call_content_chunk",
  "usage_update",
]);

function publishChatState(
  store: WritableChatStore,
  next: ChatState,
): void {
  const timeline = store.getState("timeline");
  const composer = store.getState("composer");
  const activity = store.getState("activity");
  const footer = store.getState("footer");
  store.commit({
    ...(timeline.items === next.timeline.items &&
    timeline.plan === next.timeline.plan &&
    timeline.header === next.timeline.header &&
    timeline.showThoughts === next.timeline.showThoughts
      ? {}
      : { timeline: next.timeline }),
    ...(composer.busy === next.composer.busy &&
    composer.queued === next.composer.queued &&
    composer.picker === next.composer.picker &&
    composer.interactions === next.composer.interactions &&
    composer.placeholder === next.composer.placeholder
      ? {}
      : { composer: next.composer }),
    ...(activity.items === next.activity.items
      ? {}
      : { activity: next.activity }),
    ...(footer.toast === next.footer.toast && footer.text === next.footer.text
      ? {}
      : { footer: next.footer }),
    ...(store.getState("sidecar") === next.sidecar
      ? {}
      : { sidecar: next.sidecar }),
  });
}

export interface BatonNavigation {
  openPlugins(): void;
}

interface PendingPicker {
  id: string;
  title: string;
  options: Array<{ name: string; description: string; value: string }>;
  search?: PickerSearchView;
  onSearch?: (query: string) => Promise<{
    title: string;
    options: Array<{ name: string; description: string; value: string }>;
    search: PickerSearchView;
  }>;
  onSelect: (value: string) => void | Promise<void>;
}

export class BatonChatProtocol implements ChatProtocol {
  readonly marketplace: MarketplaceRegistry;
  readonly stateStore: WritableChatStore;
  private session: SessionHandle;
  private state: SessionState;
  private controller: Controller;
  private plugins: Manager;
  /** 当前输入与控制命令的具体配置目标；默认 Target ID 与 Harness ID 相同。 */
  private harnessTargetId: string;
  private toast: ToastMessage | null = null;
  private commandOutput: TranscriptItem | null = null;
  private picker: PendingPicker | null = null;
  private pickerSearchTimer: ReturnType<typeof setTimeout> | undefined;
  private pickerSearchRevision = 0;
  private boardMode: BoardMode = "auto";
  private boardViewCache: BoardViewProjection | undefined;
  private nextPickerId = 1;
  private completionListeners = new Set<() => void>();
  private mentionCandidateQuery: string | undefined;
  private mentionCandidateCache: Candidate[] = [];
  private mentionCandidateRevision = 0;
  private unsubscribeSession: () => void;
  private streamStateTimer: ReturnType<typeof setTimeout> | undefined;
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
      this.toast = { text: "Recovered an interrupted turn from a previous baton run", tone: "info" };
    }
    this.controller = this.createController();
    // 投影单通道：live 与 resume 走同一条 reduce 路径（loadState 补历史 + subscribe 跟增量），
    // 不从 per-turn 回调取事件——harness 自发回合（observed turn）没有对应的 submit 调用。
    this.state = this.session.loadState();
    this.seedHistoryFromState();
    this.unsubscribeSession = this.subscribeSession(this.session);
    this.plugins = this.createPluginManager();
    this.stateStore = createChatStore(this.buildState());
    this.startPluginManager();
  }

  /** 接入事件流增量投影；调用前 state 必须已 loadState 到当前水位 */
  private subscribeSession(session: SessionHandle): () => void {
    return session.subscribe((envelope) => {
      applyEvent(this.state, envelope);
      if (COALESCED_STREAM_EVENT_KINDS.has(envelope.kind)) this.scheduleStreamStateChanged();
      else this.changed();
    });
  }

  // ===== 输出：baton → TUI =====

  get commands(): readonly CommandSpec[] {
    return [...COMMANDS, ...this.plugins.listCommands()];
  }

  get pluginManager(): Manager {
    return this.plugins;
  }

  subscribeCompletions(onChange: () => void): () => void {
    this.completionListeners.add(onChange);
    return () => this.completionListeners.delete(onChange);
  }

  // ===== 输入：TUI → baton =====

  async submit(text: string): Promise<void> {
    const route = parseHarnessRoute(text);
    if (route?.kind === "ambiguous") {
      this.toast = null;
      this.commandOutput = this.batonTranscriptItem(
        "_baton_harness_route_error",
        `Error: harness prefix "/${route.token}" is ambiguous; matches ${route.harnesses.join(", ")}. Use a longer harness name or alias.`,
      );
      this.changed();
      return;
    }
    if (route?.kind === "matched") {
      this.harnessTargetId = route.harness;
      this.toast = null;
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
    this.toast = null;
    this.commandOutput = null;
    const previousTitle = sessionDisplayTitle(this.session.meta);
    if (this.session.meta.forkedFrom) this.session.setTitleIfEmpty(text);
    else this.session.setPreviewIfEmpty(text);
    if (sessionDisplayTitle(this.session.meta) !== previousTitle) this.syncTerminalTitle();
    const legacyReferences = parseMentions(text);
    const hasProvidedContext = this.plugins.hasContextReference(text);
    const contextBudget = legacyReferences.length > 0 && hasProvidedContext
      ? Math.max(1, Math.floor(this.config.mentionBudgetChars / 2))
      : this.config.mentionBudgetChars;
    const legacy = expandMentions(
      this.store,
      text,
      contextBudget,
    );
    const provided = await this.plugins.provideContext(
      text,
      contextBudget,
    );
    const prompt = provided.length === 0
      ? legacy.prompt
      : [
        "<baton-context>",
        "Context explicitly referenced by the user:",
        ...provided,
        "</baton-context>",
        "",
        legacy.prompt,
      ].join("\n\n");
    const blocks: PromptBlock[] = [{ type: "text", text: prompt }];

    // 所有 prompt 都走统一 sendTurn；Adapter 依据原生运行态决定 new turn / steer / reject，
    // Controller 只在 reject 或已有队列时维持 follow-up 顺序。
    const sent = await this.controller.sendTurn(target, blocks, options);
    if (sent.effective === "steer") {
      this.toast = { text: `steering ${target} — applies at the next safe point`, tone: "info" };
      this.changed();
      return;
    }
    if (sent.reason) {
      this.toast = {
        text: `${target} same-turn send rejected (${sent.reason}); queued as follow-up`,
        tone: "info",
      };
    } else if (sent.queued) {
      this.toast = { text: `${target} turn queued`, tone: "info" };
    }
    this.changed();
    const outcome = await sent.outcome;
    if (outcome === "completed" && this.toast?.tone !== "error") {
      this.toast = null;
      this.changed();
    }
  }

  async command(name: string, argument: string): Promise<void> {
    if (name !== "status") this.commandOutput = null;
    const harness = parseHarness(name);
    if (harness) {
      this.harnessTargetId = harness;
      this.toast = null;
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
        this.toast = null;
        this.commandOutput = this.sessionStatusItem();
        this.changed();
        return;
      }
      case "compact": {
        if (argument) throw new Error("/compact takes no arguments");
        const target = this.harnessTargetId;
        this.toast = null;
        await this.controller.compactContext(target);
        this.toast = { text: `${target} context compacted`, tone: "info" };
        this.changed();
        return;
      }
      case "plan": {
        if (argument) throw new Error("/plan takes no arguments");
        return this.configureMode(this.harnessTargetId, "plan");
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
        const mode = argument.trim().toLowerCase() ||
          (this.boardMode === "open" ? "hide" : "open");
        if (mode !== "open" && mode !== "hide" && mode !== "auto") {
          throw new Error(`/board takes 'open', 'hide', or 'auto' (got: ${argument})`);
        }
        this.boardMode = mode === "hide" ? "hidden" : mode;
        this.toast =
          mode === "open" && this.plugins.listBoardItems().length === 0
            ? { text: "Board has no items", tone: "info" }
            : null;
        this.boardChanged();
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
        this.toast = { text: "Reloading plugins…", tone: "info" };
        this.changed();
        const result = await this.plugins.reload();
        if (result.failures.length === 0) {
          this.toast = {
            text: `Reloaded ${result.activated.length} plugin instance${result.activated.length === 1 ? "" : "s"}`,
            tone: "info",
          };
        } else {
          const failures = result.failures
            .map(({ pluginInstanceId, error }) =>
              `${pluginInstanceId}: ${error instanceof Error ? error.message : String(error)}`,
            )
            .join("; ");
          this.toast = {
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
      default: {
        if (!this.plugins.listCommands().some((candidate) => candidate.name === name)) {
          throw new Error(`Unknown command: /${name}`);
        }
        return this.runPluginCommand(name, argument);
      }
    }
  }

  async cycleMode(): Promise<void> {
    const target = this.harnessTargetId;
    const option = await this.modeOption(target);
    const currentIndex = option.options.findIndex(
      (candidate) => candidate.value === option.value,
    );
    const next = option.options[(currentIndex + 1) % option.options.length];
    if (!next) throw new Error(`${target} has no available modes`);
    await this.configureMode(target, next.value);
  }

  cancel(): void {
    void this.controller.control({ kind: "interrupt" });
  }

  dismissSidecar(): void {
    this.boardMode = "hidden";
    this.boardChanged();
  }

  /** 优雅退出：先关掉 agent 子进程再退（对应 /exit、双击 Ctrl+C、Ctrl+D） */
  async exit(): Promise<void> {
    this.cancelPickerSearch();
    this.toast = { text: "Exiting…", tone: "info" };
    this.changed();
    await this.controller.close();
    await this.plugins.close();
    this.marketplace.close();
    this.unsubscribeSession();
    this.session.log({
      level: "info",
      source: "baton",
      component: "session.lifecycle",
      message: "Session closed",
    });
    await this.session.closeLogs();
    this.session.releaseLock();
    this.quit(this.session.id);
  }

  resolvePicker(id: string, value: string | null): void {
    const picker = this.picker;
    if (!picker || picker.id !== id) return;
    this.cancelPickerSearch();
    this.picker = null;
    this.changed();
    if (value === null) return;
    void (async () => {
      try {
        await picker.onSelect(value);
      } catch (error) {
        this.toast = { text: error instanceof Error ? error.message : String(error), tone: "error" };
        this.changed();
      }
    })();
  }

  searchPicker(id: string, query: string): void {
    const picker = this.picker;
    if (
      !picker ||
      picker.id !== id ||
      picker.search?.mode !== "remote" ||
      !picker.onSearch
    ) {
      return;
    }
    if (picker.search.query === query && !picker.search.loading) return;

    this.cancelPickerSearch();
    const revision = this.pickerSearchRevision;
    const search = picker.onSearch;
    this.picker = {
      ...picker,
      options: [],
      search: {
        ...picker.search,
        query,
        loading: true,
      },
    };
    this.changed();
    this.pickerSearchTimer = setTimeout(() => {
      this.pickerSearchTimer = undefined;
      void (async () => {
        try {
          const result = await search(query);
          if (
            this.pickerSearchRevision !== revision ||
            this.picker?.id !== id
          ) {
            return;
          }
          this.picker = {
            ...this.picker,
            title: result.title,
            options: result.options,
            search: {
              ...result.search,
              query: result.search.query ?? query,
              loading: false,
            },
          };
          this.changed();
        } catch (error) {
          if (
            this.pickerSearchRevision !== revision ||
            this.picker?.id !== id
          ) {
            return;
          }
          const currentSearch = this.picker.search;
          if (!currentSearch) return;
          this.picker = {
            ...this.picker,
            search: {
              ...currentSearch,
              query,
              loading: false,
            },
          };
          this.toast = {
            text: error instanceof Error ? error.message : String(error),
            tone: "error",
          };
          this.changed();
        }
      })();
    }, PICKER_SEARCH_DEBOUNCE_MS);
  }

  async resolveInteraction(
    id: string,
    response: InteractionResponse,
  ): Promise<void> {
    if (response.kind === "suggested_input") {
      const pending = this.plugins
        .listPendingProposals()
        .find((proposal) => proposal.proposalId === id);
      if (!pending) {
        this.toast = { text: "plugin suggestion is no longer pending", tone: "info" };
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
    if (response.kind === "cancelled" && interaction) {
      resolution = { kind: "cancelled", reason: "user" };
    } else if (response.kind === "approval" && interaction?.kind === "permission") {
      resolution = { kind: "permission", outcome: "selected", optionId: response.optionId };
    } else if (response.kind === "approval" && interaction?.kind === "hook_trust") {
      resolution = {
        kind: "hook_trust",
        outcome: response.optionId === "trust" ? "trusted" : "skipped",
      };
    } else if (response.kind === "question" && interaction?.kind === "question") {
      const answers = Object.fromEntries(
        interaction.questions.map((question) => [
          question.questionId,
          (response.answers[question.questionId] ?? []).map((value) => {
            const option = question.options?.find(
              (candidate) =>
                candidate.optionId === value || candidate.label === value,
            );
            return option?.optionId ?? value;
          }),
        ]),
      );
      resolution = { kind: "question", outcome: "answered", answers };
    }
    const resolved =
      resolution &&
      (interaction?.requester.type === "plugin"
        ? await this.plugins.resolveInteraction(id, resolution)
        : this.controller.resolveInteraction(id, resolution));
    if (!resolved) {
      // 无 resolver：请求已被应答，或是崩溃残留（新进程没有等待中的 adapter）
      this.toast = { text: "interaction request is no longer pending", tone: "info" };
      this.changed();
    } else if (
      response.kind === "cancelled" &&
      interaction?.requester.type === "harness"
    ) {
      await this.controller.control({ kind: "interrupt" });
    }
  }

  recallQueued(): { text: string } | null {
    const recalled = this.controller.recallLatestQueued();
    if (!recalled) return null;
    // 召回队列是另一种取回动作，结束进行中的历史浏览，避免游标错位。
    this.resetHistoryNav();
    this.harnessTargetId = recalled.harnessTargetId;
    this.toast = { text: `Recalled queued message for ${recalled.harnessTargetId}; edit and resend`, tone: "info" };
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

  /**
   * chat-tui reads candidates synchronously during render. A new prefix starts
   * an asynchronous lookup and returns an empty snapshot; only the newest
   * lookup may publish and schedule another render.
   */
  mentionCandidates = (prefix: string): Candidate[] => {
    if (prefix === this.mentionCandidateQuery) {
      return this.mentionCandidateCache;
    }
    this.mentionCandidateQuery = prefix;
    this.mentionCandidateCache = [];
    const revision = ++this.mentionCandidateRevision;
    void this.plugins.listContextCandidates(prefix)
      .then((candidates) => {
        if (
          revision !== this.mentionCandidateRevision ||
          prefix !== this.mentionCandidateQuery
        ) {
          return;
        }
        this.mentionCandidateCache = [...candidates];
        this.completionsChanged(false);
      })
      .catch(() => {
        // Completion is a derived view. A failed provider cannot affect input.
      });
    return this.mentionCandidateCache;
  };

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
      textgenTargets: bundledTextgenTargets(),
      ...(this.config.textgenPrefer ? { textgenPrefer: this.config.textgenPrefer } : {}),
      ...(this.config.textgenModels ? { textgenModels: this.config.textgenModels } : {}),
      probeTarget: (target, cwd) =>
        probeHarnessTarget(target, {
          cwd,
          config: this.config,
          log: (entry) =>
            this.session.log({ ...entry, harnessTargetId: target.id }),
        }),
      onChange: () => this.changed(),
    });
  }

  private createPluginManager(): Manager {
    const settings = new PluginSettingsStore(this.store.rootDir);
    const context = new ContextProviderRegistry();
    context.registerContextProvider(
      sessionContextProvider(this.store, {
        excludeSessionId: this.session.id,
      }),
    );
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
      loadPackageEntry: (pluginId, version, options) => {
        if (!options?.marketplace) {
          throw new Error(`marketplace is required to load ${pluginId}`);
        }
        return this.marketplace.entry(
          pluginId,
          options.marketplace,
          version,
          options,
        );
      },
      pluginSupervisor: new PluginSupervisor(),
      onProposal: () => {
        this.changed();
      },
      onBoardChanged: () => {
        this.boardChanged();
      },
      onToast: ({ message }) => {
        this.toast = message;
        this.changed();
      },
      reservedCommandNames: COMMANDS.map((command) => command.name),
      contextProviders: context,
      onCommandsChanged: () => {
        this.completionsChanged();
      },
      onActivationError: ({ pluginInstanceId, error }) => {
        this.toast = {
          text: `Plugin ${pluginInstanceId} activation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          tone: "error",
        };
        this.changed();
      },
      onRunnerFailure: ({ pluginInstanceId, error }) => {
        this.toast = {
          text: `Plugin ${pluginInstanceId} stopped: ${error.message}`,
          tone: "error",
        };
        this.changed();
      },
      onReconcileError: ({ key, error }) => {
        let resourceLabel = `${key.resourceKind}/${key.resourceId}`;
        // 为 Baton Turn 提供更友好的展示信息
        if (key.resourceKind === BATON_TURN_RESOURCE_KIND) {
          try {
            const turnResource = this.plugins.getBatonResource(
              BATON_TURN_RESOURCE_KIND,
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
        this.toast = {
          text: `Plugin reconcile failed for ${resourceLabel}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          tone: "error",
        };
        this.changed();
      },
      onControllerSourceError: ({ scope, sourceId }) => {
        this.toast = {
          text: `Plugin source ${sourceId} failed for ${scope.pluginInstanceId}/${scope.resourceKind}`,
          tone: "error",
        };
        this.changed();
      },
    });
  }

  private startPluginManager(): void {
    void this.plugins.start().catch((error) => {
      this.toast = {
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
    this.session.log({
      level: "info",
      source: "baton",
      component: "session.lifecycle",
      message: "Session closed for session switch",
    });
    await this.session.closeLogs();
    this.session.releaseLock();
    this.session = next.session;
    this.syncTerminalTitle();
    this.commandOutput = null;
    this.controller = this.createController();
    this.state = next.session.loadState();
    this.seedHistoryFromState();
    this.unsubscribeSession = this.subscribeSession(next.session);
    this.toast = next.recovered
      ? { text: `Opened session ${next.session.id} (recovered an interrupted turn)`, tone: "info" }
      : { text: `Opened session ${next.session.id}`, tone: "info" };
    this.plugins = this.createPluginManager();
    this.completionsChanged();
    this.startPluginManager();
    this.changed();
  }

  private async configureModel(target: string, model: { id: string; label: string }): Promise<void> {
    await this.controller.setModel(target, model.id);
    saveModelPreference(this.store.rootDir, target, model.id);
    if (model.id === "default") delete this.modelPreferences[target];
    else this.modelPreferences[target] = model.id;
    this.toast = { text: `${target} model: ${model.label} (takes effect next turn)`, tone: "info" };
    this.changed();
  }

  private async modeOption(target: string) {
    const option = (await this.controller.getConfig(target)).find(
      (candidate) =>
        candidate.type === "select" &&
        (candidate.id === "mode" || candidate.category === "mode"),
    );
    if (!option || option.type !== "select" || option.options.length === 0) {
      throw new Error(`${target} does not support mode switching`);
    }
    return option;
  }

  private async configureMode(target: string, value: string): Promise<void> {
    const option = await this.modeOption(target);
    const selected = option.options.find((candidate) => candidate.value === value);
    if (!selected) throw new Error(`Unknown ${target} mode: ${value}`);
    await this.controller.setConfig(target, option.id, selected.value);
    this.toast = { text: `${target} mode: ${selected.name}`, tone: "info" };
    this.changed();
  }

  private async configureEffort(target: string, effort: { id: string; label: string }): Promise<void> {
    await this.controller.setEffort(target, effort.id);
    saveEffortPreference(this.store.rootDir, target, effort.id);
    if (effort.id === "default") delete this.effortPreferences[target];
    else this.effortPreferences[target] = effort.id;
    this.toast = { text: `${target} effort: ${effort.label} (takes effect next turn)`, tone: "info" };
    this.changed();
  }

  /** 控制命令输出只进入当前 timeline State，不写 session.jsonl，避免污染可恢复的会话历史。 */
  private sessionStatusItem(): TranscriptItem {
    const meta = this.session.meta;
    const activeTargetId = this.controller.activeHarnessTargetId;
    const selectedModel = this.controller.currentModel(this.harnessTargetId) ?? "default";
    const selectedEffort = this.controller.currentEffort(this.harnessTargetId) ?? "default";
    const selectedMode = this.controller.currentMode(this.harnessTargetId);
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
      `Current: ${this.harnessTargetId} - model ${selectedModel} - effort ${selectedEffort} - mode ${selectedMode}`,
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

  /** /sessions 会话内切换 Picker；行投影与启动 session picker 共用 sessionPickerOptions */
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
    this.cancelPickerSearch();
    this.picker = { ...picker, id: `pk_${this.nextPickerId++}` };
    this.changed();
  }

  private cancelPickerSearch(): void {
    if (this.pickerSearchTimer !== undefined) {
      clearTimeout(this.pickerSearchTimer);
      this.pickerSearchTimer = undefined;
    }
    this.pickerSearchRevision += 1;
  }

  private async runPluginCommand(
    name: string,
    argument: string,
    selectedValue?: string,
  ): Promise<void> {
    const command = this.plugins
      .listCommands()
      .find((candidate) => candidate.name === name);
    if (!command) throw new Error(`Plugin command is not active: /${name}`);
    const result = await this.executePluginCommand(command.pluginId, name, {
      argument,
      ...(selectedValue === undefined ? {} : { selectedValue }),
    });
    this.presentPluginCommandResult(command.pluginId, name, argument, result);
  }

  private async executePluginCommand(
    pluginId: string,
    name: string,
    input: PluginCommandInput,
  ): Promise<PluginCommandResult | undefined> {
    try {
      return await this.plugins.executeCommand(name, input);
    } catch (error) {
      this.session.log({
        level: "error",
        source: "baton",
        component: "plugin.command",
        message: `Plugin command /${name} failed`,
        pluginId,
        error: logError(error),
        attributes: {
          command: name,
          phase: input.selectedValue !== undefined
            ? "select"
            : input.searchQuery !== undefined
            ? "search"
            : "invoke",
        },
      });
      throw error;
    }
  }

  private presentPluginCommandResult(
    pluginId: string,
    name: string,
    argument: string,
    result: PluginCommandResult | undefined,
  ): void {
    if (!result) return;
    if (result.kind === "message") {
      this.toast = null;
      this.commandOutput = {
        ...this.batonTranscriptItem(`_plugin_command_${name}`, result.text),
        author: pluginId,
      };
      this.changed();
      return;
    }
    this.openPicker({
      title: result.title,
      options: result.options.map((option) => ({
        ...option,
        description: option.description ?? option.value,
      })),
      ...(result.search
        ? {
          search: {
            ...result.search,
            loading: false,
          },
        }
        : {}),
      ...(result.search?.mode === "remote"
        ? {
          onSearch: async (query: string) => {
            const next = await this.executePluginCommand(pluginId, name, {
              argument,
              searchQuery: query,
            });
            if (
              !next ||
              next.kind !== "picker" ||
              next.search?.mode !== "remote"
            ) {
              throw new Error(
                `/${name} remote search must return a remote-search picker`,
              );
            }
            return {
              title: next.title,
              options: next.options.map((option) => ({
                ...option,
                description: option.description ?? option.value,
              })),
              search: next.search,
            };
          },
        }
        : {}),
      onSelect: async (value) => {
        await this.runPluginCommand(name, argument, value);
      },
    });
  }

  /** 高频流式事件按 renderer 帧合并；领域 state 已同步 reduce，这里只延迟 UI State 投影。 */
  private scheduleStreamStateChanged(): void {
    if (this.streamStateTimer !== undefined) return;
    this.streamStateTimer = setTimeout(() => {
      this.streamStateTimer = undefined;
      this.changed();
    }, STREAM_STATE_FRAME_MS);
  }

  /** 通用状态更新按 State 发布；Store 只通知真正变化的数据单元。 */
  private changed(): void {
    if (this.streamStateTimer !== undefined) {
      clearTimeout(this.streamStateTimer);
      this.streamStateTimer = undefined;
    }
    publishChatState(this.stateStore, this.buildState());
  }

  /**
   * Board 是独立 read model：插件 reconcile 或显隐切换不重建 transcript/input。
   * footer 只替换 board 计数片段，其他 State 保持引用不变。
   */
  private boardChanged(): void {
    const board = this.boardView();
    const currentFooter = this.stateStore.getState("footer");
    const footerWithoutBoard = (currentFooter.text ?? "").replace(
      /  board:\d+(?=  cwd:)/,
      "",
    );
    const footer =
      board.items.length > 0
        ? footerWithoutBoard.replace(
          /  cwd:/,
          `  board:${board.items.length}  cwd:`,
        )
        : footerWithoutBoard;
    this.stateStore.commit({
      sidecar: board.sidecar,
      ...(currentFooter.toast === this.toast && currentFooter.text === footer
        ? {}
        : { footer: { toast: this.toast, text: footer } }),
    });
  }

  private completionsChanged(invalidateMentions = true): void {
    if (invalidateMentions) {
      this.mentionCandidateQuery = undefined;
      this.mentionCandidateCache = [];
      this.mentionCandidateRevision += 1;
    }
    for (const listener of this.completionListeners) listener();
  }

  private boardView(): BoardViewProjection {
    const items = this.plugins.listBoardItems();
    if (
      this.boardViewCache?.items === items &&
      this.boardViewCache.mode === this.boardMode
    ) {
      return this.boardViewCache;
    }
    this.boardViewCache = projectBoardView(items, this.boardMode);
    return this.boardViewCache;
  }

  private buildState(): ChatState {
    return projectChatState({
      state: this.state,
      controller: this.controller,
      pendingProposals: this.plugins.listPendingProposals(),
      session: this.session,
      config: this.config,
      harnessTargetId: this.harnessTargetId,
      toast: this.toast,
      commandOutput: this.commandOutput,
      picker: this.picker,
      board: this.boardView(),
    });
  }
}
