import {
  Controller,
  type ReconcileKey,
  type ReconcileInteraction,
  type ReconcileProposal,
  type ReconcileScope,
  type ScheduledReconcile,
} from "./controller.ts";
import {
  BATON_TURN_RESOURCE_KIND,
  BuiltinController,
  type BuiltinResource,
  type BuiltinControllerOptions,
  type BuiltinResourceKind,
  BatonResourceIndex,
} from "./builtin.ts";
import {
  type Proposal,
  type ProposalOutcome,
  ProposalStore,
} from "./proposal.ts";
import {
  type CreatePluginInstance,
  type PluginInstance,
  type PluginInstanceRepository,
  PluginInstanceStore,
} from "./instance.ts";
import {
  PluginBinding,
  type Controller as PluginResourceController,
  type ControllerSource,
  type PluginCommandInput,
  type PluginCommandResult,
  type PluginPackage,
  type Resource,
  pluginPackageKey,
  type ToastMessage,
  type ToastTone,
  validatePluginPackage,
} from "./package.ts";
import {
  reconcileKeyId,
  ReconcileCapacity,
  ReconcileDueQueue,
} from "./queue.ts";
import {
  CronSourceQueue,
  validateControllerSources,
} from "./cron-source.ts";
import { PluginResourceStore } from "./resource.ts";
import { createResourceClient } from "./resource-client.ts";
import {
  type BoardItem,
  presentBoardSource,
} from "./board.ts";
import type { SessionHandle } from "../store/store.ts";
import type { InteractionResolution } from "../interaction/types.ts";
import { Store as InteractionStore } from "./interaction.ts";
import {
  emptyBatonSnapshot,
  type BatonSnapshot,
} from "./baton-snapshot.ts";
import {
  reconcileResourceOwner,
  reconcileScopeId,
  reconcileScopeLabel,
  sameReconcileScope,
} from "./reconcile-scope.ts";
import {
  type AvailablePluginCommand,
  PluginCommandRegistry,
} from "./command/registry.ts";

const TOAST_TONES = new Set<ToastTone>([
  "info",
  "success",
  "warning",
  "error",
]);

export interface ControllerRegistration {
  close(): void;
}

export interface ControllerDefinition<TSpec, TStatus>
  extends PluginResourceController<TSpec, TStatus> {
  store: PluginResourceStore;
  now?: () => Date;
}

type BuiltinControllerDefinition<K extends BuiltinResourceKind> = Pick<
  BuiltinControllerOptions<K>,
  "pluginInstanceId" | "resourceKind" | "sources" | "reconcile" | "maxConcurrency" | "now"
>;

export interface PluginToast {
  readonly pluginInstanceId: string;
  readonly message: ToastMessage;
}

export interface ManagerOptions {
  /** 所有 Controller 合计可占用的执行容量；默认 1。 */
  maxTotalConcurrency?: number;
  proposals: ProposalStore;
  /**
   * 启用 Baton-owned Resource 时传完整 SessionHandle。只持有 ProposalStore 的调用方
   * 仍可使用 Plugin Resource Controller，但不能观察 Baton-owned Resource。
   */
  session?: Pick<
    SessionHandle,
    "id" | "dir" | "readEvents" | "subscribe" | "append"
  >;
  /** 缺省与 ProposalStore 使用同一个 BatonSession。 */
  instances?: PluginInstanceRepository;
  /** 当前进程可激活的可信、不可变 Package 版本。 */
  packages?: readonly PluginPackage[];
  /** reconcile 调用前读取并冻结的当前 BatonSession 视图。 */
  snapshot?: () => BatonSnapshot;
  /** 按需加载已安装 Package；fresh 用于开发期 `/reload-plugins` 绕过模块缓存。 */
  loadPackage?(
    pluginId: string,
    version: string,
    options?: { fresh?: boolean; marketplace?: string },
  ): Promise<PluginPackage>;
  /** Proposal 已落盘；接收方按 proposalId 幂等投影即可。 */
  onProposal(proposal: Proposal): Promise<void> | void;
  /** Board 展示内容变化；宿主据此重建展示快照。 */
  onBoardChanged?(): void;
  /** Plugin 发出的 session-scoped 瞬时提示；不进入 Event Ledger。 */
  onToast?(toast: PluginToast): void;
  /** Plugin command 注册或 Binding 生命周期变化；宿主据此刷新命令补全。 */
  onCommandsChanged?(): void;
  /** Baton core 已占用的 slash command 名称，Plugin 不得覆盖。 */
  reservedCommandNames?: readonly string[];
  /** Controller reconcile 失败后的指数退避；默认从 1 秒增长到最多 1 分钟。 */
  retryBackoff?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  now?: () => Date;
  /** 单个 Instance 激活失败不阻断其他 Plugin；宿主可将失败展示到 UI 或诊断日志。 */
  onActivationError?(failure: PluginActivationFailure): void;
  /** 自动重试已安排；宿主可将错误展示到 UI 或诊断日志。 */
  onReconcileError?(failure: ReconcileFailure): void;
  /** Controller Source 发现失败；本次 tick 跳过，下一次 cron 继续重试。 */
  onControllerSourceError?(failure: ControllerSourceFailure): void;
}

export interface PluginActivationFailure {
  readonly pluginInstanceId: string;
  readonly error: unknown;
}

export interface ReconcileFailure {
  readonly key: ReconcileKey;
  readonly error: unknown;
  readonly attempt: number;
  readonly nextRetryAt?: string;
}

export interface ControllerSourceFailure {
  readonly scope: ReconcileScope;
  readonly sourceId: string;
  readonly error: unknown;
}

export interface PluginReloadResult {
  readonly activated: readonly string[];
  readonly failures: readonly PluginActivationFailure[];
}

interface ManagedController {
  scope: ReconcileScope;
  readonly sources?: readonly ControllerSource[];
  discover?(source: ControllerSource): Promise<void>;
  enqueue(key: ReconcileKey): Promise<void>;
  close(): void;
  scheduledReconciles(): ScheduledReconcile[];
  resourceKeys?(): ReconcileKey[];
  initialReconciles?(): ReconcileKey[];
  /** PluginResource 持久化 due time；Builtin Resource 靠 ledger replay 在重启后重新唤醒。 */
  setNextReconcileAt?(key: ReconcileKey, next: Date): void;
}

interface RetryState {
  key: ReconcileKey;
  attempt: number;
}

interface ManagedBoardSource {
  readonly pluginInstanceId: string;
  present(): readonly BoardItem[];
}

function positiveDelay(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

/**
 * Plugin 域统一入口：注册和路由 Controller，并限制所有 Plugin 的进程总并发。
 */
export class Manager {
  /** Baton claims its Resource kinds before any Plugin Binding can register. */
  private readonly resourceKindOwners = new Map<string, {
    readonly owner: "baton" | string;
    controllers: number;
    claimedByResource: boolean;
  }>([
    [
      BATON_TURN_RESOURCE_KIND,
      { owner: "baton", controllers: 0, claimedByResource: true },
    ],
  ]);
  private readonly controllers = new Map<string, ManagedController>();
  private readonly boardSources = new Map<string, ManagedBoardSource>();
  private readonly commandRegistry: PluginCommandRegistry;
  private readonly instances: PluginInstanceRepository;
  private readonly packages = new Map<string, PluginPackage>();
  private readonly packageLoads = new Map<string, Promise<PluginPackage>>();
  private readonly loadPackage: ManagerOptions["loadPackage"];
  private readonly snapshot: () => BatonSnapshot;
  private readonly interactions?: InteractionStore;
  private readonly bindings = new Map<string, PluginBinding>();
  private readonly activations = new Map<string, Promise<void>>();
  private readonly capacity: ReconcileCapacity;
  private readonly proposals: ProposalStore;
  private readonly batonResources?: BatonResourceIndex;
  private readonly unsubscribeBatonResources?: () => void;
  private readonly onProposal: ManagerOptions["onProposal"];
  private readonly onBoardChanged: ManagerOptions["onBoardChanged"];
  private readonly onToast: ManagerOptions["onToast"];
  private readonly onCommandsChanged: ManagerOptions["onCommandsChanged"];
  private readonly onActivationError: ManagerOptions["onActivationError"];
  private readonly onReconcileError: ManagerOptions["onReconcileError"];
  private readonly onControllerSourceError:
    ManagerOptions["onControllerSourceError"];
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retries = new Map<string, RetryState>();
  private readonly activeSourceScopes = new Set<string>();
  /** Binding 激活完成前注册项可回滚，但不能提前消费 Event 或产生 Output。 */
  private readonly suspendedControllers = new Set<string>();
  private readonly now: () => Date;
  private readonly dueQueue: ReconcileDueQueue;
  private readonly cronSourceQueue: CronSourceQueue;
  private started = false;
  private starting?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;

  constructor(options: ManagerOptions) {
    this.capacity = new ReconcileCapacity(options.maxTotalConcurrency ?? 1);
    this.proposals = options.proposals;
    this.now = options.now ?? (() => new Date());
    this.instances =
      options.instances ??
      new PluginInstanceStore({
        session: options.proposals.session,
        now: this.now,
      });
    if (
      this.instances.session.id !== options.proposals.session.id ||
      this.instances.session.dir !== options.proposals.session.dir
    ) {
      throw new Error("plugin InstanceStore and ProposalStore must own the same BatonSession");
    }
    if (
      options.session &&
      (options.session.id !== options.proposals.session.id ||
        options.session.dir !== options.proposals.session.dir)
    ) {
      throw new Error("plugin Manager session and ProposalStore must own the same BatonSession");
    }
    for (const plugin of options.packages ?? []) {
      validatePluginPackage(plugin);
      const key = pluginPackageKey(plugin.pluginId, plugin.version);
      if (this.packages.has(key)) {
        throw new Error(`plugin Package already registered: ${plugin.pluginId}@${plugin.version}`);
      }
      this.packages.set(key, plugin);
    }
    this.loadPackage = options.loadPackage;
    this.snapshot =
      options.snapshot ??
      (() => emptyBatonSnapshot(options.proposals.batonSessionId));
    if (options.session) {
      this.interactions = new InteractionStore(options.session);
    }
    this.onProposal = options.onProposal;
    this.onBoardChanged = options.onBoardChanged;
    this.onToast = options.onToast;
    this.onCommandsChanged = options.onCommandsChanged;
    this.commandRegistry = new PluginCommandRegistry({
      reservedNames: options.reservedCommandNames,
      isInstanceActive: (pluginInstanceId) =>
        this.bindings.has(pluginInstanceId),
      onChanged: () => this.notifyCommandsChanged(),
    });
    this.onActivationError = options.onActivationError;
    this.onReconcileError = options.onReconcileError;
    this.onControllerSourceError = options.onControllerSourceError;
    this.retryInitialDelayMs = options.retryBackoff?.initialDelayMs ?? 1_000;
    this.retryMaxDelayMs = options.retryBackoff?.maxDelayMs ?? 60_000;
    positiveDelay("retryBackoff.initialDelayMs", this.retryInitialDelayMs);
    positiveDelay("retryBackoff.maxDelayMs", this.retryMaxDelayMs);
    if (this.retryMaxDelayMs < this.retryInitialDelayMs) {
      throw new Error("retryBackoff.maxDelayMs must be at least initialDelayMs");
    }
    this.dueQueue = new ReconcileDueQueue({
      now: this.now,
      onDue: (key) => {
        void this.enqueue(key).catch(() => {
          // The Controller error callback has already persisted and scheduled the retry.
        });
      },
    });
    this.cronSourceQueue = new CronSourceQueue({
      now: this.now,
      onDue: (scope, sources) =>
        this.enqueueCronSourceResources(scope, sources),
    });
    if (options.session) {
      this.batonResources = new BatonResourceIndex({
        session: options.session,
      });
      this.unsubscribeBatonResources = this.batonResources.subscribe((resource) => {
        this.enqueueBuiltinResource(resource);
      });
    }
  }

  registerController<TSpec, TStatus>(
    definition: ControllerDefinition<TSpec, TStatus>,
  ): ControllerRegistration {
    return this.registerControllerInternal(definition, false);
  }

  private registerControllerInternal<TSpec, TStatus>(
    definition: ControllerDefinition<TSpec, TStatus>,
    suspended: boolean,
  ): ControllerRegistration {
    if (this.closed) throw new Error("plugin Manager is closed");
    if (definition.store.batonSessionId !== this.proposals.batonSessionId) {
      throw new Error(
        `plugin Controller batonSessionId must be ${this.proposals.batonSessionId}, got ${definition.store.batonSessionId}`,
      );
    }
    validateControllerSources(definition.sources, this.now());
    const controller = new Controller({
      ...definition,
      snapshot: (key) => this.snapshotFor(key),
      executeWithCapacity: (execute) => this.capacity.run(execute),
      onProposal: (proposal) => this.publishProposal(proposal),
      onInteraction: (interaction) => this.publishInteraction(interaction),
      onReconcileSuccess: (key, next) => {
        if (this.controllers.get(reconcileScopeId(key)) !== controller) return;
        this.retries.delete(reconcileKeyId(key));
        if (this.started) this.dueQueue.schedule(key, next);
      },
      onReconcileError: (key, error) => {
        this.retry(controller, key, error);
      },
    });
    return this.installController(controller, suspended);
  }

  private registerBuiltinController<K extends BuiltinResourceKind>(
    definition: BuiltinControllerDefinition<K>,
  ): ControllerRegistration {
    return this.registerBuiltinControllerInternal(definition, false);
  }

  private registerBuiltinControllerInternal<K extends BuiltinResourceKind>(
    definition: BuiltinControllerDefinition<K>,
    suspended: boolean,
  ): ControllerRegistration {
    if (this.closed) throw new Error("plugin Manager is closed");
    if (!this.batonResources) {
      throw new Error(
        "plugin Manager requires a SessionHandle to watch Baton-owned Resources",
      );
    }
    validateControllerSources(definition.sources, this.now());
    const controller = new BuiltinController({
      ...definition,
      resources: this.batonResources,
      snapshot: (key) => this.snapshotFor(key),
      executeWithCapacity: (execute) => this.capacity.run(execute),
      onProposal: (proposal) => this.publishProposal(proposal),
      onInteraction: (interaction) => this.publishInteraction(interaction),
      onReconcileSuccess: (key, next) => {
        if (this.controllers.get(reconcileScopeId(key)) !== controller) return;
        this.retries.delete(reconcileKeyId(key));
        if (this.started) this.dueQueue.schedule(key, next);
      },
      onReconcileError: (key, error) => {
        this.retry(controller, key, error);
      },
    });
    return this.installController(controller, suspended);
  }

  enqueue(key: ReconcileKey): Promise<void> {
    if (this.closed) return Promise.reject(new Error("plugin Manager is closed"));
    const controller = this.controllers.get(reconcileScopeId(key));
    if (!controller) {
      return Promise.reject(
        new Error(`no plugin Controller registered for ${reconcileScopeLabel(key)}`),
      );
    }
    if (this.suspendedControllers.has(reconcileScopeId(key))) {
      return Promise.reject(new Error("plugin Controller is not active"));
    }
    return controller.enqueue(key);
  }

  /**
   * 恢复进程退出前尚未处理的 Proposal 和 Resource due time。
   * Proposal 投影失败时允许重试，接收方依靠 proposalId 去重。
   */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("plugin Manager is closed"));
    if (this.started) return Promise.resolve();
    if (this.starting) return this.starting;
    const starting = this.startManager();
    this.starting = starting;
    void starting.then(
      () => {
        if (this.starting === starting) this.starting = undefined;
      },
      () => {
        if (this.starting === starting) this.starting = undefined;
      },
    );
    return starting;
  }

  /**
   * 将一份已启用 Instance 原子绑定到对应 Package。失败时撤销本次已产生的全部注册。
   */
  async activateInstance(pluginInstanceId: string): Promise<void> {
    if (this.closed) throw new Error("plugin Manager is closed");
    if (this.bindings.has(pluginInstanceId)) return;
    const existing = this.activations.get(pluginInstanceId);
    if (existing) return await existing;

    const instance = this.instances.get(pluginInstanceId);
    if (!instance.enabled) {
      throw new Error(`plugin Instance is disabled: ${pluginInstanceId}`);
    }
    const plugin = await this.resolvePackage(
      instance.pluginId,
      instance.packageVersion,
      instance.marketplace,
    );
    const batonSession = this.snapshot().session;
    if (batonSession.batonSessionId !== this.proposals.batonSessionId) {
      throw new Error(
        `PluginActivationContext batonSessionId must be ${this.proposals.batonSessionId}, got ${batonSession.batonSessionId}`,
      );
    }

    const binding = new PluginBinding(
      instance,
      {
        batonSessionId: batonSession.batonSessionId,
        ...(batonSession.cwd === undefined ? {} : { cwd: batonSession.cwd }),
      },
      {
        registerCommand: (command) =>
          this.commandRegistry.register(instance, command),
        registerController: (controller) =>
          this.bindController(instance, controller),
        showToast: (message) =>
          this.notifyToast(instance.pluginInstanceId, message),
      },
      createResourceClient(
        new PluginResourceStore({
          session: this.instances.session,
          pluginInstanceId: instance.pluginInstanceId,
        }),
        () => this.notifyBoardChanged(),
        (resourceKind) =>
          this.claimResourceKindForCreate(instance.pluginId, resourceKind),
      ),
    );
    let activation!: Promise<void>;
    activation = Promise.resolve()
      .then(async () => {
        try {
          await plugin.activate(binding);
          binding.completeActivation();
          if (this.closed) throw new Error("plugin Manager is closed");
          this.bindings.set(pluginInstanceId, binding);
          this.notifyCommandsChanged();
          this.resumeControllers(pluginInstanceId);
          this.notifyBoardChanged();
        } catch (error) {
          try {
            await binding.close();
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              `could not activate plugin Instance ${pluginInstanceId}`,
            );
          }
          throw error;
        }
      })
      .finally(() => {
        if (this.activations.get(pluginInstanceId) === activation) {
          this.activations.delete(pluginInstanceId);
        }
      });
    this.activations.set(pluginInstanceId, activation);
    await activation;
  }

  async deactivateInstance(pluginInstanceId: string): Promise<void> {
    const activation = this.activations.get(pluginInstanceId);
    if (activation) await activation;
    const binding = this.bindings.get(pluginInstanceId);
    if (!binding) return;
    this.bindings.delete(pluginInstanceId);
    try {
      await binding.close();
    } finally {
      this.notifyBoardChanged();
    }
  }

  isInstanceActive(pluginInstanceId: string): boolean {
    return this.bindings.has(pluginInstanceId);
  }

  listInstances(): PluginInstance[] {
    return this.instances.list();
  }

  /**
   * Instance 先以 disabled 落盘，再显式启用；激活失败时仍保留一份可诊断、可重试的配置。
   */
  async createInstance(input: CreatePluginInstance): Promise<PluginInstance> {
    if (this.closed) throw new Error("plugin Manager is closed");
    await this.start();
    const shouldEnable = input.enabled ?? true;
    const instance = this.instances.create({ ...input, enabled: false });
    if (!shouldEnable) return instance;
    return await this.setInstanceEnabled(instance.pluginInstanceId, true);
  }

  async setInstanceEnabled(
    pluginInstanceId: string,
    enabled: boolean,
  ): Promise<PluginInstance> {
    if (this.closed) throw new Error("plugin Manager is closed");
    await this.start();
    const current = this.instances.get(pluginInstanceId);
    if (!enabled) {
      const disabled = this.instances.setEnabled(pluginInstanceId, false);
      await this.deactivateInstance(pluginInstanceId);
      return disabled;
    }
    if (current.enabled && this.isInstanceActive(pluginInstanceId)) return current;
    const next = current.enabled
      ? current
      : this.instances.setEnabled(pluginInstanceId, true);
    try {
      await this.activateInstance(pluginInstanceId);
      return next;
    } catch (error) {
      if (!current.enabled) this.instances.setEnabled(pluginInstanceId, false);
      throw error;
    }
  }

  /**
   * 显式升级一份 Instance 的 Package 引用，并保留其稳定身份、配置和启用状态。
   * 新版本激活失败时恢复旧引用与旧 Binding，避免一次更新留下半迁移状态。
   */
  async setInstancePackageVersion(
    pluginInstanceId: string,
    packageVersion: string,
  ): Promise<PluginInstance> {
    if (this.closed) throw new Error("plugin Manager is closed");
    await this.start();
    const current = this.instances.get(pluginInstanceId);
    if (current.packageVersion === packageVersion) return current;

    await this.resolvePackage(current.pluginId, packageVersion, current.marketplace);
    const wasActive = this.isInstanceActive(pluginInstanceId);
    if (wasActive) await this.deactivateInstance(pluginInstanceId);
    const updated = this.instances.setPackageVersion(pluginInstanceId, packageVersion);
    if (!current.enabled) return updated;

    try {
      await this.activateInstance(pluginInstanceId);
      return updated;
    } catch (error) {
      this.instances.setPackageVersion(pluginInstanceId, current.packageVersion);
      if (!wasActive) throw error;
      try {
        await this.activateInstance(pluginInstanceId);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `could not update plugin Instance ${pluginInstanceId} or restore ${current.packageVersion}`,
        );
      }
      throw error;
    }
  }

  async removeInstance(pluginInstanceId: string): Promise<void> {
    if (this.closed) throw new Error("plugin Manager is closed");
    await this.start();
    await this.deactivateInstance(pluginInstanceId);
    this.instances.delete(pluginInstanceId);
  }

  /**
   * 重载当前 BatonSession 的全部 enabled Instance。Package 每个版本只 fresh load 一次；
   * 单个 Package 或 Instance 失败不阻断其它插件，也不改变用户的 enabled 配置。
   */
  async reload(): Promise<PluginReloadResult> {
    if (this.closed) throw new Error("plugin Manager is closed");
    await this.start();
    const failures = new Map<string, PluginActivationFailure>();
    for (const pluginInstanceId of [...this.bindings.keys()].reverse()) {
      try {
        await this.deactivateInstance(pluginInstanceId);
      } catch (error) {
        failures.set(pluginInstanceId, { pluginInstanceId, error });
      }
    }

    const enabled = this.instances.list().filter((instance) => instance.enabled);
    const packageFailures = new Map<string, unknown>();
    const loadedPackages = new Set<string>();
    for (const instance of enabled) {
      const key = this.runtimePackageKey(instance);
      if (loadedPackages.has(key)) continue;
      loadedPackages.add(key);
      try {
        await this.resolvePackage(
          instance.pluginId,
          instance.packageVersion,
          instance.marketplace,
          true,
        );
      } catch (error) {
        packageFailures.set(key, error);
      }
    }

    const activated: string[] = [];
    for (const instance of enabled) {
      if (failures.has(instance.pluginInstanceId)) continue;
      const error = packageFailures.get(
        this.runtimePackageKey(instance),
      );
      if (error) {
        failures.set(instance.pluginInstanceId, {
          pluginInstanceId: instance.pluginInstanceId,
          error,
        });
        continue;
      }
      try {
        await this.activateInstance(instance.pluginInstanceId);
        activated.push(instance.pluginInstanceId);
      } catch (activationError) {
        failures.set(instance.pluginInstanceId, {
          pluginInstanceId: instance.pluginInstanceId,
          error: activationError,
        });
      }
    }
    const failureList = [...failures.values()];
    for (const failure of failureList) this.reportActivationFailure(failure);
    return Object.freeze({
      activated: Object.freeze(activated),
      failures: Object.freeze(failureList.map((failure) => Object.freeze(failure))),
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const closing = this.closeManager();
    this.closing = closing;
    return closing;
  }

  listPendingProposals(): Proposal[] {
    return this.proposals.listPending();
  }

  listBoardItems(): readonly BoardItem[] {
    const items: BoardItem[] = [];
    for (const source of this.boardSources.values()) {
      if (!this.bindings.has(source.pluginInstanceId)) continue;
      items.push(...source.present());
    }
    return Object.freeze(items);
  }

  listCommands(): readonly AvailablePluginCommand[] {
    return this.commandRegistry.list();
  }

  async executeCommand(
    name: string,
    input: PluginCommandInput,
  ): Promise<PluginCommandResult | undefined> {
    return await this.commandRegistry.execute(name, input);
  }

  resolveProposal(proposalId: string, outcome: ProposalOutcome): Proposal {
    return this.proposals.resolve(proposalId, outcome);
  }

  /**
   * 先持久化用户决议，再唤醒原 Resource。即使当前 Controller 暂不可用，
   * 后续激活或初始 reconcile 仍能从 Snapshot 恢复这份决议。
   */
  async resolveInteraction(
    interactionId: string,
    resolution: InteractionResolution,
  ): Promise<boolean> {
    const key = this.interactions?.resolve(interactionId, resolution);
    if (!key) return false;
    try {
      await this.enqueue(key);
    } catch {
      // Resolution 已落 Event Ledger；重试、reload 或下次启动会重新 reconcile。
    }
    return true;
  }

  getBatonResource<K extends BuiltinResourceKind>(
    kind: K,
    resourceId: string,
  ): BuiltinResource<K> {
    if (!this.batonResources) {
      throw new Error("Baton-owned resources are not available");
    }
    return this.batonResources.get(kind, resourceId);
  }

  private async publishProposal(draft: ReconcileProposal): Promise<void> {
    const proposal = this.proposals.record(draft);
    if (!proposal.resolution) await this.onProposal(proposal);
  }

  private publishInteraction(draft: ReconcileInteraction): void {
    if (!this.interactions) {
      throw new Error(
        "plugin Manager requires a SessionHandle to open Interactions",
      );
    }
    this.interactions.open(draft);
  }

  private snapshotFor(key: ReconcileKey): BatonSnapshot {
    return {
      ...this.snapshot(),
      pluginInteractions: this.interactions?.snapshots(key) ?? [],
    };
  }

  private async restoreProposals(): Promise<void> {
    for (const proposal of this.proposals.listPending()) {
      await this.onProposal(proposal);
    }
  }

  private async startManager(): Promise<void> {
    const enabled = this.instances.list().filter((instance) => instance.enabled);
    const failures = await Promise.all(
      enabled.map(async (instance): Promise<PluginActivationFailure | undefined> => {
        try {
          await this.activateInstance(instance.pluginInstanceId);
          return undefined;
        } catch (error) {
          return { pluginInstanceId: instance.pluginInstanceId, error };
        }
      }),
    );
    for (const failure of failures) {
      if (failure) this.reportActivationFailure(failure);
    }
    await this.restoreProposals();
    const controllers = [...this.controllers.values()];
    const scheduled = controllers.map((controller) => ({
      controller,
      entries: controller.scheduledReconciles(),
    }));
    for (const { controller, entries } of scheduled) {
      if (this.controllers.get(reconcileScopeId(controller.scope)) !== controller) continue;
      for (const entry of entries) {
        this.dueQueue.schedule(entry.key, entry.nextReconcileAt);
      }
    }
    if (this.closed) throw new Error("plugin Manager is closed");
    this.started = true;
    for (const controller of controllers) {
      if (this.controllers.get(reconcileScopeId(controller.scope)) !== controller) continue;
      this.activateControllerSources(controller);
      this.enqueueInitial(controller);
    }
  }

  private async resolvePackage(
    pluginId: string,
    version: string,
    marketplace?: string,
    fresh = false,
  ): Promise<PluginPackage> {
    const key = marketplace
      ? JSON.stringify([pluginId, marketplace, version])
      : pluginPackageKey(pluginId, version);
    if (!fresh) {
      const cached = this.packages.get(key);
      if (cached) return cached;
      const loading = this.packageLoads.get(key);
      if (loading) return await loading;
    }
    if (!this.loadPackage) {
      const cached = this.packages.get(key);
      if (cached) return cached;
      throw new Error(`plugin Package is unavailable: ${pluginId}@${version}`);
    }
    const loading = Promise.resolve()
      .then(() =>
        this.loadPackage!(
          pluginId,
          version,
          {
            ...(fresh ? { fresh: true } : {}),
            ...(marketplace ? { marketplace } : {}),
          },
        ),
      )
      .then((plugin) => {
        validatePluginPackage(plugin);
        if (plugin.pluginId !== pluginId || plugin.version !== version) {
          throw new Error(
            `loaded Package identity ${plugin.pluginId}@${plugin.version} does not match ${pluginId}@${version}`,
          );
        }
        this.packages.set(key, plugin);
        return plugin;
      })
      .finally(() => {
        if (this.packageLoads.get(key) === loading) this.packageLoads.delete(key);
      });
    this.packageLoads.set(key, loading);
    return await loading;
  }

  private runtimePackageKey(instance: PluginInstance): string {
    return instance.marketplace
      ? JSON.stringify([instance.pluginId, instance.marketplace, instance.packageVersion])
      : pluginPackageKey(instance.pluginId, instance.packageVersion);
  }

  private bindController<TSpec, TStatus>(
    instance: PluginInstance,
    pluginController: PluginResourceController<TSpec, TStatus>,
  ): () => void {
    if (pluginController.resourceKind === BATON_TURN_RESOURCE_KIND) {
      return this.bindBatonResourceController(
        instance.pluginInstanceId,
        pluginController,
      );
    }
    const releaseKind = this.claimResourceKind(
      instance.pluginId,
      pluginController.resourceKind,
    );
    try {
      const close = this.bindPluginResourceController(
        instance.pluginInstanceId,
        pluginController,
      );
      return () => {
        try {
          close();
        } finally {
          releaseKind();
        }
      };
    } catch (error) {
      releaseKind();
      throw error;
    }
  }

  private bindPluginResourceController<TSpec, TStatus>(
    pluginInstanceId: string,
    pluginController: PluginResourceController<TSpec, TStatus>,
  ): () => void {
    const store = new PluginResourceStore({
      session: this.instances.session,
      pluginInstanceId,
    });
    const registration = this.registerControllerInternal(
      {
        ...pluginController,
        store,
        now: this.now,
      },
      true,
    );
    const sourceId = reconcileScopeId({
      batonSessionId: this.proposals.batonSessionId,
      pluginInstanceId,
      resourceKind: pluginController.resourceKind,
    });
    if (pluginController.present) {
      const pluginId = this.instances.get(pluginInstanceId).pluginId;
      const present = pluginController.present;
      this.boardSources.set(sourceId, {
        pluginInstanceId,
        present: () =>
          presentBoardSource({
            pluginId,
            pluginInstanceId,
            resourceKind: pluginController.resourceKind,
            list: () =>
              store.list<TSpec, TStatus>(pluginController.resourceKind),
            present,
          }),
      });
    }
    return () => {
      this.boardSources.delete(sourceId);
      registration.close();
    };
  }

  private bindBatonResourceController<TSpec, TStatus>(
    pluginInstanceId: string,
    pluginController: PluginResourceController<TSpec, TStatus>,
  ): () => void {
    if (!this.batonResources) {
      throw new Error(
        `Resource kind ${pluginController.resourceKind} requires a SessionHandle`,
      );
    }
    const resourceKind = BATON_TURN_RESOURCE_KIND;
    const registration = this.registerBuiltinControllerInternal(
      {
        pluginInstanceId,
        resourceKind,
        sources: pluginController.sources,
        maxConcurrency: pluginController.maxConcurrency,
        reconcile: async (baton, resource) =>
          await pluginController.reconcile(
            baton,
            this.exposeBatonResource<TSpec, TStatus>(
              pluginInstanceId,
              resource,
            ),
          ),
        now: this.now,
      },
      true,
    );
    const sourceId = reconcileScopeId({
      batonSessionId: this.proposals.batonSessionId,
      pluginInstanceId,
      resourceKind,
      resourceOwner: "baton",
    });
    if (pluginController.present) {
      const pluginId = this.instances.get(pluginInstanceId).pluginId;
      const present = pluginController.present;
      this.boardSources.set(sourceId, {
        pluginInstanceId,
        present: () =>
          presentBoardSource({
            pluginId,
            pluginInstanceId,
            resourceKind,
            list: () =>
              this.batonResources!.list(resourceKind).map((resource) =>
                this.exposeBatonResource<TSpec, TStatus>(
                  pluginInstanceId,
                  resource,
                ),
              ),
            present,
          }),
      });
    }
    return () => {
      this.boardSources.delete(sourceId);
      registration.close();
    };
  }

  private exposeBatonResource<TSpec, TStatus>(
    pluginInstanceId: string,
    resource: BuiltinResource<typeof BATON_TURN_RESOURCE_KIND>,
  ): Readonly<Resource<TSpec, TStatus>> {
    return Object.freeze({
      kind: resource.kind,
      metadata: Object.freeze({
        resourceId: resource.metadata.resourceId,
        batonSessionId: resource.metadata.batonSessionId,
        pluginInstanceId,
        generation: 1,
        resourceVersion: resource.metadata.revision,
        createdAt: resource.metadata.observedAt,
        updatedAt: resource.metadata.observedAt,
      }),
      spec: Object.freeze({}) as TSpec,
      status: resource.data as TStatus,
    });
  }

  private claimResourceKind(pluginId: string, resourceKind: string): () => void {
    const current = this.resourceKindOwners.get(resourceKind);
    if (current?.owner === "baton") {
      throw new Error(`Resource kind is reserved by Baton: ${resourceKind}`);
    }
    if (current && current.owner !== pluginId) {
      throw new Error(
        `Resource kind ${resourceKind} is already registered by ${current.owner}`,
      );
    }
    if (current) {
      current.controllers += 1;
    } else {
      this.resourceKindOwners.set(resourceKind, {
        owner: pluginId,
        controllers: 1,
        claimedByResource: false,
      });
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const registered = this.resourceKindOwners.get(resourceKind);
      if (!registered || registered.owner !== pluginId) return;
      registered.controllers -= 1;
      if (registered.controllers === 0 && !registered.claimedByResource) {
        this.resourceKindOwners.delete(resourceKind);
      }
    };
  }

  private claimResourceKindForCreate(
    pluginId: string,
    resourceKind: string,
  ): void {
    const current = this.resourceKindOwners.get(resourceKind);
    if (current?.owner === "baton") {
      throw new Error(`Resource kind is reserved by Baton: ${resourceKind}`);
    }
    if (current && current.owner !== pluginId) {
      throw new Error(
        `Resource kind ${resourceKind} is already registered by ${current.owner}`,
      );
    }
    if (current) {
      current.claimedByResource = true;
      return;
    }
    this.resourceKindOwners.set(resourceKind, {
      owner: pluginId,
      controllers: 0,
      claimedByResource: true,
    });
  }

  private async closeManager(): Promise<void> {
    await Promise.allSettled(this.activations.values());
    const errors: unknown[] = [];
    for (const [pluginInstanceId, binding] of [...this.bindings].reverse()) {
      this.bindings.delete(pluginInstanceId);
      try {
        await binding.close();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const controller of this.controllers.values()) controller.close();
    this.controllers.clear();
    this.boardSources.clear();
    this.retries.clear();
    this.activeSourceScopes.clear();
    this.suspendedControllers.clear();
    this.dueQueue.close();
    this.cronSourceQueue.close();
    this.unsubscribeBatonResources?.();
    this.batonResources?.close();
    this.interactions?.close();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "could not close plugin Manager");
  }

  private reportActivationFailure(failure: PluginActivationFailure): void {
    try {
      this.onActivationError?.(Object.freeze(failure));
    } catch {
      // Diagnostic reporting must not keep healthy Plugin instances from starting.
    }
  }

  private notifyBoardChanged(): void {
    if (this.closed) return;
    try {
      this.onBoardChanged?.();
    } catch {
      // Board is a derived view; consumer invalidation must not affect Plugin runtime state.
    }
  }

  private notifyToast(
    pluginInstanceId: string,
    message: ToastMessage,
  ): void {
    const text = message.text.trim();
    if (!text) throw new Error("toast text must not be empty");
    if (!TOAST_TONES.has(message.tone)) {
      throw new Error(`unsupported toast tone: ${message.tone}`);
    }
    try {
      this.onToast?.(
        Object.freeze({
          pluginInstanceId,
          message: Object.freeze({ text, tone: message.tone }),
        }),
      );
    } catch {
      // UI feedback must not affect Plugin runtime state.
    }
  }

  private notifyCommandsChanged(): void {
    if (this.closed) return;
    try {
      this.onCommandsChanged?.();
    } catch {
      // Completion is a derived view; invalidation must not affect Plugin runtime state.
    }
  }

  private restoreDueReconciles(controller: ManagedController): void {
    for (const entry of controller.scheduledReconciles()) {
      this.dueQueue.schedule(entry.key, entry.nextReconcileAt);
    }
  }

  private installController(
    controller: ManagedController,
    suspended = false,
  ): ControllerRegistration {
    const id = reconcileScopeId(controller.scope);
    if (this.controllers.has(id)) {
      controller.close();
      throw new Error(
        `plugin Controller already registered for ${reconcileScopeLabel(controller.scope)}`,
      );
    }
    this.controllers.set(id, controller);
    if (suspended) this.suspendedControllers.add(id);
    try {
      if (this.started && !suspended) {
        this.activateControllerSources(controller);
        this.restoreDueReconciles(controller);
        this.enqueueInitial(controller);
      }
    } catch (error) {
      this.controllers.delete(id);
      this.suspendedControllers.delete(id);
      controller.close();
      this.dueQueue.removeScope(controller.scope);
      this.cronSourceQueue.removeScope(controller.scope);
      throw error;
    }
    let active = true;
    return Object.freeze({
      close: () => {
        if (!active) return;
        active = false;
        if (this.controllers.get(id) !== controller) return;
        this.controllers.delete(id);
        this.suspendedControllers.delete(id);
        controller.close();
        this.dueQueue.removeScope(controller.scope);
        this.cronSourceQueue.removeScope(controller.scope);
        for (const [keyId, retry] of this.retries) {
          if (sameReconcileScope(retry.key, controller.scope)) this.retries.delete(keyId);
        }
      },
    });
  }

  private enqueueInitial(controller: ManagedController): void {
    for (const key of controller.initialReconciles?.() ?? []) {
      void controller.enqueue(key).catch(() => {
        // Queue callback has already scheduled retry and reported diagnostics.
      });
    }
  }

  private activateControllerSources(controller: ManagedController): void {
    if (!controller.sources?.length) return;
    this.cronSourceQueue.register(controller.scope, controller.sources);
  }

  private enqueueCronSourceResources(
    scope: ReconcileScope,
    sources: readonly ControllerSource[],
  ): void {
    if (!this.started || this.closed) return;
    const controller = this.controllers.get(reconcileScopeId(scope));
    if (
      !controller ||
      this.suspendedControllers.has(reconcileScopeId(scope)) ||
      !sameReconcileScope(controller.scope, scope)
    ) {
      return;
    }
    const scopeId = reconcileScopeId(scope);
    if (this.activeSourceScopes.has(scopeId)) return;
    this.activeSourceScopes.add(scopeId);
    void this.runControllerSources(controller, sources).finally(() => {
      this.activeSourceScopes.delete(scopeId);
    });
  }

  private async runControllerSources(
    controller: ManagedController,
    sources: readonly ControllerSource[],
  ): Promise<void> {
    for (const source of sources) {
      try {
        await controller.discover?.(source);
      } catch (error) {
        try {
          this.onControllerSourceError?.(Object.freeze({
            scope: controller.scope,
            sourceId: source.sourceId,
            error,
          }));
        } catch {
          // Source diagnostics must not block reconciliation of known Resources.
        }
      }
    }
    if (
      this.closed ||
      this.controllers.get(reconcileScopeId(controller.scope)) !== controller ||
      this.suspendedControllers.has(reconcileScopeId(controller.scope))
    ) {
      return;
    }
    for (const key of controller.resourceKeys?.() ?? []) {
      void controller.enqueue(key).catch(() => {
        // Queue callback has already scheduled retry and reported diagnostics.
      });
    }
  }

  private enqueueBuiltinResource(resource: BuiltinResource): void {
    if (!this.started || this.closed) return;
    for (const controller of this.controllers.values()) {
      if (this.suspendedControllers.has(reconcileScopeId(controller.scope))) continue;
      if (
        reconcileResourceOwner(controller.scope) !== "baton" ||
        controller.scope.resourceKind !== resource.kind
      ) {
        continue;
      }
      void controller.enqueue({
        ...controller.scope,
        resourceId: resource.metadata.resourceId,
      }).catch(() => {
        // Queue callback has already scheduled retry and reported diagnostics.
      });
    }
  }

  private resumeControllers(pluginInstanceId: string): void {
    for (const controller of this.controllers.values()) {
      if (controller.scope.pluginInstanceId !== pluginInstanceId) continue;
      const id = reconcileScopeId(controller.scope);
      if (!this.suspendedControllers.delete(id)) continue;
      if (this.started) {
        this.activateControllerSources(controller);
        this.restoreDueReconciles(controller);
        this.enqueueInitial(controller);
      }
    }
  }

  private retry(controller: ManagedController, key: ReconcileKey, error: unknown): void {
    if (this.controllers.get(reconcileScopeId(key)) !== controller) return;
    const id = reconcileKeyId(key);
    const attempt = (this.retries.get(id)?.attempt ?? 0) + 1;
    this.retries.set(id, { key, attempt });
    const now = this.now();
    if (Number.isNaN(now.getTime())) {
      this.reportFailure({
        key,
        error: new AggregateError([error], "plugin Manager now() returned an invalid Date"),
        attempt,
      });
      return;
    }
    const delay = Math.min(
      this.retryMaxDelayMs,
      this.retryInitialDelayMs * 2 ** Math.min(attempt - 1, 30),
    );
    const nextRetryAt = new Date(now.getTime() + delay);
    try {
      controller.setNextReconcileAt?.(key, nextRetryAt);
      if (this.started) this.dueQueue.schedule(key, nextRetryAt);
      this.reportFailure({
        key,
        error,
        attempt,
        nextRetryAt: nextRetryAt.toISOString(),
      });
    } catch (retryError) {
      this.reportFailure({
        key,
        error: new AggregateError(
          [error, retryError],
          `could not persist retry for ${reconcileScopeLabel(key)}/${key.resourceId}`,
        ),
        attempt,
      });
    }
  }

  private reportFailure(failure: ReconcileFailure): void {
    try {
      this.onReconcileError?.(Object.freeze(failure));
    } catch {
      // Diagnostic reporting must not break retry scheduling.
    }
  }
}
