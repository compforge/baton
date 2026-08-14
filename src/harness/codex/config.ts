import type { HarnessTargetConfig } from "../../config/types.ts";

export interface CodexTargetConfig {
  command: string[];
  approvalReviewer?: "user" | "auto_review";
}

export const DEFAULT_CODEX_TARGET_CONFIG: HarnessTargetConfig = Object.freeze({
  harness: "codex",
  command: ["codex", "app-server"],
});

export function resolveCodexTargetConfig(config: HarnessTargetConfig): CodexTargetConfig {
  const command =
    Array.isArray(config.command) &&
    config.command.length > 0 &&
    config.command.every((part) => typeof part === "string" && part.trim())
      ? [...config.command]
      : ["codex", "app-server"];
  const approvalReviewer =
    config.approvalReviewer === "user" || config.approvalReviewer === "auto_review"
      ? config.approvalReviewer
      : undefined;
  return {
    command,
    ...(approvalReviewer ? { approvalReviewer } : {}),
  };
}
