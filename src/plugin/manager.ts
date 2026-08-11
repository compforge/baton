import { MAIN_LANE_ID } from "@compforge/baton-plugin";

import {
  Controller,
  type ReconcileKey,
  type ReconcileScope,
  type ScheduledReconcile,
} from "./controller.ts";
import {
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
  type CronSource,
  type PluginCommandInput,
  type PluginCommandResult,
  type PluginPackage,
  type Resource,
  type ResourceRef,
  type ResourceType,
  type SourceContext,
  BATON_SYSTEM_NAMESPACE,
  BATON_TURN_RESOURCE_TYPE,
  pluginPackageKey,
  type PluginLogRecord,
  type ToastMessage,
  type ToastTone,
  type Watch,
  validatePluginPackage,
} from "./package.ts";
import {
  reconcileKeyId,
  ReconcileCapacity,
  ReconcileDueQueue,
} from "./queue.ts";
import {
  CronSourceQueue,
} from "./cron-source.ts";
import { validateSources } from "./source.ts";
import {
  PluginResourceStore,
  resourceTypeKey,
} from "./resource.ts";
import {
  createResourceClient,
  type ResourceClientChange,
} from "./resource-client.ts";
import {
  type BoardItem,
  type BoardItemCandidate,
  presentBoardSource,
  selectBoardItems,
} from "./board.ts";
import {
  PluginSupervisor,
  type PluginRunnerClient,
  type CommandRegistration as RunnerCommandRegistration,
  type ContextProviderRegistration as RunnerContextProviderRegistration,
  type ControllerRegistration as RunnerControllerRegistration,
  type PluginPackageEntry,
  type PluginRegistration as RunnerRegistration,
} from "./runner/index.ts";
import type { SessionHandle } from "../store/store.ts";
import type { PromptBlock } from "../event/types.ts";
import type { InteractionResult } from "../interaction/types.ts";
import { Store as InteractionStore } from "./interaction.ts";
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
import { ContextProviderRegistry } from "../context/registry.ts";
import {
  type LogSink,
  logError,
} from "../logging.ts";
import { watchRequests } from "./watch.ts";
import { preparePluginDataDirectories } from "./data.ts";
import {
  type ScheduledHarnessInvocation,
  HarnessInvocationStore,
} from "./harness-invocation.ts";
import type {
  ReconcileVerbScope,
  ReconcileVerbRequest,
  ReconcileVerbResponse,
} from "./verbs.ts";
import {
  reconcileScope,
  reconcileSnapshot,
} from "./verbs.ts";

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
  proposals: ProposalStore;
  /**
   * 启用 Baton-owned Resource 时传完整 SessionHandle。只持有 ProposalStore 的调用方
   * 仍可使用 Plugin Resource Controller，但不能观察 Baton-owned Resource。
   */
  session?: Pick<
    SessionHandle,
    | "id"
    | "dir"
    | "readEvents"
    | "subscribe"
    | "append"
    | "log"
    | "ensureMainLane"
    | "requireLane"
  >;
  /** 缺省与 ProposalStore 使用同一个 BatonSession。 */
  instances?: PluginInstanceRepository;
  /** 当前进程可激活的可信、不可变 Package 版本。 */
  packages?: readonly PluginPackage[];
  /** reconcile 调用前读取并冻结的当前 BatonSession 视图。 */
  snapshot?: () => ReconcileSnapshot;
  /** Current host selection used when harness() omits harnessTargetId. */
  selectedHarnessTargetId?: () => string;
  /** 按需加载已安装 Package；fresh 用于开发期 `/reload-plugins` 绕过模块缓存。 */
  loadPackage?(
    pluginId: string,
    version: string,
    options?: { fresh?: boolean; marketplace?: string },
  ): Promise<PluginPackage>;
  /**
   * Resolve an immutable entry without importing it into Baton. When supplied
   * with a PluginSupervisor, Marketplace Plugin code runs in a per-Binding
   * child process.
   */
  loadPackageEntry?(
    pluginId: string,
    version: string,
    options: { marketplace: string; fresh?: boolean },
  ): Promise<PluginPackageEntry>;
  pluginSupervisor?: PluginSupervisor;
  /** Proposal 已落盘；接收方按 proposalId 幂等投影即可。 */
  onProposal(proposal: Proposal): Promise<void> | void;
  /** Host-owned bridge that materializes the request's explicit Lane policy. */
  enqueueHarnessInvocation?(
    request: ScheduledHarnessInvocation,
  ): Promise<unknown> | void;
  /** Cancels a queued Request or interrupts its admitted Turn. */
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
  /** Baton-owned and Plugin-provided explicit context share one registry. */
  contextProviders?: ContextProviderRegistry;
  /** Controller reconcile 失败后的指数退避；默认从 1 秒增长到最多 1 分钟。 */
  retryBackoff?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
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
  watches: readonly Watch[];
  ownsResource(resource: ResourceRef): boolean;
  cronSources?(): readonly CronSource[];
  startSources?(
    onError: (sourceId: string, error: unknown) => void,
  ): Promise<void>;
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

type ActivatablePackage =
  | {
      readonly kind: "in-process";
      readonly plugin: PluginPackage;
    }
  | {
      readonly kind: "runner";
      readonly entry: PluginPackageEntry;
    };

interface ManagedBoardSource {
  readonly pluginInstanceId: string;
  present(): Promise<readonly BoardItemCandidate[]>;
}

function positiveDelay(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
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
  private readonly boardSources = new Map<string, ManagedBoardSource>();
  private boardItemsCache: readonly BoardItem[] | undefined;
  private boardRevision = 0;
  private boardRefresh?: Promise<void>;
  private readonly commandRegistry: PluginCommandRegistry;
  private readonly contextProviders: ContextProviderRegistry;
  private readonly instances: PluginInstanceRepository;
  private readonly packages = new Map<string, PluginPackage>();
  private readonly packageLoads = new Map<string, Promise<PluginPackage>>();
  private readonly packageEntries = new Map<string, PluginPackageEntry>();
  private readonly packageEntryLoads = new Map<
    string,
    Promise<PluginPackageEntry>
  >();
  private readonly loadPackage: ManagerOptions["loadPackage"];
  private readonly loadPackageEntry: ManagerOptions["loadPackageEntry"];
  private readonly pluginSupervisor?: PluginSupervisor;
  private readonly snapshot: () => ReconcileSnapshot;
  private readonly selectedHarnessTargetId?: () => string;
  private readonly interactions?: InteractionStore;
  private readonly harnessInvocations?: HarnessInvocationStore;
  private readonly enqueueHarnessInvocation?: ManagerOptions["enqueueHarnessInvocation"];
  private readonly cancelHostHarnessInvocation?: ManagerOptions["cancelHarnessInvocation"];
  private readonly dispatchedHarnessInvocations = new Set<string>();
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
  private readonly onRunnerFailure: ManagerOptions["onRunnerFailure"];
  private readonly onReconcileError: ManagerOptions["onReconcileError"];
  private readonly onControllerSourceError:
    ManagerOptions["onControllerSourceError"];
  private readonly log?: LogSink;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retries = new Map<string, RetryState>();
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
    this.log = options.session
      ? (entry) => options.session!.log(entry)
      : undefined;
    for (const plugin of options.packages ?? []) {
      validatePluginPackage(plugin);
      const key = pluginPackageKey(plugin.pluginId, plugin.version);
      if (this.packages.has(key)) {
        throw new Error(`plugin Package already registered: ${plugin.pluginId}@${plugin.version}`);
      }
      this.packages.set(key, plugin);
    }
    this.loadPackage = options.loadPackage;
    this.loadPackageEntry = options.loadPackageEntry;
    this.pluginSupervisor = options.pluginSupervisor;
    this.snapshot =
      options.snapshot ??
      (() => emptyReconcileSnapshot(options.proposals.batonSessionId));
    this.selectedHarnessTargetId = options.selectedHarnessTargetId;
    if (options.session) {
      this.interactions = new InteractionStore(options.session, {
        now: this.now,
        onTimeout: (key) => {
          void this.enqueue(key).catch(() => {
            // The durable result remains available to initial reconcile or retry.
          });
        },
      });
      this.harnessInvocations = new HarnessInvocationStore(options.session, {
        onChanged: (request, key) =>
          this.enqueueHarnessInvocationOwner(key, request.resource),
      });
    }
    this.enqueueHarnessInvocation = options.enqueueHarnessInvocation;
    this.cancelHostHarnessInvocation = options.cancelHarnessInvocation;
    this.onProposal = options.onProposal;
    this.onBoardChanged = options.onBoardChanged;
    this.onToast = options.onToast;
    this.onCommandsChanged = options.onCommandsChanged;
    this.contextProviders =
      options.contextProviders ?? new ContextProviderRegistry();
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
        this.notifyBoardChanged();
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
    validateSources(definition.sources, this.now());
    const controller = new Controller({
      ...definition,
      snapshot: (key, resource) => this.snapshotFor(key, resource),
      invokeVerb: (context, request) => this.invokeVerb(context, request),
      executeWithCapacity: (execute) => this.capacity.run(execute),
      onReconcileSuccess: (key, next) => {
        if (this.controllers.get(reconcileScopeId(key)) !== controller) return;
        this.retries.delete(reconcileKeyId(key));
        if (this.started) this.dueQueue.schedule(key, next);
      },
      onReconcileError: (key, error) => {
        this.retry(controller, key, error);
      },
      onSourceResource: () => this.notifyBoardChanged(),
      onResourceDeleted: (resource) => {
        this.handlePluginResourceChange(Object.freeze({
          kind: "deleted",
          resource,
        }));
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
    validateSources(definition.sources, this.now());
    const controller = new BuiltinController({
      ...definition,
      resources: this.batonResources,
      snapshot: (key, resource) => this.snapshotFor(key, resource),
      invokeVerb: (context, request) => this.invokeVerb(context, request),
      executeWithCapacity: (execute) => this.capacity.run(execute),
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
    const packageSource = await this.preparePackage(instance);
    const batonSession = this.snapshot().session;
    if (batonSession.batonSessionId !== this.proposals.batonSessionId) {
      throw new Error(
        `PluginActivationContext batonSessionId must be ${this.proposals.batonSessionId}, got ${batonSession.batonSessionId}`,
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
        registerContextProvider: (provider) =>
          this.contextProviders.registerContextProvider(
            provider,
            pluginName(instance.pluginId),
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
                invokeReconcileVerb: (context, request) => {
                  if (context.key.pluginInstanceId !== instance.pluginInstanceId) {
                    throw new Error(
                      `Plugin Runner reconcile scope must belong to ${instance.pluginInstanceId}`,
                    );
                  }
                  return this.invokeVerb(context, request);
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
            binding.onClose(() => runner.close());
            for (const registration of runner.activation.registrations) {
              this.installRunnerRegistration(
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

  async listContextCandidates(prefix: string): ReturnType<
    ContextProviderRegistry["candidates"]
  > {
    return await this.contextProviders.candidates(prefix);
  }

  hasContextReference(input: string): boolean {
    return this.contextProviders.hasReference(input);
  }

  provideContext(
    input: string,
    maxChars: number,
  ): Promise<readonly string[]> {
    return this.contextProviders.provide(input, maxChars);
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

    await this.preparePackage(
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
      const key = this.packageSourceKey(instance);
      if (loadedPackages.has(key)) continue;
      loadedPackages.add(key);
      try {
        await this.preparePackage(instance, true);
      } catch (error) {
        packageFailures.set(key, error);
      }
    }

    const activated: string[] = [];
    for (const instance of enabled) {
      if (failures.has(instance.pluginInstanceId)) continue;
      const error = packageFailures.get(
        this.packageSourceKey(instance),
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

  listHarnessInvocations() {
    return this.harnessInvocations?.list() ?? [];
  }

  listPendingHarnessInvocationInputs() {
    return this.harnessInvocations?.pendingDraftInputs() ?? [];
  }

  listBoardItems(): readonly BoardItem[] {
    return this.boardItemsCache ?? [];
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
   * 先持久化 Interaction result，再唤醒原 Resource。即使当前 Controller 暂不可用，
   * 后续激活或初始 reconcile 仍能从 Snapshot 恢复这份结果。
   */
  async completeInteraction(
    interactionId: string,
    result: InteractionResult,
  ): Promise<boolean> {
    const key = this.interactions?.complete(interactionId, result);
    if (!key) return false;
    try {
      await this.enqueue(key);
    } catch {
      // Result 已落 Event Ledger；重试、reload 或下次启动会重新 reconcile。
    }
    return true;
  }

  async cancelHarnessInvocation(identifier?: string): Promise<boolean> {
    const request = this.harnessInvocations?.latestCancellable(
      identifier?.trim() || undefined,
    );
    if (!request || !this.harnessInvocations) return false;

    if (this.harnessInvocations.isAdmitted(request.invocationId)) {
      return this.cancelHostHarnessInvocation?.(request.invocationId) === "running";
    }

    const key = this.harnessInvocations.cancelBeforeAdmission(
      request.invocationId,
      "user",
    );
    this.cancelHostHarnessInvocation?.(request.invocationId);
    return key !== undefined;
  }

  resolveHarnessInvocationInput(
    invocationId: string,
    outcome:
      | {
          readonly kind: "submitted";
          readonly blocks: readonly PromptBlock[];
        }
      | { readonly kind: "dismissed" },
  ): boolean {
    const resolved = this.harnessInvocations?.resolveDraftInput(invocationId, outcome);
    if (!resolved) return false;
    if (resolved.scheduled) this.dispatchHarnessInvocation(resolved.scheduled);
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

  private async invokeVerb(
    context: ReconcileVerbScope,
    request: ReconcileVerbRequest,
  ): Promise<ReconcileVerbResponse> {
    if (request.verb === "ask") {
      if (!this.interactions) {
        throw new Error("plugin Manager requires a SessionHandle for ask()");
      }
      return this.interactions.ask(context, request.input);
    }
    if (request.verb === "confirm") {
      if (!this.interactions) {
        throw new Error("plugin Manager requires a SessionHandle for confirm()");
      }
      return this.interactions.confirm(context, request.input);
    }
    if (request.verb === "withdraw") {
      if (!this.interactions) {
        throw new Error("plugin Manager requires a SessionHandle for withdraw()");
      }
      return this.interactions.withdraw(context, request.input);
    }
    if (!this.harnessInvocations || !this.enqueueHarnessInvocation) {
      throw new Error("plugin Manager host does not support harness()");
    }
    const operation = Object.freeze({
      verb: request.verb,
      key: request.input.key,
    });
    const existing = this.harnessInvocations.current(context, operation);
    const harnessTargetId = request.input.harnessTargetId ??
      existing?.harnessTargetId ?? this.selectedHarnessTargetId?.();
    if (!harnessTargetId) {
      throw new Error(
        `${request.verb}() ${request.input.key} requires a HarnessTarget selection`,
      );
    }
    if (
      !existing &&
      !this.snapshot().harnessTargets.some((target) => target.id === harnessTargetId)
    ) {
      throw new Error(
        `${request.verb}() ${request.input.key} references unknown HarnessTarget: ${harnessTargetId}`,
      );
    }
    const snapshot = this.harnessInvocations.record({
      ...context,
      invocation: {
        operation,
        title: request.input.key,
        prompt: request.input.prompt,
        laneId: request.verb === "draft" ? MAIN_LANE_ID : request.input.laneId,
        newLane: request.verb === "draft" ? false : (request.input.newLane ?? false),
        harnessTargetId,
      },
    });
    const scheduled = this.harnessInvocations.scheduled(snapshot.invocationId);
    if (scheduled) this.dispatchHarnessInvocation(scheduled);
    if (request.verb === "draft" && snapshot.phase === "awaiting_input") {
      return Object.freeze({ state: "editing" });
    }
    if (snapshot.phase === "completed" && snapshot.result && snapshot.laneId) {
      return Object.freeze({
        state: "completed",
        laneId: snapshot.laneId,
        turn: snapshot.result,
      });
    }
    if (snapshot.phase === "cancelled") {
      return request.verb === "draft"
        ? Object.freeze({ state: "dismissed" })
        : Object.freeze({ state: "cancelled" });
    }
    if (
      snapshot.phase !== "queued" &&
      snapshot.phase !== "running" &&
      snapshot.phase !== "uncertain"
    ) {
      throw new Error(
        `${request.verb}() ${request.input.key} entered unexpected phase: ${snapshot.phase}`,
      );
    }
    return Object.freeze({
      state: "pending",
      phase: snapshot.phase,
      ...(snapshot.laneId === undefined ? {} : { laneId: snapshot.laneId }),
      ...(snapshot.turnId === undefined ? {} : { turnId: snapshot.turnId }),
    });
  }

  private snapshotFor(key: ReconcileKey, resource: ResourceRef): ReconcileSnapshot {
    return this.snapshot();
  }

  private async restoreProposals(): Promise<void> {
    for (const proposal of this.proposals.listPending()) {
      await this.onProposal(proposal);
    }
  }

  private restoreHarnessInvocations(): void {
    for (const request of this.harnessInvocations?.restore() ?? []) {
      this.dispatchHarnessInvocation(request);
    }
  }

  private dispatchHarnessInvocation(request: ScheduledHarnessInvocation): void {
    if (
      !this.enqueueHarnessInvocation ||
      this.dispatchedHarnessInvocations.has(request.invocationId)
    ) {
      return;
    }
    this.dispatchedHarnessInvocations.add(request.invocationId);
    void Promise.resolve()
      .then(() => this.enqueueHarnessInvocation!(request))
      .catch((error) => {
        this.harnessInvocations?.cancelBeforeAdmission(
          request.invocationId,
          "recovery",
          error instanceof Error ? error.message : String(error),
        );
        this.log?.({
          level: "error",
          source: "baton",
          component: "plugin.harness-invocation",
          message: "HarnessInvocation dispatch failed",
          pluginInstanceId: request.pluginInstanceId,
          turnId: request.turnId,
          harnessTargetId: request.harnessTargetId,
          error: logError(error),
          attributes: { harnessInvocationId: request.invocationId },
        });
      });
  }

  private enqueueHarnessInvocationOwner(
    key: ReconcileKey,
    resource: ResourceRef,
  ): void {
    if (this.closed) return;
    const controller = this.controllers.get(reconcileScopeId(key));
    if (
      !controller ||
      !controller.ownsResource(resource) ||
      this.suspendedControllers.has(reconcileScopeId(key))
    ) {
      return;
    }
    void controller.enqueue(key).catch(() => {
      // Reconcile failures use the ordinary retry path.
    });
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
    this.restoreHarnessInvocations();
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

  private async preparePackage(
    instance: PluginInstance,
    fresh = false,
  ): Promise<ActivatablePackage> {
    if (
      this.pluginSupervisor &&
      this.loadPackageEntry &&
      instance.marketplace
    ) {
      return {
        kind: "runner",
        entry: await this.resolvePackageEntry(
          instance.pluginId,
          instance.packageVersion,
          instance.marketplace,
          fresh,
        ),
      };
    }
    return {
      kind: "in-process",
      plugin: await this.resolvePackage(
        instance.pluginId,
        instance.packageVersion,
        instance.marketplace,
        fresh,
      ),
    };
  }

  private async resolvePackageEntry(
    pluginId: string,
    version: string,
    marketplace: string,
    fresh = false,
  ): Promise<PluginPackageEntry> {
    if (!this.loadPackageEntry) {
      throw new Error(
        `plugin Package entry is unavailable: ${pluginId}@${marketplace} ${version}`,
      );
    }
    const key = JSON.stringify([pluginId, marketplace, version]);
    if (!fresh) {
      const cached = this.packageEntries.get(key);
      if (cached) return cached;
      const loading = this.packageEntryLoads.get(key);
      if (loading) return await loading;
    }
    const loading = Promise.resolve()
      .then(() =>
        this.loadPackageEntry!(
          pluginId,
          version,
          {
            marketplace,
            ...(fresh ? { fresh: true } : {}),
          },
        ),
      )
      .then((entry) => {
        if (entry.pluginId !== pluginId || entry.version !== version) {
          throw new Error(
            `resolved Package entry ${entry.pluginId}@${entry.version} does not match ${pluginId}@${version}`,
          );
        }
        this.packageEntries.set(key, entry);
        return entry;
      })
      .finally(() => {
        if (this.packageEntryLoads.get(key) === loading) {
          this.packageEntryLoads.delete(key);
        }
      });
    this.packageEntryLoads.set(key, loading);
    return await loading;
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

  private packageSourceKey(instance: PluginInstance): string {
    return instance.marketplace
      ? JSON.stringify([instance.pluginId, instance.marketplace, instance.packageVersion])
      : pluginPackageKey(instance.pluginId, instance.packageVersion);
  }

  private installRunnerRegistration(
    binding: PluginBinding,
    runner: PluginRunnerClient,
    registration: RunnerRegistration,
  ): void {
    if (registration.kind === "command") {
      this.installRunnerCommand(binding, runner, registration);
      return;
    }
    if (registration.kind === "context-provider") {
      this.installRunnerContextProvider(binding, runner, registration);
      return;
    }
    this.installRunnerController(binding, runner, registration);
  }

  private installRunnerCommand(
    binding: PluginBinding,
    runner: PluginRunnerClient,
    registration: RunnerCommandRegistration,
  ): void {
    binding.registerCommand({
      commandId: registration.commandId,
      name: registration.name,
      description: registration.description,
      execute: async (input) =>
        await runner.invoke<PluginCommandResult | undefined>(
          registration.handlerId,
          input,
        ),
    });
  }

  private installRunnerContextProvider(
    binding: PluginBinding,
    runner: PluginRunnerClient,
    registration: RunnerContextProviderRegistration,
  ): void {
    binding.registerContextProvider({
      kind: registration.providerKind,
      search: async (query) =>
        await runner.invoke(
          registration.searchHandlerId,
          query,
        ),
      provide: async (id, options) =>
        await runner.invoke<string | undefined>(
          registration.provideHandlerId,
          id,
          options,
        ),
    });
  }

  private installRunnerController(
    binding: PluginBinding,
    runner: PluginRunnerClient,
    registration: RunnerControllerRegistration,
  ): void {
    const sources = registration.sources.map((source) =>
      source.type === "cron"
        ? {
            type: "cron" as const,
            sourceId: source.sourceId,
            cron: source.cron,
            timeZone: source.timeZone,
          }
        : {
            type: "resource" as const,
            sourceId: source.sourceId,
            start: async (context: SourceContext<unknown>) =>
              await runner.startSource(
                source.startHandlerId,
                context,
              ),
          }
    );
    const watches: Watch[] = registration.watches.map((watch) => ({
      resourceType: watch.resourceType,
      handler: {
        create: async (event) =>
          await runner.invoke(watch.createHandlerId, event),
        update: async (event) =>
          await runner.invoke(watch.updateHandlerId, event),
        delete: async (event) =>
          await runner.invoke(watch.deleteHandlerId, event),
      },
    }));
    binding.registerController({
      resourceType: registration.resourceType,
      sources,
      watches,
      ...(registration.maxConcurrency === undefined
        ? {}
        : { maxConcurrency: registration.maxConcurrency }),
      reconcile: async (context, resource) =>
        await runner.invoke(
          registration.reconcileHandlerId,
          reconcileSnapshot(context),
          reconcileScope(context),
          resource,
        ),
      ...(registration.presentHandlerId === undefined
        ? {}
        : {
            present: async (resource) =>
              await runner.invoke(
                registration.presentHandlerId!,
                resource,
              ),
          }),
    });
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
      batonSessionId: this.proposals.batonSessionId,
      pluginInstanceId,
      resourceApiVersion: pluginController.resourceType.apiVersion,
      resourceKind: pluginController.resourceType.kind,
    });
    if (pluginController.present) {
      const pluginId = this.instances.get(pluginInstanceId).pluginId;
      const present = pluginController.present;
      this.boardSources.set(sourceId, {
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
      batonSessionId: this.proposals.batonSessionId,
      pluginInstanceId,
      resourceApiVersion: BATON_TURN_RESOURCE_TYPE.apiVersion,
      resourceKind,
      resourceOwner: "baton",
    });
    if (pluginController.present) {
      const pluginId = this.instances.get(pluginInstanceId).pluginId;
      const present = pluginController.present;
      this.boardSources.set(sourceId, {
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
      this.boardSources.delete(sourceId);
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
    this.suspendedControllers.clear();
    this.dueQueue.close();
    this.cronSourceQueue.close();
    this.unsubscribeBatonResources?.();
    this.batonResources?.close();
    this.interactions?.close();
    this.harnessInvocations?.close();
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

  private notifyBoardChanged(): void {
    if (this.closed) return;
    this.boardRevision += 1;
    this.refreshBoardItems();
  }

  private refreshBoardItems(): void {
    if (this.closed || this.boardRefresh) return;
    const revision = this.boardRevision;
    const sources = [...this.boardSources.values()].filter((source) =>
      this.bindings.has(source.pluginInstanceId)
    );
    const refresh = Promise.all(
      sources.map((source) => source.present()),
    )
      .then((groups) => {
        if (this.closed || revision !== this.boardRevision) return;
        this.boardItemsCache = selectBoardItems(groups.flat());
        try {
          this.onBoardChanged?.();
        } catch {
          // Projection invalidation cannot affect Plugin state.
        }
      })
      .catch((error) => {
        this.log?.({
          level: "error",
          source: "baton",
          component: "plugin.board",
          message: "Could not refresh Plugin Board projection",
          error: logError(error),
        });
      })
      .finally(() => {
        if (this.boardRefresh === refresh) this.boardRefresh = undefined;
        if (!this.closed && revision !== this.boardRevision) {
          this.refreshBoardItems();
        }
      });
    this.boardRefresh = refresh;
  }

  private handlePluginResourceChange(change: ResourceClientChange): void {
    if (change.kind === "deleted") {
      const resource = change.resource;
      const ref: ResourceRef = {
        apiVersion: resource.apiVersion,
        kind: resource.kind,
        namespace: resource.metadata.namespace,
        name: resource.metadata.name,
        uid: resource.metadata.uid,
      };
      this.interactions?.cancelForResource(ref);
      if (this.harnessInvocations) {
        for (const requestId of this.harnessInvocations.cancelForResource(ref)) {
          this.cancelHostHarnessInvocation?.(requestId);
        }
      }
    }
    this.notifyBoardChanged();
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
    if (change.kind !== "deleted") {
      const key = Object.freeze({
        batonSessionId: this.proposals.batonSessionId,
        pluginInstanceId: change.resource.metadata.namespace,
        resourceApiVersion: change.resource.apiVersion,
        resourceKind: change.resource.kind,
        resourceId: change.resource.metadata.name,
      });
      const scopeId = reconcileScopeId(key);
      const controller = this.controllers.get(scopeId);
      if (controller && !this.suspendedControllers.has(scopeId)) {
        pending.set(reconcileKeyId(key), { controller, key });
      }
    }

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
        requests = await watchRequests(controller.watches, change);
      } catch (error) {
        this.log?.({
          level: "error",
          source: "baton",
          component: "plugin.watch",
          message: "Plugin Controller EventHandler failed",
          pluginInstanceId: controller.scope.pluginInstanceId,
          error: logError(error),
          attributes: {
            primaryResource:
              `${controller.scope.resourceApiVersion}/${controller.scope.resourceKind}`,
            watchedResource: `${change.resource.apiVersion}/${change.resource.kind}`,
          },
        });
        continue;
      }
      for (const request of requests) {
        const key = Object.freeze({
          ...controller.scope,
          resourceId: request.name,
        });
        pending.set(reconcileKeyId(key), { controller, key });
      }
    }

    for (const { controller, key } of pending.values()) {
      void controller.enqueue(key).catch(() => {
        // Reconcile failures use the Controller retry path; close races need no extra reaction.
      });
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
