import { createHash } from "node:crypto";

import type {
  ReconcileOperationRef,
  ResourceRef,
  TurnSummary,
} from "@compforge/baton-plugin";

import { newId } from "../event/ids.ts";
import type {
  AnyEventEnvelope,
  EventEnvelope,
  HarnessInvocationRecorded,
  HarnessInvocationScheduled,
  PromptBlock,
} from "../event/types.ts";
import type { SessionHandle } from "../store/store.ts";
import type { ReconcileKey } from "./controller.ts";
import {
  reconcileOperationIdentity,
  reconcileOperationLabel,
} from "./reconcile-operation.ts";
import { reconcileResourceOwner } from "./reconcile-scope.ts";

type HarnessOperationRef = ReconcileOperationRef<"draft" | "harness">;

export type HarnessInvocationPhase =
  | "awaiting_input"
  | "queued"
  | "running"
  | "uncertain"
  | "completed"
  | "cancelled";

export interface HarnessInvocationSnapshot {
  readonly invocationId: string;
  readonly operation: HarnessOperationRef;
  readonly resource: ResourceRef;
  readonly phase: HarnessInvocationPhase;
  readonly newLane: boolean;
  readonly harnessTargetId?: string;
  readonly laneId?: string;
  readonly turnId?: string;
  readonly result?: TurnSummary;
}

export interface ReconcileHarnessInvocation {
  readonly key: ReconcileKey;
  readonly resource: ResourceRef;
  readonly basedOnGeneration?: number;
  readonly basedOnResourceVersion?: string;
  readonly basedOnRevision?: number;
  readonly invocation: {
    readonly operation: HarnessOperationRef;
    readonly title: string;
    readonly prompt: string;
    readonly laneId: string;
    readonly newLane: boolean;
    /** Required for harness(); omitted draft() Targets resolve when the user submits. */
    readonly harnessTargetId?: string;
  };
}

type HarnessInvocationSession = Pick<
  SessionHandle,
  "id" | "readEvents" | "subscribe" | "append" | "requireLane"
>;

export interface ScheduledHarnessInvocation {
  readonly invocationId: string;
  readonly pluginInstanceId: string;
  readonly harnessTargetId: string;
  readonly laneId: string;
  readonly newLane: boolean;
  readonly parentLaneId?: string;
  readonly source: "user" | "plugin";
  readonly messageId: string;
  readonly turnId: string;
  readonly blocks: readonly PromptBlock[];
}

export interface DraftHarnessInvocationInput {
  readonly invocationId: string;
  readonly pluginInstanceId: string;
  readonly title: string;
  readonly prompt: string;
  /** Plugin-fixed Target; omit to use the host selection when the user submits. */
  readonly harnessTargetId?: string;
}

export interface ResolvedHarnessInvocation {
  readonly key: ReconcileKey;
  readonly scheduled?: ScheduledHarnessInvocation;
}

interface InvocationState {
  readonly recorded: EventEnvelope<"_baton_harness_invocation_recorded">;
  inputSubmission?: EventEnvelope<"_baton_harness_invocation_input_submitted">;
  scheduled?: EventEnvelope<"_baton_harness_invocation_scheduled">;
  cancelled?: EventEnvelope<"_baton_harness_invocation_cancelled">;
  admitted: boolean;
  uncertain: boolean;
  result?: TurnSummary;
}

export interface HarnessInvocationStoreOptions {
  onChanged?(invocation: HarnessInvocationSnapshot, key: ReconcileKey): void;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invocationId(
  draft: Pick<ReconcileHarnessInvocation, "key" | "resource">,
  operation: HarnessOperationRef,
): string {
  return `hinv_${digest(reconcileOperationIdentity({
    batonSessionId: draft.key.batonSessionId,
    pluginInstanceId: draft.key.pluginInstanceId,
    resourceOwner: reconcileResourceOwner(draft.key),
    resource: draft.resource,
  }, operation))}`;
}

function sameResource(left: ResourceRef, right: ResourceRef): boolean {
  return left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.namespace === right.namespace &&
    left.name === right.name &&
    left.uid === right.uid;
}

function sameEnvelope(
  current: HarnessInvocationRecorded,
  draft: ReconcileHarnessInvocation,
): boolean {
  const invocation = draft.invocation;
  return current.operation.verb === invocation.operation.verb &&
    current.operation.key === invocation.operation.key &&
    current.resourceOwner === reconcileResourceOwner(draft.key) &&
    sameResource(current.resource, draft.resource) &&
    current.title === invocation.title &&
    current.prompt === invocation.prompt &&
    current.laneId === invocation.laneId &&
    current.newLane === invocation.newLane &&
    current.harnessTargetId === invocation.harnessTargetId;
}

function keyOf(state: InvocationState): ReconcileKey {
  const source = state.recorded.source;
  if (source.type !== "plugin") {
    throw new Error(
      `HarnessInvocation ${state.recorded.payload.invocationId} has a non-Plugin source`,
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

function pluginInstanceIdOf(state: InvocationState): string {
  const source = state.recorded.source;
  if (source.type !== "plugin") {
    throw new Error(
      `HarnessInvocation ${state.recorded.payload.invocationId} has a non-Plugin source`,
    );
  }
  return source.pluginInstanceId;
}

function phaseOf(state: InvocationState): HarnessInvocationPhase {
  if (state.result) return "completed";
  if (state.cancelled) return "cancelled";
  if (state.uncertain) return "uncertain";
  if (state.admitted) return "running";
  if (state.scheduled) return "queued";
  return state.recorded.payload.operation.verb === "draft"
    ? "awaiting_input"
    : "queued";
}

function frozenSummary(summary: TurnSummary): TurnSummary {
  return Object.freeze({
    ...summary,
    toolCalls: Object.freeze(
      summary.toolCalls.map((toolCall) => Object.freeze({ ...toolCall })),
    ),
    ...(summary.usage === undefined
      ? {}
      : { usage: Object.freeze({ ...summary.usage }) }),
  });
}

function snapshotOf(state: InvocationState): HarnessInvocationSnapshot {
  const recorded = state.recorded.payload;
  const harnessTargetId = state.inputSubmission?.payload.harnessTargetId ??
    recorded.harnessTargetId;
  return Object.freeze({
    invocationId: recorded.invocationId,
    operation: Object.freeze({ ...recorded.operation }),
    resource: Object.freeze({ ...recorded.resource }),
    phase: phaseOf(state),
    newLane: recorded.newLane,
    ...(harnessTargetId === undefined ? {} : { harnessTargetId }),
    ...(state.scheduled === undefined
      ? {}
      : {
          laneId: state.scheduled.payload.laneId,
          turnId: state.scheduled.payload.turnId,
        }),
    ...(state.result === undefined
      ? {}
      : { result: frozenSummary(state.result) }),
  });
}

function scheduledOf(
  state: InvocationState,
): ScheduledHarnessInvocation | undefined {
  const scheduled = state.scheduled?.payload;
  if (!scheduled) return;
  const recorded = state.recorded.payload;
  return Object.freeze({
    invocationId: scheduled.invocationId,
    pluginInstanceId: pluginInstanceIdOf(state),
    harnessTargetId: scheduled.harnessTargetId,
    laneId: scheduled.laneId,
    newLane: recorded.newLane,
    ...(recorded.newLane ? { parentLaneId: recorded.laneId } : {}),
    source: recorded.operation.verb === "draft" ? "user" : "plugin",
    messageId: scheduled.messageId,
    turnId: scheduled.turnId,
    blocks: state.inputSubmission?.payload.blocks ?? [
      { type: "text", text: recorded.prompt } satisfies PromptBlock,
    ],
  });
}

/** Event-backed owner for one durable harness() or draft() execution. */
export class HarnessInvocationStore {
  private readonly states = new Map<string, InvocationState>();
  private readonly invocationIdByMessage = new Map<string, string>();
  private readonly invocationIdByTurn = new Map<string, string>();
  private readonly invocationIdByAttempt = new Map<string, string>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly session: HarnessInvocationSession,
    private readonly options: HarnessInvocationStoreOptions = {},
  ) {
    for (const event of session.readEvents()) this.apply(event, false);
    this.unsubscribe = session.subscribe((event) => this.apply(event, true));
  }

  current(
    context: Pick<ReconcileHarnessInvocation, "key" | "resource">,
    operation: HarnessOperationRef,
  ): HarnessInvocationSnapshot | undefined {
    const state = this.states.get(invocationId(context, operation));
    return state ? snapshotOf(state) : undefined;
  }

  record(draft: ReconcileHarnessInvocation): HarnessInvocationSnapshot {
    if (draft.key.batonSessionId !== this.session.id) {
      throw new Error(
        `HarnessInvocation batonSessionId must be ${this.session.id}, got ${draft.key.batonSessionId}`,
      );
    }
    const id = invocationId(draft, draft.invocation.operation);
    const existing = this.states.get(id);
    if (existing) {
      if (!sameEnvelope(existing.recorded.payload, draft)) {
        throw new Error(
          `HarnessInvocation identity conflict for ${reconcileOperationLabel(draft.invocation.operation)}: ${id}`,
        );
      }
      this.ensureScheduled(existing);
      return snapshotOf(existing);
    }

    const invocation = draft.invocation;
    // Lane selection is part of the durable request envelope. Reject a stale or
    // unknown base Lane before writing an invocation that can never be scheduled.
    this.session.requireLane(invocation.laneId);
    this.session.append({
      kind: "_baton_harness_invocation_recorded",
      source: {
        type: "plugin",
        pluginInstanceId: draft.key.pluginInstanceId,
      },
      payload: {
        invocationId: id,
        operation: { ...invocation.operation },
        resourceOwner: reconcileResourceOwner(draft.key),
        resource: { ...draft.resource },
        title: invocation.title,
        prompt: invocation.prompt,
        laneId: invocation.laneId,
        newLane: invocation.newLane,
        ...(invocation.harnessTargetId === undefined
          ? {}
          : { harnessTargetId: invocation.harnessTargetId }),
      },
    });
    const state = this.states.get(id);
    if (!state) throw new Error(`HarnessInvocation was not recorded: ${id}`);
    this.ensureScheduled(state);
    return snapshotOf(state);
  }

  scheduled(invocationId: string): ScheduledHarnessInvocation | undefined {
    const state = this.states.get(invocationId);
    return state ? scheduledOf(state) : undefined;
  }

  list(): readonly HarnessInvocationSnapshot[] {
    return Object.freeze(
      [...this.states.values()]
        .sort((left, right) => left.recorded.seq - right.recorded.seq)
        .map(snapshotOf),
    );
  }

  pendingDraftInputs(): readonly DraftHarnessInvocationInput[] {
    return Object.freeze(
      [...this.states.values()]
        .filter((state) => phaseOf(state) === "awaiting_input")
        .sort((left, right) => left.recorded.seq - right.recorded.seq)
        .map((state) => Object.freeze({
          invocationId: state.recorded.payload.invocationId,
          pluginInstanceId: pluginInstanceIdOf(state),
          title: state.recorded.payload.title,
          prompt: state.recorded.payload.prompt,
          ...(state.recorded.payload.harnessTargetId === undefined
            ? {}
            : { harnessTargetId: state.recorded.payload.harnessTargetId }),
        })),
    );
  }

  resolveDraftInput(
    invocationId: string,
    outcome:
      | {
          readonly kind: "submitted";
          readonly blocks: readonly PromptBlock[];
          readonly harnessTargetId: string;
        }
      | { readonly kind: "dismissed" },
  ): ResolvedHarnessInvocation | undefined {
    const state = this.states.get(invocationId);
    if (
      !state ||
      phaseOf(state) !== "awaiting_input" ||
      state.recorded.payload.operation.verb !== "draft"
    ) {
      return;
    }
    if (outcome.kind === "dismissed") {
      this.appendCancellation(state, "user", "draft input dismissed");
      return Object.freeze({ key: keyOf(state) });
    }
    if (outcome.blocks.length === 0) {
      throw new Error(
        `HarnessInvocation ${invocationId} draft input must not be empty`,
      );
    }
    const fixedHarnessTargetId = state.recorded.payload.harnessTargetId;
    if (
      fixedHarnessTargetId !== undefined &&
      outcome.harnessTargetId !== fixedHarnessTargetId
    ) {
      throw new Error(
        `HarnessInvocation ${invocationId} must use its fixed HarnessTarget: ${fixedHarnessTargetId}`,
      );
    }
    this.session.append({
      kind: "_baton_harness_invocation_input_submitted",
      source: { type: "user" },
      parentEventId: state.recorded.eventId,
      payload: {
        invocationId,
        blocks: [...outcome.blocks],
        harnessTargetId: outcome.harnessTargetId,
      },
    });
    const current = this.states.get(invocationId) as InvocationState;
    const scheduled = this.ensureScheduled(current);
    return Object.freeze({
      key: keyOf(current),
      ...(scheduled === undefined ? {} : { scheduled }),
    });
  }

  latestCancellable(identifier?: string): HarnessInvocationSnapshot | undefined {
    const states = [...this.states.values()]
      .filter((state) => {
        const phase = phaseOf(state);
        return phase !== "completed" && phase !== "cancelled" &&
          (identifier === undefined ||
            state.recorded.payload.invocationId === identifier);
      })
      .sort((left, right) => right.recorded.seq - left.recorded.seq);
    return states[0] ? snapshotOf(states[0]) : undefined;
  }

  isAdmitted(invocationId: string): boolean {
    return this.states.get(invocationId)?.admitted ?? false;
  }

  cancelBeforeAdmission(
    invocationId: string,
    reason: "user" | "resource" | "recovery",
    detail?: string,
  ): ReconcileKey | undefined {
    const state = this.states.get(invocationId);
    if (!state || state.admitted || state.result || state.cancelled) return;
    this.appendCancellation(state, reason, detail);
    return keyOf(state);
  }

  cancelForResource(resource: ResourceRef): string[] {
    const cancelled: string[] = [];
    for (const state of this.states.values()) {
      if (
        !sameResource(state.recorded.payload.resource, resource) ||
        state.admitted ||
        state.result ||
        state.cancelled
      ) {
        continue;
      }
      const id = state.recorded.payload.invocationId;
      this.cancelBeforeAdmission(id, "resource");
      cancelled.push(id);
    }
    return cancelled;
  }

  /** Repairs ledger gaps and returns scheduled Inputs that still need dispatch. */
  restore(): readonly ScheduledHarnessInvocation[] {
    const pending: ScheduledHarnessInvocation[] = [];
    for (const state of this.states.values()) {
      if (state.result || state.cancelled) continue;
      if (
        state.recorded.payload.operation.verb === "draft" &&
        !state.inputSubmission
      ) {
        continue;
      }
      const scheduled = this.ensureScheduled(state);
      const current = this.states.get(
        state.recorded.payload.invocationId,
      ) as InvocationState;
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

  private ensureScheduled(
    state: InvocationState,
  ): ScheduledHarnessInvocation | undefined {
    if (state.scheduled) return scheduledOf(state);
    const recorded = state.recorded.payload;
    if (
      (recorded.operation.verb === "draft" && !state.inputSubmission) ||
      state.cancelled ||
      state.result
    ) {
      return;
    }
    const harnessTargetId = state.inputSubmission?.payload.harnessTargetId ??
      recorded.harnessTargetId;
    if (!harnessTargetId) {
      throw new Error(
        `HarnessInvocation ${recorded.invocationId} requires a HarnessTarget before scheduling`,
      );
    }
    this.session.requireLane(recorded.laneId);
    const scheduled: HarnessInvocationScheduled = {
      invocationId: recorded.invocationId,
      messageId: newId("m"),
      turnId: newId("t"),
      harnessTargetId,
      laneId: recorded.newLane ? newId("hl") : recorded.laneId,
    };
    this.session.append({
      kind: "_baton_harness_invocation_scheduled",
      source: { type: "baton" },
      parentEventId:
        state.inputSubmission?.eventId ?? state.recorded.eventId,
      payload: scheduled,
    });
    return scheduledOf(
      this.states.get(scheduled.invocationId) as InvocationState,
    );
  }

  private appendCancellation(
    state: InvocationState,
    reason: "user" | "resource" | "recovery",
    detail?: string,
  ): void {
    this.session.append({
      kind: "_baton_harness_invocation_cancelled",
      source: reason === "user" ? { type: "user" } : { type: "baton" },
      parentEventId: state.scheduled?.eventId ?? state.recorded.eventId,
      payload: {
        invocationId: state.recorded.payload.invocationId,
        reason,
        ...(detail === undefined ? {} : { detail }),
      },
    });
  }

  private apply(event: AnyEventEnvelope, notify: boolean): void {
    let changed: InvocationState | undefined;
    switch (event.kind) {
      case "_baton_harness_invocation_recorded": {
        if (this.states.has(event.payload.invocationId)) return;
        this.states.set(event.payload.invocationId, {
          recorded: event,
          admitted: false,
          uncertain: false,
        });
        return;
      }
      case "_baton_harness_invocation_input_submitted": {
        const state = this.states.get(event.payload.invocationId);
        if (!state || state.inputSubmission) return;
        state.inputSubmission = event;
        changed = state;
        break;
      }
      case "_baton_harness_invocation_scheduled": {
        const state = this.states.get(event.payload.invocationId);
        if (!state || state.scheduled) return;
        state.scheduled = event;
        this.invocationIdByMessage.set(
          event.payload.messageId,
          event.payload.invocationId,
        );
        this.invocationIdByTurn.set(
          event.payload.turnId,
          event.payload.invocationId,
        );
        changed = state;
        break;
      }
      case "user_message": {
        const id = this.invocationIdByMessage.get(event.payload.messageId);
        const state = id ? this.states.get(id) : undefined;
        if (!state || state.admitted) return;
        state.admitted = true;
        changed = state;
        break;
      }
      case "_baton_delivery_attempt_update": {
        const update = event.payload;
        let id = this.invocationIdByAttempt.get(update.attemptId);
        if (update.phase === "prepared") {
          id = this.invocationIdByMessage.get(update.inputId);
          if (id) this.invocationIdByAttempt.set(update.attemptId, id);
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
        const id = this.invocationIdByTurn.get(event.payload.turnId);
        const state = id ? this.states.get(id) : undefined;
        if (!state || state.result) return;
        state.result = event.payload;
        state.uncertain = false;
        changed = state;
        break;
      }
      case "_baton_harness_invocation_cancelled": {
        const state = this.states.get(event.payload.invocationId);
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
