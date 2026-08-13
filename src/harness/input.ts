import type { PromptBlock } from "../event/index.ts";
import type { HarnessTarget } from "./target.ts";

/** The actor that caused a prompt Input to enter Baton. */
export type HarnessInputSource =
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
export type HarnessInputStatus =
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
export interface HarnessInput {
  messageId: string;
  /** 队列内展示排序用的自增号；与身份无关。 */
  id: number;
  /** 为新 Turn 预留的 ID；accepted steer 后改为实际承载它的当前 Turn ID。 */
  turnId: string;
  target: HarnessTarget;
  /** Baton-owned logical execution channel selected before admission. */
  laneId: string;
  blocks: PromptBlock[];
  source: HarnessInputSource;
  /** Durable causal link; orthogonal to the actor recorded in source. */
  harnessInvocationId?: string;
  /** Human Input or Plugin fact that caused this queued Turn. */
  parentEventId?: string;
  status: HarnessInputStatus;
  delivery: "prompt" | "steer";
  /** 本 turn 是用户对某个已完成计划提案的明确执行请求。 */
  sourceProposedPlanId?: string;
}

/** Durable WAL fact emitted before one Harness Input state transition. */
export interface HarnessInputUpdate {
  queueId: number;
  messageId: string;
  turnId: string;
  harnessTargetId: string;
  laneId: string;
  blocks: PromptBlock[];
  source: HarnessInputSource;
  status: HarnessInputStatus;
  delivery: "prompt" | "steer";
  harnessInvocationId?: string;
  sourceProposedPlanId?: string;
  causeEventId?: string;
}

/** Input 只读快照：投影 / 诊断消费 status，不触碰内部 resolve/reject。 */
export interface HarnessInputSnapshot {
  messageId: string;
  turnId: string;
  harnessTargetId: string;
  laneId: string;
  harness: string;
  status: HarnessInputStatus;
  delivery: "prompt" | "steer";
  source: HarnessInputSource;
  harnessInvocationId?: string;
  sourceProposedPlanId?: string;
}

export function harnessInputUpdate(
  input: HarnessInput,
  status: HarnessInputStatus,
  update?: { turnId?: string; delivery?: HarnessInput["delivery"] },
): HarnessInputUpdate {
  return {
    queueId: input.id,
    messageId: input.messageId,
    turnId: update?.turnId ?? input.turnId,
    harnessTargetId: input.target.id,
    laneId: input.laneId,
    blocks: [...input.blocks],
    source: { ...input.source },
    status,
    delivery: update?.delivery ?? input.delivery,
    ...(input.harnessInvocationId === undefined
      ? {}
      : { harnessInvocationId: input.harnessInvocationId }),
    ...(input.sourceProposedPlanId === undefined
      ? {}
      : { sourceProposedPlanId: input.sourceProposedPlanId }),
    ...(input.parentEventId === undefined
      ? {}
      : { causeEventId: input.parentEventId }),
  };
}

export function harnessInputSnapshot(input: HarnessInput): HarnessInputSnapshot {
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
