import { isDeepStrictEqual } from "node:util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type {
  Resource,
  ResourceListOptions,
  ResourceNamespace,
  ResourceOwnerReference,
  ResourceType,
} from "@compforge/baton-plugin";

import { newId } from "../event/ids.ts";
import { withAsyncFileLock, withFileLock } from "../store/file-lock.ts";
import type { SessionHandle } from "../store/store.ts";
import {
  namespaceContains,
  parseResourceNamespace,
} from "./namespace.ts";

export type PluginResource<
  TSpec = Record<string, unknown>,
  TStatus = Record<string, unknown>,
> = Resource<TSpec, TStatus>;

export interface PluginResourceStoreOptions {
  session: Pick<SessionHandle, "id" | "dir">;
  pluginInstanceId: string;
}

interface MutationOptions {
  expectedResourceVersion?: string;
  namespace?: ResourceNamespace;
}

interface CreateResource<TSpec, TStatus> {
  type: ResourceType;
  name?: string;
  namespace?: ResourceNamespace;
  labels?: Readonly<Record<string, string>>;
  annotations?: Readonly<Record<string, string>>;
  owner?: ResourceOwnerReference;
  spec: TSpec;
  status?: TStatus;
}

interface EnsureResource<TSpec> {
  type: ResourceType;
  name: string;
  namespace?: ResourceNamespace;
  labels?: Readonly<Record<string, string>>;
  annotations?: Readonly<Record<string, string>>;
  owner?: ResourceOwnerReference;
  spec: TSpec;
}

interface EnsureResourceResult<TSpec, TStatus> {
  resource: PluginResource<TSpec, TStatus>;
  created: boolean;
}

export interface ResourceDeletionUpdate {
  readonly oldResource: PluginResource<unknown, unknown>;
  readonly resource: PluginResource<unknown, unknown>;
}

interface ResourceControl {
  nextReconcileAt?: string;
}

interface StoredPluginResource<TSpec, TStatus> {
  object: PluginResource<TSpec, TStatus>;
  control: ResourceControl;
}

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const API_VERSION =
  /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?\/v[0-9]+(?:(?:alpha|beta)[0-9]+)?$/;
const RESOURCE_SHORT_NAME = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const RESOURCE_VERSION = /^[1-9][0-9]*$/;
const LABEL_NAME =
  /^[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const DNS_SUBDOMAIN =
  /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;

function assertPathSegment(name: string, value: string): void {
  if (!PATH_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`${name} must be a non-empty stable identifier without path separators`);
  }
}

export function validateResourceType(type: ResourceType): ResourceType {
  if (!type || typeof type !== "object") {
    throw new Error("resource type must be an object");
  }
  if (!API_VERSION.test(type.apiVersion)) {
    throw new Error(
      "resource apiVersion must use a DNS group and Kubernetes-style version",
    );
  }
  assertPathSegment("resource kind", type.kind);
  if (type.shortNames !== undefined) {
    if (
      !Array.isArray(type.shortNames) ||
      type.shortNames.length === 0 ||
      type.shortNames.some((name) => !RESOURCE_SHORT_NAME.test(name))
    ) {
      throw new Error(
        "resource shortNames must be a non-empty list of lowercase aliases",
      );
    }
  }
  return type;
}

function sameResourceType(
  left: ResourceType,
  right: ResourceType,
): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind
  );
}

export function resourceTypeKey(type: ResourceType): string {
  validateResourceType(type);
  return JSON.stringify([type.apiVersion, type.kind]);
}

function jsonObject<T>(name: string, value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must contain only JSON values: ${detail}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isDeepStrictEqual(value, parsed)) {
    throw new Error(`${name} must contain only lossless JSON values`);
  }
  return parsed as T;
}

function annotationMap(
  name: string,
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return;
  const map = jsonObject(name, value);
  for (const [key, entry] of Object.entries(map)) {
    if (!key || typeof entry !== "string") {
      throw new Error(`${name} must contain only non-empty keys and string values`);
    }
  }
  return map;
}

function annotationMapPatch(
  name: string,
  value: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string | null>> {
  const map = jsonObject(name, value);
  for (const [key, entry] of Object.entries(map)) {
    if (!key || (typeof entry !== "string" && entry !== null)) {
      throw new Error(`${name} must contain only non-empty keys and string or null values`);
    }
  }
  return map;
}

function labelKey(name: string, key: string): void {
  const parts = key.split("/");
  if (parts.length > 2) {
    throw new Error(`${name} key ${JSON.stringify(key)} must contain at most one "/"`);
  }
  const labelName = parts.at(-1)!;
  if (labelName.length < 1 || labelName.length > 63 || !LABEL_NAME.test(labelName)) {
    throw new Error(`${name} key ${JSON.stringify(key)} has an invalid label name`);
  }
  const prefix = parts.length === 2 ? parts[0]! : undefined;
  if (
    prefix !== undefined &&
    (prefix.length < 1 || prefix.length > 253 || !DNS_SUBDOMAIN.test(prefix) ||
      prefix.split(".").some((part) => part.length > 63))
  ) {
    throw new Error(`${name} key ${JSON.stringify(key)} has an invalid DNS prefix`);
  }
}

function labelValue(name: string, key: string, value: string): void {
  if (
    value.length > 63 ||
    (value.length > 0 && !LABEL_NAME.test(value))
  ) {
    throw new Error(`${name} value for ${JSON.stringify(key)} is not a valid label value`);
  }
}

function labelMap(
  name: string,
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return;
  const map = jsonObject(name, value);
  for (const [key, entry] of Object.entries(map)) {
    if (typeof entry !== "string") {
      throw new Error(`${name} must contain only string values`);
    }
    labelKey(name, key);
    labelValue(name, key, entry);
  }
  return map;
}

function labelMapPatch(
  name: string,
  value: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string | null>> {
  const map = jsonObject(name, value);
  for (const [key, entry] of Object.entries(map)) {
    if (typeof entry !== "string" && entry !== null) {
      throw new Error(`${name} must contain only string or null values`);
    }
    labelKey(name, key);
    if (entry !== null) labelValue(name, key, entry);
  }
  return map;
}

function containsStringMap(
  current: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>> | undefined,
): boolean {
  return expected === undefined ||
    Object.entries(expected).every(([key, value]) => current?.[key] === value);
}

function applyStringMapPatch(
  current: Readonly<Record<string, string>> | undefined,
  patch: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string>> | undefined {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function positiveInteger(name: string, value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function resourceVersion(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !RESOURCE_VERSION.test(value)) {
    throw new Error(`${name} must be an opaque positive version`);
  }
}

function nextResourceVersion(current: string): string {
  const next = BigInt(current) + 1n;
  return next.toString();
}

function isoTimestamp(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export class PluginResourceStore {
  private readonly sessionDir: string;
  readonly batonSessionId: string;
  readonly pluginInstanceId: string;

  constructor(options: PluginResourceStoreOptions) {
    assertPathSegment("batonSessionId", options.session.id);
    assertPathSegment("pluginInstanceId", options.pluginInstanceId);
    this.sessionDir = options.session.dir;
    this.batonSessionId = options.session.id;
    this.pluginInstanceId = options.pluginInstanceId;
  }

  create<TSpec, TStatus = Record<string, unknown>>(
    input: CreateResource<TSpec, TStatus>,
  ): PluginResource<TSpec, TStatus> {
    const type = validateResourceType(input.type);
    const name = input.name ?? newId("pr");
    const namespace = this.resourceNamespace(input.namespace ?? "v1");
    const labels = labelMap("metadata.labels", input.labels);
    const annotations = annotationMap(
      "metadata.annotations",
      input.annotations,
    );
    assertPathSegment("resource name", name);
    const owner = this.ownerReference(input.owner, type, name, namespace);
    const path = this.resourcePath(type, name, namespace);
    return withFileLock(path, () => {
      if (existsSync(path)) {
        throw new Error(`plugin resource already exists: ${type.kind}/${name}`);
      }
      this.assertOwnerActive(owner);
      const stored = this.initialStoredResource<TSpec, TStatus>({
        type,
        name,
        namespace,
        labels,
        annotations,
        owner,
        spec: input.spec,
        status: input.status ?? ({} as TStatus),
      });
      writeJsonAtomic(path, stored);
      return stored.object;
    });
  }

  /**
   * Materializes a Source-owned Resource identity once. Repeated observations
   * are wakeups, not implicit spec updates.
   */
  ensure<TSpec, TStatus = Record<string, unknown>>(
    input: EnsureResource<TSpec>,
  ): EnsureResourceResult<TSpec, TStatus> {
    const type = validateResourceType(input.type);
    const name = input.name;
    const namespace = this.resourceNamespace(input.namespace ?? "v1");
    const labels = labelMap("metadata.labels", input.labels);
    const annotations = annotationMap(
      "metadata.annotations",
      input.annotations,
    );
    const spec = jsonObject("spec", input.spec);
    assertPathSegment("resource name", name);
    const owner = this.ownerReference(input.owner, type, name, namespace);
    const path = this.resourcePath(type, name, namespace);
    return withFileLock(path, () => {
      if (!existsSync(path)) {
        this.assertOwnerActive(owner);
        const stored = this.initialStoredResource<TSpec, TStatus>({
          type,
          name,
          namespace,
          labels,
          annotations,
          owner,
          spec,
          status: {} as TStatus,
        });
        writeJsonAtomic(path, stored);
        return { resource: stored.object, created: true };
      }
      const current = this.readCurrentStored<TSpec, TStatus>(
        type,
        name,
        namespace,
      ).object;
      if (
        !isDeepStrictEqual(current.spec, spec) ||
        !containsStringMap(current.metadata.labels, labels) ||
        !containsStringMap(current.metadata.annotations, annotations) ||
        !isDeepStrictEqual(current.metadata.owner, owner)
      ) {
        throw new Error(
          `Controller Source input conflicts with existing Resource: ${type.kind}/${name}`,
        );
      }
      return { resource: current, created: false };
    });
  }

  get<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace = "v1",
  ): PluginResource<TSpec, TStatus> {
    return this.readStored<TSpec, TStatus>(type, name, namespace).object;
  }

  find<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace = "v1",
  ): PluginResource<TSpec, TStatus> | undefined {
    validateResourceType(type);
    assertPathSegment("resource name", name);
    const canonical = this.resourceNamespace(namespace);
    if (!existsSync(this.resourcePath(type, name, canonical))) return;
    return this.readCurrentStored<TSpec, TStatus>(type, name, canonical).object;
  }

  list<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
    options: ResourceListOptions = {},
  ): PluginResource<TSpec, TStatus>[] {
    validateResourceType(type);
    const namespace = this.resourceNamespace(options.namespace ?? "v1");
    const matchLabels = labelMap(
      "resource list matchLabels",
      options.matchLabels,
    );
    const namespaces = options.includeDescendants
      ? this.managedNamespaces().filter((candidate) =>
          namespaceContains(namespace, candidate)
        )
      : [namespace];
    return namespaces.flatMap((candidate) => {
      const kindDir = this.kindDir(type, candidate);
      if (!existsSync(kindDir)) return [];
      return readdirSync(kindDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) =>
          this.readStored<TSpec, TStatus>(
            type,
            basename(entry.name, ".json"),
            candidate,
          ).object
        );
    })
      .filter((resource) =>
        containsStringMap(resource.metadata.labels, matchLabels)
      )
      .sort((left, right) =>
        left.metadata.namespace.localeCompare(right.metadata.namespace) ||
        left.metadata.name.localeCompare(right.metadata.name)
      );
  }

  replaceSpec<TSpec, TStatus = Record<string, unknown>>(
    type: ResourceType,
    name: string,
    spec: TSpec,
    options: MutationOptions = {},
  ): PluginResource<TSpec, TStatus> {
    const nextSpec = jsonObject("spec", spec);
    return this.mutate<TSpec, TStatus>(type, name, options, (current) => {
      if (isDeepStrictEqual(current.object.spec, nextSpec)) return current;
      return {
        ...current,
        object: {
          ...current.object,
          metadata: {
            ...current.object.metadata,
            generation: current.object.metadata.generation + 1,
            resourceVersion: nextResourceVersion(
              current.object.metadata.resourceVersion,
            ),
          },
          spec: nextSpec,
        },
      };
    }).object;
  }

  patchStatus<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
    name: string,
    patch: Partial<TStatus>,
    options: MutationOptions = {},
  ): PluginResource<TSpec, TStatus> {
    const statusPatch = jsonObject("status patch", patch);
    return this.mutate<TSpec, TStatus>(type, name, options, (current) => {
      const status = { ...current.object.status, ...statusPatch };
      if (isDeepStrictEqual(current.object.status, status)) return current;
      return {
        ...current,
        object: {
          ...current.object,
          metadata: {
            ...current.object.metadata,
            resourceVersion: nextResourceVersion(
              current.object.metadata.resourceVersion,
            ),
          },
          status,
        },
      };
    }).object;
  }

  patchMetadata<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
    name: string,
    patch: {
      readonly labels?: Readonly<Record<string, string | null>>;
      readonly annotations?: Readonly<Record<string, string | null>>;
    },
    options: MutationOptions = {},
  ): PluginResource<TSpec, TStatus> {
    const metadataPatch = jsonObject("metadata patch", patch);
    const labelPatch = metadataPatch.labels === undefined
      ? undefined
      : labelMapPatch("metadata labels patch", metadataPatch.labels);
    const annotationPatch = metadataPatch.annotations === undefined
      ? undefined
      : annotationMapPatch(
        "metadata annotations patch",
        metadataPatch.annotations,
      );
    return this.mutate<TSpec, TStatus>(type, name, options, (current) => {
      const labels = labelPatch === undefined
        ? current.object.metadata.labels
        : applyStringMapPatch(current.object.metadata.labels, labelPatch);
      const annotations = annotationPatch === undefined
        ? current.object.metadata.annotations
        : applyStringMapPatch(
          current.object.metadata.annotations,
          annotationPatch,
        );
      if (
        isDeepStrictEqual(current.object.metadata.labels, labels) &&
        isDeepStrictEqual(current.object.metadata.annotations, annotations)
      ) {
        return current;
      }
      const metadata = {
        ...current.object.metadata,
        resourceVersion: nextResourceVersion(
          current.object.metadata.resourceVersion,
        ),
      };
      if (labels === undefined) delete metadata.labels;
      else metadata.labels = labels;
      if (annotations === undefined) delete metadata.annotations;
      else metadata.annotations = annotations;
      return {
        ...current,
        object: {
          ...current.object,
          metadata,
        },
      };
    }).object;
  }

  /**
   * Persists a deletion request for one Resource and every structural
   * descendant. Existing timestamps are never rewritten.
   */
  requestDeletion(
    type: ResourceType,
    name: string,
    now: Date = new Date(),
    namespace: ResourceNamespace = "v1",
  ): readonly ResourceDeletionUpdate[] {
    if (Number.isNaN(now.getTime())) {
      throw new Error("deletion time must be a valid Date");
    }
    const target = this.get<unknown, unknown>(type, name, namespace);
    const updates: ResourceDeletionUpdate[] = [];
    const pending = [target];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const resource = pending.shift()!;
      if (visited.has(resource.metadata.uid)) continue;
      visited.add(resource.metadata.uid);
      if (resource.metadata.deletionTimestamp === undefined) {
        const next = this.mutate<unknown, unknown>(
          resource,
          resource.metadata.name,
          { namespace: resource.metadata.namespace as ResourceNamespace },
          (current) => {
            if (current.object.metadata.deletionTimestamp !== undefined) {
              return current;
            }
            return {
              object: {
                ...current.object,
                metadata: {
                  ...current.object.metadata,
                  resourceVersion: nextResourceVersion(
                    current.object.metadata.resourceVersion,
                  ),
                  deletionTimestamp: now.toISOString(),
                },
              },
              control: {},
            };
          },
        ).object;
        if (
          next.metadata.resourceVersion !==
          resource.metadata.resourceVersion
        ) {
          updates.push(Object.freeze({
            oldResource: resource,
            resource: next,
          }));
        }
      }

      // Mark this node first so create() rejects new dependents before the
      // scan. Repeating the scan also repairs partially propagated requests.
      pending.push(
        ...this.listAll().filter((candidate) => {
          return candidate.metadata.owner?.uid === resource.metadata.uid;
        }),
      );
    }
    return Object.freeze(updates);
  }

  finalizeDeletion(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace = "v1",
  ): PluginResource<unknown, unknown> {
    const resource = this.get<unknown, unknown>(type, name, namespace);
    if (resource.metadata.deletionTimestamp === undefined) {
      throw new Error(
        `plugin resource deletion was not requested: ${type.kind}/${name}`,
      );
    }
    this.remove(type, name, namespace);
    return resource;
  }

  setNextReconcileAt<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
    name: string,
    next: Date | null,
    options: MutationOptions = {},
  ): void {
    if (next && Number.isNaN(next.getTime())) {
      throw new Error("nextReconcileAt must be a valid Date");
    }
    const nextReconcileAt = next?.toISOString();
    this.mutate<TSpec, TStatus>(type, name, options, (current) => {
      if (current.control.nextReconcileAt === nextReconcileAt) return current;
      const control = { ...current.control };
      if (nextReconcileAt === undefined) delete control.nextReconcileAt;
      else control.nextReconcileAt = nextReconcileAt;
      return { ...current, control };
    });
  }

  scheduledReconciles(
    type: ResourceType,
  ): readonly {
    resource: PluginResource<unknown, unknown>;
    nextReconcileAt: Date;
  }[] {
    validateResourceType(type);
    return this.list<unknown, unknown>(type, {
      namespace: "v1",
      includeDescendants: true,
    }).flatMap((resource) => {
      const stored = this.readStored<unknown, unknown>(
        type,
        resource.metadata.name,
        resource.metadata.namespace as ResourceNamespace,
      );
      if (stored.control.nextReconcileAt === undefined) return [];
      return [{
        resource: stored.object,
        nextReconcileAt: new Date(stored.control.nextReconcileAt),
      }];
    });
  }

  /**
   * 只串行化同一 Resource 的 Controller，不阻止用户并发更新 spec。
   * Controller 仍须用 resourceVersion 拒绝基于旧 snapshot 的 status 或调度写入。
   */
  withReconcileLock<T>(
    type: ResourceType,
    name: string,
    reconcile: () => Promise<T>,
    namespace: ResourceNamespace = "v1",
  ): Promise<T> {
    validateResourceType(type);
    assertPathSegment("resource name", name);
    return withAsyncFileLock(
      `${this.resourcePath(type, name, namespace)}.reconcile`,
      reconcile,
    );
  }

  private mutate<TSpec, TStatus>(
    type: ResourceType,
    name: string,
    options: MutationOptions,
    update: (
      current: StoredPluginResource<TSpec, TStatus>,
    ) => StoredPluginResource<TSpec, TStatus>,
  ): StoredPluginResource<TSpec, TStatus> {
    validateResourceType(type);
    assertPathSegment("resource name", name);
    const namespace = this.resourceNamespace(options.namespace ?? "v1");
    const path = this.resourcePath(type, name, namespace);
    return withFileLock(path, () => {
      const current = this.readStored<TSpec, TStatus>(type, name, namespace);
      if (
        options.expectedResourceVersion !== undefined &&
        options.expectedResourceVersion !==
          current.object.metadata.resourceVersion
      ) {
        throw new Error(
          `plugin resource version conflict: expected ${options.expectedResourceVersion}, current ${current.object.metadata.resourceVersion}`,
        );
      }
      const next = update(current);
      if (!isDeepStrictEqual(current, next)) writeJsonAtomic(path, next);
      return next;
    });
  }

  private readStored<TSpec, TStatus>(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace = "v1",
  ): StoredPluginResource<TSpec, TStatus> {
    validateResourceType(type);
    assertPathSegment("resource name", name);
    return this.readCurrentStored<TSpec, TStatus>(type, name, namespace);
  }

  private readCurrentStored<TSpec, TStatus>(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace = "v1",
  ): StoredPluginResource<TSpec, TStatus> {
    const canonical = this.resourceNamespace(namespace);
    const path = this.resourcePath(type, name, canonical);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`plugin resource not found: ${type.kind}/${name}`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not read plugin resource ${path}: ${detail}`);
    }
    return this.validateStored<TSpec, TStatus>(
      path,
      type,
      name,
      canonical,
      parsed,
    );
  }

  private validateStored<TSpec, TStatus>(
    path: string,
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace,
    value: unknown,
  ): StoredPluginResource<TSpec, TStatus> {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("root must be a JSON object");
      }
      const stored = value as Partial<StoredPluginResource<TSpec, TStatus>>;
      const object = this.validateObject<TSpec, TStatus>(
        type,
        name,
        namespace,
        stored.object,
      );
      const control = this.validateControl(stored.control);
      return { object, control };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid plugin resource ${path}: ${detail}`);
    }
  }

  private validateObject<TSpec, TStatus>(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace,
    value: unknown,
  ): PluginResource<TSpec, TStatus> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("object must be a JSON object");
    }
    const resource = value as Partial<PluginResource<TSpec, TStatus>>;
    if (!sameResourceType(resource as ResourceType, type)) {
      throw new Error(
        `apiVersion and kind must be ${type.apiVersion} ${type.kind}`,
      );
    }
    const metadata = resource.metadata;
    if (!metadata || typeof metadata !== "object") {
      throw new Error("metadata must be an object");
    }
    if (metadata.name !== name) throw new Error(`name must be ${name}`);
    if (metadata.namespace !== namespace) {
      throw new Error(`namespace must be ${namespace}`);
    }
    assertPathSegment("metadata.uid", metadata.uid);
    positiveInteger("metadata.generation", metadata.generation);
    resourceVersion("metadata.resourceVersion", metadata.resourceVersion);
    isoTimestamp(
      "metadata.creationTimestamp",
      metadata.creationTimestamp,
    );
    labelMap("metadata.labels", metadata.labels);
    annotationMap("metadata.annotations", metadata.annotations);
    this.ownerReference(metadata.owner, type, name, namespace);
    if (metadata.deletionTimestamp !== undefined) {
      isoTimestamp(
        "metadata.deletionTimestamp",
        metadata.deletionTimestamp,
      );
    }
    jsonObject("spec", resource.spec);
    jsonObject("status", resource.status);
    return resource as PluginResource<TSpec, TStatus>;
  }

  private validateControl(value: unknown): ResourceControl {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("control must be an object");
    }
    const control = value as ResourceControl;
    if (control.nextReconcileAt !== undefined) {
      isoTimestamp("control.nextReconcileAt", control.nextReconcileAt);
    }
    return control;
  }

  private initialStoredResource<TSpec, TStatus>(
    input: {
      type: ResourceType;
      name: string;
      namespace: ResourceNamespace;
      labels?: Readonly<Record<string, string>>;
      annotations?: Readonly<Record<string, string>>;
      owner?: ResourceOwnerReference;
      spec: TSpec;
      status: TStatus;
    },
  ): StoredPluginResource<TSpec, TStatus> {
    const resource: PluginResource<TSpec, TStatus> = {
      apiVersion: input.type.apiVersion,
      kind: input.type.kind,
      metadata: {
        name: input.name,
        namespace: input.namespace,
        uid: newId("pr"),
        generation: 1,
        resourceVersion: "1",
        creationTimestamp: new Date().toISOString(),
        ...(input.owner === undefined ? {} : { owner: input.owner }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        ...(input.annotations === undefined
          ? {}
          : { annotations: input.annotations }),
      },
      spec: jsonObject("spec", input.spec),
      status: jsonObject("status", input.status),
    };
    return { object: resource, control: {} };
  }

  private ownerReference(
    value: ResourceOwnerReference | undefined,
    dependentType: ResourceType,
    dependentName: string,
    dependentNamespace: ResourceNamespace,
  ): ResourceOwnerReference | undefined {
    if (value === undefined) return;
    const owner = jsonObject("metadata.owner", value);
    validateResourceType(owner);
    assertPathSegment("metadata.owner.name", owner.name);
    assertPathSegment("metadata.owner.uid", owner.uid);
    if (owner.namespace !== dependentNamespace) {
      throw new Error(
        `metadata.owner.namespace must be ${dependentNamespace}`,
      );
    }
    if (
      sameResourceType(owner, dependentType) &&
      owner.name === dependentName
    ) {
      throw new Error("plugin resource cannot own itself");
    }
    return owner;
  }

  private assertOwnerActive(
    owner: ResourceOwnerReference | undefined,
  ): void {
    if (!owner) return;
    const resource = this.get(
      owner,
      owner.name,
      owner.namespace as ResourceNamespace,
    );
    if (resource.metadata.uid !== owner.uid) {
      throw new Error(
        `plugin resource owner uid does not match: ${owner.kind}/${owner.name}`,
      );
    }
    if (resource.metadata.deletionTimestamp !== undefined) {
      throw new Error(
        `plugin resource owner is being deleted: ${owner.kind}/${owner.name}`,
      );
    }
  }

  private listAll(): PluginResource<unknown, unknown>[] {
    const resources: PluginResource<unknown, unknown>[] = [];
    for (const namespace of this.managedNamespaces()) {
      const root = this.resourcesDir(namespace);
      if (!existsSync(root)) continue;
      for (const group of readdirSync(root, { withFileTypes: true })) {
        if (!group.isDirectory()) continue;
        const groupDir = join(root, group.name);
        for (const version of readdirSync(groupDir, { withFileTypes: true })) {
          if (!version.isDirectory()) continue;
          const versionDir = join(groupDir, version.name);
          for (const kind of readdirSync(versionDir, { withFileTypes: true })) {
            if (!kind.isDirectory()) continue;
            const type = {
              apiVersion: `${group.name}/${version.name}`,
              kind: kind.name,
            };
            resources.push(...this.list(type, { namespace }));
          }
        }
      }
    }
    return resources;
  }

  private remove(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace,
  ): void {
    validateResourceType(type);
    assertPathSegment("resource name", name);
    const path = this.resourcePath(type, name, namespace);
    withFileLock(path, () => {
      if (!existsSync(path)) {
        throw new Error(`plugin resource not found: ${type.kind}/${name}`);
      }
      rmSync(path, { force: true });
    });
  }

  private namespacesDir(): string {
    return join(
      this.sessionDir,
      "plugins",
      this.pluginInstanceId,
      "namespaces",
    );
  }

  private resourcesDir(namespace: ResourceNamespace): string {
    return join(
      this.namespacesDir(),
      encodeURIComponent(namespace),
      "resources",
    );
  }

  private kindDir(type: ResourceType, namespace: ResourceNamespace): string {
    const [group, version] = type.apiVersion.split("/");
    if (!group || !version) {
      throw new Error(`invalid resource apiVersion: ${type.apiVersion}`);
    }
    return join(this.resourcesDir(namespace), group, version, type.kind);
  }

  private resourcePath(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace,
  ): string {
    return join(
      this.kindDir(type, this.resourceNamespace(namespace)),
      `${name}.json`,
    );
  }

  private resourceNamespace(namespace: ResourceNamespace): ResourceNamespace {
    return parseResourceNamespace(namespace);
  }

  private managedNamespaces(): ResourceNamespace[] {
    const root = this.namespacesDir();
    if (!existsSync(root)) return ["v1"];
    const namespaces = readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      try {
        return [parseResourceNamespace(decodeURIComponent(entry.name))];
      } catch {
        return [];
      }
    });
    if (!namespaces.includes("v1")) namespaces.push("v1");
    return namespaces.sort();
  }

}
