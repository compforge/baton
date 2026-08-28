// ~/.baton/config.yaml：用户级配置。HarnessTarget 拥有 Harness 专属启动配置，
// 根配置只负责全局选项、Target 索引和默认 Target。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse, stringify } from "yaml";

import { DEFAULT_CLAUDE_TARGET_CONFIG } from "../harness/claude/config.ts";
import { DEFAULT_CODEX_TARGET_CONFIG } from "../harness/codex/config.ts";
import { DEFAULT_DSH_TARGET_CONFIG } from "../harness/dsh/config.ts";
import type { BatonConfig, HarnessTargetConfig, NotificationConfig } from "./types.ts";

export type { BatonConfig, HarnessTargetConfig, NotificationConfig } from "./types.ts";

export const DEFAULT_CONFIG: BatonConfig = {
  defaultTarget: "codex",
  targets: {
    codex: DEFAULT_CODEX_TARGET_CONFIG,
    claude: DEFAULT_CLAUDE_TARGET_CONFIG,
    dsh: DEFAULT_DSH_TARGET_CONFIG,
  },
  mentionBudgetChars: 4096,
  showThoughts: true,
  notifications: { enabled: true, bell: false },
  logLevel: "info",
};

export function batonRoot(rootDir?: string): string {
  return rootDir ?? join(homedir(), ".baton");
}

export function configPath(rootDir?: string): string {
  return join(batonRoot(rootDir), "config.yaml");
}

/** 不存在则写入默认配置，返回文件路径。只在入口调用一次，load 本身无副作用。 */
export function ensureConfigFile(rootDir?: string): string {
  const path = configPath(rootDir);
  if (!existsSync(path)) {
    mkdirSync(batonRoot(rootDir), { recursive: true });
    writeFileSync(path, stringify(DEFAULT_CONFIG));
  }
  return path;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function loadTargets(value: unknown): Record<string, HarnessTargetConfig> {
  const configured = record(value) ?? {};
  const targets: Record<string, HarnessTargetConfig> = {};
  const targetIds = new Set([...Object.keys(DEFAULT_CONFIG.targets), ...Object.keys(configured)]);
  for (const targetId of targetIds) {
    if (!TARGET_ID_PATTERN.test(targetId)) continue;
    const base = DEFAULT_CONFIG.targets[targetId];
    const supplied = record(configured[targetId]);
    const candidate = { ...(base ?? {}), ...(supplied ?? {}) };
    if (typeof candidate.harness !== "string" || !candidate.harness.trim()) continue;
    targets[targetId] = Object.freeze({ ...candidate, harness: candidate.harness.trim() });
  }
  return targets;
}

function loadNotifications(value: unknown): NotificationConfig {
  if (typeof value === "boolean") return { enabled: value, bell: false };
  const supplied = record(value);
  if (!supplied) return DEFAULT_CONFIG.notifications;
  const enabled = typeof supplied.enabled === "boolean"
    ? supplied.enabled
    : DEFAULT_CONFIG.notifications.enabled;
  const bell = typeof supplied.bell === "boolean"
    ? supplied.bell
    : DEFAULT_CONFIG.notifications.bell;
  return { enabled, bell };
}

export function targetConfigFor(config: BatonConfig, targetId: string): HarnessTargetConfig {
  const target = config.targets[targetId];
  if (!target) throw new Error(`HarnessTarget not configured: ${targetId}`);
  return target;
}

/** Adapter/probe 创建边界的严格校验：账号选择不能因坏配置静默回落到 Baton 进程环境。 */
export function targetEnvironmentFor(
  config: HarnessTargetConfig,
  targetId: string,
): Readonly<Record<string, string>> | undefined {
  if (config.env === undefined) return undefined;
  const supplied = record(config.env);
  if (!supplied) throw new Error(`HarnessTarget ${targetId} env must be a string map`);

  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(supplied)) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(`HarnessTarget ${targetId} env has invalid variable name: ${name}`);
    }
    if (typeof value !== "string") {
      throw new Error(`HarnessTarget ${targetId} env ${name} must be a string`);
    }
    environment[name] = value;
  }
  return Object.keys(environment).length > 0 ? Object.freeze(environment) : undefined;
}

export function loadConfig(rootDir?: string): BatonConfig {
  let fromFile: Record<string, unknown> = {};
  const path = configPath(rootDir);
  if (existsSync(path)) {
    try {
      fromFile = record(parse(readFileSync(path, "utf8"))) ?? {};
    } catch {
      fromFile = {};
    }
  }

  const targets = loadTargets(fromFile.targets);
  const defaultTarget =
    typeof fromFile.defaultTarget === "string" && targets[fromFile.defaultTarget]
      ? fromFile.defaultTarget
      : DEFAULT_CONFIG.defaultTarget;
  const mentionBudgetChars =
    typeof fromFile.mentionBudgetChars === "number" &&
    Number.isFinite(fromFile.mentionBudgetChars) &&
    fromFile.mentionBudgetChars > 0
      ? fromFile.mentionBudgetChars
      : DEFAULT_CONFIG.mentionBudgetChars;
  const showThoughts = typeof fromFile.showThoughts === "boolean"
    ? fromFile.showThoughts
    : DEFAULT_CONFIG.showThoughts;
  const logLevel =
    typeof fromFile.logLevel === "string" &&
    ["debug", "info", "warn", "error"].includes(fromFile.logLevel)
      ? fromFile.logLevel as BatonConfig["logLevel"]
      : DEFAULT_CONFIG.logLevel;
  const textgenPrefer =
    typeof fromFile.textgenPrefer === "string" && targets[fromFile.textgenPrefer]
      ? fromFile.textgenPrefer
      : undefined;
  const textgenModels = record(fromFile.textgenModels);
  const validTextgenModels =
    textgenModels &&
    Object.values(textgenModels).every((value) => typeof value === "string" && value.trim())
      ? textgenModels as Record<string, string>
      : undefined;

  return {
    defaultTarget,
    targets,
    mentionBudgetChars,
    showThoughts,
    notifications: loadNotifications(fromFile.notifications),
    logLevel,
    ...(textgenPrefer ? { textgenPrefer } : {}),
    ...(validTextgenModels ? { textgenModels: validTextgenModels } : {}),
  };
}
