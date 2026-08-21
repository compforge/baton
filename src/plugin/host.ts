import { createHash } from "node:crypto";

import type {
  PluginNamespace,
  PluginNamespaceTemplate,
} from "@compforge/baton-plugin";

import {
  parsePluginNamespaceTemplate,
  resolvePluginNamespace,
} from "./namespace.ts";

export interface PluginHostSession {
  readonly sessionId: string;
  readonly projectId: string;
  readonly cwd: string;
}

export interface PluginHostProject {
  readonly projectId: string;
  readonly cwd: string;
}

export interface PluginHostPackage {
  readonly pluginId: string;
  readonly marketplace: string;
  readonly packageVersion: string;
  readonly namespace: PluginNamespaceTemplate;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface PluginBindingDefinition
  extends Omit<PluginHostPackage, "namespace"> {
  readonly bindingId: string;
  readonly namespace: PluginNamespace;
  readonly namespaceTemplate: PluginNamespaceTemplate;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
}

export interface PluginWorker {
  readonly pid?: number;
  close(): Promise<void>;
}

export interface PluginWorkerLauncher {
  launch(binding: PluginBindingDefinition): Promise<PluginWorker>;
}

export type PluginWorkerPhase = "starting" | "running" | "failed" | "stopping";

export interface PluginWorkerStatus extends PluginBindingDefinition {
  readonly phase: PluginWorkerPhase;
  readonly pid?: number;
  readonly error?: string;
}

interface WorkerEntry {
  binding: PluginBindingDefinition;
  phase: PluginWorkerPhase;
  worker?: PluginWorker;
  error?: string;
}

function packageKey(plugin: Pick<PluginHostPackage, "pluginId" | "marketplace">): string {
  return JSON.stringify([plugin.pluginId, plugin.marketplace]);
}

function bindingKey(
  plugin: Pick<PluginHostPackage, "pluginId" | "marketplace">,
  namespace: PluginNamespace,
): string {
  return JSON.stringify([plugin.pluginId, plugin.marketplace, namespace]);
}

export function pluginBindingId(
  plugin: Pick<PluginHostPackage, "pluginId" | "marketplace">,
  namespace: PluginNamespace,
): string {
  return `pb_${createHash("sha256")
    .update(bindingKey(plugin, namespace))
    .digest("hex")
    .slice(0, 20)}`;
}

/** Resolves Package cardinality before the Host decides which Workers to keep. */
export function desiredPluginBindings(
  plugin: PluginHostPackage,
  sessions: readonly PluginHostSession[],
  projects: readonly PluginHostProject[] = sessions,
): readonly PluginBindingDefinition[] {
  const template = parsePluginNamespaceTemplate(plugin.namespace);
  const bindings = new Map<
    PluginNamespace,
    PluginHostProject | PluginHostSession | undefined
  >();
  if (template === "v1") {
    bindings.set("v1", undefined);
  } else {
    const scopeContexts = template === "v1/project" ? projects : sessions;
    for (const target of scopeContexts) {
      const namespace = resolvePluginNamespace(template, {
        projectId: target.projectId,
        ...(template === "v1/project/session"
          ? { sessionId: (target as PluginHostSession).sessionId }
          : {}),
      });
      const existing = bindings.get(namespace);
      if (existing && existing.cwd !== target.cwd) {
        throw new Error(
          `project ${target.projectId} is attached with conflicting cwd values`,
        );
      }
      bindings.set(namespace, existing ?? target);
    }
  }
  return Object.freeze(
    [...bindings]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([namespace, target]) => {
        const { namespace: namespaceTemplate, ...packageIdentity } = plugin;
        return Object.freeze({
          ...packageIdentity,
          namespace,
          namespaceTemplate,
          bindingId: pluginBindingId(plugin, namespace),
          ...(target === undefined
            ? {}
            : {
                projectId: target.projectId,
                cwd: target.cwd,
                ...(namespaceTemplate === "v1/project/session"
                  ? { sessionId: (target as PluginHostSession).sessionId }
                  : {}),
              }),
        });
      }),
  );
}

function sameBinding(
  left: PluginBindingDefinition,
  right: PluginBindingDefinition,
): boolean {
  return (
    left.bindingId === right.bindingId &&
    left.pluginId === right.pluginId &&
    left.marketplace === right.marketplace &&
    left.packageVersion === right.packageVersion &&
    left.namespace === right.namespace &&
    left.namespaceTemplate === right.namespaceTemplate &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    left.cwd === right.cwd &&
    JSON.stringify(left.config) === JSON.stringify(right.config)
  );
}

/**
 * Baton Daemon 内的 namespace Binding manager。Binding identity 是
 * plugin + namespace；Session 数量不会直接决定 Worker 或 reconcile owner 数量。
 */
export class PluginHost {
  private readonly workers = new Map<string, WorkerEntry>();
  private operation = Promise.resolve();
  private closed = false;

  constructor(private readonly launcher: PluginWorkerLauncher) {}

  reconcile(
    packages: readonly PluginHostPackage[],
    sessions: readonly PluginHostSession[],
    projects: readonly PluginHostProject[] = sessions,
  ): Promise<void> {
    return this.serial(async () => {
      const desired = new Map<string, PluginBindingDefinition>();
      for (const plugin of packages) {
        for (const binding of desiredPluginBindings(plugin, sessions, projects)) {
          const key = bindingKey(binding, binding.namespace);
          if (desired.has(key)) {
            throw new Error(
              `duplicate Plugin Binding for ${plugin.pluginId}@${plugin.marketplace} in ${binding.namespace}`,
            );
          }
          desired.set(key, binding);
        }
      }

      for (const [key, entry] of [...this.workers]) {
        const next = desired.get(key);
        if (next && sameBinding(entry.binding, next)) {
          desired.delete(key);
          continue;
        }
        await this.stop(key, entry);
      }
      for (const [key, binding] of desired) await this.start(key, binding);
    });
  }

  list(): readonly PluginWorkerStatus[] {
    return Object.freeze(
      [...this.workers.values()]
        .map((entry) => Object.freeze({
          ...entry.binding,
          phase: entry.phase,
          ...(entry.worker?.pid === undefined ? {} : { pid: entry.worker.pid }),
          ...(entry.error === undefined ? {} : { error: entry.error }),
        }))
        .sort((left, right) =>
          packageKey(left).localeCompare(packageKey(right)) ||
          left.namespace.localeCompare(right.namespace)
        ),
    );
  }

  close(): Promise<void> {
    if (this.closed) return this.operation;
    this.closed = true;
    return this.serial(async () => {
      for (const [key, entry] of [...this.workers]) await this.stop(key, entry);
    }, true);
  }

  private serial(operation: () => Promise<void>, closing = false): Promise<void> {
    if (this.closed && !closing) {
      return Promise.reject(new Error("Plugin Host is closed"));
    }
    const next = this.operation.then(operation, operation);
    this.operation = next.catch(() => {});
    return next;
  }

  private async start(
    key: string,
    binding: PluginBindingDefinition,
  ): Promise<void> {
    const entry: WorkerEntry = { binding, phase: "starting" };
    this.workers.set(key, entry);
    try {
      entry.worker = await this.launcher.launch(binding);
      entry.phase = "running";
    } catch (error) {
      entry.phase = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async stop(key: string, entry: WorkerEntry): Promise<void> {
    entry.phase = "stopping";
    try {
      await entry.worker?.close();
    } finally {
      this.workers.delete(key);
    }
  }
}
