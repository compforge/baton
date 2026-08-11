import { fileURLToPath } from "node:url";

import type {
  PluginDataDirectories,
  PluginInstance,
  PluginSessionContext,
  ResourceClient,
  SourceContext,
  ToastMessage,
} from "@compforge/baton-plugin";
import type { PluginLogRecord } from "../package.ts";
import type {
  ReconcileVerbScope,
  ReconcileVerbRequest,
  ReconcileVerbResponse,
} from "../verbs.ts";

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
  readonly request: RunnerRequest;
  timeout?: ReturnType<typeof setTimeout>;
}

interface ReconcileCall {
  readonly callId: number;
  blockers: number;
}

interface SourceCallbacks {
  readonly emit: SourceContext<unknown>["emit"];
  readonly reportError: SourceContext<unknown>["reportError"];
}

export interface PluginRunnerCallbacks {
  readonly resources: ResourceClient;
  readonly invokeReconcileVerb: (
    context: ReconcileVerbScope,
    request: ReconcileVerbRequest,
  ) => Promise<ReconcileVerbResponse>;
  readonly onToast: (message: ToastMessage) => void;
  readonly onLog: (record: PluginLogRecord) => void;
  readonly onOutput?: (
    stream: "stdout" | "stderr",
    output: string,
  ) => void;
  readonly onFailure?: (error: Error) => void;
}

const RUNNER_CLOSE_GRACE_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_LINE_CHARS = 8 * 1024;

export interface PluginRunnerClientOptions extends PluginRunnerCallbacks {
  readonly requestTimeoutMs?: number;
}

/**
 * One PluginBinding's child-process client. Third-party code and synchronous
 * subprocess calls cannot occupy Baton's event loop.
 */
export class PluginRunnerClient {
  private readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  private readonly callbacks: PluginRunnerCallbacks;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<number, PendingCall>();
  private readonly reconcileCalls = new Map<string, ReconcileCall>();
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
        stdout: "pipe",
        stderr: "pipe",
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
    void this.captureOutput("stdout", this.child.stdout);
    void this.captureOutput("stderr", this.child.stderr);
  }

  private async captureOutput(
    stream: "stdout" | "stderr",
    readable: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          this.emitOutput(stream, buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
        if (buffer.length > MAX_OUTPUT_LINE_CHARS) {
          this.emitOutput(stream, buffer);
          buffer = "";
        }
      }
      buffer += decoder.decode();
      this.emitOutput(stream, buffer);
    } catch {
      // Process termination can close the stream while the reader is pending.
    } finally {
      reader.releaseLock();
    }
  }

  private emitOutput(stream: "stdout" | "stderr", output: string): void {
    const text = output.trim();
    if (!text) return;
    try {
      this.callbacks.onOutput?.(
        stream,
        text.slice(0, MAX_OUTPUT_LINE_CHARS),
      );
    } catch {
      // Runtime output is diagnostic-only.
    }
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
      const pending: PendingCall = { resolve, reject, request };
      this.pending.set(callId, pending);
      const executionId = this.reconcileExecutionId(request);
      if (executionId) {
        this.reconcileCalls.set(executionId, { callId, blockers: 0 });
      }
      this.armCallTimeout(callId, pending);
      try {
        this.child.send({
          kind: "parent-call",
          callId,
          request,
        } satisfies ParentCall);
      } catch (error) {
        if (pending.timeout) clearTimeout(pending.timeout);
        this.pending.delete(callId);
        if (executionId) this.reconcileCalls.delete(executionId);
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
      this.callbacks.onLog(childMessage.record);
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
    if (pending.timeout) clearTimeout(pending.timeout);
    const executionId = this.reconcileExecutionId(pending.request);
    if (executionId) this.reconcileCalls.delete(executionId);
    if (reply.ok) pending.resolve(reply.value);
    else pending.reject(restoredError(reply.error));
  }

  private async handleChildCall(call: ChildCall): Promise<void> {
    const resumeTimeout = call.request.method === "reconcile.invoke"
      ? this.pauseReconcileTimeout(call.request.context.executionId)
      : undefined;
    try {
      const value = await this.handleHostRequest(call.request);
      this.replyToChild({
        kind: "parent-reply",
        callId: call.callId,
        ok: true,
        value,
      } satisfies ParentReply);
    } catch (error) {
      this.replyToChild({
        kind: "parent-reply",
        callId: call.callId,
        ok: false,
        error: serializedError(error),
      } satisfies ParentReply);
    } finally {
      resumeTimeout?.();
    }
  }

  private replyToChild(reply: ParentReply): void {
    if (this.closing || this.failed || this.child.exitCode !== null) return;
    try {
      this.child.send(reply);
    } catch (error) {
      if (this.closing || this.failed) return;
      this.fail(
        error instanceof Error ? error : new Error(String(error)),
        true,
      );
    }
  }

  private async handleHostRequest(request: HostRequest): Promise<unknown> {
    switch (request.method) {
      case "reconcile.invoke":
        return await this.callbacks.invokeReconcileVerb(
          request.context,
          request.request,
        );
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
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(this.failed);
    }
    this.pending.clear();
    this.reconcileCalls.clear();
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

  private reconcileExecutionId(request: RunnerRequest): string | undefined {
    if (request.method !== "invoke") return;
    const scope = request.args[1];
    if (!scope || typeof scope !== "object" || !("executionId" in scope)) {
      return;
    }
    return typeof scope.executionId === "string" ? scope.executionId : undefined;
  }

  private armCallTimeout(callId: number, pending: PendingCall): void {
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      if (!this.pending.has(callId)) return;
      this.fail(
        new Error(
          `Plugin Runner ${pending.request.method} timed out after ${this.requestTimeoutMs}ms`,
        ),
        true,
      );
    }, this.requestTimeoutMs);
  }

  /** A verb owns its timeout, so the outer Runner watchdog pauses while it waits. */
  private pauseReconcileTimeout(executionId: string): (() => void) | undefined {
    const reconcile = this.reconcileCalls.get(executionId);
    const pending = reconcile
      ? this.pending.get(reconcile.callId)
      : undefined;
    if (!reconcile || !pending) return;
    reconcile.blockers += 1;
    if (reconcile.blockers === 1 && pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = undefined;
    }
    return () => {
      const current = this.reconcileCalls.get(executionId);
      const active = current ? this.pending.get(current.callId) : undefined;
      if (!current || !active) return;
      current.blockers -= 1;
      if (current.blockers === 0) this.armCallTimeout(current.callId, active);
    };
  }
}
