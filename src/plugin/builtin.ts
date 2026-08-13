import type {
  AnyEventEnvelope,
  EventEnvelope,
  TurnSummary,
} from "../event/index.ts";
import type {
  ReconcileContext,
  ResourceRef,
  Watch,
} from "@compforge/baton-plugin";
import type { SessionHandle } from "../store/store.ts";
import { newId } from "../event/ids.ts";
import {
  type ControllerRetryOptions,
  type ReconcileKey,
  type ReconcileResult,
  ReconcileRetry,
  type ReconcileScope,
  type ScheduledReconcile,
} from "./controller.ts";
import type { ResourceClientChange } from "./resource-client.ts";
import { ReconcileQueue, type ReconcileCapacityLease } from "./queue.ts";
import { reconcileResourceOwner } from "./reconcile-scope.ts";
import {
  emptyReconcileSnapshot,
  type ReconcileSnapshot,
} from "./reconcile-snapshot.ts";
import { validateSources } from "./source.ts";
import { validateWatches, watchRequests } from "./watch.ts";
import {
  createReconcileContext,
  type ExecutionScope,
  type InvokeVerb,
} from "./verb.ts";
import type {
  ControllerSource,
  CronSource,
} from "./package.ts";
import {
  BATON_SYSTEM_NAMESPACE,
  BATON_TURN_RESOURCE_TYPE,
} from "./package.ts";

export const BATON_TURN_RESOURCE_KIND = BATON_TURN_RESOURCE_TYPE.kind;

export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export type BatonTurnResourceData = DeepReadonly<TurnSummary> & {
  readonly harness?: string;
  readonly harnessTargetId?: string;
  readonly laneId?: string;
  readonly harnessSessionId?: string;
};

export interface BuiltinResourceDataMap {
  [BATON_TURN_RESOURCE_KIND]: BatonTurnResourceData;
}

export type BuiltinResourceKind = keyof BuiltinResourceDataMap;

export interface BuiltinResourceMetadata {
  readonly batonSessionId: string;
  readonly resourceId: string;
  /** 产生当前 Resource 的 ledger seq；Baton-owned Resource 自身不另设持久真相。 */
  readonly revision: number;
  readonly sourceEventId: string;
  readonly observedAt: string;
}

export interface BuiltinResource<K extends BuiltinResourceKind = BuiltinResourceKind> {
  readonly kind: K;
  readonly metadata: BuiltinResourceMetadata;
  readonly data: BuiltinResourceDataMap[K];
}

export type AnyBuiltinResource = {
  [K in BuiltinResourceKind]: BuiltinResource<K>;
}[BuiltinResourceKind];

type BuiltinSession = Pick<
  SessionHandle,
  "id" | "dir" | "ledger" | "subscribe"
>;

export interface BatonResourceIndexOptions {
  session: BuiltinSession;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function turnResource(
  event: EventEnvelope<"_baton_turn_summary">,
): BuiltinResource<typeof BATON_TURN_RESOURCE_KIND> {
  return deepFreeze({
    kind: BATON_TURN_RESOURCE_KIND,
    metadata: {
      batonSessionId: event.scope.batonSessionId,
      resourceId: event.payload.turnId,
      revision: event.seq,
      sourceEventId: event.eventId,
      observedAt: event.ts,
    },
    data: {
      ...event.payload,
      ...(event.harness === undefined ? {} : { harness: event.harness }),
      ...(event.harnessTargetId === undefined
        ? {}
        : { harnessTargetId: event.harnessTargetId }),
      ...(event.laneId === undefined
        ? {}
        : { laneId: event.laneId }),
      ...(event.harnessSessionId === undefined
        ? {}
        : { harnessSessionId: event.harnessSessionId }),
    },
  });
}

function builtinResourceRef(resource: BuiltinResource): ResourceRef {
  return Object.freeze({
    ...BATON_TURN_RESOURCE_TYPE,
    namespace: BATON_SYSTEM_NAMESPACE,
    name: resource.metadata.resourceId,
    uid: resource.metadata.sourceEventId,
  });
}

/**
 * Event Ledger 派生出的只读 Baton Resource 索引。它不创建第二份事实，也不提供 patch API。
 */
export class BatonResourceIndex {
  readonly batonSessionId: string;
  readonly session: Readonly<Pick<SessionHandle, "id" | "dir">>;
  private readonly turns = new Map<
    string,
    BuiltinResource<typeof BATON_TURN_RESOURCE_KIND>
  >();
  private readonly listeners = new Set<(resource: AnyBuiltinResource) => void>();
  private readonly unsubscribeSession: () => void;
  private closed = false;

  constructor(options: BatonResourceIndexOptions) {
    this.batonSessionId = options.session.id;
    this.session = Object.freeze({
      id: options.session.id,
      dir: options.session.dir,
    });
    for (const event of options.session.ledger.read()) this.project(event, false);
    this.unsubscribeSession = options.session.subscribe((event) => {
      this.project(event, true);
    });
  }

  get<K extends BuiltinResourceKind>(
    kind: K,
    resourceId: string,
  ): BuiltinResource<K> {
    this.assertKind(kind);
    const resource = this.turns.get(resourceId);
    if (!resource) {
      throw new Error(`builtin resource not found: ${kind}/${resourceId}`);
    }
    return resource as BuiltinResource<K>;
  }

  list<K extends BuiltinResourceKind>(kind: K): BuiltinResource<K>[] {
    this.assertKind(kind);
    return [...this.turns.values()]
      .sort((left, right) => left.metadata.revision - right.metadata.revision)
      .map((resource) => resource as BuiltinResource<K>);
  }

  subscribe(listener: (resource: AnyBuiltinResource) => void): () => void {
    if (this.closed) throw new Error("Baton resource index is closed");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeSession();
    this.listeners.clear();
  }

  private project(event: AnyEventEnvelope, notify: boolean): void {
    if (event.kind !== "_baton_turn_summary") return;
    const resource = turnResource(event);
    const current = this.turns.get(resource.metadata.resourceId);
    if (current && current.metadata.revision >= resource.metadata.revision) return;
    this.turns.set(resource.metadata.resourceId, resource);
    if (!notify || this.closed) return;
    for (const listener of this.listeners) listener(resource);
  }

  private assertKind(kind: string): asserts kind is BuiltinResourceKind {
    if (kind !== BATON_TURN_RESOURCE_KIND) {
      throw new Error(`unsupported builtin resource kind: ${kind}`);
    }
  }
}

export interface BuiltinControllerOptions<K extends BuiltinResourceKind> {
  resources: BatonResourceIndex;
  pluginInstanceId: string;
  resourceKind: K;
  sources?: readonly ControllerSource[];
  watches?: readonly Watch[];
  reconcile(
    context: ReconcileContext,
    resource: Readonly<BuiltinResource<K>>,
  ): Promise<ReconcileResult | void>;
  maxConcurrency?: number;
  now?: () => Date;
  /** 每次执行前读取最新 BatonSession 只读视图。 */
  snapshot?: (key: ReconcileKey, resource: ResourceRef) => ReconcileSnapshot;
  invokeVerb?: InvokeVerb;
  executeReconcile?: <T>(
    scope: ExecutionScope,
    localLease: ReconcileCapacityLease,
    execute: () => Promise<T>,
  ) => Promise<T>;
  onReconcileSuccess?(key: ReconcileKey, nextReconcileAt: Date | null): void;
  onReconcileError?(key: ReconcileKey, error: unknown): void;
  onWatchError?(change: ResourceClientChange, error: unknown): void;
  retry?: ControllerRetryOptions;
}

function validatedResult(result: ReconcileResult | void): ReconcileResult {
  if (!result) return {};
  if (
    result.requeueAfterMs !== undefined &&
    (!Number.isSafeInteger(result.requeueAfterMs) || result.requeueAfterMs < 1)
  ) {
    throw new Error("reconcile requeueAfterMs must be a positive integer");
  }
  return result;
}

/**
 * 一个 Plugin 对一种 Baton-owned Resource 的只读 Controller。
 * 重放和 live event 最终都只入同一 keyed queue，Controller 每次重新读取最新 Resource。
 */
export class BuiltinController<K extends BuiltinResourceKind> {
  readonly scope: ReconcileScope;
  readonly sources: readonly ControllerSource[];
  readonly watches: readonly Watch[];
  private readonly resources: BatonResourceIndex;
  private readonly resourceKind: K;
  private readonly reconcileResource: BuiltinControllerOptions<K>["reconcile"];
  private readonly now: () => Date;
  private readonly snapshot: NonNullable<BuiltinControllerOptions<K>["snapshot"]>;
  private readonly invokeVerb: InvokeVerb;
  private readonly executeReconcile: NonNullable<
    BuiltinControllerOptions<K>["executeReconcile"]
  >;
  private readonly onWatchError?: BuiltinControllerOptions<K>["onWatchError"];
  private readonly queue: ReconcileQueue;
  private readonly retry?: ReconcileRetry;
  private closed = false;

  constructor(options: BuiltinControllerOptions<K>) {
    if (!options.pluginInstanceId.trim()) {
      throw new Error("pluginInstanceId must not be empty");
    }
    this.resources = options.resources;
    this.resourceKind = options.resourceKind;
    validateWatches(options.watches);
    this.now = options.now ?? (() => new Date());
    validateSources(options.sources, this.now());
    this.sources = Object.freeze([...(options.sources ?? [])]);
    this.watches = Object.freeze([...(options.watches ?? [])]);
    if (this.sources.some((source) => source.type === "resource")) {
      throw new Error(
        "Controller resource Sources cannot materialize Baton-owned Resources",
      );
    }
    this.resources.list(options.resourceKind);
    this.reconcileResource = options.reconcile;
    this.snapshot =
      options.snapshot ??
      (() => emptyReconcileSnapshot(options.resources.batonSessionId));
    this.invokeVerb = options.invokeVerb ?? (async () => {
      throw new Error("plugin BuiltinController has no reconcile capability host");
    });
    this.scope = Object.freeze({
      batonSessionId: options.resources.batonSessionId,
      pluginInstanceId: options.pluginInstanceId,
      resourceApiVersion: BATON_TURN_RESOURCE_TYPE.apiVersion,
      resourceKind: options.resourceKind,
      resourceOwner: "baton",
    });
    this.executeReconcile = options.executeReconcile ??
      (async <T>(
        _scope: ExecutionScope,
        _localLease: ReconcileCapacityLease,
        execute: () => Promise<T>,
      ) => await execute());
    this.onWatchError = options.onWatchError;
    if (options.retry) {
      this.retry = new ReconcileRetry({
        ...options.retry,
      });
    }
    this.queue = new ReconcileQueue({
      execute: (key, localLease) => {
        const executionScope = Object.freeze({
          batonSessionId: key.batonSessionId,
          pluginInstanceId: key.pluginInstanceId,
          executionId: newId("pex"),
        });
        return this.executeReconcile(executionScope, localLease, async () => {
          if (this.closed) throw new Error("plugin Controller is closed");
          const resource = this.resources.get(this.resourceKind, key.resourceId);
          const resourceRef = builtinResourceRef(resource);
          const snapshot = deepFreeze(this.snapshot(key, resourceRef));
          if (snapshot.session.batonSessionId !== this.scope.batonSessionId) {
            throw new Error(
              `ReconcileSnapshot batonSessionId must be ${this.scope.batonSessionId}, got ${snapshot.session.batonSessionId}`,
            );
          }
          const context = createReconcileContext(
            snapshot,
            executionScope,
            this.invokeVerb,
          );
          const result = validatedResult(
            await this.reconcileResource(context, resource),
          );
          const now = this.now();
          if (Number.isNaN(now.getTime())) {
            throw new Error("plugin Controller now() returned an invalid Date");
          }
          const nextReconcileAt =
            result.requeueAfterMs === undefined
              ? null
              : new Date(now.getTime() + result.requeueAfterMs);
          options.onReconcileSuccess?.(key, nextReconcileAt);
          if (this.retry) this.retry.succeeded(key, nextReconcileAt);
        });
      },
      maxConcurrency: options.maxConcurrency,
      onError: (key, error) => {
        if (this.retry) this.retry.failed(key, error);
        else options.onReconcileError?.(key, error);
      },
    });
  }

  enqueue(key: ReconcileKey): Promise<void> {
    try {
      this.assertOwns(key);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.queue.enqueue(Object.freeze({ ...key, resourceOwner: "baton" }));
  }

  cronSources(): readonly CronSource[] {
    return this.sources.filter(
      (source): source is CronSource =>
        source.type === "cron",
    );
  }

  async reconcileKeys(
    change: ResourceClientChange,
  ): Promise<readonly ReconcileKey[]> {
    if (change.resource.metadata.namespace !== this.scope.pluginInstanceId) {
      return [];
    }
    let requests;
    try {
      requests = await watchRequests(this.watches, change);
    } catch (error) {
      this.onWatchError?.(change, error);
      return [];
    }
    return Object.freeze(requests.map((request) => Object.freeze({
      ...this.scope,
      resourceId: request.name,
    })));
  }

  close(): void {
    this.closed = true;
    this.retry?.close();
    this.queue.close();
  }

  initialReconciles(): ReconcileKey[] {
    return this.resources.list(this.resourceKind).map((resource) =>
      Object.freeze({
        ...this.scope,
        resourceId: resource.metadata.resourceId,
      }),
    );
  }

  resourceKeys(): ReconcileKey[] {
    return this.initialReconciles();
  }

  scheduledReconciles(): ScheduledReconcile[] {
    return [];
  }

  /** Exact incarnation guard for Event-driven wakeups such as HarnessInvocation results. */
  ownsResource(resource: ResourceRef): boolean {
    if (
      resource.apiVersion !== BATON_TURN_RESOURCE_TYPE.apiVersion ||
      resource.kind !== this.resourceKind ||
      resource.namespace !== BATON_SYSTEM_NAMESPACE
    ) {
      return false;
    }
    try {
      return builtinResourceRef(
        this.resources.get(this.resourceKind, resource.name),
      ).uid === resource.uid;
    } catch {
      return false;
    }
  }

  private assertOwns(key: ReconcileKey): void {
    if (
      key.batonSessionId !== this.scope.batonSessionId ||
      key.pluginInstanceId !== this.scope.pluginInstanceId ||
      key.resourceApiVersion !== this.scope.resourceApiVersion ||
      key.resourceKind !== this.scope.resourceKind ||
      reconcileResourceOwner(key) !== "baton"
    ) {
      throw new Error(
        `reconcile key is outside controller scope: ${key.batonSessionId}/${key.pluginInstanceId}/${key.resourceApiVersion}/${key.resourceKind}/${key.resourceId}`,
      );
    }
  }
}
