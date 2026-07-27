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
  ): Readonly<Resource<TSpec, TStatus>>;
  list<TSpec, TStatus>(
    type: ResourceType,
  ): readonly Readonly<Resource<TSpec, TStatus>>[];
  create<TSpec, TStatus>(
    type: ResourceType,
    init: {
      name: string;
      spec: TSpec;
    },
  ): Readonly<Resource<TSpec, TStatus>>;
  delete(type: ResourceType, name: string): void;
  patchStatus<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: Partial<TStatus>,
  ): Readonly<Resource<TSpec, TStatus>>;
}

export const BATON_API_VERSION = "baton.dev/v1alpha1" as const;
export const BATON_SYSTEM_NAMESPACE = "baton-system" as const;
export const BATON_TURN_RESOURCE_TYPE = Object.freeze({
  apiVersion: BATON_API_VERSION,
  kind: "Turn",
} as const satisfies ResourceType);

export type BatonTurnResourceApiVersion =
  typeof BATON_TURN_RESOURCE_TYPE.apiVersion;
export type BatonTurnResourceKind = typeof BATON_TURN_RESOURCE_TYPE.kind;

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
