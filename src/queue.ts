import { newId } from "./event/ids.ts";
import type { PromptBlock, StopReason } from "./event/index.ts";
import type { HarnessTarget } from "./harness/target.ts";
import type { HarnessInput, HarnessInputSource, HarnessInputStatus } from "./harness/input.ts";

export interface QueueSnapshot {
  id: number;
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
) => void;

/**
 * In-memory execution index for Harness Inputs. Durable queue truth lives in
 * `harness_input.updated` Events; every mutation calls `beforeTransition` first.
 */
export class Queue<TBinding extends QueueBinding> {
  private readonly queue: QueueItem[] = [];
  private readonly dispatching = new Map<string, QueueItem>();
  private readonly runsByTurn = new Map<string, QueueRun<TBinding>>();
  private readonly activeRunByLane = new Map<string, string>();
  private nextId = 1;

  constructor(private readonly beforeTransition?: BeforeInputTransition) {}

  get length(): number {
    return this.queue.length;
  }

  get queued(): readonly QueueItem[] {
    return this.queue;
  }

  get claimed(): readonly QueueItem[] {
    return [...this.dispatching.values()];
  }

  get snapshots(): QueueSnapshot[] {
    return this.queue.map(queueSnapshot);
  }

  runs(): IterableIterator<QueueRun<TBinding>> {
    return this.runsByTurn.values();
  }

  run(turnId: string): QueueRun<TBinding> | undefined {
    return this.runsByTurn.get(turnId);
  }

  activeRun(laneId: string): QueueRun<TBinding> | undefined {
    const turnId = this.activeRunByLane.get(laneId);
    if (!turnId) return undefined;
    const run = this.runsByTurn.get(turnId);
    return run?.status === "active" ? run : undefined;
  }

  startRun(
    binding: TBinding,
    turnId: string,
    input?: QueueItem,
  ): { run: QueueRun<TBinding>; settled: Promise<void> } {
    if (this.activeRun(binding.laneId)) {
      throw new Error(`Lane ${binding.laneId} already has an active Queue run`);
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
    this.runsByTurn.set(turnId, run);
    this.activeRunByLane.set(binding.laneId, turnId);
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
    if (this.activeRunByLane.get(run.laneId) === run.turnId) {
      this.activeRunByLane.delete(run.laneId);
    }
    this.runsByTurn.delete(run.turnId);
    if (run.cancelGraceTimer) clearTimeout(run.cancelGraceTimer);
    run.cancelGraceTimer = undefined;
    run.release();
    run.steers.length = 0;
  }

  enqueue(
    target: HarnessTarget,
    laneId: string,
    blocks: PromptBlock[],
    options?: {
      source?: HarnessInputSource;
      harnessInvocationId?: string;
      sourceProposedPlanId?: string;
      identity?: { messageId: string; turnId: string };
      parentEventId?: string;
      queueId?: number;
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
      id: options?.queueId ?? this.nextId++,
      turnId: options?.identity?.turnId ?? newId("t"),
      messageId: options?.identity?.messageId ?? newId("m"),
      target,
      laneId,
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
    this.nextId = Math.max(this.nextId, input.id + 1);
    if (!options?.restore) this.beforeTransition?.(input, "queued");
    this.queue.push(input);
    return { input, outcome };
  }

  /**
   * @spec 只有仍位于队头的 HarnessInput 才能被 same-turn dispatch claim；claim 后不可被 composer recall。
   * @see {@link ../docs/workflow.md}
   */
  claimFirstForSteer(input: QueueItem): boolean {
    if (this.dispatching.size > 0 || this.queue[0] !== input) return false;
    this.beforeTransition?.(input, "dispatching", { delivery: "steer" });
    this.queue.shift();
    input.status = "dispatching";
    input.delivery = "steer";
    this.dispatching.set(input.messageId, input);
    return true;
  }

  acceptClaimedSteer(input: QueueItem, turnId: string): void {
    if (!this.dispatching.delete(input.messageId)) {
      throw new Error(`Input ${input.messageId} is not dispatching`);
    }
    this.beforeTransition?.(input, "accepted_steer", { turnId, delivery: "steer" });
    input.turnId = turnId;
    input.status = "accepted_steer";
  }

  requeueClaimed(input: QueueItem): void {
    if (!this.dispatching.delete(input.messageId)) {
      throw new Error(`Input ${input.messageId} is not dispatching`);
    }
    this.beforeTransition?.(input, "queued", { delivery: "prompt" });
    input.status = "queued";
    input.delivery = "prompt";
    this.queue.unshift(input);
  }

  abandonClaimed(input: QueueItem): void {
    if (!this.dispatching.delete(input.messageId)) return;
    this.beforeTransition?.(input, "interrupted");
    input.status = "interrupted";
    input.resolve?.("completed");
  }

  dequeue(predicate?: (input: QueueItem) => boolean): QueueItem | undefined {
    const index = predicate ? this.queue.findIndex(predicate) : 0;
    if (index < 0) return;
    const input = this.queue[index];
    if (input) this.beforeTransition?.(input, "admitted");
    const [removed] = this.queue.splice(index, 1);
    if (removed) removed.status = "admitted";
    return removed;
  }

  recallLatestUser(): QueueSnapshot | undefined {
    const index = this.queue.findLastIndex(
      (input) => input.source.type === "user" && !input.harnessInvocationId,
    );
    if (index < 0) return undefined;
    const input = this.queue[index];
    if (input) this.beforeTransition?.(input, "recalled");
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
    if (input) this.beforeTransition?.(input, "recalled");
    const [removed] = this.queue.splice(index, 1);
    if (!removed) return undefined;
    removed.status = "recalled";
    removed.resolve?.("recalled");
    return queueSnapshot(removed);
  }
}

function queueSnapshot(input: QueueItem): QueueSnapshot {
  return {
    id: input.id,
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
