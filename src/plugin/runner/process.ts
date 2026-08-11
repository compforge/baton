import type {
  Command,
  ContextProvider,
  Controller,
  EventHandler,
  PluginActivationContext,
  PluginDataDirectories,
  PluginInstance,
  PluginLogContext,
  PluginLogLevel,
  PluginPackage,
  PluginSessionContext,
  Resource,
  ResourceClient,
  ResourceListOptions,
  ResourceOwnerReference,
  ResourceType,
  Source,
  SourceContext,
  ToastMessage,
  Watch,
} from "@compforge/baton-plugin";
import type { PluginLogRecord } from "../package.ts";
import {
  createBaton,
  type BatonVerbResponse,
} from "../verbs.ts";

import {
  type ActivationResult,
  type ChildCall,
  type ChildMessage,
  type ChildReply,
  type ControllerRegistration,
  type HostRequest,
  type ParentMessage,
  type ParentReply,
  type PluginPackageEntry,
  type PluginRegistration,
  type RunnerRequest,
  restoredError,
  serializedError,
} from "./protocol.ts";

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

const handlers = new Map<string, (...args: never[]) => unknown>();
const sourceSignals = new Map<string, AbortController>();
const cleanups: Array<() => Promise<void> | void> = [];
const pendingHostCalls = new Map<number, PendingCall>();
let nextHandlerId = 1;
let nextHostCallId = 1;
let active = false;
let closing = false;

function send(message: ChildMessage): void {
  if (!process.send) throw new Error("Plugin Runner IPC is unavailable");
  process.send(message);
}

function handler(
  scope: string,
  callback: (...args: never[]) => unknown,
): string {
  const handlerId = `${scope}:${nextHandlerId++}`;
  handlers.set(handlerId, callback);
  return handlerId;
}

function callHost<T>(request: HostRequest): Promise<T> {
  if (closing) {
    return Promise.reject(new Error("Plugin Runner is closing"));
  }
  const callId = nextHostCallId++;
  return new Promise<unknown>((resolve, reject) => {
    pendingHostCalls.set(callId, { resolve, reject });
    try {
      send({
        kind: "child-call",
        callId,
        request,
      } satisfies ChildCall);
    } catch (error) {
      pendingHostCalls.delete(callId);
      reject(error);
    }
  }) as Promise<T>;
}

const resources: ResourceClient = Object.freeze({
  async get<TSpec, TStatus>(type: ResourceType, name: string) {
    return await callHost<Readonly<Resource<TSpec, TStatus>>>({
      method: "resource.get",
      type,
      name,
    });
  },
  async list<TSpec, TStatus>(
    type: ResourceType,
    options?: ResourceListOptions,
  ) {
    return await callHost<readonly Readonly<Resource<TSpec, TStatus>>[]>({
      method: "resource.list",
      type,
      options,
    });
  },
  async create<TSpec, TStatus>(
    type: ResourceType,
    init: {
      name: string;
      labels?: Readonly<Record<string, string>>;
      annotations?: Readonly<Record<string, string>>;
      owner?: ResourceOwnerReference;
      spec: TSpec;
    },
  ) {
    return await callHost<Readonly<Resource<TSpec, TStatus>>>({
      method: "resource.create",
      type,
      init,
    });
  },
  async delete(type: ResourceType, name: string) {
    await callHost<void>({
      method: "resource.delete",
      type,
      name,
    });
  },
  async patchMetadata<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: {
      readonly labels?: Readonly<Record<string, string | null>>;
      readonly annotations?: Readonly<Record<string, string | null>>;
    },
  ) {
    return await callHost<Readonly<Resource<TSpec, TStatus>>>({
      method: "resource.patchMetadata",
      resource: resource as Readonly<Resource<unknown, unknown>>,
      patch,
    });
  },
  async patchStatus<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: Partial<TStatus>,
  ) {
    return await callHost<Readonly<Resource<TSpec, TStatus>>>({
      method: "resource.patchStatus",
      resource: resource as Readonly<Resource<unknown, unknown>>,
      patch: patch as Readonly<Record<string, unknown>>,
    });
  },
});

function commandRegistration(command: Command): PluginRegistration {
  return {
    kind: "command",
    handlerId: handler(
      `command:${command.commandId}`,
      command.execute.bind(command) as (...args: never[]) => unknown,
    ),
    commandId: command.commandId,
    name: command.name,
    description: command.description,
  };
}

function contextRegistration(provider: ContextProvider): PluginRegistration {
  return {
    kind: "context-provider",
    providerKind: provider.kind,
    searchHandlerId: handler(
      `context:${provider.kind}:search`,
      provider.search.bind(provider) as (...args: never[]) => unknown,
    ),
    provideHandlerId: handler(
      `context:${provider.kind}:provide`,
      provider.provide.bind(provider) as (...args: never[]) => unknown,
    ),
  };
}

function watchRegistration(
  controllerId: string,
  watch: Watch,
  index: number,
): ControllerRegistration["watches"][number] {
  const prefix = `${controllerId}:watch:${index}`;
  return {
    resourceType: watch.resourceType,
    createHandlerId: handler(
      `${prefix}:create`,
      watch.handler.create.bind(watch.handler) as (...args: never[]) => unknown,
    ),
    updateHandlerId: handler(
      `${prefix}:update`,
      watch.handler.update.bind(watch.handler) as (...args: never[]) => unknown,
    ),
    deleteHandlerId: handler(
      `${prefix}:delete`,
      watch.handler.delete.bind(watch.handler) as (...args: never[]) => unknown,
    ),
  };
}

function controllerRegistration(
  controller: Controller<unknown, unknown>,
): PluginRegistration {
  const controllerId =
    `controller:${controller.resourceType.apiVersion}:${controller.resourceType.kind}`;
  return {
    kind: "controller",
    controllerId,
    resourceType: controller.resourceType,
    reconcileHandlerId: handler(
      `${controllerId}:reconcile`,
      (async (snapshot, context, resource) =>
        await controller.reconcile(
          createBaton(
            snapshot,
            context,
            async (verbContext, request) =>
              await callHost<BatonVerbResponse>({
                method: "baton.invoke",
                context: verbContext,
                request,
              }),
          ),
          resource,
        )) as (...args: never[]) => unknown,
    ),
    ...(controller.present === undefined
      ? {}
      : {
          presentHandlerId: handler(
            `${controllerId}:present`,
            controller.present.bind(controller) as (...args: never[]) => unknown,
          ),
        }),
    ...(controller.maxConcurrency === undefined
      ? {}
      : { maxConcurrency: controller.maxConcurrency }),
    sources: Object.freeze(
      (controller.sources ?? []).map((source) =>
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
              startHandlerId: handler(
                `${controllerId}:source:${source.sourceId}`,
                source.start.bind(source) as (...args: never[]) => unknown,
              ),
            }
      ),
    ),
    watches: Object.freeze(
      (controller.watches ?? []).map((watch, index) =>
        watchRegistration(controllerId, watch, index)
      ),
    ),
  };
}

async function activate(
  entry: PluginPackageEntry,
  instance: PluginInstance,
  session: PluginSessionContext,
  dataDirs: PluginDataDirectories,
): Promise<ActivationResult> {
  if (active) throw new Error("Plugin Runner already has an active Binding");
  if (closing) throw new Error("Plugin Runner is closing");
  const module = await import(entry.entryUrl) as { default?: unknown };
  const plugin = module.default as PluginPackage | undefined;
  if (!plugin || typeof plugin.activate !== "function") {
    throw new Error(`Plugin entry must default export a PluginPackage: ${entry.entryUrl}`);
  }
  if (plugin.pluginId !== entry.pluginId || plugin.version !== entry.version) {
    throw new Error(
      `loaded Package identity ${plugin.pluginId}@${plugin.version} does not match ${entry.pluginId}@${entry.version}`,
    );
  }

  const registrations: PluginRegistration[] = [];
  let sealed = false;
  const assertRegistering = (): void => {
    if (sealed) throw new Error("Plugin Binding activation is complete");
  };
  const context: PluginActivationContext = Object.freeze({
    instance,
    session,
    dataDirs: Object.freeze({ ...dataDirs }),
    resources,
    toast: Object.freeze({
      show(message: ToastMessage) {
        send({ kind: "toast", message });
      },
    }),
    logger: pluginLogger(),
    registerCommand(command: Command) {
      assertRegistering();
      registrations.push(commandRegistration(command));
    },
    registerContextProvider(provider: ContextProvider) {
      assertRegistering();
      registrations.push(contextRegistration(provider));
    },
    registerController<TSpec, TStatus>(
      controller: Controller<TSpec, TStatus>,
    ) {
      assertRegistering();
      registrations.push(
        controllerRegistration(
          controller as Controller<unknown, unknown>,
        ),
      );
    },
    onClose(cleanup: () => Promise<void> | void) {
      assertRegistering();
      cleanups.push(cleanup);
    },
  });
  try {
    await plugin.activate(context);
    sealed = true;
    active = true;
    return {
      registrations: Object.freeze(registrations),
    };
  } catch (error) {
    sealed = true;
    await closeBinding();
    throw error;
  }
}

function pluginLogger(): PluginActivationContext["logger"] {
  const write = (
    level: PluginLogLevel,
    message: string,
    context?: PluginLogContext,
  ): void => {
    try {
      const record: PluginLogRecord = {
        level,
        message,
        ...(context ? { context } : {}),
      };
      send({ kind: "log", record });
    } catch {
      // Logging is best-effort and must not change Plugin behavior.
    }
  };
  return Object.freeze({
    debug: (message: string, context?: PluginLogContext) =>
      write("debug", message, context),
    info: (message: string, context?: PluginLogContext) =>
      write("info", message, context),
    warn: (message: string, context?: PluginLogContext) =>
      write("warn", message, context),
    error: (message: string, context?: PluginLogContext) =>
      write("error", message, context),
  });
}

async function startSource(
  handlerId: string,
  sourceRunId: string,
): Promise<void> {
  const callback = handlers.get(handlerId) as Source<unknown>["start"] | undefined;
  if (!callback) throw new Error(`Unknown Plugin handler: ${handlerId}`);
  if (sourceSignals.has(sourceRunId)) {
    throw new Error(`Plugin Source is already running: ${sourceRunId}`);
  }
  const abort = new AbortController();
  sourceSignals.set(sourceRunId, abort);
  const context: SourceContext<unknown> = Object.freeze({
    signal: abort.signal,
    async emit(
      resource: Parameters<SourceContext<unknown>["emit"]>[0],
    ) {
      if (abort.signal.aborted) return;
      await callHost<void>({
        method: "source.emit",
        sourceRunId,
        resource,
      });
    },
    reportError(error: unknown) {
      if (abort.signal.aborted) return;
      send({
        kind: "source-error",
        sourceRunId,
        error: serializedError(error),
      });
    },
  });
  try {
    await callback(context);
  } catch (error) {
    sourceSignals.delete(sourceRunId);
    abort.abort();
    throw error;
  }
}

function stopSource(sourceRunId: string): void {
  const abort = sourceSignals.get(sourceRunId);
  sourceSignals.delete(sourceRunId);
  abort?.abort();
}

async function closeBinding(): Promise<void> {
  if (closing) return;
  closing = true;
  for (const abort of sourceSignals.values()) abort.abort();
  sourceSignals.clear();
  const errors: unknown[] = [];
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  cleanups.length = 0;
  handlers.clear();
  for (const pending of pendingHostCalls.values()) {
    pending.reject(new Error("Plugin Runner is closing"));
  }
  pendingHostCalls.clear();
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Could not close Plugin Runner");
  }
}

async function dispatch(request: RunnerRequest): Promise<unknown> {
  switch (request.method) {
    case "activate":
      return await activate(
        request.entry,
        request.instance,
        request.session,
        request.dataDirs,
      );
    case "invoke": {
      const callback = handlers.get(request.handlerId);
      if (!callback) throw new Error(`Unknown Plugin handler: ${request.handlerId}`);
      return await callback(...request.args as never[]);
    }
    case "start-source":
      await startSource(request.handlerId, request.sourceRunId);
      return undefined;
    case "stop-source":
      stopSource(request.sourceRunId);
      return undefined;
    case "close":
      await closeBinding();
      return undefined;
  }
}

function handleParentReply(reply: ParentReply): void {
  const pending = pendingHostCalls.get(reply.callId);
  if (!pending) return;
  pendingHostCalls.delete(reply.callId);
  if (reply.ok) pending.resolve(reply.value);
  else pending.reject(restoredError(reply.error));
}

process.on("message", (message: ParentMessage) => {
  if (message.kind === "parent-reply") {
    handleParentReply(message);
    return;
  }
  void dispatch(message.request).then(
    (value) => {
      send({
        kind: "child-reply",
        callId: message.callId,
        ok: true,
        value,
      } satisfies ChildReply);
      if (message.request.method === "close") {
        process.disconnect?.();
      }
    },
    (error) => {
      send({
        kind: "child-reply",
        callId: message.callId,
        ok: false,
        error: serializedError(error),
      } satisfies ChildReply);
    },
  );
});

process.on("disconnect", () => {
  void closeBinding().finally(() => process.exit(0));
});
