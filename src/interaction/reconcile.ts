import type {
  AskChoice,
  AskInput,
  AskResult,
  ConfirmInput,
  ConfirmResult,
  DraftInput,
  HarnessInvocationInput,
  VerbResult,
} from "@compforge/baton-plugin";

import { resolutionEvent, requestResult } from "./resolution.ts";
import { actorOf } from "../message/actor.ts";
import { createInputRequest } from "../message/project.ts";
import type { InputRequest } from "../message/types.ts";
import type {
  AnyEventEnvelope,
  EventSource,
} from "../event/index.ts";
import type { PromptBlock } from "../input/blocks.ts";
import type { ExecutionScope } from "../plugin/verb.ts";
import type { SessionHandle } from "../store/store.ts";
import type {
  InteractionDraft,
  InteractionCancellationReason,
  InteractionResult,
  QuestionChoice,
} from "./types.ts";

const QUESTION_ID = "decision";
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type InteractionSession = Pick<
  SessionHandle,
  "id" | "projection" | "appendEvent" | "subscribe"
>;

interface PluginQuestionInput {
  readonly verb: "ask" | "confirm";
  readonly title: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly choices?: readonly AskChoice[];
  readonly allowOther?: boolean;
}

type PluginInteractionRequest =
  | {
      readonly kind: "question";
      readonly verb: "ask" | "confirm";
      readonly title: string;
      readonly prompt: string;
      readonly timeoutMs: number;
      readonly choices?: readonly AskChoice[];
      readonly allowOther?: boolean;
    }
  | {
      readonly kind: "suggested_input";
      readonly verb: "draft";
      readonly title: string;
      readonly prompt: string;
      readonly timeoutMs: number;
      readonly harnessTargetId?: string;
    }
  | {
      readonly kind: "harness_invocation";
      readonly verb: "harness";
      readonly title: string;
      readonly prompt: string;
      readonly timeoutMs: number;
      readonly laneId: string;
      readonly newLane: boolean;
      readonly harnessTargetId?: string;
    };

export type ReconcileDraftInteractionResult = VerbResult<{
  readonly blocks: readonly PromptBlock[];
}>;

export type ReconcileHarnessGateResult = VerbResult<"approved" | "declined">;

export interface ReconcileInteractionStoreOptions {
  now?: () => Date;
  harnessInvocationGate?(
    interaction: InputRequest & { request: Extract<InteractionDraft, { kind: "harness_invocation" }> },
  ): "auto_approve" | "require_user";
}

function pluginRequestContent(request: PluginInteractionRequest): InteractionDraft {
  if (request.kind === "suggested_input") {
    return Object.freeze({
      kind: "suggested_input",
      title: request.title,
      text: request.prompt,
      ...(request.harnessTargetId === undefined
        ? {}
        : { harnessTargetId: request.harnessTargetId }),
    });
  }
  if (request.kind === "harness_invocation") {
    return Object.freeze({
      kind: "harness_invocation",
      title: request.title,
      prompt: request.prompt,
      laneId: request.laneId,
      newLane: request.newLane,
      ...(request.harnessTargetId === undefined
        ? {}
        : { harnessTargetId: request.harnessTargetId }),
    });
  }
  return Object.freeze({
    kind: "question",
    questions: [
      {
        questionId: QUESTION_ID,
        header: request.title,
        question: request.prompt,
        ...(request.choices === undefined
          ? {}
          : {
              choices: request.choices.map((choice) => ({
                value: choice.value,
                label: choice.label,
                ...(choice.description === undefined
                  ? {}
                  : { description: choice.description }),
              } satisfies QuestionChoice)),
            }),
        ...(request.allowOther === undefined
          ? {}
          : { allowOther: request.allowOther }),
      },
    ],
  });
}

function cancelledResult<T>(
  reason: InteractionCancellationReason,
  detail?: string,
): VerbResult<T> {
  if (reason === "user") return Object.freeze({ state: "dismissed" });
  if (reason === "timeout") return Object.freeze({ state: "timeout" });
  return Object.freeze({
    state: "failure",
    ...(detail === undefined ? {} : { error: detail }),
  });
}

/**
 * @spec A Plugin Interaction appends its first terminal fact to the Event Ledger before resolving any suspended continuation; later terminal attempts cannot replace it.
 * @rule Keep the Event Ledger as the durable fact store, not a continuation store: recovery must fail orphaned Plugin Interactions instead of reviving an old call stack.
 */
export class ReconcileInteractionStore {
  private get entries() { return this.session.projection.interactions; }
  private readonly waiters = new Map<
    string,
    Set<(result: InteractionResult) => void>
  >();
  private readonly unsubscribe: () => void;
  private readonly now: () => Date;
  private readonly harnessInvocationGate: NonNullable<
    ReconcileInteractionStoreOptions["harnessInvocationGate"]
  >;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly session: InteractionSession,
    options: ReconcileInteractionStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.harnessInvocationGate = options.harnessInvocationGate ??
      (() => "auto_approve");
    this.arm();
    this.unsubscribe = session.subscribe((event) => this.apply(event));
  }

  async ask(
    scope: ExecutionScope,
    input: AskInput,
  ): Promise<AskResult> {
    return await this.question(scope, {
      verb: "ask",
      title: input.title,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs,
      ...(input.choices === undefined
        ? {}
        : { choices: input.choices.map((choice) => ({ ...choice })) }),
      ...(input.allowOther === undefined
        ? {}
        : { allowOther: input.allowOther }),
    });
  }

  async confirm(
    scope: ExecutionScope,
    input: ConfirmInput,
  ): Promise<ConfirmResult> {
    const result = await this.question(scope, {
      verb: "confirm",
      title: input.title,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs,
      choices: [
        { value: "accept", label: input.confirmLabel ?? "Accept" },
        { value: "decline", label: input.declineLabel ?? "Decline" },
      ],
    });
    if (result.state !== "success") return result;
    return Object.freeze({
      state: "success",
      value: result.value === "accept" ? "accepted" : "declined",
    });
  }

  async draft(
    scope: ExecutionScope,
    input: DraftInput,
  ): Promise<ReconcileDraftInteractionResult> {
    const interaction = this.open(scope, {
      kind: "suggested_input",
      verb: "draft",
      title: input.title,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs,
      ...(input.harnessTargetId === undefined
        ? {}
        : { harnessTargetId: input.harnessTargetId }),
    });
    const result = await this.waitFor(interaction.messageId);
    if (result.kind === "cancelled") {
      return cancelledResult(result.reason, result.detail);
    }
    if (result.kind !== "suggested_input") {
      return Object.freeze({
        state: "failure",
        error: "draft Interaction returned an invalid result",
      });
    }
    if (result.outcome === "dismissed") {
      return Object.freeze({ state: "dismissed" });
    }
    return Object.freeze({
      state: "success",
      value: {
        blocks: Object.freeze(
          result.blocks.map((block) => Object.freeze({ ...block })),
        ),
      },
    });
  }

  async harness(
    scope: ExecutionScope,
  input: HarnessInvocationInput,
  ): Promise<ReconcileHarnessGateResult> {
    const interaction = this.open(scope, {
      kind: "harness_invocation",
      verb: "harness",
      title: input.title,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs,
      laneId: input.laneId,
      newLane: input.newLane ?? false,
      ...(input.harnessTargetId === undefined
        ? {}
        : { harnessTargetId: input.harnessTargetId }),
    });
    if (
      interaction.request.kind === "harness_invocation" &&
      this.harnessInvocationGate({ ...interaction, request: interaction.request }) === "auto_approve"
    ) {
      this.settle(
        interaction.messageId,
        { kind: "harness_invocation", outcome: "approved" },
        { type: "baton" },
      );
    }
    const result = await this.waitFor(interaction.messageId);
    if (result.kind === "cancelled") {
      return cancelledResult(result.reason, result.detail);
    }
    if (result.kind !== "harness_invocation") {
      return Object.freeze({
        state: "failure",
        error: "harness Interaction returned an invalid result",
      });
    }
    return Object.freeze({ state: "success", value: result.outcome });
  }

  complete(messageId: string, result: InteractionResult): boolean {
    const entry = this.entries.get(messageId);
    if (!entry || entry.request.source.kind !== "plugin" || !entry.pluginContext) return false;
    return this.settle(messageId, result, { type: "user" });
  }

  failExecution(executionId: string, error: string): void {
    for (const [messageId, entry] of this.entries) {
      if (
        entry.request.status !== "pending" ||
        entry.pluginContext?.executionId !== executionId
      ) {
        continue;
      }
      this.settle(
        messageId,
        { kind: "cancelled", reason: "recovery", detail: error },
        { type: "baton" },
      );
    }
  }

  failOrphans(error: string): void {
    for (const entry of this.entries.values()) {
      const context = entry.pluginContext;
      if (entry.request.status !== "pending" || !context) continue;
      this.failExecution(context.executionId, error);
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribe();
  }

  private async question(
    scope: ExecutionScope,
    input: PluginQuestionInput,
  ): Promise<AskResult> {
    const interaction = this.open(scope, {
      kind: "question",
      ...input,
    });
    const result = await this.waitFor(interaction.messageId);
    if (result.kind === "cancelled") {
      return cancelledResult(result.reason, result.detail);
    }
    if (result.kind !== "question") {
      return Object.freeze({
        state: "failure",
        error: "question Interaction returned an invalid result",
      });
    }
    return Object.freeze({
      state: "success",
      value: result.answers[QUESTION_ID]![0]!,
    });
  }

  private open(
    scope: ExecutionScope,
    request: PluginInteractionRequest,
  ): InputRequest {
    if (scope.batonSessionId !== this.session.id) {
      throw new Error(
        `plugin Interaction batonSessionId must be ${this.session.id}, got ${scope.batonSessionId}`,
      );
    }
    const interaction = createInputRequest(
      pluginRequestContent(request),
      { kind: "plugin", key: scope.pluginInstanceId },
      new Date(this.timestamp() + request.timeoutMs).toISOString(),
    );
    this.session.appendEvent({
      kind: "interaction.requested",
      source: {
        type: "plugin",
        pluginInstanceId: scope.pluginInstanceId,
      },
      payload: { ...interaction, pluginContext: { executionId: scope.executionId, verb: request.verb } },
    });
    return interaction;
  }

  private waitFor(messageId: string): Promise<InteractionResult> {
    const result = requestResult(this.session.projection, messageId);
    if (result) return Promise.resolve(result);
    return new Promise((resolve) => {
      const waiters = this.waiters.get(messageId) ?? new Set();
      waiters.add(resolve);
      this.waiters.set(messageId, waiters);
    });
  }

  private settle(
    messageId: string,
    result: InteractionResult,
    source: EventSource,
  ): boolean {
    const entry = this.entries.get(messageId);
    const event = entry && resolutionEvent(entry.request, result, actorOf(source));
    if (!entry || !event) return false;
    this.session.appendEvent({ ...event, source, parentEventId: entry.requestedEventId });
    return requestResult(this.session.projection, messageId) !== undefined;
  }

  private timestamp(): number {
    const value = this.now().getTime();
    if (Number.isNaN(value)) {
      throw new Error("plugin Interaction now() returned an invalid Date");
    }
    return value;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      if (!entry.pluginContext || entry.request.source.kind !== "plugin" || entry.request.status !== "pending" || entry.request.expiresAt === undefined) {
        continue;
      }
      earliest = Math.min(
        earliest,
        Date.parse(entry.request.expiresAt),
      );
    }
    if (!Number.isFinite(earliest)) return;
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, earliest - this.timestamp()),
    );
    this.timer = setTimeout(() => this.expireDue(), delay);
    this.timer.unref?.();
  }

  private expireDue(): void {
    this.timer = undefined;
    const now = this.timestamp();
    for (const [messageId, entry] of this.entries) {
      const expiresAt = entry.request.expiresAt;
      if (
        !entry.pluginContext || entry.request.source.kind !== "plugin" ||
        entry.request.status !== "pending" ||
        expiresAt === undefined ||
        Date.parse(expiresAt) > now
      ) {
        continue;
      }
      this.settle(
        messageId,
        { kind: "cancelled", reason: "timeout" },
        { type: "baton" },
      );
    }
    this.arm();
  }

  private apply(event: AnyEventEnvelope): void {
    if (event.kind !== "interaction.requested" && event.kind !== "interaction.answered" && event.kind !== "interaction.cancelled") return;
    // Session has already reduced this event. Rejected, duplicate and late facts
    // cannot independently settle a continuation through this notification.
    const messageId = event.kind === "interaction.answered" ? event.payload.replyToMessageIds[0] : event.payload.messageId;
    const result = requestResult(this.session.projection, messageId);
    if (result) {
      const waiters = this.waiters.get(messageId);
      this.waiters.delete(messageId);
      for (const resolve of waiters ?? []) resolve(result);
    }
    this.arm();
  }
}
