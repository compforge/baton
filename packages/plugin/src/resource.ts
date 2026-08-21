import type { TurnSummary } from "./snapshot.ts";
import type {
  PluginNamespace,
  ResourceNamespace,
} from "./namespace.ts";

/** Versioned Resource schema identity, equivalent to a Kubernetes GroupVersionKind. */
export interface ResourceType {
  readonly apiVersion: string;
  readonly kind: string;
  /** Optional compact aliases; they are not part of Resource identity. */
  readonly shortNames?: readonly string[];
}

/**
 * Stable Resource reference.
 *
 * `uid` pins one concrete incarnation. Omit it only when the caller intends
 * name-based lookup that may resolve to a replacement Resource.
 */
export interface ResourceRef extends ResourceType {
  readonly namespace: ResourceNamespace;
  readonly name: string;
  readonly uid?: string;
}

/** Pins a dependent Resource to one concrete owner incarnation. */
export interface ResourceOwnerReference extends ResourceRef {
  readonly uid: string;
}

export interface ResourceMetadata {
  /** Stable name within one namespace and Resource type. */
  readonly name: string;
  /** Canonical Binding scope. Baton-owned Resources use a Baton-reserved namespace. */
  readonly namespace: ResourceNamespace;
  /** Baton-assigned identity for this concrete incarnation. */
  readonly uid: string;
  /** Desired-state revision. Only spec changes advance it. */
  readonly generation: number;
  /** Opaque optimistic-concurrency token. */
  readonly resourceVersion: string;
  readonly creationTimestamp: string;
  /** Structural owner used by Baton for cascading deletion. */
  readonly owner?: ResourceOwnerReference;
  /** Set after deletion is requested and retained until reconcile succeeds. */
  readonly deletionTimestamp?: string;
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

/** Exact-match label selector. All entries must match the Resource. */
export interface ResourceListOptions {
  readonly matchLabels?: Readonly<Record<string, string>>;
}

export interface ResourceClient {
  /** Canonical namespace inherited by Resource operations. */
  readonly namespace: PluginNamespace;
  /**
   * @spec A ResourceRef lookup returns the latest Resource only within the referenced namespace and, when uid is present, only for that exact incarnation; deletion or replacement returns undefined.
   * @rule After awaiting a Core verb, use a uid-pinned ref before applying the result so a stale continuation cannot write to a replacement Resource.
   */
  get<TSpec, TStatus>(
    ref: ResourceRef,
  ): Promise<Readonly<Resource<TSpec, TStatus>> | undefined>;
  list<TSpec, TStatus>(
    type: ResourceType,
    options?: ResourceListOptions,
  ): Promise<readonly Readonly<Resource<TSpec, TStatus>>[]>;
  create<TSpec, TStatus>(
    type: ResourceType,
    init: {
      name: string;
      labels?: Readonly<Record<string, string>>;
      annotations?: Readonly<Record<string, string>>;
      owner?: ResourceOwnerReference;
      spec: TSpec;
    },
  ): Promise<Readonly<Resource<TSpec, TStatus>>>;
  /** Requests cascading deletion; final removal follows successful reconcile. */
  delete(type: ResourceType, name: string): Promise<void>;
  /**
   * Patches Plugin-owned metadata by key. A null value removes that key.
   *
   * Identity, desired state, and observed state remain in their dedicated
   * fields and cannot be changed through this method.
   */
  patchMetadata<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: {
      readonly labels?: Readonly<Record<string, string | null>>;
      readonly annotations?: Readonly<Record<string, string | null>>;
    },
  ): Promise<Readonly<Resource<TSpec, TStatus>>>;
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
  readonly laneId?: string;
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
