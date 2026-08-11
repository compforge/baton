import type { PluginInstance } from "./instance.ts";
import {
  type PluginPackage,
  pluginPackageKey,
  validatePluginPackage,
} from "./package.ts";
import type { PluginPackageEntry } from "./runner/index.ts";

export interface PackageLoaderOptions {
  /** 当前进程可激活的可信、不可变 Package 版本。 */
  packages?: readonly PluginPackage[];
  /** 按需加载已安装 Package；fresh 用于开发期绕过模块缓存。 */
  loadPackage?(
    pluginId: string,
    version: string,
    options?: { fresh?: boolean; marketplace?: string },
  ): Promise<PluginPackage>;
  /** Resolve an immutable entry without importing it into Baton. */
  loadPackageEntry?(
    pluginId: string,
    version: string,
    options: { marketplace: string; fresh?: boolean },
  ): Promise<PluginPackageEntry>;
}

export type PackageSource =
  | {
      readonly kind: "in-process";
      readonly plugin: PluginPackage;
    }
  | {
      readonly kind: "runner";
      readonly entry: PluginPackageEntry;
    };

/** Resolves immutable Package sources and deduplicates concurrent loads. */
export class PackageLoader {
  private readonly packages = new Map<string, PluginPackage>();
  private readonly packageLoads = new Map<string, Promise<PluginPackage>>();
  private readonly packageEntries = new Map<string, PluginPackageEntry>();
  private readonly packageEntryLoads = new Map<
    string,
    Promise<PluginPackageEntry>
  >();
  private readonly loadPackage: PackageLoaderOptions["loadPackage"];
  private readonly loadPackageEntry: PackageLoaderOptions["loadPackageEntry"];

  constructor(options: PackageLoaderOptions) {
    for (const plugin of options.packages ?? []) {
      validatePluginPackage(plugin);
      const key = pluginPackageKey(plugin.pluginId, plugin.version);
      if (this.packages.has(key)) {
        throw new Error(
          `plugin Package already registered: ${plugin.pluginId}@${plugin.version}`,
        );
      }
      this.packages.set(key, plugin);
    }
    this.loadPackage = options.loadPackage;
    this.loadPackageEntry = options.loadPackageEntry;
  }

  async load(
    instance: PluginInstance,
    fresh = false,
  ): Promise<PackageSource> {
    if (this.loadPackageEntry && instance.marketplace) {
      return {
        kind: "runner",
        entry: await this.resolveEntry(
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

  sourceKey(instance: PluginInstance): string {
    return instance.marketplace
      ? JSON.stringify([
          instance.pluginId,
          instance.marketplace,
          instance.packageVersion,
        ])
      : pluginPackageKey(instance.pluginId, instance.packageVersion);
  }

  private async resolveEntry(
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
        this.loadPackageEntry!(pluginId, version, {
          marketplace,
          ...(fresh ? { fresh: true } : {}),
        }),
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
        this.loadPackage!(pluginId, version, {
          ...(fresh ? { fresh: true } : {}),
          ...(marketplace ? { marketplace } : {}),
        }),
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
}
