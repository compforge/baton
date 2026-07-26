import type { TurnSummary } from "./snapshot.ts";

export interface ResourceMetadata {
  readonly resourceId: string;
  readonly batonSessionId: string;
  readonly pluginInstanceId: string;
  readonly generation: number;
  readonly resourceVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextReconcileAt?: string;
}

export interface Resource<
  TSpec = Record<string, unknown>,
  TStatus = Record<string, unknown>,
> {
  readonly kind: string;
  readonly metadata: ResourceMetadata;
  readonly spec: TSpec;
  readonly status: TStatus;
}

export interface ResourceClient {
  get<TSpec, TStatus>(
    resourceKind: string,
    resourceId: string,
  ): Readonly<Resource<TSpec, TStatus>>;
  list<TSpec, TStatus>(
    resourceKind?: string,
  ): readonly Readonly<Resource<TSpec, TStatus>>[];
  create<TSpec, TStatus>(
    resourceKind: string,
    init: {
      resourceId: string;
      spec: TSpec;
    },
  ): Readonly<Resource<TSpec, TStatus>>;
  delete(resourceKind: string, resourceId: string): void;
  patchStatus<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: Partial<TStatus>,
  ): Readonly<Resource<TSpec, TStatus>>;
}

export type BatonTurnResourceKind = "baton.turn";

export type BatonTurnResourceData = TurnSummary & {
  readonly harness?: string;
  readonly harnessTargetId?: string;
  readonly harnessSessionId?: string;
};

/** Read-only Resource shape exposed by the Baton-owned `baton.turn` kind. */
export type BatonTurnResource = Resource<
  Record<string, never>,
  BatonTurnResourceData
> & {
  readonly kind: BatonTurnResourceKind;
};
