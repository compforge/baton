import type { TurnSummary } from "./snapshot.ts";
import type {
  AnyResourceNamespace,
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
  readonly namespace: AnyResourceNamespace;
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
  /** Concrete Resource scope. Baton-owned Resources use a Baton-reserved namespace. */
  readonly namespace: AnyResourceNamespace;
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
  /** Exact namespace to query. Plugin-owned Resources default to user-global `v1`. */
  readonly namespace?: AnyResourceNamespace;
  /** Include every descendant namespace below `namespace`. */
  readonly includeDescendants?: boolean;
  readonly matchLabels?: Readonly<Record<string, string>>;
}

export interface ResourceReader {
  get<TSpec, TStatus>(
    ref: ResourceRef,
  ): Promise<Readonly<Resource<TSpec, TStatus>> | undefined>;
  list<TSpec, TStatus>(
    type: ResourceType,
    options?: ResourceListOptions,
  ): Promise<readonly Readonly<Resource<TSpec, TStatus>>[]>;
}

/** Kubernetes-style merge patch payload; each Resource provider validates supported paths. */
export interface ResourceMergePatch {
  readonly type: "merge";
  readonly value: Readonly<Record<string, unknown>>;
}

export interface ResourceWriter {
  create<TSpec, TStatus>(
    type: ResourceType,
    init: {
      name: string;
      /** Concrete Resource namespace. Defaults to the user-global `v1`. */
      namespace?: ResourceNamespace;
      labels?: Readonly<Record<string, string>>;
      annotations?: Readonly<Record<string, string>>;
      owner?: ResourceOwnerReference;
      spec: TSpec;
    },
  ): Promise<Readonly<Resource<TSpec, TStatus>>>;
  /** Requests cascading deletion; final removal follows successful reconcile. */
  delete(
    type: ResourceType,
    name: string,
    namespace?: ResourceNamespace,
  ): Promise<void>;
  /** Applies one optimistic patch against the supplied Resource incarnation/version. */
  patch<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: ResourceMergePatch,
  ): Promise<Readonly<Resource<TSpec, TStatus>>>;
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

/**
 * Host-owned Resource access. Core projections are provider-backed, while
 * Plugin-owned Resources remain isolated by PluginInstance.
 *
 * @spec One PluginInstance may own Resources in global, Project, and Session namespaces simultaneously; omitted mutation namespace defaults to `v1`.
 */
export interface ResourceClient extends ResourceReader, ResourceWriter {
  /**
   * @spec A ResourceRef lookup returns the latest Resource only within the referenced namespace and, when uid is present, only for that exact incarnation; deletion or replacement returns undefined.
   * @rule After awaiting a Core verb, use a uid-pinned ref before applying the result so a stale continuation cannot write to a replacement Resource.
   */
  get<TSpec, TStatus>(
    ref: ResourceRef,
  ): Promise<Readonly<Resource<TSpec, TStatus>> | undefined>;
}

export type BatonTurnResourceApiVersion = "baton.dev/v1alpha1";
export type BatonTurnResourceKind = "Turn";

export type BatonSessionResourceKind = "Session";
export type BatonTargetResourceKind = "Target";
export type BatonSessionTargetBindingResourceKind = "SessionTargetBinding";

export interface BatonSessionResourceStatus {
  readonly phase: "Active" | "Inactive";
}

export interface BatonTargetResourceSpec {
  readonly harness: string;
}

export interface BatonTargetResourceStatus {
  readonly phase: "Ready" | "Unavailable";
}

export interface BatonSessionTargetBindingResourceSpec {
  readonly sessionRef: ResourceRef;
  readonly eligibleTargetRefs: readonly ResourceRef[];
  readonly targetRef?: ResourceRef;
}

export interface BatonSessionTargetBindingResourceStatus {
  readonly observedGeneration: number;
  readonly effectiveTargetRef?: ResourceRef;
  readonly phase: "Pending" | "Bound" | "Failed";
}

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

export type BatonSessionResource = Resource<
  Record<string, never>,
  BatonSessionResourceStatus
> & {
  readonly apiVersion: BatonTurnResourceApiVersion;
  readonly kind: BatonSessionResourceKind;
};

export type BatonTargetResource = Resource<
  BatonTargetResourceSpec,
  BatonTargetResourceStatus
> & {
  readonly apiVersion: BatonTurnResourceApiVersion;
  readonly kind: BatonTargetResourceKind;
};

export type BatonSessionTargetBindingResource = Resource<
  BatonSessionTargetBindingResourceSpec,
  BatonSessionTargetBindingResourceStatus
> & {
  readonly apiVersion: BatonTurnResourceApiVersion;
  readonly kind: BatonSessionTargetBindingResourceKind;
};
