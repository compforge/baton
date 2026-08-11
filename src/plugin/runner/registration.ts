import {
  PluginBinding,
  type PluginCommandResult,
  type SourceContext,
  type Watch,
} from "../package.ts";
import {
  reconcileScope,
  reconcileSnapshot,
} from "../verb.ts";
import type { PluginRunnerClient } from "./client.ts";
import type {
  CommandRegistration,
  ContextProviderRegistration,
  ControllerRegistration,
  PluginRegistration,
} from "./protocol.ts";

/** Installs one Runner protocol registration into its Plugin Binding. */
export function installRegistration(
  binding: PluginBinding,
  runner: PluginRunnerClient,
  registration: PluginRegistration,
): void {
  if (registration.kind === "command") {
    installCommand(binding, runner, registration);
    return;
  }
  if (registration.kind === "context-provider") {
    installContextProvider(binding, runner, registration);
    return;
  }
  installController(binding, runner, registration);
}

function installCommand(
  binding: PluginBinding,
  runner: PluginRunnerClient,
  registration: CommandRegistration,
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

function installContextProvider(
  binding: PluginBinding,
  runner: PluginRunnerClient,
  registration: ContextProviderRegistration,
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

function installController(
  binding: PluginBinding,
  runner: PluginRunnerClient,
  registration: ControllerRegistration,
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
