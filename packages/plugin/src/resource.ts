import type { TurnSummary } from "./snapshot.ts";

/** Versioned Resource schema identity, equivalent to a Kubernetes GroupVersionKind. */
export interface ResourceType {
  readonly apiVersion: string;
  readonly kind: string;
}

/**
 * Stable Resource reference.
 *
 * `uid` pins one concrete incarnation. Omit it only when the caller intends
 * name-based lookup that may resolve to a replacement Resource.
 */
export interface ResourceRef extends ResourceType {
  readonly namespace: string;
  readonly name: string;
  readonly uid?: string;
}

export interface ResourceMetadata {
  /** Stable name within one namespace and Resource type. */
  readonly name: string;
  /** PluginInstance scope. Baton-owned Resources use a Baton-reserved namespace. */
  readonly namespace: string;
  /** Baton-assigned identity for this concrete incarnation. */
  readonly uid: string;
  /** Desired-state revision. Only spec changes advance it. */
  readonly generation: number;
  /** Opaque optimistic-concurrency token. */
  readonly resourceVersion: string;
  readonly creationTimestamp: string;
  /** Machine-readable grouping and selection metadata owned by the Plugin. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Non-identifying extension metadata owned by the Plugin. */
  readonly annotations?: Readonly<Record<string, string>>;
}

export interface Resource<
  TSpec = Record<string, unknown>,
  TStatus = Record<string, unknown>,
> extends ResourceType {
  readonly metadata: ResourceMetadata;
  readonly spec: TSpec;
  readonly status: TStatus;
}

export interface ResourceClient {
  get<TSpec, TStatus>(
    type: ResourceType,
    name: string,
  ): Promise<Readonly<Resource<TSpec, TStatus>>>;
  list<TSpec, TStatus>(
    type: ResourceType,
  ): Promise<readonly Readonly<Resource<TSpec, TStatus>>[]>;
  create<TSpec, TStatus>(
    type: ResourceType,
    init: {
      name: string;
      labels?: Readonly<Record<string, string>>;
      annotations?: Readonly<Record<string, string>>;
      spec: TSpec;
    },
  ): Promise<Readonly<Resource<TSpec, TStatus>>>;
  delete(type: ResourceType, name: string): Promise<void>;
  patchStatus<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: Partial<TStatus>,
  ): Promise<Readonly<Resource<TSpec, TStatus>>>;
}

export type BatonTurnResourceApiVersion = "baton.dev/v1alpha1";
export type BatonTurnResourceKind = "Turn";

export type BatonTurnResourceData = TurnSummary & {
  readonly harness?: string;
  readonly harnessTargetId?: string;
  readonly harnessSessionId?: string;
};

/** Read-only Resource shape exposed by Baton-owned Turn observations. */
export type BatonTurnResource = Resource<
  Record<string, never>,
  BatonTurnResourceData
> & {
  readonly apiVersion: BatonTurnResourceApiVersion;
  readonly kind: BatonTurnResourceKind;
};
