import type {
  DeferredHookStage,
  Hook,
  HookStage,
  HookSubjectMap,
  InlineHookStage,
} from "@compforge/baton-plugin";

import { newId } from "../event/ids.ts";
import { type LogSink, logError } from "../logging.ts";
import type { ReconcileSnapshot } from "./reconcile-snapshot.ts";
import {
  createHookContext,
  type ExecutionScope,
  type InvokeVerb,
  type Verb,
} from "./verb.ts";

export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
export const DEFAULT_DEFERRED_HOOK_QUEUE_LIMIT = 256;

export interface HookRegistrationOwner {
  readonly batonSessionId: string;
  readonly pluginInstanceId: string;
  readonly pluginId: string;
}

export interface RegisteredHook<S extends HookStage = HookStage> {
  readonly owner: HookRegistrationOwner;
  readonly hook: Hook<S>;
}

interface HookRuntimeOptions {
  readonly snapshot: () => ReconcileSnapshot;
  readonly verb: Verb;
  readonly invokeVerb: InvokeVerb;
  readonly log?: LogSink;
  readonly defaultTimeoutMs?: number;
  readonly deferredQueueLimit?: number;
}

/** Host registry; Plugin Binding cleanup removes each registration atomically. */
export class HookRegistry {
  private readonly byStage = new Map<HookStage, Set<RegisteredHook>>();

  register<S extends HookStage>(owner: HookRegistrationOwner, hook: Hook<S>): () => void {
    if (!hook.hookId.trim()) throw new Error("Hook hookId must not be empty");
    if (hook.timeoutMs !== undefined && (!Number.isSafeInteger(hook.timeoutMs) || hook.timeoutMs < 1)) {
      throw new Error("Hook timeoutMs must be a positive integer");
    }
    const registrations = this.byStage.get(hook.stage) ?? new Set();
    if ([...registrations].some((entry) =>
      entry.owner.pluginInstanceId === owner.pluginInstanceId &&
      entry.hook.hookId === hook.hookId
    )) {
      throw new Error(`Hook already registered: ${hook.stage}/${hook.hookId}`);
    }
    const registration = Object.freeze({ owner, hook }) as RegisteredHook;
    registrations.add(registration);
    this.byStage.set(hook.stage, registrations);
    return () => {
      registrations.delete(registration);
      if (registrations.size === 0) this.byStage.delete(hook.stage);
    };
  }

  list<S extends HookStage>(stage: S): readonly RegisteredHook<S>[] {
    return [...(this.byStage.get(stage) ?? [])] as RegisteredHook<S>[];
  }

  has(stage: HookStage): boolean {
    return (this.byStage.get(stage)?.size ?? 0) > 0;
  }
}

/**
 * Hook failures are observations, not decisions: inline stages wait for all
 * matching handlers and fail open; committed/published stages use a bounded
 * best-effort queue. Effects are only available through HookContext.verbs.
 */
export class HookRuntime {
  private readonly snapshot: () => ReconcileSnapshot;
  private readonly verb: Verb;
  private readonly invokeVerb: InvokeVerb;
  private readonly log?: LogSink;
  private readonly defaultTimeoutMs: number;
  private readonly deferredQueueLimit: number;
  private deferredPending = 0;

  constructor(
    private readonly registry: HookRegistry,
    options: HookRuntimeOptions,
  ) {
    this.snapshot = options.snapshot;
    this.verb = options.verb;
    this.invokeVerb = options.invokeVerb;
    this.log = options.log;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    this.deferredQueueLimit =
      options.deferredQueueLimit ?? DEFAULT_DEFERRED_HOOK_QUEUE_LIMIT;
    if (!Number.isSafeInteger(this.defaultTimeoutMs) || this.defaultTimeoutMs < 1) {
      throw new Error("Hook default timeout must be a positive integer");
    }
    if (
      !Number.isSafeInteger(this.deferredQueueLimit) ||
      this.deferredQueueLimit < 1
    ) {
      throw new Error("Hook deferred queue limit must be a positive integer");
    }
  }

  async inline<S extends InlineHookStage>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): Promise<void> {
    await Promise.allSettled(
      this.registry.list(stage).map((registration) =>
        this.run(registration, stage, subject)
      ),
    );
  }

  defer<S extends DeferredHookStage>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): void {
    for (const registration of this.registry.list(stage)) {
      if (this.deferredPending >= this.deferredQueueLimit) {
        this.writeLog(registration, stage, "dropped", undefined, {
          reason: "deferred hook queue is full",
        });
        continue;
      }
      this.deferredPending += 1;
      void this.run(registration, stage, subject).finally(() => {
        this.deferredPending -= 1;
      });
    }
  }

  private async run<S extends HookStage>(
    registration: RegisteredHook<S>,
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): Promise<void> {
    const scope: ExecutionScope = Object.freeze({
      batonSessionId: registration.owner.batonSessionId,
      pluginInstanceId: registration.owner.pluginInstanceId,
      executionId: newId("pex"),
    });
    const context = createHookContext(
      stage,
      subject,
      this.snapshot(),
      scope,
      this.invokeVerb,
    );
    const startedAt = Date.now();
    this.writeLog(registration, stage, "started", scope.executionId);
    try {
      await this.verb.executeHook(scope, async () => {
        await this.withTimeout(
          Promise.resolve(registration.hook.run(context)),
          registration.hook.timeoutMs ?? this.defaultTimeoutMs,
        );
      });
      this.writeLog(registration, stage, "completed", scope.executionId, {
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      this.writeLog(registration, stage, "failed", scope.executionId, {
        durationMs: Date.now() - startedAt,
        error,
      });
    }
  }

  private async withTimeout(wait: Promise<void>, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        wait,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Hook timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private writeLog(
    registration: RegisteredHook,
    stage: HookStage,
    outcome: "started" | "completed" | "failed" | "dropped",
    executionId?: string,
    details?: { readonly durationMs?: number; readonly error?: unknown; readonly reason?: string },
  ): void {
    this.log?.({
      level: outcome === "failed" || outcome === "dropped" ? "warn" : "debug",
      source: "baton",
      component: "plugin.hook",
      message: `Plugin Hook ${outcome}`,
      pluginId: registration.owner.pluginId,
      pluginInstanceId: registration.owner.pluginInstanceId,
      ...(details?.error === undefined ? {} : { error: logError(details.error) }),
      attributes: {
        hookId: registration.hook.hookId,
        stage,
        outcome,
        ...(executionId === undefined ? {} : { executionId }),
        ...(details?.durationMs === undefined ? {} : { durationMs: details.durationMs }),
        ...(details?.reason === undefined ? {} : { reason: details.reason }),
      },
    });
  }
}
