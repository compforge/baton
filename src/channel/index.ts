import type {
  HookStage,
  HookSubjectMap,
  HumanInput,
  HumanInputRecord,
  HumanInputSettlement,
  HumanPresentation,
} from "@compforge/baton-plugin";
import { AsyncLocalStorage } from "node:async_hooks";

import { newId } from "../event/ids.ts";
import { logError } from "../logging.ts";
import type { SessionHandle } from "../store/store.ts";

export interface ChannelHookGateway {
  has(stage: HookStage): boolean;
  before<S extends Extract<HookStage, `${string}.before`>>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): Promise<void>;
  after<S extends Extract<HookStage, `${string}.after`>>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): void;
}

export interface ChannelOptions {
  readonly session: SessionHandle;
}

/**
 * BatonSession 的双向协调边界。
 *
 * inbound 将已类型化的 Human Input 送到末端 handler；outbound 将 Core
 * Projection 交给上游 surface。Hook 只观察这条主链，动作仍必须通过 Verb
 * 回到 Core。Queue、Controller 和 Harness 继续拥有各自的调度与执行职责。
 * Channel 借用 inbound/outbound 语义，不提供可任意组装的 handler pipeline。
 */
export class Channel implements ChannelHookGateway {
  private hooks: ChannelHookGateway | undefined;
  private presentationRevision = 0;
  private readonly outboundHookScope = new AsyncLocalStorage<boolean>();

  constructor(private readonly options: ChannelOptions) {}

  /** Attach the active Plugin Hook boundary without coupling Channel to Manager. */
  connect(hooks: ChannelHookGateway): void {
    this.hooks = hooks;
  }

  disconnect(): void {
    this.hooks = undefined;
  }

  /**
   * Process one request down the inbound path and return its terminal result.
   * The original fact and terminal settlement are durable before their Hooks.
   */
  async inbound<T>(
    input: HumanInput,
    handle: (record: HumanInputRecord) => Promise<T>,
  ): Promise<T> {
    const inputId = newId("in");
    const received = this.options.session.appendEvent({
      kind: "input.received",
      source: { type: "user" },
      payload: { inputId, input },
    });
    const record: HumanInputRecord = Object.freeze({
      inputId,
      eventId: received.eventId,
      seq: received.seq,
      input,
    });

    await this.notifyBefore("human.inbound.before", record);
    try {
      const result = await handle(record);
      this.settle(record, "succeeded");
      return result;
    } catch (error) {
      this.settle(
        record,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  /**
   * Send one response up the outbound path. Reentrant publication skips the
   * same before Hook so a Hook-created Interaction can become visible and
   * unblock the Hook that requested it.
   */
  async outbound(
    kind: HumanPresentation["kind"],
    publish: () => boolean,
  ): Promise<boolean> {
    const presentation: HumanPresentation = Object.freeze({
      presentationId: newId("hp"),
      kind,
      revision: ++this.presentationRevision,
    });
    if (!this.publishingFromHook && this.has("human.outbound.before")) {
      await this.outboundHookScope.run(
        true,
        () => this.notifyBefore("human.outbound.before", presentation),
      );
    }
    const published = publish();
    if (published) this.notifyAfter("human.outbound.after", presentation);
    return published;
  }

  /** Whether outbound is inside its before coordination window. */
  get publishingFromHook(): boolean {
    return this.outboundHookScope.getStore() === true;
  }

  has(stage: HookStage): boolean {
    try {
      return this.hooks?.has(stage) ?? false;
    } catch (error) {
      this.logFailure(stage, error);
      return false;
    }
  }

  async before<S extends Extract<HookStage, `${string}.before`>>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): Promise<void> {
    await this.notifyBefore(stage, subject);
  }

  after<S extends Extract<HookStage, `${string}.after`>>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): void {
    this.notifyAfter(stage, subject);
  }

  private settle(
    record: HumanInputRecord,
    outcome: HumanInputSettlement["outcome"],
    detail?: string,
  ): void {
    const settled = this.options.session.appendEvent({
      kind: "input.settled",
      source: { type: "baton" },
      parentEventId: record.eventId,
      payload: {
        inputId: record.inputId,
        outcome,
        ...(detail === undefined ? {} : { detail }),
      },
    });
    this.notifyAfter("human.inbound.after", Object.freeze({
      inputId: record.inputId,
      eventId: settled.eventId,
      seq: settled.seq,
      outcome,
      ...(detail === undefined ? {} : { detail }),
    }));
  }

  private async notifyBefore<S extends Extract<HookStage, `${string}.before`>>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): Promise<void> {
    try {
      await this.hooks?.before(stage, subject);
    } catch (error) {
      this.logFailure(stage, error);
    }
  }

  private notifyAfter<S extends Extract<HookStage, `${string}.after`>>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): void {
    try {
      this.hooks?.after(stage, subject);
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
