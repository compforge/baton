import { fileURLToPath } from "node:url";

import type {
  PluginDataDirectories,
  PluginInstance,
  PluginLogEntry,
  PluginSessionContext,
  ResourceClient,
  SourceContext,
  ToastMessage,
} from "@compforge/baton-plugin";

import {
  type ActivationResult,
  type ChildCall,
  type ChildMessage,
  type ChildReply,
  type HostRequest,
  type ParentCall,
  type ParentReply,
  type PluginPackageEntry,
  type RunnerRequest,
  restoredError,
  serializedError,
} from "./protocol.ts";

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface SourceCallbacks {
  readonly emit: SourceContext<unknown>["emit"];
  readonly reportError: SourceContext<unknown>["reportError"];
}

export interface PluginRunnerCallbacks {
  readonly resources: ResourceClient;
  readonly onToast: (message: ToastMessage) => void;
  readonly onLog: (entry: PluginLogEntry) => void;
  readonly onFailure?: (error: Error) => void;
}

const RUNNER_CLOSE_GRACE_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface PluginRunnerClientOptions extends PluginRunnerCallbacks {
  readonly requestTimeoutMs?: number;
}

/**
 * One PluginBinding's child-process client. Third-party code and synchronous
 * subprocess calls cannot occupy Baton's event loop.
 */
export class PluginRunnerClient {
  private readonly child: Bun.Subprocess<"ignore", "ignore", "ignore">;
  private readonly callbacks: PluginRunnerCallbacks;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<number, PendingCall>();
  private readonly sources = new Map<string, SourceCallbacks>();
  private nextCallId = 1;
  private nextSourceRunId = 1;
  private closing = false;
  private failed?: Error;

  constructor(options: PluginRunnerClientOptions) {
    this.callbacks = options;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1
    ) {
      throw new Error("Plugin Runner request timeout must be a positive integer");
    }
    this.child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./process.ts", import.meta.url)),
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        ipc: (message) => {
          this.handleMessage(message);
        },
        onDisconnect: () => {
          if (!this.closing) {
            this.fail(new Error("Plugin Runner IPC disconnected"));
          }
        },
        onExit: (_child, exitCode, signalCode, error) => {
          if (this.closing) return;
          this.fail(
            error ??
              new Error(
                `Plugin Runner exited unexpectedly: ${
                  signalCode ?? exitCode
                }`,
              ),
          );
        },
      },
    );
  }

  async activate(
    entry: PluginPackageEntry,
    instance: PluginInstance,
    session: PluginSessionContext,
    dataDirs: PluginDataDirectories,
  ): Promise<ActivationResult> {
    return await this.call({
      method: "activate",
      entry,
      instance,
      session,
      dataDirs,
    }) as ActivationResult;
  }

  async invoke<T>(
    handlerId: string,
    ...args: readonly unknown[]
  ): Promise<T> {
    return await this.call({
      method: "invoke",
      handlerId,
      args,
    }) as T;
  }

  async startSource(
    handlerId: string,
    context: SourceContext<unknown>,
  ): Promise<void> {
    const sourceRunId = `source:${this.nextSourceRunId++}`;
    this.sources.set(sourceRunId, {
      emit: context.emit,
      reportError: context.reportError,
    });
    const stop = (): void => {
      context.signal.removeEventListener("abort", stop);
      this.sources.delete(sourceRunId);
      void this.call({
        method: "stop-source",
        sourceRunId,
      }).catch(() => {
        // Runner close and Source cancellation can race.
      });
    };
    context.signal.addEventListener("abort", stop, { once: true });
    try {
      await this.call({
        method: "start-source",
        handlerId,
        sourceRunId,
      });
    } catch (error) {
      stop();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      if (!this.failed && this.child.exitCode === null) {
        await Promise.race([
          this.send({ method: "close" }),
          new Promise<void>((resolve) =>
            setTimeout(resolve, RUNNER_CLOSE_GRACE_MS)
          ),
        ]);
      }
    } finally {
      this.sources.clear();
      if (this.child.exitCode === null) this.child.kill();
      this.child.disconnect();
      this.fail(new Error("Plugin Runner is closed"));
    }
  }

  private call(request: RunnerRequest): Promise<unknown> {
    if (this.closing) {
      return Promise.reject(
        this.failed ?? new Error("Plugin Runner is closing"),
      );
    }
    return this.send(request);
  }

  private send(request: RunnerRequest): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    const callId = this.nextCallId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(callId)) return;
        this.fail(
          new Error(
            `Plugin Runner ${request.method} timed out after ${this.requestTimeoutMs}ms`,
          ),
          true,
        );
      }, this.requestTimeoutMs);
      this.pending.set(callId, { resolve, reject, timeout });
      try {
        this.child.send({
          kind: "parent-call",
          callId,
          request,
        } satisfies ParentCall);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(callId);
        reject(error);
      }
    });
  }

  private handleMessage(message: unknown): void {
    if (
      !message ||
      typeof message !== "object" ||
      !("kind" in message) ||
      typeof message.kind !== "string"
    ) {
      this.fail(new Error("Plugin Runner sent an invalid IPC message"), true);
      return;
    }
    const childMessage = message as ChildMessage;
    if (childMessage.kind === "child-reply") {
      this.handleReply(childMessage);
      return;
    }
    if (childMessage.kind === "child-call") {
      void this.handleChildCall(childMessage);
      return;
    }
    if (childMessage.kind === "toast") {
      this.callbacks.onToast(childMessage.message);
      return;
    }
    if (childMessage.kind === "log") {
      this.callbacks.onLog(childMessage.entry);
      return;
    }
    if (childMessage.kind === "source-error") {
      this.sources.get(childMessage.sourceRunId)?.reportError(
        restoredError(childMessage.error),
      );
      return;
    }
    this.fail(
      new Error(`Plugin Runner sent an unknown IPC message: ${message.kind}`),
      true,
    );
  }

  private handleReply(reply: ChildReply): void {
    const pending = this.pending.get(reply.callId);
    if (!pending) return;
    this.pending.delete(reply.callId);
    clearTimeout(pending.timeout);
    if (reply.ok) pending.resolve(reply.value);
    else pending.reject(restoredError(reply.error));
  }

  private async handleChildCall(call: ChildCall): Promise<void> {
    try {
      const value = await this.handleHostRequest(call.request);
      this.child.send({
        kind: "parent-reply",
        callId: call.callId,
        ok: true,
        value,
      } satisfies ParentReply);
    } catch (error) {
      this.child.send({
        kind: "parent-reply",
        callId: call.callId,
        ok: false,
        error: serializedError(error),
      } satisfies ParentReply);
    }
  }

  private async handleHostRequest(request: HostRequest): Promise<unknown> {
    switch (request.method) {
      case "resource.get":
        return await this.callbacks.resources.get(request.type, request.name);
      case "resource.list":
        return await this.callbacks.resources.list(
          request.type,
          request.options,
        );
      case "resource.create":
        return await this.callbacks.resources.create(
          request.type,
          request.init,
        );
      case "resource.delete":
        await this.callbacks.resources.delete(request.type, request.name);
        return undefined;
      case "resource.patchMetadata":
        return await this.callbacks.resources.patchMetadata(
          request.resource,
          request.patch,
        );
      case "resource.patchStatus":
        return await this.callbacks.resources.patchStatus(
          request.resource,
          request.patch,
        );
      case "source.emit": {
        const source = this.sources.get(request.sourceRunId);
        if (!source) {
          throw new Error(`Plugin Source is not active: ${request.sourceRunId}`);
        }
        await source.emit(request.resource);
        return undefined;
      }
    }
  }

  private fail(error: Error, terminate = false): void {
    if (this.failed) return;
    this.failed = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.failed);
    }
    this.pending.clear();
    for (const source of this.sources.values()) {
      source.reportError(this.failed);
    }
    this.sources.clear();
    if (!this.closing) {
      try {
        this.callbacks.onFailure?.(this.failed);
      } catch {
        // A lifecycle observer cannot change Runner failure semantics.
      }
    }
    if (terminate && this.child.exitCode === null) {
      this.child.kill("SIGKILL");
      this.child.disconnect();
    }
  }
}
