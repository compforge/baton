import type { Controller } from "./reconcile.ts";
import type { ResourceClient } from "./resource.ts";
import type { Command } from "./command.ts";
import type { ContextProvider } from "./context.ts";

export type PluginConfig = Record<string, unknown>;

export interface PluginInstance {
  readonly pluginInstanceId: string;
  readonly batonSessionId: string;
  readonly pluginId: string;
  readonly marketplace?: string;
  readonly packageVersion: string;
  readonly enabled: boolean;
  readonly config: Readonly<PluginConfig>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PluginSessionContext {
  readonly batonSessionId: string;
  readonly cwd?: string;
}

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastMessage {
  readonly text: string;
  readonly tone: ToastTone;
}

export interface ToastSink {
  show(message: ToastMessage): void;
}

export type PluginLogLevel = "debug" | "info" | "warn" | "error";

export type PluginLogDetails = Readonly<
  Record<string, string | number | boolean | null>
>;

export interface PluginLogEntry {
  readonly level: PluginLogLevel;
  /** Stable Plugin-local area, for example "devloop.pull-request-source". */
  readonly component?: string;
  readonly message: string;
  readonly error?: unknown;
  readonly details?: PluginLogDetails;
}

export interface PluginLogger {
  /** Best-effort diagnostics owned and persisted by the current BatonSession. */
  write(entry: PluginLogEntry): void;
}

export interface PluginActivationContext {
  readonly instance: PluginInstance;
  readonly session: PluginSessionContext;
  readonly resources: ResourceClient;
  /** Session-scoped, non-durable user feedback. Reconcile state belongs in Resource status / Board. */
  readonly toast: ToastSink;
  /** Session-scoped diagnostics. Never log secrets or use logs as domain state. */
  readonly logger: PluginLogger;
  registerCommand(command: Command): void;
  registerContextProvider(provider: ContextProvider): void;
  registerController<TSpec, TStatus>(
    controller: Controller<TSpec, TStatus>,
  ): void;
  onClose(cleanup: () => Promise<void> | void): void;
}

export interface PluginPackage {
  readonly pluginId: string;
  readonly version: string;
  activate(context: PluginActivationContext): Promise<void> | void;
}
