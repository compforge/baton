import type {
  Controller as PluginController,
  ControllerSource,
  CronSource,
  ResourceRef,
  ResourceType,
  Watch,
} from "@compforge/baton-plugin";

import type { PluginResource } from "./resource.ts";
import type { ResourceClientChange } from "./resource-client.ts";
import { newId } from "../event/ids.ts";
import {
  PluginResourceStore,
  validateResourceType,
} from "./resource.ts";
import { reconcileKeyId, ReconcileQueue } from "./queue.ts";
import type { ReconcileCapacityLease } from "./queue.ts";
import { reconcileResourceOwner } from "./reconcile-scope.ts";
import {
  emptyReconcileSnapshot,
  type ReconcileSnapshot,
} from "./reconcile-snapshot.ts";
import { ControllerSources, validateSources } from "./source.ts";
import { validateWatches, watchRequests } from "./watch.ts";
import {
  createReconcileContext,
  type ExecutionScope,
  type InvokeVerb,
} from "./verb.ts";

export type ReconcileResourceOwner = "plugin" | "baton";

export interface ReconcileScope {
  readonly batonSessionId: string;
  readonly pluginInstanceId: string;
  readonly resourceApiVersion: string;
  readonly resourceKind: string;
  /** 旧 key 缺省为 plugin；baton 表示只读 Baton-owned Resource。 */
  readonly resourceOwner?: ReconcileResourceOwner;
}

export interface ReconcileKey extends ReconcileScope {
  readonly resourceId: string;
}

export interface ReconcileResult {
  /** 一次性动态唤醒间隔；Controller 负责换算并持久化 nextReconcileAt。 */
  requeueAfterMs?: number;
}

export interface ScheduledReconcile {
  readonly key: ReconcileKey;
  readonly nextReconcileAt: Date;
}

export interface ReconcileRetryBackoff {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

export interface ReconcileFailure {
  readonly key: ReconcileKey;
  readonly error: unknown;
  readonly attempt: number;
  readonly nextRetryAt?: string;
}

export function reconcileRetryBackoff(
  value?: Partial<ReconcileRetryBackoff>,
): ReconcileRetryBackoff {
  const initialDelayMs = value?.initialDelayMs ?? 1_000;
  const maxDelayMs = value?.maxDelayMs ?? 60_000;
  for (const [name, delay] of Object.entries({ initialDelayMs, maxDelayMs })) {
    if (!Number.isSafeInteger(delay) || delay < 1) {
      throw new Error(`retryBackoff.${name} must be a positive integer`);
    }
  }
  if (maxDelayMs < initialDelayMs) {
    throw new Error("retryBackoff.maxDelayMs must be at least initialDelayMs");
  }
  return Object.freeze({ initialDelayMs, maxDelayMs });
}

export interface ControllerRetryOptions {
  backoff: ReconcileRetryBackoff;
  now: () => Date;
  schedule(key: ReconcileKey, nextReconcileAt: Date | null): void;
  report(failure: ReconcileFailure): void;
}

interface ReconcileRetryOptions extends ControllerRetryOptions {
  persist?(key: ReconcileKey, nextRetryAt: Date): void;
}

/** Per-Controller retry state; the shared due queue remains a Manager dependency. */
export class ReconcileRetry {
  private readonly attempts = new Map<string, number>();
  private closed = false;

  constructor(private readonly options: ReconcileRetryOptions) {}

  succeeded(key: ReconcileKey, nextReconcileAt: Date | null): void {
    if (this.closed) return;
    this.attempts.delete(reconcileKeyId(key));
    this.options.schedule(key, nextReconcileAt);
  }

  failed(key: ReconcileKey, error: unknown): void {
    if (this.closed) return;
    const id = reconcileKeyId(key);
    const attempt = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempt);
    const now = this.options.now();
    if (Number.isNaN(now.getTime())) {
      this.options.report({
        key,
        error: new AggregateError([error], "plugin Controller now() returned an invalid Date"),
        attempt,
      });
      return;
    }
    const delay = Math.min(
      this.options.backoff.maxDelayMs,
      this.options.backoff.initialDelayMs * 2 ** Math.min(attempt - 1, 30),
    );
    const nextRetryAt = new Date(now.getTime() + delay);
    try {
      this.options.persist?.(key, nextRetryAt);
      this.options.schedule(key, nextRetryAt);
      this.options.report({
        key,
        error,
        attempt,
        nextRetryAt: nextRetryAt.toISOString(),
      });
    } catch (retryError) {
      this.options.report({
        key,
        error: new AggregateError(
          [error, retryError],
          `could not persist retry for ${key.resourceApiVersion}/${key.resourceKind}/${key.resourceId}`,
        ),
        attempt,
      });
    }
  }

  close(): void {
    this.closed = true;
    this.attempts.clear();
  }
}

export interface ControllerOptions<TSpec, TStatus> {
  store: PluginResourceStore;
  resourceType: ResourceType;
  sources?: readonly ControllerSource<TSpec>[];
  watches?: readonly Watch[];
  reconcile: PluginController<TSpec, TStatus>["reconcile"];
  present?: PluginController<TSpec, TStatus>["present"];
  maxConcurrency?: number;
  now?: () => Date;
  /** 每次执行前读取最新 BatonSession 只读视图。 */
  snapshot?: (key: ReconcileKey, resource: ResourceRef) => ReconcileSnapshot;
  invokeVerb?: InvokeVerb;
  /** Manager 注入的进程总容量；缺省表示不额外限流。 */
  executeWithCapacity?: <T>(execute: () => Promise<T>) => Promise<T>;
  /** Core-owned lifecycle and total capacity for one live Plugin execution. */
  executeReconcile?: <T>(
    scope: ExecutionScope,
    localLease: ReconcileCapacityLease,
    execute: () => Promise<T>,
  ) => Promise<T>;
  /** Reconcile 成功观察点；动态唤醒持久化已由 Controller 完成。 */
  onReconcileSuccess?(key: ReconcileKey, nextReconcileAt: Date | null): void;
  /** 仅报告实际执行失败，不包含 enqueue 参数校验错误。 */
  onReconcileError?(key: ReconcileKey, error: unknown): void;
  retry?: ControllerRetryOptions;
  /** Source 首次 materialize Resource 后失效 Board 等派生投影。 */
  onSourceResource?(resource: Readonly<PluginResource<TSpec, TStatus>>): void;
  /** Terminating Resource reconcile 成功后，向 Manager 发布最终删除事实。 */
  onResourceDeleted?(
    resource: Readonly<PluginResource<unknown, unknown>>,
  ): void;
  onWatchError?(change: ResourceClientChange, error: unknown): void;
}

function ownedKey(key: ReconcileKey): ReconcileKey {
  const copy = {
    batonSessionId: key.batonSessionId,
    pluginInstanceId: key.pluginInstanceId,
    resourceApiVersion: key.resourceApiVersion,
    resourceKind: key.resourceKind,
    resourceId: key.resourceId,
    ...(key.resourceOwner === undefined
      ? {}
      : { resourceOwner: key.resourceOwner }),
  };
  for (const [name, value] of Object.entries({
    batonSessionId: copy.batonSessionId,
    pluginInstanceId: copy.pluginInstanceId,
    resourceApiVersion: copy.resourceApiVersion,
    resourceKind: copy.resourceKind,
    resourceId: copy.resourceId,
  })) {
    if (!value.trim()) throw new Error(`reconcile key ${name} must not be empty`);
  }
  if (
    copy.resourceOwner !== undefined &&
    copy.resourceOwner !== "plugin" &&
    copy.resourceOwner !== "baton"
  ) {
    throw new Error(`reconcile key resourceOwner is invalid: ${String(copy.resourceOwner)}`);
  }
  return Object.freeze(copy);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
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

interface ReconcileExecution {
  deletedResource?: Readonly<PluginResource<unknown, unknown>>;
  nextReconcileAt: Date | null;
}

/**
 * 单个 Plugin Resource Kind 的控制器：拥有 reconcile、独立队列、局部并发和执行边界。
 * Manager 只负责注册、路由和所有 Controller 共享的总容量。
 */
export class Controller<TSpec, TStatus> {
  readonly scope: ReconcileScope;
  readonly sources: readonly ControllerSource<TSpec>[];
  readonly watches: readonly Watch[];
  readonly present?: PluginController<TSpec, TStatus>["present"];
  private readonly store: PluginResourceStore;
  private readonly resourceType: ResourceType;
  private readonly reconcileResource: PluginController<TSpec, TStatus>["reconcile"];
  private readonly now: () => Date;
  private readonly snapshot: NonNullable<
    ControllerOptions<TSpec, TStatus>["snapshot"]
  >;
  private readonly executeWithCapacity: NonNullable<
    ControllerOptions<TSpec, TStatus>["executeWithCapacity"]
  >;
  private readonly invokeVerb: InvokeVerb;
  private readonly executeReconcile: NonNullable<
    ControllerOptions<TSpec, TStatus>["executeReconcile"]
  >;
  private readonly onWatchError?: ControllerOptions<TSpec, TStatus>["onWatchError"];
  private readonly queue: ReconcileQueue;
  private readonly controllerSources: ControllerSources<TSpec, TStatus>;
  private readonly retry?: ReconcileRetry;
  private closed = false;

  constructor(options: ControllerOptions<TSpec, TStatus>) {
    validateResourceType(options.resourceType);
    validateWatches(options.watches);
    this.store = options.store;
    this.resourceType = Object.freeze({ ...options.resourceType });
    this.watches = Object.freeze([...(options.watches ?? [])]);
    this.reconcileResource = options.reconcile;
    this.present = options.present;
    this.now = options.now ?? (() => new Date());
    validateSources(options.sources, this.now());
    this.snapshot =
      options.snapshot ?? (() => emptyReconcileSnapshot(options.store.batonSessionId));
    this.executeWithCapacity =
      options.executeWithCapacity ?? (async (execute) => await execute());
    this.invokeVerb = options.invokeVerb ?? (async () => {
      throw new Error("plugin Controller has no reconcile capability host");
    });
    this.executeReconcile = options.executeReconcile ??
      (async (_scope, _localLease, execute) => await execute());
    this.onWatchError = options.onWatchError;
    this.scope = Object.freeze({
      batonSessionId: options.store.batonSessionId,
      pluginInstanceId: options.store.pluginInstanceId,
      resourceApiVersion: options.resourceType.apiVersion,
      resourceKind: options.resourceType.kind,
    });
    if (options.retry) {
      this.retry = new ReconcileRetry({
        ...options.retry,
        persist: (key, nextRetryAt) => this.setNextReconcileAt(key, nextRetryAt),
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
          const execution = await this.reconcile(key, executionScope);
          if (execution.deletedResource) {
            options.onResourceDeleted?.(execution.deletedResource);
          }
          options.onReconcileSuccess?.(key, execution.nextReconcileAt);
          if (this.retry) this.retry.succeeded(key, execution.nextReconcileAt);
        });
      },
      maxConcurrency: options.maxConcurrency,
      onError: (key, error) => {
        if (this.retry) this.retry.failed(key, error);
        else options.onReconcileError?.(key, error);
      },
    });
    this.controllerSources = new ControllerSources({
      sources: options.sources,
      store: this.store,
      resourceType: this.resourceType,
      executeWithCapacity: this.executeWithCapacity,
      onResource: options.onSourceResource,
      enqueue: (resourceId) => {
        void this.enqueue({
          ...this.scope,
          resourceId,
        }).catch(() => {
          // The Controller retry path has already persisted and reported the failure.
        });
      },
    });
    this.sources = this.controllerSources.all;
  }

  enqueue(key: ReconcileKey): Promise<void> {
    let reconcileKey: ReconcileKey;
    try {
      reconcileKey = ownedKey(key);
      this.assertOwns(reconcileKey);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.queue.enqueue(reconcileKey);
  }

  async startSources(
    onError: (sourceId: string, error: unknown) => void,
  ): Promise<void> {
    await this.controllerSources.start(onError);
  }

  cronSources(): readonly CronSource[] {
    return this.controllerSources.cron();
  }

  async reconcileKeys(
    change: ResourceClientChange,
  ): Promise<readonly ReconcileKey[]> {
    if (change.resource.metadata.namespace !== this.scope.pluginInstanceId) {
      return [];
    }
    const keys = new Map<string, ReconcileKey>();
    if (
      change.kind !== "deleted" &&
      change.resource.apiVersion === this.resourceType.apiVersion &&
      change.resource.kind === this.resourceType.kind
    ) {
      const key = ownedKey({
        ...this.scope,
        resourceId: change.resource.metadata.name,
      });
      keys.set(reconcileKeyId(key), key);
    }
    let requests;
    try {
      requests = await watchRequests(this.watches, change);
    } catch (error) {
      // A broken secondary mapping must not suppress the primary Resource wake-up.
      this.onWatchError?.(change, error);
      return Object.freeze([...keys.values()]);
    }
    for (const request of requests) {
      const key = ownedKey({
        ...this.scope,
        resourceId: request.name,
      });
      keys.set(reconcileKeyId(key), key);
    }
    return Object.freeze([...keys.values()]);
  }

  close(): void {
    this.closed = true;
    this.retry?.close();
    this.controllerSources.close();
    this.queue.close();
  }

  scheduledReconciles(): ScheduledReconcile[] {
    return this.store.scheduledReconciles(this.resourceType).map((entry) =>
      Object.freeze({
        key: ownedKey({
          ...this.scope,
          resourceId: entry.resource.metadata.name,
        }),
        nextReconcileAt: entry.nextReconcileAt,
      })
    );
  }

  /** Exact incarnation guard for Event-driven wakeups such as HarnessInvocation results. */
  ownsResource(resource: ResourceRef): boolean {
    if (
      resource.apiVersion !== this.resourceType.apiVersion ||
      resource.kind !== this.resourceType.kind ||
      resource.namespace !== this.scope.pluginInstanceId
    ) {
      return false;
    }
    try {
      return this.store.get(this.resourceType, resource.name).metadata.uid ===
        resource.uid;
    } catch {
      return false;
    }
  }

  resourceKeys(): ReconcileKey[] {
    return this.store.list(this.resourceType).map((resource) =>
      ownedKey({
        ...this.scope,
        resourceId: resource.metadata.name,
      }),
    );
  }

  initialReconciles(): ReconcileKey[] {
    return this.resourceKeys();
  }

  setNextReconcileAt(key: ReconcileKey, next: Date): void {
    const reconcileKey = ownedKey(key);
    this.assertOwns(reconcileKey);
    this.store.setNextReconcileAt(
      this.resourceType,
      reconcileKey.resourceId,
      next,
    );
  }

  private async reconcile(
    key: ReconcileKey,
    executionScope: ExecutionScope,
  ): Promise<ReconcileExecution> {
    return await this.store.withReconcileLock(
      this.resourceType,
      key.resourceId,
      async () => {
        const resource = deepFreeze(
          this.store.get<TSpec, TStatus>(this.resourceType, key.resourceId),
        );
        const resourceRef = Object.freeze({
          apiVersion: resource.apiVersion,
          kind: resource.kind,
          namespace: resource.metadata.namespace,
          name: resource.metadata.name,
          uid: resource.metadata.uid,
        });
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
        const latest = this.store.get<TSpec, TStatus>(
          this.resourceType,
          key.resourceId,
        );
        if (latest.metadata.generation !== resource.metadata.generation) {
          throw new Error(
            `plugin resource generation changed during reconcile: expected ${resource.metadata.generation}, current ${latest.metadata.generation}`,
          );
        }
        if (resource.metadata.deletionTimestamp !== undefined) {
          const deletedResource = this.store.finalizeDeletion(
            this.resourceType,
            key.resourceId,
          );
          // Invocation/result events may have marked this key dirty while the
          // terminating reconcile was running. The Resource no longer exists,
          // so that follow-up must not be admitted after finalization.
          this.queue.forgetPending(key);
          return {
            nextReconcileAt: null,
            deletedResource: deepFreeze(deletedResource),
          };
        }
        const nextReconcileAt =
          result.requeueAfterMs === undefined
            ? null
            : new Date(now.getTime() + result.requeueAfterMs);
        this.store.setNextReconcileAt<TSpec, TStatus>(
          this.resourceType,
          key.resourceId,
          nextReconcileAt,
          { expectedResourceVersion: latest.metadata.resourceVersion },
        );

        return {
          nextReconcileAt,
        };
      },
    );
  }

  private assertOwns(key: ReconcileKey): void {
    if (
      key.batonSessionId !== this.scope.batonSessionId ||
      key.pluginInstanceId !== this.scope.pluginInstanceId ||
      key.resourceApiVersion !== this.scope.resourceApiVersion ||
      key.resourceKind !== this.scope.resourceKind ||
      reconcileResourceOwner(key) !== reconcileResourceOwner(this.scope)
    ) {
      throw new Error(
        `reconcile key is outside controller scope: ${key.batonSessionId}/${key.pluginInstanceId}/${key.resourceApiVersion}/${key.resourceKind}/${key.resourceId}`,
      );
    }
  }
}
