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
  labels?: Readonly<Record<string, string>>;
  annotations?: Readonly<Record<string, string>>;
  spec: TSpec;
  status?: TStatus;
}

interface EnsureResource<TSpec> {
  type: ResourceType;
  name: string;
  labels?: Readonly<Record<string, string>>;
  annotations?: Readonly<Record<string, string>>;
  spec: TSpec;
}

interface EnsureResourceResult<TSpec, TStatus> {
  resource: PluginResource<TSpec, TStatus>;
  created: boolean;
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

function stringMap(
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
    const labels = stringMap("metadata.labels", input.labels);
    const annotations = stringMap(
      "metadata.annotations",
      input.annotations,
    );
    assertPathSegment("resource name", name);
    const path = this.resourcePath(type, name);
    return withFileLock(path, () => {
      if (existsSync(path)) {
        throw new Error(`plugin resource already exists: ${type.kind}/${name}`);
      }
      const stored = this.initialStoredResource<TSpec, TStatus>({
        type,
        name,
        labels,
        annotations,
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
    const labels = stringMap("metadata.labels", input.labels);
    const annotations = stringMap(
      "metadata.annotations",
      input.annotations,
    );
    const spec = jsonObject("spec", input.spec);
    assertPathSegment("resource name", name);
    const path = this.resourcePath(type, name);
    return withFileLock(path, () => {
      if (!existsSync(path)) {
        const stored = this.initialStoredResource<TSpec, TStatus>({
          type,
          name,
          labels,
          annotations,
          spec,
          status: {} as TStatus,
        });
        writeJsonAtomic(path, stored);
        return { resource: stored.object, created: true };
      }
      const current = this.readCurrentStored<TSpec, TStatus>(type, name).object;
      if (
        !isDeepStrictEqual(current.spec, spec) ||
        !isDeepStrictEqual(current.metadata.labels, labels) ||
        !isDeepStrictEqual(current.metadata.annotations, annotations)
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
  ): PluginResource<TSpec, TStatus> {
    return this.readStored<TSpec, TStatus>(type, name).object;
  }

  list<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
  ): PluginResource<TSpec, TStatus>[] {
    validateResourceType(type);
    const kindDir = this.kindDir(type);
    if (!existsSync(kindDir)) return [];
    return readdirSync(kindDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) =>
        this.readStored<TSpec, TStatus>(
          type,
          basename(entry.name, ".json"),
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
    const path = this.resourcePath(type, name);
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
      `${this.resourcePath(type, name)}.reconcile`,
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
    const path = this.resourcePath(type, name);
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
    return this.readCurrentStored<TSpec, TStatus>(type, name);
  }

  private readCurrentStored<TSpec, TStatus>(
    type: ResourceType,
    name: string,
  ): StoredPluginResource<TSpec, TStatus> {
    const path = this.resourcePath(type, name);
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
      const stored = value as Partial<StoredPluginResource<TSpec, TStatus>>;
      const object = this.validateObject<TSpec, TStatus>(
        type,
        name,
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
    stringMap("metadata.labels", metadata.labels);
    stringMap("metadata.annotations", metadata.annotations);
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
      labels?: Readonly<Record<string, string>>;
      annotations?: Readonly<Record<string, string>>;
      spec: TSpec;
      status: TStatus;
    },
  ): StoredPluginResource<TSpec, TStatus> {
    const resource: PluginResource<TSpec, TStatus> = {
      apiVersion: input.type.apiVersion,
      kind: input.type.kind,
      metadata: {
        name: input.name,
        namespace: this.pluginInstanceId,
        uid: newId("pr"),
        generation: 1,
        resourceVersion: "1",
        creationTimestamp: new Date().toISOString(),
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

  private resourcePath(type: ResourceType, name: string): string {
    return join(this.kindDir(type), `${name}.json`);
  }

}
