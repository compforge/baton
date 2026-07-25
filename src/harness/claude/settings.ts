// Claude Code settings 读取：使用 Claude Agent SDK 的 resolveSettings() 函数。
// SDK 自动发现并合并多层配置（user/project/local/managed），比手动读取 JSON 更可靠。

import {
  resolveSettings,
  type McpServerConfig,
  type SdkPluginConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { DiagnosticSink } from "../../diagnostics.ts";

/**
 * Claude settings 文件的相关部分（只提取我们需要的）
 */
export interface ClaudeSettings {
  plugins?: SdkPluginConfig[];
  mcpServers?: Record<string, McpServerConfig>;
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
  diagnostic?: DiagnosticSink,
): Promise<ClaudeSettings> {
  try {
    const resolved = await resolveSettings({ cwd });
    const { plugins, mcpServers } = resolved.effective;

    return {
      plugins: plugins && Array.isArray(plugins) && plugins.length > 0
        ? (plugins as SdkPluginConfig[])
        : undefined,
      mcpServers: mcpServers && typeof mcpServers === "object" && Object.keys(mcpServers).length > 0
        ? (mcpServers as Record<string, McpServerConfig>)
        : undefined,
    };
  } catch (error) {
    // Settings 解析失败：记录但不阻断启动（大多数项目没有 settings）
    if (diagnostic) {
      diagnostic({
        level: "info",
        component: "claude.settings",
        harness: "claude",
        message: "Could not resolve Claude settings",
        details: { error: error instanceof Error ? error.message : String(error), cwd },
      });
    }
    return {};
  }
}
