import type { HarnessTargetConfig } from "../../config/types.ts";

export interface ClaudeTargetConfig {
  executable?: string;
}

export const DEFAULT_CLAUDE_TARGET_CONFIG: HarnessTargetConfig = Object.freeze({
  harness: "claude",
});

export function resolveClaudeTargetConfig(config: HarnessTargetConfig): ClaudeTargetConfig {
  const configured = typeof config.executable === "string" && config.executable.trim()
    ? config.executable
    : undefined;
  const executable = process.env.BATON_CLAUDE_BIN || configured;
  return executable ? { executable } : {};
}
