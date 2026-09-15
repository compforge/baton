// Claude Code 接入：官方 Agent SDK 进程内直调（TS 宿主不需要 tutti 那样的 sidecar）。
// SDK 以子进程拉起 claude CLI；可执行文件可换成公司包装器（BATON_CLAUDE_BIN），
// 凭证零持有，复用本机登录态。见 docs/harness/claude-code.md。

import {
  query,
  type EffortLevel,
  type Options,
  type PermissionResult,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";

import { newId } from "../../event/ids.ts";
import { MessageReplies } from "../message-replies.ts";
import type { LogSink } from "../../logging.ts";
import { logError } from "../../logging.ts";
import { readClaudeSettings } from "./settings.ts";
import type {
  ConfigValue,
  SessionConfigOption,
} from "../../event/index.ts";
import type {
  AdapterCapabilities,
  HarnessAdapter,
  EffortOption,
  HarnessEventSink,
  HarnessSessionBindingSink,
  ModelOption,
  ModelConfiguration,
  NativeEventSink,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  SendTurnReceipt,
  HarnessSessionHandle,
  OpenInteraction,
  TextgenRequest,
} from "../adapter.ts";
import { unsupportedPromptBlocks } from "../adapter.ts";
import { generateClaudeStructured } from "./textgen.ts";
import {
  sessionIdFromResumeState,
  sessionIdResumeState,
} from "../resume.ts";
import { ClaudeEventHandler, type ClaudePermissionMeta } from "./events.ts";

export {
  applyTaskOp,
  claudeApprovalOptions,
  claudeDurableMessageDrafts,
  claudeProposedPlanDraft,
  claudeResultDiff,
  claudeToolDiff,
  claudeToolEffect,
  claudeToolKind,
  claudeToolTitle,
  taskPlanEntries,
  taskToolOp,
  todoWritePlan,
  type ClaudeDurableMappingState,
  type ClaudeDurableMessage,
  type TaskEntry,
  type TaskToolOp,
} from "./mapping.ts";
import {
  CLAUDE_FALLBACK_MODELS,
  CLAUDE_MODES,
  CLAUDE_SETTING_SOURCES,
  claudeCommandLifecycleMessage,
  claudeEfforts,
  claudeEffortsForModel,
  claudeModels,
  claudePromptChannel,
  claudeUserMessage,
  commandLifecycleKey,
  startsHarnessTurn,
  type ClaudePromptChannel,
  type ClaudeRuntime,
  type ClaudeStreamMessage,
  type ClaudeTurn,
} from "./runtime.ts";
export { claudeUserMessage, probeClaudeTarget, startsHarnessTurn } from "./runtime.ts";

export interface ClaudeAdapterOptions {
  openInteraction: OpenInteraction;
  log?: LogSink;
  nativeEvent?: NativeEventSink;
  /** HarnessTarget 固定环境；同名项覆盖每次 open 传入的动态环境。 */
  env?: Readonly<Record<string, string>>;
  /** claude 可执行文件路径；默认 BATON_CLAUDE_BIN 环境变量，再默认交给 SDK 自己找 */
  executablePath?: string;
  /** 测试注入点；生产始终使用 Agent SDK 的 query。 */
  queryFactory?: typeof query;
}

/**
 * 0.3.270 runtime exposes this control method, but its Query declaration has not caught up yet.
 * Keep the temporary narrowing at the Claude boundary so Core never learns provider UUIDs.
 */
type AsyncMessageCancellableQuery = Query & {
  cancelAsyncMessage(messageUuid: string): Promise<boolean>;
};

export class ClaudeAdapter implements HarnessAdapter {
  readonly harness = "claude-code";
  // 可选能力接口落地并验证后才声明对应 marker——契约测试钉住
  // "声明支持就必须实现对应接口"。
  readonly capabilities: AdapterCapabilities = {
    prompt: { image: { supported: true } },
    compact: { supported: true },
    config: { supported: true },
    textgen: { supported: true },
    tasks: { stop: { supported: true } },
    inputs: { cancel: { supported: true } },
  };
  // Claude 原生队列跨 Turn 存活（command_lifecycle/result UUID 回执迟到也会到），
  // 投递进度由 input_delivery_update 显式报告。
  readonly steering = {
    deliveryTracking: "explicit",
    cancelOwnership: "survives",
  } as const;
  private sessions = new Map<string, ClaudeRuntime>();
  private events: ClaudeEventHandler;

  constructor(private options: ClaudeAdapterOptions) {
    this.events = new ClaudeEventHandler({
      openInteraction: options.openInteraction,
      ...(options.log ? { log: options.log } : {}),
      publishSessionBinding: (runtime, sessionId) => this.publishSessionBinding(runtime, sessionId),
      finishTurn: (runtime, emit, turn, stopReason, raw) =>
        this.finishTurn(runtime, emit, turn, stopReason, raw),
    });
  }

  /** TextGeneratable：一次性 SDK query，与 HarnessSession 生命周期完全无关（见 textgen.ts）。 */
  async generateStructured(request: TextgenRequest): Promise<unknown> {
    return generateClaudeStructured(request, {
      executablePath: this.options.executablePath,
      env: this.options.env,
      ...(this.options.queryFactory ? { queryFactory: this.options.queryFactory } : {}),
    });
  }

  /** SDK 无独立"启动"步骤：streaming query 在首个 sendTurn 时创建，这里只登记运行时。 */
  async open(
    opts: OpenOptions,
    sink: HarnessEventSink,
    binding?: HarnessSessionBindingSink,
  ): Promise<HarnessSessionHandle> {
    const id = newId("hs");
    const requestedSessionId = opts.resumeState
      ? sessionIdFromResumeState(opts.resumeState)
      : opts.resumeSessionId;
    // 0.2.14 曾把进程内 hs_ handle 当稳定身份落盘。迁移知识留在 Claude Adapter
    // 边界：core 不解析任何 Harness 的 ID 方言；新 init 随后会发布真实 binding。
    const resumeSessionId = requestedSessionId?.startsWith("hs_")
      ? undefined
      : requestedSessionId;

    const env = opts.env || this.options.env
      ? { ...opts.env, ...this.options.env }
      : undefined;
    // 读取 .claude/settings.json 中的 plugins 和 mcpServers 配置
    const settings = await readClaudeSettings(opts.cwd, this.options.log, env);

    // 注意：虽然 SDK 通过子进程启动 Claude CLI，CLI 会自动读取配置文件层级：
    //   1. ~/.claude/settings.json (user-level)
    //   2. ${cwd}/.claude/settings.json (project-level)
    //   3. ${cwd}/.claude/settings.local.json (local override)
    //   4. managed-settings.json (policy)
    //
    // 但为了确保 plugins 和 mcpServers 能被正确加载，我们需要：
    // 1. 通过 SDK Options 显式传递 plugins 和 mcpServers（确保 SDK 能看到）
    // 2. 同时保持 cwd 正确，让 CLI 能读取 enabledPlugins 等其他配置
    //
    // 这种"双保险"策略能最大程度保证 plugin 正常工作。

    const runtime: ClaudeRuntime = {
      cwd: opts.cwd,
      env,
      sink,
      bindingSink: binding,
      claudeSessionId: resumeSessionId,
      suppressedToolIds: new Set(),
      capturedProposedPlanKeys: new Set(),
      tasks: new Map(),
      pendingTaskOps: new Map(),
      settings,
    };
    this.sessions.set(id, runtime);
    if (resumeSessionId) this.publishSessionBinding(runtime, resumeSessionId);
    return { harness: this.harness, handleId: id, resumed: Boolean(resumeSessionId) };
  }

  async listModels(ref: HarnessSessionHandle): Promise<ModelOption[]> {
    const rt = this.mustSession(ref);
    try {
      await this.ensureModelCatalog(rt);
    } catch {
      // CLI 初始化失败时仍允许用稳定别名发起首轮，不让模型发现阻断发送链路。
    }
    return rt.models ?? CLAUDE_FALLBACK_MODELS;
  }

  async setModel(ref: HarnessSessionHandle, modelId: string | null): Promise<void> {
    const rt = this.mustSession(ref);
    const model = !modelId || modelId === "default" ? undefined : modelId;
    if (rt.effort && !claudeEffortsForModel(rt, model).some((candidate) => candidate.id === rt.effort)) {
      throw new Error(`Claude model ${model ?? "default"} does not support effort ${rt.effort}`);
    }
    if (rt.activeQuery) await rt.activeQuery.setModel(model);
    rt.model = model;
  }

  async setModelConfiguration(ref: HarnessSessionHandle, configuration: ModelConfiguration): Promise<void> {
    const rt = this.mustSession(ref);
    const models = await this.listModels(ref);
    const model = configuration.model === "default" ? undefined : configuration.model;
    if (model && !models.some((candidate) => candidate.id === model)) {
      throw new Error(`Unknown Claude model: ${model}`);
    }
    const effort = configuration.effort === "default" ? undefined : configuration.effort;
    if (effort && !claudeEffortsForModel(rt, model).some((candidate) => candidate.id === effort)) {
      throw new Error(`Claude model ${configuration.model} does not support effort ${effort}`);
    }
    rt.model = model;
    rt.effort = effort as EffortLevel | undefined;
    // Recreate query options at the next new turn, never mutate the active query.
    if (rt.activeQuery) rt.queryOptionsDirty = true;
  }

  currentModel(ref: HarnessSessionHandle): string | null {
    return this.mustSession(ref).model ?? null;
  }

  async listEfforts(ref: HarnessSessionHandle): Promise<EffortOption[]> {
    const rt = this.mustSession(ref);
    try {
      await this.ensureModelCatalog(rt);
    } catch {
      // 与 model picker 一致：发现失败时使用 SDK 的稳定 effort 词表。
    }
    return claudeEfforts(rt);
  }

  async setEffort(ref: HarnessSessionHandle, effortId: string | null): Promise<void> {
    const rt = this.mustSession(ref);
    if (!effortId || effortId === "default") {
      rt.effort = undefined;
      if (rt.activeQuery) rt.queryOptionsDirty = true;
      return;
    }
    if (!claudeEfforts(rt).some((candidate) => candidate.id === effortId)) {
      throw new Error(`Claude model ${rt.model ?? "default"} does not support effort ${effortId}`);
    }
    rt.effort = effortId as EffortLevel;
    if (rt.activeQuery) rt.queryOptionsDirty = true;
  }

  currentEffort(ref: HarnessSessionHandle): string | null {
    return this.mustSession(ref).effort ?? null;
  }

  async getConfig(ref: HarnessSessionHandle): Promise<SessionConfigOption[]> {
    const [models, efforts] = await Promise.all([
      this.listModels(ref),
      this.listEfforts(ref),
    ]);
    return [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        value: this.currentModel(ref) ?? "default",
        options: models.map(({ id, label, description }) => ({
          value: id,
          name: label,
          ...(description ? { description } : {}),
        })),
      },
      {
        id: "effort",
        type: "select",
        name: "Effort",
        category: "thought_level",
        value: this.currentEffort(ref) ?? "default",
        options: efforts.map(({ id, label, description }) => ({
          value: id,
          name: label,
          ...(description ? { description } : {}),
        })),
      },
      {
        id: "mode",
        type: "select",
        name: "Mode",
        category: "mode",
        value: this.mustSession(ref).permissionMode ?? "default",
        options: [...CLAUDE_MODES],
      },
    ];
  }

  async setConfig(
    ref: HarnessSessionHandle,
    configId: string,
    value: ConfigValue,
  ): Promise<SessionConfigOption[]> {
    if (typeof value !== "string") {
      throw new Error(`Claude config ${configId} requires a string value`);
    }
    if (configId === "model") {
      await this.setModel(ref, value);
    } else if (configId === "effort") {
      await this.setEffort(ref, value);
    } else if (configId === "mode") {
      if (value !== "default" && value !== "plan") {
        throw new Error(`Unknown Claude mode: ${value}`);
      }
      const rt = this.mustSession(ref);
      if (rt.activeTurn && !rt.activeTurn.finalized) {
        throw new Error("Cannot switch Claude mode while a turn is running");
      }
      if (rt.activeQuery) await rt.activeQuery.setPermissionMode(value);
      rt.permissionMode = value === "default" ? undefined : value;
    } else {
      throw new Error(`Unknown Claude session config: ${configId}`);
    }
    return this.getConfig(ref);
  }

  private async ensureModelCatalog(rt: ClaudeRuntime): Promise<void> {
    if (rt.models) return;
    if (rt.activeQuery) {
      rt.modelInfos = await rt.activeQuery.supportedModels();
      rt.models = claudeModels(rt.modelInfos);
      return;
    }
    // 静态发现归 HarnessTarget probe；live Adapter 在尚未启动 query 时只提供稳定别名。
    rt.models = CLAUDE_FALLBACK_MODELS;
  }

  async compactContext(ref: HarnessSessionHandle, turnId: string): Promise<PromptReceipt> {
    const rt = this.mustSession(ref);
    if (!rt.claudeSessionId) throw new Error("Claude has no conversation to compact yet");
    if (rt.activeTurn && !rt.activeTurn.finalized) {
      throw new Error(`claude turn ${rt.activeTurn.turnId} still active; cannot compact`);
    }
    const receipt = await this.sendTurn(ref, {
      turnId,
      messageId: newId("m"),
      blocks: [{ type: "text", text: "/compact" }],
    });
    if (!receipt.accepted || receipt.effective !== "new_turn") {
      throw new Error(
        !receipt.accepted ? receipt.reason ?? "Claude rejected context compaction" : "Claude compact opened as steer",
      );
    }
    return { accepted: true };
  }

  /**
   * 统一输入入口，对齐 T3Code 的 Claude runtime：
   * - 空闲时在长生命周期 streaming query 上开启新 turn；
   * - 运行中且 Baton turnId 匹配时，把消息投进同一 prompt stream，作为当前 turn 的 steer；
   * - turnId 不匹配时拒绝，由 Controller 排成 follow-up，绝不误注入别的回合。
   */
  async sendTurn(
    ref: HarnessSessionHandle,
    input: PromptInput,
  ): Promise<SendTurnReceipt> {
    const rt = this.mustSession(ref);
    const unsupported = unsupportedPromptBlocks(input.blocks, this.capabilities);
    if (unsupported.length) {
      throw new Error(`claude-code adapter does not support prompt block type(s): ${unsupported.join(", ")}`);
    }

    const active = rt.activeTurn && !rt.activeTurn.finalized ? rt.activeTurn : undefined;
    if (active) {
      if (active.turnId !== input.turnId) {
        return {
          accepted: false,
          effective: "rejected",
          reason: `active Claude turn is ${active.turnId}, not ${input.turnId}`,
        };
      }
      const message = await claudeUserMessage(input.blocks);
      if (rt.activeTurn !== active || active.finalized) {
        return { accepted: false, effective: "rejected", reason: "active Claude turn completed while reading input" };
      }
      if (!rt.promptChannel?.offer(message)) {
        return {
          accepted: false,
          effective: "rejected",
          reason: "Claude streaming input is unavailable",
        };
      }
      // offer 只代表 Baton 把消息交给 SDK input stream；原生 queued/started
      // lifecycle 才决定它何时离开 Composer Queue。投递回执走 input_delivery_update，
      // 不再寄生 user_message.deliveryState。
      const pendingOffers = (rt.pendingOfferUuids ??= new Map());
      (rt.inputMessageIdsByUuid ??= new Map()).set(message.uuid as string, input.messageId);
      pendingOffers.set(message.uuid as string, {
        turnId: active.turnId,
        messageId: input.messageId,
        blocks: input.blocks,
      });
      this.emit(
        rt,
        {
          kind: "user_message",
          payload: {
            messageId: input.messageId,
            content: input.blocks,
            delivery: "steer",
          },
        },
        active,
      );
      return { accepted: true, effective: "steer" };
    }

    // 没有对应 Queue item 的 Turn 仍需先明确收口，避免后续消息与新 Queue-driven Turn
    // 共用 currentTurn 而发生归属混淆。
    if (rt.currentTurn && !rt.currentTurn.finalized) {
      const harnessTurn = rt.currentTurn;
      this.finishTurn(rt, (ev) => this.emit(rt, ev, harnessTurn), harnessTurn, "end_turn");
    }
    if (rt.queryOptionsDirty) this.closeStreamingQuery(rt);

    const turn: ClaudeTurn = { turnId: input.turnId, finalized: false, cancelRequested: false, replies: new MessageReplies([input.messageId]) };
    rt.activeTurn = turn;
    rt.currentTurn = turn;
    // user_message / state_update(running) 由 controller 在出队时落盘（用户输入是 BatonSession
    // 的事实，不等 harness 就绪）；adapter 只报告 harness 执行过程与终态。

    try {
      const message = await claudeUserMessage(input.blocks);
      this.ensureStreamingQuery(rt);
      (rt.inputMessageIdsByUuid ??= new Map()).set(message.uuid as string, input.messageId);
      if (!rt.promptChannel?.offer(message)) {
        throw new Error("Claude streaming input closed before prompt was accepted");
      }
    } catch (error) {
      if (rt.activeTurn === turn) rt.activeTurn = undefined;
      if (rt.currentTurn === turn) rt.currentTurn = undefined;
      throw error;
    }
    return { accepted: true, effective: "new_turn" };
  }

  private ensureStreamingQuery(rt: ClaudeRuntime): void {
    if (rt.activeQuery) return;
    const executable = this.options.executablePath ?? process.env.BATON_CLAUDE_BIN;
    const sdkOptions: Options = {
      cwd: rt.cwd,
      env: {
        ...(process.env as Record<string, string>),
        // 新模型不再默认暴露 Task/Todo 工具；用 SDK 公布的兼容开关恢复工具面，
        // 但仍让 canUseTool 保持唯一权限入口。Target env 可显式覆盖这个默认值。
        CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
        ...rt.env,
      },
      resume: rt.claudeSessionId,
      includePartialMessages: true,
      // Baton exposes per-task stop in /parallel. With this declaration Esc only aborts
      // the foreground turn and leaves background work individually controllable.
      perTaskStopAffordance: true,
      // Agent SDK 默认使用空 system prompt；显式恢复 Claude Code 语义，确保
      // skills、auto-memory 等原生能力与直接运行 claude CLI 一致。
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: [...CLAUDE_SETTING_SOURCES],
      ...(rt.model ? { model: rt.model } : {}),
      ...(rt.effort ? { effort: rt.effort } : {}),
      ...(rt.permissionMode ? { permissionMode: rt.permissionMode } : {}),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      ...(rt.settings?.plugins ? { plugins: rt.settings.plugins } : {}),
      ...(rt.settings?.mcpServers ? { mcpServers: rt.settings.mcpServers } : {}),
      canUseTool: (toolName, toolInput, meta) =>
        this.handleCanUseTool(
          rt,
          (ev) => this.emit(rt, ev, rt.currentTurn ?? rt.activeTurn),
          () => rt.currentTurn?.turnId ?? rt.activeTurn?.turnId ?? "",
          toolName,
          toolInput,
          meta,
        ),
    };

    const channel = claudePromptChannel();
    const q = (this.options.queryFactory ?? query)({ prompt: channel.stream, options: sdkOptions });
    rt.promptChannel = channel;
    rt.activeQuery = q;
    rt.queryOptionsDirty = false;
    void q
      .initializationResult()
      .then((result) => {
        rt.modelInfos = result.models;
        rt.models = claudeModels(result.models);
      })
      .catch((error) => {
        this.options.log?.({
          level: "warn",
          source: "harness",
          component: "claude.initialization",
          harness: this.harness,
          turnId: rt.currentTurn?.turnId,
          message: "Claude SDK initialization result failed",
          error: logError(error),
        });
      });
    void this.consumeQuery(rt, q, channel);
  }

  private async consumeQuery(rt: ClaudeRuntime, q: Query, channel: ClaudePromptChannel): Promise<void> {
    try {
      for await (const sdkMessage of q) {
        const msg: ClaudeStreamMessage =
          claudeCommandLifecycleMessage(sdkMessage) ?? sdkMessage;
        this.options.nativeEvent?.({
          direction: "in",
          name: msg.type === "system" ? `system/${msg.subtype}` : msg.type,
          payload: msg,
        });
        let current = rt.currentTurn;
        if (!current) {
          if (msg.type === "system" && msg.subtype === "init") {
            this.publishSessionBinding(rt, msg.session_id);
          }
          continue;
        }
        const startsQueuedTurn =
          current.finalized &&
          msg.type === "command_lifecycle" &&
          msg.state === "started" &&
          rt.pendingOfferUuids?.has(commandLifecycleKey(msg)) === true;
        if (startsHarnessTurn(msg.type, current) || startsQueuedTurn) {
          current = this.mintHarnessTurn(rt);
          rt.currentTurn = current;
        }
        const emit: HarnessEventSink = (ev) => this.emit(rt, ev, current);
        this.handleMessage(rt, emit, msg, current);
      }
      const current = rt.currentTurn;
      if (current) {
        this.finishTurn(
          rt,
          (ev) => this.emit(rt, ev, current),
          current,
          current.cancelRequested ? "cancelled" : "end_turn",
        );
      }
    } catch (error) {
      // effort 变更或 close 会主动替换/清掉 query；旧消费循环此时无需制造错误事件。
      if (rt.activeQuery !== q) return;
      const current = rt.currentTurn;
      if (!current) return;
      const emit: HarnessEventSink = (ev) => this.emit(rt, ev, current);
      this.options.log?.({
        level: current.cancelRequested ? "info" : "error",
        source: "harness",
        component: "claude.query",
        harness: this.harness,
        turnId: current.turnId,
        message: current.cancelRequested ? "Claude SDK query stopped after cancellation" : "Claude SDK query failed",
        error: logError(error),
      });
      if (current.cancelRequested) {
        this.finishTurn(rt, emit, current, "cancelled");
      } else {
        emit({
          kind: "_baton_error_update",
          payload: { message: error instanceof Error ? error.message : String(error) },
        });
        this.finishTurn(rt, emit, current, "error");
      }
    } finally {
      if (rt.activeQuery === q) {
        this.failPendingOffers(rt, "Claude streaming query ended before queued message was applied");
        rt.activeQuery = undefined;
        rt.promptChannel = undefined;
      }
      channel.close();
    }
  }

  private closeStreamingQuery(rt: ClaudeRuntime): void {
    const queryHandle = rt.activeQuery;
    const channel = rt.promptChannel;
    rt.activeQuery = undefined;
    rt.promptChannel = undefined;
    rt.queryOptionsDirty = false;
    this.failPendingOffers(rt, "Claude streaming query closed before queued message was applied");
    channel?.close();
    queryHandle?.close();
  }

  /** query owner 消失后原生队列已不可证明；逐条悲观收口，避免 resume 后永久悬挂。 */
  private failPendingOffers(rt: ClaudeRuntime, reason: string): void {
    const pending = rt.pendingOfferUuids;
    if (!pending || pending.size === 0) return;
    for (const offer of pending.values()) {
      this.emit(
        rt,
        {
          kind: "input_delivery_update",
          payload: {
            messageId: offer.messageId,
            state: "failed",
            detail: reason,
          },
        },
        offer,
      );
      this.emit(
        rt,
        {
          kind: "_baton_notice",
          payload: {
            level: "warning",
            title: "Queued message was not applied",
            detail: `${reason}: ${offer.messageId}`,
          },
        },
        offer,
      );
    }
    pending.clear();
  }

  /**
   * 铸造 Harness 自行开始的 Turn，并以 Harness 来源的 running 开界。
   * 刻意不写 rt.activeTurn：它没有对应 Queue item；新 Queue-driven Turn 到达时
   * sendTurn 会先将它收口，再把用户输入送进同一个 streaming query。
   */
  private mintHarnessTurn(rt: ClaudeRuntime): ClaudeTurn {
    const harnessTurn: ClaudeTurn = { turnId: newId("t"), finalized: false, cancelRequested: false };
    this.emit(
      rt,
      { kind: "state_update", payload: { state: "running" } },
      harnessTurn,
    );
    return harnessTurn;
  }

  /**
   * 每个 turn 只发一次逻辑终态；result 消息、异常、流异常结束都收敛到这里。
   * 只允许终结传入的那个 turn：上一 turn 的流耗尽兜底不能误杀已经开始的下一 turn。
   */
  private finishTurn(rt: ClaudeRuntime, emit: HarnessEventSink, turn: ClaudeTurn, stopReason: string, raw?: unknown): void {
    if (turn.finalized) return;
    turn.finalized = true;
    emit({
      kind: "state_update",
      payload: { state: "idle", stopReason },
      ...(raw !== undefined ? { raw } : {}),
    });
    if (rt.activeTurn === turn) rt.activeTurn = undefined;
  }

  /** 信封补齐：open 绑定的 sink + 所属 turnId。turn 内发射必须显式传 turn；跨 turn 的事件不带 turnId */
  private emit(rt: ClaudeRuntime, ev: Parameters<HarnessEventSink>[0], turn?: Pick<ClaudeTurn, "turnId" | "replies">): void {
    rt.sink({
      ...((turn ?? rt.activeTurn)?.replies?.apply(ev) ?? ev),
      harnessSessionId: rt.claudeSessionId,
      turnId: (turn ?? rt.activeTurn)?.turnId,
    });
  }

  async cancel(ref: HarnessSessionHandle): Promise<void> {
    const rt = this.sessions.get(ref.handleId);
    const turn = rt?.activeTurn;
    if (!rt?.activeQuery || !turn) return;
    turn.cancelRequested = true;
    // streaming query 本身保持存活；SDK result 仍从 consumeQuery 收口当前 turn。
    const receipt = await rt.activeQuery.interrupt().catch((error) => {
      this.options.log?.({
        level: "warn",
        source: "harness",
        component: "claude.cancel",
        harness: this.harness,
        turnId: turn.turnId,
        message: "Claude SDK interrupt failed",
        error: logError(error),
      });
      return undefined;
    });
    // interrupt 不动 CLI 侧已排队的消息：steer offer 若实际被排队而非折进当前 turn，
    // 它会在 interrupt 之后自行开新 turn 跑起来。这里只做观测（匹配自己 offer 过的
    // uuid；回执里其余内部 uuid 按 SDK 契约忽略），量化后再决定是否撤回。
    for (const uuid of receipt?.still_queued ?? []) {
      const offer = rt.pendingOfferUuids?.get(uuid);
      if (!offer) continue;
      this.options.log?.({
        level: "warn",
        source: "harness",
        component: "claude.cancel",
        harness: this.harness,
        turnId: turn.turnId,
        message: `interrupt left steered message ${offer.messageId} (offered to turn ${offer.turnId}) queued CLI-side; it may still run as a new turn`,
      });
    }
  }

  async stopTask(ref: HarnessSessionHandle, taskId: string): Promise<void> {
    const rt = this.mustSession(ref);
    if (!rt.activeQuery) {
      throw new Error(`Claude task is no longer attached to a live query: ${taskId}`);
    }
    await rt.activeQuery.stopTask(taskId);
  }

  async cancelInput(ref: HarnessSessionHandle, messageId: string): Promise<boolean> {
    const rt = this.mustSession(ref);
    const query = rt.activeQuery as Partial<AsyncMessageCancellableQuery> | undefined;
    if (!query) return false;
    const pending = [...(rt.pendingOfferUuids?.entries() ?? [])].find(
      ([, offer]) => offer.messageId === messageId,
    );
    if (!pending) return false;
    if (typeof query.cancelAsyncMessage !== "function") {
      throw new Error("Claude SDK query does not support cancelling individual inputs");
    }
    // Keep the correlation until command_lifecycle(cancelled) emits the durable failed outcome.
    return query.cancelAsyncMessage(pending[0]);
  }

  async close(ref: HarnessSessionHandle): Promise<void> {
    const rt = this.sessions.get(ref.handleId);
    if (!rt) return;
    this.sessions.delete(ref.handleId);
    const turn = rt.activeTurn;
    if (turn) turn.cancelRequested = true;
    this.closeStreamingQuery(rt);
    // 宿主主动 close 时若仍有活跃 turn，合成终态，不留"已接受未终结"的悬挂状态
    if (turn) this.finishTurn(rt, (ev) => this.emit(rt, ev, turn), turn, "cancelled");
  }

  private mustSession(ref: HarnessSessionHandle): ClaudeRuntime {
    const rt = this.sessions.get(ref.handleId);
    if (!rt) throw new Error(`unknown claude session: ${ref.handleId}`);
    return rt;
  }

  private publishSessionBinding(rt: ClaudeRuntime, sessionId: string): void {
    rt.claudeSessionId = sessionId;
    if (rt.publishedSessionId === sessionId) return;
    rt.publishedSessionId = sessionId;
    rt.bindingSink?.({
      identity: { id: sessionId },
      resumeState: sessionIdResumeState(sessionId),
    });
  }

  /** Adapter-level seam retained for focused protocol mapping tests. */
  private handleCanUseTool(
    rt: Pick<ClaudeRuntime, "capturedProposedPlanKeys">,
    emit: HarnessEventSink,
    turnId: () => string,
    toolName: string,
    input: Record<string, unknown>,
    meta: ClaudePermissionMeta,
  ): Promise<PermissionResult> {
    return this.events.handleCanUseTool(rt, emit, turnId, toolName, input, meta);
  }

  /** Adapter-level seam retained for focused protocol mapping tests. */
  private handleMessage(
    rt: ClaudeRuntime,
    emit: HarnessEventSink,
    message: ClaudeStreamMessage,
    turn: ClaudeTurn,
  ): void {
    this.events.handleMessage(rt, emit, message, turn);
  }
}
