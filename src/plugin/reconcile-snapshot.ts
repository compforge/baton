import type { InputSnapshot as ControllerInputSnapshot } from "../controller/input.ts";
import type { TurnSummary } from "../event/types.ts";
import type { HarnessTarget } from "../harness/target.ts";
import type {
  Interaction,
  InteractionRequester,
} from "../interaction/types.ts";
import type { SessionState } from "../store/reduce.ts";

type SnapshotReadonly<T> =
  T extends string | number | boolean | bigint | symbol | null | undefined
    ? T
    : T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly SnapshotReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: SnapshotReadonly<T[Key]> }
        : T;

export interface SessionSnapshot {
  readonly batonSessionId: string;
  readonly cwd?: string;
  readonly runState: SessionState["runState"];
  /** Event Ledger 当前水位。 */
  readonly revision: number;
}

export interface ActiveTurnSnapshot {
  readonly turnId: string;
  readonly role: "driven" | "observed";
  readonly state: "running" | "requires_action";
  readonly harness?: string;
  readonly harnessTargetId?: string;
  readonly laneId?: string;
  readonly startedAt?: number;
}

export interface InputSnapshot {
  readonly messageId: string;
  readonly turnId: string;
  readonly harnessTargetId: string;
  readonly laneId: string;
  readonly harness: string;
  readonly status: ControllerInputSnapshot["status"];
  readonly delivery: ControllerInputSnapshot["delivery"];
  readonly source: SnapshotReadonly<ControllerInputSnapshot["source"]>;
  readonly harnessInvocationId?: string;
}

export interface HarnessTargetSnapshot {
  readonly id: string;
  readonly harness: string;
  readonly label?: string;
}

export interface PendingInteractionSnapshot {
  readonly interactionId: string;
  readonly kind: Interaction["kind"];
  readonly requester: SnapshotReadonly<InteractionRequester>;
  readonly turnId?: string;
}

/**
 * Plugin reconcile 开始时冻结的 BatonSession 只读视图。
 *
 * Snapshot 只暴露 Plugin 做当前决策所需的稳定视图；内部 Controller、Store、HarnessBinding
 * 和其他可变 owner 不穿透这条边界。
 */
export interface ReconcileSnapshot {
  readonly session: SessionSnapshot;
  readonly activeTurns: readonly ActiveTurnSnapshot[];
  readonly inputs: readonly InputSnapshot[];
  readonly harnessTargets: readonly HarnessTargetSnapshot[];
  readonly pendingInteractions: readonly PendingInteractionSnapshot[];
  readonly latestTurn?: SnapshotReadonly<TurnSummary>;
  readonly turns: readonly SnapshotReadonly<TurnSummary>[];
}

interface CreateReconcileSnapshotOptions {
  readonly batonSessionId: string;
  readonly cwd?: string;
  readonly state: Pick<
    SessionState,
    "runState" | "lastSeq" | "activeTurns" | "interactions" | "turnSummaries"
  >;
  readonly inputs?: readonly ControllerInputSnapshot[];
  readonly harnessTargets?: readonly (HarnessTarget & { readonly label?: string })[];
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Host-side snapshot builder; Plugin packages only consume the resulting ReconcileSnapshot type. */
export function createReconcileSnapshot(options: CreateReconcileSnapshotOptions): ReconcileSnapshot {
  const latestTurn = options.state.turnSummaries.at(-1);
  return deepFreeze({
    session: {
      batonSessionId: options.batonSessionId,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      runState: options.state.runState,
      revision: options.state.lastSeq,
    },
    activeTurns: [...options.state.activeTurns.values()].map((turn) => ({
      turnId: turn.turnId,
      role: turn.role,
      state: turn.state,
      ...(turn.harness === undefined ? {} : { harness: turn.harness }),
      ...(turn.harnessTargetId === undefined
        ? {}
        : { harnessTargetId: turn.harnessTargetId }),
      ...(turn.laneId === undefined
        ? {}
        : { laneId: turn.laneId }),
      ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    })),
    inputs: (options.inputs ?? []).map((input) => ({ ...input })),
    harnessTargets: (options.harnessTargets ?? []).map((target) => ({
      id: target.id,
      harness: target.harness,
      ...(target.label === undefined ? {} : { label: target.label }),
    })),
    pendingInteractions: [...options.state.interactions.values()]
      .filter((entry) => entry.resolution === undefined)
      .map((entry) => ({
        interactionId: entry.interaction.interactionId,
        kind: entry.interaction.kind,
        requester: { ...entry.interaction.requester },
        ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }),
      })),
    turns: options.state.turnSummaries.map((turn) => ({
      ...turn,
      toolCalls: turn.toolCalls.map((toolCall) => ({ ...toolCall })),
      ...(turn.usage === undefined ? {} : { usage: { ...turn.usage } }),
    })),
    ...(latestTurn === undefined
      ? {}
      : {
          latestTurn: {
            ...latestTurn,
            toolCalls: latestTurn.toolCalls.map((toolCall) => ({ ...toolCall })),
            ...(latestTurn.usage === undefined ? {} : { usage: { ...latestTurn.usage } }),
          },
        }),
  });
}

export function emptyReconcileSnapshot(batonSessionId: string): ReconcileSnapshot {
  return deepFreeze({
    session: {
      batonSessionId,
      runState: "idle",
      revision: 0,
    },
    activeTurns: [],
    inputs: [],
    harnessTargets: [],
    pendingInteractions: [],
    turns: [],
  });
}
