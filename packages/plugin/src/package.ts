import type { Controller } from "./reconcile.ts";
import type { ResourceClient } from "./resource.ts";
import type { Command } from "./command.ts";

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

export interface PluginActivationContext {
  readonly instance: PluginInstance;
  readonly session: PluginSessionContext;
  readonly resources: ResourceClient;
  /** Session-scoped, non-durable user feedback. Reconcile state belongs in Resource status / Board. */
  readonly toast: ToastSink;
  registerCommand(command: Command): void;
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
