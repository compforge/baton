import type {
  BuiltinResource,
  BuiltinResourceKind,
  PluginResource,
} from "./resource.ts";
import type { BatonSnapshot } from "./snapshot.ts";
import type { BoardProjector } from "./board.ts";

export type PluginOutput = {
  readonly kind: "proposed-input";
  readonly text: string;
};

export interface ReconcileResult {
  readonly output?: PluginOutput;
  readonly requeueAfterMs?: number;
}

export interface ResourceReconciler<TResource> {
  reconcile(
    baton: Readonly<BatonSnapshot>,
    resource: Readonly<TResource>,
  ): Promise<ReconcileResult | void>;
}

export type Reconciler<TSpec, TStatus> = ResourceReconciler<
  PluginResource<TSpec, TStatus>
>;

export type BuiltinReconciler<K extends BuiltinResourceKind> =
  ResourceReconciler<BuiltinResource<K>>;

export interface ResourceSchedule {
  /** Stable within one ResourceContribution. */
  readonly scheduleId: string;
  /** Five- or six-field cron expression. */
  readonly cron: string;
  /** IANA time zone, for example "Asia/Shanghai" or "UTC". */
  readonly timeZone: string;
}

export interface ResourceContribution<TSpec, TStatus> {
  readonly resourceKind: string;
  readonly reconciler: Reconciler<TSpec, TStatus>;
  /**
   * Recurring wakeups for every current Resource of this kind.
   * A due schedule only enqueues normal keyed reconcile work.
   */
  readonly schedules?: readonly ResourceSchedule[];
  /** Optional derived read model for Baton's shared Board. */
  readonly board?: BoardProjector<TSpec, TStatus>;
  readonly maxConcurrency?: number;
}

export interface BuiltinResourceContribution<
  K extends BuiltinResourceKind,
> {
  readonly resourceKind: K;
  readonly reconciler: BuiltinReconciler<K>;
  readonly maxConcurrency?: number;
}
