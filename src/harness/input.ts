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
 *
 * steer 的调度阶段是 `steering`（Adapter 已接受、等待 Harness 原生投递边界）；
 * 投递结果（applied/failed）记录在 `HarnessInput.deliveryOutcome`，与调度状态正交——
 * 回执可能迟到于 Turn 收口，迟到事实只补 outcome，不回迁 status。
 */
export type HarnessInputStatus =
  | "queued"
  | "dispatching"
  | "admitted"
  | "steering"
  | "failed"
  | "finalized"
  | "recalled"
  | "interrupted";

/** 老 ledger 里 steer 接受态叫 accepted_steer；replay 归一到 steering。 */
export function normalizeHarnessInputStatus(status: string): HarnessInputStatus {
  return status === "accepted_steer" ? "steering" : (status as HarnessInputStatus);
}

/**
 * 一条输入的 controller 生命周期记录。身份即 `messageId`：durable 形态是事件流里的
 * `user_message`，live 形态就是这条记录，不另造平行身份。
 */
export interface HarnessInput {
  messageId: string;
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
  /**
   * steer 的投递结果：applied = 已写入模型上下文，failed = Harness 明确丢弃；
   * undefined = 仍在等待原生投递边界。与 status 正交：Turn 收口不改变它，
   * Harness 回执迟到时只补它不迁 status。
   */
  deliveryOutcome?: "applied" | "failed";
  /** 本 turn 是用户对某个已完成计划提案的明确执行请求。 */
  sourceProposedPlanId?: string;
}

/** Durable WAL fact emitted before one Harness Input state transition. */
export interface HarnessInputUpdate {
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
  deliveryOutcome?: "applied" | "failed";
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
    ...(input.deliveryOutcome === undefined
      ? {}
      : { deliveryOutcome: input.deliveryOutcome }),
    source: { ...input.source },
    ...(input.harnessInvocationId === undefined
      ? {}
      : { harnessInvocationId: input.harnessInvocationId }),
    ...(input.sourceProposedPlanId
      ? { sourceProposedPlanId: input.sourceProposedPlanId }
      : {}),
  };
}
