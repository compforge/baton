import type {
  AskChoice,
  AskInput,
  AskResult,
  CancellationReason,
  ConfirmInput,
  ConfirmResult,
  DraftInput,
  HarnessInput,
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
import type { PromptBlock } from "../input/blocks.ts";
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

interface PluginQuestionInput {
  readonly title: string;
  readonly prompt: string;
  readonly choices?: readonly AskChoice[];
  readonly allowOther?: boolean;
  readonly expiresAt?: string;
}

interface ReconcileInteractionRequest {
  readonly key: ReconcileKey;
  readonly resource: ResourceRef;
  readonly basedOnGeneration?: number;
  readonly basedOnResourceVersion?: string;
  readonly basedOnRevision?: number;
  readonly request:
    | {
        readonly kind: "question";
        readonly operation: ReconcileOperationRef<"ask" | "confirm">;
        readonly title: string;
        readonly prompt: string;
        readonly choices?: readonly AskChoice[];
        readonly allowOther?: boolean;
        readonly expiresAt?: string;
      }
    | {
        readonly kind: "suggested_input";
        readonly operation: ReconcileOperationRef<"draft">;
        readonly title: string;
        readonly prompt: string;
        readonly harnessTargetId?: string;
      }
    | {
        readonly kind: "harness_invocation";
        readonly operation: ReconcileOperationRef<"harness">;
        readonly title: string;
        readonly prompt: string;
        readonly laneId: string;
        readonly newLane: boolean;
        readonly harnessTargetId?: string;
      };
}

export type ReconcileDraftInteractionResult =
  | { readonly state: "editing" }
  | { readonly state: "dismissed" }
  | { readonly state: "cancelled"; readonly reason: CancellationReason }
  | { readonly state: "submitted"; readonly blocks: readonly PromptBlock[] };

export type ReconcileHarnessGateResult =
  | { readonly state: "waiting" }
  | { readonly state: "approved" }
  | { readonly state: "declined" }
  | { readonly state: "cancelled"; readonly reason: CancellationReason };

export interface ReconcileInteractionStoreOptions {
  now?: () => Date;
  onTimeout?(key: ReconcileKey): void;
  harnessInvocationGate?(
    interaction: Extract<Interaction, { kind: "harness_invocation" }>,
  ): "auto_approve" | "require_user";
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
  operation: ReconcileOperationRef<"ask" | "confirm" | "draft" | "harness">,
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
  draft: ReconcileInteractionRequest,
): Interaction {
  const request = draft.request;
  const base = {
    interactionId: newId("ix"),
    requester: {
      type: "plugin" as const,
      pluginInstanceId: draft.key.pluginInstanceId,
    },
    pluginContext: interactionContext(draft, request.operation),
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
    kind: "question",
    ...base,
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
    this.onTimeout = options.onTimeout;
    this.harnessInvocationGate = options.harnessInvocationGate ??
      (() => "auto_approve");
    for (const event of session.readEvents()) this.apply(event);
    this.replaying = false;
    this.arm();
    this.unsubscribe = session.subscribe((event) => this.apply(event));
  }

  /**
   * @spec A Plugin decision key is domain identity, independent of the reconcile verb. Ask choices preserve Plugin-authored values end-to-end so results need no Store-specific translation.
   * @rule Keep verb and key separate; do not reconstruct operation identity with string prefixes.
   */
  ask(
    context: ReconcileVerbScope,
    input: AskInput,
  ): AskResult {
    return this.question(
      context,
      { verb: "ask", key: input.key },
      input,
    );
  }

  /**
   * @spec Confirm is a constrained decision over the same operation identity model: the verb distinguishes it from ask, while accept and decline remain stable domain outcomes.
   * @rule Keep verb and key separate; do not reconstruct operation identity with string prefixes.
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

  draft(
    context: ReconcileVerbScope,
    input: DraftInput,
  ): ReconcileDraftInteractionResult {
    const interaction = this.open({
      ...context,
      request: {
        kind: "suggested_input",
        operation: { verb: "draft", key: input.key },
        title: input.key,
        prompt: input.prompt,
        ...(input.harnessTargetId === undefined
          ? {}
          : { harnessTargetId: input.harnessTargetId }),
      },
    });
    const result = this.entries.get(interaction.interactionId)?.result;
    if (!result) return Object.freeze({ state: "editing" });
    if (result.kind === "cancelled") {
      return Object.freeze({ state: "cancelled", reason: result.reason });
    }
    if (result.kind !== "suggested_input") {
      throw new Error(`draft() ${input.key} has an invalid Interaction result`);
    }
    if (result.outcome === "dismissed") {
      return Object.freeze({ state: "dismissed" });
    }
    return Object.freeze({
      state: "submitted",
      blocks: Object.freeze(result.blocks.map((block) => Object.freeze({ ...block }))),
    });
  }

  harness(
    context: ReconcileVerbScope,
    input: HarnessInput,
  ): ReconcileHarnessGateResult {
    const interaction = this.open({
      ...context,
      request: {
        kind: "harness_invocation",
        operation: { verb: "harness", key: input.key },
        title: input.key,
        prompt: input.prompt,
        laneId: input.laneId,
        newLane: input.newLane ?? false,
        ...(input.harnessTargetId === undefined
          ? {}
          : { harnessTargetId: input.harnessTargetId }),
      },
    });
    let entry = this.entries.get(interaction.interactionId);
    if (
      entry && !entry.result && interaction.kind === "harness_invocation" &&
      this.harnessInvocationGate(interaction) === "auto_approve"
    ) {
      this.settle(
        interaction.interactionId,
        { kind: "harness_invocation", outcome: "approved" },
        { type: "baton" },
      );
      entry = this.entries.get(interaction.interactionId);
    }
    const result = entry?.result;
    if (!result) return Object.freeze({ state: "waiting" });
    if (result.kind === "cancelled") {
      return Object.freeze({ state: "cancelled", reason: result.reason });
    }
    if (result.kind !== "harness_invocation") {
      throw new Error(`harness() ${input.key} has an invalid Interaction result`);
    }
    return Object.freeze({ state: result.outcome });
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

  private question(
    context: ReconcileVerbScope,
    operation: ReconcileOperationRef<"ask" | "confirm">,
    input: PluginQuestionInput,
  ): AskResult {
    const interaction = this.open({
      ...context,
      request: {
        kind: "question",
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
      value: result.values[0]!,
    });
  }

  private open(draft: ReconcileInteractionRequest): Interaction {
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
