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

  finishRun(run: QueueRun<TBinding>, stopReason: StopReason | undefined): void {
    if (run.status === "finalized") return;
    run.status = "finalized";
    run.stopReason = stopReason;
    const terminal: HarnessInputStatus = stopReason === "cancelled" ? "interrupted" : "finalized";
    if (run.input) run.input.status = terminal;
    for (const steer of run.steers) {
      steer.status = terminal;
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
    },
  ): QueueSubmission {
    let resolve!: (outcome: QueueOutcome) => void;
    let reject!: (error: unknown) => void;
    const outcome = new Promise<QueueOutcome>((resolveOutcome, rejectOutcome) => {
      resolve = resolveOutcome;
      reject = rejectOutcome;
    });
    const input: QueueItem = {
      enqueueSeq: options?.enqueueSeq ?? 0,
      turnId: options?.identity?.turnId ?? newId("t"),
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
    this.beforeTransition(input, "accepted_steer", { turnId, delivery: "steer" });
    this.dispatching = undefined;
    input.turnId = turnId;
    input.status = "accepted_steer";
  }

  requeueClaimed(input: QueueItem): void {
    if (this.dispatching !== input) {
      throw new Error(`Input ${input.messageId} is not dispatching`);
    }
    this.beforeTransition(input, "queued", { delivery: "prompt" });
    this.dispatching = undefined;
    input.status = "queued";
    input.delivery = "prompt";
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
    if (index < 0) return undefined;
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
