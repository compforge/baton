import type { HarnessTargetConfig } from "../../config/types.ts";

export interface DshTargetConfig {
  command?: string[];
  provider?: string;
  model: string;
}

export const DEFAULT_DSH_TARGET_CONFIG: HarnessTargetConfig = Object.freeze({
  harness: "dsh",
  model: "prod",
});

export function resolveDshTargetConfig(config: HarnessTargetConfig): DshTargetConfig {
  const command =
    Array.isArray(config.command) &&
    config.command.length > 0 &&
    config.command.every((part) => typeof part === "string" && part.trim())
      ? [...config.command]
      : undefined;
  const provider = typeof config.provider === "string" && config.provider.trim()
    ? config.provider
    : undefined;
  const model = typeof config.model === "string" && config.model.trim()
    ? config.model
    : "prod";
  return {
    ...(command ? { command } : {}),
    ...(provider ? { provider } : {}),
    model,
  };
}
