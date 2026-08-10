import { newId } from "../event/ids.ts";
import type { PromptBlock } from "../event/types.ts";
import type { HarnessTarget } from "../harness/target.ts";

/** The actor that caused a prompt Input to enter Baton. */
export type InputSource =
  | { type: "user" }
  | {
      type: "plugin";
      pluginInstanceId: string;
      turnRequestId: string;
    };

/**
 * 一条 prompt Input 的生命周期状态（见 docs/workflow.md“采集与准入”）。让 recall /
 * interrupt / steer / race 的迁移成为对同一 Input 的状态查询，而不是散落在 submit /
 * steer / Esc 里的时序特判。
 */
export type InputStatus =
  | "queued"
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
  /** baton turn id：入队时即分配，steer 的 expectedTurnId 引用它。 */
  turnId: string;
  target: HarnessTarget;
  /** Baton-owned logical execution channel selected before admission. */
  laneId: string;
  blocks: PromptBlock[];
  source: InputSource;
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
  sourceProposedPlanId?: string;
}

export type SubmitOutcome = "completed" | "recalled";

/**
 * Input 的内存 owner：只管理待 admission 的队列、输入身份与队列状态迁移。
 * 是否开始 drain、如何执行 turn 仍由 Controller 编排。
 */
export class InputQueue {
  private readonly queue: InputRecord[] = [];
  private nextId = 1;

  get length(): number {
    return this.queue.length;
  }

  get queued(): readonly InputRecord[] {
    return this.queue;
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
      sourceProposedPlanId?: string;
      identity?: { messageId: string; turnId: string };
    },
  ): Promise<SubmitOutcome> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: this.nextId++,
        turnId: options?.identity?.turnId ?? newId("t"),
        messageId: options?.identity?.messageId ?? newId("m"),
        target,
        laneId,
        blocks,
        source: options?.source ?? { type: "user" },
        status: "queued",
        delivery: "prompt",
        ...(options?.sourceProposedPlanId
          ? { sourceProposedPlanId: options.sourceProposedPlanId }
          : {}),
        resolve,
        reject,
      });
    });
  }

  dequeue(): InputRecord | undefined {
    const input = this.queue.shift();
    if (input) input.status = "admitted";
    return input;
  }

  acceptSteer(
    target: HarnessTarget,
    laneId: string,
    turnId: string,
    messageId: string,
    blocks: PromptBlock[],
  ): InputRecord {
    return {
      id: this.nextId++,
      turnId,
      messageId,
      target,
      laneId,
      blocks,
      source: { type: "user" },
      status: "accepted_steer",
      delivery: "steer",
    };
  }

  recallLatestUser(): QueuedTurnSnapshot | undefined {
    const index = this.queue.findLastIndex(
      (input) => input.source.type === "user",
    );
    if (index < 0) return undefined;
    const [input] = this.queue.splice(index, 1);
    if (!input) return undefined;
    input.status = "recalled";
    input.resolve?.("recalled");
    return queuedTurnSnapshot(input);
  }

  cancelTurnRequest(turnRequestId: string): QueuedTurnSnapshot | undefined {
    const index = this.queue.findIndex(
      (input) =>
        input.source.type === "plugin" &&
        input.source.turnRequestId === turnRequestId,
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
  };
}
