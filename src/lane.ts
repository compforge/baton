import { MAIN_LANE_ID } from "@compforge/baton-plugin";

import type { HarnessResumeState } from "./harness/resume.ts";
import type { HarnessLaunchSnapshot } from "./harness/target.ts";

export { MAIN_LANE_ID };

export interface HarnessSessionMeta {
  harness: string;
  /** 当前原生 session 最近一次 create/resume 实际采用的配置快照。 */
  launchSnapshot?: HarnessLaunchSnapshot;
  harnessSessionId?: string;
  /** Adapter 拥有的版本化 checkpoint；Baton 只保存并在下次 open 时原样回传。 */
  resumeState?: HarnessResumeState;
  /** harness 侧恢复所需的游标（如 Claude SDK resume cursor），语义归 adapter */
  resumeCursor?: string;
  /**
   * 当前原生会话的 ContextEpoch identity：resume 保留，fresh session 重新签发。
   * 已接受的 revision 由 ContextDeliveryReceipt 重放；syncedSeq 只是兼容缓存。
   */
  contextEpochId?: string;
  /** 该 ContextEpoch 已同步到的 BatonSession 事件序号（Receipt 的缓存，不是真相源）。 */
  syncedSeq?: number;
  parentSessionId?: string;
}

export type LaneCreatedFor =
  | { type: "session" }
  | { type: "harness_invocation"; invocationId: string }
  /** Reserved for the direct human “start this asynchronously” intake path. */
  | { type: "user_request"; requestId: string };

/**
 * Baton-owned task line. A Lane is independent from Harness selection and can
 * hand work between Targets while remaining serial within the Lane.
 */
export interface LaneMeta {
  laneId: string;
  createdFor: LaneCreatedFor;
  /** Creation provenance for a side Lane; it does not constrain later use. */
  parentLaneId?: string;
  /** harnessTargetId → native binding used by that Target within this Lane. */
  harnessSessions: Record<string, HarnessSessionMeta>;
}

export function createLaneMeta(options: {
  laneId: string;
  createdFor: LaneCreatedFor;
  parentLaneId?: string;
}): LaneMeta {
  return {
    laneId: options.laneId,
    createdFor: options.createdFor,
    ...(options.parentLaneId === undefined
      ? {}
      : { parentLaneId: options.parentLaneId }),
    harnessSessions: {},
  };
}

export function createMainLaneMeta(): LaneMeta {
  return createLaneMeta({
    laneId: MAIN_LANE_ID,
    createdFor: { type: "session" },
  });
}
