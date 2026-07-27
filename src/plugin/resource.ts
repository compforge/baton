import { createHash } from "node:crypto";
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
  ResourceType,
} from "@qiankun01/baton-plugin";

import { newId } from "../event/ids.ts";
import { withAsyncFileLock, withFileLock } from "../store/file-lock.ts";
import type { SessionHandle } from "../store/store.ts";

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
}

interface CreateResource<TSpec, TStatus> {
  type: ResourceType;
  name?: string;
  spec: TSpec;
  status?: TStatus;
}

interface ResourceControl {
  nextReconcileAt?: string;
}

interface StoredPluginResource<TSpec, TStatus> {
  object: PluginResource<TSpec, TStatus>;
  control: ResourceControl;
}

interface LegacyPluginResource<TSpec, TStatus> {
  kind: string;
  metadata: {
    resourceId: string;
    batonSessionId: string;
    pluginInstanceId: string;
    generation: number;
    resourceVersion: number;
    createdAt: string;
    updatedAt: string;
    nextReconcileAt?: string;
  };
  spec: TSpec;
  status: TStatus;
}

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const API_VERSION =
  /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?\/v[0-9]+(?:(?:alpha|beta)[0-9]+)?$/;
const RESOURCE_VERSION = /^[1-9][0-9]*$/;

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

function legacyUid(
  sessionId: string,
  pluginInstanceId: string,
  resource: LegacyPluginResource<unknown, unknown>,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      sessionId,
      pluginInstanceId,
      resource.kind,
      resource.metadata.resourceId,
      resource.metadata.createdAt,
    ]))
    .digest("hex");
  return `res_${digest}`;
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
    assertPathSegment("resource name", name);
    const path = this.resourcePath(type, name);
    return withFileLock(path, () => {
      if (existsSync(path) || existsSync(this.legacyResourcePath(type, name))) {
        throw new Error(`plugin resource already exists: ${type.kind}/${name}`);
      }
      const now = new Date().toISOString();
      const resource: PluginResource<TSpec, TStatus> = {
        apiVersion: type.apiVersion,
        kind: type.kind,
        metadata: {
          name,
          namespace: this.pluginInstanceId,
          uid: newId("pr"),
          generation: 1,
          resourceVersion: "1",
          creationTimestamp: now,
        },
        spec: jsonObject("spec", input.spec),
        status: jsonObject("status", input.status ?? ({} as TStatus)),
      };
      writeJsonAtomic(path, {
        object: resource,
        control: {},
      } satisfies StoredPluginResource<TSpec, TStatus>);
      return resource;
    });
  }

  get<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
    name: string,
  ): PluginResource<TSpec, TStatus> {
    return this.readStored<TSpec, TStatus>(type, name).object;
  }

  list<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
  ): PluginResource<TSpec, TStatus>[] {
    validateResourceType(type);
    const kindDir = this.kindDir(type);
    const legacyKindDir = this.legacyKindDir(type);
    const names = new Set<string>();
    for (const directory of [kindDir, legacyKindDir]) {
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          names.add(basename(entry.name, ".json"));
        }
      }
    }
    return [...names]
      .map((name) =>
        this.readStored<TSpec, TStatus>(
          type,
          name,
        ).object
      )
      .sort((left, right) =>
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

  delete(type: ResourceType, name: string): void {
    validateResourceType(type);
    assertPathSegment("resource name", name);
    const path = this.storedResourcePath(type, name);
    withFileLock(path, () => {
      if (!existsSync(path)) {
        throw new Error(`plugin resource not found: ${type.kind}/${name}`);
      }
      rmSync(path, { force: true });
    });
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
    return this.list<unknown, unknown>(type).flatMap((resource) => {
      const stored = this.readStored<unknown, unknown>(
        type,
        resource.metadata.name,
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
  ): Promise<T> {
    validateResourceType(type);
    assertPathSegment("resource name", name);
    return withAsyncFileLock(
      `${this.storedResourcePath(type, name)}.reconcile`,
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
    const path = this.storedResourcePath(type, name);
    return withFileLock(path, () => {
      const current = this.readStored<TSpec, TStatus>(type, name);
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
  ): StoredPluginResource<TSpec, TStatus> {
    validateResourceType(type);
    assertPathSegment("resource name", name);
    const path = this.storedResourcePath(type, name);
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
    return this.validateStored<TSpec, TStatus>(path, type, name, parsed);
  }

  private validateStored<TSpec, TStatus>(
    path: string,
    type: ResourceType,
    name: string,
    value: unknown,
  ): StoredPluginResource<TSpec, TStatus> {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("root must be a JSON object");
      }
      if ("object" in value) {
        const stored = value as Partial<StoredPluginResource<TSpec, TStatus>>;
        const object = this.validateObject<TSpec, TStatus>(
          type,
          name,
          stored.object,
        );
        const control = this.validateControl(stored.control);
        return { object, control };
      }
      return this.migrateLegacy<TSpec, TStatus>(type, name, value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid plugin resource ${path}: ${detail}`);
    }
  }

  private validateObject<TSpec, TStatus>(
    type: ResourceType,
    name: string,
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
    if (metadata.namespace !== this.pluginInstanceId) {
      throw new Error(`namespace must be ${this.pluginInstanceId}`);
    }
    assertPathSegment("metadata.uid", metadata.uid);
    positiveInteger("metadata.generation", metadata.generation);
    resourceVersion("metadata.resourceVersion", metadata.resourceVersion);
    isoTimestamp(
      "metadata.creationTimestamp",
      metadata.creationTimestamp,
    );
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

  private migrateLegacy<TSpec, TStatus>(
    type: ResourceType,
    name: string,
    value: object,
  ): StoredPluginResource<TSpec, TStatus> {
    const legacy = value as Partial<LegacyPluginResource<TSpec, TStatus>>;
    const metadata = legacy.metadata;
    if (legacy.kind !== type.kind) throw new Error(`kind must be ${type.kind}`);
    if (!metadata || typeof metadata !== "object") {
      throw new Error("metadata must be an object");
    }
    if (metadata.resourceId !== name) {
      throw new Error(`resourceId must be ${name}`);
    }
    if (metadata.batonSessionId !== this.batonSessionId) {
      throw new Error(`batonSessionId must be ${this.batonSessionId}`);
    }
    if (metadata.pluginInstanceId !== this.pluginInstanceId) {
      throw new Error(`pluginInstanceId must be ${this.pluginInstanceId}`);
    }
    positiveInteger("metadata.generation", metadata.generation);
    positiveInteger("metadata.resourceVersion", metadata.resourceVersion);
    isoTimestamp("metadata.createdAt", metadata.createdAt);
    isoTimestamp("metadata.updatedAt", metadata.updatedAt);
    if (metadata.nextReconcileAt !== undefined) {
      isoTimestamp("metadata.nextReconcileAt", metadata.nextReconcileAt);
    }
    const spec = jsonObject("spec", legacy.spec as TSpec);
    const status = jsonObject("status", legacy.status as TStatus);
    return {
      object: {
        apiVersion: type.apiVersion,
        kind: type.kind,
        metadata: {
          name,
          namespace: this.pluginInstanceId,
          uid: legacyUid(
            this.batonSessionId,
            this.pluginInstanceId,
            legacy as LegacyPluginResource<unknown, unknown>,
          ),
          generation: metadata.generation,
          resourceVersion: String(metadata.resourceVersion),
          creationTimestamp: metadata.createdAt,
        },
        spec,
        status,
      },
      control: {
        ...(metadata.nextReconcileAt === undefined
          ? {}
          : { nextReconcileAt: metadata.nextReconcileAt }),
      },
    };
  }

  private resourcesDir(): string {
    return join(
      this.sessionDir,
      "plugins",
      this.pluginInstanceId,
      "resources",
    );
  }

  private kindDir(type: ResourceType): string {
    const [group, version] = type.apiVersion.split("/");
    if (!group || !version) {
      throw new Error(`invalid resource apiVersion: ${type.apiVersion}`);
    }
    return join(this.resourcesDir(), group, version, type.kind);
  }

  private legacyKindDir(type: ResourceType): string {
    return join(this.resourcesDir(), type.kind);
  }

  private resourcePath(type: ResourceType, name: string): string {
    return join(this.kindDir(type), `${name}.json`);
  }

  private legacyResourcePath(type: ResourceType, name: string): string {
    return join(this.legacyKindDir(type), `${name}.json`);
  }

  private storedResourcePath(type: ResourceType, name: string): string {
    const path = this.resourcePath(type, name);
    if (existsSync(path)) return path;
    const legacy = this.legacyResourcePath(type, name);
    return existsSync(legacy) ? legacy : path;
  }
}
