import type { TurnSummary } from "./snapshot.ts";

export interface PluginResourceMetadata {
  readonly resourceId: string;
  readonly batonSessionId: string;
  readonly pluginInstanceId: string;
  readonly generation: number;
  readonly resourceVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextReconcileAt?: string;
}

export interface PluginResource<
  TSpec = Record<string, unknown>,
  TStatus = Record<string, unknown>,
> {
  readonly kind: string;
  readonly metadata: PluginResourceMetadata;
  readonly spec: TSpec;
  readonly status: TStatus;
}

export interface PluginResourceClient {
  get<TSpec, TStatus>(
    resourceKind: string,
    resourceId: string,
  ): Readonly<PluginResource<TSpec, TStatus>>;
  list<TSpec, TStatus>(
    resourceKind?: string,
  ): readonly Readonly<PluginResource<TSpec, TStatus>>[];
  create<TSpec, TStatus>(
    resourceKind: string,
    init: {
      resourceId: string;
      spec: TSpec;
    },
  ): Readonly<PluginResource<TSpec, TStatus>>;
  delete(resourceKind: string, resourceId: string): void;
  patchStatus<TSpec, TStatus>(
    resource: Readonly<PluginResource<TSpec, TStatus>>,
    patch: Partial<TStatus>,
  ): Readonly<PluginResource<TSpec, TStatus>>;
}

export type BatonTurnResourceKind = "baton.turn";

export type BatonTurnResourceData = TurnSummary & {
  readonly harness?: string;
  readonly harnessTargetId?: string;
  readonly harnessSessionId?: string;
};

export interface BuiltinResourceDataMap {
  "baton.turn": BatonTurnResourceData;
}

export type BuiltinResourceKind = keyof BuiltinResourceDataMap;

export interface BuiltinResourceMetadata {
  readonly batonSessionId: string;
  readonly resourceId: string;
  readonly revision: number;
  readonly sourceEventId: string;
  readonly observedAt: string;
}

export interface BuiltinResource<
  K extends BuiltinResourceKind = BuiltinResourceKind,
> {
  readonly kind: K;
  readonly metadata: BuiltinResourceMetadata;
  readonly data: BuiltinResourceDataMap[K];
}
