import type {
  AskInput,
  AskResult,
  CancellationReason,
  ConfirmInput,
  ConfirmResult,
  ResourceRef,
} from "@compforge/baton-plugin";

import { newId } from "../event/ids.ts";
import type {
  AnyEventEnvelope,
  EventEnvelope,
} from "../event/types.ts";
import type {
  Interaction,
  InteractionResolution,
  PluginResourceInteractionContext,
} from "../interaction/types.ts";
import type { SessionHandle } from "../store/store.ts";
import type { ReconcileKey } from "./controller.ts";
import { reconcileResourceOwner } from "./reconcile-scope.ts";
import type { ReconcileVerbScope } from "./verbs.ts";

const QUESTION_ID = "decision";

type InteractionSession = Pick<
  SessionHandle,
  "id" | "readEvents" | "subscribe" | "append"
>;

interface Entry {
  readonly opened: EventEnvelope<"interaction.opened">;
  resolution?: InteractionResolution;
}

interface InteractionOption {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
}

interface ReconcileInteraction {
  readonly key: ReconcileKey;
  readonly resource: ResourceRef;
  readonly basedOnGeneration?: number;
  readonly basedOnResourceVersion?: string;
  readonly basedOnRevision?: number;
  readonly request: {
    readonly kind: "interaction";
    readonly decisionKey: string;
    readonly title: string;
    readonly prompt: string;
    readonly options?: readonly InteractionOption[];
    readonly allowOther?: boolean;
  };
}

function interactionIdentity(
  pluginInstanceId: string,
  context: PluginResourceInteractionContext,
): string {
  return JSON.stringify([
    pluginInstanceId,
    context.resourceOwner,
    context.resource.apiVersion,
    context.resource.kind,
    context.resource.namespace,
    context.resource.name,
    context.resource.uid,
    context.decisionKey,
  ]);
}

function interactionContext(
  draft: ReconcileInteraction,
): PluginResourceInteractionContext {
  return Object.freeze({
    decisionKey: draft.request.decisionKey,
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
  draft: ReconcileInteraction,
): Interaction {
  const request = draft.request;
  return Object.freeze({
    kind: "question",
    interactionId: newId("ix"),
    requester: {
      type: "plugin" as const,
      pluginInstanceId: draft.key.pluginInstanceId,
    },
    pluginContext: interactionContext(draft),
    questions: [
      {
        questionId: QUESTION_ID,
        header: request.title,
        question: request.prompt,
        ...(request.options === undefined
          ? {}
          : {
              options: request.options.map((option) => ({
                optionId: option.optionId,
                label: option.label,
                description: option.description ?? "",
              })),
            }),
        ...(request.allowOther === undefined
          ? {}
          : { allowOther: request.allowOther }),
      },
    ],
  });
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
  resolution: InteractionResolution | undefined,
):
  | { readonly kind: "answered"; readonly values: readonly string[] }
  | { readonly kind: "cancelled"; readonly reason: CancellationReason }
  | undefined {
  if (!resolution) return;
  if (resolution.kind === "cancelled") {
    return {
      kind: "cancelled",
      reason: resolution.reason,
    };
  }
  if (resolution.kind !== "question") return;
  return {
    kind: "answered",
    values: Object.freeze([...(resolution.answers[QUESTION_ID] ?? [])]),
  };
}

function validResolution(
  interaction: Interaction,
  resolution: InteractionResolution,
): boolean {
  if (resolution.kind === "cancelled") return true;
  if (interaction.kind !== "question" || resolution.kind !== "question") {
    return false;
  }
  if (
    Object.keys(resolution.answers).some((questionId) => questionId !== QUESTION_ID)
  ) {
    return false;
  }
  const values = resolution.answers[QUESTION_ID] ?? [];
  if (values.length !== 1 || !values[0]?.trim()) return false;
  const question = interaction.questions[0];
  if (!question?.options?.length) return true;
  if (question.options.some((option) => option.optionId === values[0])) {
    return true;
  }
  return question.allowOther === true;
}

/**
 * Event-backed Plugin Interaction index. It stores no callbacks: resolution is
 * persisted first, then routed back to the original Resource reconcile key.
 */
export class Store {
  private readonly entries = new Map<string, Entry>();
  private readonly interactionIdByIdentity = new Map<string, string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly session: InteractionSession) {
    for (const event of session.readEvents()) this.apply(event);
    this.unsubscribe = session.subscribe((event) => this.apply(event));
  }

  ask<TValue extends string>(
    context: ReconcileVerbScope,
    input: AskInput<TValue>,
  ): AskResult<TValue> {
    const interaction = this.open({
      ...context,
      request: {
        kind: "interaction",
        decisionKey: `ask:${input.key}`,
        title: input.title,
        prompt: input.prompt,
        ...(input.choices === undefined
          ? {}
          : {
              options: input.choices.map((choice) => ({
                optionId: choice.value,
                label: choice.label,
                ...(choice.description === undefined
                  ? {}
                  : { description: choice.description }),
              })),
            }),
        ...(input.allowOther === undefined
          ? {}
          : { allowOther: input.allowOther }),
      },
    });
    const entry = this.entries.get(interaction.interactionId);
    const resolved = outcome(entry?.resolution);
    if (!resolved) return Object.freeze({ state: "waiting" });
    if (resolved.kind === "cancelled") {
      return Object.freeze({
        state: "cancelled",
        reason: resolved.reason,
      });
    }
    return Object.freeze({
      state: "answered",
      value: resolved.values[0] as TValue,
    });
  }

  confirm(
    context: ReconcileVerbScope,
    input: ConfirmInput,
  ): ConfirmResult {
    const result = this.ask(context, {
      key: `confirm:${input.key}`,
      title: input.title,
      prompt: input.prompt,
      choices: [
        {
          value: "grant",
          label: input.confirmLabel ?? "Allow",
        },
        {
          value: "decline",
          label: input.declineLabel ?? "Decline",
        },
      ],
    });
    if (result.state === "waiting" || result.state === "cancelled") {
      return result;
    }
    return Object.freeze({
      state: result.value === "grant" ? "granted" : "declined",
    });
  }

  private open(draft: ReconcileInteraction): Interaction {
    if (draft.key.batonSessionId !== this.session.id) {
      throw new Error(
        `plugin Interaction batonSessionId must be ${this.session.id}, got ${draft.key.batonSessionId}`,
      );
    }
    const context = interactionContext(draft);
    const identity = interactionIdentity(draft.key.pluginInstanceId, context);
    const existingId = this.interactionIdByIdentity.get(identity);
    if (existingId) {
      const existing = this.entries.get(existingId);
      if (existing) {
        const candidate = pluginInteraction(draft);
        if (
          JSON.stringify(stableEnvelope(existing.opened.payload)) !==
            JSON.stringify(stableEnvelope(candidate))
        ) {
          throw new Error(
            `plugin Interaction identity conflict for ${draft.request.decisionKey}`,
          );
        }
        return existing.opened.payload;
      }
    }

    const interaction = pluginInteraction(draft);
    this.session.append({
      kind: "interaction.opened",
      source: {
        type: "plugin",
        pluginInstanceId: draft.key.pluginInstanceId,
      },
      payload: interaction,
    });
    return interaction;
  }

  resolve(
    interactionId: string,
    resolution: InteractionResolution,
  ): ReconcileKey | undefined {
    const entry = this.entries.get(interactionId);
    const interaction = entry?.opened.payload;
    if (
      !entry ||
      entry.resolution ||
      !interaction ||
      interaction.requester.type !== "plugin" ||
      !interaction.pluginContext
    ) {
      return;
    }
    if (!validResolution(interaction, resolution)) return;
    this.session.append({
      kind: "interaction.resolved",
      source: { type: "user" },
      parentEventId: entry.opened.eventId,
      payload: {
        interactionId,
        resolution,
      },
    });
    const context = interaction.pluginContext;
    return Object.freeze({
      batonSessionId: this.session.id,
      pluginInstanceId: interaction.requester.pluginInstanceId,
      resourceApiVersion: context.resource.apiVersion,
      resourceKind: context.resource.kind,
      resourceId: context.resource.name,
      ...(context.resourceOwner === "plugin"
        ? {}
        : { resourceOwner: context.resourceOwner }),
    });
  }

  close(): void {
    this.unsubscribe();
  }

  private apply(event: AnyEventEnvelope): void {
    if (event.kind === "interaction.opened") {
      const interaction = event.payload;
      const context = interaction.pluginContext;
      if (interaction.requester.type !== "plugin" || !context) return;
      if (this.entries.has(interaction.interactionId)) return;
      const identity = interactionIdentity(
        interaction.requester.pluginInstanceId,
        context,
      );
      const existingId = this.interactionIdByIdentity.get(identity);
      if (existingId) return;
      this.entries.set(interaction.interactionId, { opened: event });
      this.interactionIdByIdentity.set(identity, interaction.interactionId);
      return;
    }
    if (event.kind !== "interaction.resolved") return;
    const entry = this.entries.get(event.payload.interactionId);
    if (!entry || entry.resolution) return;
    entry.resolution = event.payload.resolution;
  }
}
