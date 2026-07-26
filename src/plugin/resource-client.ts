import type { Resource } from "@qiankun01/baton-plugin";
import { PluginResourceStore } from "./resource.ts";

export interface ResourceClient {
  get<TSpec, TStatus>(
    resourceKind: string,
    resourceId: string,
  ): Readonly<Resource<TSpec, TStatus>>;
  list<TSpec, TStatus>(
    resourceKind?: string,
  ): readonly Readonly<Resource<TSpec, TStatus>>[];
  /**
   * Creates a new Plugin-owned Resource with the given spec.
   *
   * The status will be initialized to an empty object and should be set
   * by the Controller on the first reconciliation.
   */
  create<TSpec, TStatus>(
    resourceKind: string,
    init: {
      resourceId: string;
      spec: TSpec;
    },
  ): Readonly<Resource<TSpec, TStatus>>;
  delete(resourceKind: string, resourceId: string): void;
  /**
   * Updates the status of a Plugin-owned Resource.
   *
   * This is the primary way to update resource state. Unlike Kubernetes where
   * users update spec and controllers update status, in Baton plugins both
   * create and update their own resources.
   *
   * The patch is merged with the existing status. Generation is NOT incremented
   * (only resourceVersion is), so this will not trigger a new reconciliation.
   */
  patchStatus<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: Partial<TStatus>,
  ): Readonly<Resource<TSpec, TStatus>>;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Restricts Resource reads and status writes to one PluginInstance-owned store. */
export function createResourceClient(
  store: PluginResourceStore,
  onChange?: () => void,
  assertCanCreateKind?: (resourceKind: string) => void,
): ResourceClient {
  const changed = (): void => {
    try {
      onChange?.();
    } catch {
      // Resource mutation has already committed; a UI invalidation must not turn it into failure.
    }
  };
  const assertOwned = (resource: {
    kind: string;
    metadata: {
      batonSessionId: string;
      pluginInstanceId: string;
      resourceId: string;
      resourceVersion: number;
    };
  }): void => {
    if (
      resource.metadata.batonSessionId !== store.batonSessionId ||
      resource.metadata.pluginInstanceId !== store.pluginInstanceId
    ) {
      throw new Error(
        `plugin ResourceClient cannot access ${resource.kind}/${resource.metadata.resourceId} outside ${store.pluginInstanceId}`,
      );
    }
  };

  return Object.freeze({
    get<TSpec, TStatus>(resourceKind: string, resourceId: string) {
      return deepFreeze(store.get<TSpec, TStatus>(resourceKind, resourceId));
    },
    list<TSpec, TStatus>(resourceKind?: string) {
      return store
        .list<TSpec, TStatus>(resourceKind)
        .map((resource) => deepFreeze(resource));
    },
    create<TSpec, TStatus>(
      resourceKind: string,
      init: {
        resourceId: string;
        spec: TSpec;
      },
    ) {
      assertCanCreateKind?.(resourceKind);
      const created = deepFreeze(
        store.create<TSpec, TStatus>({
          kind: resourceKind,
          resourceId: init.resourceId,
          spec: init.spec,
        }),
      );
      changed();
      return created;
    },
    delete(resourceKind: string, resourceId: string) {
      const resource = store.get(resourceKind, resourceId);
      assertOwned(resource);
      store.delete(resourceKind, resourceId);
      changed();
    },
    patchStatus<TSpec, TStatus>(
      resource: Parameters<ResourceClient["patchStatus"]>[0],
      patch: Partial<TStatus>,
    ) {
      assertOwned(resource);
      const patched = deepFreeze(
        store.patchStatus<TSpec, TStatus>(
          resource.kind,
          resource.metadata.resourceId,
          patch,
          {
            expectedResourceVersion: resource.metadata.resourceVersion,
          },
        ),
      );
      if (
        patched.metadata.resourceVersion !==
        resource.metadata.resourceVersion
      ) {
        changed();
      }
      return patched;
    },
  });
}
