import {
  Controller,
  type ReconcileFailure,
  type ReconcileKey,
  type ReconcileRetryBackoff,
  type ReconcileScope,
  type ScheduledReconcile,
  reconcileRetryBackoff,
} from "./controller.ts";

export type { ReconcileFailure } from "./controller.ts";
import {
  BuiltinController,
  type BuiltinResource,
  type BuiltinControllerOptions,
  type BuiltinResourceKind,
  BatonResourceIndex,
} from "./builtin.ts";
import {
  type CreatePluginInstance,
  type PluginInstance,
  type PluginInstanceRepository,
} from "./instance.ts";
import {
  PluginBinding,
  type Controller as PluginResourceController,
  type CronSource,
  type PluginCommandInput,
  type PluginCommandResult,
  type HookStage,
  type HookSubjectMap,
  type Resource,
  type ResourceRef,
  type ResourceType,
  BATON_SYSTEM_NAMESPACE,
  BATON_TURN_RESOURCE_TYPE,
  type PluginLogRecord,
  type ToastMessage,
  type ToastTone,
} from "./package.ts";
import {
  PackageLoader,
  type PackageLoaderOptions,
} from "./package-loader.ts";
import {
  reconcileKeyId,
  ReconcileCapacity,
  ReconcileDueQueue,
} from "./queue.ts";
import {
  CronSourceQueue,
} from "./cron-source.ts";
import {
  PluginResourceStore,
  resourceTypeKey,
} from "./resource.ts";
import {
  createResourceClient,
  type ResourceClientChange,
} from "./resource-client.ts";
import {
  BoardProjection,
  type BoardItem,
  presentBoardSource,
} from "./board.ts";
import {
  installRegistration,
  PluginSupervisor,
} from "./runner/index.ts";
import type { SessionHandle } from "../store/store.ts";
import type { InteractionResult } from "../interaction/types.ts";
import type { ReconcileInteractionStoreOptions } from "../interaction/reconcile.ts";
import {
  emptyReconcileSnapshot,
  type ReconcileSnapshot,
} from "./reconcile-snapshot.ts";
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
import { MentionRegistry } from "../context/registry.ts";
import {
  type LogSink,
  logError,
} from "../logging.ts";
import { preparePluginDataDirectories } from "./data.ts";
import type { ScheduledHarnessInvocation } from "./harness-invocation.ts";
import { Verb } from "./verb.ts";
import { HookRegistry, HookRuntime } from "./hook.ts";

const TOAST_TONES = new Set<ToastTone>([
  "info",
  "success",
  "warning",
  "error",
]);
const PLUGIN_LOG_LEVELS = new Set([
  "debug",
  "info",
  "warn",
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
  "pluginInstanceId" | "resourceKind" | "sources" | "watches" | "reconcile" | "maxConcurrency" | "now"
>;

export interface PluginToast {
  readonly pluginInstanceId: string;
  readonly message: ToastMessage;
}

export interface ManagerOptions {
  /** 所有 Controller 合计可占用的执行容量；默认 1。 */
  maxTotalConcurrency?: number;
  /** Manager 与所有 Plugin 数据共享的 BatonSession owner。 */
  instances: PluginInstanceRepository;
  /**
   * 启用 Baton-owned Resource 与 ReconcileContext verbs 时传完整 SessionHandle。只持有
   * PluginInstanceRepository 的调用方
   * 仍可使用 Plugin Resource Controller，但不能观察 Baton-owned Resource。
   */
  session?: Pick<
    SessionHandle,
    | "id"
    | "dir"
    | "ledger"
    | "log"
    | "ensureMainLane"
    | "requireLane"
  >;
  /** 当前进程可激活的可信、不可变 Package 版本。 */
  packages?: PackageLoaderOptions["packages"];
  /** reconcile 调用前读取并冻结的当前 BatonSession 视图。 */
  snapshot?: () => ReconcileSnapshot;
  /** Current host selection used by an implicit harness() or a submitted draft(). */
  selectedHarnessTargetId?: () => string | undefined;
  /** Policy decision for the mandatory Interaction before a Plugin Harness invocation. */
  harnessInvocationGate?: ReconcileInteractionStoreOptions["harnessInvocationGate"];
  /** 按需加载已安装 Package；fresh 用于开发期 `/reload-plugins` 绕过模块缓存。 */
  loadPackage?: PackageLoaderOptions["loadPackage"];
  /**
   * Resolve an immutable entry without importing it into Baton. When supplied
   * with a PluginSupervisor, Marketplace Plugin code runs in a per-Binding
   * child process.
   */
  loadPackageEntry?: PackageLoaderOptions["loadPackageEntry"];
  pluginSupervisor?: PluginSupervisor;
  /** Host-owned bridge that materializes the request's explicit Lane policy. */
  enqueueHarnessInvocation?(
    request: ScheduledHarnessInvocation,
  ): Promise<unknown> | void;
  /** Cancels a queued Request or interrupts its active Queue run. */
  cancelHarnessInvocation?(
    harnessInvocationId: string,
  ): "queued" | "running" | undefined;
  /** Board 展示内容变化；宿主据此重建展示快照。 */
  onBoardChanged?(): void;
  /** Plugin 发出的 session-scoped 瞬时提示；不进入 Event Ledger。 */
  onToast?(toast: PluginToast): void;
  /** Plugin command 注册或 Binding 生命周期变化；宿主据此刷新命令补全。 */
  onCommandsChanged?(): void;
  /** Baton core 已占用的 slash command 名称，Plugin 不得覆盖。 */
  reservedCommandNames?: readonly string[];
  /** Baton-owned and Plugin-provided explicit mentions share one registry. */
  mentions?: MentionRegistry;
  /** Default timeout for one Hook handler. */
  hookTimeoutMs?: number;
  /** Maximum number of best-effort after Hook deliveries awaiting completion. */
  afterHookQueueLimit?: number;
  /** Controller reconcile 失败后的指数退避；默认从 1 秒增长到最多 1 分钟。 */
  retryBackoff?: Partial<ReconcileRetryBackoff>;
  now?: () => Date;
  /** 单个 Instance 激活失败不阻断其他 Plugin；宿主可将失败展示到 UI 或诊断日志。 */
  onActivationError?(failure: PluginActivationFailure): void;
  /** 已激活 Runner 意外退出；Manager 会撤销该 Binding 的全部宿主注册。 */
  onRunnerFailure?(failure: PluginRunnerFailure): void;
  /** 自动重试已安排；宿主可将错误展示到 UI 或诊断日志。 */
  onReconcileError?(failure: ReconcileFailure): void;
  /** Controller resource Source initial/live observation failure. */
  onControllerSourceError?(failure: ControllerSourceFailure): void;
}

export interface PluginActivationFailure {
  readonly pluginInstanceId: string;
  readonly error: unknown;
}

export interface PluginRunnerFailure {
  readonly pluginInstanceId: string;
  readonly error: Error;
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
  ownsResource(resource: ResourceRef): boolean;
  cronSources?(): readonly CronSource[];
  startSources?(
    onError: (sourceId: string, error: unknown) => void,
  ): Promise<void>;
  enqueue(key: ReconcileKey): Promise<void>;
  reconcileKeys(change: ResourceClientChange): Promise<readonly ReconcileKey[]>;
  close(): void;
  scheduledReconciles(): ScheduledReconcile[];
  resourceKeys?(): ReconcileKey[];
  initialReconciles?(): ReconcileKey[];
}

function pluginName(pluginId: string): string {
  const name = pluginId.split("/").at(-1);
  if (!name) throw new Error(`pluginId has no name: ${pluginId}`);
  return name;
}

/**
 * Plugin 域统一入口：注册和路由 Controller，并限制所有 Plugin 的进程总并发。
 */
export class Manager {
  /** Baton claims its Resource kinds before any Plugin Binding can register. */
  private readonly resourceTypeOwners = new Map<string, {
    readonly owner: "baton" | string;
    controllers: number;
    claimedByResource: boolean;
  }>([
    [
      resourceTypeKey(BATON_TURN_RESOURCE_TYPE),
      { owner: "baton", controllers: 0, claimedByResource: true },
    ],
  ]);
  private readonly controllers = new Map<string, ManagedController>();
  private readonly board: BoardProjection;
  private readonly commandRegistry: PluginCommandRegistry;
  private readonly mentions: MentionRegistry;
  private readonly hooks: HookRuntime;
  private readonly hookRegistry = new HookRegistry();
  private readonly instances: PluginInstanceRepository;
  private readonly packageLoader: PackageLoader;
  private readonly pluginSupervisor?: PluginSupervisor;
  private readonly snapshot: () => ReconcileSnapshot;
  private readonly verb: Verb;
  private readonly bindings = new Map<string, PluginBinding>();
  private readonly activations = new Map<string, Promise<void>>();
  private readonly capacity: ReconcileCapacity;
  private readonly batonResources?: BatonResourceIndex;
  private readonly unsubscribeBatonResources?: () => void;
  private readonly onToast: ManagerOptions["onToast"];
  private readonly onCommandsChanged: ManagerOptions["onCommandsChanged"];
  private readonly onActivationError: ManagerOptions["onActivationError"];
  private readonly onRunnerFailure: ManagerOptions["onRunnerFailure"];
  private readonly onReconcileError: ManagerOptions["onReconcileError"];
  private readonly onControllerSourceError:
    ManagerOptions["onControllerSourceError"];
  private readonly log?: LogSink;
  private readonly retryBackoff: ReconcileRetryBackoff;
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
    this.now = options.now ?? (() => new Date());
    this.instances = options.instances;
    if (
      options.session &&
      (options.session.id !== this.instances.session.id ||
        options.session.dir !== this.instances.session.dir)
    ) {
      throw new Error(
        "plugin Manager session and PluginInstanceRepository must own the same BatonSession",
      );
    }
    this.log = options.session
      ? (entry) => options.session!.log(entry)
      : undefined;
    this.board = new BoardProjection({
      isInstanceActive: (pluginInstanceId) =>
        this.bindings.has(pluginInstanceId),
      ...(options.onBoardChanged
        ? { onChanged: options.onBoardChanged }
        : {}),
      onRefreshError: (error) => {
        this.log?.({
          level: "error",
          source: "baton",
          component: "plugin.board",
          message: "Could not refresh Plugin Board projection",
          error: logError(error),
        });
      },
    });
    this.pluginSupervisor = options.pluginSupervisor;
    this.packageLoader = new PackageLoader({
      ...(options.packages ? { packages: options.packages } : {}),
      ...(options.loadPackage ? { loadPackage: options.loadPackage } : {}),
      ...(options.pluginSupervisor && options.loadPackageEntry
        ? { loadPackageEntry: options.loadPackageEntry }
        : {}),
    });
    this.snapshot =
      options.snapshot ??
      (() => emptyReconcileSnapshot(this.instances.session.id));
    this.verb = new Verb({
      session: options.session,
      capacity: this.capacity,
      snapshot: this.snapshot,
      selectedHarnessTargetId: options.selectedHarnessTargetId,
      harnessInvocationGate: options.harnessInvocationGate,
      enqueueHarnessInvocation: options.enqueueHarnessInvocation,
      cancelHarnessInvocation: options.cancelHarnessInvocation,
      now: this.now,
      log: this.log,
    });
    this.hooks = new HookRuntime(this.hookRegistry, {
      snapshot: this.snapshot,
      verb: this.verb,
      invokeVerb: (context, request) => this.verb.invoke(context, request),
      log: this.log,
      ...(options.hookTimeoutMs === undefined
        ? {}
        : { defaultTimeoutMs: options.hookTimeoutMs }),
      ...(options.afterHookQueueLimit === undefined
        ? {}
        : { afterQueueLimit: options.afterHookQueueLimit }),
    });
    this.onToast = options.onToast;
    this.onCommandsChanged = options.onCommandsChanged;
    this.mentions = options.mentions ?? new MentionRegistry();
    this.commandRegistry = new PluginCommandRegistry({
      reservedNames: options.reservedCommandNames,
      isInstanceActive: (pluginInstanceId) =>
        this.bindings.has(pluginInstanceId),
      onChanged: () => this.notifyCommandsChanged(),
    });
    this.onActivationError = options.onActivationError;
    this.onRunnerFailure = options.onRunnerFailure;
    this.onReconcileError = options.onReconcileError;
    this.onControllerSourceError = options.onControllerSourceError;
    this.retryBackoff = reconcileRetryBackoff(options.retryBackoff);
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
        this.board.invalidate();
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
    if (definition.store.batonSessionId !== this.instances.session.id) {
      throw new Error(
        `plugin Controller batonSessionId must be ${this.instances.session.id}, got ${definition.store.batonSessionId}`,
      );
    }
    const controller: Controller<TSpec, TStatus> = new Controller({
      ...definition,
      snapshot: (key, resource) => this.snapshotFor(key, resource),
      invokeVerb: (context, request) => this.verb.invoke(context, request),
      executeWithCapacity: (execute) =>
        this.capacity.run(async () => await execute()),
      executeReconcile: (scope, localLease, execute) =>
        this.verb.execute(scope, localLease, execute),
      retry: {
        backoff: this.retryBackoff,
        now: this.now,
        schedule: (key, next) => {
          if (this.controllers.get(reconcileScopeId(key)) !== controller) return;
          if (this.started) this.dueQueue.schedule(key, next);
        },
        report: (failure) => {
          if (this.controllers.get(reconcileScopeId(failure.key)) !== controller) return;
          this.reportFailure(failure);
        },
      },
      onSourceResource: () => this.board.invalidate(),
      onResourceDeleted: (resource) => {
        this.handlePluginResourceChange(Object.freeze({
          kind: "deleted",
          resource,
        }));
      },
      onWatchError: (change, error) =>
        this.reportWatchFailure(controller.scope, change, error),
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
    const controller: BuiltinController<K> = new BuiltinController({
      ...definition,
      resources: this.batonResources,
      snapshot: (key, resource) => this.snapshotFor(key, resource),
      invokeVerb: (context, request) => this.verb.invoke(context, request),
      executeReconcile: (scope, localLease, execute) =>
        this.verb.execute(scope, localLease, execute),
      retry: {
        backoff: this.retryBackoff,
        now: this.now,
        schedule: (key, next) => {
          if (this.controllers.get(reconcileScopeId(key)) !== controller) return;
          if (this.started) this.dueQueue.schedule(key, next);
        },
        report: (failure) => {
          if (this.controllers.get(reconcileScopeId(failure.key)) !== controller) return;
          this.reportFailure(failure);
        },
      },
      onWatchError: (change, error) =>
        this.reportWatchFailure(controller.scope, change, error),
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

  /** 收口崩溃遗留的 Plugin execution，再恢复 Resource due time。 */
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
    const packageSource = await this.packageLoader.load(instance);
    const batonSession = this.snapshot().session;
    if (batonSession.batonSessionId !== this.instances.session.id) {
      throw new Error(
        `PluginContext batonSessionId must be ${this.instances.session.id}, got ${batonSession.batonSessionId}`,
      );
    }

    const resources = createResourceClient(
      new PluginResourceStore({
        session: this.instances.session,
        pluginInstanceId: instance.pluginInstanceId,
      }),
      (change) => this.handlePluginResourceChange(change),
      (resourceType) =>
        this.claimResourceTypeForCreate(instance.pluginId, resourceType),
    );
    const dataDirs = preparePluginDataDirectories(
      {
        batonSessionId: batonSession.batonSessionId,
        ...(batonSession.cwd === undefined ? {} : { cwd: batonSession.cwd }),
        dir: this.instances.session.dir,
      },
      instance,
    );
    const binding = new PluginBinding(
      instance,
      {
        batonSessionId: batonSession.batonSessionId,
        ...(batonSession.cwd === undefined ? {} : { cwd: batonSession.cwd }),
      },
      dataDirs,
      {
        registerCommand: (command) =>
          this.commandRegistry.register(instance, command),
        registerMention: (mention) =>
          this.mentions.registerMention(
            mention,
            pluginName(instance.pluginId),
          ),
        registerHook: (hook) =>
          this.hookRegistry.register(
            {
              batonSessionId: instance.batonSessionId,
              pluginInstanceId: instance.pluginInstanceId,
              pluginId: instance.pluginId,
            },
            hook,
          ),
        registerController: (controller) =>
          this.bindController(instance, controller),
        showToast: (message) =>
          this.notifyToast(instance.pluginInstanceId, message),
        writeLog: (entry) => this.writePluginLog(instance, entry),
      },
      resources,
    );
    let activation!: Promise<void>;
    activation = Promise.resolve()
      .then(async () => {
        try {
          if (packageSource.kind === "in-process") {
            await packageSource.plugin.activate(binding);
          } else {
            if (!this.pluginSupervisor) {
              throw new Error("Plugin Supervisor is unavailable");
            }
            const runner = await this.pluginSupervisor.activate(
              packageSource.entry,
              instance,
              binding.session,
              dataDirs,
              {
                resources,
                invokeVerb: (context, request) => {
                  if (context.pluginInstanceId !== instance.pluginInstanceId) {
                    throw new Error(
                      `Plugin Runner execution scope must belong to ${instance.pluginInstanceId}`,
                    );
                  }
                  return this.verb.invoke(context, request);
                },
                onToast: (message) =>
                  this.notifyToast(instance.pluginInstanceId, message),
                onLog: (entry) => this.writePluginLog(instance, entry),
                onOutput: (stream, output) =>
                  this.writePluginLog(instance, {
                    level: stream === "stderr" ? "warn" : "debug",
                    message: `Plugin Runner wrote to ${stream}`,
                    context: {
                      component: `runner.${stream}`,
                      attributes: { output },
                    },
                  }),
                onFailure: (error) =>
                  this.handleRunnerFailure(
                    instance.pluginInstanceId,
                    error,
                  ),
              },
            );
            // Register Runner cleanup first so reverse-order Binding close
            // withdraws host registrations before terminating third-party code.
            binding.lifecycle.onClose(() => runner.close());
            for (const registration of runner.activation.registrations) {
              installRegistration(
                binding,
                runner.client,
                registration,
              );
            }
          }
          binding.completeActivation();
          if (this.closed) throw new Error("plugin Manager is closed");
          this.bindings.set(pluginInstanceId, binding);
          this.log?.({
            level: "info",
            source: "baton",
            component: "plugin.activation",
            message: "Plugin activated",
            pluginId: instance.pluginId,
            pluginInstanceId: instance.pluginInstanceId,
            packageVersion: instance.packageVersion,
          });
          this.notifyCommandsChanged();
          await this.resumeControllers(pluginInstanceId);
          this.board.invalidate();
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
    this.verb.failInstance(
      pluginInstanceId,
      "Plugin instance was deactivated",
    );
    try {
      await binding.close();
    } finally {
      this.board.invalidate();
    }
  }

  isInstanceActive(pluginInstanceId: string): boolean {
    return this.bindings.has(pluginInstanceId);
  }

  listInstances(): PluginInstance[] {
    return this.instances.list();
  }

  async listMentionCandidates(prefix: string): ReturnType<
    MentionRegistry["candidates"]
  > {
    return await this.mentions.candidates(prefix);
  }

  hasMentionReference(input: string): boolean {
    return this.mentions.hasReference(input);
  }

  resolveMentions(
    input: string,
    maxChars: number,
  ): Promise<readonly string[]> {
    return this.mentions.resolve(input, maxChars);
  }

  beforeHook<S extends Extract<HookStage, `${string}.before`>>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): Promise<void> {
    return this.hooks.before(stage, subject);
  }

  afterHook<S extends Extract<HookStage, `${string}.after`>>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): void {
    this.hooks.after(stage, subject);
  }

  hasHook(stage: HookStage): boolean {
    return this.hookRegistry.has(stage);
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

    await this.packageLoader.load(
      Object.freeze({ ...current, packageVersion }),
    );
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
      const key = this.packageLoader.sourceKey(instance);
      if (loadedPackages.has(key)) continue;
      loadedPackages.add(key);
      try {
        await this.packageLoader.load(instance, true);
      } catch (error) {
        packageFailures.set(key, error);
      }
    }

    const activated: string[] = [];
    for (const instance of enabled) {
      if (failures.has(instance.pluginInstanceId)) continue;
      const error = packageFailures.get(
        this.packageLoader.sourceKey(instance),
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
    this.board.close();
    const closing = this.closeManager();
    this.closing = closing;
    return closing;
  }

  listHarnessInvocations() {
    return this.verb.listHarnessInvocations();
  }

  listBoardItems(): readonly BoardItem[] {
    return this.board.list();
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

  /** Persist the Interaction result before resuming its live Plugin execution. */
  async completeInteraction(
    interactionId: string,
    result: InteractionResult,
  ): Promise<boolean> {
    return this.verb.completeInteraction(interactionId, result);
  }

  async cancelHarnessInvocation(identifier?: string): Promise<boolean> {
    return this.verb.cancelHarnessInvocation(identifier);
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

  private snapshotFor(key: ReconcileKey, resource: ResourceRef): ReconcileSnapshot {
    return this.snapshot();
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
    this.verb.failOrphans();
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
    await Promise.all(
      controllers.map(async (controller) => {
        if (
          this.controllers.get(reconcileScopeId(controller.scope)) !== controller
        ) {
          return;
        }
        await this.activateControllerSources(controller);
        if (
          this.controllers.get(reconcileScopeId(controller.scope)) !== controller
        ) {
          return;
        }
        this.enqueueInitial(controller);
      }),
    );
  }

  private bindController<TSpec, TStatus>(
    instance: PluginInstance,
    pluginController: PluginResourceController<TSpec, TStatus>,
  ): () => void {
    if (
      resourceTypeKey(pluginController.resourceType) ===
        resourceTypeKey(BATON_TURN_RESOURCE_TYPE)
    ) {
      return this.bindBatonResourceController(
        instance.pluginInstanceId,
        pluginController,
      );
    }
    const releaseKind = this.claimResourceType(
      instance.pluginId,
      pluginController.resourceType,
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
      batonSessionId: this.instances.session.id,
      pluginInstanceId,
      resourceApiVersion: pluginController.resourceType.apiVersion,
      resourceKind: pluginController.resourceType.kind,
    });
    let unregisterBoardSource: (() => void) | undefined;
    if (pluginController.present) {
      const pluginId = this.instances.get(pluginInstanceId).pluginId;
      const present = pluginController.present;
      unregisterBoardSource = this.board.registerSource(sourceId, {
        pluginInstanceId,
        present: () =>
          presentBoardSource<TSpec, TStatus>({
            pluginId,
            pluginInstanceId,
            resourceType: pluginController.resourceType,
            list: () =>
              store.list<TSpec, TStatus>(pluginController.resourceType),
            present,
          }),
      });
    }
    return () => {
      unregisterBoardSource?.();
      registration.close();
    };
  }

  private bindBatonResourceController<TSpec, TStatus>(
    pluginInstanceId: string,
    pluginController: PluginResourceController<TSpec, TStatus>,
  ): () => void {
    if (!this.batonResources) {
      throw new Error(
        `Resource type ${pluginController.resourceType.apiVersion}/${pluginController.resourceType.kind} requires a SessionHandle`,
      );
    }
    const resourceKind = BATON_TURN_RESOURCE_TYPE.kind;
    const sources = pluginController.sources ?? [];
    if (sources.some((source) => source.type === "resource")) {
      throw new Error(
        "Controller resource Sources cannot materialize Baton-owned Resources",
      );
    }
    const cronSources = sources.filter(
      (source): source is CronSource => source.type === "cron",
    );
    const registration = this.registerBuiltinControllerInternal(
      {
        pluginInstanceId,
        resourceKind,
        sources: cronSources,
        watches: pluginController.watches,
        maxConcurrency: pluginController.maxConcurrency,
        reconcile: async (context, resource) =>
          await pluginController.reconcile(
            context,
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
      batonSessionId: this.instances.session.id,
      pluginInstanceId,
      resourceApiVersion: BATON_TURN_RESOURCE_TYPE.apiVersion,
      resourceKind,
      resourceOwner: "baton",
    });
    let unregisterBoardSource: (() => void) | undefined;
    if (pluginController.present) {
      const pluginId = this.instances.get(pluginInstanceId).pluginId;
      const present = pluginController.present;
      unregisterBoardSource = this.board.registerSource(sourceId, {
        pluginInstanceId,
        present: () =>
          presentBoardSource<TSpec, TStatus>({
            pluginId,
            pluginInstanceId,
            resourceType: BATON_TURN_RESOURCE_TYPE,
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
      unregisterBoardSource?.();
      registration.close();
    };
  }

  private exposeBatonResource<TSpec, TStatus>(
    _pluginInstanceId: string,
    resource: BuiltinResource<typeof BATON_TURN_RESOURCE_TYPE.kind>,
  ): Readonly<Resource<TSpec, TStatus>> {
    return Object.freeze({
      apiVersion: BATON_TURN_RESOURCE_TYPE.apiVersion,
      kind: resource.kind,
      metadata: Object.freeze({
        name: resource.metadata.resourceId,
        namespace: BATON_SYSTEM_NAMESPACE,
        uid: resource.metadata.sourceEventId,
        generation: 1,
        resourceVersion: String(resource.metadata.revision),
        creationTimestamp: resource.metadata.observedAt,
      }),
      spec: Object.freeze({}) as TSpec,
      status: resource.data as TStatus,
    });
  }

  private claimResourceType(pluginId: string, type: ResourceType): () => void {
    const key = resourceTypeKey(type);
    const current = this.resourceTypeOwners.get(key);
    if (current?.owner === "baton") {
      throw new Error(`Resource type is reserved by Baton: ${key}`);
    }
    if (current && current.owner !== pluginId) {
      throw new Error(
        `Resource type ${key} is already registered by ${current.owner}`,
      );
    }
    if (current) {
      current.controllers += 1;
    } else {
      this.resourceTypeOwners.set(key, {
        owner: pluginId,
        controllers: 1,
        claimedByResource: false,
      });
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const registered = this.resourceTypeOwners.get(key);
      if (!registered || registered.owner !== pluginId) return;
      registered.controllers -= 1;
      if (registered.controllers === 0 && !registered.claimedByResource) {
        this.resourceTypeOwners.delete(key);
      }
    };
  }

  private claimResourceTypeForCreate(
    pluginId: string,
    type: ResourceType,
  ): void {
    const key = resourceTypeKey(type);
    const current = this.resourceTypeOwners.get(key);
    if (current?.owner === "baton") {
      throw new Error(`Resource type is reserved by Baton: ${key}`);
    }
    if (current && current.owner !== pluginId) {
      throw new Error(
        `Resource type ${key} is already registered by ${current.owner}`,
      );
    }
    if (current) {
      current.claimedByResource = true;
      return;
    }
    this.resourceTypeOwners.set(key, {
      owner: pluginId,
      controllers: 0,
      claimedByResource: true,
    });
  }

  private async closeManager(): Promise<void> {
    await Promise.allSettled(this.activations.values());
    this.verb.failAll("Plugin Manager was closed");
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
    this.suspendedControllers.clear();
    this.dueQueue.close();
    this.cronSourceQueue.close();
    this.unsubscribeBatonResources?.();
    this.batonResources?.close();
    this.verb.close();
    try {
      await this.pluginSupervisor?.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "could not close plugin Manager");
  }

  private reportActivationFailure(failure: PluginActivationFailure): void {
    this.log?.({
      level: "error",
      source: "baton",
      component: "plugin.activation",
      message: "Plugin activation failed",
      pluginInstanceId: failure.pluginInstanceId,
      error: logError(failure.error),
    });
    try {
      this.onActivationError?.(Object.freeze(failure));
    } catch {
      // Diagnostic reporting must not keep healthy Plugin instances from starting.
    }
  }

  private handlePluginResourceChange(change: ResourceClientChange): void {
    this.board.invalidate();
    void this.routePluginResourceChange(change);
  }

  private async routePluginResourceChange(
    change: ResourceClientChange,
  ): Promise<void> {
    if (this.closed) return;

    const pending = new Map<string, {
      controller: ManagedController;
      key: ReconcileKey;
    }>();
    for (const controller of this.controllers.values()) {
      const scopeId = reconcileScopeId(controller.scope);
      if (
        controller.scope.pluginInstanceId !==
          change.resource.metadata.namespace ||
        this.suspendedControllers.has(scopeId)
      ) {
        continue;
      }
      let requests;
      try {
        requests = await controller.reconcileKeys(change);
      } catch (error) {
        this.reportWatchFailure(controller.scope, change, error);
        continue;
      }
      for (const request of requests) {
        pending.set(reconcileKeyId(request), { controller, key: request });
      }
    }

    for (const { controller, key } of pending.values()) {
      void controller.enqueue(key).catch(() => {
        // Reconcile failures use the Controller retry path; close races need no extra reaction.
      });
    }
  }

  private reportWatchFailure(
    scope: ReconcileScope,
    change: ResourceClientChange,
    error: unknown,
  ): void {
    this.log?.({
      level: "error",
      source: "baton",
      component: "plugin.watch",
      message: "Plugin Controller EventHandler failed",
      pluginInstanceId: scope.pluginInstanceId,
      error: logError(error),
      attributes: {
        primaryResource: `${scope.resourceApiVersion}/${scope.resourceKind}`,
        watchedResource: `${change.resource.apiVersion}/${change.resource.kind}`,
      },
    });
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
      // UI feedback must not affect Plugin-owned state.
    }
  }

  private writePluginLog(
    instance: PluginInstance,
    record: PluginLogRecord,
  ): void {
    try {
      if (
        !record ||
        typeof record !== "object" ||
        !PLUGIN_LOG_LEVELS.has(record.level)
      ) {
        return;
      }
      const message = typeof record.message === "string"
        ? record.message.trim()
        : "";
      if (!message) return;
      const context = record.context;
      const localComponent = typeof context?.component === "string"
        ? context.component.trim()
        : "";
      this.log?.({
        level: record.level,
        source: "plugin",
        component: localComponent
          ? `plugin.${instance.pluginId}.${localComponent}`
          : `plugin.${instance.pluginId}`,
        message,
        pluginId: instance.pluginId,
        pluginInstanceId: instance.pluginInstanceId,
        packageVersion: instance.packageVersion,
        ...(context?.error === undefined
          ? {}
          : { error: logError(context.error) }),
        ...(context?.attributes &&
            typeof context.attributes === "object" &&
            !Array.isArray(context.attributes)
          ? { attributes: context.attributes }
          : {}),
      });
    } catch {
      // Diagnostics must never affect Plugin activation or reconciliation.
    }
  }

  private notifyCommandsChanged(): void {
    if (this.closed) return;
    try {
      this.onCommandsChanged?.();
    } catch {
      // Completion is a derived view; invalidation must not affect Plugin-owned state.
    }
  }

  private handleRunnerFailure(
    pluginInstanceId: string,
    error: Error,
  ): void {
    this.verb.failInstance(pluginInstanceId, error.message);
    this.log?.({
      level: "error",
      source: "baton",
      component: "plugin.runner",
      message: "Plugin Runner stopped unexpectedly",
      pluginInstanceId,
      error: logError(error),
    });
    try {
      this.onRunnerFailure?.({ pluginInstanceId, error });
    } catch {
      // Failure reporting cannot keep a dead Binding registered.
    }
    void (async () => {
      const activation = this.activations.get(pluginInstanceId);
      if (activation) {
        try {
          await activation;
        } catch {
          return;
        }
      }
      await this.deactivateInstance(pluginInstanceId);
    })().catch(() => {
      // Binding close errors are surfaced through diagnostics at their origin.
    });
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
        void this.activateControllerSources(controller).then(() => {
          if (this.controllers.get(id) !== controller) return;
          this.restoreDueReconciles(controller);
          this.enqueueInitial(controller);
        });
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

  private async activateControllerSources(
    controller: ManagedController,
  ): Promise<void> {
    const cronSources = controller.cronSources?.() ?? [];
    if (cronSources.length > 0) {
      this.cronSourceQueue.register(controller.scope, cronSources);
    }
    await controller.startSources?.((sourceId, error) => {
      try {
        this.log?.({
          level: "error",
          source: "baton",
          component: "plugin.source",
          message: `Plugin source ${sourceId} failed`,
          pluginInstanceId: controller.scope.pluginInstanceId,
          error: logError(error),
          attributes: {
            resourceApiVersion: controller.scope.resourceApiVersion,
            resourceKind: controller.scope.resourceKind,
            sourceId,
          },
        });
        this.onControllerSourceError?.(Object.freeze({
          scope: controller.scope,
          sourceId,
          error,
        }));
      } catch {
        // Source diagnostics must not interrupt discovery or live delivery.
      }
    });
  }

  private enqueueCronSourceResources(
    scope: ReconcileScope,
    _sources: readonly CronSource[],
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

  private async resumeControllers(pluginInstanceId: string): Promise<void> {
    for (const controller of this.controllers.values()) {
      if (controller.scope.pluginInstanceId !== pluginInstanceId) continue;
      const id = reconcileScopeId(controller.scope);
      if (!this.suspendedControllers.delete(id)) continue;
      if (this.started) {
        await this.activateControllerSources(controller);
        if (this.controllers.get(id) !== controller) continue;
        this.restoreDueReconciles(controller);
        this.enqueueInitial(controller);
      }
    }
  }

  private reportFailure(failure: ReconcileFailure): void {
    this.log?.({
      level: "error",
      source: "baton",
      component: "plugin.reconcile",
      message: "Plugin reconcile failed",
      pluginInstanceId: failure.key.pluginInstanceId,
      error: logError(failure.error),
      attributes: {
        resourceApiVersion: failure.key.resourceApiVersion,
        resourceKind: failure.key.resourceKind,
        resourceId: failure.key.resourceId,
        attempt: failure.attempt,
        ...(failure.nextRetryAt
          ? { nextRetryAt: failure.nextRetryAt }
          : {}),
      },
    });
    try {
      this.onReconcileError?.(Object.freeze(failure));
    } catch {
      // Diagnostic reporting must not break retry scheduling.
    }
  }
}
