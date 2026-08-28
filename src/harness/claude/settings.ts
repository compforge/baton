// Claude Code settings 读取：使用 Claude Agent SDK 的 resolveSettings() 函数。
// SDK 自动发现并合并多层配置（user/project/local/managed），比手动读取 JSON 更可靠。
//
// 注意：当前此模块不再用于将 settings 传递给 SDK。
// SDK 通过子进程启动 Claude CLI，CLI 会根据 cwd 自动读取配置文件：
//   1. ~/.claude/settings.json (user-level)
//   2. ${cwd}/.claude/settings.json (project-level)
//   3. ${cwd}/.claude/settings.local.json (local override)
//   4. managed-settings.json (policy)
//
// 此模块保留用于：
// - 诊断和验证：检查 settings 配置是否存在和有效
// - 未来扩展：需要读取 settings 做条件判断或展示的场景
// - 测试支持：在测试中验证配置读取逻辑
//
// 如果只需要让 Claude CLI 使用配置，无需调用此模块，只需传递正确的 cwd 给 SDK。

import {
  resolveSettings,
  type McpServerConfig,
  type SdkPluginConfig,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import type { LogSink } from "../../logging.ts";

/**
 * Claude settings 文件的相关部分（只提取我们需要的）
 */
export interface ClaudeSettings {
  plugins?: SdkPluginConfig[];
  mcpServers?: Record<string, McpServerConfig>;
  enabledPlugins?: Settings["enabledPlugins"];
  extraKnownMarketplaces?: Settings["extraKnownMarketplaces"];
}

/**
 * 使用 SDK 的 resolveSettings() 读取 Claude settings。
 *
 * SDK 自动发现并合并配置，优先级从低到高：
 * 1. ~/.claude/settings.json (user-level)
 * 2. .claude/settings.json (project-level)
 * 3. .claude/settings.local.json (local override)
 * 4. managed-settings.json (policy)
 *
 * 失败不抛异常，返回空配置并写 diagnostic。
 */
export async function readClaudeSettings(
  cwd: string,
  log?: LogSink,
  env?: Readonly<Record<string, string>>,
): Promise<ClaudeSettings> {
  if (
    env?.CLAUDE_CONFIG_DIR !== undefined &&
    env.CLAUDE_CONFIG_DIR !== process.env.CLAUDE_CONFIG_DIR
  ) {
    // resolveSettings 没有 per-call env；此时读取会混入 Baton 自己的默认账号配置。
    // 目标 Claude 子进程会按 CLAUDE_CONFIG_DIR 自行加载正确的 user settings。
    return {};
  }
  try {
    const resolved = await resolveSettings({ cwd });
    const { plugins, mcpServers, enabledPlugins, extraKnownMarketplaces } = resolved.effective;

    return {
      plugins: plugins && Array.isArray(plugins) && plugins.length > 0
        ? (plugins as SdkPluginConfig[])
        : undefined,
      mcpServers: mcpServers && typeof mcpServers === "object" && Object.keys(mcpServers).length > 0
        ? (mcpServers as Record<string, McpServerConfig>)
        : undefined,
      enabledPlugins: enabledPlugins && typeof enabledPlugins === "object" && Object.keys(enabledPlugins).length > 0
        ? enabledPlugins
        : undefined,
      extraKnownMarketplaces: extraKnownMarketplaces && typeof extraKnownMarketplaces === "object" && Object.keys(extraKnownMarketplaces).length > 0
        ? extraKnownMarketplaces
        : undefined,
    };
  } catch (error) {
    // Settings 解析失败：记录但不阻断启动（大多数项目没有 settings）
    if (log) {
      log({
        level: "info",
        source: "harness",
        component: "claude.settings",
        harness: "claude",
        message: "Could not resolve Claude settings",
        attributes: { error: error instanceof Error ? error.message : String(error), cwd },
      });
    }
    return {};
  }
}
