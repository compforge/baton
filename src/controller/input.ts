import { newId } from "../event/ids.ts";
import type { PromptBlock } from "../event/types.ts";
import type { HarnessTarget } from "../harness/target.ts";

/** The actor that caused a prompt Input to enter Baton. */
export type InputSource =
  | { type: "user" }
  | {
      type: "plugin";
      pluginInstanceId: string;
    };

/**
 * 一条 prompt Input 的生命周期状态（见 docs/workflow.md“采集与准入”）。让 recall /
 * interrupt / steer / race 的迁移成为对同一 Input 的状态查询，而不是散落在 submit /
 * steer / Esc 里的时序特判。
 */
export type InputStatus =
  | "queued"
  | "dispatching"
  | "admitted"
  | "accepted_steer"
  | "finalized"
  | "recalled"
  | "interrupted";

/**
 * 一条输入的 controller 生命周期记录。身份即 `messageId`：durable 形态是事件流里的
 * `user_message`，live 形态就是这条记录，不另造平行身份。
 */
export interface InputRecord {
  messageId: string;
  /** 队列内展示排序用的自增号；与身份无关。 */
  id: number;
  /** 为新 Turn 预留的 ID；accepted steer 后改为实际承载它的当前 Turn ID。 */
  turnId: string;
  target: HarnessTarget;
  /** Baton-owned logical execution channel selected before admission. */
  laneId: string;
  blocks: PromptBlock[];
  source: InputSource;
  /** Durable causal link; orthogonal to the actor recorded in source. */
  harnessInvocationId?: string;
  status: InputStatus;
  delivery: "prompt" | "steer";
  /** 本 turn 是用户对某个已完成计划提案的明确执行请求。 */
  sourceProposedPlanId?: string;
  /** queued/admitted 专属：submit 的回执通道；accepted_steer 无。 */
  resolve?: (outcome: SubmitOutcome) => void;
  reject?: (error: unknown) => void;
}

export interface QueuedTurnSnapshot {
  id: number;
  turnId: string;
  harnessTargetId: string;
  laneId: string;
  harness: string;
  blocks: PromptBlock[];
  source: InputSource;
  harnessInvocationId?: string;
}

/** Input 只读快照：投影 / 诊断消费 status，不触碰内部 resolve/reject。 */
export interface InputSnapshot {
  messageId: string;
  turnId: string;
  harnessTargetId: string;
  laneId: string;
  harness: string;
  status: InputStatus;
  delivery: "prompt" | "steer";
  source: InputSource;
  harnessInvocationId?: string;
  sourceProposedPlanId?: string;
}

export type SubmitOutcome = "completed" | "recalled";

export interface InputSubmission {
  input: InputRecord;
  outcome: Promise<SubmitOutcome>;
}

/**
 * Input 的内存 owner：只管理待 admission 的队列、输入身份与队列状态迁移。
 * 是否开始 drain、如何执行 turn 仍由 Controller 编排。
 */
export class InputQueue {
  private readonly queue: InputRecord[] = [];
  private readonly dispatching = new Map<string, InputRecord>();
  private nextId = 1;

  get length(): number {
    return this.queue.length;
  }

  get queued(): readonly InputRecord[] {
    return this.queue;
  }

  get claimed(): readonly InputRecord[] {
    return [...this.dispatching.values()];
  }

  get snapshots(): QueuedTurnSnapshot[] {
    return this.queue.map(queuedTurnSnapshot);
  }

  enqueue(
    target: HarnessTarget,
    laneId: string,
    blocks: PromptBlock[],
    options?: {
      source?: InputSource;
      harnessInvocationId?: string;
      sourceProposedPlanId?: string;
      identity?: { messageId: string; turnId: string };
    },
  ): InputSubmission {
    let resolve!: (outcome: SubmitOutcome) => void;
    let reject!: (error: unknown) => void;
    const outcome = new Promise<SubmitOutcome>((resolveOutcome, rejectOutcome) => {
      resolve = resolveOutcome;
      reject = rejectOutcome;
    });
    const input: InputRecord = {
      id: this.nextId++,
      turnId: options?.identity?.turnId ?? newId("t"),
      messageId: options?.identity?.messageId ?? newId("m"),
      target,
      laneId,
      blocks,
      source: options?.source ?? { type: "user" },
      ...(options?.harnessInvocationId === undefined
        ? {}
        : { harnessInvocationId: options.harnessInvocationId }),
      status: "queued",
      delivery: "prompt",
      ...(options?.sourceProposedPlanId
        ? { sourceProposedPlanId: options.sourceProposedPlanId }
        : {}),
      resolve,
      reject,
    };
    this.queue.push(input);
    return { input, outcome };
  }

  /**
   * @spec 只有仍位于队头的 Input 才能被 same-turn dispatch claim；claim 后不可被 composer recall。
   * @see {@link ../../docs/workflow.md}
   */
  claimFirstForSteer(input: InputRecord): boolean {
    if (this.dispatching.size > 0 || this.queue[0] !== input) return false;
    this.queue.shift();
    input.status = "dispatching";
    input.delivery = "steer";
    this.dispatching.set(input.messageId, input);
    return true;
  }

  acceptClaimedSteer(input: InputRecord, turnId: string): void {
    if (!this.dispatching.delete(input.messageId)) {
      throw new Error(`Input ${input.messageId} is not dispatching`);
    }
    input.turnId = turnId;
    input.status = "accepted_steer";
  }

  requeueClaimed(input: InputRecord): void {
    if (!this.dispatching.delete(input.messageId)) {
      throw new Error(`Input ${input.messageId} is not dispatching`);
    }
    input.status = "queued";
    input.delivery = "prompt";
    this.queue.unshift(input);
  }

  abandonClaimed(input: InputRecord): void {
    if (!this.dispatching.delete(input.messageId)) return;
    input.status = "interrupted";
    input.resolve?.("completed");
  }

  dequeue(predicate?: (input: InputRecord) => boolean): InputRecord | undefined {
    const index = predicate ? this.queue.findIndex(predicate) : 0;
    if (index < 0) return;
    const [input] = this.queue.splice(index, 1);
    if (input) input.status = "admitted";
    return input;
  }

  recallLatestUser(): QueuedTurnSnapshot | undefined {
    const index = this.queue.findLastIndex(
      // HarnessInvocation owns its own durable cancellation lifecycle. Generic
      // composer recall must not detach a queued Input from that Request.
      (input) => input.source.type === "user" && !input.harnessInvocationId,
    );
    if (index < 0) return undefined;
    const [input] = this.queue.splice(index, 1);
    if (!input) return undefined;
    input.status = "recalled";
    input.resolve?.("recalled");
    return queuedTurnSnapshot(input);
  }

  cancelHarnessInvocation(harnessInvocationId: string): QueuedTurnSnapshot | undefined {
    const index = this.queue.findIndex(
      (input) => input.harnessInvocationId === harnessInvocationId,
    );
    if (index < 0) return undefined;
    const [input] = this.queue.splice(index, 1);
    if (!input) return undefined;
    input.status = "recalled";
    input.resolve?.("recalled");
    return queuedTurnSnapshot(input);
  }
}

export function inputSnapshot(input: InputRecord): InputSnapshot {
  return {
    messageId: input.messageId,
    turnId: input.turnId,
    harnessTargetId: input.target.id,
    laneId: input.laneId,
    harness: input.target.harness,
    status: input.status,
    delivery: input.delivery,
    source: { ...input.source },
    ...(input.harnessInvocationId === undefined
      ? {}
      : { harnessInvocationId: input.harnessInvocationId }),
    ...(input.sourceProposedPlanId
      ? { sourceProposedPlanId: input.sourceProposedPlanId }
      : {}),
  };
}

function queuedTurnSnapshot(input: InputRecord): QueuedTurnSnapshot {
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
