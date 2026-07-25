import type {
  BuiltinResource,
  BuiltinResourceKind,
  PluginResource,
} from "./resource.ts";
import type { BatonSnapshot } from "./snapshot.ts";

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

export interface ResourceContribution<TSpec, TStatus> {
  readonly resourceKind: string;
  readonly reconciler: Reconciler<TSpec, TStatus>;
  readonly maxConcurrency?: number;
}

export interface BuiltinResourceContribution<
  K extends BuiltinResourceKind,
> {
  readonly resourceKind: K;
  readonly reconciler: BuiltinReconciler<K>;
  readonly maxConcurrency?: number;
}
