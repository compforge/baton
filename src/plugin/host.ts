import { createHash } from "node:crypto";

export interface PluginHostPackage {
  readonly pluginId: string;
  readonly marketplace: string;
  readonly packageVersion: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface PluginBindingDefinition extends PluginHostPackage {
  readonly bindingId: string;
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
): string {
  return packageKey(plugin);
}

export function pluginBindingId(
  plugin: Pick<PluginHostPackage, "pluginId" | "marketplace">,
): string {
  return `pb_${createHash("sha256")
    .update(bindingKey(plugin))
    .digest("hex")
    .slice(0, 20)}`;
}

/** One enabled PluginInstance activates one Binding and one Worker. */
export function desiredPluginBinding(
  plugin: PluginHostPackage,
): PluginBindingDefinition {
  return Object.freeze({
    ...plugin,
    bindingId: pluginBindingId(plugin),
  });
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
    JSON.stringify(left.config) === JSON.stringify(right.config)
  );
}

/**
 * Baton Daemon 内的 PluginInstance Binding manager。Session 数量不决定
 * Worker 或 reconcile owner 数量。
 */
export class PluginHost {
  private readonly workers = new Map<string, WorkerEntry>();
  private operation = Promise.resolve();
  private closed = false;

  constructor(private readonly launcher: PluginWorkerLauncher) {}

  reconcile(packages: readonly PluginHostPackage[]): Promise<void> {
    return this.serial(async () => {
      const desired = new Map<string, PluginBindingDefinition>();
      for (const plugin of packages) {
        const binding = desiredPluginBinding(plugin);
        const key = bindingKey(binding);
        if (desired.has(key)) {
          throw new Error(
            `duplicate Plugin Binding for ${plugin.pluginId}@${plugin.marketplace}`,
          );
        }
        desired.set(key, binding);
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
        .sort((left, right) => packageKey(left).localeCompare(packageKey(right))),
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
