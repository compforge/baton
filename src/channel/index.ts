import type {
  DeferredHookStage,
  HookStage,
  HookSubjectMap,
  InlineHookStage,
  ViewInput,
  ViewInputRecord,
  ViewOutput,
} from "@compforge/baton-plugin";

import {
  Controller,
  type ControllerOptions,
  type SendTurnOptions,
  type SendTurnOutcome,
} from "../controller/index.ts";
import { newId } from "../event/ids.ts";
import type {
  AnyEventEnvelope,
  PromptBlock,
  ViewInputOutcome,
} from "../event/index.ts";
import type { HarnessTarget } from "../harness/target.ts";
import type { InteractionResult } from "../interaction/types.ts";
import { logError } from "../logging.ts";
import { Manager, type ManagerOptions } from "../plugin/manager.ts";
import { createReconcileSnapshot } from "../plugin/reconcile-snapshot.ts";
import type { SessionState } from "../store/reduce.ts";
import type { SessionHandle } from "../store/store.ts";

export interface ChannelHookGateway {
  has(stage: HookStage): boolean;
  inline<S extends InlineHookStage>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): Promise<void>;
  defer<S extends DeferredHookStage>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): void;
}

export type ChannelLifecycle = "open" | "closing" | "closed";

export type ChannelControllerOptions = Omit<
  ControllerOptions,
  "session" | "hooks"
>;

export type ChannelPluginOptions = Omit<
  ManagerOptions,
  | "session"
  | "snapshot"
  | "enqueueHarnessInvocation"
  | "cancelHarnessInvocation"
  | "harnessTargets"
> & {
  /** Targets exposed in the frozen Plugin snapshot. */
  readonly harnessTargets?: readonly (HarnessTarget & {
    readonly label?: string;
  })[];
};

export interface ChannelOptions {
  readonly session: SessionHandle;
  readonly controller: ChannelControllerOptions;
  readonly plugins?: ChannelPluginOptions;
  /** Test/embedder Hook boundary when no Plugin Manager is composed. */
  readonly hooks?: ChannelHookGateway;
}

export interface DispatchReceipt<T> {
  /** Durable ViewInput accepted by this Channel. */
  readonly input: ViewInputRecord;
  readonly accepted: true;
  /** Immediate receipt from the state owner; long-running settlement stays separate. */
  readonly result: T;
}

export type ChannelProjectionListener = (
  projection: SessionState,
  event: AnyEventEnvelope,
) => void;

/** Same-process guard complementing SessionHandle's cross-process lease. */
const activeSessionChannels = new Set<string>();

/**
 * One BatonSession lease 的活跃协调边界与 composition root。
 *
 * Channel 装配 Controller、Plugin Manager、Hook gateway 和 Interaction 路由，
 * 并为 ViewInput 提供固定的 typed path。它只拥有进程期生命周期和组件引用；
 * Session、Queue、Turn、Interaction、Resource 的可恢复状态和状态机仍归原 owner。
 */
export class Channel implements ChannelHookGateway {
  readonly controller: Controller;
  readonly pluginManager: Manager | undefined;

  private hooks: ChannelHookGateway | undefined;
  private lifecycleState: ChannelLifecycle = "open";
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private viewOutputRevision = 0;
  private readonly subscriptions = new Set<() => void>();

  constructor(private readonly options: ChannelOptions) {
    if (options.plugins && options.hooks) {
      throw new Error("Channel plugins and external hooks cannot both be configured");
    }
    if (activeSessionChannels.has(options.session.dir)) {
      throw new Error(`BatonSession already has an active Channel: ${options.session.id}`);
    }
    // openBatonSession may already hold the process lease after recovery. The
    // Channel becomes its sole live owner and always releases it from close().
    options.session.acquireLock();
    activeSessionChannels.add(options.session.dir);
    try {
      this.controller = new Controller({
        ...options.controller,
        session: options.session,
        hooks: this,
      });
      this.pluginManager = options.plugins
        ? this.createPluginManager(options.plugins)
        : undefined;
      this.hooks = this.pluginManager
        ? this.pluginHooks(this.pluginManager)
        : options.hooks;
    } catch (error) {
      activeSessionChannels.delete(options.session.dir);
      options.session.releaseLock();
      throw error;
    }
  }

  get lifecycle(): ChannelLifecycle {
    return this.lifecycleState;
  }

  /** Current Session-owned Projection; Channel does not copy or own it. */
  get projection(): SessionState {
    return this.options.session.projection;
  }

  /** Start active Plugin bindings after the Human surface is subscribed. */
  start(): Promise<void> {
    this.assertOpen();
    if (!this.pluginManager) return Promise.resolve();
    this.startPromise ??= this.pluginManager.start();
    return this.startPromise;
  }

  /** Observe Session projection changes through the active Channel lifetime. */
  subscribe(listener: ChannelProjectionListener): () => void {
    this.assertOpen();
    const unsubscribeSession = this.options.session.subscribe((event) => {
      listener(this.options.session.projection, event);
    });
    const unsubscribe = () => {
      if (!this.subscriptions.delete(unsubscribe)) return;
      unsubscribeSession();
    };
    this.subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  /**
   * Accept one prompt, prepare its Harness blocks after WAL intake, then let
   * Controller own Queue admission and Turn execution. Target resolution runs
   * after inline view.input Hooks so an awaited Resource patch affects this input.
   */
  submitPrompt(
    input: Extract<ViewInput, { kind: "prompt" }>,
    prepare: (record: ViewInputRecord) => Promise<PromptBlock[]>,
    options?: Omit<SendTurnOptions, "parentEventId">,
  ): Promise<DispatchReceipt<SendTurnOutcome>> {
    return this.dispatch(input, async (record) =>
      await this.controller.sendTurn(
        this.pluginManager?.resolveHarnessTargetId(input.harnessTargetId) ??
          input.harnessTargetId,
        await prepare(record),
        { ...options, parentEventId: record.eventId },
      ));
  }

  /** Run a closed-set command lowering supplied by the Human surface. */
  dispatchCommand<T>(
    input: Extract<ViewInput, { kind: "command" }>,
    execute: (record: ViewInputRecord) => Promise<T>,
  ): Promise<DispatchReceipt<T>> {
    return this.dispatch(input, execute);
  }

  /** Apply one typed configuration input through its concrete setting owner. */
  dispatchConfiguration<T>(
    input: Extract<ViewInput, { kind: "configuration" }>,
    apply: (record: ViewInputRecord) => Promise<T>,
  ): Promise<DispatchReceipt<T>> {
    return this.dispatch(input, apply);
  }

  /** Route an Interaction answer to the requester that owns its continuation. */
  resolveInteraction(
    input: Extract<ViewInput, { kind: "interaction_response" }>,
    prepare: (record: ViewInputRecord) => Promise<InteractionResult | undefined>,
  ): Promise<DispatchReceipt<boolean>> {
    return this.dispatch(input, async (record) => {
      const interaction = this.options.session.projection.interactions.get(
        input.interactionId,
      )?.interaction;
      const result = await prepare(record);
      if (!interaction || !result) return false;
      const completed = interaction.requester.type === "plugin"
        ? await this.pluginManager?.completeInteraction(
          input.interactionId,
          result,
        ) ?? false
        : this.controller.completeInteraction(input.interactionId, result);
      if (
        completed &&
        result.kind === "cancelled" &&
        interaction.requester.type === "harness"
      ) {
        await this.controller.control({ kind: "interrupt" });
      }
      return completed;
    });
  }

  /** Interrupt the active main-Lane Queue run; Turn settlement remains owner-driven. */
  interrupt(
    input: Extract<ViewInput, { kind: "interrupt" }>,
  ): Promise<DispatchReceipt<void>> {
    return this.dispatch(input, async () => {
      await this.controller.control({ kind: "interrupt" });
    });
  }

  /** Publish one ViewOutput, then notify Plugins of that observation. */
  async publishViewOutput(
    kind: ViewOutput["kind"],
    publish: () => boolean,
  ): Promise<boolean> {
    if (this.lifecycleState !== "open") return false;
    const output: ViewOutput = Object.freeze({
      outputId: newId("vo"),
      kind,
      revision: ++this.viewOutputRevision,
    });
    const published = publish();
    if (published) {
      this.notifyDeferred("view.output", output);
    }
    return published;
  }

  has(stage: HookStage): boolean {
    try {
      return this.hooks?.has(stage) ?? false;
    } catch (error) {
      this.logFailure(stage, error);
      return false;
    }
  }

  async inline<S extends InlineHookStage>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): Promise<void> {
    await this.notifyInline(stage, subject);
  }

  defer<S extends DeferredHookStage>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): void {
    this.notifyDeferred(stage, subject);
  }

  /**
   * Stop intake once, close the composed components, flush the Session, and
   * release its lease. The same Promise is the stable close settlement.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifecycleState = "closing";
    this.closePromise = this.closeActive();
    return this.closePromise;
  }

  private async dispatch<T>(
    input: ViewInput,
    handle: (record: ViewInputRecord) => Promise<T>,
  ): Promise<DispatchReceipt<T>> {
    this.assertOpen();
    const inputId = newId("in");
    const received = this.options.session.appendEvent({
      kind: "input.received",
      source: { type: "user" },
      payload: { inputId, input },
    });
    const record: ViewInputRecord = Object.freeze({
      inputId,
      eventId: received.eventId,
      seq: received.seq,
      input,
    });

    await this.notifyInline("view.input", record);
    try {
      const result = await handle(record);
      this.settle(record, "succeeded");
      return Object.freeze({ input: record, accepted: true, result });
    } catch (error) {
      this.settle(
        record,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private createPluginManager(options: ChannelPluginOptions): Manager {
    const { harnessTargets = [], ...manager } = options;
    return new Manager({
      ...manager,
      session: this.options.session,
      harnessTargets,
      snapshot: () =>
        createReconcileSnapshot({
          batonSessionId: this.options.session.id,
          cwd: this.options.session.meta.cwd,
          state: this.options.session.projection,
          harnessInputs: this.controller.harnessInputs,
          harnessTargets,
        }),
      enqueueHarnessInvocation: (request) => {
        this.assertOpen();
        return this.controller.enqueueHarnessInvocation({
          harnessInvocationId: request.invocationId,
          pluginInstanceId: request.pluginInstanceId,
          harnessTargetId: request.harnessTargetId,
          laneId: request.laneId,
          newLane: request.newLane,
          ...(request.parentLaneId === undefined
            ? {}
            : { parentLaneId: request.parentLaneId }),
          source: request.source === "user"
            ? { type: "user" }
            : {
                type: "plugin",
                pluginInstanceId: request.pluginInstanceId,
              },
          messageId: request.messageId,
          turnId: request.turnId,
          blocks: [...request.blocks],
        });
      },
      cancelHarnessInvocation: (requestId) => {
        if (this.lifecycleState !== "open") return undefined;
        return this.controller.cancelHarnessInvocation(requestId);
      },
    });
  }

  private pluginHooks(manager: Manager): ChannelHookGateway {
    return {
      has: (stage) => manager.hasHook(stage),
      inline: (stage, subject) => manager.inlineHook(stage, subject),
      defer: (stage, subject) => manager.deferHook(stage, subject),
    };
  }

  private async closeActive(): Promise<void> {
    for (const unsubscribe of [...this.subscriptions]) unsubscribe();
    const errors: unknown[] = [];
    // Manager.close() marks the Plugin boundary closed synchronously before
    // awaiting Binding teardown. Start it first so no new Verb/Source work can
    // race Harness shutdown, but let both component trees drain together.
    const pluginsClosing = this.pluginManager?.close().catch((error) => {
      errors.push(error);
    });
    try {
      await this.controller.close();
    } catch (error) {
      errors.push(error);
    }
    await pluginsClosing;
    this.hooks = undefined;
    this.options.session.log({
      level: "info",
      source: "baton",
      component: "channel.lifecycle",
      message: "Channel closed",
    });
    try {
      await this.options.session.closeLogs();
    } catch (error) {
      errors.push(error);
    } finally {
      activeSessionChannels.delete(this.options.session.dir);
      this.options.session.releaseLock();
      this.lifecycleState = "closed";
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "could not close Channel");
    }
  }

  private assertOpen(): void {
    if (this.lifecycleState !== "open") {
      throw new Error(`Channel is ${this.lifecycleState}`);
    }
  }

  private settle(
    record: ViewInputRecord,
    outcome: ViewInputOutcome,
    detail?: string,
  ): void {
    this.options.session.appendEvent({
      kind: "input.settled",
      source: { type: "baton" },
      parentEventId: record.eventId,
      payload: {
        inputId: record.inputId,
        outcome,
        ...(detail === undefined ? {} : { detail }),
      },
    });
  }

  private async notifyInline<S extends InlineHookStage>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): Promise<void> {
    try {
      await this.hooks?.inline(stage, subject);
    } catch (error) {
      this.logFailure(stage, error);
    }
  }

  private notifyDeferred<S extends DeferredHookStage>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): void {
    try {
      this.hooks?.defer(stage, subject);
    } catch (error) {
      this.logFailure(stage, error);
    }
  }

  private logFailure(stage: HookStage, error: unknown): void {
    this.options.session.log({
      level: "warn",
      source: "baton",
      component: "channel",
      message: "Channel Hook gateway failed open",
      error: logError(error),
      attributes: { stage },
    });
  }
}
