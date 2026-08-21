import type {
  BoardPresentation,
  BoardItemTone,
  Command,
  DeferredHookStage,
  Hook,
  HookStage,
  HookSubjectMap,
  InlineHookStage,
  Mention,
  Controller,
  ControllerSource,
  CronSource,
  CreateEvent,
  DeleteEvent,
  EventHandler,
  EventResource,
  MapFunc,
  PluginCommandInput,
  PluginCommandPickerSearch,
  PluginCommandResult,
  PluginContext,
  PluginDataDirectories,
  PluginLogContext,
  PluginLogger,
  PluginLogLevel,
  PluginPackage,
  PluginSessionContext,
  Resource,
  ReconcileRequest,
  ResourceRef,
  Source,
  SourceContext,
  SourceSignal,
  ResourceType,
  ToastMessage,
  ToastSink,
  ToastTone,
  UpdateEvent,
  ViewInput,
  ViewInputRecord,
  ViewOutput,
  Watch,
} from "@compforge/baton-plugin";
import type { PluginInstance } from "./instance.ts";
import type { ResourceClient } from "./resource-client.ts";
import { validateResourceType } from "./resource.ts";

export type {
  BoardPresentation,
  BoardItemTone,
  Command,
  DeferredHookStage,
  Hook,
  HookStage,
  HookSubjectMap,
  InlineHookStage,
  Mention,
  Controller,
  ControllerSource,
  CronSource,
  CreateEvent,
  DeleteEvent,
  EventHandler,
  EventResource,
  MapFunc,
  PluginCommandInput,
  PluginCommandPickerSearch,
  PluginCommandResult,
  PluginContext,
  PluginDataDirectories,
  PluginLogContext,
  PluginLogger,
  PluginLogLevel,
  PluginPackage,
  PluginSessionContext,
  Resource,
  ReconcileRequest,
  ResourceRef,
  Source,
  SourceContext,
  SourceSignal,
  ResourceType,
  ToastMessage,
  ToastSink,
  ToastTone,
  UpdateEvent,
  ViewInput,
  ViewInputRecord,
  ViewOutput,
  Watch,
} from "@compforge/baton-plugin";

export const BATON_SYSTEM_NAMESPACE = "baton-system" as const;
export const BATON_TURN_RESOURCE_TYPE = Object.freeze({
  apiVersion: "baton.dev/v1alpha1",
  kind: "Turn",
} as const satisfies ResourceType);

function uniqueRequests(
  requests: readonly ReconcileRequest[],
): readonly ReconcileRequest[] {
  const unique = new Map<string, ReconcileRequest>();
  for (const request of requests) {
    const key = JSON.stringify([request.namespace, request.name]);
    if (!unique.has(key)) unique.set(key, request);
  }
  return Object.freeze([...unique.values()]);
}

function typedResource<TSpec, TStatus>(
  resource: EventResource,
): Readonly<Resource<TSpec, TStatus>> {
  return resource as Readonly<Resource<TSpec, TStatus>>;
}

/** Internal convenience adapter; the public authoring package stays type-only. */
export function enqueueRequestsFromMapFunc<
  TSpec = unknown,
  TStatus = unknown,
>(
  map: MapFunc<TSpec, TStatus>,
): EventHandler {
  return Object.freeze({
    async create(event: CreateEvent) {
      return uniqueRequests(
        await map(typedResource<TSpec, TStatus>(event.object)),
      );
    },
    async update(event: UpdateEvent) {
      return uniqueRequests([
        ...await map(typedResource<TSpec, TStatus>(event.oldObject)),
        ...await map(typedResource<TSpec, TStatus>(event.newObject)),
      ]);
    },
    async delete(event: DeleteEvent) {
      return uniqueRequests(
        await map(typedResource<TSpec, TStatus>(event.object)),
      );
    },
  });
}

type ResourceRegistrar = <TSpec, TStatus>(
  controller: Controller<TSpec, TStatus>,
) => () => void;

type CommandRegistrar = (
  command: Command,
) => () => void;

type MentionRegistrar = (
  mention: Mention,
) => () => void;

type HookRegistrar = (
  hook: Hook,
) => () => void;

interface PluginRegistrars {
  registerCommand: CommandRegistrar;
  registerMention: MentionRegistrar;
  registerHook: HookRegistrar;
  registerController: ResourceRegistrar;
  showToast(message: ToastMessage): void;
  writeLog(record: PluginLogRecord): void;
}

export interface PluginLogRecord {
  readonly level: PluginLogLevel;
  readonly message: string;
  readonly context?: PluginLogContext;
}

function nonEmpty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

export function pluginPackageKey(pluginId: string, version: string): string {
  return JSON.stringify([pluginId, version]);
}

export function validatePluginPackage(plugin: PluginPackage): void {
  nonEmpty("pluginId", plugin.pluginId);
  nonEmpty("plugin version", plugin.version);
  if (typeof plugin.activate !== "function") {
    throw new Error(`plugin Package ${plugin.pluginId}@${plugin.version} must provide activate()`);
  }
}

/**
 * PluginInstance 在当前进程中的一次临时绑定。所有注册按逆序关闭，支持激活失败整体回滚。
 */
export class PluginBinding implements PluginContext {
  readonly instance: PluginInstance;
  readonly session: PluginSessionContext;
  readonly dataDirs: PluginDataDirectories;
  readonly resources: ResourceClient;
  readonly toast: ToastSink;
  readonly logger: PluginLogger;
  readonly commands: PluginContext["commands"];
  readonly mentions: PluginContext["mentions"];
  readonly controllers: PluginContext["controllers"];
  readonly hooks: PluginContext["hooks"];
  readonly lifecycle: PluginContext["lifecycle"];
  private readonly registrars: PluginRegistrars;
  private readonly cleanups: Array<() => Promise<void> | void> = [];
  private sealed = false;
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    instance: PluginInstance,
    session: PluginSessionContext,
    dataDirs: PluginDataDirectories,
    registrars: PluginRegistrars,
    resources: ResourceClient,
  ) {
    this.instance = instance;
    this.session = Object.freeze({ ...session });
    this.dataDirs = Object.freeze({ ...dataDirs });
    this.registrars = registrars;
    this.resources = resources;
    this.toast = Object.freeze({
      show: (message: ToastMessage) => {
        if (this.closed) throw new Error("plugin Binding is closed");
        this.registrars.showToast(message);
      },
    });
    const write = (
      level: PluginLogLevel,
      message: string,
      context?: PluginLogContext,
    ): void => {
      if (this.closed) throw new Error("plugin Binding is closed");
      this.registrars.writeLog({
        level,
        message,
        ...(context ? { context } : {}),
      });
    };
    this.logger = Object.freeze({
      debug: (message: string, context?: PluginLogContext) =>
        write("debug", message, context),
      info: (message: string, context?: PluginLogContext) =>
        write("info", message, context),
      warn: (message: string, context?: PluginLogContext) =>
        write("warn", message, context),
      error: (message: string, context?: PluginLogContext) =>
        write("error", message, context),
    });
    this.commands = Object.freeze({
      register: (command: Command) => this.registerCommand(command),
    });
    this.mentions = Object.freeze({
      register: (mention: Mention) => this.registerMention(mention),
    });
    this.controllers = Object.freeze({
      register: <TSpec, TStatus>(controller: Controller<TSpec, TStatus>) =>
        this.registerController(controller),
    });
    this.hooks = Object.freeze({
      register: (hook: Hook) => this.registerHook(hook),
    });
    this.lifecycle = Object.freeze({
      onClose: (cleanup: () => Promise<void> | void) =>
        this.registerCleanup(cleanup),
    });
  }

  completeActivation(): void {
    if (this.closed) throw new Error("plugin Binding is closed");
    this.sealed = true;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.sealed = true;
    const closing = this.closeAll();
    this.closing = closing;
    return closing;
  }

  private assertRegistering(): void {
    if (this.closed) throw new Error("plugin Binding is closed");
    if (this.sealed) throw new Error("plugin Binding activation is complete");
  }

  private registerController<TSpec, TStatus>(controller: Controller<TSpec, TStatus>): void {
    this.assertRegistering();
    validateResourceType(controller.resourceType);
    this.cleanups.push(this.registrars.registerController(controller));
  }

  private registerCommand(command: Command): void {
    this.assertRegistering();
    this.cleanups.push(this.registrars.registerCommand(command));
  }

  private registerMention(mention: Mention): void {
    this.assertRegistering();
    this.cleanups.push(this.registrars.registerMention(mention));
  }

  private registerHook(hook: Hook): void {
    this.assertRegistering();
    this.cleanups.push(this.registrars.registerHook(hook));
  }

  private registerCleanup(cleanup: () => Promise<void> | void): void {
    this.assertRegistering();
    if (typeof cleanup !== "function") throw new Error("plugin cleanup must be a function");
    this.cleanups.push(cleanup);
  }

  private async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const cleanup of this.cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    this.cleanups.length = 0;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "could not close plugin Binding");
  }
}
