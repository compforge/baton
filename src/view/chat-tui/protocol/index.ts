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
  QueueIntent,
  QueueIntentResult,
  TranscriptItem,
  TranscriptMessageItem,
} from "chat-tui";
import { createChatStore } from "chat-tui";

import { CommandRegistry, type CommandDefinition } from "../../../commands/registry.ts";
import {
  Channel,
  type ChannelControllerOptions,
  type ChannelPluginOptions,
} from "../../../channel/index.ts";
import { targetConfigFor, type BatonConfig } from "../../../config/config.ts";
import { loadEffortPreferences, saveEffortPreference } from "../../../config/effort-preferences.ts";
import { loadModelPreferences, saveModelPreference } from "../../../config/model-preferences.ts";
import {
  expandMentions,
  parseMentions,
  sessionMention,
} from "../../../context/mention.ts";
import { MentionRegistry } from "../../../context/registry.ts";
import { logError } from "../../../logging.ts";
import {
  textOf,
  type ContentBlock,
  type PromptBlock,
} from "../../../event/index.ts";
import {
  createHarnessAdapter,
  configuredHarnessTargets,
  harnessDefinitionFor,
  probeHarnessTarget,
  resolveHarnessTarget,
  resolveHarnessTargetSelection,
} from "../../../harness/registry.ts";
import { HARNESS_IDENTITIES, HARNESSES } from "../../../harness/ids.ts";
import { configuredTextgenTargets } from "../../../session/title.ts";
import type { InteractionResult } from "../../../interaction/types.ts";
import type { Manager } from "../../../plugin/manager.ts";
import { BATON_TURN_RESOURCE_KIND } from "../../../plugin/builtin.ts";
import type {
  PluginCommandInput,
  PluginCommandResult,
  ToastMessage,
  ViewInput,
} from "../../../plugin/package.ts";
import { MarketplaceRegistry } from "../../../plugin/marketplace/index.ts";
import {
  GlobalPluginInstanceStore,
  PluginSettingsStore,
} from "../../../plugin/settings.ts";
import { PluginSupervisor } from "../../../plugin/runner/index.ts";
import { openBatonSession } from "../../../session/open.ts";
import type { Controller } from "../../../controller/index.ts";
import { MAIN_LANE_ID } from "../../../lane.ts";
import { laneTargetStateKey, type SessionState } from "../../../store/reduce.ts";
import { sessionDisplayTitle, type SessionHandle, type SessionStore } from "../../../store/store.ts";
import { sessionPickerOptions, type SessionPickerMode } from "../session-picker.tsx";
import { setTerminalTabTitle } from "../terminal-title.ts";
import { TerminalNotifier } from "../notifications.ts";
import { readClipboard, type ClipboardContent } from "../clipboard.ts";
import {
  archiveClipboardImage,
  composerImagePathsOf,
  composerImageToken,
  composerPromptBlocks,
  composerTextOf,
} from "../prompt-images.ts";
import { userVisibleText } from "./transcript.ts";
import {
  contextWindowText,
  projectBoardView,
  projectChatState,
  type BoardMode,
  type BoardViewProjection,
} from "./state.ts";
import { ChatViewPublisher } from "./publisher.ts";

export {
  thoughtDisplayBlocks,
  toolTranscriptItem,
  userVisibleText,
} from "./transcript.ts";
export { runStatusLabel } from "./state.ts";

const PICKER_SEARCH_DEBOUNCE_MS = 250;

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
  private channel: Channel;
  private viewPublisher: ChatViewPublisher;
  private controller: Controller;
  private plugins: Manager;
  private readonly commandRegistry: CommandRegistry;
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
  // 输入历史（shell 式 ↑/↓ 回溯）：会话级，从事件流的 user 消息种入、提交时追加。
  // 事件流是真相源——不另存磁盘文件；resume/切换会话后 loadState 重建 state 即可重新种入。
  private history: Array<{ text: string; imagePaths: string[] }> = [];
  private historyCursor: number | null = null; // null = 未浏览（正在编辑草稿）
  private historyStash: { text: string; imagePaths: string[] } | null = null; // 进入浏览前暂存的草稿，越过最新时恢复
  private lastHistoryText: string | null = null; // 上次召回的条目，判定用户是否改动过
  private composerImagePaths: string[] = [];
  /** 运行时 thoughts 开关（/thoughts 切换）；会话级，不写回 config.yaml。 */
  private showThoughts: boolean;
  private readonly notifier: TerminalNotifier | null;
  private queueManagerOpen = false;
  private readonly modelPreferences: Record<string, string>;
  private readonly effortPreferences: Record<string, string>;
  private shutdownPromise?: Promise<void>;
  private exitPromise?: Promise<void>;

  constructor(
    private readonly store: SessionStore,
    private readonly config: BatonConfig,
    opened: { session: SessionHandle; resumed: boolean; recovered?: boolean },
    private readonly quit: (sessionId?: string) => void,
    private readonly navigation?: BatonNavigation,
  ) {
    this.session = opened.session;
    this.syncTerminalTitle();
    this.showThoughts = config.showThoughts;
    // 桌面通知只对真实终端启用；测试与管道场景静默。
    this.notifier = config.notifications.enabled && process.stdout.isTTY
      ? new TerminalNotifier({
          config: config.notifications,
          sessionTitle: () => sessionDisplayTitle(this.session.meta),
        })
      : null;
    const defaultTarget = resolveHarnessTarget(config, config.defaultTarget);
    if (!defaultTarget) {
      throw new Error(`Default HarnessTarget is not registered: ${config.defaultTarget}`);
    }
    this.harnessTargetId = defaultTarget.id;
    this.modelPreferences = loadModelPreferences(store.rootDir);
    this.effortPreferences = loadEffortPreferences(store.rootDir);
    this.commandRegistry = this.createCommandRegistry();
    this.marketplace = new MarketplaceRegistry({
      rootDir: store.rootDir,
      cwd: this.session.meta.cwd,
    });
    if (opened.recovered) {
      this.toast = { text: "Recovered an interrupted turn from a previous baton run", tone: "info" };
    }
    this.channel = this.createChannel();
    this.controller = this.channel.controller;
    // Projection 由 BatonSession 统一维护：打开时 replay，live Event 直接 reduce。
    // TUI 只观察投影变化，不从 Ledger 或 per-turn 回调重建事实。
    this.state = this.channel.projection;
    this.seedHistoryFromState();
    this.plugins = this.requirePluginManager();
    this.stateStore = createChatStore(this.buildState());
    this.viewPublisher = new ChatViewPublisher(
      this.channel,
      this.stateStore,
      () => this.buildState(),
    );
    this.unsubscribeSession = this.subscribeChannel(this.channel);
    this.startChannel();
  }

  /** Projection 已在 Session 内更新；这里仅按 Event 类型安排 Human surface 刷新。 */
  private subscribeChannel(channel: Channel): () => void {
    return channel.subscribe((_projection, event) => {
      this.notifier?.handleEvent(event);
      this.viewPublisher.event(event.kind);
    });
  }

  // ===== 输出：baton → TUI =====

  get commands(): readonly CommandSpec[] {
    return [...this.commandRegistry.list(), ...this.plugins.listCommands()];
  }

  get pluginManager(): Manager {
    return this.plugins;
  }

  subscribeCompletions(onChange: () => void): () => void {
    this.completionListeners.add(onChange);
    return () => this.completionListeners.delete(onChange);
  }

  // ===== 输入：TUI → baton =====

  composerAcceptsPaste(): boolean {
    const composer = this.stateStore.getState("composer");
    const interaction = composer.interactions?.[0];
    return !composer.picker && interaction?.kind !== "approval" && interaction?.kind !== "question";
  }

  async prepareClipboardPaste(
    provided?: ClipboardContent,
    composerText?: string,
  ): Promise<string | null> {
    if (composerText !== undefined && !/\[Image #\d+\]/.test(composerText)) {
      this.composerImagePaths = [];
    }
    const content = provided ?? await readClipboard();
    if (!content) return null;
    if (content.type === "text") return content.text;
    if (!this.controller.promptCapabilities(this.harnessTargetId).image?.supported) {
      this.toast = { text: `${this.harnessTargetId} does not support image input`, tone: "error" };
      this.changed();
      return null;
    }
    try {
      const archived = await archiveClipboardImage(this.store.rootDir, content.data);
      this.composerImagePaths.push(archived.path);
      return `${composerImageToken(this.composerImagePaths.length)} `;
    } catch (error) {
      this.toast = {
        text: `Failed to archive clipboard image: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      };
      this.changed();
      return null;
    }
  }

  async submit(text: string): Promise<void> {
    return this.submitMessage(text);
  }

  private async submitMessage(
    text: string,
    options?: { sourceProposedPlanId?: string },
  ): Promise<void> {
    const target = this.harnessTargetId;
    const receipt = await this.channel.submitPrompt(Object.freeze({
      kind: "prompt",
      text,
      harnessTargetId: target,
    }), async () => await this.prepareComposerInput(text), options);
    // Controller receipt 与 Turn settlement 分离；Channel 接受 Input 后不等待完整 Turn。
    const sent = receipt.result;
    if (sent.effective === "steer") {
      this.toast = { text: `${target} steer queued for the current turn`, tone: "info" };
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

  private async prepareComposerInput(text: string): Promise<PromptBlock[]> {
    // 用户实际提交的内容进历史；一次新提交结束当前的 ↑ 浏览会话。
    this.recordHistory(composerPromptBlocks(text, this.composerImagePaths));
    this.resetHistoryNav();
    this.toast = null;
    this.commandOutput = null;
    const previousTitle = sessionDisplayTitle(this.session.meta);
    if (this.session.meta.forkedFrom) this.session.setTitleIfEmpty(text);
    else this.session.setPreviewIfEmpty(text);
    if (sessionDisplayTitle(this.session.meta) !== previousTitle) this.syncTerminalTitle();
    const legacyReferences = parseMentions(text);
    const hasProvidedContext = this.plugins.hasMentionReference(text);
    const contextBudget = legacyReferences.length > 0 && hasProvidedContext
      ? Math.max(1, Math.floor(this.config.mentionBudgetChars / 2))
      : this.config.mentionBudgetChars;
    const legacy = expandMentions(
      this.store,
      text,
      contextBudget,
    );
    const provided = await this.plugins.resolveMentions(
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
    const blocks = composerPromptBlocks(prompt, this.composerImagePaths);
    this.composerImagePaths = [];
    return blocks;
  }

  /**
   * @spec 一次 Commandable 提交先完整执行并结算 canonical Command；只有成功后，允许的 trailing text 才作为下一条普通 Prompt 提交。
   */
  async command(name: string, argument: string): Promise<void> {
    const input: ViewInput = Object.freeze({
      kind: "command",
      command: name,
      argument,
      harnessTargetId: this.harnessTargetId,
    });
    let trailingText: string | undefined;
    await this.channel.dispatchCommand(input, async () => {
      const invocation = this.commandRegistry.resolve(name, argument);
      if (!invocation) {
        if (!this.plugins.listCommands().some((candidate) => candidate.name === name)) {
          throw new Error(`Unknown command: /${name}`);
        }
        return await this.runPluginCommand(name, argument);
      }
      trailingText = invocation.trailingText;
      return await invocation.command.execute(invocation.argument);
    });
    if (trailingText) await this.submitMessage(trailingText);
  }

  private createCommandRegistry(): CommandRegistry {
    const registry = new CommandRegistry();
    const register = (command: CommandDefinition): void => {
      registry.register({
        ...command,
        execute: async (argument) => {
          if (command.name !== "status") this.commandOutput = null;
          await command.execute(argument);
        },
      });
    };

    for (const harness of HARNESSES) {
      register({
        name: harness,
        description: `Switch the input target to ${harness}`,
        scope: "baton",
        runPolicy: "always",
        input: { kind: "none", trailingText: "submit" },
        aliases: HARNESS_IDENTITIES[harness].aliases.map((name) => ({ name })),
        execute: async () => {
          const target = resolveHarnessTargetSelection(this.config, harness);
          if (!target) throw new Error(`No unambiguous HarnessTarget configured for ${harness}`);
          await this.configureHarness(target.id);
        },
      });
    }

    register({
      name: "target",
      description: "Switch the input target by configured HarnessTarget id",
      scope: "baton",
      runPolicy: "always",
      input: { kind: "argument" },
      execute: async (argument) => {
        const targets = configuredHarnessTargets(this.config);
        if (!argument) {
          this.openPicker({
            title: "Select HarnessTarget",
            options: targets.map((target) => {
              const definition = harnessDefinitionFor(target.harness);
              return {
                name: target.id,
                description: definition?.label ?? target.harness,
                value: target.id,
              };
            }),
            onSelect: async (value) => {
              const target = resolveHarnessTarget(this.config, value);
              if (target) await this.configureHarness(target.id);
            },
          });
          return;
        }
        const target = resolveHarnessTarget(this.config, argument);
        if (!target) throw new Error(`Unknown HarnessTarget: ${argument}`);
        await this.configureHarness(target.id);
      },
    });

    register({
      name: "model",
      description: "Set the model for the current harness's next turns",
      scope: "harness",
      runPolicy: "always",
      input: { kind: "argument" },
      execute: async (argument) => {
        const target = this.harnessTargetId;
        const models = await this.controller.listModels(target);
        if (!argument) {
          this.openPicker({
            title: `Select ${target} model`,
            options: models.map((model) => ({
              name: model.label,
              description: model.description ?? model.id,
              value: model.id,
            })),
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
        await this.configureModel(target, model);
      },
    });

    register({
      name: "effort",
      description: "Set the reasoning effort for the current harness's next turns",
      scope: "harness",
      runPolicy: "always",
      input: { kind: "argument" },
      aliases: [
        {
          name: "h",
          description: "Set the reasoning effort to High",
          boundArgument: "high",
          input: { kind: "none", trailingText: "submit" },
        },
        {
          name: "eh",
          description: "Set the reasoning effort to Extra high",
          boundArgument: "xhigh",
          input: { kind: "none", trailingText: "submit" },
        },
      ],
      execute: async (argument) => {
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
        await this.configureEffort(target, effort);
      },
    });

    register({
      name: "fast",
      description: "Toggle Fast mode for the current harness session",
      scope: "harness",
      runPolicy: "always",
      input: { kind: "none", trailingText: "submit" },
      execute: async () => {
        const target = this.harnessTargetId;
        const option = (await this.controller.getConfig(target)).find(
          (candidate) => candidate.id === "fast" && candidate.type === "boolean",
        );
        if (!option || option.type !== "boolean") {
          throw new Error(`${target} does not support Fast mode`);
        }
        const enabled = !option.value;
        await this.controller.setConfig(target, option.id, enabled);
        this.toast = {
          text: `${target} Fast mode: ${enabled ? "on" : "off"} (takes effect next turn)`,
          tone: "info",
        };
        this.changed();
      },
    });

    register({
      name: "plan",
      description: "Switch the current harness to Plan mode",
      scope: "harness",
      runPolicy: "idle",
      input: { kind: "none", trailingText: "submit" },
      execute: async () => await this.configureMode(this.harnessTargetId, "plan"),
    });

    register({
      name: "compact",
      description: "Compact the current harness context",
      scope: "harness",
      runPolicy: "idle",
      input: { kind: "none", trailingText: "reject" },
      execute: async () => {
        const target = this.harnessTargetId;
        this.toast = null;
        await this.controller.compactContext(target);
        this.toast = { text: `${target} context compacted`, tone: "info" };
        this.changed();
      },
    });

    register({
      name: "implement-plan",
      description: "Start a new turn that implements a proposed plan (latest by default)",
      scope: "baton",
      runPolicy: "always",
      input: { kind: "argument" },
      execute: async (argument) => {
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
        const resolved = typeof proposal === "string"
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
        await this.submitMessage(
          `Implement the following proposed plan:\n\n${resolved.content}`,
          { sourceProposedPlanId: resolved.planId },
        );
      },
    });

    register({
      name: "cancel-request",
      description: "Cancel a pending HarnessInvocation (latest by default)",
      scope: "baton",
      runPolicy: "always",
      input: { kind: "argument" },
      execute: async (argument) => {
        const identifier = argument.trim() || undefined;
        const cancelled = await this.plugins.cancelHarnessInvocation(identifier);
        if (!cancelled) {
          throw new Error(
            identifier
              ? `Cancellable HarnessInvocation not found: ${identifier}`
              : "No cancellable HarnessInvocation found",
          );
        }
        this.toast = {
          text: identifier
            ? `Cancelled HarnessInvocation ${identifier}`
            : "Cancelled latest HarnessInvocation",
          tone: "info",
        };
        this.changed();
      },
    });

    register({
      name: "queue",
      description: "Manage queued follow-ups by item",
      scope: "baton",
      runPolicy: "always",
      input: { kind: "none", trailingText: "reject" },
      execute: async () => this.openQueueManager(),
    });

    register({
      name: "thoughts",
      description: "Toggle agent thought display (this session only)",
      scope: "baton",
      runPolicy: "always",
      input: { kind: "none", trailingText: "reject" },
      execute: async () => {
        this.showThoughts = !this.showThoughts;
        this.toast = {
          text: `Thoughts ${this.showThoughts ? "shown" : "hidden"} (this session only; set showThoughts in config.yaml to persist)`,
          tone: "info",
        };
        this.changed();
      },
    });

    register({
      name: "board",
      description: "Toggle the Board sidecar (or set 'open', 'hide', or 'auto')",
      scope: "baton",
      runPolicy: "always",
      input: { kind: "argument" },
      execute: async (argument) => {
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
      },
    });

    register({
      name: "plugins",
      description: "Manage Baton plugins",
      scope: "baton",
      runPolicy: "always",
      input: { kind: "none", trailingText: "reject" },
      execute: async () => {
        if (!this.navigation) throw new Error("Plugin manager is not available in this client");
        this.navigation.openPlugins();
      },
    });

    register({
      name: "reload-plugins",
      description: "Reload enabled plugins in the current BatonSession",
      scope: "baton",
      runPolicy: "always",
      input: { kind: "none", trailingText: "reject" },
      execute: async () => {
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
      },
    });

    register({
      name: "sessions",
      description: "Open the BatonSession picker ('tree' for the fork-lineage view)",
      scope: "baton",
      runPolicy: "idle",
      input: { kind: "argument" },
      execute: async (argument) => {
        // chat-tui Picker 没有自定义按键，模式经参数选择（启动 picker 则用 Tab 就地切换）
        const mode = argument || "list";
        if (mode !== "list" && mode !== "tree") {
          throw new Error(`/sessions takes 'tree' or 'list' (got: ${argument})`);
        }
        this.openSessionsPicker(mode);
      },
    });

    register({
      name: "status",
      description: "Show the current BatonSession information",
      scope: "baton",
      runPolicy: "always",
      input: { kind: "none", trailingText: "reject" },
      execute: async () => {
        this.toast = null;
        this.commandOutput = this.sessionStatusItem();
        this.changed();
      },
    });

    register({
      name: "new",
      description: "Create a new BatonSession in the current directory",
      scope: "baton",
      runPolicy: "idle",
      input: { kind: "none", trailingText: "reject" },
      execute: async () => {
        await this.switchSession(() => {
          const next = this.store.createSession({ cwd: this.session.meta.cwd });
          next.acquireLock();
          return { session: next };
        });
      },
    });

    register({
      name: "exit",
      description: "Exit baton",
      scope: "baton",
      runPolicy: "always",
      input: { kind: "none", trailingText: "reject" },
      execute: async () => await this.exit(),
    });

    return registry;
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
    const input: ViewInput = Object.freeze({
      kind: "interrupt",
      harnessTargetId: this.controller.activeHarnessTargetId ?? this.harnessTargetId,
    });
    void this.channel.interrupt(input);
  }

  dismissSidecar(): void {
    this.boardMode = "hidden";
    this.boardChanged();
  }

  /** 只释放 Baton 运行时；信号路径用它避免向已经断开的终端继续渲染。 */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownActive();
    return this.shutdownPromise;
  }

  private async shutdownActive(): Promise<void> {
    this.cancelPickerSearch();
    this.viewPublisher.close();
    this.unsubscribeSession();
    try {
      await this.channel.close();
    } finally {
      this.marketplace.close();
    }
  }

  /** 优雅退出：先关掉 agent 子进程再退（对应 /exit、双击 Ctrl+C、Ctrl+D） */
  exit(): Promise<void> {
    if (this.exitPromise) return this.exitPromise;
    this.toast = { text: "Exiting…", tone: "info" };
    this.changed();
    this.exitPromise = this.exitActive();
    return this.exitPromise;
  }

  private async exitActive(): Promise<void> {
    try {
      await this.shutdown();
    } finally {
      this.quit(this.session.id);
    }
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
    const input: ViewInput = Object.freeze({
      kind: "interaction_response",
      interactionId: id,
    });
    const receipt = await this.channel.resolveInteraction(
      input,
      async () => await this.prepareInteractionResult(id, response),
    );
    if (!receipt.result) {
      // 无 continuation：请求已被应答，或是崩溃残留。
      this.toast = { text: "interaction request is no longer pending", tone: "info" };
      this.changed();
    }
  }

  private async prepareInteractionResult(
    id: string,
    response: InteractionResponse,
  ): Promise<InteractionResult | undefined> {
    const interaction = this.state.interactions.get(id)?.interaction;
    let result: InteractionResult | undefined;
    if (
      response.kind === "suggested_input" &&
      interaction?.kind === "suggested_input"
    ) {
      result = response.outcome === "submitted"
        ? {
            kind: "suggested_input",
            outcome: "submitted",
            blocks: await this.prepareComposerInput(response.text),
          }
        : { kind: "suggested_input", outcome: "dismissed" };
    } else if (response.kind === "cancelled" && interaction) {
      result = { kind: "cancelled", reason: "user" };
    } else if (response.kind === "approval" && interaction?.kind === "permission") {
      result = { kind: "permission", outcome: "selected", optionId: response.optionId };
    } else if (response.kind === "approval" && interaction?.kind === "hook_trust") {
      result = {
        kind: "hook_trust",
        outcome: response.optionId === "trust" ? "trusted" : "skipped",
      };
    } else if (
      response.kind === "approval" &&
      interaction?.kind === "harness_invocation"
    ) {
      result = {
        kind: "harness_invocation",
        outcome: response.optionId === "approve" ? "approved" : "declined",
      };
    } else if (response.kind === "question" && interaction?.kind === "question") {
      const answers = Object.fromEntries(
        interaction.questions.map((question) => [
          question.questionId,
          (response.answers[question.questionId] ?? []).map((value) => {
            const choice = question.choices?.find(
              (candidate) =>
                candidate.value === value || candidate.label === value,
            );
            return choice?.value ?? value;
          }),
        ]),
      );
      result = { kind: "question", outcome: "answered", answers };
    }
    return result;
  }

  recallQueued(): { text: string } | null {
    const recalled = this.controller.recallLatestQueued();
    if (!recalled) return null;
    // 召回队列是另一种取回动作，结束进行中的历史浏览，避免游标错位。
    this.resetHistoryNav();
    this.harnessTargetId = recalled.harnessTargetId;
    this.composerImagePaths = composerImagePathsOf(recalled.blocks);
    this.toast = { text: `Recalled queued message for ${recalled.harnessTargetId}; edit and resend`, tone: "info" };
    this.changed();
    return { text: userVisibleText(composerTextOf(recalled.blocks)) };
  }

  /** /queue opens chat-tui's dedicated pane; item actions return through typed intents. */
  private openQueueManager(): void {
    const items = this.controller.listQueued();
    if (items.length === 0) {
      this.toast = { text: "Queue is empty", tone: "info" };
      this.changed();
      return;
    }
    this.queueManagerOpen = true;
    this.changed();
  }

  async resolveQueue(intent: QueueIntent): Promise<QueueIntentResult> {
    if (intent.kind === "close") {
      this.queueManagerOpen = false;
      this.changed();
      return { kind: "accepted" };
    }
    if (intent.kind === "move") {
      const moved = this.controller.moveQueuedById(intent.itemId, intent.direction);
      return moved
        ? { kind: "accepted" }
        : { kind: "rejected", message: "That queued message can no longer be moved" };
    }
    if (intent.kind === "dispatch-now") {
      const outcome = await this.controller.dispatchQueuedNow(intent.itemId);
      if (!outcome) {
        return {
          kind: "rejected",
          message: "That queued message can no longer be dispatched",
        };
      }
      this.queueManagerOpen = false;
      this.toast = {
        text: outcome.effective === "steer"
          ? "Dispatched queued message to the current turn"
          : "Moved queued message to the front",
        tone: "info",
      };
      this.changed();
      return { kind: "accepted" };
    }
    const withdrawn = intent.kind === "recall"
      ? this.controller.recallQueuedById(intent.itemId)
      : this.controller.discardQueuedById(intent.itemId);
    if (!withdrawn) {
      return {
        kind: "rejected",
        message: "That queued message is no longer manageable",
      };
    }
    this.resetHistoryNav();
    if (intent.kind === "discard") {
      this.toast = {
        text: `Deleted queued message for ${withdrawn.harnessTargetId}`,
        tone: "info",
      };
      if (this.controller.listQueued().length === 0) this.queueManagerOpen = false;
      this.changed();
      return { kind: "accepted" };
    }
    this.queueManagerOpen = false;
    this.harnessTargetId = withdrawn.harnessTargetId;
    this.composerImagePaths = composerImagePathsOf(withdrawn.blocks);
    this.toast = {
      text: `Recalled queued message for ${withdrawn.harnessTargetId}; edit and resend`,
      tone: "info",
    };
    this.changed();
    return {
      kind: "recalled",
      text: userVisibleText(composerTextOf(withdrawn.blocks)),
    };
  }

  /**
   * ↑ 历史回溯（shell 式）。current 为输入框当前内容：首次进入浏览时暂存为草稿并跳到
   * 最新一条；连续浏览时若 current 已偏离上次召回的条目，说明用户改过 → 返回 null 让
   * TUI 放行为普通光标移动。已到最旧则停住（返回 null）。
   */
  historyPrev(current: string): { text: string } | null {
    if (this.history.length === 0) return null;
    if (this.historyCursor === null) {
      this.historyStash = { text: current, imagePaths: [...this.composerImagePaths] };
      this.historyCursor = this.history.length - 1;
    } else {
      if (this.lastHistoryText !== null && current !== this.lastHistoryText) return null;
      if (this.historyCursor === 0) return null;
      this.historyCursor -= 1;
    }
    const entry = this.history[this.historyCursor]!;
    this.composerImagePaths = [...entry.imagePaths];
    this.lastHistoryText = entry.text;
    return { text: entry.text };
  }

  /** ↓ 历史前进，与 historyPrev 对称；越过最新条目时恢复进入浏览前暂存的草稿并退出浏览。 */
  historyNext(current: string): { text: string } | null {
    if (this.historyCursor === null) return null;
    if (this.lastHistoryText !== null && current !== this.lastHistoryText) return null;
    if (this.historyCursor + 1 >= this.history.length) {
      const stash = this.historyStash ?? { text: "", imagePaths: [] };
      this.composerImagePaths = [...stash.imagePaths];
      this.resetHistoryNav();
      return { text: stash.text };
    }
    this.historyCursor += 1;
    const entry = this.history[this.historyCursor]!;
    this.composerImagePaths = [...entry.imagePaths];
    this.lastHistoryText = entry.text;
    return { text: entry.text };
  }

  /** 追加一条输入历史（相邻去重、跳过空白）；提交与从事件流种入共用。 */
  private recordHistory(blocks: ReadonlyArray<ContentBlock | PromptBlock>): void {
    const trimmed = userVisibleText(composerTextOf(blocks));
    if (!trimmed) return;
    const imagePaths = composerImagePathsOf(blocks);
    const previous = this.history[this.history.length - 1];
    if (
      previous?.text === trimmed &&
      previous.imagePaths.length === imagePaths.length &&
      previous.imagePaths.every((path, index) => path === imagePaths[index])
    ) return;
    this.history.push({ text: trimmed, imagePaths });
  }

  private resetHistoryNav(): void {
    this.historyCursor = null;
    this.historyStash = null;
    this.lastHistoryText = null;
  }

  /** 从当前 state 的非 Plugin user-role 消息重建用户输入历史。 */
  private seedHistoryFromState(): void {
    this.history = [];
    for (const entry of this.state.timeline) {
      if (entry.type !== "message") continue;
      const msg = this.state.messages.get(entry.id);
      if (!msg || msg.role !== "user" || msg.source?.type === "plugin") continue;
      this.recordHistory(msg.content);
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
    void this.plugins.listMentionCandidates(prefix)
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

  private createChannel(): Channel {
    return new Channel({
      session: this.session,
      controller: this.controllerOptions(),
      plugins: this.pluginOptions(),
    });
  }

  private controllerOptions(): ChannelControllerOptions {
    return {
      mentionBudgetChars: this.config.mentionBudgetChars,
      modelPreferences: this.modelPreferences,
      effortPreferences: this.effortPreferences,
      // 交互回调由 controller 提供（resolver 注册表）：protocol 不再持有交互状态
      createAdapter: (target, handlers) =>
        createHarnessAdapter(target, {
          ...handlers,
          targetConfig: targetConfigFor(this.config, target.id),
          rootDir: this.store.rootDir,
        }),
      resolveTarget: (targetId) => resolveHarnessTarget(this.config, targetId),
      textgenTargets: configuredTextgenTargets(this.config),
      ...(this.config.textgenPrefer ? { textgenPrefer: this.config.textgenPrefer } : {}),
      ...(this.config.textgenModels ? { textgenModels: this.config.textgenModels } : {}),
      onSessionTitleChange: () => this.syncTerminalTitle(),
      probeTarget: (target, cwd) =>
        probeHarnessTarget(target, {
          cwd,
          targetConfig: targetConfigFor(this.config, target.id),
          log: (entry) =>
            this.session.log({ ...entry, harnessTargetId: target.id }),
        }),
      onChange: () => this.changed(),
    };
  }

  private pluginOptions(): ChannelPluginOptions {
    const settings = new PluginSettingsStore(this.store.rootDir);
    const mentions = new MentionRegistry();
    mentions.registerMention(
      sessionMention(this.store, {
        excludeSessionId: this.session.id,
      }),
    );
    return {
      instances: new GlobalPluginInstanceStore({
        settings,
        session: this.session,
      }),
      harnessTargets: configuredHarnessTargets(this.config).map((target) => {
        const definition = harnessDefinitionFor(target.harness);
        return {
          ...target,
          label: target.id === target.harness
            ? (definition?.label ?? target.id)
            : `${definition?.label ?? target.harness} (${target.id})`,
        };
      }),
      selectedHarnessTargetId: () => this.harnessTargetId,
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
      onBoardChanged: () => {
        this.boardChanged();
      },
      onToast: ({ message }) => {
        this.toast = message;
        this.changed();
      },
      reservedCommandNames: this.commandRegistry.names(),
      mentions,
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
    };
  }

  private requirePluginManager(): Manager {
    const manager = this.channel.pluginManager;
    if (!manager) throw new Error("TUI Channel requires a Plugin Manager");
    return manager;
  }

  private startChannel(): void {
    void this.channel.start().catch((error) => {
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
    if (this.controller.isBusy || this.controller.harnessQueueLength > 0) {
      throw new Error("Wait for the current turn to finish before switching BatonSession");
    }
    const next = open();
    this.viewPublisher.close();
    this.unsubscribeSession();
    this.session.log({
      level: "info",
      source: "baton",
      component: "session.lifecycle",
      message: "Session closed for session switch",
    });
    await this.channel.close();
    this.session = next.session;
    // /thoughts 是 BatonSession 级临时覆盖；切换后从用户配置重新开始，不能串到新会话。
    this.showThoughts = this.config.showThoughts;
    this.composerImagePaths = [];
    this.syncTerminalTitle();
    this.commandOutput = null;
    this.channel = this.createChannel();
    this.controller = this.channel.controller;
    this.state = this.channel.projection;
    this.seedHistoryFromState();
    this.toast = next.recovered
      ? { text: `Opened session ${next.session.id} (recovered an interrupted turn)`, tone: "info" }
      : { text: `Opened session ${next.session.id}`, tone: "info" };
    this.plugins = this.requirePluginManager();
    this.viewPublisher = new ChatViewPublisher(
      this.channel,
      this.stateStore,
      () => this.buildState(),
    );
    this.unsubscribeSession = this.subscribeChannel(this.channel);
    this.completionsChanged();
    this.startChannel();
    this.changed();
  }

  private async runHumanConfiguration(
    setting: Extract<ViewInput, { kind: "configuration" }>["setting"],
    target: string,
    value: string | null,
    action: () => Promise<void>,
  ): Promise<void> {
    await this.channel.dispatchConfiguration(Object.freeze({
      kind: "configuration",
      harnessTargetId: target,
      setting,
      value,
    }), action);
  }

  private async configureHarness(target: string): Promise<void> {
    await this.runHumanConfiguration("harness", target, target, async () => {
      this.harnessTargetId = target;
      this.toast = null;
      this.commandOutput = null;
      this.changed();
    });
  }

  private async configureModel(target: string, model: { id: string; label: string }): Promise<void> {
    await this.runHumanConfiguration("model", target, model.id, async () => {
      await this.controller.setModel(target, model.id);
      saveModelPreference(this.store.rootDir, target, model.id);
      if (model.id === "default") delete this.modelPreferences[target];
      else this.modelPreferences[target] = model.id;
      this.toast = { text: `${target} model: ${model.label} (takes effect next turn)`, tone: "info" };
      this.changed();
    });
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
    await this.runHumanConfiguration("mode", target, value, async () => {
      const option = await this.modeOption(target);
      const selected = option.options.find((candidate) => candidate.value === value);
      if (!selected) throw new Error(`Unknown ${target} mode: ${value}`);
      await this.controller.setConfig(target, option.id, selected.value);
      this.toast = { text: `${target} mode: ${selected.name}`, tone: "info" };
      this.changed();
    });
  }

  private async configureEffort(target: string, effort: { id: string; label: string }): Promise<void> {
    await this.runHumanConfiguration("effort", target, effort.id, async () => {
      await this.controller.setEffort(target, effort.id);
      saveEffortPreference(this.store.rootDir, target, effort.id);
      if (effort.id === "default") delete this.effortPreferences[target];
      else this.effortPreferences[target] = effort.id;
      this.toast = { text: `${target} effort: ${effort.label} (takes effect next turn)`, tone: "info" };
      this.changed();
    });
  }

  /** 控制命令输出只进入当前 timeline State，不写 session.jsonl，避免污染可恢复的会话历史。 */
  private sessionStatusItem(): TranscriptItem {
    const meta = this.session.meta;
    const activeTargetId = this.controller.activeHarnessTargetId;
    const selectedModel = this.controller.currentModel(this.harnessTargetId) ?? "default";
    const selectedEffort = this.controller.currentEffort(this.harnessTargetId) ?? "default";
    const selectedMode = this.controller.currentMode(this.harnessTargetId);
    const context = this.state.perLaneTarget.get(
      laneTargetStateKey(MAIN_LANE_ID, this.harnessTargetId),
    )?.contextWindow;
    const contextText = contextWindowText(context, selectedModel);
    const targets = meta.harnessTargets
      ? Object.keys(meta.harnessTargets).join(", ")
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
      `State: ${activeTargetId ? `running (${activeTargetId})` : "idle"} - queue ${this.controller.harnessQueueLength}`,
    ].join("\n");
    return this.batonTranscriptItem("_baton_status", text);
  }

  /** baton 自身也是 transcript author；这类 UI 反馈不写入 harness 会话历史。 */
  private batonTranscriptItem(id: string, text: string): TranscriptMessageItem {
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

  /** 通用状态更新统一发布为 ViewOutput。 */
  private changed(): void {
    this.viewPublisher.changed();
  }

  /** Board 与其他可见状态共用同一条 ViewOutput 路径。 */
  private boardChanged(): void {
    this.viewPublisher.boardChanged();
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
      session: this.session,
      config: { showThoughts: this.showThoughts },
      harnessTargetId: this.harnessTargetId,
      toast: this.toast,
      commandOutput: this.commandOutput,
      picker: this.picker,
      queueManagerOpen: this.queueManagerOpen,
      board: this.boardView(),
    });
  }
}
