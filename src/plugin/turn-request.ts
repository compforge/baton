import { createHash } from "node:crypto";

import type {
  ResourceRef,
  TurnRequestPhase,
  TurnRequestSnapshot,
  TurnSummary,
} from "@compforge/baton-plugin";

import { newId } from "../event/ids.ts";
import type {
  AnyEventEnvelope,
  EventEnvelope,
  TurnRequestRecorded,
  TurnRequestScheduled,
} from "../event/types.ts";
import type {
  Interaction,
  InteractionResolution,
} from "../interaction/types.ts";
import type { SessionHandle } from "../store/store.ts";
import type {
  ReconcileKey,
  ReconcileTurnRequest,
} from "./controller.ts";
import { reconcileResourceOwner } from "./reconcile-scope.ts";

const ALLOW_ONCE = "allow_once";
const REJECT = "reject";

type TurnRequestSession = Pick<
  SessionHandle,
  "id" | "readEvents" | "subscribe" | "append"
>;

export interface ScheduledTurnRequest {
  readonly requestId: string;
  readonly pluginInstanceId: string;
  readonly harnessTargetId: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly prompt: string;
}

export interface ResolvedTurnRequest {
  readonly key: ReconcileKey;
  readonly scheduled?: ScheduledTurnRequest;
}

interface RequestState {
  readonly recorded: EventEnvelope<"_baton_turn_request_recorded">;
  interaction?: EventEnvelope<"interaction.opened">;
  interactionResolution?: InteractionResolution;
  authorization?: EventEnvelope<"_baton_turn_request_authorization_resolved">;
  scheduled?: EventEnvelope<"_baton_turn_request_scheduled">;
  cancelled?: EventEnvelope<"_baton_turn_request_cancelled">;
  admitted: boolean;
  uncertain: boolean;
  result?: TurnSummary;
}

export interface TurnRequestStoreOptions {
  onChanged?(request: TurnRequestSnapshot, key: ReconcileKey): void;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestId(draft: ReconcileTurnRequest): string {
  return `trq_${digest(JSON.stringify([
    draft.key.batonSessionId,
    draft.key.pluginInstanceId,
    reconcileResourceOwner(draft.key),
    draft.resource.apiVersion,
    draft.resource.kind,
    draft.resource.namespace,
    draft.resource.name,
    draft.resource.uid,
    draft.request.requestKey,
  ]))}`;
}

function sameResource(left: ResourceRef, right: ResourceRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.namespace === right.namespace &&
    left.name === right.name &&
    left.uid === right.uid
  );
}

function sameEnvelope(
  current: TurnRequestRecorded,
  draft: ReconcileTurnRequest,
): boolean {
  return (
    current.requestKey === draft.request.requestKey &&
    current.resourceOwner === reconcileResourceOwner(draft.key) &&
    sameResource(current.resource, draft.resource) &&
    current.title === draft.request.title &&
    current.description === draft.request.description &&
    current.prompt === draft.request.prompt &&
    current.requestedHarnessTargetId === draft.request.harnessTargetId
  );
}

function authorizationDescription(recorded: TurnRequestRecorded): string {
  return [
    recorded.description?.trim(),
    "Prompt (read-only):",
    recorded.prompt,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function keyOf(state: RequestState): ReconcileKey {
  const source = state.recorded.source;
  if (source.type !== "plugin") {
    throw new Error(
      `TurnRequest ${state.recorded.payload.requestId} has a non-Plugin source`,
    );
  }
  const recorded = state.recorded.payload;
  return Object.freeze({
    batonSessionId: state.recorded.scope.batonSessionId,
    pluginInstanceId: source.pluginInstanceId,
    resourceApiVersion: recorded.resource.apiVersion,
    resourceKind: recorded.resource.kind,
    resourceId: recorded.resource.name,
    ...(recorded.resourceOwner === "plugin"
      ? {}
      : { resourceOwner: recorded.resourceOwner }),
  });
}

function pluginInstanceIdOf(state: RequestState): string {
  const source = state.recorded.source;
  if (source.type !== "plugin") {
    throw new Error(
      `TurnRequest ${state.recorded.payload.requestId} has a non-Plugin source`,
    );
  }
  return source.pluginInstanceId;
}

function phaseOf(state: RequestState): TurnRequestPhase {
  if (state.result) return "completed";
  if (state.cancelled) return "cancelled";
  if (state.authorization?.payload.outcome === "declined") return "declined";
  if (state.uncertain) return "uncertain";
  if (state.admitted) return "running";
  if (
    state.scheduled ||
    state.authorization?.payload.outcome === "allowed"
  ) {
    return "queued";
  }
  return "pending_approval";
}

function snapshotOf(state: RequestState): TurnRequestSnapshot {
  const recorded = state.recorded.payload;
  const harnessTargetId =
    state.scheduled?.payload.harnessTargetId ??
    state.authorization?.payload.harnessTargetId ??
    recorded.requestedHarnessTargetId;
  return Object.freeze({
    requestId: recorded.requestId,
    requestKey: recorded.requestKey,
    resource: Object.freeze({ ...recorded.resource }),
    phase: phaseOf(state),
    ...(harnessTargetId === undefined ? {} : { harnessTargetId }),
    ...(state.scheduled === undefined
      ? {}
      : { turnId: state.scheduled.payload.turnId }),
    ...(state.result === undefined
      ? {}
      : {
          result: Object.freeze({
            ...state.result,
            toolCalls: Object.freeze(
              state.result.toolCalls.map((toolCall) =>
                Object.freeze({ ...toolCall })
              ),
            ),
            ...(state.result.usage === undefined
              ? {}
              : { usage: Object.freeze({ ...state.result.usage }) }),
          }),
        }),
  });
}

function scheduledOf(state: RequestState): ScheduledTurnRequest | undefined {
  const scheduled = state.scheduled?.payload;
  if (!scheduled) return;
  return Object.freeze({
    requestId: scheduled.requestId,
    pluginInstanceId: pluginInstanceIdOf(state),
    harnessTargetId: scheduled.harnessTargetId,
    messageId: scheduled.messageId,
    turnId: scheduled.turnId,
    prompt: state.recorded.payload.prompt,
  });
}

function permissionSelection(
  resolution: InteractionResolution,
): "allowed" | "declined" | "cancelled" | undefined {
  if (resolution.kind === "cancelled") return "cancelled";
  if (resolution.kind !== "permission" || resolution.outcome !== "selected") {
    return;
  }
  if (resolution.optionId === ALLOW_ONCE) return "allowed";
  if (resolution.optionId === REJECT) return "declined";
}

/** Event-backed owner for Plugin requests to start one new driven Turn. */
export class TurnRequestStore {
  private readonly states = new Map<string, RequestState>();
  private readonly requestIdByInteraction = new Map<string, string>();
  private readonly requestIdByMessage = new Map<string, string>();
  private readonly requestIdByTurn = new Map<string, string>();
  private readonly requestIdByAttempt = new Map<string, string>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly session: TurnRequestSession,
    private readonly options: TurnRequestStoreOptions = {},
  ) {
    for (const event of session.readEvents()) this.apply(event, false);
    this.unsubscribe = session.subscribe((event) => this.apply(event, true));
  }

  record(draft: ReconcileTurnRequest): TurnRequestSnapshot {
    if (draft.key.batonSessionId !== this.session.id) {
      throw new Error(
        `TurnRequest batonSessionId must be ${this.session.id}, got ${draft.key.batonSessionId}`,
      );
    }
    const id = requestId(draft);
    const existing = this.states.get(id);
    if (existing) {
      if (!sameEnvelope(existing.recorded.payload, draft)) {
        throw new Error(
          `TurnRequest identity conflict for ${draft.request.requestKey}: ${id}`,
        );
      }
      this.ensureAuthorizationInteraction(existing);
      return snapshotOf(existing);
    }

    this.session.append({
      kind: "_baton_turn_request_recorded",
      source: {
        type: "plugin",
        pluginInstanceId: draft.key.pluginInstanceId,
      },
      payload: {
        requestId: id,
        requestKey: draft.request.requestKey,
        resourceOwner: reconcileResourceOwner(draft.key),
        resource: { ...draft.resource },
        title: draft.request.title,
        ...(draft.request.description === undefined
          ? {}
          : { description: draft.request.description }),
        prompt: draft.request.prompt,
        ...(draft.request.harnessTargetId === undefined
          ? {}
          : { requestedHarnessTargetId: draft.request.harnessTargetId }),
      },
    });
    const state = this.states.get(id);
    if (!state) throw new Error(`TurnRequest was not recorded: ${id}`);
    this.ensureAuthorizationInteraction(state);
    return snapshotOf(state);
  }

  resolve(
    interactionId: string,
    resolution: InteractionResolution,
    selectedHarnessTargetId: string,
    availableHarnessTargetIds: ReadonlySet<string>,
  ): ResolvedTurnRequest | undefined {
    const id = this.requestIdByInteraction.get(interactionId);
    const state = id ? this.states.get(id) : undefined;
    if (
      !id ||
      !state ||
      state.interactionResolution ||
      state.authorization ||
      state.cancelled ||
      state.result
    ) {
      return;
    }
    const selection = permissionSelection(resolution);
    if (!selection) return;

    const targetId =
      state.recorded.payload.requestedHarnessTargetId ||
      selectedHarnessTargetId;
    if (
      selection === "allowed" &&
      (!targetId || !availableHarnessTargetIds.has(targetId))
    ) {
      throw new Error(
        `TurnRequest ${id} cannot use unknown HarnessTarget: ${targetId || "<none>"}`,
      );
    }

    // The TurnRequest fact is the durable authorization decision. Recording it
    // before closing the UI Interaction preserves the selected Target across
    // the crash window between these two ledger appends.
    if (selection === "cancelled") {
      this.appendCancellation(state, "user");
    } else {
      this.session.append({
        kind: "_baton_turn_request_authorization_resolved",
        source: { type: "user" },
        parentEventId: state.interaction?.eventId,
        payload: {
          requestId: id,
          interactionId,
          outcome: selection,
          ...(selection === "allowed" ? { harnessTargetId: targetId } : {}),
        },
      });
    }
    this.appendInteractionResolution(state, resolution);

    const current = this.states.get(id) as RequestState;
    const scheduled =
      selection === "allowed" ? this.ensureScheduled(current) : undefined;
    return Object.freeze({
      key: keyOf(current),
      ...(scheduled === undefined ? {} : { scheduled }),
    });
  }

  snapshots(key: ReconcileKey, resource: ResourceRef): readonly TurnRequestSnapshot[] {
    const snapshots = [...this.states.values()]
      .filter((state) => {
        const owner = keyOf(state);
        return (
          owner.pluginInstanceId === key.pluginInstanceId &&
          owner.resourceApiVersion === key.resourceApiVersion &&
          owner.resourceKind === key.resourceKind &&
          owner.resourceId === key.resourceId &&
          reconcileResourceOwner(owner) === reconcileResourceOwner(key) &&
          sameResource(state.recorded.payload.resource, resource)
        );
      })
      .sort((left, right) => left.recorded.seq - right.recorded.seq)
      .map(snapshotOf);
    return Object.freeze(snapshots);
  }

  list(): readonly TurnRequestSnapshot[] {
    return Object.freeze(
      [...this.states.values()]
        .sort((left, right) => left.recorded.seq - right.recorded.seq)
        .map(snapshotOf),
    );
  }

  latestCancellable(identifier?: string): TurnRequestSnapshot | undefined {
    const states = [...this.states.values()]
      .filter((state) => {
        const phase = phaseOf(state);
        if (phase === "completed" || phase === "declined" || phase === "cancelled") {
          return false;
        }
        return (
          identifier === undefined ||
          state.recorded.payload.requestId === identifier
        );
      })
      .sort((left, right) => right.recorded.seq - left.recorded.seq);
    return states[0] ? snapshotOf(states[0]) : undefined;
  }

  isAdmitted(requestId: string): boolean {
    return this.states.get(requestId)?.admitted ?? false;
  }

  cancelBeforeAdmission(
    requestId: string,
    reason: "user" | "resource" | "recovery",
    detail?: string,
  ): ReconcileKey | undefined {
    const state = this.states.get(requestId);
    if (!state || state.admitted || state.result || state.cancelled) return;
    this.appendCancellation(state, reason, detail);
    if (state.interaction && !state.interactionResolution) {
      this.appendInteractionResolution(state, {
        kind: "cancelled",
        reason: reason === "user" ? "user" : "requester",
      });
    }
    return keyOf(state);
  }

  cancelForResource(resource: ResourceRef): string[] {
    const cancelled: string[] = [];
    for (const state of this.states.values()) {
      if (
        !sameResource(state.recorded.payload.resource, resource) ||
        state.admitted ||
        state.result ||
        state.cancelled ||
        state.authorization?.payload.outcome === "declined"
      ) {
        continue;
      }
      this.cancelBeforeAdmission(
        state.recorded.payload.requestId,
        "resource",
      );
      cancelled.push(state.recorded.payload.requestId);
    }
    return cancelled;
  }

  /** Repairs ledger gaps and returns scheduled Inputs that still need dispatch. */
  restore(): readonly ScheduledTurnRequest[] {
    const pending: ScheduledTurnRequest[] = [];
    for (const state of this.states.values()) {
      if (state.result || state.cancelled) continue;
      if (!state.authorization) {
        this.ensureAuthorizationInteraction(state);
        continue;
      }
      this.ensureInteractionClosed(state);
      if (state.authorization.payload.outcome !== "allowed") continue;
      const scheduled = this.ensureScheduled(state);
      const current = this.states.get(state.recorded.payload.requestId) as RequestState;
      if (
        scheduled &&
        !current.admitted &&
        !current.uncertain &&
        !current.cancelled &&
        !current.result
      ) {
        pending.push(scheduled);
      }
    }
    return Object.freeze(pending);
  }

  close(): void {
    this.unsubscribe();
  }

  private ensureAuthorizationInteraction(state: RequestState): Interaction | undefined {
    if (
      state.interaction ||
      state.authorization ||
      state.cancelled ||
      state.result
    ) {
      return state.interaction?.payload;
    }
    const recorded = state.recorded.payload;
    const interaction: Interaction = Object.freeze<Interaction>({
      kind: "permission",
      interactionId: newId("ix"),
      requester: {
        type: "plugin",
        pluginInstanceId: pluginInstanceIdOf(state),
      },
      turnRequestContext: {
        turnRequestId: recorded.requestId,
        ...(recorded.requestedHarnessTargetId === undefined
          ? {}
          : { requestedHarnessTargetId: recorded.requestedHarnessTargetId }),
      },
      title: recorded.title,
      description: authorizationDescription(recorded),
      options: [
        {
          optionId: ALLOW_ONCE,
          name: "Allow once",
          polarity: "allow",
          lifetime: "once",
        },
        {
          optionId: REJECT,
          name: "Reject",
          polarity: "reject",
          lifetime: "once",
        },
      ],
    });
    this.session.append({
      kind: "interaction.opened",
      source: {
        type: "plugin",
        pluginInstanceId: pluginInstanceIdOf(state),
      },
      parentEventId: state.recorded.eventId,
      payload: interaction,
    });
    return interaction;
  }

  private ensureScheduled(state: RequestState): ScheduledTurnRequest | undefined {
    if (state.scheduled) return scheduledOf(state);
    const authorization = state.authorization?.payload;
    if (
      !authorization ||
      authorization.outcome !== "allowed" ||
      !authorization.harnessTargetId ||
      state.cancelled ||
      state.result
    ) {
      return;
    }
    const scheduled: TurnRequestScheduled = {
      requestId: state.recorded.payload.requestId,
      messageId: newId("m"),
      turnId: newId("t"),
      harnessTargetId: authorization.harnessTargetId,
    };
    this.session.append({
      kind: "_baton_turn_request_scheduled",
      source: { type: "baton" },
      parentEventId: state.authorization?.eventId,
      payload: scheduled,
    });
    return scheduledOf(this.states.get(scheduled.requestId) as RequestState);
  }

  private appendCancellation(
    state: RequestState,
    reason: "user" | "resource" | "recovery",
    detail?: string,
  ): void {
    this.session.append({
      kind: "_baton_turn_request_cancelled",
      source: reason === "user" ? { type: "user" } : { type: "baton" },
      parentEventId:
        state.scheduled?.eventId ??
        state.authorization?.eventId ??
        state.interaction?.eventId ??
        state.recorded.eventId,
      payload: {
        requestId: state.recorded.payload.requestId,
        reason,
        ...(detail === undefined ? {} : { detail }),
      },
    });
  }

  private appendInteractionResolution(
    state: RequestState,
    resolution: InteractionResolution,
  ): void {
    if (!state.interaction || state.interactionResolution) return;
    this.session.append({
      kind: "interaction.resolved",
      source: resolution.kind === "cancelled" && resolution.reason !== "user"
        ? { type: "baton" }
        : { type: "user" },
      parentEventId: state.interaction.eventId,
      payload: {
        interactionId: state.interaction.payload.interactionId,
        resolution,
      },
    });
  }

  private ensureInteractionClosed(state: RequestState): void {
    if (!state.interaction || state.interactionResolution) return;
    if (state.cancelled) {
      this.appendInteractionResolution(state, {
        kind: "cancelled",
        reason: state.cancelled.payload.reason === "user" ? "user" : "requester",
      });
      return;
    }
    const authorization = state.authorization?.payload;
    if (!authorization) return;
    this.appendInteractionResolution(state, {
      kind: "permission",
      outcome: "selected",
      optionId: authorization.outcome === "allowed" ? ALLOW_ONCE : REJECT,
    });
  }

  private apply(event: AnyEventEnvelope, notify: boolean): void {
    let changed: RequestState | undefined;
    switch (event.kind) {
      case "_baton_turn_request_recorded": {
        if (this.states.has(event.payload.requestId)) return;
        const state: RequestState = {
          recorded: event,
          admitted: false,
          uncertain: false,
        };
        this.states.set(event.payload.requestId, state);
        return;
      }
      case "interaction.opened": {
        const id = event.payload.turnRequestContext?.turnRequestId;
        const state = id ? this.states.get(id) : undefined;
        if (!state || state.interaction) return;
        state.interaction = event;
        this.requestIdByInteraction.set(event.payload.interactionId, id as string);
        return;
      }
      case "interaction.resolved": {
        const id = this.requestIdByInteraction.get(event.payload.interactionId);
        const state = id ? this.states.get(id) : undefined;
        if (!state || state.interactionResolution) return;
        state.interactionResolution = event.payload.resolution;
        return;
      }
      case "_baton_turn_request_authorization_resolved": {
        const state = this.states.get(event.payload.requestId);
        if (!state || state.authorization) return;
        state.authorization = event;
        changed = state;
        break;
      }
      case "_baton_turn_request_scheduled": {
        const state = this.states.get(event.payload.requestId);
        if (!state || state.scheduled) return;
        state.scheduled = event;
        this.requestIdByMessage.set(event.payload.messageId, event.payload.requestId);
        this.requestIdByTurn.set(event.payload.turnId, event.payload.requestId);
        changed = state;
        break;
      }
      case "user_message": {
        const id = this.requestIdByMessage.get(event.payload.messageId);
        const state = id ? this.states.get(id) : undefined;
        if (!state || state.admitted) return;
        state.admitted = true;
        changed = state;
        break;
      }
      case "_baton_delivery_attempt_update": {
        const update = event.payload;
        let id = this.requestIdByAttempt.get(update.attemptId);
        if (update.phase === "prepared") {
          id = this.requestIdByMessage.get(update.inputId);
          if (id) this.requestIdByAttempt.set(update.attemptId, id);
        }
        const state = id ? this.states.get(id) : undefined;
        if (!state) return;
        const uncertain = update.phase === "uncertain";
        if (state.uncertain === uncertain) return;
        state.uncertain = uncertain;
        changed = state;
        break;
      }
      case "_baton_turn_summary": {
        const id = this.requestIdByTurn.get(event.payload.turnId);
        const state = id ? this.states.get(id) : undefined;
        if (!state || state.result) return;
        state.result = event.payload;
        state.uncertain = false;
        changed = state;
        break;
      }
      case "_baton_turn_request_cancelled": {
        const state = this.states.get(event.payload.requestId);
        if (!state || state.cancelled || state.result) return;
        state.cancelled = event;
        changed = state;
        break;
      }
      default:
        return;
    }
    if (notify && changed) {
      this.options.onChanged?.(snapshotOf(changed), keyOf(changed));
    }
  }
}
