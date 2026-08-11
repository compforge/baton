import type {
  AskChoice,
  AskInput,
  AskResult,
  CancellationReason,
  ConfirmInput,
  ConfirmResult,
  ReconcileOperationRef,
  ResourceRef,
  WithdrawInput,
  WithdrawResult,
} from "@compforge/baton-plugin";

import { newId } from "../event/ids.ts";
import type {
  AnyEventEnvelope,
  EventEnvelope,
  EventSource,
} from "../event/types.ts";
import type {
  Interaction,
  InteractionResult,
  ReconcileInteractionContext,
  QuestionChoice,
} from "./types.ts";
import type { SessionHandle } from "../store/store.ts";
import type { ReconcileKey } from "../plugin/controller.ts";
import {
  reconcileOperationIdentity,
  reconcileOperationLabel,
} from "../plugin/reconcile-operation.ts";
import { reconcileResourceOwner } from "../plugin/reconcile-scope.ts";
import type { ReconcileVerbScope } from "../plugin/verbs.ts";

const QUESTION_ID = "decision";

type InteractionSession = Pick<
  SessionHandle,
  "id" | "readEvents" | "subscribe" | "append"
>;

interface Entry {
  readonly requested: EventEnvelope<"interaction.requested">;
  result?: InteractionResult;
}

interface PluginQuestionInput<TValue extends string = string> {
  readonly title: string;
  readonly prompt: string;
  readonly choices?: readonly AskChoice<TValue>[];
  readonly allowOther?: boolean;
  readonly expiresAt?: string;
}

interface ReconcileQuestion {
  readonly key: ReconcileKey;
  readonly resource: ResourceRef;
  readonly basedOnGeneration?: number;
  readonly basedOnResourceVersion?: string;
  readonly basedOnRevision?: number;
  readonly request: {
    readonly operation: ReconcileOperationRef<"ask" | "confirm">;
    readonly title: string;
    readonly prompt: string;
    readonly choices?: readonly AskChoice[];
    readonly allowOther?: boolean;
    readonly expiresAt?: string;
  };
}

export interface ReconcileInteractionStoreOptions {
  now?: () => Date;
  onTimeout?(key: ReconcileKey): void;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function interactionIdentity(
  batonSessionId: string,
  pluginInstanceId: string,
  context: ReconcileInteractionContext,
): string {
  return reconcileOperationIdentity({
    batonSessionId,
    pluginInstanceId,
    resourceOwner: context.resourceOwner,
    resource: context.resource,
  }, context.operation);
}

function interactionContext(
  draft: ReconcileVerbScope,
  operation: ReconcileOperationRef<"ask" | "confirm">,
): ReconcileInteractionContext {
  return Object.freeze({
    operation: Object.freeze({ ...operation }),
    resource: draft.resource,
    resourceOwner: reconcileResourceOwner(draft.key),
    ...(draft.basedOnGeneration === undefined
      ? {}
      : { basedOnGeneration: draft.basedOnGeneration }),
    ...(draft.basedOnResourceVersion === undefined
      ? {}
      : { basedOnResourceVersion: draft.basedOnResourceVersion }),
    ...(draft.basedOnRevision === undefined
      ? {}
      : { basedOnRevision: draft.basedOnRevision }),
  });
}

function pluginInteraction(
  draft: ReconcileQuestion,
): Interaction {
  const request = draft.request;
  return Object.freeze({
    kind: "question",
    interactionId: newId("ix"),
    requester: {
      type: "plugin" as const,
      pluginInstanceId: draft.key.pluginInstanceId,
    },
    pluginContext: interactionContext(draft, request.operation),
    ...(request.expiresAt === undefined
      ? {}
      : { expiresAt: request.expiresAt }),
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

function reconcileKey(
  batonSessionId: string,
  interaction: Interaction,
): ReconcileKey | undefined {
  const context = interaction.pluginContext;
  if (interaction.requester.type !== "plugin" || !context) return;
  return Object.freeze({
    batonSessionId,
    pluginInstanceId: interaction.requester.pluginInstanceId,
    resourceApiVersion: context.resource.apiVersion,
    resourceKind: context.resource.kind,
    resourceId: context.resource.name,
    ...(context.resourceOwner === "plugin"
      ? {}
      : { resourceOwner: context.resourceOwner }),
  });
}

function sameResource(left: ResourceRef, right: ResourceRef): boolean {
  return left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.namespace === right.namespace &&
    left.name === right.name &&
    left.uid === right.uid;
}

function stableEnvelope(interaction: Interaction): unknown {
  const { interactionId: _interactionId, pluginContext, ...presentation } =
    interaction;
  if (!pluginContext) return presentation;
  const {
    basedOnGeneration: _basedOnGeneration,
    basedOnResourceVersion: _basedOnResourceVersion,
    basedOnRevision: _basedOnRevision,
    ...identity
  } = pluginContext;
  return { ...presentation, pluginContext: identity };
}

function outcome(
  result: InteractionResult | undefined,
):
  | { readonly kind: "answered"; readonly values: readonly string[] }
  | { readonly kind: "cancelled"; readonly reason: CancellationReason }
  | undefined {
  if (!result) return;
  if (result.kind === "cancelled") {
    return {
      kind: "cancelled",
      reason: result.reason,
    };
  }
  if (result.kind !== "question") return;
  return {
    kind: "answered",
    values: Object.freeze([...(result.answers[QUESTION_ID] ?? [])]),
  };
}

function validResult(
  interaction: Interaction,
  result: InteractionResult,
): boolean {
  if (result.kind === "cancelled") return true;
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

/**
 * Reconcile continuation for Core-owned Interactions. It stores no Plugin
 * callbacks: the result is persisted first, then routed by Resource identity.
 */
export class ReconcileInteractionStore {
  private readonly entries = new Map<string, Entry>();
  private readonly interactionIdByIdentity = new Map<string, string>();
  private readonly unsubscribe: () => void;
  private readonly now: () => Date;
  private readonly onTimeout: ReconcileInteractionStoreOptions["onTimeout"];
  private timer?: ReturnType<typeof setTimeout>;
  private replaying = true;

  constructor(
    private readonly session: InteractionSession,
    options: ReconcileInteractionStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.onTimeout = options.onTimeout;
    for (const event of session.readEvents()) this.apply(event);
    this.replaying = false;
    this.arm();
    this.unsubscribe = session.subscribe((event) => this.apply(event));
  }

  /**
   * @spec Plugin ask identity keeps the authored key separate from the ask verb; choice values cross the Interaction boundary unchanged.
   * @case id=choice_value_round_trip,desc=`resolve an authored choice`,expect=`the AskResult value equals AskChoice.value`
   * @rule Keep operation verb and key structured; do not encode the verb into the key.
   */
  ask<TValue extends string>(
    context: ReconcileVerbScope,
    input: AskInput<TValue>,
  ): AskResult<TValue> {
    return this.question(
      context,
      { verb: "ask", key: input.key },
      input,
    );
  }

  /**
   * @spec Plugin confirm identity keeps the authored key separate from the confirm verb and maps the fixed accept/decline choices to ConfirmResult states.
   * @case id=confirm_choice_mapping,desc=`resolve a confirm choice`,expect=`accept becomes accepted and decline becomes declined`
   * @rule Keep operation verb and key structured; do not encode the verb into the key.
   */
  confirm(
    context: ReconcileVerbScope,
    input: ConfirmInput,
  ): ConfirmResult {
    const result = this.question(context, {
      verb: "confirm",
      key: input.key,
    }, {
      title: input.title,
      prompt: input.prompt,
      choices: [
        {
          value: "accept",
          label: input.confirmLabel ?? "Accept",
        },
        {
          value: "decline",
          label: input.declineLabel ?? "Decline",
        },
      ],
      ...(input.expiresAt === undefined
        ? {}
        : { expiresAt: input.expiresAt }),
    });
    if (result.state === "waiting" || result.state === "cancelled") {
      return result;
    }
    return Object.freeze({
      state: result.value === "accept" ? "accepted" : "declined",
    });
  }

  withdraw(
    context: ReconcileVerbScope,
    input: WithdrawInput,
  ): WithdrawResult {
    const identity = interactionIdentity(
      this.session.id,
      context.key.pluginInstanceId,
      interactionContext(context, input),
    );
    const interactionId = this.interactionIdByIdentity.get(identity);
    const entry = interactionId === undefined
      ? undefined
      : this.entries.get(interactionId);
    if (!interactionId || !entry) {
      return Object.freeze({ state: "not-pending" });
    }
    if (entry.result) {
      return entry.result.kind === "cancelled" &&
          entry.result.reason === "requester"
        ? Object.freeze({ state: "cancelled", reason: "requester" })
        : Object.freeze({ state: "not-pending" });
    }
    this.settle(
      interactionId,
      { kind: "cancelled", reason: "requester" },
      {
        type: "plugin",
        pluginInstanceId: context.key.pluginInstanceId,
      },
    );
    return Object.freeze({ state: "cancelled", reason: "requester" });
  }

  cancelForResource(resource: ResourceRef): string[] {
    const cancelled: string[] = [];
    for (const [interactionId, entry] of this.entries) {
      if (entry.result) continue;
      const context = entry.requested.payload.pluginContext;
      if (!context || !sameResource(context.resource, resource)) continue;
      this.settle(
        interactionId,
        { kind: "cancelled", reason: "requester" },
        { type: "baton" },
      );
      cancelled.push(interactionId);
    }
    return cancelled;
  }

  private question<TValue extends string>(
    context: ReconcileVerbScope,
    operation: ReconcileOperationRef<"ask" | "confirm">,
    input: PluginQuestionInput<TValue>,
  ): AskResult<TValue> {
    const interaction = this.open({
      ...context,
      request: {
        operation,
        title: input.title,
        prompt: input.prompt,
        ...(input.choices === undefined
          ? {}
          : {
              choices: input.choices.map((choice) => ({ ...choice })),
            }),
        ...(input.allowOther === undefined
          ? {}
          : { allowOther: input.allowOther }),
        ...(input.expiresAt === undefined
          ? {}
          : { expiresAt: input.expiresAt }),
      },
    });
    let entry = this.entries.get(interaction.interactionId);
    if (entry && !entry.result && this.expired(entry)) {
      this.settle(
        interaction.interactionId,
        { kind: "cancelled", reason: "timeout" },
        { type: "baton" },
      );
      entry = this.entries.get(interaction.interactionId);
    }
    const result = outcome(entry?.result);
    if (!result) return Object.freeze({ state: "waiting" });
    if (result.kind === "cancelled") {
      return Object.freeze({
        state: "cancelled",
        reason: result.reason,
      });
    }
    return Object.freeze({
      state: "answered",
      value: result.values[0] as TValue,
    });
  }

  private open(draft: ReconcileQuestion): Interaction {
    if (draft.key.batonSessionId !== this.session.id) {
      throw new Error(
        `plugin Interaction batonSessionId must be ${this.session.id}, got ${draft.key.batonSessionId}`,
      );
    }
    const context = interactionContext(draft, draft.request.operation);
    const identity = interactionIdentity(
      this.session.id,
      draft.key.pluginInstanceId,
      context,
    );
    const existingId = this.interactionIdByIdentity.get(identity);
    if (existingId) {
      const existing = this.entries.get(existingId);
      if (existing) {
        const candidate = pluginInteraction(draft);
        if (
          JSON.stringify(stableEnvelope(existing.requested.payload)) !==
            JSON.stringify(stableEnvelope(candidate))
        ) {
          throw new Error(
            `plugin Interaction identity conflict for ${reconcileOperationLabel(draft.request.operation)}`,
          );
        }
        return existing.requested.payload;
      }
    }

    const interaction = pluginInteraction(draft);
    this.session.append({
      kind: "interaction.requested",
      source: {
        type: "plugin",
        pluginInstanceId: draft.key.pluginInstanceId,
      },
      payload: interaction,
    });
    return interaction;
  }

  complete(
    interactionId: string,
    result: InteractionResult,
  ): ReconcileKey | undefined {
    const entry = this.entries.get(interactionId);
    const interaction = entry?.requested.payload;
    if (
      !entry ||
      entry.result ||
      !interaction ||
      interaction.requester.type !== "plugin" ||
      !interaction.pluginContext
    ) {
      return;
    }
    if (!validResult(interaction, result)) return;
    return this.settle(interactionId, result, { type: "user" });
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribe();
  }

  private settle(
    interactionId: string,
    result: InteractionResult,
    source: EventSource,
  ): ReconcileKey | undefined {
    const entry = this.entries.get(interactionId);
    const interaction = entry?.requested.payload;
    if (!entry || entry.result || !interaction) return;
    if (result.kind === "cancelled") {
      this.session.append({
        kind: "interaction.cancelled",
        source,
        parentEventId: entry.requested.eventId,
        payload: { interactionId, reason: result.reason },
      });
    } else {
      this.session.append({
        kind: "interaction.answered",
        source,
        parentEventId: entry.requested.eventId,
        payload: { interactionId, answer: result },
      });
    }
    return reconcileKey(this.session.id, interaction);
  }

  private timestamp(): number {
    const value = this.now().getTime();
    if (Number.isNaN(value)) {
      throw new Error("plugin Interaction now() returned an invalid Date");
    }
    return value;
  }

  private expired(entry: Entry): boolean {
    const expiresAt = entry.requested.payload.expiresAt;
    return expiresAt !== undefined && Date.parse(expiresAt) <= this.timestamp();
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
    const owners: ReconcileKey[] = [];
    for (const [interactionId, entry] of this.entries) {
      const expiresAt = entry.requested.payload.expiresAt;
      if (
        entry.result ||
        expiresAt === undefined ||
        Date.parse(expiresAt) > now
      ) {
        continue;
      }
      const key = this.settle(
        interactionId,
        { kind: "cancelled", reason: "timeout" },
        { type: "baton" },
      );
      if (key) owners.push(key);
    }
    this.arm();
    for (const key of owners) this.onTimeout?.(key);
  }

  private apply(event: AnyEventEnvelope): void {
    if (event.kind === "interaction.requested") {
      const interaction = event.payload;
      const context = interaction.pluginContext;
      if (interaction.requester.type !== "plugin" || !context) return;
      if (this.entries.has(interaction.interactionId)) return;
      const identity = interactionIdentity(
        this.session.id,
        interaction.requester.pluginInstanceId,
        context,
      );
      const existingId = this.interactionIdByIdentity.get(identity);
      if (existingId) return;
      this.entries.set(interaction.interactionId, { requested: event });
      this.interactionIdByIdentity.set(identity, interaction.interactionId);
      this.arm();
      return;
    }
    if (
      event.kind !== "interaction.answered" &&
      event.kind !== "interaction.cancelled"
    ) return;
    const entry = this.entries.get(event.payload.interactionId);
    if (!entry || entry.result) return;
    entry.result = event.kind === "interaction.answered"
      ? event.payload.answer
      : { kind: "cancelled", reason: event.payload.reason };
    this.arm();
  }
}
