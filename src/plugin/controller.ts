import type {
  Controller as PluginController,
  ControllerSource,
  CronSource,
  Output as PluginInteractionOutput,
  ResourceRef,
  ResourceType,
} from "@qiankun01/baton-plugin";

import type { PluginResource } from "./resource.ts";
import {
  PluginResourceStore,
  validateResourceType,
} from "./resource.ts";
import { ReconcileQueue } from "./queue.ts";
import { reconcileResourceOwner } from "./reconcile-scope.ts";
import {
  emptyBatonSnapshot,
  type BatonSnapshot,
} from "./baton-snapshot.ts";
import {
  type PluginOutput,
  validatePluginOutput,
} from "./output.ts";
import { ControllerSources } from "./source.ts";

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
  /** 交给 Baton 校验、持久化并进入对应宿主生命周期。 */
  output?: PluginOutput;
  /** 一次性动态唤醒间隔；Controller 负责换算并持久化 nextReconcileAt。 */
  requeueAfterMs?: number;
}

export interface PluginResourceReconcileProposal {
  readonly key: ReconcileKey;
  readonly basedOnGeneration: number;
  /**
   * Controller 产出建议时看到的最新 Resource revision。
   * 同一 spec generation 下的不同外部 observation 必须能形成不同 Proposal。
   */
  readonly basedOnResourceVersion?: string;
  readonly basedOnRevision?: never;
  readonly text: string;
}

export interface BuiltinResourceReconcileProposal {
  readonly key: ReconcileKey;
  readonly basedOnGeneration?: never;
  readonly basedOnResourceVersion?: never;
  readonly basedOnRevision: number;
  readonly text: string;
}

export type ReconcileProposal =
  | PluginResourceReconcileProposal
  | BuiltinResourceReconcileProposal;

export interface PluginResourceReconcileInteraction {
  readonly key: ReconcileKey;
  readonly resource: ResourceRef;
  readonly basedOnGeneration: number;
  readonly basedOnResourceVersion?: string;
  readonly basedOnRevision?: never;
  readonly request: PluginInteractionOutput;
}

export interface BuiltinResourceReconcileInteraction {
  readonly key: ReconcileKey;
  readonly resource: ResourceRef;
  readonly basedOnGeneration?: never;
  readonly basedOnResourceVersion?: never;
  readonly basedOnRevision: number;
  readonly request: PluginInteractionOutput;
}

export type ReconcileInteraction =
  | PluginResourceReconcileInteraction
  | BuiltinResourceReconcileInteraction;

export interface ScheduledReconcile {
  readonly key: ReconcileKey;
  readonly nextReconcileAt: Date;
}

export interface ControllerOptions<TSpec, TStatus> {
  store: PluginResourceStore;
  resourceType: ResourceType;
  sources?: readonly ControllerSource<TSpec>[];
  reconcile: PluginController<TSpec, TStatus>["reconcile"];
  present?: PluginController<TSpec, TStatus>["present"];
  maxConcurrency?: number;
  now?: () => Date;
  /** 每次执行前读取最新 BatonSession 只读视图。 */
  snapshot?: (key: ReconcileKey) => BatonSnapshot;
  /** Manager 注入的进程总容量；缺省表示不额外限流。 */
  executeWithCapacity?: <T>(execute: () => Promise<T>) => Promise<T>;
  onProposal(proposal: ReconcileProposal): Promise<void> | void;
  onInteraction?(interaction: ReconcileInteraction): Promise<void> | void;
  /** 仅供 Manager 收口成功后的动态唤醒；持久化由 Controller 先完成。 */
  onReconcileSuccess?(key: ReconcileKey, nextReconcileAt: Date | null): void;
  /** 仅报告实际执行失败，不包含 enqueue 参数校验错误。 */
  onReconcileError?(key: ReconcileKey, error: unknown): void;
  /** Source materialize Resource 后失效 Board 等派生投影。 */
  onSourceResource?(resource: Readonly<PluginResource<TSpec, TStatus>>): void;
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
  if (result.output !== undefined) {
    validatePluginOutput(result.output);
  }
  if (
    result.requeueAfterMs !== undefined &&
    (!Number.isSafeInteger(result.requeueAfterMs) || result.requeueAfterMs < 1)
  ) {
    throw new Error("reconcile requeueAfterMs must be a positive integer");
  }
  return result;
}

interface ReconcileExecution {
  proposal?: ReconcileProposal;
  interaction?: ReconcileInteraction;
  nextReconcileAt: Date | null;
}

/**
 * 单个 Plugin Resource Kind 的控制器：拥有 reconcile、独立队列、局部并发和执行边界。
 * Manager 只负责注册、路由和所有 Controller 共享的总容量。
 */
export class Controller<TSpec, TStatus> {
  readonly scope: ReconcileScope;
  readonly sources: readonly ControllerSource<TSpec>[];
  readonly present?: PluginController<TSpec, TStatus>["present"];
  private readonly store: PluginResourceStore;
  private readonly resourceType: ResourceType;
  private readonly reconcileResource: PluginController<TSpec, TStatus>["reconcile"];
  private readonly now: () => Date;
  private readonly snapshot: (key: ReconcileKey) => BatonSnapshot;
  private readonly executeWithCapacity: NonNullable<
    ControllerOptions<TSpec, TStatus>["executeWithCapacity"]
  >;
  private readonly onProposal: ControllerOptions<TSpec, TStatus>["onProposal"];
  private readonly onInteraction: NonNullable<
    ControllerOptions<TSpec, TStatus>["onInteraction"]
  >;
  private readonly queue: ReconcileQueue;
  private readonly controllerSources: ControllerSources<TSpec, TStatus>;
  private closed = false;

  constructor(options: ControllerOptions<TSpec, TStatus>) {
    validateResourceType(options.resourceType);
    this.store = options.store;
    this.resourceType = Object.freeze({ ...options.resourceType });
    this.reconcileResource = options.reconcile;
    this.present = options.present;
    this.now = options.now ?? (() => new Date());
    this.snapshot =
      options.snapshot ?? (() => emptyBatonSnapshot(options.store.batonSessionId));
    this.executeWithCapacity =
      options.executeWithCapacity ?? (async (execute) => await execute());
    this.onProposal = options.onProposal;
    this.onInteraction =
      options.onInteraction ??
      (() => {
        throw new Error("plugin Controller has no Interaction publisher");
      });
    this.scope = Object.freeze({
      batonSessionId: options.store.batonSessionId,
      pluginInstanceId: options.store.pluginInstanceId,
      resourceApiVersion: options.resourceType.apiVersion,
      resourceKind: options.resourceType.kind,
    });
    this.queue = new ReconcileQueue({
      execute: (key) =>
        this.executeWithCapacity(async () => {
          if (this.closed) throw new Error("plugin Controller is closed");
          const execution = await this.reconcile(key);
          if (execution.proposal) await this.onProposal(execution.proposal);
          if (execution.interaction) {
            await this.onInteraction(execution.interaction);
          }
          options.onReconcileSuccess?.(key, execution.nextReconcileAt);
        }),
      maxConcurrency: options.maxConcurrency,
      onError: options.onReconcileError,
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
          // Reconcile failure reporting and retry are owned by Manager.
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

  close(): void {
    this.closed = true;
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

  private async reconcile(key: ReconcileKey): Promise<ReconcileExecution> {
    return await this.store.withReconcileLock(
      this.resourceType,
      key.resourceId,
      async () => {
        const resource = deepFreeze(
          this.store.get<TSpec, TStatus>(this.resourceType, key.resourceId),
        );
        const baton = deepFreeze(this.snapshot(key));
        if (baton.session.batonSessionId !== this.scope.batonSessionId) {
          throw new Error(
            `BatonSnapshot batonSessionId must be ${this.scope.batonSessionId}, got ${baton.session.batonSessionId}`,
          );
        }
        const result = validatedResult(
          await this.reconcileResource(baton, resource),
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

        const output = result.output;
        return {
          nextReconcileAt,
          ...(output?.kind === "proposed-input"
            ? {
                proposal: Object.freeze({
                  key,
                  basedOnGeneration: resource.metadata.generation,
                  basedOnResourceVersion: latest.metadata.resourceVersion,
                  text: output.text,
                }),
              }
            : {}),
          ...(output?.kind === "interaction"
            ? {
                interaction: Object.freeze({
                  key,
                  resource: Object.freeze({
                    apiVersion: resource.apiVersion,
                    kind: resource.kind,
                    namespace: resource.metadata.namespace,
                    name: resource.metadata.name,
                    uid: resource.metadata.uid,
                  }),
                  basedOnGeneration: resource.metadata.generation,
                  basedOnResourceVersion: latest.metadata.resourceVersion,
                  request: output,
                }),
              }
            : {}),
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
