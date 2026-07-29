import type {
  BoardPresentation,
  BoardItemTone,
  Command,
  ContextProvider,
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
  PluginActivationContext,
  PluginDataDirectories,
  PluginLogEntry,
  PluginLogger,
  PluginPackage,
  PluginSessionContext,
  Resource,
  ReconcileRequest,
  Source,
  SourceContext,
  SourceSignal,
  ResourceType,
  ToastMessage,
  ToastSink,
  ToastTone,
  UpdateEvent,
  Watch,
} from "@compforge/baton-plugin";
import type { PluginInstance } from "./instance.ts";
import type { ResourceClient } from "./resource-client.ts";
import { validateResourceType } from "./resource.ts";

export type {
  BoardPresentation,
  BoardItemTone,
  Command,
  ContextProvider,
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
  PluginActivationContext,
  PluginDataDirectories,
  PluginLogEntry,
  PluginLogger,
  PluginPackage,
  PluginSessionContext,
  Resource,
  ReconcileRequest,
  Source,
  SourceContext,
  SourceSignal,
  ResourceType,
  ToastMessage,
  ToastSink,
  ToastTone,
  UpdateEvent,
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
    if (!unique.has(request.name)) unique.set(request.name, request);
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

type ContextProviderRegistrar = (
  provider: ContextProvider,
) => () => void;

interface PluginRegistrars {
  registerCommand: CommandRegistrar;
  registerContextProvider: ContextProviderRegistrar;
  registerController: ResourceRegistrar;
  showToast(message: ToastMessage): void;
  writeLog(entry: PluginLogEntry): void;
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
export class PluginBinding implements PluginActivationContext {
  readonly instance: PluginInstance;
  readonly session: PluginSessionContext;
  readonly dataDirs: PluginDataDirectories;
  readonly resources: ResourceClient;
  readonly toast: ToastSink;
  readonly logger: PluginLogger;
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
    this.logger = Object.freeze({
      write: (entry: PluginLogEntry) => {
        if (this.closed) throw new Error("plugin Binding is closed");
        this.registrars.writeLog(entry);
      },
    });
  }

  registerController<TSpec, TStatus>(
    controller: Controller<TSpec, TStatus>,
  ): void {
    this.assertRegistering();
    validateResourceType(controller.resourceType);
    const close = this.registrars.registerController(controller);
    this.cleanups.push(close);
  }

  registerCommand(command: Command): void {
    this.assertRegistering();
    const close = this.registrars.registerCommand(command);
    this.cleanups.push(close);
  }

  registerContextProvider(provider: ContextProvider): void {
    this.assertRegistering();
    const close = this.registrars.registerContextProvider(provider);
    this.cleanups.push(close);
  }

  onClose(cleanup: () => Promise<void> | void): void {
    this.assertRegistering();
    if (typeof cleanup !== "function") throw new Error("plugin cleanup must be a function");
    this.cleanups.push(cleanup);
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
