import { newId } from "./event/ids.ts";
import type { PromptBlock, StopReason } from "./event/index.ts";
import type { HarnessTarget } from "./harness/target.ts";
import type { HarnessInput, HarnessInputSource, HarnessInputStatus } from "./harness/input.ts";

export interface QueueSnapshot {
  messageId: string;
  enqueueSeq: number;
  turnId: string;
  harnessTargetId: string;
  laneId: string;
  harness: string;
  blocks: PromptBlock[];
  source: HarnessInputSource;
  harnessInvocationId?: string;
}

export type QueueOutcome = "completed" | "recalled";

/** Queue-private continuation; it is never persisted or exposed to Harnesses. */
export interface QueueItem extends HarnessInput {
  /** First queued Event seq; orders Queue heads without creating another identity. */
  enqueueSeq: number;
  /** Reserved new-Turn identity retained while the Input is temporarily a steer. */
  reservedTurnId: string;
  /** A pending steer reclaimed by Esc is delivered as a visible follow-up Turn. */
  requeuedFromSteer?: boolean;
  resolve?: (outcome: QueueOutcome) => void;
  reject?: (error: unknown) => void;
}

interface QueueBinding {
  readonly laneId: string;
}

/**
 * Core-owned delivery state for a HarnessInput that has left the Queue.
 * This is deliberately separate from Turn: a Turn may contain no Human
 * question, while Queue release and steer settlement only concern delivery.
 */
export interface QueueRun<TBinding extends QueueBinding> {
  readonly turnId: string;
  readonly binding: TBinding;
  readonly laneId: string;
  readonly input?: QueueItem;
  readonly steers: QueueItem[];
  readonly release: () => void;
  status: "active" | "finalized";
  stopReason?: StopReason;
  inputEventId?: string;
  cancelGraceTimer?: ReturnType<typeof setTimeout>;
}

export interface QueueSubmission {
  input: QueueItem;
  outcome: Promise<QueueOutcome>;
}

type BeforeInputTransition = (
  input: QueueItem,
  status: HarnessInputStatus,
  update?: { turnId?: string; delivery?: HarnessInput["delivery"] },
) => number;

/**
 * One Lane's in-memory execution index for Harness Inputs. Durable queue truth
 * lives in `harness_input.updated` Events; every mutation calls
 * `beforeTransition` first.
 */
export class Queue<TBinding extends QueueBinding> {
  private readonly queue: QueueItem[] = [];
  private dispatching: QueueItem | undefined;
  private currentRun: QueueRun<TBinding> | undefined;

  constructor(
    readonly laneId: string,
    private readonly beforeTransition: BeforeInputTransition,
  ) {}

  get length(): number {
    return this.queue.length;
  }

  get queued(): readonly QueueItem[] {
    return this.queue;
  }

  get head(): QueueItem | undefined {
    return this.queue[0];
  }

  get claimed(): readonly QueueItem[] {
    return this.dispatching ? [this.dispatching] : [];
  }

  get snapshots(): QueueSnapshot[] {
    return this.queue.map(queueSnapshot);
  }

  runs(): IterableIterator<QueueRun<TBinding>> {
    return (this.currentRun ? [this.currentRun] : []).values();
  }

  run(turnId: string): QueueRun<TBinding> | undefined {
    return this.currentRun?.turnId === turnId ? this.currentRun : undefined;
  }

  get activeRun(): QueueRun<TBinding> | undefined {
    return this.currentRun?.status === "active" ? this.currentRun : undefined;
  }

  startRun(
    binding: TBinding,
    turnId: string,
    input?: QueueItem,
  ): { run: QueueRun<TBinding>; settled: Promise<void> } {
    if (binding.laneId !== this.laneId) {
      throw new Error(
        `Queue ${this.laneId} cannot start a run for Lane ${binding.laneId}`,
      );
    }
    if (this.activeRun) {
      throw new Error(`Lane ${this.laneId} already has an active Queue run`);
    }
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run: QueueRun<TBinding> = {
      turnId,
      binding,
      laneId: binding.laneId,
      input,
      steers: [],
      release,
      status: "active",
    };
    this.currentRun = run;
    return { run, settled };
  }

  finishRun(
    run: QueueRun<TBinding>,
    stopReason: StopReason | undefined,
    /** 投影中的 steer 投递结果查询；Turn 收口只终结已投递的 steer。 */
    deliveryOutcomeOf?: (messageId: string) => "applied" | "failed" | undefined,
  ): void {
    if (run.status === "finalized") return;
    run.status = "finalized";
    run.stopReason = stopReason;
    const terminal: HarnessInputStatus = stopReason === "cancelled" ? "interrupted" : "finalized";
    if (run.input) {
      this.beforeTransition(run.input, terminal);
      run.input.status = terminal;
    }
    for (const steer of run.steers) {
      const outcome = deliveryOutcomeOf?.(steer.messageId);
      if (outcome === "applied") {
        // 已进模型上下文的 steer 与 Turn 共命运。
        this.beforeTransition(steer, terminal);
        steer.status = terminal;
      }
      // outcome 为 undefined:原生队列跨 Turn,不标终态——投影继续持有 steering 状态,
      // Harness 回执到达后再迁移;failed:回执时已落终态,不覆盖。
      steer.resolve?.("completed");
    }
    if (this.currentRun?.turnId === run.turnId) this.currentRun = undefined;
    if (run.cancelGraceTimer) clearTimeout(run.cancelGraceTimer);
    run.cancelGraceTimer = undefined;
    run.release();
    run.steers.length = 0;
  }

  enqueue(
    target: HarnessTarget,
    blocks: PromptBlock[],
    options?: {
      source?: HarnessInputSource;
      harnessInvocationId?: string;
      sourceProposedPlanId?: string;
      identity?: { messageId: string; turnId: string };
      parentEventId?: string;
      enqueueSeq?: number;
      restore?: boolean;
      /** Crash 恢复的 steering Input 按 Esc 回收同语义处理：重放为可见 follow-up。 */
      requeuedFromSteer?: boolean;
    },
  ): QueueSubmission {
    let resolve!: (outcome: QueueOutcome) => void;
    let reject!: (error: unknown) => void;
    const outcome = new Promise<QueueOutcome>((resolveOutcome, rejectOutcome) => {
      resolve = resolveOutcome;
      reject = rejectOutcome;
    });
    const reservedTurnId = options?.identity?.turnId ?? newId("t");
    const input: QueueItem = {
      enqueueSeq: options?.enqueueSeq ?? 0,
      turnId: reservedTurnId,
      reservedTurnId,
      messageId: options?.identity?.messageId ?? newId("m"),
      target,
      laneId: this.laneId,
      blocks,
      source: options?.source ?? { type: "user" },
      ...(options?.harnessInvocationId === undefined
        ? {}
        : { harnessInvocationId: options.harnessInvocationId }),
      ...(options?.parentEventId === undefined
        ? {}
        : { parentEventId: options.parentEventId }),
      status: "queued",
      delivery: "prompt",
      ...(options?.sourceProposedPlanId
        ? { sourceProposedPlanId: options.sourceProposedPlanId }
        : {}),
      ...(options?.requeuedFromSteer ? { requeuedFromSteer: true } : {}),
      resolve,
      reject,
    };
    if (options?.restore) {
      if (input.enqueueSeq < 1) {
        throw new Error(`restored Input ${input.messageId} is missing its queued Event seq`);
      }
    } else {
      input.enqueueSeq = this.beforeTransition(input, "queued");
    }
    this.queue.push(input);
    return { input, outcome };
  }

  /**
   * Reclaim native steers which the Adapter guarantees cancel will orphan.
   * They keep message identity and their original reserved Turn identity, and
   * move ahead of later follow-ups in the same order the user submitted them.
   */
  requeueSteers(run: QueueRun<TBinding>, messageIds: ReadonlySet<string>): QueueItem[] {
    const reclaimed: QueueItem[] = [];
    for (let index = run.steers.length - 1; index >= 0; index--) {
      const input = run.steers[index];
      if (!input || !messageIds.has(input.messageId)) continue;
      this.beforeTransition(input, "queued", {
        turnId: input.reservedTurnId,
        delivery: "prompt",
      });
      input.turnId = input.reservedTurnId;
      input.status = "queued";
      input.delivery = "prompt";
      input.requeuedFromSteer = true;
      reclaimed.unshift(input);
      run.steers.splice(index, 1);
    }
    this.queue.unshift(...reclaimed);
    return reclaimed;
  }

  /**
   * @spec 只有仍位于队头的 HarnessInput 才能被 same-turn dispatch claim；claim 后不可被 composer recall。
   * @see {@link ../docs/workflow.md}
   */
  claimFirstForSteer(input: QueueItem): boolean {
    if (this.dispatching || this.queue[0] !== input) return false;
    this.beforeTransition(input, "dispatching", { delivery: "steer" });
    this.queue.shift();
    input.status = "dispatching";
    input.delivery = "steer";
    this.dispatching = input;
    return true;
  }

  acceptClaimedSteer(input: QueueItem, turnId: string): void {
    if (this.dispatching !== input) {
      throw new Error(`Input ${input.messageId} is not dispatching`);
    }
    this.beforeTransition(input, "steering", { turnId, delivery: "steer" });
    this.dispatching = undefined;
    input.turnId = turnId;
    input.status = "steering";
  }

  /**
   * @param fromAcceptedSteer admission 回执输给 Esc 竞态时使用：Adapter 已接受
   * 且已落 steer 正文，重放必须按回收 steer 语义落成可见 follow-up。
   */
  requeueClaimed(input: QueueItem, opts?: { fromAcceptedSteer?: boolean }): void {
    if (this.dispatching !== input) {
      throw new Error(`Input ${input.messageId} is not dispatching`);
    }
    this.beforeTransition(input, "queued", { delivery: "prompt" });
    this.dispatching = undefined;
    input.status = "queued";
    input.delivery = "prompt";
    if (opts?.fromAcceptedSteer) input.requeuedFromSteer = true;
    this.queue.unshift(input);
  }

  abandonClaimed(input: QueueItem): void {
    if (this.dispatching !== input) return;
    this.beforeTransition(input, "interrupted");
    this.dispatching = undefined;
    input.status = "interrupted";
    input.resolve?.("completed");
  }

  dequeue(): QueueItem | undefined {
    const input = this.queue[0];
    if (input) this.beforeTransition(input, "admitted");
    const [removed] = this.queue.splice(0, 1);
    if (removed) removed.status = "admitted";
    return removed;
  }

  recallLatestUser(): QueueSnapshot | undefined {
    const index = this.queue.findLastIndex(
      (input) => input.source.type === "user" && !input.harnessInvocationId,
    );
    return index < 0 ? undefined : this.recallAt(index);
  }

  /**
   * 按 messageId 召回一条仍在排队的用户输入；与 recallLatestUser 同一语义
   * （recalled 终态 + outcome 收口），只是定位方式从"最新一条"变为显式指定。
   */
  recallUserById(messageId: string): QueueSnapshot | undefined {
    const index = this.queue.findIndex(
      (input) =>
        input.messageId === messageId &&
        input.source.type === "user" &&
        !input.harnessInvocationId,
    );
    return index < 0 ? undefined : this.recallAt(index);
  }

  private recallAt(index: number): QueueSnapshot | undefined {
    const input = this.queue[index];
    if (input) this.beforeTransition(input, "recalled");
    const [removed] = this.queue.splice(index, 1);
    if (!removed) return undefined;
    removed.status = "recalled";
    removed.resolve?.("recalled");
    return queueSnapshot(removed);
  }

  cancelHarnessInvocation(harnessInvocationId: string): QueueSnapshot | undefined {
    const index = this.queue.findIndex(
      (input) => input.harnessInvocationId === harnessInvocationId,
    );
    if (index < 0) return undefined;
    const input = this.queue[index];
    if (input) this.beforeTransition(input, "recalled");
    const [removed] = this.queue.splice(index, 1);
    if (!removed) return undefined;
    removed.status = "recalled";
    removed.resolve?.("recalled");
    return queueSnapshot(removed);
  }
}

function queueSnapshot(input: QueueItem): QueueSnapshot {
  return {
    messageId: input.messageId,
    enqueueSeq: input.enqueueSeq,
    turnId: input.turnId,
    harnessTargetId: input.target.id,
    laneId: input.laneId,
    harness: input.target.harness,
    blocks: [...input.blocks],
    source: { ...input.source },
    ...(input.harnessInvocationId === undefined
      ? {}
      : { harnessInvocationId: input.harnessInvocationId }),
  };
}
