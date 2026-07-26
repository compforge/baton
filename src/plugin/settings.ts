import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parse, stringify } from "yaml";

import { withFileLock } from "../store/file-lock.ts";
import type { SessionHandle } from "../store/store.ts";
import { parsePluginKey, pluginKey } from "./identity.ts";
import type {
  CreatePluginInstance,
  PluginConfig,
  PluginInstance,
  PluginInstanceRepository,
} from "./instance.ts";

export interface PluginSetting {
  readonly key: string;
  readonly pluginId: string;
  readonly marketplace: string;
  readonly packageVersion: string;
  readonly enabled: boolean;
  readonly config: Readonly<PluginConfig>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PluginSettingValue {
  enabled: boolean;
  version: string;
  config: PluginConfig;
  createdAt: string;
  updatedAt: string;
}

interface PluginSettingsFile {
  version: 1;
  plugins: Record<string, PluginSettingValue>;
}

const EMPTY_SETTINGS: PluginSettingsFile = {
  version: 1,
  plugins: {},
};

function jsonObject(name: string, value: unknown): PluginConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a YAML object`);
  }
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must contain only JSON values: ${detail}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isDeepStrictEqual(value, parsed)) {
    throw new Error(`${name} must contain only lossless JSON values`);
  }
  return parsed as PluginConfig;
}

function nonEmptyString(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
  return value;
}

function timestamp(name: string, value: unknown): string {
  const result = nonEmptyString(name, value);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}

function parseSettings(value: unknown, fallbackTimestamp: string): PluginSettingsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("plugin settings root must be a YAML object");
  }
  const root = value as Record<string, unknown>;
  if (root.version !== 1) throw new Error("plugin settings version must be 1");
  if (!root.plugins || typeof root.plugins !== "object" || Array.isArray(root.plugins)) {
    throw new Error("plugin settings plugins must be a YAML object");
  }
  const plugins: Record<string, PluginSettingValue> = {};
  for (const [key, rawValue] of Object.entries(root.plugins as Record<string, unknown>)) {
    parsePluginKey(key);
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      throw new Error(`plugin settings ${key} must be a YAML object`);
    }
    const setting = rawValue as Record<string, unknown>;
    if (typeof setting.enabled !== "boolean") {
      throw new Error(`plugin settings ${key}.enabled must be a boolean`);
    }
    plugins[key] = {
      enabled: setting.enabled,
      version: nonEmptyString(`plugin settings ${key}.version`, setting.version),
      config: jsonObject(`plugin settings ${key}.config`, setting.config ?? {}),
      createdAt:
        setting.createdAt === undefined
          ? fallbackTimestamp
          : timestamp(`plugin settings ${key}.createdAt`, setting.createdAt),
      updatedAt:
        setting.updatedAt === undefined
          ? fallbackTimestamp
          : timestamp(`plugin settings ${key}.updatedAt`, setting.updatedAt),
    };
  }
  return { version: 1, plugins };
}

function writeYamlAtomic(path: string, value: PluginSettingsFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random()}.tmp`;
  try {
    writeFileSync(temporary, stringify(value, { lineWidth: 0 }), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function runtimeInstanceId(key: string): string {
  return `pi_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function freezeSetting(key: string, value: PluginSettingValue): PluginSetting {
  const identity = parsePluginKey(key);
  return deepFreeze({
    key,
    ...identity,
    packageVersion: value.version,
    enabled: value.enabled,
    config: { ...value.config },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

/**
 * 用户级 Plugin 启用配置。Package 安装缓存与 session 运行态分别由其它 Store 管理。
 */
export class PluginSettingsStore {
  readonly path: string;

  constructor(rootDir: string) {
    this.path = join(rootDir, "plugin.yaml");
  }

  list(): PluginSetting[] {
    const settings = this.read();
    return Object.entries(settings.plugins)
      .map(([key, value]) => freezeSetting(key, value))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  get(key: string): PluginSetting {
    parsePluginKey(key);
    const value = this.read().plugins[key];
    if (!value) throw new Error(`plugin is not configured: ${key}`);
    return freezeSetting(key, value);
  }

  set(input: {
    pluginId: string;
    marketplace: string;
    packageVersion: string;
    enabled?: boolean;
    config?: PluginConfig;
  }): PluginSetting {
    const key = pluginKey(input.pluginId, input.marketplace);
    const packageVersion = nonEmptyString("packageVersion", input.packageVersion);
    return withFileLock(this.path, () => {
      const current = this.read();
      const previous = current.plugins[key];
      const config = jsonObject("config", input.config ?? previous?.config ?? {});
      const now = new Date().toISOString();
      const next: PluginSettingValue = {
        enabled: input.enabled ?? true,
        version: packageVersion,
        config,
        createdAt: previous?.createdAt ?? now,
        updatedAt: previous && isDeepStrictEqual(
          {
            enabled: previous.enabled,
            version: previous.version,
            config: previous.config,
          },
          {
            enabled: input.enabled ?? true,
            version: packageVersion,
            config,
          },
        )
          ? previous.updatedAt
          : now,
      };
      if (previous && isDeepStrictEqual(previous, next)) return freezeSetting(key, previous);
      writeYamlAtomic(this.path, {
        version: 1,
        plugins: { ...current.plugins, [key]: next },
      });
      return freezeSetting(key, next);
    });
  }

  setEnabled(key: string, enabled: boolean): PluginSetting {
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
    return this.update(key, (current) => ({ ...current, enabled }));
  }

  setPackageVersion(key: string, packageVersion: string): PluginSetting {
    const version = nonEmptyString("packageVersion", packageVersion);
    return this.update(key, (current) => ({ ...current, version }));
  }

  replaceConfig(key: string, config: PluginConfig): PluginSetting {
    const nextConfig = jsonObject("config", config);
    return this.update(key, (current) => ({ ...current, config: nextConfig }));
  }

  remove(key: string): void {
    parsePluginKey(key);
    withFileLock(this.path, () => {
      const current = this.read();
      if (!current.plugins[key]) return;
      const plugins = { ...current.plugins };
      delete plugins[key];
      writeYamlAtomic(this.path, { version: 1, plugins });
    });
  }

  private update(
    key: string,
    mutate: (current: PluginSettingValue) => PluginSettingValue,
  ): PluginSetting {
    parsePluginKey(key);
    return withFileLock(this.path, () => {
      const settings = this.read();
      const current = settings.plugins[key];
      if (!current) throw new Error(`plugin is not configured: ${key}`);
      const next = mutate(current);
      if (isDeepStrictEqual(current, next)) return freezeSetting(key, current);
      next.updatedAt = new Date().toISOString();
      writeYamlAtomic(this.path, {
        version: 1,
        plugins: { ...settings.plugins, [key]: next },
      });
      return freezeSetting(key, next);
    });
  }

  private read(): PluginSettingsFile {
    if (!existsSync(this.path)) return { ...EMPTY_SETTINGS, plugins: {} };
    try {
      const fallbackTimestamp = statSync(this.path).mtime.toISOString();
      return parseSettings(
        parse(readFileSync(this.path, "utf8")) as unknown,
        fallbackTimestamp,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not read plugin settings ${this.path}: ${detail}`);
    }
  }
}

/**
 * 根据全局 enablement 创建当前 BatonSession 的运行时 Instance。
 * Instance id 由 plugin@marketplace 稳定派生，Resource/Proposal 仍落在当前 session。
 */
export class GlobalPluginInstanceStore implements PluginInstanceRepository {
  readonly batonSessionId: string;
  readonly session: Readonly<Pick<SessionHandle, "id" | "dir">>;
  private readonly settings: PluginSettingsStore;

  constructor(options: {
    settings: PluginSettingsStore;
    session: Pick<SessionHandle, "id" | "dir">;
  }) {
    this.settings = options.settings;
    this.session = Object.freeze({ id: options.session.id, dir: options.session.dir });
    this.batonSessionId = options.session.id;
  }

  create(input: CreatePluginInstance): PluginInstance {
    if (!input.marketplace) throw new Error("marketplace is required for a global plugin");
    const key = pluginKey(input.pluginId, input.marketplace);
    const expectedId = runtimeInstanceId(key);
    if (input.pluginInstanceId && input.pluginInstanceId !== expectedId) {
      throw new Error(`pluginInstanceId must be ${expectedId}`);
    }
    if (this.settings.list().some((setting) => setting.key === key)) {
      throw new Error(`plugin instance already exists: ${expectedId}`);
    }
    return this.instance(this.settings.set({
      pluginId: input.pluginId,
      marketplace: input.marketplace,
      packageVersion: input.packageVersion,
      enabled: input.enabled,
      config: input.config,
    }));
  }

  get(pluginInstanceId: string): PluginInstance {
    const setting = this.settings.list().find(
      ({ key }) => runtimeInstanceId(key) === pluginInstanceId,
    );
    if (!setting) throw new Error(`plugin instance not found: ${pluginInstanceId}`);
    return this.instance(setting);
  }

  list(): PluginInstance[] {
    return this.settings.list().map((setting) => this.instance(setting));
  }

  setEnabled(pluginInstanceId: string, enabled: boolean): PluginInstance {
    const current = this.get(pluginInstanceId);
    return this.instance(
      this.settings.setEnabled(pluginKey(current.pluginId, current.marketplace!), enabled),
    );
  }

  setPackageVersion(pluginInstanceId: string, packageVersion: string): PluginInstance {
    const current = this.get(pluginInstanceId);
    return this.instance(
      this.settings.setPackageVersion(
        pluginKey(current.pluginId, current.marketplace!),
        packageVersion,
      ),
    );
  }

  replaceConfig(pluginInstanceId: string, config: PluginConfig): PluginInstance {
    const current = this.get(pluginInstanceId);
    return this.instance(
      this.settings.replaceConfig(pluginKey(current.pluginId, current.marketplace!), config),
    );
  }

  delete(pluginInstanceId: string): void {
    const current = this.get(pluginInstanceId);
    this.settings.remove(pluginKey(current.pluginId, current.marketplace!));
  }

  private instance(setting: PluginSetting): PluginInstance {
    return deepFreeze({
      pluginInstanceId: runtimeInstanceId(setting.key),
      batonSessionId: this.batonSessionId,
      pluginId: setting.pluginId,
      marketplace: setting.marketplace,
      packageVersion: setting.packageVersion,
      enabled: setting.enabled,
      config: setting.config,
      createdAt: setting.createdAt,
      updatedAt: setting.updatedAt,
    });
  }
}
