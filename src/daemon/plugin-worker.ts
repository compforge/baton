import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { HumanInboxStore } from "../inbox/human.ts";
import type {
  CreatePluginInstance,
  PluginConfig,
  PluginInstance,
  PluginInstanceRepository,
} from "../plugin/instance.ts";
import {
  type PluginBindingDefinition,
  type PluginHostPackage,
  type PluginWorker,
  type PluginWorkerLauncher,
} from "../plugin/host.ts";
import { Manager } from "../plugin/manager.ts";
import { MarketplaceRegistry } from "../plugin/marketplace/index.ts";
import { emptyReconcileSnapshot } from "../plugin/reconcile-snapshot.ts";
import { PluginSupervisor } from "../plugin/runner/index.ts";
import { PluginSettingsStore } from "../plugin/settings.ts";

class BindingInstanceRepository implements PluginInstanceRepository {
  readonly batonSessionId: string;
  readonly session: Readonly<{ id: string; dir: string }>;
  private readonly instance: PluginInstance;

  constructor(binding: PluginBindingDefinition, dir: string, now = new Date()) {
    this.batonSessionId = binding.bindingId;
    this.session = Object.freeze({ id: binding.bindingId, dir });
    const timestamp = now.toISOString();
    this.instance = Object.freeze({
      pluginInstanceId: binding.bindingId,
      batonSessionId: binding.bindingId,
      pluginId: binding.pluginId,
      marketplace: binding.marketplace,
      packageVersion: binding.packageVersion,
      enabled: true,
      config: binding.config,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  create(_input: CreatePluginInstance): PluginInstance {
    throw new Error("Daemon Plugin Binding repository is read-only");
  }

  get(pluginInstanceId: string): PluginInstance {
    if (pluginInstanceId !== this.instance.pluginInstanceId) {
      throw new Error(`plugin instance not found: ${pluginInstanceId}`);
    }
    return this.instance;
  }

  list(): PluginInstance[] {
    return [this.instance];
  }

  setEnabled(_pluginInstanceId: string, _enabled: boolean): PluginInstance {
    throw new Error("Daemon Plugin Binding repository is read-only");
  }

  setPackageVersion(
    _pluginInstanceId: string,
    _packageVersion: string,
  ): PluginInstance {
    throw new Error("Daemon Plugin Binding repository is read-only");
  }

  replaceConfig(_pluginInstanceId: string, _config: PluginConfig): PluginInstance {
    throw new Error("Daemon Plugin Binding repository is read-only");
  }

  delete(_pluginInstanceId: string): void {
    throw new Error("Daemon Plugin Binding repository is read-only");
  }
}

/** Launches the existing Manager/Supervisor/Runner tree under the Baton Daemon. */
export class DaemonPluginWorkerLauncher implements PluginWorkerLauncher {
  private readonly marketplace: MarketplaceRegistry;
  private readonly settings: PluginSettingsStore;

  constructor(
    private readonly rootDir: string,
    private readonly inbox: HumanInboxStore,
  ) {
    this.marketplace = new MarketplaceRegistry({ rootDir });
    this.settings = new PluginSettingsStore(rootDir);
  }

  packages(): readonly PluginHostPackage[] {
    const installed = new Map(
      this.marketplace.installed().map((entry) => [
        JSON.stringify([
          entry.manifest.pluginId,
          entry.provenance.marketplace,
          entry.manifest.version,
        ]),
        entry,
      ]),
    );
    return Object.freeze(
      this.settings.list()
        .filter((setting) => setting.enabled)
        .map((setting): PluginHostPackage => {
          const entry = installed.get(JSON.stringify([
            setting.pluginId,
            setting.marketplace,
            setting.packageVersion,
          ]));
          if (!entry) {
            throw new Error(
              `enabled Plugin Package is not installed: ${setting.key} ${setting.packageVersion}`,
            );
          }
          return Object.freeze({
            pluginId: setting.pluginId,
            marketplace: setting.marketplace,
            packageVersion: setting.packageVersion,
            config: setting.config,
          });
        }),
    );
  }

  async launch(binding: PluginBindingDefinition): Promise<PluginWorker> {
    const dir = this.bindingDir(binding);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const instances = new BindingInstanceRepository(binding, dir);
    const supervisor = new PluginSupervisor();
    const manager = new Manager({
      instances,
      snapshot: () => {
        const snapshot = emptyReconcileSnapshot(binding.bindingId);
        return snapshot;
      },
      loadPackageEntry: (pluginId, version, options) => {
        if (!options.marketplace) {
          throw new Error(`marketplace is required to load ${pluginId}`);
        }
        return this.marketplace.entry(
          pluginId,
          options.marketplace,
          version,
          options,
        );
      },
      pluginSupervisor: supervisor,
      performVerb: (execution, request) =>
        this.inbox.request({
          namespace: execution.namespace,
          pluginId: binding.pluginId,
          pluginInstanceId: binding.bindingId,
          executionId: execution.executionId,
          request,
        }),
    });
    try {
      await manager.start();
      if (!manager.isInstanceActive(binding.bindingId)) {
        throw new Error(`Plugin Worker failed to activate ${binding.bindingId}`);
      }
    } catch (error) {
      await manager.close().catch(() => {});
      throw error;
    }
    return Object.freeze({
      close: async () => await manager.close(),
    });
  }

  close(): void {
    this.marketplace.close();
  }

  private bindingDir(binding: PluginBindingDefinition): string {
    return join(
      this.rootDir,
      "projects",
      "_global",
      "sessions",
      binding.bindingId,
    );
  }
}
