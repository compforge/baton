import type {
  Outcome as PublicInteractionOutcome,
  Snapshot as PublicInteractionSnapshot,
} from "@qiankun01/baton-plugin";
import {
  BATON_SYSTEM_NAMESPACE,
  BATON_TURN_RESOURCE_TYPE,
} from "@qiankun01/baton-plugin";

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
import type {
  ReconcileInteraction,
  ReconcileKey,
} from "./controller.ts";
import { reconcileResourceOwner } from "./reconcile-scope.ts";

const QUESTION_ID = "decision";
export const LEGACY_RESOURCE_API_VERSION =
  "legacy.baton.dev/v1alpha1";

type InteractionSession = Pick<
  SessionHandle,
  "id" | "readEvents" | "subscribe" | "append"
>;

interface Entry {
  readonly opened: EventEnvelope<"interaction.opened">;
  resolution?: InteractionResolution;
}

function interactionIdentity(
  pluginInstanceId: string,
  context: PluginResourceInteractionContext,
): string {
  if (!context.resource) {
    return JSON.stringify([
      pluginInstanceId,
      context.resourceOwner,
      context.resourceKind,
      context.resourceId,
      context.decisionKey,
    ]);
  }
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

function contextKind(context: PluginResourceInteractionContext): string {
  if (context.resource) return context.resource.kind;
  if (context.resourceOwner === "baton" && context.resourceKind === "baton.turn") {
    return BATON_TURN_RESOURCE_TYPE.kind;
  }
  if (!context.resourceKind) {
    throw new Error("plugin Interaction context has no Resource kind");
  }
  return context.resourceKind;
}

function contextName(context: PluginResourceInteractionContext): string {
  const name = context.resource?.name ?? context.resourceId;
  if (!name) throw new Error("plugin Interaction context has no Resource name");
  return name;
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
                ...(option.role === undefined ? {} : { role: option.role }),
              })),
            }),
        ...(request.allowOther === undefined
          ? {}
          : { allowOther: request.allowOther }),
      },
    ],
  });
}

function outcome(
  resolution: InteractionResolution | undefined,
): PublicInteractionOutcome | undefined {
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

  open(draft: ReconcileInteraction): Interaction {
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
      if (existing) return existing.opened.payload;
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
      resourceApiVersion:
        context.resource?.apiVersion ?? LEGACY_RESOURCE_API_VERSION,
      resourceKind: contextKind(context),
      resourceId: contextName(context),
      ...(context.resourceOwner === "plugin"
        ? {}
        : { resourceOwner: context.resourceOwner }),
    });
  }

  snapshots(key: ReconcileKey): readonly PublicInteractionSnapshot[] {
    const resourceOwner = reconcileResourceOwner(key);
    const snapshots: PublicInteractionSnapshot[] = [];
    for (const entry of this.entries.values()) {
      const interaction = entry.opened.payload;
      const context = interaction.pluginContext;
      if (
        interaction.requester.type !== "plugin" ||
        interaction.requester.pluginInstanceId !== key.pluginInstanceId ||
        !context ||
        context.resourceOwner !== resourceOwner ||
        (context.resource !== undefined &&
          context.resource.apiVersion !== key.resourceApiVersion) ||
        contextKind(context) !== key.resourceKind ||
        contextName(context) !== key.resourceId
      ) {
        continue;
      }
      const resolved = outcome(entry.resolution);
      snapshots.push(Object.freeze({
        interactionId: interaction.interactionId,
        decisionKey: context.decisionKey,
        resource:
          context.resource ??
          Object.freeze({
            apiVersion: key.resourceApiVersion,
            kind: key.resourceKind,
            namespace:
              resourceOwner === "baton"
                ? BATON_SYSTEM_NAMESPACE
                : key.pluginInstanceId,
            name: key.resourceId,
          }),
        ...(resolved === undefined ? {} : { outcome: Object.freeze(resolved) }),
      }));
    }
    return Object.freeze(snapshots);
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
