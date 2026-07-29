import type {
  PluginDataDirectories,
  PluginInstance,
  PluginSessionContext,
} from "@compforge/baton-plugin";

import {
  PluginRunnerClient,
  type PluginRunnerCallbacks,
} from "./client.ts";
import type {
  ActivationResult,
  PluginPackageEntry,
} from "./protocol.ts";

export interface ActivePluginRunner {
  readonly client: PluginRunnerClient;
  readonly activation: ActivationResult;
  close(): Promise<void>;
}

export interface PluginSupervisorOptions {
  readonly requestTimeoutMs?: number;
}

/** Baton-owned lifecycle boundary for per-Binding Plugin Runner processes. */
export class PluginSupervisor {
  private readonly active = new Set<PluginRunnerClient>();
  private readonly requestTimeoutMs?: number;
  private closed = false;

  constructor(options: PluginSupervisorOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  async activate(
    entry: PluginPackageEntry,
    instance: PluginInstance,
    session: PluginSessionContext,
    dataDirs: PluginDataDirectories,
    callbacks: PluginRunnerCallbacks,
  ): Promise<ActivePluginRunner> {
    if (this.closed) throw new Error("Plugin Supervisor is closed");
    let client!: PluginRunnerClient;
    client = new PluginRunnerClient({
      ...callbacks,
      ...(this.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: this.requestTimeoutMs }),
      onFailure: (error) => {
        this.active.delete(client);
        callbacks.onFailure?.(error);
      },
    });
    this.active.add(client);
    try {
      const activation = await client.activate(
        entry,
        instance,
        session,
        dataDirs,
      );
      let active = true;
      return Object.freeze({
        client,
        activation,
        close: async () => {
          if (!active) return;
          active = false;
          this.active.delete(client);
          await client.close();
        },
      });
    } catch (error) {
      this.active.delete(client);
      await client.close().catch(() => {});
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const clients = [...this.active];
    this.active.clear();
    const results = await Promise.allSettled(
      clients.map((client) => client.close()),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Could not close Plugin Supervisor");
    }
  }
}

export type {
  PluginPackageEntry,
} from "./protocol.ts";
