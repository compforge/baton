// Claude Code settings 读取：从 .claude/settings.json 加载 plugins 和 mcpServers 配置。
// 参考 Claude Agent SDK 的 settings 结构。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiagnosticSink } from "../../diagnostics.ts";

/**
 * Claude SDK 的 plugin 配置
 */
export interface SdkPluginConfig {
  type: "local";
  path: string;
}

/**
 * Claude SDK 的 MCP server 配置
 */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Claude settings 文件的相关部分（只提取我们需要的）
 */
export interface ClaudeSettings {
  plugins?: SdkPluginConfig[];
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * 从指定目录读取 .claude/settings.json 文件。
 *
 * 查找顺序：
 * 1. cwd/.claude/settings.json
 * 2. cwd/.claude/settings.local.json（优先级更高，会覆盖 settings.json）
 *
 * 失败不抛异常，返回空配置并写 diagnostic。
 */
export async function readClaudeSettings(
  cwd: string,
  diagnostic?: DiagnosticSink,
): Promise<ClaudeSettings> {
  const result: ClaudeSettings = {};

  // 1. 读取 .claude/settings.json
  const settingsPath = join(cwd, ".claude", "settings.json");
  const baseSettings = await readSettingsFile(settingsPath, diagnostic);
  if (baseSettings.plugins) result.plugins = baseSettings.plugins;
  if (baseSettings.mcpServers) result.mcpServers = baseSettings.mcpServers;

  // 2. 读取 .claude/settings.local.json（覆盖）
  const localSettingsPath = join(cwd, ".claude", "settings.local.json");
  const localSettings = await readSettingsFile(localSettingsPath, diagnostic);
  if (localSettings.plugins) result.plugins = localSettings.plugins;
  if (localSettings.mcpServers) {
    result.mcpServers = { ...result.mcpServers, ...localSettings.mcpServers };
  }

  return result;
}

/**
 * 读取单个 settings 文件
 */
async function readSettingsFile(
  path: string,
  diagnostic?: DiagnosticSink,
): Promise<Partial<ClaudeSettings>> {
  try {
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content);

    // 验证并提取 plugins
    const plugins = Array.isArray(parsed.plugins)
      ? parsed.plugins.filter((p: unknown): p is SdkPluginConfig => {
          if (typeof p !== "object" || p === null) return false;
          const plugin = p as Record<string, unknown>;
          return plugin.type === "local" && typeof plugin.path === "string";
        })
      : undefined;

    // 验证并提取 mcpServers
    const mcpServers =
      parsed.mcpServers && typeof parsed.mcpServers === "object"
        ? (Object.fromEntries(
            Object.entries(parsed.mcpServers).filter(([_name, config]) => {
              if (typeof config !== "object" || config === null) return false;
              const server = config as Record<string, unknown>;
              return typeof server.command === "string";
            }),
          ) as Record<string, McpServerConfig>)
        : undefined;

    return { plugins, mcpServers };
  } catch (error) {
    // 文件不存在或解析失败：静默忽略（大多数项目没有 settings）
    if (diagnostic && (error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostic({
        level: "info",
        component: "claude.settings",
        harness: "claude",
        message: `Could not read Claude settings from ${path}`,
        details: { error: error instanceof Error ? error.message : String(error) },
      });
    }
    return {};
  }
}
