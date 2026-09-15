// Codex 接入：拉起 `codex app-server` 子进程（裸 `codex` 是交互式 TUI，headless 必须走这里），
// JSON-RPC over stdio，事件译成内部模型。方法集参考 tutti codex_appserver_adapter.go 与
// `codex app-server generate-json-schema` 的官方 schema（v0.143.0 验证）。见 docs/harness/codex.md。

import { spawn } from "node:child_process";
import { MessageReplies } from "../message-replies.ts";

import { FileHookTrustStore, type HookTrustStore } from "../../config/hook.ts";
import { logError } from "../../logging.ts";
import type {
  ConfigValue,
  SessionConfigOption,
  StopReason,
} from "../../event/index.ts";
import { textOf } from "../../event/index.ts";
import type { InteractionDraft } from "../../interaction/types.ts";
import type {
  AdapterCapabilities,
  HarnessAdapter,
  EffortOption,
  HarnessEventSink,
  HarnessSessionBindingSink,
  ModelOption,
  ModelConfiguration,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  SendTurnReceipt,
  HarnessSessionHandle,
  ApprovalRoute,
  ReconcileVerdict,
  TextgenRequest,
} from "../adapter.ts";
import { unsupportedPromptBlocks } from "../adapter.ts";
import { generateCodexStructured } from "./textgen.ts";
import { JsonRpcPeer } from "./jsonrpc.ts";
import { readCodexModelData } from "./catalog.ts";
import { CodexEventHandler } from "./events.ts";
import {
  sessionIdResumeState,
} from "../resume.ts";

import {
  CODEX_FAST_SERVICE_TIER,
  CODEX_FALLBACK_MODES,
  CODEX_STANDARD_SERVICE_TIER,
  codexCollaborationMode,
  codexEfforts,
  codexModels,
  codexModelSupportsEffort,
  codexModes,
  fastConfigOption,
  selectedCodexModel,
  updateCodexResolvedSettings,
  type CodexAdapterOptions,
  type CodexTurn,
  type ThreadRuntime,
} from "./runtime.ts";
export type { CodexAdapterOptions } from "./runtime.ts";
export {
  codexApprovalChoices,
  codexItemLifecycleDrafts,
  codexToolTerminalStatus,
  type CodexApprovalChoices,
} from "./mapping.ts";

import {
  codexCommandWithHookTrustBypass,
  codexHooksRequiringTrust,
  codexLaunchCommand,
  codexSupportsHookTrustPreflight,
  summarizeTrustedHookOwners,
} from "./launch.ts";
export {
  codexCommandWithHookTrustBypass,
  codexHooksRequiringTrust,
  codexLaunchCommand,
  codexSupportsHookTrustPreflight,
} from "./launch.ts";

function stopReasonOf(turnStatus: string): StopReason {
  switch (turnStatus) {
    case "completed":
      return "end_turn";
    case "interrupted":
      return "cancelled";
    default:
      return turnStatus; // 开放联合：failed 等原样透传
  }
}

import {
  RECONCILE_REQUEST_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
  STARTUP_REQUEST_TIMEOUT_MS,
  interruptCommandProcess,
  terminateCodexProcess,
} from "./process.ts";
import {
  OUTPUT_EVENT_KINDS,
  codexPromptInput,
  mapThreadStatus,
  openCodexThread,
} from "./thread.ts";
export { codexPromptInput, mapThreadStatus, openCodexThread } from "./thread.ts";

export class CodexAdapter implements HarnessAdapter {
  readonly harness = "codex";
  // steer 经 userMessage completed 回执显式报告 applied；cancel 会把原生
  // pending_input 变成不可达（Controller 在发 cancel 前 reclaim），正常结束的
  // turn 不消费完的 steer 则随下一 turn 应用、回执可能跨 Turn 迟到。
  readonly steering = {
    deliveryTracking: "explicit",
    cancelOwnership: "unreachable",
  } as const;
  // 可选能力接口落地并验证后才声明对应 marker——契约测试钉住
  // "声明支持就必须实现对应接口"。
  // sync：catch-up 走 turn/start.additionalContext（experimental API，initialize 已声明
  // experimentalApi）。曾用 thread/inject_items 注入独立 user message，但那会污染 codex
  // 原生历史（rollout 里出现无对应回合的悬空 user message）；additionalContext 由 codex
  // 以 contextual fragment 形态随本 turn 入史，且不过 UserPromptSubmit hook。
  readonly capabilities: AdapterCapabilities = {
    prompt: { image: { supported: true } },
    compact: { supported: true },
    sync: { supported: true },
    config: { supported: true },
    reconcile: { supported: true },
    approvalRouting: { supported: true },
    textgen: { supported: true },
  };
  private threads = new Map<string, ThreadRuntime>();
  private readonly hookTrustStore: HookTrustStore;
  private readonly events: CodexEventHandler;

  constructor(private options: CodexAdapterOptions) {
    this.hookTrustStore = options.hookTrustStore ?? new FileHookTrustStore("codex");
    this.events = new CodexEventHandler({
      openInteraction: options.openInteraction,
      ...(options.nativeEvent ? { nativeEvent: options.nativeEvent } : {}),
      ...(options.log ? { log: options.log } : {}),
      emit: (runtime, event, raw, turn) => this.emit(runtime, event, raw, turn),
      finishTurn: (runtime, turn, status) => this.finishTurn(runtime, turn, status),
      publishConfigSnapshot: (runtime, config, raw) =>
        this.publishConfigSnapshot(runtime, config, raw),
      flushPendingCancel: (runtime) => this.flushPendingCancel(runtime),
    });
  }

  /** TextGeneratable：一次性 `codex exec`，与 thread 生命周期完全无关（见 textgen.ts）。 */
  async generateStructured(request: TextgenRequest): Promise<unknown> {
    return generateCodexStructured(request, {
      command: codexLaunchCommand(this.options.command),
      env: this.options.env,
    });
  }

  private launch(command: string[], opts: OpenOptions, sink: HarnessEventSink): ThreadRuntime {
    const [cmd, ...args] = command;
    const child = spawn(cmd as string, args, {
      cwd: opts.cwd,
      // 继承 HOME 等本机环境：凭证零持有，复用 ~/.codex 登录态（见 docs/harness/codex.md）
      env: { ...process.env, ...opts.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      // A dedicated process group lets close() reap app-server descendants too
      // instead of only terminating the immediate child.
      detached: process.platform !== "win32",
    });
    const log = this.options.log ?? (() => {});
    const peer = new JsonRpcPeer((line) => child.stdin.write(line), log);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => peer.feed(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (!message) return;
      log({
        level: "warn",
        source: "harness",
        component: "codex.stderr",
        harness: this.harness,
        message: "codex app-server wrote to stderr",
        attributes: { output: message.slice(0, 4096) },
      });
    });

    const rt: ThreadRuntime = {
      child,
      peer,
      threadId: "",
      approvalRoute: null,
      serviceTier: null,
      sink,
    };
    // transport 终结 = 该 session 所有在途工作的终结点：pending JSON-RPC request 全部 reject，
    // 活跃 turn 必须在此合成终态，否则 controller 永远等不到 idle（见 docs/harness.md）。
    child.on("close", (code) => {
      if (!rt.closing && code !== 0) {
        log({
          level: "error",
          source: "harness",
          component: "codex.process",
          harness: this.harness,
          message: `codex app-server exited (code ${code})`,
        });
      }
      peer.close(`codex app-server exited (${code})`);
      if (!rt.closing) {
        this.failTurn(rt, rt.activeTurn, `codex app-server exited (code ${code})`);
      }
    });
    child.on("error", (error) => {
      log({
        level: "error",
        source: "harness",
        component: "codex.process",
        harness: this.harness,
        message: "codex app-server spawn error",
        error: logError(error),
      });
      peer.close(`codex app-server spawn error: ${error.message}`);
      this.failTurn(rt, rt.activeTurn, `codex app-server error: ${error.message}`);
    });
    peer.onNotification((method, params) => this.handleNotification(rt, method, params));
    peer.onServerRequest((method, params) => this.handleServerRequest(rt, method, params));
    return rt;
  }

  private async initialize(rt: ThreadRuntime): Promise<void> {
    await rt.peer.request(
      "initialize",
      {
        clientInfo: { name: "baton", version: "0.0.1", title: "baton" },
        capabilities: { experimentalApi: true },
      },
      { timeoutMs: STARTUP_REQUEST_TIMEOUT_MS },
    );
    rt.peer.notify("initialized", {});
  }

  async open(
    opts: OpenOptions,
    sink: HarnessEventSink,
    binding?: HarnessSessionBindingSink,
  ): Promise<HarnessSessionHandle> {
    const command = codexLaunchCommand(this.options.command);
    let rt = this.launch(command, opts, sink);
    try {
      await this.initialize(rt);

      if (codexSupportsHookTrustPreflight(command)) {
        const hooksResult = await rt.peer.request("hooks/list", {});
        const hooks = codexHooksRequiringTrust(hooksResult);
        const hooksNeedingUserTrust = hooks.filter(
          (hook) => !this.hookTrustStore.isTrusted(hook),
        );
        for (const warning of this.hookTrustStore.takeWarnings?.() ?? []) {
          this.emit(rt, {
            kind: "_baton_notice",
            payload: { level: "warning", title: "Could not load saved hook trust", detail: warning },
          });
        }
        let trustAll = hooks.length > 0 && hooksNeedingUserTrust.length === 0;
        if (trustAll) {
          this.emit(rt, {
            kind: "_baton_notice",
            payload: {
              level: "info",
              title: `Enabled ${hooks.length} previously trusted Codex hook${hooks.length === 1 ? "" : "s"}`,
              detail: summarizeTrustedHookOwners(hooks),
            },
          });
        }
        if (hooksNeedingUserTrust.length > 0) {
          const interaction: InteractionDraft = {
            kind: "hook_trust",
            harnessName: "Codex",
            hooks: hooksNeedingUserTrust,
          };
          const result = await this.options.openInteraction(interaction, { raw: hooksResult });
          if (result.kind === "cancelled") {
            throw new Error("Codex hook trust request was cancelled");
          }
          const trust = result.kind === "hook_trust" && result.outcome === "trusted";
          if (trust) {
            this.hookTrustStore.trust(hooksNeedingUserTrust);
          }
          trustAll = trust;
        }
        if (trustAll) {
          // app-server 没有写 trust 的 RPC。Baton 已持久校验精确 hash 后，用官方 bypass 参数
          // 重启；旧进程尚未创建 thread/turn，退出不会丢 harness 状态。
          rt.closing = true;
          rt.peer.close("codex app-server restarting with trusted hooks");
          await terminateCodexProcess(
            rt.child,
            this.options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS,
          );
          rt = this.launch(codexCommandWithHookTrustBypass(command), opts, sink);
          await this.initialize(rt);
        }
      }

      const opened = await openCodexThread(rt.peer, { ...opts, approvalReviewer: this.options.approvalReviewer });
      const threadId = opened.threadId;
      rt.threadId = threadId;
      rt.approvalRoute = opened.route;
      rt.serviceTier = opened.serviceTier;
      this.threads.set(threadId, rt);
      // thread/start|resume 已回吐当前 tier；先发布无额外 RPC 的最小快照，避免会话启动
      // 被 model/list 等可选 catalog 阻塞。首次 /config 或 /fast 会补齐完整快照。
      this.publishConfigSnapshot(rt, [fastConfigOption(rt.serviceTier)]);
      binding?.({
        identity: { id: threadId },
        resumeState: sessionIdResumeState(threadId),
      });
      return { harness: this.harness, handleId: threadId, resumed: opened.resumed };
    } catch (error) {
      // open() 尚未返回 HarnessSessionHandle，controller 无法调用 close()；adapter 必须清掉自己已启动的进程。
      rt.closing = true;
      rt.peer.close("codex app-server open failed");
      await terminateCodexProcess(
        rt.child,
        this.options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS,
      );
      throw error;
    }
  }

  /** ApprovalRoutable：报告 codex 回吐的生效路由，而非 baton 请求的值（企业策略可能打回）。 */
  approvalRoute(ref: HarnessSessionHandle): ApprovalRoute | null {
    return this.threads.get(ref.handleId)?.approvalRoute ?? null;
  }

  async listModels(ref: HarnessSessionHandle): Promise<ModelOption[]> {
    const rt = this.mustThread(ref);
    return codexModels(await rt.peer.request("model/list", { limit: 200 }));
  }

  async setModel(ref: HarnessSessionHandle, modelId: string | null): Promise<void> {
    const rt = this.mustThread(ref);
    const model = !modelId || modelId === "default" ? undefined : modelId;
    const catalog =
      rt.effortUsesDefault || rt.effortSelection || rt.mode
        ? await rt.peer.request("model/list", { limit: 200 })
        : undefined;
    const selected = catalog === undefined ? undefined : selectedCodexModel(catalog, model);
    if (rt.effortSelection && selected && !codexModelSupportsEffort(selected, rt.effortSelection)) {
      throw new Error(`Codex model ${selected.id} does not support effort ${rt.effortSelection}`);
    }
    if (rt.effortUsesDefault) rt.effort = selected?.defaultEffort;
    rt.model = model;
    if (catalog !== undefined) updateCodexResolvedSettings(rt, catalog);
  }

  async setModelConfiguration(ref: HarnessSessionHandle, configuration: ModelConfiguration): Promise<void> {
    const rt = this.mustThread(ref);
    const catalog = await readCodexModelData(rt.peer);
    const model = configuration.model === "default" ? undefined : configuration.model;
    const selected = selectedCodexModel(catalog, model);
    if (!selected) throw new Error(`Unknown Codex model: ${configuration.model}`);
    const effort = configuration.effort === "default" ? undefined : configuration.effort;
    if (effort && !codexModelSupportsEffort(selected, effort)) {
      throw new Error(`Codex model ${selected.id} does not support effort ${effort}`);
    }
    // No await after validation: sendTurn can never observe a half-applied pair.
    rt.model = model;
    // Keep the selected collaboration mode, but do not let its old effort override this pair.
    rt.modeEffort = undefined;
    rt.effortSelection = effort;
    rt.effortUsesDefault = effort === undefined;
    rt.effort = effort ?? selected.defaultEffort;
    updateCodexResolvedSettings(rt, catalog);
  }

  currentModel(ref: HarnessSessionHandle): string | null {
    return this.mustThread(ref).model ?? null;
  }

  async listEfforts(ref: HarnessSessionHandle): Promise<EffortOption[]> {
    const rt = this.mustThread(ref);
    return codexEfforts(await rt.peer.request("model/list", { limit: 200 }), rt.model);
  }

  async setEffort(ref: HarnessSessionHandle, effortId: string | null): Promise<void> {
    const rt = this.mustThread(ref);
    if (!effortId || effortId === "default") {
      const catalog = await rt.peer.request("model/list", { limit: 200 });
      rt.effort = selectedCodexModel(catalog, rt.model)?.defaultEffort;
      rt.effortSelection = undefined;
      rt.effortUsesDefault = true;
      updateCodexResolvedSettings(rt, catalog);
      return;
    }
    const catalog = await rt.peer.request("model/list", { limit: 200 });
    const selected = selectedCodexModel(catalog, rt.model);
    if (selected && !codexModelSupportsEffort(selected, effortId)) {
      throw new Error(`Codex model ${selected.id} does not support effort ${effortId}`);
    }
    rt.effort = effortId;
    rt.effortSelection = effortId;
    rt.effortUsesDefault = false;
    updateCodexResolvedSettings(rt, catalog);
  }

  currentEffort(ref: HarnessSessionHandle): string | null {
    return this.mustThread(ref).effortSelection ?? null;
  }

  private publishConfigSnapshot(rt: ThreadRuntime, options: SessionConfigOption[], raw?: unknown): void {
    rt.configOptions = options;
    this.emit(rt, { kind: "config_option_update", payload: { options } }, raw);
  }

  private async configSnapshot(rt: ThreadRuntime): Promise<SessionConfigOption[]> {
    // 一次 model/list 生成整份快照，避免 model 与 effort 来自两个不同时点的 catalog。
    const catalog = await rt.peer.request("model/list", { limit: 200 });
    updateCodexResolvedSettings(rt, catalog);
    const models = codexModels(catalog);
    const efforts = codexEfforts(catalog, rt.model);
    const selectedModel = selectedCodexModel(catalog, rt.model);
    const modes = await rt.peer
      .request("collaborationMode/list", {})
      .then(codexModes)
      // Old app-servers may not expose this endpoint. Once a mode was selected,
      // retain its two-state control during a transient catalog failure.
      .catch(() => rt.mode ? [...CODEX_FALLBACK_MODES] : []);
    return [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        value: rt.model ?? "default",
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
        value: rt.effortSelection ?? "default",
        options: efforts.map(({ id, label, description }) => ({
          value: id,
          name: label,
          ...(description ? { description } : {}),
        })),
      },
      fastConfigOption(rt.serviceTier, selectedModel),
      ...(modes.length > 0
        ? [{
            id: "mode",
            type: "select" as const,
            name: "Mode",
            category: "mode",
            value: rt.mode ?? "default",
            options: modes.map(({ id, label }) => ({
              value: id,
              name: label,
              description:
                id === "plan"
                  ? "Plan without modifying the workspace"
                  : "Allow normal implementation work",
            })),
          }]
        : []),
    ];
  }

  async getConfig(ref: HarnessSessionHandle): Promise<SessionConfigOption[]> {
    const rt = this.mustThread(ref);
    const options = await this.configSnapshot(rt);
    this.publishConfigSnapshot(rt, options);
    return options;
  }

  async setConfig(
    ref: HarnessSessionHandle,
    configId: string,
    value: ConfigValue,
  ): Promise<SessionConfigOption[]> {
    const rt = this.mustThread(ref);
    if (configId === "fast") {
      if (typeof value !== "boolean") {
        throw new Error("Codex config fast requires a boolean value");
      }
      if (value) {
        const catalog = await rt.peer.request("model/list", { limit: 200 });
        const selected = selectedCodexModel(catalog, rt.model);
        if (selected?.supportsFast === false) {
          throw new Error(`Codex model ${selected.id} does not support Fast mode`);
        }
      }
      await rt.peer.request("thread/settings/update", {
        threadId: rt.threadId,
        serviceTier: value ? CODEX_FAST_SERVICE_TIER : null,
      });
      // RPC 表示更新已通过预检并入队；settings/updated 到达后还会用权威值校准。
      rt.serviceTier = value ? CODEX_FAST_SERVICE_TIER : CODEX_STANDARD_SERVICE_TIER;
      return this.getConfig(ref);
    }
    if (typeof value !== "string") {
      throw new Error(`Codex config ${configId} requires a string value`);
    }
    if (configId === "model") {
      await this.setModel(ref, value);
    } else if (configId === "effort") {
      await this.setEffort(ref, value);
    } else if (configId === "mode") {
      if (value !== "default" && value !== "plan") {
        throw new Error(`Unknown Codex mode: ${value}`);
      }
      if (rt.activeTurn && !rt.activeTurn.finalized) {
        throw new Error("Cannot switch Codex mode while a turn is running");
      }
      const [modeResult, catalog] = await Promise.all([
        rt.peer.request("collaborationMode/list", {}),
        rt.peer.request("model/list", { limit: 200 }),
      ]);
      const selected = codexModes(modeResult).find((candidate) => candidate.id === value);
      if (!selected) throw new Error(`Unknown Codex mode: ${value}`);
      rt.mode = selected.id;
      rt.modeEffort = selected.effort;
      updateCodexResolvedSettings(rt, catalog);
    } else {
      throw new Error(`Unknown Codex session config: ${configId}`);
    }
    return this.getConfig(ref);
  }

  async reconcile(
    ref: HarnessSessionHandle,
    _turnId: string,
  ): Promise<ReconcileVerdict> {
    const rt = this.mustThread(ref);
    const response = await rt.peer.request(
      "thread/read",
      { threadId: rt.threadId, includeTurns: false },
      { timeoutMs: RECONCILE_REQUEST_TIMEOUT_MS },
    );
    const status = (
      response as {
        thread?: { status?: { type?: string; activeFlags?: string[] } };
      }
    ).thread?.status;
    return { state: mapThreadStatus(status), detail: status?.type };
  }

  async compactContext(ref: HarnessSessionHandle, turnId: string): Promise<PromptReceipt> {
    const rt = this.mustThread(ref);
    if (rt.activeTurn && !rt.activeTurn.finalized) {
      throw new Error(`codex turn ${rt.activeTurn.turnId} still active; cannot compact`);
    }
    const turn: CodexTurn = { turnId, finalized: false };
    rt.turnId = turnId;
    rt.activeTurn = turn;
    void rt.peer.request("thread/compact/start", { threadId: rt.threadId }).catch((error) => {
      this.failTurn(rt, turn, error instanceof Error ? error.message : String(error));
    });
    return { accepted: true };
  }

  /**
   * 统一输入入口：有匹配的活跃 Baton turn 时映射原生 `turn/steer`，否则发
   * `turn/start`。Adapter 以自身运行态做最终判断，Controller 不感知 Codex turn id。
   */
  async sendTurn(
    ref: HarnessSessionHandle,
    input: PromptInput,
  ): Promise<SendTurnReceipt> {
    const rt = this.mustThread(ref);
    const unsupported = unsupportedPromptBlocks(input.blocks, this.capabilities);
    if (unsupported.length) {
      throw new Error(`codex adapter does not support prompt block type(s): ${unsupported.join(", ")}`);
    }

    const activeTurn = rt.activeTurn;
    if (activeTurn && !activeTurn.finalized) {
      // race 防线：Controller 看到的 turn 已过期，或 turn/start 响应尚未给出 native id，
      // 都无法安全定向；拒绝后由 Controller 把原输入排成 follow-up。
      if (activeTurn.turnId !== input.turnId || !rt.codexTurnId) {
        return { accepted: false, effective: "rejected" };
      }
      const pendingSteers = (rt.pendingSteerMessageIds ??= new Set<string>());
      const inFlightSteers = (rt.inFlightSteerMessageIds ??= new Set<string>());
      pendingSteers.add(input.messageId);
      inFlightSteers.add(input.messageId);
      const settleAdmission = (receipt: SendTurnReceipt): SendTurnReceipt => {
        inFlightSteers.delete(input.messageId);
        return receipt;
      };
      try {
        await rt.peer.request("turn/steer", {
          threadId: rt.threadId,
          expectedTurnId: rt.codexTurnId,
          input: codexPromptInput(input.blocks),
          clientUserMessageId: input.messageId,
        });
      } catch (error) {
        // userMessage 原生回执比 RPC 错误更强：这种竞态下不能再降级成
        // follow-up，否则同一条用户输入会被执行两次。
        if (rt.appliedSteerMessageIds?.delete(input.messageId)) {
          return settleAdmission({ accepted: true, effective: "steer" });
        }
        pendingSteers.delete(input.messageId);
        return settleAdmission({
          accepted: false,
          effective: "rejected",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      if (rt.appliedSteerMessageIds?.delete(input.messageId)) {
        return settleAdmission({ accepted: true, effective: "steer" });
      }
      if (activeTurn.finalized || rt.activeTurn !== activeTurn) {
        pendingSteers.delete(input.messageId);
        return settleAdmission({
          accepted: false,
          effective: "rejected",
          reason: "active Codex turn completed before steer admission settled",
        });
      }
      // RPC 成功只证明进入 Codex pending_input；userMessage 通知才证明
      // 它已经在下一次 sampling 前写入模型上下文（回执走 input_delivery_update）。
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
        undefined,
        activeTurn,
      );
      return settleAdmission({ accepted: true, effective: "steer" });
    }

    const turn: CodexTurn = { turnId: input.turnId, finalized: false, replies: new MessageReplies([input.messageId]) };
    rt.turnId = input.turnId;
    rt.activeTurn = turn;
    // user_message / state_update(running) 由 controller 在出队时落盘（用户输入是 BatonSession
    // 的事实，且入参 blocks 可能含 <baton-sync> prepend，不能进正典历史）；adapter 只在
    // steer 成功时补 delivery:"steer" 的用户消息。

    // 跨 harness catch-up 随本 turn 送达：additionalContext 按 key 的 contextual
    // fragment（untrusted → user 语义）在 codex 侧与 prompt 同回合入史。admission 失败
    // 即未送达，controller 水位不动、下次重注入（PromptInput.syncBlocks 契约）。
    const syncText = input.syncBlocks?.length ? textOf(input.syncBlocks) : undefined;
    // fast-submit：turn/start 的响应立即返回 status=inProgress 的 Turn（旧版本才会阻塞到结束）。
    // 因此响应只用于拿 codex turn id 和捕获终态；正常结束以 turn/completed 通知为准。
    const collaborationMode = codexCollaborationMode(rt);
    void rt.peer
      .request("turn/start", {
        threadId: rt.threadId,
        input: codexPromptInput(input.blocks),
        ...(syncText ? { additionalContext: { "baton-sync": { value: syncText, kind: "untrusted" } } } : {}),
        ...(collaborationMode
          ? { collaborationMode }
          : {
              ...(rt.model ? { model: rt.model } : {}),
              ...(rt.effort ? { effort: rt.effort } : {}),
            }),
        // 不显式开启则 codex 不发 item/reasoning/* 通知，中间过程对用户不可见
        summary: "auto",
      })
      .then((resp) => {
        const started = (resp as { turn?: { id?: string; status?: string } }).turn;
        // 迟到响应（老版本阻塞到 turn 结束才回）可能落在下一 turn 已开始之后：
        // 只在自己仍是 active turn 时才写共享的 codexTurnId
        if (started?.id && rt.activeTurn === turn) {
          rt.codexTurnId = String(started.id);
          (rt.turnsByNativeId ??= new Map()).set(rt.codexTurnId, turn);
          this.flushPendingCancel(rt);
        }
        const status = started?.status;
        if (status && status !== "inProgress" && status !== "queued") {
          this.finishTurn(rt, turn, status);
        }
      })
      .catch((err) => {
        this.failTurn(rt, turn, err instanceof Error ? err.message : String(err));
      });
    return { accepted: true, effective: "new_turn" };
  }

  async cancel(ref: HarnessSessionHandle): Promise<void> {
    const rt = this.mustThread(ref);
    const turn = rt.activeTurn;
    if (!turn || turn.finalized) return;
    if (!rt.codexTurnId) {
      // fast-submit 窗口：codex turn id 尚未回，此刻无法定向 interrupt。记下意图，
      // id 就位后补发；即便补发失败，controller 的 cancel 宽限期兜底仍会合成终态。
      rt.pendingCancel = true;
      return;
    }
    for (const pid of rt.activeCommandProcesses?.values() ?? []) {
      interruptCommandProcess(pid);
    }
    await rt.peer.request("turn/interrupt", { threadId: rt.threadId, turnId: rt.codexTurnId });
  }

  /** cancel 早于 codex turn id 就位时的补发：fire-and-forget，失败由 controller 宽限期兜底 */
  private flushPendingCancel(rt: ThreadRuntime): void {
    if (!rt.pendingCancel || !rt.codexTurnId) return;
    rt.pendingCancel = false;
    void rt.peer.request("turn/interrupt", { threadId: rt.threadId, turnId: rt.codexTurnId }).catch(() => {});
  }

  async close(ref: HarnessSessionHandle): Promise<void> {
    const rt = this.threads.get(ref.handleId);
    if (!rt) return;
    this.threads.delete(ref.handleId);
    // 宿主主动关闭：活跃 turn 读作 cancelled；先终结再 kill，child close 回调就不会再合成 failed
    this.finishTurn(rt, rt.activeTurn, "interrupted");
    rt.closing = true;
    rt.peer.close("codex app-server closed by Baton");
    const closed = await terminateCodexProcess(
      rt.child,
      this.options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS,
    );
    if (!closed) {
      this.options.log?.({
        level: "warn",
        source: "harness",
        component: "codex.process",
        harness: this.harness,
        message: "codex app-server did not exit after SIGKILL",
      });
    }
  }

  private mustThread(ref: HarnessSessionHandle): ThreadRuntime {
    const rt = this.threads.get(ref.handleId);
    if (!rt) throw new Error(`unknown codex thread: ${ref.handleId}`);
    return rt;
  }

  /** 信封补齐。turn 终态类发射显式传所属 turn：迟到终态不能盖上共享 rt.turnId（已是最新 turn 的 id） */
  private emit(rt: ThreadRuntime, ev: Parameters<HarnessEventSink>[0], raw?: unknown, turn?: CodexTurn | null): void {
    // 空回合判定的记账点：任何可见产出都经过这里，集中标记比在各通知分支手工标记可靠
    const owner = turn === null ? undefined : turn ?? rt.activeTurn;
    if (owner && !owner.finalized && OUTPUT_EVENT_KINDS.has(ev.kind)) owner.sawOutput = true;
    rt.sink({ ...(owner?.replies?.apply(ev) ?? ev), harnessSessionId: rt.threadId, turnId: turn === null ? undefined : turn?.turnId ?? rt.turnId, raw });
  }

  /**
   * 每个 turn 只发一次逻辑终态；turn/completed 通知、turn/start 响应终态、transport 失败谁先到都行。
   * 只允许终结传入的 turn（同 claude adapter）：上一 turn 的迟到终态不能误杀已开始的下一 turn。
   */
  private finishTurn(rt: ThreadRuntime, turn: CodexTurn | undefined, turnStatus: string): void {
    if (!turn || turn.finalized) return;
    turn.finalized = true;
    // 空回合显式上报：completed 但没有任何可见产出，说明 prompt 在进模型前被丢弃
    // （codex core 对 hook 拦截等路径静默 return，prompt 也不进原生 history）。
    // 事故：bs_01KXCNW0WVA11NZH2F8FKTCJ5E 连续空回合被静默当正常 end_turn，表现为"吞消息"。
    if (turnStatus === "completed" && !turn.sawOutput) {
      const hookBlock = turn.hookBlock;
      this.emit(
        rt,
        {
          kind: "_baton_notice",
          payload: {
            level: "warning",
            title: "Codex returned an empty turn (no output)",
            detail: hookBlock
              ? `prompt blocked by hook ${hookBlock.source}${hookBlock.reason ? `: ${hookBlock.reason}` : ""}`
              : "prompt was likely dropped before reaching the model (e.g. blocked by a UserPromptSubmit hook) and is not part of the codex thread history",
          },
        },
        undefined,
        turn,
      );
    }
    this.emit(
      rt,
      {
        kind: "state_update",
        payload: { state: "idle", stopReason: stopReasonOf(turnStatus) },
      },
      undefined,
      turn,
    );
    if (rt.activeTurn === turn) {
      rt.activeTurn = undefined;
      rt.codexTurnId = undefined;
      rt.activeCommandProcesses?.clear();
      // cancel 后原生 pending_input 不可达（Controller reclaim 已收口）；正常结束的
      // turn 未消费的 steer 会随下一 turn 应用，userMessage 回执跨 Turn 迟到，记账保留。
      if (stopReasonOf(turnStatus) === "cancelled") {
        rt.pendingSteerMessageIds?.clear();
      }
      rt.pendingCancel = undefined; // turn 已终结，挂起的取消意图随之失效
    }
  }

  /** Adapter-level seam retained for focused turn-boundary tests. */
  private failTurn(rt: ThreadRuntime, turn: CodexTurn | undefined, message: string): void {
    this.events.failTurn(rt, turn, message);
  }

  /** Adapter-level seam retained for focused protocol mapping tests. */
  private handleNotification(rt: ThreadRuntime, method: string, params: unknown): void {
    this.events.handleNotification(rt, method, params);
  }

  /** Adapter-level seam retained for focused approval contract tests. */
  private handleServerRequest(rt: ThreadRuntime, method: string, params: unknown): Promise<unknown> {
    return this.events.handleServerRequest(rt, method, params);
  }

}
