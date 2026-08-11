export {
  PluginSupervisor,
  type ActivePluginRunner,
  type PluginPackageEntry,
  type PluginSupervisorOptions,
} from "./supervisor.ts";
export {
  PluginRunnerClient,
  type PluginRunnerClientOptions,
} from "./client.ts";
export { installRegistration } from "./registration.ts";

export type {
  ActivationResult,
  CommandRegistration,
  ContextProviderRegistration,
  ControllerRegistration,
  PluginRegistration,
  SourceRegistration,
  WatchRegistration,
} from "./protocol.ts";
