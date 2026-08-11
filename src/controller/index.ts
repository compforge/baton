import {
  isContextSynchronizable,
  isContextCompactable,
  type AdapterCapabilities,
  type HarnessAdapter,
  type ApprovalRoute,
  type EffortOption,
  type InteractionContext,
  type InteractionHandler,
  type ModelOption,
  type NativeEventSink,
  type SendTurnReceipt,
} from "../harness/adapter.ts";
import { buildTargetCatchUpContext } from "../context/mention.ts";
import {
  ContextDeliveries,
  sessionHistoryContextSource,
  type ContextDeliveryTransport,
  type ContextSnapshotEnvelope,
} from "../context/delivery.ts";
import type { LogSink } from "../logging.ts";
import { logError } from "../logging.ts";
import { newId } from "../event/ids.ts";
import {
  type AnyEventDraft,
  type AnyEventEnvelope,
  type AnyNewEvent,
  type EventEnvelope,
  type EventSource,
  type ConfigValue,
  type PromptBlock,
  type SessionConfigOption,
  type StopReason,
} from "../event/types.ts";
import { HarnessBinding } from "../harness/binding.ts";
import type { HarnessTarget, HarnessTargetProbeResult } from "../harness/target.ts";
import type { TextgenCandidate } from "../harness/textgen.ts";
import { maybeGenerateSessionTitle } from "../session/title.ts";
import type {
  InteractionDraft,
  InteractionResult,
} from "../interaction/types.ts";
import { MAIN_LANE_ID, type SessionHandle } from "../store/store.ts";
import { DeliveryAttempts } from "./attempt.ts";
import {
  InputQueue,
  inputSnapshot,
  type InputRecord,
  type InputSource,
  type InputSnapshot,
  type QueuedTurnSnapshot,
  type SubmitOutcome,
} from "./input.ts";
import { InteractionWaiters } from "./interaction.ts";
import { TurnLedger, type TurnRecord } from "./turn.ts";

export type {
  InputSource,
  InputSnapshot,
  InputStatus,
  QueuedTurnSnapshot,
  SubmitOutcome,
} from "./input.ts";

export interface HarnessInvocationInput {
  readonly harnessInvocationId: string;
  readonly pluginInstanceId: string;
  readonly harnessTargetId: string;
  readonly laneId: string;
  readonly newLane: boolean;
  readonly parentLaneId?: string;
  readonly source: InputSource;
  readonly messageId: string;
  readonly turnId: string;
  readonly blocks: PromptBlock[];
}

export type HarnessInvocationCancellation = "queued" | "running";

function eventSourceOf(source: InputSource): EventSource {
  return source.type === "user"
    ? { type: "user" }
    : {
        type: "plugin",
        pluginInstanceId: source.pluginInstanceId,
      };
}

/**
 * Control：与 Input / Interaction result 并列的第三种用户信号
 * （见 docs/workflow.md“Input 到 Harness”）。
 * 不携带内容、不到达 model——是对 turn **生命周期**的命令，必须 out-of-band 够到正在跑的
 * turn（不进 queue，否则会排在它要打断的 turn 后面而死锁）。当前唯一 kind 是 `interrupt`
 * （Esc）；pause / abort-bash / shutdown 等作为新 kind 加入时按 kernel 演进规则处理。
 */
export type Control = { kind: "interrupt" };

/**
 * 用户 sendTurn 的调度结果（workflow：requested 与 effective 分开呈现）：
 * - `steer`：已注入当前 turn 的下一个安全边界，不产生新 turn；
 * - `new_turn`：已进入 Controller 的 driven turn 队列；`queued` 说明它是否在等待当前
 *   turn。outcome 在该 turn 完成/被撤回时 resolve。
 */
export type SendTurnOutcome =
  | { effective: "steer" }
  | {
      effective: "new_turn";
      queued: boolean;
      outcome: Promise<SubmitOutcome>;
      reason?: string;
    };

/** Controller 注入给 Adapter 的宿主能力；Interaction 必须经可信边界打开。 */
export interface InteractionHandlers {
  interactionHandler: InteractionHandler;
  log: LogSink;
  nativeEvent: NativeEventSink;
}

export interface ControllerOptions {
  session: SessionHandle;
  mentionBudgetChars: number;
  /** 新 session 未选过 model 时使用的 HarnessTarget 级持久偏好。 */
  modelPreferences?: Readonly<Record<string, string>>;
  /** 新 session 未选过 effort 时使用的 HarnessTarget 级持久偏好。 */
  effortPreferences?: Readonly<Record<string, string>>;
  /** 工厂按 target.harness 选择 Adapter，并可使用 target.id lowering 实例级配置。 */
  createAdapter(target: HarnessTarget, handlers: InteractionHandlers): HarnessAdapter;
  /** HarnessTarget identity 的唯一 owner；未知 id 必须返回 undefined，不能反推 Harness。 */
  resolveTarget(harnessTargetId: string): HarnessTarget | undefined;
  /** 不创建 HarnessSession 的 Target 级只读发现；缺省时兼容回落到 live binding。 */
  probeTarget?: (target: HarnessTarget, cwd: string) => Promise<HarnessTargetProbeResult>;
  /**
   * textgen 旁路生成（session 标题）的降级链候选 Target。当前 turn 的 target 自动前置
   * （优先沿用用户刚才选择的 provider），未声明 textgen capability 的由路由器跳过。
   * 缺省 = 只用当前 target，不跨 harness 降级。
   */
  textgenTargets?: readonly HarnessTarget[];
  /** 首选 textgen harness（canonical id 或 target id）；缺省 = 当前 turn 的 harness 优先。 */
  textgenPrefer?: string;
  /** 按 canonical harness id 覆盖 textgen 模型（ID 方言由各 adapter 收口）。 */
  textgenModels?: Record<string, string>;
  onChange?: () => void;
  /**
   * cancel 后等待 harness 确认终态的宽限期。到期仍无终态则合成 terminal error 并
   * 推进队列（workflow：除 cancel grace 与 transport close 外不设全局 watchdog，
   * 合法的长任务不应被误杀）。
   */
  cancelGraceMs?: number;
  /** Maximum concurrently running side Lanes. */
  sideLaneConcurrency?: number;
}

const DEFAULT_CANCEL_GRACE_MS = 10_000;
const DEFAULT_SIDE_LANE_CONCURRENCY = 4;

/** 打断标记文案：cancelled 终态时落一条 notice，TUI 时间线醒目提示（对齐 Codex 的体验） */
export const INTERRUPTED_NOTICE_TITLE = "Conversation interrupted — tell the agent what to do differently";

/**
 * 一个 BatonSession 的唯一 turn 编排入口：统一负责 harness 恢复、上下文追平与 Lane 调度。
 * UI 只提交意图和消费事件（经 SessionHandle.subscribe 订阅事件流），不能分别维护
 * 各 harness 的并发状态。
 *
 * turn 分两类生命周期（见 docs/workflow.md）：
 * - driven turn：baton 发起；每个 Lane 内串行，不同 Lane 可并行；
 * - observed turn：harness 自发（Harness 来源的 `state_update(running)` 开界），
 *   baton 不控制其开始，只划界、记账（turn summary + 同步水位），不进队列。
 *
 * 生命周期由 state event 驱动（workflow）：adapter.sendTurn 只确认接收，turn 的
 * 完成以 `state_update(idle)` 为准，经 finalize 按 baton turn id 幂等收口——
 * 重复/迟到的物理终态（reconnect、transport race）不会二次终结，也不会关闭更新的 turn。
 *
 * TurnLedger：driven/observed 统一入 `turns` 台账，终态一律按 envelope.turnId 查表
 * 路由（不看 binding——按 binding 路由在同 harness driven+observed 并发时会吞掉 observed
 * 的终态）。台账仅限制每个 Lane 同时一个 driven Turn；跨 Lane 并发由队列策略决定。
 */
export class Controller {
  /** Lane × HarnessTarget → live binding. */
  private readonly bindings = new Map<string, HarnessBinding>();
  private readonly mainQueue = new InputQueue();
  private readonly sideQueue = new InputQueue();
  private readonly turns = new TurnLedger<HarnessBinding>();
  private readonly deliveryAttempts: DeliveryAttempts<HarnessBinding>;
  private readonly contextDeliveries: ContextDeliveries<HarnessBinding>;
  private readonly interactions: InteractionWaiters<HarnessBinding>;
  private drainingMain = false;
  private activeSideRuns = 0;
  /** driven 工作从 Harness setup 开始即对 UI 可见。 */
  private readonly processing = new Map<
    string,
    { target: HarnessTarget; startedAt: number }
  >();

  constructor(private readonly options: ControllerOptions) {
    const concurrency = options.sideLaneConcurrency ?? DEFAULT_SIDE_LANE_CONCURRENCY;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("sideLaneConcurrency must be a positive integer");
    }
    this.deliveryAttempts = new DeliveryAttempts(
      (binding, event) =>
        this.appendEvent(binding, event, {
          type: "baton",
        }) as EventEnvelope<"_baton_delivery_attempt_update">,
      options.session.readEvents(),
    );
    this.contextDeliveries = new ContextDeliveries(
      (binding, event) => this.appendEvent(binding, event, { type: "baton" }),
      options.session.readEvents(),
    );
    this.interactions = new InteractionWaiters(
      (binding, event, source) => this.appendEvent(binding, event, source),
      () => this.changed(),
    );
  }

  /**
   * 用户完成一个未决 Interaction。先把用户事实持久化，再唤醒 Harness；没有活跃 continuation
   * 时返回 false，UI 据此提示 stale，而不是把响应写进一个无人消费的内存通道。
   */
  completeInteraction(interactionId: string, result: InteractionResult): boolean {
    return this.interactions.complete(interactionId, result);
  }

  private openHarnessInteraction(
    laneId: string,
    harnessTargetId: string,
    draft: InteractionDraft,
    context?: InteractionContext,
  ): Promise<InteractionResult> {
    const binding = this.bindings.get(this.bindingKey(laneId, harnessTargetId));
    if (!binding) return Promise.reject(new Error(`unknown Lane binding for interaction: ${laneId} × ${harnessTargetId}`));
    const active = this.turns.activeDriven(laneId);
    const turnId =
      context?.turnId ?? active?.turnId ?? binding.setupTurnId;
    return this.interactions.open(binding, draft, turnId, context);
  }

  private mainLaneId(): string {
    return MAIN_LANE_ID;
  }

  private activeMainTurn(): TurnRecord<HarnessBinding> | undefined {
    for (const record of this.turns.values()) {
      if (
        record.status === "active" &&
        record.role === "driven" &&
        record.laneId === MAIN_LANE_ID
      ) {
        return record;
      }
    }
    return undefined;
  }

  /** 当前 driven turn 的具体配置目标；Harness 类型只用于选择 Adapter。 */
  get activeHarnessTargetId(): string | undefined {
    const active = this.activeMainTurn();
    const processing = active
      ? this.processing.get(active.laneId)
      : [...this.processing.entries()].find(
          ([laneId]) => laneId === MAIN_LANE_ID,
        )?.[1];
    return processing?.target.id ?? active?.harnessTargetId;
  }

  /** 当前 driven turn 的 baton turn id；TUI 据此做 per-turn 投影（运行阶段等） */
  get activeTurnId(): string | undefined {
    return this.activeMainTurn()?.turnId;
  }

  /** 当前 turn 的起跑时刻（epoch ms）；elapsed 跳秒由 TUI 组件自理，这里只给起点 */
  get activeStartedAt(): number | undefined {
    const active = this.activeMainTurn();
    return (
      (active ? this.processing.get(active.laneId)?.startedAt : undefined) ??
      active?.startedAt
    );
  }

  /** 给 UI 做提交前提示；最终准入仍以 Adapter.sendTurn 为准。 */
  promptCapabilities(harnessTargetId: string): AdapterCapabilities["prompt"] {
    return this.bindingFor(this.mainLaneId(), harnessTargetId).adapter.capabilities.prompt;
  }

  get queueLength(): number {
    return this.mainQueue.length + this.sideQueue.length;
  }

  get queuedTurns(): QueuedTurnSnapshot[] {
    return [...this.mainQueue.snapshots, ...this.sideQueue.snapshots];
  }

  get sideRunCount(): number {
    return this.activeSideRuns;
  }

  /**
   * 所有**在世** Input 的只读快照：排队中的 follow-up + 当前 turn 的 admitted 输入 +
   * 已接受的 steer。终态输入（finalized/recalled/interrupted）不驻内存——其历史在事件流里
   * （`user_message`），与 turn 台账瘦身同一取舍。投影 / 诊断据此看到每条输入的 messageId 与消费状态。
   */
  get inputs(): InputSnapshot[] {
    const out: InputSnapshot[] = [];
    for (const input of this.mainQueue.queued) out.push(inputSnapshot(input));
    for (const input of this.sideQueue.queued) out.push(inputSnapshot(input));
    for (const record of this.turns.values()) {
      if (record.status !== "active") continue;
      if (record.turn) out.push(inputSnapshot(record.turn));
      for (const steer of record.steers ?? []) out.push(inputSnapshot(steer));
    }
    return out;
  }

  get isBusy(): boolean {
    return this.drainingMain;
  }

  submit(
    harnessTargetId: string,
    blocks: PromptBlock[],
    options?: { sourceProposedPlanId?: string },
  ): Promise<SubmitOutcome> {
    const target = this.targetFor(harnessTargetId);
    const laneId = this.mainLaneId();
    if (options?.sourceProposedPlanId) {
      if (
        this.inputs.some(
          (input) => input.sourceProposedPlanId === options.sourceProposedPlanId,
        )
      ) {
        throw new Error(`Proposed plan already has a pending implementation turn: ${options.sourceProposedPlanId}`);
      }
      const proposal = this.options.session
        .loadState()
        .proposedPlans.get(options.sourceProposedPlanId);
      if (!proposal) {
        throw new Error(`Proposed plan not found: ${options.sourceProposedPlanId}`);
      }
      if (proposal.implementationTurnId) {
        throw new Error(`Proposed plan already has an implementation turn: ${options.sourceProposedPlanId}`);
      }
    }
    const outcome = this.mainQueue.enqueue(target, laneId, blocks, options);
    this.changed();
    void this.drainMain();
    return outcome;
  }

  /** Materializes a scheduled HarnessInvocation without inferring Lane from source. */
  async enqueueHarnessInvocation(input: HarnessInvocationInput): Promise<SubmitOutcome> {
    if (
      this.inputs.some(
        (candidate) => candidate.harnessInvocationId === input.harnessInvocationId,
      )
    ) {
      return Promise.reject(
        new Error(`HarnessInvocation already has a live Input: ${input.harnessInvocationId}`),
      );
    }
    const target = this.targetFor(input.harnessTargetId);
    const parentLaneId = input.parentLaneId;
    if (input.newLane && !parentLaneId) {
      throw new Error(`HarnessInvocation ${input.harnessInvocationId} is missing parentLaneId`);
    }
    const laneId = input.newLane && parentLaneId
      ? this.options.session.ensureHarnessInvocationLane(
        input.laneId,
        input.harnessInvocationId,
        parentLaneId,
      ).laneId
      : this.options.session.requireLane(input.laneId).laneId;
    const queue = laneId === this.mainLaneId() ? this.mainQueue : this.sideQueue;
    const outcome = queue.enqueue(target, laneId, input.blocks, {
      source: input.source,
      harnessInvocationId: input.harnessInvocationId,
      identity: {
        messageId: input.messageId,
        turnId: input.turnId,
      },
    });
    this.changed();
    if (laneId === this.mainLaneId()) void this.drainMain();
    else this.drainSideLanes();
    return outcome;
  }

  /** Cancels a queued Request, or interrupts its already-admitted Turn. */
  cancelHarnessInvocation(harnessInvocationId: string): HarnessInvocationCancellation | undefined {
    const queued =
      this.mainQueue.cancelHarnessInvocation(harnessInvocationId) ??
      this.sideQueue.cancelHarnessInvocation(harnessInvocationId);
    if (queued) {
      this.changed();
      return "queued";
    }
    for (const active of this.turns.values()) {
      if (
        active.status === "active" &&
        active.turn?.harnessInvocationId === harnessInvocationId
      ) {
        void this.interruptRecord(active);
        return "running";
      }
    }
    return undefined;
  }

  /**
   * 用户输入的统一入口。没有更早 follow-up、目标与当前 driven turn 一致且 HarnessSession
   * 已就绪时，直接交给 Adapter 依据原生运行态决定 same-turn send；其余情况进入全局队列。
   * observed turn（harness 自发）不接受输入——Baton 不拥有其生命周期。
   */
  async sendTurn(
    harnessTargetId: string,
    blocks: PromptBlock[],
    options?: { sourceProposedPlanId?: string },
  ): Promise<SendTurnOutcome> {
    const laneId = this.mainLaneId();
    const active = this.turns.activeDriven(laneId);
    if (
      !options?.sourceProposedPlanId &&
      this.mainQueue.length === 0 &&
      active?.turn &&
      active.turn.target.id === harnessTargetId &&
      active.binding.ref
    ) {
      const messageId = newId("m");
      let receipt: SendTurnReceipt;
      try {
        receipt = await active.binding.adapter.sendTurn(active.binding.ref, {
          turnId: active.turnId,
          messageId,
          blocks,
        });
      } catch (error) {
        receipt = {
          accepted: false,
          effective: "rejected",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (receipt.effective === "steer") {
        // 已接受的 same-turn send 是一等 Input：挂到当前 turn，cancel 时统一迁移 interrupted。
        (active.steers ??= []).push(
          this.mainQueue.acceptSteer(
            active.turn.target,
            laneId,
            active.turnId,
            messageId,
            blocks,
          ),
        );
        this.changed();
        return { effective: "steer" };
      }
      if (receipt.effective === "new_turn") {
        throw new Error(
          `adapter ${active.binding.adapter.harness} opened a new turn while Baton turn ${active.turnId} is active`,
        );
      }
      return {
        effective: "new_turn",
        queued: true,
        outcome: this.submit(harnessTargetId, blocks, options),
        ...(receipt.effective === "rejected" && receipt.reason
          ? { reason: receipt.reason }
          : {}),
      };
    }

    const queued =
      Boolean(this.activeMainTurn()) ||
      this.drainingMain ||
      this.mainQueue.length > 0;
    return {
      effective: "new_turn",
      queued,
      outcome: this.submit(harnessTargetId, blocks, options),
    };
  }

  /** 只允许撤回尚未开始执行的最新 turn；已被 drain 取走的 active turn 不在此列。 */
  recallLatestQueued(): QueuedTurnSnapshot | undefined {
    const turn = this.mainQueue.recallLatestUser();
    if (!turn) return undefined;
    this.changed();
    return turn;
  }

  async listModels(harnessTargetId: string): Promise<ModelOption[]> {
    const target = this.targetFor(harnessTargetId);
    const probed = await this.options.probeTarget?.(target, this.options.session.meta.cwd);
    if (probed?.models) return probed.models;
    return (await this.ensureHarness(this.mainLaneId(), harnessTargetId)).listModels();
  }

  async setModel(harnessTargetId: string, modelId: string | null): Promise<void> {
    await (
      await this.ensureHarness(this.mainLaneId(), harnessTargetId)
    ).setModel(modelId);
    this.changed();
  }

  currentModel(harnessTargetId: string): string | null {
    const binding = this.bindings.get(this.bindingKey(this.mainLaneId(), harnessTargetId));
    if (binding) return binding.currentModel();
    this.targetFor(harnessTargetId);
    return (
      this.options.session.meta.harnessTargets[harnessTargetId]?.model ??
      this.options.modelPreferences?.[harnessTargetId] ??
      null
    );
  }

  async listEfforts(harnessTargetId: string): Promise<EffortOption[]> {
    const target = this.targetFor(harnessTargetId);
    const probed = await this.options.probeTarget?.(target, this.options.session.meta.cwd);
    if (probed?.efforts) return probed.efforts;
    return (await this.ensureHarness(this.mainLaneId(), harnessTargetId)).listEfforts();
  }

  async setEffort(harnessTargetId: string, effortId: string | null): Promise<void> {
    await (
      await this.ensureHarness(this.mainLaneId(), harnessTargetId)
    ).setEffort(effortId);
    this.changed();
  }

  currentEffort(harnessTargetId: string): string | null {
    const binding = this.bindings.get(this.bindingKey(this.mainLaneId(), harnessTargetId));
    if (binding) return binding.currentEffort();
    this.targetFor(harnessTargetId);
    return (
      this.options.session.meta.harnessTargets[harnessTargetId]?.effort ??
      this.options.effortPreferences?.[harnessTargetId] ??
      null
    );
  }

  currentMode(harnessTargetId: string): string {
    return this.options.session.meta.harnessTargets[harnessTargetId]?.mode ?? "default";
  }

  async getConfig(harnessTargetId: string): Promise<SessionConfigOption[]> {
    return (await this.ensureHarness(this.mainLaneId(), harnessTargetId)).getConfig();
  }

  async setConfig(
    harnessTargetId: string,
    configId: string,
    value: ConfigValue,
  ): Promise<SessionConfigOption[]> {
    const snapshot = await (
      await this.ensureHarness(this.mainLaneId(), harnessTargetId)
    ).setConfig(configId, value);
    this.changed();
    return snapshot;
  }

  /**
   * 用 harness 原生机制压缩当前上下文。它是一个没有 user_message 的 driven control turn：
   * 仍走统一 running → harness events → idle 流水线，因此 TUI、持久化与崩溃恢复不会旁路。
   */
  async compactContext(harnessTargetId: string): Promise<void> {
    if (this.drainingMain || this.mainQueue.length > 0) {
      throw new Error("/compact requires an idle session");
    }
    this.drainingMain = true;
    try {
      await this.runContextCompaction(harnessTargetId);
    } finally {
      this.drainingMain = false;
      this.changed();
      if (this.mainQueue.length > 0) void this.drainMain();
    }
  }

  private async runContextCompaction(harnessTargetId: string): Promise<void> {
    const target = this.targetFor(harnessTargetId);
    const laneId = this.mainLaneId();
    this.processing.set(laneId, { target, startedAt: Date.now() });
    let record: TurnRecord<HarnessBinding> | undefined;
    try {
      const binding = await this.ensureHarness(laneId, harnessTargetId);
      if (
        !binding.ref ||
        !binding.adapter.capabilities.compact?.supported ||
        !isContextCompactable(binding.adapter)
      ) {
        throw new Error(`${harnessTargetId} does not support /compact`);
      }

      const turnId = newId("t");
      const admitted = this.admitDrivenTurn(binding, {
        turnId,
        harnessSessionId: binding.sessionIdentity()?.id,
      });
      record = admitted.record;
      await binding.adapter.compactContext(binding.ref, turnId);
      await admitted.released;
    } catch (error) {
      this.options.session.log({
        level: "error",
        source: "baton",
        component: "controller.compact",
        harness: target.harness,
        harnessTargetId,
        turnId: record?.turnId,
        message: "harness context compaction failed",
        error: logError(error),
      });
      if (record && record.status !== "finalized") {
        this.synthesizeTerminal(record, {
          message: error instanceof Error ? error.message : String(error),
          stopReason: "error",
        });
      }
      throw error;
    } finally {
      this.processing.delete(laneId);
    }
  }

  /**
   * 该 harness 当前生效的审批路由；不支持该能力、或 harness 没报出来 → null，
   * 投影据此静默。不读 config：config 是意图，只有 harness 自己报的才是事实。
   */
  approvalRoute(harnessTargetId: string): ApprovalRoute | null {
    return this.bindings
      .get(this.bindingKey(this.mainLaneId(), harnessTargetId))
      ?.approvalRoute() ?? null;
  }

  /**
   * 施加一个 Control 信号（Input / Interaction result 之外的第三种用户信号，见
   * `Control`）。当前唯一
   * kind 是 `interrupt`（Esc）——打断当前 driven turn。新增 kind 时在此按 kind 分派。
   */
  async control(signal: Control): Promise<void> {
    switch (signal.kind) {
      case "interrupt":
        return this.interrupt();
    }
  }

  /**
   * Control:interrupt 的实现——中断当前 driven turn。确认以 harness 的 idle/cancelled 终态
   * 为准；宽限期内没等到则合成 terminal error，保证队列永远能推进（不能因 harness 失联而死锁）。
   * preparing（harness 冷启动中）无需确认：尚未向 harness 提交任何内容，立即合成取消。
   */
  private async interrupt(): Promise<void> {
    const active = this.activeMainTurn();
    if (!active) return;
    return this.interruptRecord(active);
  }

  private async interruptRecord(active: TurnRecord<HarnessBinding>): Promise<void> {
    if (!active.binding.ref) {
      // preparing：Esc 立即生效，不被冷启动绑住。启动流程继续完成——成功则 binding
      // 保留给后续 turn 复用；卡死由 adapter 的启动期超时兜底，不会永久占住队列。
      this.synthesizeTerminal(active, { stopReason: "cancelled" });
      return;
    }
    active.cancelGraceTimer ??= setTimeout(() => {
      this.synthesizeTerminal(active, {
        message: "cancel grace period expired without harness confirmation",
        stopReason: "cancelled",
      });
    }, this.options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
    try {
      await active.binding.adapter.cancel(active.binding.ref);
    } catch (error) {
      this.options.session.log({
        level: "error",
        source: "baton",
        component: "controller.cancel",
        harness: active.harness,
        harnessTargetId: active.harnessTargetId,
        turnId: active.turnId,
        message: "harness cancel request failed",
        error: logError(error),
      });
      // cancel 请求本身失败（transport 已断等）：不再等 harness，直接合成终态
      this.synthesizeTerminal(active, {
        message: `cancel request failed: ${error instanceof Error ? error.message : String(error)}`,
        stopReason: "cancelled",
      });
    }
  }

  async close(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const binding of this.bindings.values()) {
      if (binding.ref) {
        closing.push(
          binding.close().catch((error) => {
            this.options.session.log({
              level: "warn",
              source: "baton",
              component: "controller.close",
              harness: binding.adapter.harness,
              harnessTargetId: binding.target.id,
              message: "harness close failed",
              error: logError(error),
            });
          }),
        );
      }
    }
    await Promise.all(closing);
  }

  private async drainMain(): Promise<void> {
    if (this.drainingMain) return;
    this.drainingMain = true;
    try {
      while (this.mainQueue.length > 0) {
        const turn = this.mainQueue.dequeue() as InputRecord;
        this.changed();
        try {
          await this.runTurn(turn);
          turn.resolve?.("completed");
        } catch (error) {
          turn.reject?.(error);
        }
      }
    } finally {
      this.drainingMain = false;
      this.changed();
    }
  }

  private drainSideLanes(): void {
    const concurrency = this.options.sideLaneConcurrency ?? DEFAULT_SIDE_LANE_CONCURRENCY;
    while (this.activeSideRuns < concurrency && this.sideQueue.length > 0) {
      const turn = this.sideQueue.dequeue(
        (candidate) => !this.processing.has(candidate.laneId) &&
          !this.turns.activeDriven(candidate.laneId),
      );
      if (!turn) return;
      this.activeSideRuns++;
      this.changed();
      void this.runTurn(turn)
        .then(() => turn.resolve?.("completed"), (error) => turn.reject?.(error))
        .finally(() => {
          this.activeSideRuns--;
          this.changed();
          this.drainSideLanes();
        });
    }
  }

  /**
   * driven turn 开界的唯一入口（见 docs/workflow.md“Turn 开界”）：入台账、置为当前 driven turn、
   * 落 user_message + state_update(running)。**control turn**（/compact 这类无用户
   * 输入、占用 turn 形状的控制操作）不传 input，跳过 user_message——两类 driven turn
   * 的开界序列只活在这里，不允许旁路再手搭一份。
   */
  private admitDrivenTurn(
    binding: HarnessBinding,
    opts: { turnId: string; input?: InputRecord; harnessSessionId?: string },
  ): { record: TurnRecord<HarnessBinding>; released: Promise<void> } {
    const admitted = this.turns.admitDriven(binding, opts.turnId, opts.input);
    if (opts.input) {
      const inputEvent = this.appendEvent(
        binding,
        {
          kind: "user_message",
          harnessSessionId: opts.harnessSessionId,
          turnId: opts.turnId,
          payload: { messageId: opts.input.messageId, content: opts.input.blocks },
        },
        eventSourceOf(opts.input.source),
      );
      admitted.record.inputEventId = inputEvent.eventId;
    }
    this.appendEvent(
      binding,
      {
        kind: "state_update",
        harnessSessionId: opts.harnessSessionId,
        turnId: opts.turnId,
        payload: { state: "running" },
      },
      { type: "baton" },
    );
    return admitted;
  }

  private async runTurn(turn: InputRecord): Promise<void> {
    this.processing.set(turn.laneId, {
      target: turn.target,
      startedAt: Date.now(),
    });

    // 出队即入账、即落盘：用户输入是 BatonSession 的事实，owner 是 controller——
    // 不等 harness 冷启动（codex 首启要 spawn → initialize → thread resume/start，
    // 可达数秒，期间 Transcript 必须已能看到这条输入）。落盘的是**原始输入** turn.blocks：
    // <baton-sync> 注入只进 harness transport（syncContext / prepend），不进正典历史。
    let binding: HarnessBinding;
    let record: TurnRecord<HarnessBinding>;
    let released: Promise<void>;
    try {
      binding = this.bindingFor(turn.laneId, turn.target.id, turn.turnId);
      const lane = this.options.session.meta.lanes[turn.laneId];
      if (!lane) throw new Error(`Lane not found: ${turn.laneId}`);
      ({ record, released } = this.admitDrivenTurn(binding, {
        turnId: turn.turnId,
        input: turn,
        harnessSessionId: lane.harnessSessions[turn.target.id]?.harnessSessionId,
      }));
    } catch (error) {
      this.processing.delete(turn.laneId);
      this.changed();
      throw error;
    }
    const targetKey = binding.target.id;
    const coldStart = !binding.ref;
    if (coldStart) {
      // 冷启动阶段对用户可见（否则 spinner 只能显示误导性的 thinking…）；
      // idle 终态会连带清掉 phase，失败/取消路径无需单独收尾
      this.appendEvent(
        binding,
        {
          kind: "_baton_run_status",
          turnId: turn.turnId,
          payload: { phase: "starting", title: `Starting ${turn.target.harness}…` },
        },
        { type: "baton" },
      );
    }

    try {
      await this.ensureHarness(turn.laneId, turn.target.id);
      // preparing 期间被取消：终态已合成、summary 已落，不再向 harness 提交
      if (record.status === "finalized") return;
      if (!binding.ref) throw new Error(`${targetKey} failed to start`);
      if (coldStart) {
        this.appendEvent(
          binding,
          {
            kind: "_baton_run_status",
            turnId: turn.turnId,
            payload: { phase: null },
          },
          { type: "baton" },
        );
      }

      const session = this.options.session;
      const meta = session.meta.lanes[turn.laneId]?.harnessSessions[turn.target.id];
      const contextEpochId = binding.contextEpochId;
      if (!contextEpochId) {
        throw new Error(`${targetKey} opened without a ContextEpoch`);
      }
      // Receipt 是事实来源；syncedSeq 只给尚未产生新事件的旧会话做迁移兜底。
      const sinceSeq =
        this.contextDeliveries.epoch(contextEpochId)?.throughSeq ?? meta?.syncedSeq ?? 0;
      const catchUp = buildTargetCatchUpContext(session, {
        target: binding.target,
        laneId: binding.laneId,
        sinceSeq,
        includeTargetTurns: binding.freshHarnessSession,
        budgetChars: this.options.mentionBudgetChars,
      });
      let blocks = turn.blocks;
      let syncBlocks: PromptBlock[] | undefined;
      // 水位（syncedSeq）只在注入时前进到本批 throughSeq（并发正确性的关键：
      // throughSeq 固定在注入时点，turn 运行期间其它 harness 落盘的事件 seq 必然
      // 大于它，下一次注入自然回补；finalize 推尾水位则会永久越过它们）。
      let submitContext:
        | {
            snapshot: ContextSnapshotEnvelope;
            transport: ContextDeliveryTransport;
          }
        | undefined;
      if (catchUp) {
        const snapshot = this.contextDeliveries.prepare(binding, {
          turnId: turn.turnId,
          harnessSessionId: binding.sessionIdentity()?.id,
          source: sessionHistoryContextSource(session.id),
          afterSeq: sinceSeq,
          throughSeq: catchUp.throughSeq,
          text: catchUp.text,
        });
        const syncBlock: PromptBlock = {
          type: "text",
          text: `<baton-sync>\n${catchUp.text}\n</baton-sync>`,
        };
        if (isContextSynchronizable(binding.adapter)) {
          await binding.adapter.syncContext(binding.ref, [syncBlock]);
          this.acceptContextDelivery(binding, snapshot, "sync_context");
        } else {
          // 随本 turn 的 sendTurn 送达（原生 side-channel 或 prepend）；两种形态共享
          // 同一水位语义：admission 通过后才推进，失败则下次重注入
          if (binding.adapter.capabilities.sync?.supported) {
            syncBlocks = [syncBlock];
            submitContext = { snapshot, transport: "submit_side_channel" };
          } else {
            blocks = [syncBlock, { type: "text", text: "\n\n" }, ...blocks];
            submitContext = { snapshot, transport: "prompt_prepend" };
          }
        }
      }

      if (!meta?.launchSnapshot) {
        throw new Error(
          `cannot prepare harness delivery for turn ${record.turnId}: missing HarnessLaunchSnapshot`,
        );
      }
      const attempt = this.deliveryAttempts.prepare(binding, {
        turnId: record.turnId,
        inputEventId: record.inputEventId,
        inputId: turn.messageId,
        launchSnapshot: meta.launchSnapshot,
        harnessSessionId: meta.harnessSessionId ?? binding.sessionIdentity()?.id,
      });
      this.deliveryAttempts.markDispatching(binding, attempt);

      // sendTurn 回执只确认 Adapter 接受本次投递责任；Harness 终态仍由 idle Event 收口。
      // Adapter 契约规定：throw 只发生在接受责任之前；接受后即使原生 transport 失败，
      // 也必须经事件流报告终态，不能把不确定性藏进一个迟到 rejection。
      try {
        const receipt = await binding.adapter.sendTurn(binding.ref, {
          turnId: turn.turnId,
          messageId: turn.messageId,
          blocks,
          ...(syncBlocks ? { syncBlocks } : {}),
        });
        if (receipt.effective !== "new_turn") {
          const reason =
            receipt.effective === "rejected" && receipt.reason
              ? `: ${receipt.reason}`
              : "";
          throw new Error(
            `adapter ${binding.adapter.harness} rejected new Baton turn ${turn.turnId}${reason}`,
          );
        }
      } catch (error) {
        this.deliveryAttempts.finalize(binding, attempt, "not_accepted", {
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      this.deliveryAttempts.markAccepted(binding, attempt);
      if (turn.sourceProposedPlanId) {
        // 只在 Adapter 已接受投递责任后建立因果边；启动/admission 失败不能把提案误标为执行中。
        this.appendEvent(
          binding,
          {
            kind: "proposed_plan_implementation_started",
            turnId: turn.turnId,
            payload: {
              planId: turn.sourceProposedPlanId,
              implementationTurnId: turn.turnId,
            },
          },
          { type: "baton" },
        );
      }
      if (submitContext) {
        // admission 通过 ⇒ 随 sendTurn 送达的 sync 块（syncBlocks 或 prepend）已进入 harness
        // 输入：视为同步到 throughSeq。
        // admission 失败走 catch 上抛，水位不动，下次重新注入。
        this.acceptContextDelivery(
          binding,
          submitContext.snapshot,
          submitContext.transport,
        );
      }
      await released;
    } catch (error) {
      // preparing 期间被取消、随后启动又失败：用户已收到 cancelled 终态并继续别的事，
      // 迟到的启动错误不再作为本 turn 的失败上抛（事件历史已闭合）
      if (record.status === "finalized") return;
      const detail = error instanceof Error ? error.message : String(error);
      this.options.session.log({
        level: "error",
        source: "baton",
        component: "controller.turn",
        harness: turn.target.harness,
        harnessTargetId: targetKey,
        turnId: turn.turnId,
        message: "harness startup or prompt admission failed",
        error: logError(error),
      });
      // 启动/admission 失败：合成结构化终态（error + idle + summary）——user_message 已
      // 落盘，必须有结局，不允许"输入消失且无历史"的半状态；随后仍上抛给 submit 调用方。
      this.synthesizeTerminal(record, { message: detail, stopReason: "error" });
      throw new Error(`BatonSession ${this.options.session.id} · ${targetKey}: ${detail}`, {
        cause: error,
      });
    } finally {
      this.processing.delete(turn.laneId);
      this.changed();
    }
  }

  /**
   * Receipt 必须先进入 session ledger，ContextEpoch 和 meta 缓存随后才前进。
   * adapter admission 仅证明 transport 接受，不扩大成“model 已读”的承诺。
   */
  private acceptContextDelivery(
    binding: HarnessBinding,
    snapshot: ContextSnapshotEnvelope,
    transport: ContextDeliveryTransport,
  ): void {
    const contextEpochId = binding.contextEpochId;
    if (!contextEpochId) {
      throw new Error(`${binding.target.id} cannot accept context without a ContextEpoch`);
    }
    const harnessSessionId = binding.sessionIdentity()?.id;
    this.contextDeliveries.accept(binding, snapshot, {
      contextEpochId,
      harnessSessionId,
      transport,
    });
    const session = this.options.session;
    const laneId = binding.laneId;
    const existing = session.meta.lanes[laneId]?.harnessSessions[binding.target.id];
    session.setLaneHarnessSession(laneId, binding.target.id, {
      ...existing,
      harness: binding.adapter.harness,
      harnessSessionId:
        existing?.harnessSessionId ?? harnessSessionId,
      contextEpochId,
      syncedSeq: snapshot.payload.throughSeq,
    });
    binding.freshHarnessSession = false;
  }

  /**
   * 所有事件的唯一入口（adapter 上报 + controller 自有：出队 user_message/running、
   * 合成终态）：持久化（append 即广播给事件流订阅者，UI 投影由订阅侧完成，
   * 这里不做任何转发）→ 识别 turn 边界并记账。
   * 不变量：任何进入本方法的事件必然对订阅者可见——投影正确性由 append 广播
   * 单通道保证，不依赖"是否有活跃 turn"。
   */
  private appendEvent(
    binding: HarnessBinding,
    ev: AnyEventDraft,
    source: EventSource,
  ): AnyEventEnvelope {
    const envelope = this.options.session.append({
      ...ev,
      source,
      harness: binding.adapter.harness,
      harnessTargetId: binding.target.id,
      laneId: binding.laneId,
    } as AnyNewEvent) as AnyEventEnvelope;
    if (envelope.kind === "state_update") {
      const p = envelope.payload;
      if (p.state === "running" && envelope.source.type === "harness" && envelope.turnId) {
        // observed turn 开界：登记入台账，不进队列（见 docs/workflow.md）
        this.turns.observe(binding, envelope.turnId);
      } else if (p.state === "idle") {
        // 终态一律按 baton turn id 查表路由（不看 binding）。无 turnId 的终态：
        // 已持久化留痕，但无法归属任何 turn，不驱动生命周期（adapter 契约要求
        // 终态必带 turnId，由契约测试钉住）。
        if (envelope.turnId) {
          // Attempt 对账先于 Turn 幂等收口：cancel grace 后迟到的 Harness idle 虽然不能
          // 二次 finalize Turn，却仍是把 uncertain Attempt 收敛到终态的权威 Receipt。
          this.deliveryAttempts.observeTerminal(binding, envelope);
          this.finalize(envelope);
        }
      }
    }
    // append 已同步广播给投影；普通流式事件不能再走 controller 通知，否则每个 chunk
    // 都会重建两次完整 view。终态对 controller 私有台账的变更由 finalize 自己通知。
    return envelope;
  }

  /**
   * 所有 turn 的统一有序 finalize 路径（见 docs/workflow.md“Turn 收口”）：终态已持久化 →
   * （driven 被打断时）interrupted notice → 一次 turn summary → 同步元数据 →
   * （driven）释放等待者推进队列。observed 只记账，不碰队列——summary 让 harness
   * 自发产出进入 @ 引用与跨 harness catch-up 的正典历史，否则后台唤醒的结论对
   * 下一棒 harness 是永久盲区。
   * 按 baton turn id 幂等：迟到/重复/未知终态一律 inert，不会关闭更新的 turn。
   */
  private finalize(terminal: EventEnvelope<"state_update">): void {
    const turnId = terminal.turnId;
    if (!turnId) return;
    const stopReason = terminal.payload.stopReason;
    const record = this.turns.beginFinalization(turnId, stopReason);
    if (!record) return;

    // cancel-cascade：本 turn 仍挂起的 Interaction 随收口一并了结，绝不留悬挂 continuation。
    // Controller 先持久化 interaction.cancelled，再唤醒 Adapter；参考 codex
    // clear_pending_waiters→Abort、opencode interrupt 的 ensuring(pending.delete)。
    // 顺序天然对：finalize 发生在 adapter.cancel 之后（先中断 turn，再收 pending），不会让取消以
    // model 可见的 tool rejection 抢在 turn 中断之前冒出来。
    this.interactions.cancelForTurn(turnId);

    const session = this.options.session;

    // 用户打断的 turn 在时间线留下醒目标记；排队的后续输入会自然跟在标记后面
    if (record.role === "driven" && stopReason === "cancelled") {
      session.append({
        kind: "_baton_notice",
        source: { type: "baton" },
        harness: record.harness,
        harnessTargetId: record.harnessTargetId,
        laneId: record.laneId,
        turnId,
        payload: { level: "warning", title: INTERRUPTED_NOTICE_TITLE },
      });
    }

    session.summarizeTurnEvent(turnId);
    if (record.role === "driven") record.binding.freshHarnessSession = false;

    this.turns.finish(record, stopReason);
    if (
      record.role === "driven" &&
      record.laneId === MAIN_LANE_ID
    ) {
      this.maybeGenerateTitle(record.harnessTargetId);
    }
    this.changed();
  }

  /**
   * session 标题的 LLM 生成（fire-and-forget 旁路）：首个 driven turn 收口后触发一次，
   * 失败/降级全部在 textgen 路由器内收口，主流程无感。护栏（用户命名不覆盖）在
   * maybeGenerateSessionTitle 内，含落盘前复查。
   */
  private titleGenAttempted = false;

  private maybeGenerateTitle(currentTargetId: string): void {
    if (this.titleGenAttempted) return;
    this.titleGenAttempted = true;
    const session = this.options.session;
    const candidates = this.textgenCandidates(currentTargetId);
    if (candidates.length === 0) return;
    void maybeGenerateSessionTitle({
      session,
      candidates,
      ...(this.options.textgenModels ? { models: this.options.textgenModels } : {}),
      log: (entry) => session.log(entry),
    })
      .then((updated) => {
        // Session metadata 不走 Event broadcast；标题落盘后显式刷新当前投影。
        if (updated) this.changed();
      })
      .catch((error) => {
        session.log({
          level: "warn",
          source: "baton",
          component: "textgen",
          message: "session title generation failed",
          attributes: { error: error instanceof Error ? error.message : String(error) },
        });
      });
  }

  /**
   * 降级链排序：显式 prefer → 当前 turn 的 target → 其余候选。
   * 已有 live binding 的复用其 adapter（省一次构造），其余经工厂新建——textgen 是
   * 一次性调用，不需要 open()。
   */
  private textgenCandidates(currentTargetId: string): TextgenCandidate[] {
    const ordered: HarnessTarget[] = [];
    const seen = new Set<string>();
    const push = (target: HarnessTarget | undefined) => {
      if (target && !seen.has(target.id)) {
        seen.add(target.id);
        ordered.push(target);
      }
    };
    const prefer = this.options.textgenPrefer;
    if (prefer) {
      push((this.options.textgenTargets ?? []).find((t) => t.id === prefer || t.harness === prefer));
    }
    push(this.options.resolveTarget(currentTargetId));
    for (const target of this.options.textgenTargets ?? []) push(target);

    const candidates: TextgenCandidate[] = [];
    for (const target of ordered) {
      try {
        candidates.push({
          harness: target.harness,
          adapter:
            this.bindings.get(
              this.bindingKey(this.mainLaneId(), target.id),
            )?.adapter ??
            this.options.createAdapter(target, {
              interactionHandler: () =>
                Promise.reject(new Error("textgen cannot open Harness interactions")),
              log: (entry) => this.options.session.log({ ...entry, harnessTargetId: target.id }),
              // textgen adapter 不开 session、不上报原生事件；sink 就位但不产生流量。
              nativeEvent: () => {},
            }),
        });
      } catch (error) {
        // 候选构造也是降级链的一部分；某个 provider 配置损坏不能阻断其他家。
        this.options.session.log({
          level: "warn",
          source: "baton",
          component: "textgen",
          harness: target.harness,
          harnessTargetId: target.id,
          message: "textgen candidate initialization failed, falling back",
          attributes: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    return candidates;
  }

  /**
   * controller 合成终态：可选的结构化 error 留痕 + idle，走统一事件管线（→ finalize）。
   * 使用方：cancel 宽限期到期 / cancel 请求失败 / preparing 取消（无 error，纯 cancelled）/
   * 启动与 admission 失败（stopReason:"error"）。
   */
  private synthesizeTerminal(
    record: TurnRecord<HarnessBinding>,
    opts: { message?: string; stopReason: StopReason },
  ): void {
    if (record.status === "finalized") return;
    if (opts.message !== undefined) {
      this.appendEvent(
        record.binding,
        {
          kind: "_baton_error_update",
          turnId: record.turnId,
          payload: { message: opts.message, retryable: false },
        },
        { type: "baton" },
      );
    }
    this.appendEvent(
      record.binding,
      {
        kind: "state_update",
        turnId: record.turnId,
        payload: { state: "idle", stopReason: opts.stopReason },
      },
      { type: "baton" },
    );
  }

  /**
   * 同步获取（创建即启动）HarnessBinding：Adapter 构造和可信 Event sink 在这里绑定，
   * runTurn 因此能在 open() 完成之前落 user_message。实际启动生命周期由 binding 拥有。
   */
  private bindingKey(laneId: string, harnessTargetId: string): string {
    return `${laneId}\0${harnessTargetId}`;
  }

  private bindingFor(
    laneId: string,
    harnessTargetId: string,
    setupTurnId?: string,
  ): HarnessBinding {
    const key = this.bindingKey(laneId, harnessTargetId);
    let binding = this.bindings.get(key);
    if (!binding) {
      const lane = this.options.session.meta.lanes[laneId];
      if (!lane) throw new Error(`Lane not found: ${laneId}`);
      const target = this.targetFor(harnessTargetId);
      const adapter = this.options.createAdapter(target, {
        interactionHandler: (interaction, context) =>
          this.openHarnessInteraction(laneId, target.id, interaction, context),
        log: (entry) =>
          this.options.session.log({ ...entry, harnessTargetId: target.id }),
        nativeEvent: (event) =>
          this.options.session.nativeEvent(
            target.id,
            target.harness,
            event,
            laneId,
          ),
      });
      let created!: HarnessBinding;
      created = new HarnessBinding({
        laneId,
        target,
        cwd: this.options.session.meta.cwd,
        adapter,
        session: this.options.session,
        setupTurnId,
        modelPreference: this.options.modelPreferences?.[target.id],
        effortPreference: this.options.effortPreferences?.[target.id],
        eventSink: (event) =>
          this.appendEvent(created, event, {
            type: "harness",
            harnessTargetId: created.target.id,
          }),
      });
      binding = created;
      this.bindings.set(key, created);
      created.start();
    }
    return binding;
  }

  private async ensureHarness(laneId: string, harnessTargetId: string): Promise<HarnessBinding> {
    const key = this.bindingKey(laneId, harnessTargetId);
    const binding = this.bindingFor(laneId, harnessTargetId);
    if (binding.isStarting) {
      try {
        await binding.ensure();
      } catch (error) {
        this.bindings.delete(key);
        throw error;
      } finally {
        this.changed();
      }
    }
    return binding;
  }

  private targetFor(harnessTargetId: string): HarnessTarget {
    const resolved = this.options.resolveTarget(harnessTargetId);
    if (!resolved) {
      throw new Error(`HarnessTarget not registered: ${harnessTargetId}`);
    }
    if (!resolved.id || resolved.id !== harnessTargetId || !resolved.harness) {
      throw new Error(
        `invalid HarnessTarget for ${harnessTargetId}: id=${resolved.id}, harness=${resolved.harness}`,
      );
    }
    return Object.freeze({ id: resolved.id, harness: resolved.harness });
  }

  private changed(): void {
    this.options.onChange?.();
  }
}
