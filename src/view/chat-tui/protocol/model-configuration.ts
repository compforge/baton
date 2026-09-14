import type { Channel } from "../../../channel/index.ts";
import { saveModelPreference } from "../../../config/model-preferences.ts";
import { saveEffortPreference } from "../../../config/effort-preferences.ts";
import type { ModelConfiguration } from "../../../harness/adapter.ts";

/** Human command lowering shares the same Target preferences as /model and /effort. */
export async function configureTargetModel(
  channel: Channel,
  rootDir: string,
  target: string,
  configuration: ModelConfiguration,
  preferences: { models: Record<string, string>; efforts: Record<string, string> },
): Promise<void> {
  await channel.dispatchConfiguration({
    kind: "configuration",
    setting: "model_configuration",
    harnessTargetId: target,
    value: configuration,
  }, async () => {
    await channel.controller.setModelConfiguration(target, configuration);
    saveModelPreference(rootDir, target, configuration.model);
    saveEffortPreference(rootDir, target, configuration.effort);
    if (configuration.model === "default") delete preferences.models[target];
    else preferences.models[target] = configuration.model;
    if (configuration.effort === "default") delete preferences.efforts[target];
    else preferences.efforts[target] = configuration.effort;
  });
}
