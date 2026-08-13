import {
  isContextSynchronizable,
  isContextCompactable,
  type AdapterCapabilities,
  type HarnessAdapter,
  type ApprovalRoute,
  type EffortOption,
  type InteractionContext,
  type OpenInteraction,
  type ModelOption,
  type NativeEventSink,
  type PromptInput,
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
} from "../event/index.ts";
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
  harnessInputUpdate,
  harnessInputSnapshot,
  type HarnessInputSource,
  type HarnessInputSnapshot,
} from "../harness/input.ts";
import {
  Queue,
  type QueueSubmission,
  type QueueItem,
  type QueueRun,
  type QueueSnapshot,
  type QueueOutcome,
} from "../queue.ts";
import { HarnessInteractionContinuations } from "../interaction/harness.ts";
import { TurnRegistry, type TurnRecord } from "../turn.ts";
import {
  HarnessHookCoordinator,
  type HarnessHookGateway,
} from "./hook.ts";

export type { HarnessHookGateway } from "./hook.ts";

export type {
  HarnessInputSource,
  HarnessInputSnapshot,
  HarnessInputStatus,
} from "../harness/input.ts";
export type {
  QueueSnapshot,
  QueueOutcome,
} from "../queue.ts";

export interface HarnessInvocationInput {
  readonly harnessInvocationId: string;
  readonly pluginInstanceId: string;
  readonly harnessTargetId: string;
  readonly laneId: string;
  readonly newLane: boolean;
  readonly parentLaneId?: string;
  readonly source: HarnessInputSource;
  readonly messageId: string;
  readonly turnId: string;
  readonly blocks: PromptBlock[];
}

export type HarnessInvocationCancellation = "queued" | "running";

function eventSourceOf(source: HarnessInputSource): EventSource {
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
 * - `steer`：Adapter 已承担向当前 turn 投递的责任；原生队列是否已应用
 *   由 user_message deliveryState 继续报告；
 * - `new_turn`：已进入全局 Queue；`queued` 说明它是否在等待当前
 *   turn。outcome 在该 turn 完成/被撤回时 resolve。
 */
export type SendTurnOutcome =
  | { effective: "steer" }
  | {
      effective: "new_turn";
      queued: boolean;
      outcome: Promise<QueueOutcome>;
      reason?: string;
    };

export interface SendTurnOptions {
  readonly sourceProposedPlanId?: string;
  /** Host-prepared intake identity used to correlate human Hook stages with the Input. */
  readonly identity?: { readonly messageId: string; readonly turnId: string };
  /** Durable Human Input or Plugin fact that caused this Turn. */
  readonly parentEventId?: string;
  /** Called synchronously after the Input is visible in the Core queue. */
  readonly onEnqueued?: () => void;
}

/** Controller 注入给 Adapter 的 Core ports；原生 Harness verb 只能经这些边界 lowering。 */
export interface HarnessAdapterPorts {
  openInteraction: OpenInteraction;
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
  createAdapter(target: HarnessTarget, handlers: HarnessAdapterPorts): HarnessAdapter;
  /** Optional Plugin notification surface for Harness send and ledger intake boundaries. */
  hooks?: HarnessHookGateway;
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
  /** Session 标题异步生成并落盘后的通知；终端等宿主投影可据此同步标题。 */
  onSessionTitleChange?: () => void;
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
 * UI 只提交输入和消费 BatonSession Projection，不能分别维护
 * 各 harness 的并发状态。
 *
 * Lane 与 Turn 都只是归属边界：Lane 表达长期并发通道，Turn 表达一次 Harness loop
 * 的 start/end。Queue 负责调度，Harness 负责执行，Controller 负责协调；Turn 本身不干活。
 *
 * 生命周期由 state event 驱动（workflow）：adapter.sendTurn 只确认接收，turn 的
 * 完成以 `state_update(idle)` 为准，经 finalize 按 baton turn id 幂等收口——
 * 重复/迟到的物理终态（reconnect、transport race）不会二次终结，也不会关闭更新的 turn。
 *
 * Event Ledger 只保留可回放的事实历史；TurnRegistry 只是按 turnId 建立的运行期 scope 索引。
 */
export class Controller {
  /** Lane × HarnessTarget → live binding. */
  private readonly bindings = new Map<string, HarnessBinding>();
  private readonly mainQueue: Queue<HarnessBinding>;
  private readonly sideQueue: Queue<HarnessBinding>;
  private readonly turns = new TurnRegistry<HarnessBinding>();
  private readonly deliveryAttempts: DeliveryAttempts<HarnessBinding>;
  private readonly contextDeliveries: ContextDeliveries<HarnessBinding>;
  private readonly harnessInteractions: HarnessInteractionContinuations<HarnessBinding>;
  private readonly harnessHooks: HarnessHookCoordinator;
  private drainingMain = false;
  private activeSideRuns = 0;
  /** 已开始处理的 Queue item 从 Harness setup 起即对 UI 可见。 */
  private readonly processing = new Map<
    string,
    { target: HarnessTarget; startedAt: number }
  >();

  constructor(private readonly options: ControllerOptions) {
    const concurrency = options.sideLaneConcurrency ?? DEFAULT_SIDE_LANE_CONCURRENCY;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("sideLaneConcurrency must be a positive integer");
    }
    const beforeInputTransition = (
      input: QueueItem,
      status: QueueItem["status"],
      update?: { turnId?: string; delivery?: QueueItem["delivery"] },
    ) => this.recordHarnessInputTransition(input, status, update);
    this.mainQueue = new Queue<HarnessBinding>(beforeInputTransition);
    this.sideQueue = new Queue<HarnessBinding>(beforeInputTransition);
    this.deliveryAttempts = new DeliveryAttempts(
      (binding, event) =>
        this.appendEvent(binding, event, {
          type: "baton",
        }) as EventEnvelope<"_baton_delivery_attempt_update">,
      options.session.ledger.read(),
    );
    this.contextDeliveries = new ContextDeliveries(
      (binding, event) => this.appendEvent(binding, event, { type: "baton" }),
      options.session.ledger.read(),
    );
    this.harnessInteractions = new HarnessInteractionContinuations(
      (binding, event, source) => this.appendEvent(binding, event, source),
      () => this.changed(),
    );
    this.harnessHooks = new HarnessHookCoordinator({
      gateway: options.hooks,
      append: (binding, event) =>
        this.appendEvent(binding, event, {
          type: "harness",
          harnessTargetId: binding.target.id,
        }),
      log: (entry) => options.session.log(entry),
    });
    this.restoreQueuedHarnessInputs();
    queueMicrotask(() => {
      if (this.mainQueue.length > 0) void this.drainMain();
      if (this.sideQueue.length > 0) this.drainSideLanes();
    });
  }

  /** Rebuilds safely queued Human work from the Event Ledger WAL. */
  private restoreQueuedHarnessInputs(): void {
    const latest = new Map<
      string,
      Extract<AnyEventEnvelope, { kind: "harness_input.updated" }>
    >();
    for (const event of this.options.session.ledger.read()) {
      if (event.kind === "harness_input.updated") {
        latest.set(event.payload.messageId, event);
      }
    }
    const queued = [...latest.values()]
      .filter((event) => event.payload.status === "queued")
      .sort((left, right) => left.payload.queueId - right.payload.queueId);
    for (const event of queued) {
      const input = event.payload;
      // Plugin executions have their own recovery/failure contract; only the
      // Human queue is resumed automatically by this intake path.
      if (input.harnessInvocationId) continue;
      const target = this.options.resolveTarget(input.harnessTargetId);
      if (!target || !this.options.session.meta.lanes[input.laneId]) {
        this.options.session.log({
          level: "warn",
          source: "baton",
          component: "controller.input-recovery",
          message: "queued Harness Input could not be restored",
          attributes: {
            messageId: input.messageId,
            harnessTargetId: input.harnessTargetId,
            laneId: input.laneId,
          },
        });
        continue;
      }
      const queue = input.laneId === this.mainLaneId() ? this.mainQueue : this.sideQueue;
      queue.enqueue(target, input.laneId, [...input.blocks], {
        source: input.source,
        identity: { messageId: input.messageId, turnId: input.turnId },
        queueId: input.queueId,
        restore: true,
        ...(input.causeEventId === undefined
          ? {}
          : { parentEventId: input.causeEventId }),
        ...(input.sourceProposedPlanId === undefined
          ? {}
          : { sourceProposedPlanId: input.sourceProposedPlanId }),
      });
    }
  }

  /** Event Ledger WAL entry written before the in-memory queue transition. */
  private recordHarnessInputTransition(
    input: QueueItem,
    status: QueueItem["status"],
    update?: { turnId?: string; delivery?: QueueItem["delivery"] },
  ): void {
    const payload = harnessInputUpdate(input, status, update);
    this.options.session.appendEvent({
      kind: "harness_input.updated",
      source: eventSourceOf(input.source),
      ...(input.parentEventId === undefined ? {} : { parentEventId: input.parentEventId }),
      harness: input.target.harness,
      harnessTargetId: input.target.id,
      laneId: input.laneId,
      turnId: payload.turnId,
      payload,
    });
  }

  /**
   * 用户完成一个未决 Interaction。先把用户事实持久化，再唤醒 Harness；没有活跃 continuation
   * 时返回 false，UI 据此提示 stale，而不是把响应写进一个无人消费的内存通道。
   */
  completeInteraction(interactionId: string, result: InteractionResult): boolean {
    return this.harnessInteractions.complete(interactionId, result);
  }

  private openHarnessInteraction(
    laneId: string,
    harnessTargetId: string,
    draft: InteractionDraft,
    context?: InteractionContext,
  ): Promise<InteractionResult> {
    const binding = this.bindings.get(this.bindingKey(laneId, harnessTargetId));
    if (!binding) return Promise.reject(new Error(`unknown Lane binding for interaction: ${laneId} × ${harnessTargetId}`));
    const active = this.queueForLane(laneId).activeRun(laneId);
    const turnId =
      context?.turnId ?? active?.turnId ?? binding.setupTurnId;
    return this.harnessInteractions.open(binding, draft, turnId, context);
  }

  private mainLaneId(): string {
    return MAIN_LANE_ID;
  }

  private queueForLane(laneId: string): Queue<HarnessBinding> {
    return laneId === MAIN_LANE_ID ? this.mainQueue : this.sideQueue;
  }

  private activeMainRun(): QueueRun<HarnessBinding> | undefined {
    return this.mainQueue.activeRun(MAIN_LANE_ID);
  }

  private runForTurn(turnId: string): QueueRun<HarnessBinding> | undefined {
    return this.mainQueue.run(turnId) ?? this.sideQueue.run(turnId);
  }

  /** 主 Queue 当前 run 的具体配置目标；Harness 类型只用于选择 Adapter。 */
  get activeHarnessTargetId(): string | undefined {
    const active = this.activeMainRun();
    const processing = active
      ? this.processing.get(active.laneId)
      : [...this.processing.entries()].find(
          ([laneId]) => laneId === MAIN_LANE_ID,
        )?.[1];
    return processing?.target.id ?? active?.binding.target.id;
  }

  /** 主 Queue 当前 run 对应的 Turn ID；TUI 据此做 per-turn 投影。 */
  get activeTurnId(): string | undefined {
    return this.activeMainRun()?.turnId;
  }

  /** 当前 turn 的起跑时刻（epoch ms）；elapsed 跳秒由 TUI 组件自理，这里只给起点 */
  get activeStartedAt(): number | undefined {
    const active = this.activeMainRun();
    return (
      (active ? this.processing.get(active.laneId)?.startedAt : undefined) ??
      (active ? this.turns.get(active.turnId)?.startedAt : undefined)
    );
  }

  /** 给 UI 做提交前提示；最终准入仍以 Adapter.sendTurn 为准。 */
  promptCapabilities(harnessTargetId: string): AdapterCapabilities["prompt"] {
    return this.bindingFor(this.mainLaneId(), harnessTargetId).adapter.capabilities.prompt;
  }

  get harnessQueueLength(): number {
    return this.mainQueue.length + this.sideQueue.length;
  }

  get queuedHarnessInputs(): QueueSnapshot[] {
    return [...this.mainQueue.snapshots, ...this.sideQueue.snapshots];
  }

  get sideRunCount(): number {
    return this.activeSideRuns;
  }

  /**
   * 所有**在世** HarnessInput 的只读快照：waiting + running item +
   * 已接受的 steer。终态输入（finalized/recalled/interrupted）不驻内存——其历史在事件流里
   * （`user_message`），与 turn 台账瘦身同一取舍。投影 / 诊断据此看到每条输入的 messageId 与消费状态。
   */
  get harnessInputs(): HarnessInputSnapshot[] {
    const out: HarnessInputSnapshot[] = [];
    for (const input of this.mainQueue.queued) out.push(harnessInputSnapshot(input));
    for (const input of this.mainQueue.claimed) out.push(harnessInputSnapshot(input));
    for (const input of this.sideQueue.queued) out.push(harnessInputSnapshot(input));
    for (const input of this.sideQueue.claimed) out.push(harnessInputSnapshot(input));
    for (const run of [...this.mainQueue.runs(), ...this.sideQueue.runs()]) {
      if (run.status !== "active") continue;
      if (run.input) out.push(harnessInputSnapshot(run.input));
      for (const steer of run.steers) out.push(harnessInputSnapshot(steer));
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
  ): Promise<QueueOutcome> {
    const submission = this.enqueueMainInput(harnessTargetId, blocks, options);
    this.changed();
    void this.drainMain();
    return submission.outcome;
  }

  private enqueueMainInput(
    harnessTargetId: string,
    blocks: PromptBlock[],
    options?: SendTurnOptions,
  ): QueueSubmission {
    const target = this.targetFor(harnessTargetId);
    const laneId = this.mainLaneId();
    if (options?.sourceProposedPlanId) {
      if (
        this.harnessInputs.some(
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
    return this.mainQueue.enqueue(target, laneId, blocks, options);
  }

  /** Materializes a scheduled HarnessInvocation without inferring Lane from source. */
  async enqueueHarnessInvocation(input: HarnessInvocationInput): Promise<QueueOutcome> {
    if (
      this.harnessInputs.some(
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
    const submission = queue.enqueue(target, laneId, input.blocks, {
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
    return submission.outcome;
  }

  /** Cancels a queued Request, or interrupts its active Queue run. */
  cancelHarnessInvocation(harnessInvocationId: string): HarnessInvocationCancellation | undefined {
    const queued =
      this.mainQueue.cancelHarnessInvocation(harnessInvocationId) ??
      this.sideQueue.cancelHarnessInvocation(harnessInvocationId);
    if (queued) {
      this.changed();
      return "queued";
    }
    for (const active of [...this.mainQueue.runs(), ...this.sideQueue.runs()]) {
      if (
        active.status === "active" &&
        active.input?.harnessInvocationId === harnessInvocationId
      ) {
        void this.interruptRecord(active);
        return "running";
      }
    }
    return undefined;
  }

  /**
   * 用户输入的统一入口。Input 先获得稳定 messageId 并进入全局队列；没有更早 follow-up、
   * 目标与当前 Queue run 一致且 HarnessSession 已就绪时，Controller 原子 claim 队头，
   * 再交给 Adapter 依据原生运行态决定 same-turn send。Adapter 拒绝时同一 Input 回到队头。
   * 没有对应 Queue run 的 Turn 不接受 steer——Baton 不拥有其投递生命周期。
   *
   * @spec 每次用户提交只创建一个 Input/messageId；steer rejection 降级 follow-up 时保持身份不变。
   * @see {@link ../../docs/workflow.md}
   */
  async sendTurn(
    harnessTargetId: string,
    blocks: PromptBlock[],
    options?: SendTurnOptions,
  ): Promise<SendTurnOutcome> {
    const laneId = this.mainLaneId();
    const active = this.mainQueue.activeRun(laneId);
    const queued =
      Boolean(this.activeMainRun()) ||
      this.drainingMain ||
      this.mainQueue.length > 0;
    const submission = this.enqueueMainInput(harnessTargetId, blocks, options);
    const input = submission.input;
    this.changed();
    options?.onEnqueued?.();
    if (
      !options?.sourceProposedPlanId &&
      active?.input &&
      active.input.target.id === harnessTargetId &&
      active.binding.ref &&
      this.mainQueue.claimFirstForSteer(input)
    ) {
      this.changed();
      let receipt: SendTurnReceipt;
      const attemptId = newId("att");
      try {
        receipt = await this.harnessHooks.send(
          active.binding,
          active.binding.ref,
          {
            turnId: active.turnId,
            messageId: input.messageId,
            blocks: input.blocks,
          },
          attemptId,
          "steer",
        );
      } catch (error) {
        receipt = {
          accepted: false,
          effective: "rejected",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (receipt.effective === "steer") {
        this.mainQueue.acceptClaimedSteer(input, active.turnId);
        if (active.status === "active") {
          // 已接受的 same-turn send 挂到当前 turn，cancel 时统一迁移 interrupted。
          active.steers.push(input);
        } else {
          // Adapter receipt 可能晚于 Esc/终态。输入已经被 Harness 接受，不能重新入队；
          // 直接继承它所绑定 Turn 的终态，避免把 Input 挂回已退休的台账记录。
          const terminal = active.stopReason === "cancelled" ? "interrupted" : "finalized";
          this.recordHarnessInputTransition(input, terminal);
          input.status = terminal;
          input.resolve?.("completed");
        }
        this.changed();
        return { effective: "steer" };
      }
      if (receipt.effective === "new_turn") {
        const error = new Error(
          `adapter ${active.binding.adapter.harness} opened a new turn while Baton turn ${active.turnId} is active`,
        );
        this.mainQueue.abandonClaimed(input);
        this.changed();
        throw error;
      }
      this.mainQueue.requeueClaimed(input);
      this.changed();
      void this.drainMain();
      return {
        effective: "new_turn",
        queued: true,
        outcome: submission.outcome,
        ...(receipt.effective === "rejected" && receipt.reason
          ? { reason: receipt.reason }
          : {}),
      };
    }
    void this.drainMain();
    return {
      effective: "new_turn",
      queued,
      outcome: submission.outcome,
    };
  }

  /** 只允许撤回尚未开始执行的最新 turn；已被 drain 取走的 active turn 不在此列。 */
  recallLatestQueued(): QueueSnapshot | undefined {
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
   * 用 harness 原生机制压缩当前上下文。它会打开一个没有 user_message 的 control Turn：
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
    let run: QueueRun<HarnessBinding> | undefined;
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
      const started = this.startTurn(binding, {
        turnId,
        harnessSessionId: binding.sessionIdentity()?.id,
      });
      run = started.run;
      await binding.adapter.compactContext(binding.ref, turnId);
      await started.settled;
    } catch (error) {
      this.options.session.log({
        level: "error",
        source: "baton",
        component: "controller.compact",
        harness: target.harness,
        harnessTargetId,
        turnId: run?.turnId,
        message: "harness context compaction failed",
        error: logError(error),
      });
      if (run && run.status !== "finalized") {
        this.synthesizeTerminal(run, {
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
   * kind 是 `interrupt`（Esc）——打断主 Lane 当前 Queue run。新增 kind 时在此按 kind 分派。
   */
  async control(signal: Control): Promise<void> {
    switch (signal.kind) {
      case "interrupt":
        return this.interrupt();
    }
  }

  /**
   * Control:interrupt 的实现——中断主 Lane 当前 Queue run。确认以 harness 的 idle/cancelled 终态
   * 为准；宽限期内没等到则合成 terminal error，保证队列永远能推进（不能因 harness 失联而死锁）。
   * preparing（harness 冷启动中）无需确认：尚未向 harness 提交任何内容，立即合成取消。
   */
  private async interrupt(): Promise<void> {
    const active = this.activeMainRun();
    if (!active) return;
    return this.interruptRecord(active);
  }

  private async interruptRecord(active: QueueRun<HarnessBinding>): Promise<void> {
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
        harness: active.binding.adapter.harness,
        harnessTargetId: active.binding.target.id,
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
    await this.harnessHooks.close();
  }

  private async drainMain(): Promise<void> {
    if (this.drainingMain) return;
    this.drainingMain = true;
    try {
      while (this.mainQueue.length > 0) {
        const input = this.mainQueue.dequeue() as QueueItem;
        this.changed();
        try {
          await this.runQueueItem(input);
          input.resolve?.("completed");
        } catch (error) {
          input.reject?.(error);
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
      const input = this.sideQueue.dequeue(
        (candidate) => !this.processing.has(candidate.laneId) &&
          !this.sideQueue.activeRun(candidate.laneId),
      );
      if (!input) return;
      this.activeSideRuns++;
      this.changed();
      void this.runQueueItem(input)
        .then(() => input.resolve?.("completed"), (error) => input.reject?.(error))
        .finally(() => {
          this.activeSideRuns--;
          this.changed();
          this.drainSideLanes();
        });
    }
  }

  /**
   * Queue 驱动 Turn 开界的唯一入口：先把 user_message 与 running 事实写入 Event Ledger，
   * 再建立运行期 Queue run。/compact 这类 control Turn 不带 input，因此跳过 user_message。
   */
  private startTurn(
    binding: HarnessBinding,
    opts: { turnId: string; input?: QueueItem; harnessSessionId?: string },
  ): { record: TurnRecord<HarnessBinding>; run: QueueRun<HarnessBinding>; settled: Promise<void> } {
    let inputEventId: string | undefined;
    if (opts.input) {
      const inputEvent = this.appendEvent(
        binding,
        {
          kind: "user_message",
          ...(opts.input.parentEventId === undefined
            ? {}
            : { parentEventId: opts.input.parentEventId }),
          harnessSessionId: opts.harnessSessionId,
          turnId: opts.turnId,
          payload: { messageId: opts.input.messageId, content: opts.input.blocks },
        },
        eventSourceOf(opts.input.source),
      );
      inputEventId = inputEvent.eventId;
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
    const record = this.turns.get(opts.turnId);
    if (!record) throw new Error(`Turn ${opts.turnId} did not open`);
    const queue = this.queueForLane(binding.laneId);
    const { run, settled } = queue.startRun(binding, opts.turnId, opts.input);
    run.inputEventId = inputEventId;
    return { record, run, settled };
  }

  private async runQueueItem(input: QueueItem): Promise<void> {
    this.processing.set(input.laneId, {
      target: input.target,
      startedAt: Date.now(),
    });

    // 出队即入账、即落盘：用户输入是 BatonSession 的事实，owner 是 controller——
    // 不等 harness 冷启动（codex 首启要 spawn → initialize → thread resume/start，
    // 可达数秒，期间 Transcript 必须已能看到这条输入）。落盘的是**原始输入** input.blocks：
    // <baton-sync> 注入只进 harness transport（syncContext / prepend），不进正典历史。
    let binding: HarnessBinding;
    let record: TurnRecord<HarnessBinding>;
    let run: QueueRun<HarnessBinding>;
    let settled: Promise<void>;
    try {
      binding = this.bindingFor(input.laneId, input.target.id, input.turnId);
      const lane = this.options.session.meta.lanes[input.laneId];
      if (!lane) throw new Error(`Lane not found: ${input.laneId}`);
      ({ record, run, settled } = this.startTurn(binding, {
        turnId: input.turnId,
        input,
        harnessSessionId: lane.harnessSessions[input.target.id]?.harnessSessionId,
      }));
    } catch (error) {
      this.processing.delete(input.laneId);
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
          turnId: input.turnId,
          payload: { phase: "starting", title: `Starting ${input.target.harness}…` },
        },
        { type: "baton" },
      );
    }

    try {
      await this.ensureHarness(input.laneId, input.target.id);
      // preparing 期间被取消：终态已合成、summary 已落，不再向 harness 提交
      if (record.status === "finalized") return;
      if (!binding.ref) throw new Error(`${targetKey} failed to start`);
      if (coldStart) {
        this.appendEvent(
          binding,
          {
            kind: "_baton_run_status",
            turnId: input.turnId,
            payload: { phase: null },
          },
          { type: "baton" },
        );
      }

      const session = this.options.session;
      const meta = session.meta.lanes[input.laneId]?.harnessSessions[input.target.id];
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
      let blocks = input.blocks;
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
          turnId: input.turnId,
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
        inputEventId: run.inputEventId,
        inputId: input.messageId,
        launchSnapshot: meta.launchSnapshot,
        harnessSessionId: meta.harnessSessionId ?? binding.sessionIdentity()?.id,
      });
      const promptInput: PromptInput = {
        turnId: input.turnId,
        messageId: input.messageId,
        blocks,
        ...(syncBlocks ? { syncBlocks } : {}),
      };
      const beforeDelivery = this.harnessHooks.beforeDelivery(
        this.harnessHooks.delivery(
          binding,
          promptInput,
          attempt.attemptId,
          "new_turn",
        ),
      );
      if (beforeDelivery) await beforeDelivery;
      this.deliveryAttempts.markDispatching(binding, attempt);

      // sendTurn 回执只确认 Adapter 接受本次投递责任；Harness 终态仍由 idle Event 收口。
      // Adapter 契约规定：throw 只发生在接受责任之前；接受后即使原生 transport 失败，
      // 也必须经事件流报告终态，不能把不确定性藏进一个迟到 rejection。
      try {
        const receipt = await this.harnessHooks.send(
          binding,
          binding.ref,
          promptInput,
          attempt.attemptId,
          "new_turn",
          false,
        );
        if (receipt.effective !== "new_turn") {
          const reason =
            receipt.effective === "rejected" && receipt.reason
              ? `: ${receipt.reason}`
              : "";
          throw new Error(
            `adapter ${binding.adapter.harness} rejected new Baton turn ${input.turnId}${reason}`,
          );
        }
      } catch (error) {
        this.deliveryAttempts.finalize(binding, attempt, "not_accepted", {
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      this.deliveryAttempts.markAccepted(binding, attempt);
      if (input.sourceProposedPlanId) {
        // 只在 Adapter 已接受投递责任后建立因果边；启动/admission 失败不能把提案误标为执行中。
        this.appendEvent(
          binding,
          {
            kind: "proposed_plan_implementation_started",
            turnId: input.turnId,
            payload: {
              planId: input.sourceProposedPlanId,
              implementationTurnId: input.turnId,
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
      await settled;
    } catch (error) {
      // preparing 期间被取消、随后启动又失败：用户已收到 cancelled 终态并继续别的事，
      // 迟到的启动错误不再作为本 turn 的失败上抛（事件历史已闭合）
      if (record.status === "finalized") return;
      const detail = error instanceof Error ? error.message : String(error);
      this.options.session.log({
        level: "error",
        source: "baton",
        component: "controller.turn",
        harness: input.target.harness,
        harnessTargetId: targetKey,
        turnId: input.turnId,
        message: "harness startup or prompt admission failed",
        error: logError(error),
      });
      // 启动/admission 失败：合成结构化终态（error + idle + summary）——user_message 已
      // 落盘，必须有结局，不允许"输入消失且无历史"的半状态；随后仍上抛给 submit 调用方。
      this.synthesizeTerminal(run, { message: detail, stopReason: "error" });
      throw new Error(`BatonSession ${this.options.session.id} · ${targetKey}: ${detail}`, {
        cause: error,
      });
    } finally {
      this.processing.delete(input.laneId);
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
   * adapter 上报与 Controller 自有 Event 的统一入口。BatonSession 先完成
   * WAL record，再直接 reduce 当前 Projection；Controller 随后只处理 Turn
   * scope 等协调逻辑。Ledger 不在这条实时链路上广播 Event。
   */
  private appendEvent(
    binding: HarnessBinding,
    ev: AnyEventDraft,
    source: EventSource,
  ): AnyEventEnvelope {
    const envelope = this.options.session.appendEvent({
      ...ev,
      source,
      harness: binding.adapter.harness,
      harnessTargetId: binding.target.id,
      laneId: binding.laneId,
    } as AnyNewEvent) as AnyEventEnvelope;
    if (envelope.kind === "state_update") {
      const p = envelope.payload;
      if (p.state === "running" && envelope.turnId) {
        // Event 已先落盘，再建立 Turn scope 的运行期索引。
        this.turns.open(binding, envelope.turnId);
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
    // Projection 已在 BatonSession 内同步 reduce；终态对 Controller 私有台账的
    // 变更仍由 finalize 自己通知。
    return envelope;
  }

  /**
   * 所有 Turn 的统一有序收界路径：终态已持久化 → interrupted notice → summary →
   * 同步元数据 → 若有关联 Queue run，则释放它并推进队列。Harness 自行打开的 Turn
   * 同样会被汇总，让后台产出进入 @ 引用与跨 Harness catch-up 的正典历史。
   * 按 baton turn id 幂等：迟到/重复/未知终态一律 inert，不会关闭更新的 turn。
   */
  private finalize(terminal: EventEnvelope<"state_update">): void {
    const turnId = terminal.turnId;
    if (!turnId) return;
    const stopReason = terminal.payload.stopReason;
    const record = this.turns.beginFinalization(turnId, stopReason);
    if (!record) return;
    const run = this.runForTurn(turnId);

    // cancel-cascade：本 turn 仍挂起的 Interaction 随收口一并了结，绝不留悬挂 continuation。
    // Controller 先持久化 interaction.cancelled，再唤醒 Adapter；参考 codex
    // clear_pending_waiters→Abort、opencode interrupt 的 ensuring(pending.delete)。
    // 顺序天然对：finalize 发生在 adapter.cancel 之后（先中断 turn，再收 pending），不会让取消以
    // model 可见的 tool rejection 抢在 turn 中断之前冒出来。
    this.harnessInteractions.cancelForTurn(turnId);

    const session = this.options.session;

    // 用户打断的 turn 在时间线留下醒目标记；排队的后续输入会自然跟在标记后面
    if (run && stopReason === "cancelled") {
      session.appendEvent({
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
    if (run) record.binding.freshHarnessSession = false;

    const inputStatus = stopReason === "cancelled" ? "interrupted" : "finalized";
    if (run?.input) {
      this.recordHarnessInputTransition(run.input, inputStatus);
    }
    for (const steer of run?.steers ?? []) {
      this.recordHarnessInputTransition(steer, inputStatus);
    }

    if (run) this.queueForLane(run.laneId).finishRun(run, stopReason);
    if (run && record.laneId === MAIN_LANE_ID) {
      this.maybeGenerateTitle(record.harnessTargetId);
    }
    this.changed();
  }

  /**
   * session 标题的 LLM 生成（fire-and-forget 旁路）：首个主 Queue Turn 收口后触发一次，
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
        // Session metadata 不走 Event reduce；标题落盘后显式刷新当前展示。
        if (updated) {
          this.options.onSessionTitleChange?.();
          this.changed();
        }
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
              openInteraction: () =>
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
   * 启动与投递失败（stopReason:"error"）。
   */
  private synthesizeTerminal(
    record: Pick<TurnRecord<HarnessBinding>, "binding" | "turnId" | "status">,
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
   * runQueueItem 因此能在 open() 完成之前落 user_message。实际启动生命周期由 binding 拥有。
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
        openInteraction: (interaction, context) =>
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
        eventSink: (event) => this.harnessHooks.acceptEvent(created, event),
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
