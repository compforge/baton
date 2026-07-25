import type {
  BuiltinResourceContribution,
  BuiltinResourceKind,
  BoardItemDraft,
  BoardItemTone,
  BoardProjector,
  PluginActivationContext,
  PluginPackage,
  PluginSessionContext,
  ResourceContribution,
} from "@qiankun01/baton-plugin";
import type { PluginInstance } from "./instance.ts";
import type { PluginResourceClient } from "./resource-client.ts";

export type {
  BoardItemDraft,
  BoardItemTone,
  BoardProjector,
  BuiltinResourceContribution,
  PluginActivationContext,
  PluginPackage,
  PluginSessionContext,
  ResourceContribution,
} from "@qiankun01/baton-plugin";

type ResourceRegistrar = <TSpec, TStatus>(
  contribution: ResourceContribution<TSpec, TStatus>,
) => () => void;

type BuiltinResourceRegistrar = <K extends BuiltinResourceKind>(
  contribution: BuiltinResourceContribution<K>,
) => () => void;

interface PluginRegistrars {
  registerResource: ResourceRegistrar;
  watchBuiltinResource: BuiltinResourceRegistrar;
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
  readonly resources: PluginResourceClient;
  private readonly registrars: PluginRegistrars;
  private readonly cleanups: Array<() => Promise<void> | void> = [];
  private sealed = false;
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    instance: PluginInstance,
    session: PluginSessionContext,
    registrars: PluginRegistrars,
    resources: PluginResourceClient,
  ) {
    this.instance = instance;
    this.session = Object.freeze({ ...session });
    this.registrars = registrars;
    this.resources = resources;
  }

  registerResource<TSpec, TStatus>(
    contribution: ResourceContribution<TSpec, TStatus>,
  ): void {
    this.assertRegistering();
    if (!contribution.resourceKind.trim()) {
      throw new Error("resourceKind must not be empty");
    }
    const close = this.registrars.registerResource(contribution);
    this.cleanups.push(close);
  }

  watchBuiltinResource<K extends BuiltinResourceKind>(
    contribution: BuiltinResourceContribution<K>,
  ): void {
    this.assertRegistering();
    if (!contribution.resourceKind.trim()) {
      throw new Error("resourceKind must not be empty");
    }
    const close = this.registrars.watchBuiltinResource(contribution);
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
