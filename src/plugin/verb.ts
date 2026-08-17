import {
  MAIN_LANE_ID,
  MAX_VERB_TIMEOUT_MS,
  type AskInput,
  type AskResult,
  type AskValue,
  type ConfirmInput,
  type ConfirmResult,
  type DraftInput,
  type DraftResult,
  type HarnessInvocationInput,
  type HarnessResult,
  type HookContext,
  type HookStage,
  type HookSubjectMap,
  type PluginVerbs,
  type ReconcileContext,
} from "@compforge/baton-plugin";

import type { PromptBlock } from "../event/index.ts";
import type { InteractionResult } from "../interaction/types.ts";
import {
  ReconcileInteractionStore,
  type ReconcileInteractionStoreOptions,
} from "../interaction/reconcile.ts";
import {
  type LogSink,
  logError,
} from "../logging.ts";
import type { SessionHandle } from "../store/store.ts";
import {
  HarnessInvocationStore,
  type ScheduledHarnessInvocation,
} from "./harness-invocation.ts";
import type {
  ReconcileCapacity,
  ReconcileCapacityLease,
} from "./queue.ts";
import type { ReconcileSnapshot } from "./reconcile-snapshot.ts";

export interface ExecutionScope {
  readonly batonSessionId: string;
  readonly pluginInstanceId: string;
  /** Core-issued identity for one live Plugin execution. */
  readonly executionId: string;
}

/**
 * Plugin-facing typed Core verbs. Every operation-producing verb first becomes
 * an Interaction; draft/harness create a HarnessInvocation only after that gate
 * settles positively. Runner never sends an opaque message.
 */
export type VerbRequest =
  | {
      readonly verb: "ask";
      readonly input: AskInput;
    }
  | {
      readonly verb: "confirm";
      readonly input: ConfirmInput;
    }
  | {
      readonly verb: "draft";
      readonly input: DraftInput;
    }
  | {
      readonly verb: "harness";
      readonly input: HarnessInvocationInput;
    };

export type VerbResponse =
  | AskResult
  | ConfirmResult
  | DraftResult
  | HarnessResult;

export type InvokeVerb = (
  context: ExecutionScope,
  request: VerbRequest,
) => Promise<VerbResponse>;

const reconcileScopes = new WeakMap<ReconcileContext, ExecutionScope>();
const hookScopes = new WeakMap<HookContext, ExecutionScope>();

function nonEmpty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function validateAsk(input: AskInput): void {
  validateTimeout("ask", input.timeoutMs);
  nonEmpty("ask title", input.title);
  nonEmpty("ask prompt", input.prompt);
  if (input.choices === undefined) {
    if (input.allowOther !== true) {
      throw new Error("ask without choices must set allowOther to true");
    }
    return;
  }
  if (input.choices.length === 0) {
    throw new Error("ask choices must not be empty");
  }
  const values = new Set<string>();
  for (const choice of input.choices) {
    nonEmpty("ask choice value", choice.value);
    nonEmpty("ask choice label", choice.label);
    if (values.has(choice.value)) {
      throw new Error(`ask choice value is duplicated: ${choice.value}`);
    }
    values.add(choice.value);
  }
}

function validateConfirm(input: ConfirmInput): void {
  validateTimeout("confirm", input.timeoutMs);
  nonEmpty("confirm title", input.title);
  nonEmpty("confirm prompt", input.prompt);
  if (input.confirmLabel !== undefined) {
    nonEmpty("confirm confirmLabel", input.confirmLabel);
  }
  if (input.declineLabel !== undefined) {
    nonEmpty("confirm declineLabel", input.declineLabel);
  }
}

function validateTimeout(name: string, timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`${name} timeoutMs must be a positive integer`);
  }
  if (timeoutMs > MAX_VERB_TIMEOUT_MS) {
    throw new Error(
      `${name} timeoutMs must not exceed ${MAX_VERB_TIMEOUT_MS}`,
    );
  }
}

function validateHarness(input: HarnessInvocationInput): void {
  validateTimeout("harness", input.timeoutMs);
  nonEmpty("harness title", input.title);
  nonEmpty("harness prompt", input.prompt);
  nonEmpty("harness laneId", input.laneId);
  if (input.newLane !== undefined && typeof input.newLane !== "boolean") {
    throw new Error(`harness newLane is invalid: ${String(input.newLane)}`);
  }
  if (input.harnessTargetId !== undefined) {
    nonEmpty("harness harnessTargetId", input.harnessTargetId);
  }
}

function validateDraft(input: DraftInput): void {
  validateTimeout("draft", input.timeoutMs);
  nonEmpty("draft title", input.title);
  nonEmpty("draft prompt", input.prompt);
  if (input.harnessTargetId !== undefined) {
    nonEmpty("draft harnessTargetId", input.harnessTargetId);
  }
}

/** Host and Runner use the same facade; only the invocation transport differs. */
export function createPluginVerbs(
  scope: ExecutionScope,
  invoke: InvokeVerb,
): PluginVerbs {
  return Object.freeze({
    async ask<const TInput extends AskInput>(input: TInput) {
      validateAsk(input);
      return await invoke(scope, {
        verb: "ask",
        input,
      }) as AskResult<AskValue<TInput>>;
    },
    async confirm(input: ConfirmInput) {
      validateConfirm(input);
      return await invoke(scope, {
        verb: "confirm",
        input,
      }) as ConfirmResult;
    },
    async draft(input: DraftInput) {
      validateDraft(input);
      return await invoke(scope, {
        verb: "draft",
        input,
      }) as DraftResult;
    },
    async harness(input: HarnessInvocationInput) {
      validateHarness(input);
      return await invoke(scope, {
        verb: "harness",
        input,
      }) as HarnessResult;
    },
  });
}

export function createReconcileContext(
  snapshot: ReconcileSnapshot,
  scope: ExecutionScope,
  invoke: InvokeVerb,
): ReconcileContext {
  const context = Object.freeze({
    snapshot,
    verbs: createPluginVerbs(scope, invoke),
  });
  reconcileScopes.set(context, scope);
  return context;
}

export function createHookContext<S extends HookStage>(
  stage: S,
  subject: Readonly<HookSubjectMap[S]>,
  snapshot: ReconcileSnapshot,
  scope: ExecutionScope,
  invoke: InvokeVerb,
): HookContext<S> {
  const context = Object.freeze({
    stage,
    subject,
    snapshot,
    verbs: createPluginVerbs(scope, invoke),
  });
  hookScopes.set(context, scope);
  return context;
}

export function reconcileScope(context: ReconcileContext): ExecutionScope {
  const scope = reconcileScopes.get(context);
  if (!scope) throw new Error("reconcile scope is unavailable");
  return scope;
}

export function reconcileSnapshot(context: ReconcileContext): ReconcileSnapshot {
  return context.snapshot;
}

export function hookScope(context: HookContext): ExecutionScope {
  const scope = hookScopes.get(context);
  if (!scope) throw new Error("hook scope is unavailable");
  return scope;
}

type VerbSession = Pick<
  SessionHandle,
  "id" | "ledger" | "appendEvent" | "subscribe" | "requireLane"
>;

interface ActiveExecution {
  readonly scope: ExecutionScope;
  suspend<T>(wait: Promise<T>): Promise<T>;
}

export interface VerbOptions {
  session?: VerbSession;
  capacity: ReconcileCapacity;
  snapshot: () => ReconcileSnapshot;
  selectedHarnessTargetId?: () => string | undefined;
  harnessInvocationGate?:
    ReconcileInteractionStoreOptions["harnessInvocationGate"];
  enqueueHarnessInvocation?(
    request: ScheduledHarnessInvocation,
  ): Promise<unknown> | void;
  cancelHarnessInvocation?(
    harnessInvocationId: string,
  ): "queued" | "running" | undefined;
  now?: () => Date;
  log?: LogSink;
}

/** Plugin typed verbs and the live executions suspended while those verbs settle. */
export class Verb {
  private readonly capacity: ReconcileCapacity;
  private readonly snapshot: () => ReconcileSnapshot;
  private readonly selectedHarnessTargetId?: () => string | undefined;
  private readonly interactions?: ReconcileInteractionStore;
  private readonly harnessInvocations?: HarnessInvocationStore;
  private readonly enqueueHarnessInvocation:
    VerbOptions["enqueueHarnessInvocation"];
  private readonly cancelHostHarnessInvocation:
    VerbOptions["cancelHarnessInvocation"];
  private readonly dispatchedHarnessInvocations = new Set<string>();
  private readonly executions = new Map<string, ActiveExecution>();
  private readonly now: () => Date;
  private readonly log?: LogSink;

  constructor(options: VerbOptions) {
    this.capacity = options.capacity;
    this.snapshot = options.snapshot;
    this.selectedHarnessTargetId = options.selectedHarnessTargetId;
    this.enqueueHarnessInvocation = options.enqueueHarnessInvocation;
    this.cancelHostHarnessInvocation = options.cancelHarnessInvocation;
    this.now = options.now ?? (() => new Date());
    this.log = options.log;
    if (options.session) {
      this.interactions = new ReconcileInteractionStore(options.session, {
        now: this.now,
        harnessInvocationGate: options.harnessInvocationGate,
      });
      this.harnessInvocations = new HarnessInvocationStore(options.session);
    }
  }

  listHarnessInvocations() {
    return this.harnessInvocations?.list() ?? [];
  }

  completeInteraction(
    interactionId: string,
    result: InteractionResult,
  ): boolean {
    return this.interactions?.complete(interactionId, result) ?? false;
  }

  cancelHarnessInvocation(identifier?: string): boolean {
    const request = this.harnessInvocations?.latestCancellable(
      identifier?.trim() || undefined,
    );
    if (!request || !this.harnessInvocations) return false;

    const cancelled = this.harnessInvocations.cancel(
      request.invocationId,
      "user",
    );
    this.cancelHostHarnessInvocation?.(request.invocationId);
    return cancelled;
  }

  async invoke(
    context: ExecutionScope,
    request: VerbRequest,
  ): Promise<VerbResponse> {
    const execution = this.executions.get(context.executionId);
    if (
      !execution ||
      execution.scope.pluginInstanceId !== context.pluginInstanceId ||
      execution.scope.batonSessionId !== context.batonSessionId
    ) {
      throw new Error(`Plugin execution is not active: ${context.executionId}`);
    }
    const operation = this.perform(context, request).catch((error) =>
      Object.freeze({
        state: "failure" as const,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return await execution.suspend(operation);
  }

  async execute<T>(
    scope: ExecutionScope,
    localLease: ReconcileCapacityLease,
    execute: () => Promise<T>,
  ): Promise<T> {
    return await this.capacity.run(async (globalLease) => {
      return await this.trackExecution(
        scope,
        async <U>(wait: Promise<U>): Promise<U> =>
          await globalLease.suspend(localLease.suspend(wait)),
        execute,
      );
    });
  }

  /** Hook notification does not consume the reconcile workqueue capacity. */
  async executeHook<T>(
    scope: ExecutionScope,
    execute: () => Promise<T>,
  ): Promise<T> {
    return await this.trackExecution(scope, async (wait) => await wait, execute);
  }

  failInstance(pluginInstanceId: string, error: string): void {
    for (const execution of this.executions.values()) {
      if (execution.scope.pluginInstanceId !== pluginInstanceId) continue;
      this.failExecution(execution.scope.executionId, error);
    }
  }

  failAll(error: string): void {
    for (const execution of this.executions.values()) {
      this.failExecution(execution.scope.executionId, error);
    }
  }

  failOrphans(): void {
    this.interactions?.failOrphans(
      "Plugin execution was interrupted by Core restart",
    );
    this.harnessInvocations?.failOrphans(
      "Plugin execution was interrupted by Core restart",
    );
  }

  close(): void {
    this.interactions?.close();
    this.harnessInvocations?.close();
  }

  private async perform(
    context: ExecutionScope,
    request: VerbRequest,
  ): Promise<VerbResponse> {
    if (!this.interactions) {
      throw new Error(
        `Plugin verb ${request.verb}() requires a SessionHandle`,
      );
    }
    if (request.verb === "ask") {
      return await this.interactions.ask(context, request.input);
    }
    if (request.verb === "confirm") {
      return await this.interactions.confirm(context, request.input);
    }
    if (!this.harnessInvocations || !this.enqueueHarnessInvocation) {
      throw new Error(
        `Plugin verb ${request.verb}() requires HarnessInvocation support`,
      );
    }

    const deadline = this.timestamp() + request.input.timeoutMs;
    let harnessTargetId: string;
    let draftBlocks: readonly PromptBlock[] | undefined;
    if (request.verb === "draft") {
      const interaction = await this.interactions.draft(
        context,
        request.input,
      );
      if (interaction.state !== "success") return interaction;
      draftBlocks = interaction.value.blocks;
      const target = request.input.harnessTargetId ??
        this.selectedHarnessTargetId?.();
      if (!target) {
        throw new Error(
          "draft() requires a HarnessTarget selection on submission",
        );
      }
      harnessTargetId = target;
    } else {
      const target = request.input.harnessTargetId ??
        this.selectedHarnessTargetId?.();
      if (!target) {
        throw new Error("harness() requires a HarnessTarget selection");
      }
      harnessTargetId = target;
      const interaction = await this.interactions.harness(
        context,
        { ...request.input, harnessTargetId },
      );
      if (interaction.state !== "success") return interaction;
      if (interaction.value === "declined") {
        return Object.freeze({
          state: "success",
          value: { outcome: "declined" as const },
        });
      }
    }
    if (
      !this.snapshot().harnessTargets.some(
        (target) => target.id === harnessTargetId,
      )
    ) {
      throw new Error(
        `${request.verb}() references unknown HarnessTarget: ${harnessTargetId}`,
      );
    }
    const snapshot = this.harnessInvocations.record({
      scope: context,
      invocation: {
        verb: request.verb,
        title: request.input.title,
        prompt: request.input.prompt,
        ...(draftBlocks === undefined ? {} : { blocks: draftBlocks }),
        laneId: request.verb === "draft" ? MAIN_LANE_ID : request.input.laneId,
        newLane: request.verb === "draft"
          ? false
          : (request.input.newLane ?? false),
        harnessTargetId,
      },
    });
    const scheduled = this.harnessInvocations.scheduled(snapshot.invocationId);
    if (scheduled) this.dispatchHarnessInvocation(scheduled);
    const terminal = await this.waitForHarnessInvocation(
      snapshot.invocationId,
      deadline,
    );
    if (terminal.phase === "completed" && terminal.result && terminal.laneId) {
      return Object.freeze({
        state: "success",
        value: {
          outcome: "completed" as const,
          laneId: terminal.laneId,
          turn: terminal.result,
        },
      });
    }
    if (terminal.phase === "cancelled") {
      if (terminal.cancellation?.reason === "user") {
        return Object.freeze({ state: "dismissed" });
      }
      if (terminal.cancellation?.reason === "timeout") {
        return Object.freeze({ state: "timeout" });
      }
      return Object.freeze({
        state: "failure",
        ...(terminal.cancellation?.detail === undefined
          ? {}
          : { error: terminal.cancellation.detail }),
      });
    }
    return Object.freeze({
      state: "failure",
      ...(terminal.failure?.detail === undefined
        ? {}
        : { error: terminal.failure.detail }),
    });
  }

  private async trackExecution<T>(
    scope: ExecutionScope,
    suspend: ActiveExecution["suspend"],
    execute: () => Promise<T>,
  ): Promise<T> {
    if (this.executions.has(scope.executionId)) {
      throw new Error(`Plugin execution already exists: ${scope.executionId}`);
    }
    this.executions.set(scope.executionId, { scope, suspend });
    let failure = "Plugin execution completed before its verb";
    try {
      return await execute();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.failExecution(scope.executionId, failure);
      this.executions.delete(scope.executionId);
    }
  }

  private async waitForHarnessInvocation(
    invocationId: string,
    deadline: number,
  ) {
    if (!this.harnessInvocations) {
      throw new Error("HarnessInvocation store is unavailable");
    }
    const remaining = deadline - this.timestamp();
    if (remaining <= 0) {
      this.harnessInvocations.cancel(invocationId, "timeout");
      this.cancelHostHarnessInvocation?.(invocationId);
      return await this.harnessInvocations.wait(invocationId);
    }
    const timer = setTimeout(() => {
      if (this.harnessInvocations?.cancel(invocationId, "timeout")) {
        this.cancelHostHarnessInvocation?.(invocationId);
      }
    }, remaining);
    timer.unref?.();
    try {
      return await this.harnessInvocations.wait(invocationId);
    } finally {
      clearTimeout(timer);
    }
  }

  private timestamp(): number {
    const value = this.now().getTime();
    if (Number.isNaN(value)) {
      throw new Error("plugin Verb now() returned an invalid Date");
    }
    return value;
  }

  private failExecution(executionId: string, error: string): void {
    this.interactions?.failExecution(executionId, error);
    for (
      const invocationId of
        this.harnessInvocations?.failExecution(executionId, error) ?? []
    ) {
      this.cancelHostHarnessInvocation?.(invocationId);
    }
  }

  private dispatchHarnessInvocation(request: ScheduledHarnessInvocation): void {
    if (
      !this.enqueueHarnessInvocation ||
      this.dispatchedHarnessInvocations.has(request.invocationId)
    ) {
      return;
    }
    this.dispatchedHarnessInvocations.add(request.invocationId);
    void Promise.resolve()
      .then(() => this.enqueueHarnessInvocation!(request))
      .catch((error) => {
        this.harnessInvocations?.fail(
          request.invocationId,
          "dispatch",
          error instanceof Error ? error.message : String(error),
        );
        this.log?.({
          level: "error",
          source: "baton",
          component: "plugin.harness-invocation",
          message: "HarnessInvocation dispatch failed",
          pluginInstanceId: request.pluginInstanceId,
          turnId: request.turnId,
          harnessTargetId: request.harnessTargetId,
          error: logError(error),
          attributes: { harnessInvocationId: request.invocationId },
        });
      });
  }
}
