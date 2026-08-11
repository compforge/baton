import { createHash } from "node:crypto";

import type {
  HarnessCancellationReason,
  HarnessFailureReason,
  ReconcileOperationRef,
  ResourceRef,
  TurnSummary,
} from "@compforge/baton-plugin";

import { newId } from "../event/ids.ts";
import type {
  AnyEventEnvelope,
  EventEnvelope,
  HarnessInvocationCancelled,
  HarnessInvocationFailed,
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
  | "queued"
  | "running"
  | "uncertain"
  | "completed"
  | "cancelled"
  | "failed";

export interface HarnessInvocationSnapshot {
  readonly invocationId: string;
  readonly operation: HarnessOperationRef;
  readonly resource: ResourceRef;
  readonly phase: HarnessInvocationPhase;
  readonly newLane: boolean;
  readonly harnessTargetId: string;
  readonly laneId?: string;
  readonly turnId?: string;
  readonly result?: TurnSummary;
  readonly cancellation?: Readonly<HarnessInvocationCancelled>;
  readonly failure?: Readonly<HarnessInvocationFailed>;
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
    readonly blocks?: readonly PromptBlock[];
    readonly laneId: string;
    readonly newLane: boolean;
    readonly harnessTargetId: string;
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

interface InvocationState {
  readonly recorded: EventEnvelope<"_baton_harness_invocation_recorded">;
  scheduled?: EventEnvelope<"_baton_harness_invocation_scheduled">;
  cancelled?: EventEnvelope<"_baton_harness_invocation_cancelled">;
  failed?: EventEnvelope<"_baton_harness_invocation_failed">;
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
    JSON.stringify(current.blocks) === JSON.stringify(invocation.blocks) &&
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
  if (state.failed) return "failed";
  if (state.cancelled) return "cancelled";
  if (state.uncertain) return "uncertain";
  if (state.admitted) return "running";
  if (state.scheduled) return "queued";
  return "queued";
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
  return Object.freeze({
    invocationId: recorded.invocationId,
    operation: Object.freeze({ ...recorded.operation }),
    resource: Object.freeze({ ...recorded.resource }),
    phase: phaseOf(state),
    newLane: recorded.newLane,
    harnessTargetId: recorded.harnessTargetId,
    ...(state.scheduled === undefined
      ? {}
      : {
          laneId: state.scheduled.payload.laneId,
          turnId: state.scheduled.payload.turnId,
        }),
    ...(state.result === undefined
      ? {}
      : { result: frozenSummary(state.result) }),
    ...(state.cancelled === undefined
      ? {}
      : { cancellation: Object.freeze({ ...state.cancelled.payload }) }),
    ...(state.failed === undefined
      ? {}
      : { failure: Object.freeze({ ...state.failed.payload }) }),
  });
}

function scheduledOf(
  state: InvocationState,
): ScheduledHarnessInvocation | undefined {
  if (state.result || state.cancelled || state.failed) return;
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
    blocks: invocationBlocks(state),
  });
}

function invocationBlocks(state: InvocationState): readonly PromptBlock[] {
  const recorded = state.recorded.payload;
  if (recorded.operation.verb !== "draft") {
    return [{ type: "text", text: recorded.prompt } satisfies PromptBlock];
  }
  if (!recorded.blocks?.length) {
    throw new Error(
      `draft HarnessInvocation ${recorded.invocationId} has no submitted Interaction blocks`,
    );
  }
  return recorded.blocks;
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
    if (
      draft.invocation.operation.verb === "draft" &&
      (draft.invocation.blocks === undefined ||
        draft.invocation.blocks.length === 0)
    ) {
      throw new Error(
        "draft HarnessInvocation requires blocks from a submitted Interaction",
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
        ...(invocation.blocks === undefined
          ? {}
          : { blocks: invocation.blocks.map((block) => ({ ...block })) }),
        laneId: invocation.laneId,
        newLane: invocation.newLane,
        harnessTargetId: invocation.harnessTargetId,
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

  latestCancellable(identifier?: string): HarnessInvocationSnapshot | undefined {
    const states = [...this.states.values()]
      .filter((state) => {
        const phase = phaseOf(state);
        return phase !== "completed" && phase !== "cancelled" &&
          phase !== "failed" &&
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
    reason: HarnessCancellationReason,
    detail?: string,
  ): ReconcileKey | undefined {
    const state = this.states.get(invocationId);
    if (
      !state || state.admitted || state.result || state.cancelled || state.failed
    ) return;
    this.appendCancellation(state, reason, detail);
    return keyOf(state);
  }

  failBeforeAdmission(
    invocationId: string,
    reason: HarnessFailureReason,
    detail: string,
  ): ReconcileKey | undefined {
    const state = this.states.get(invocationId);
    if (
      !state || state.admitted || state.result || state.cancelled || state.failed
    ) return;
    this.appendFailure(state, reason, detail);
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
        state.failed
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
      if (state.result || state.cancelled || state.failed) continue;
      const scheduled = this.ensureScheduled(state);
      const current = this.states.get(
        state.recorded.payload.invocationId,
      ) as InvocationState;
      if (
        scheduled &&
        !current.admitted &&
        !current.uncertain &&
        !current.cancelled &&
        !current.failed &&
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
      state.cancelled ||
      state.failed ||
      state.result
    ) {
      return;
    }
    invocationBlocks(state);
    this.session.requireLane(recorded.laneId);
    const scheduled: HarnessInvocationScheduled = {
      invocationId: recorded.invocationId,
      messageId: newId("m"),
      turnId: newId("t"),
      harnessTargetId: recorded.harnessTargetId,
      laneId: recorded.newLane ? newId("hl") : recorded.laneId,
    };
    this.session.append({
      kind: "_baton_harness_invocation_scheduled",
      source: { type: "baton" },
      parentEventId: state.recorded.eventId,
      payload: scheduled,
    });
    return scheduledOf(
      this.states.get(scheduled.invocationId) as InvocationState,
    );
  }

  private appendCancellation(
    state: InvocationState,
    reason: HarnessCancellationReason,
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

  private appendFailure(
    state: InvocationState,
    reason: HarnessFailureReason,
    detail: string,
  ): void {
    this.session.append({
      kind: "_baton_harness_invocation_failed",
      source: { type: "baton" },
      parentEventId: state.scheduled?.eventId ?? state.recorded.eventId,
      payload: {
        invocationId: state.recorded.payload.invocationId,
        reason,
        detail,
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
        if (!state || state.result || state.cancelled || state.failed) return;
        state.result = event.payload;
        state.uncertain = false;
        changed = state;
        break;
      }
      case "_baton_harness_invocation_cancelled": {
        const state = this.states.get(event.payload.invocationId);
        if (!state || state.cancelled || state.failed || state.result) return;
        state.cancelled = event;
        changed = state;
        break;
      }
      case "_baton_harness_invocation_failed": {
        const state = this.states.get(event.payload.invocationId);
        if (!state || state.failed || state.cancelled || state.result) return;
        state.failed = event;
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
