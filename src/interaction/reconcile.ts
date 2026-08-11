import type {
  AskChoice,
  AskInput,
  AskResult,
  ConfirmInput,
  ConfirmResult,
  DraftInput,
  HarnessInput,
  VerbResult,
} from "@compforge/baton-plugin";

import { newId } from "../event/ids.ts";
import type {
  AnyEventEnvelope,
  EventEnvelope,
  EventSource,
} from "../event/types.ts";
import type { PromptBlock } from "../input/blocks.ts";
import type { ReconcileVerbScope } from "../plugin/verbs.ts";
import type { SessionHandle } from "../store/store.ts";
import type {
  Interaction,
  InteractionCancellationReason,
  InteractionResult,
  QuestionChoice,
} from "./types.ts";

const QUESTION_ID = "decision";
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type InteractionSession = Pick<
  SessionHandle,
  "id" | "readEvents" | "subscribe" | "append"
>;

interface Entry {
  readonly requested: EventEnvelope<"interaction.requested">;
  result?: InteractionResult;
}

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
    interaction: Extract<Interaction, { kind: "harness_invocation" }>,
  ): "auto_approve" | "require_user";
}

function pluginInteraction(
  scope: ReconcileVerbScope,
  request: PluginInteractionRequest,
  expiresAt: string,
): Interaction {
  const base = {
    interactionId: newId("ix"),
    requester: {
      type: "plugin" as const,
      pluginInstanceId: scope.pluginInstanceId,
    },
    pluginContext: {
      executionId: scope.executionId,
      verb: request.verb,
    },
    expiresAt,
  };
  if (request.kind === "suggested_input") {
    return Object.freeze({
      ...base,
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
      ...base,
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
    ...base,
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

function validResult(
  interaction: Interaction,
  result: InteractionResult,
): boolean {
  if (result.kind === "cancelled") return true;
  if (
    interaction.kind === "suggested_input" &&
    result.kind === "suggested_input"
  ) {
    return result.outcome === "dismissed" || result.blocks.length > 0;
  }
  if (
    interaction.kind === "harness_invocation" &&
    result.kind === "harness_invocation"
  ) {
    return true;
  }
  if (interaction.kind !== "question" || result.kind !== "question") {
    return false;
  }
  if (
    Object.keys(result.answers).some((questionId) => questionId !== QUESTION_ID)
  ) {
    return false;
  }
  const values = result.answers[QUESTION_ID] ?? [];
  if (values.length !== 1 || !values[0]?.trim()) return false;
  const question = interaction.questions[0];
  if (!question?.choices?.length) return true;
  if (question.choices.some((choice) => choice.value === values[0])) {
    return true;
  }
  return question.allowOther === true;
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
  private readonly entries = new Map<string, Entry>();
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
  private replaying = true;

  constructor(
    private readonly session: InteractionSession,
    options: ReconcileInteractionStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.harnessInvocationGate = options.harnessInvocationGate ??
      (() => "auto_approve");
    for (const event of session.readEvents()) this.apply(event);
    this.replaying = false;
    this.arm();
    this.unsubscribe = session.subscribe((event) => this.apply(event));
  }

  async ask(
    scope: ReconcileVerbScope,
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
    scope: ReconcileVerbScope,
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
    scope: ReconcileVerbScope,
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
    const result = await this.waitFor(interaction.interactionId);
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
    scope: ReconcileVerbScope,
    input: HarnessInput,
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
      interaction.kind === "harness_invocation" &&
      this.harnessInvocationGate(interaction) === "auto_approve"
    ) {
      this.settle(
        interaction.interactionId,
        { kind: "harness_invocation", outcome: "approved" },
        { type: "baton" },
      );
    }
    const result = await this.waitFor(interaction.interactionId);
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

  complete(interactionId: string, result: InteractionResult): boolean {
    const entry = this.entries.get(interactionId);
    const interaction = entry?.requested.payload;
    if (
      !entry ||
      entry.result ||
      !interaction ||
      interaction.requester.type !== "plugin" ||
      !interaction.pluginContext ||
      !validResult(interaction, result)
    ) {
      return false;
    }
    return this.settle(interactionId, result, { type: "user" });
  }

  failExecution(executionId: string, error: string): void {
    for (const [interactionId, entry] of this.entries) {
      if (
        entry.result ||
        entry.requested.payload.pluginContext?.executionId !== executionId
      ) {
        continue;
      }
      this.settle(
        interactionId,
        { kind: "cancelled", reason: "recovery", detail: error },
        { type: "baton" },
      );
    }
  }

  failOrphans(error: string): void {
    for (const entry of this.entries.values()) {
      const context = entry.requested.payload.pluginContext;
      if (entry.result || !context) continue;
      this.failExecution(context.executionId, error);
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribe();
  }

  private async question(
    scope: ReconcileVerbScope,
    input: PluginQuestionInput,
  ): Promise<AskResult> {
    const interaction = this.open(scope, {
      kind: "question",
      ...input,
    });
    const result = await this.waitFor(interaction.interactionId);
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
    scope: ReconcileVerbScope,
    request: PluginInteractionRequest,
  ): Interaction {
    if (scope.batonSessionId !== this.session.id) {
      throw new Error(
        `plugin Interaction batonSessionId must be ${this.session.id}, got ${scope.batonSessionId}`,
      );
    }
    const interaction = pluginInteraction(
      scope,
      request,
      new Date(this.timestamp() + request.timeoutMs).toISOString(),
    );
    this.session.append({
      kind: "interaction.requested",
      source: {
        type: "plugin",
        pluginInstanceId: scope.pluginInstanceId,
      },
      payload: interaction,
    });
    return interaction;
  }

  private waitFor(interactionId: string): Promise<InteractionResult> {
    const result = this.entries.get(interactionId)?.result;
    if (result) return Promise.resolve(result);
    return new Promise((resolve) => {
      const waiters = this.waiters.get(interactionId) ?? new Set();
      waiters.add(resolve);
      this.waiters.set(interactionId, waiters);
    });
  }

  private settle(
    interactionId: string,
    result: InteractionResult,
    source: EventSource,
  ): boolean {
    const entry = this.entries.get(interactionId);
    if (!entry || entry.result) return false;
    if (result.kind === "cancelled") {
      this.session.append({
        kind: "interaction.cancelled",
        source,
        parentEventId: entry.requested.eventId,
        payload: {
          interactionId,
          reason: result.reason,
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        },
      });
    } else {
      this.session.append({
        kind: "interaction.answered",
        source,
        parentEventId: entry.requested.eventId,
        payload: { interactionId, answer: result },
      });
    }
    return true;
  }

  private timestamp(): number {
    const value = this.now().getTime();
    if (Number.isNaN(value)) {
      throw new Error("plugin Interaction now() returned an invalid Date");
    }
    return value;
  }

  private arm(): void {
    if (this.replaying) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      if (entry.result || entry.requested.payload.expiresAt === undefined) {
        continue;
      }
      earliest = Math.min(
        earliest,
        Date.parse(entry.requested.payload.expiresAt),
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
    for (const [interactionId, entry] of this.entries) {
      const expiresAt = entry.requested.payload.expiresAt;
      if (
        entry.result ||
        expiresAt === undefined ||
        Date.parse(expiresAt) > now
      ) {
        continue;
      }
      this.settle(
        interactionId,
        { kind: "cancelled", reason: "timeout" },
        { type: "baton" },
      );
    }
    this.arm();
  }

  private apply(event: AnyEventEnvelope): void {
    if (event.kind === "interaction.requested") {
      const interaction = event.payload;
      if (
        interaction.requester.type !== "plugin" ||
        !interaction.pluginContext ||
        this.entries.has(interaction.interactionId)
      ) {
        return;
      }
      this.entries.set(interaction.interactionId, { requested: event });
      this.arm();
      return;
    }
    if (
      event.kind !== "interaction.answered" &&
      event.kind !== "interaction.cancelled"
    ) {
      return;
    }
    const entry = this.entries.get(event.payload.interactionId);
    if (!entry || entry.result) return;
    entry.result = event.kind === "interaction.answered"
      ? event.payload.answer
      : {
          kind: "cancelled",
          reason: event.payload.reason,
          ...(event.payload.detail === undefined
            ? {}
            : { detail: event.payload.detail }),
        };
    const waiters = this.waiters.get(event.payload.interactionId);
    this.waiters.delete(event.payload.interactionId);
    for (const resolve of waiters ?? []) resolve(entry.result);
    this.arm();
  }
}
