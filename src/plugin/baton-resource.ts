import type {
  BatonSessionResource,
  BatonSessionTargetBindingResource,
  BatonTargetResource,
  BatonTurnResource,
  Resource,
  ResourceListOptions,
  ResourceMergePatch,
  ResourceRef,
  ResourceType,
} from "@compforge/baton-plugin";

import type { HarnessTarget } from "../harness/target.ts";
import {
  sessionTargetBindingMeta,
  type SessionHandle,
  type SessionMeta,
} from "../store/store.ts";
import type { BatonResourceIndex } from "./baton-resource-controller.ts";
import {
  BATON_SESSION_RESOURCE_TYPE,
  BATON_SESSION_TARGET_BINDING_RESOURCE_TYPE,
  BATON_SYSTEM_NAMESPACE,
  BATON_TARGET_RESOURCE_TYPE,
  BATON_TURN_RESOURCE_TYPE,
} from "./package.ts";
import { resourceTypeKey } from "./resource.ts";

export interface BatonSessionObservation {
  readonly meta: SessionMeta;
  readonly active: boolean;
}

type WritableBindingSession = Pick<
  SessionHandle,
  "id" | "meta" | "setTargetBinding"
>;

export interface BatonResourceProviderOptions {
  readonly session: WritableBindingSession;
  readonly turns?: BatonResourceIndex;
  readonly sessions?: () => readonly BatonSessionObservation[];
  readonly targets?: () => readonly HarnessTarget[];
  readonly now?: () => Date;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function typeMatches(left: ResourceType, right: ResourceType): boolean {
  return resourceTypeKey(left) === resourceTypeKey(right);
}

function keysAre(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function jsonObject(name: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Core-owned Resource provider. Public clients see ordinary Resources; their
 * authoritative state remains in Session, HarnessTarget configuration, and Ledger.
 */
export class BatonResourceProvider {
  private readonly session: WritableBindingSession;
  private readonly turns?: BatonResourceIndex;
  private readonly sessions?: BatonResourceProviderOptions["sessions"];
  private readonly targets: NonNullable<BatonResourceProviderOptions["targets"]>;
  private readonly now: () => Date;
  private readonly targetCreationTimestamp: string;

  constructor(options: BatonResourceProviderOptions) {
    this.session = options.session;
    this.turns = options.turns;
    this.sessions = options.sessions;
    this.targets = options.targets ?? (() => []);
    this.now = options.now ?? (() => new Date());
    const created = this.now();
    if (Number.isNaN(created.getTime())) {
      throw new Error("Baton Resource provider now() returned an invalid Date");
    }
    this.targetCreationTimestamp = created.toISOString();
  }

  handles(type: ResourceType): boolean {
    return [
      BATON_TURN_RESOURCE_TYPE,
      BATON_SESSION_RESOURCE_TYPE,
      BATON_TARGET_RESOURCE_TYPE,
      BATON_SESSION_TARGET_BINDING_RESOURCE_TYPE,
    ].some((candidate) => typeMatches(candidate, type));
  }

  get<TSpec, TStatus>(
    ref: ResourceRef,
  ): Readonly<Resource<TSpec, TStatus>> | undefined {
    if (ref.namespace !== BATON_SYSTEM_NAMESPACE || !this.handles(ref)) return undefined;
    const resource = this.list<TSpec, TStatus>(ref).find(
      (candidate) => candidate.metadata.name === ref.name,
    );
    if (!resource || (ref.uid !== undefined && resource.metadata.uid !== ref.uid)) {
      return undefined;
    }
    return resource;
  }

  list<TSpec, TStatus>(
    type: ResourceType,
    options?: ResourceListOptions,
  ): readonly Readonly<Resource<TSpec, TStatus>>[] {
    if (
      (options?.namespace !== undefined && options.namespace !== BATON_SYSTEM_NAMESPACE) ||
      Object.keys(options?.matchLabels ?? {}).length > 0
    ) {
      return [];
    }
    let resources: readonly Resource<unknown, unknown>[];
    if (typeMatches(type, BATON_SESSION_RESOURCE_TYPE)) {
      resources = this.sessionObservations().map((session) => this.sessionResource(session));
    } else if (typeMatches(type, BATON_TARGET_RESOURCE_TYPE)) {
      resources = this.configuredTargets().map((target) => this.targetResource(target));
    } else if (typeMatches(type, BATON_SESSION_TARGET_BINDING_RESOURCE_TYPE)) {
      resources = this.sessionObservations().map((session) => this.bindingResource(session.meta));
    } else if (typeMatches(type, BATON_TURN_RESOURCE_TYPE)) {
      resources = this.turnResources();
    } else {
      return [];
    }
    return resources as readonly Readonly<Resource<TSpec, TStatus>>[];
  }

  patch<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: ResourceMergePatch,
  ): Readonly<Resource<TSpec, TStatus>> {
    if (!typeMatches(resource, BATON_SESSION_TARGET_BINDING_RESOURCE_TYPE)) {
      throw new Error(
        `Resource ${resource.apiVersion}/${resource.kind} does not support patch`,
      );
    }
    if (
      resource.metadata.namespace !== BATON_SYSTEM_NAMESPACE ||
      resource.metadata.name !== this.session.id ||
      resource.metadata.uid !== this.bindingUid(this.session.id)
    ) {
      throw new Error(
        `Plugin may patch only the current SessionTargetBinding ${this.session.id}`,
      );
    }
    if (patch.type !== "merge" || !keysAre(patch.value, ["spec"])) {
      throw new Error("SessionTargetBinding patch may change only spec.targetRef");
    }
    const spec = jsonObject("SessionTargetBinding patch spec", patch.value.spec);
    if (!keysAre(spec, ["targetRef"])) {
      throw new Error("SessionTargetBinding patch may change only spec.targetRef");
    }
    const targetId = spec.targetRef === null
      ? undefined
      : this.targetId(jsonObject("SessionTargetBinding targetRef", spec.targetRef));
    this.session.setTargetBinding(
      targetId,
      resource.metadata.resourceVersion,
      this.now(),
    );
    return this.bindingResource(this.session.meta) as Readonly<Resource<TSpec, TStatus>>;
  }

  /**
   * A binding replaces only the conventional family/default coordinate. An
   * explicit Target id remains authoritative, so `/target <id>` is still exact.
   */
  resolveTarget(requestedTargetId: string): string {
    const requested = this.configuredTargets().find((target) => target.id === requestedTargetId);
    const boundId = sessionTargetBindingMeta(this.session.meta).targetId;
    if (!requested || requested.id !== requested.harness || !boundId) {
      return requestedTargetId;
    }
    const bound = this.configuredTargets().find((target) => target.id === boundId);
    return bound?.harness === requested.harness ? bound.id : requestedTargetId;
  }

  private sessionObservations(): readonly BatonSessionObservation[] {
    const observed = new Map(
      (this.sessions?.() ?? []).map((session) => [
        session.meta.batonSessionId,
        session,
      ]),
    );
    observed.set(this.session.id, {
      meta: this.session.meta,
      active: true,
    });
    return [...observed.values()].sort((left, right) =>
      left.meta.batonSessionId.localeCompare(right.meta.batonSessionId)
    );
  }

  private configuredTargets(): readonly HarnessTarget[] {
    return [...this.targets()].sort((left, right) => left.id.localeCompare(right.id));
  }

  private sessionResource(observation: BatonSessionObservation): BatonSessionResource {
    const { meta, active } = observation;
    return deepFreeze({
      ...BATON_SESSION_RESOURCE_TYPE,
      metadata: {
        name: meta.batonSessionId,
        namespace: BATON_SYSTEM_NAMESPACE,
        uid: meta.batonSessionId,
        generation: 1,
        resourceVersion: meta.updatedAt ?? meta.createdAt,
        creationTimestamp: meta.createdAt,
      },
      spec: {},
      status: { phase: active ? "Active" : "Inactive" },
    });
  }

  private targetResource(target: HarnessTarget): BatonTargetResource {
    return deepFreeze({
      ...BATON_TARGET_RESOURCE_TYPE,
      metadata: {
        name: target.id,
        namespace: BATON_SYSTEM_NAMESPACE,
        uid: this.targetUid(target.id),
        generation: 1,
        resourceVersion: "1",
        creationTimestamp: this.targetCreationTimestamp,
      },
      spec: { harness: target.harness },
      status: { phase: "Ready" },
    });
  }

  private bindingResource(meta: SessionMeta): BatonSessionTargetBindingResource {
    const binding = sessionTargetBindingMeta(meta);
    const targets = this.configuredTargets();
    const selected = binding.targetId === undefined
      ? undefined
      : targets.find((target) => target.id === binding.targetId);
    const targetRef = selected ? this.targetRef(selected.id) : undefined;
    return deepFreeze({
      ...BATON_SESSION_TARGET_BINDING_RESOURCE_TYPE,
      metadata: {
        name: meta.batonSessionId,
        namespace: BATON_SYSTEM_NAMESPACE,
        uid: this.bindingUid(meta.batonSessionId),
        generation: binding.generation,
        resourceVersion: String(binding.resourceVersion),
        creationTimestamp: meta.createdAt,
      },
      spec: {
        sessionRef: this.sessionRef(meta.batonSessionId),
        eligibleTargetRefs: targets.map((target) => this.targetRef(target.id)),
        ...(targetRef === undefined ? {} : { targetRef }),
      },
      status: {
        observedGeneration: binding.generation,
        ...(targetRef === undefined ? {} : { effectiveTargetRef: targetRef }),
        phase: binding.targetId === undefined
          ? "Pending"
          : selected
            ? "Bound"
            : "Failed",
      },
    });
  }

  private turnResources(): readonly BatonTurnResource[] {
    if (!this.turns) return [];
    return this.turns.list(BATON_TURN_RESOURCE_TYPE.kind).map((turn) =>
      deepFreeze({
        ...BATON_TURN_RESOURCE_TYPE,
        metadata: {
          name: turn.metadata.resourceId,
          namespace: BATON_SYSTEM_NAMESPACE,
          uid: turn.metadata.sourceEventId,
          generation: 1,
          resourceVersion: String(turn.metadata.revision),
          creationTimestamp: turn.metadata.observedAt,
        },
        spec: {},
        status: turn.data as unknown as BatonTurnResource["status"],
      }) as BatonTurnResource
    );
  }

  private targetId(ref: Record<string, unknown>): string {
    if (
      ref.apiVersion !== BATON_TARGET_RESOURCE_TYPE.apiVersion ||
      ref.kind !== BATON_TARGET_RESOURCE_TYPE.kind ||
      ref.namespace !== BATON_SYSTEM_NAMESPACE ||
      typeof ref.name !== "string"
    ) {
      throw new Error("SessionTargetBinding targetRef must reference a Baton Target");
    }
    const target = this.configuredTargets().find((candidate) => candidate.id === ref.name);
    if (!target) throw new Error(`SessionTargetBinding target is not eligible: ${ref.name}`);
    if (ref.uid !== undefined && ref.uid !== this.targetUid(target.id)) {
      throw new Error(`SessionTargetBinding target uid does not match: ${target.id}`);
    }
    return target.id;
  }

  private sessionRef(sessionId: string): ResourceRef {
    return Object.freeze({
      ...BATON_SESSION_RESOURCE_TYPE,
      namespace: BATON_SYSTEM_NAMESPACE,
      name: sessionId,
      uid: sessionId,
    });
  }

  private targetRef(targetId: string): ResourceRef {
    return Object.freeze({
      ...BATON_TARGET_RESOURCE_TYPE,
      namespace: BATON_SYSTEM_NAMESPACE,
      name: targetId,
      uid: this.targetUid(targetId),
    });
  }

  private targetUid(targetId: string): string {
    return `target:${targetId}`;
  }

  private bindingUid(sessionId: string): string {
    return `session-target-binding:${sessionId}`;
  }
}
