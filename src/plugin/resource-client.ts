import type {
  Resource,
  ResourceClient as PublicResourceClient,
  ResourceType,
} from "@compforge/baton-plugin";

import { PluginResourceStore } from "./resource.ts";

export type ResourceClient = PublicResourceClient;

export type ResourceClientChange =
  | {
      readonly kind: "created";
      readonly resource: Readonly<Resource<unknown, unknown>>;
    }
  | {
      readonly kind: "status-updated";
      readonly oldResource: Readonly<Resource<unknown, unknown>>;
      readonly resource: Readonly<Resource<unknown, unknown>>;
    }
  | {
      readonly kind: "deleted";
      readonly resource: Readonly<Resource<unknown, unknown>>;
    };

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Restricts Resource reads and status writes to one PluginInstance namespace. */
export function createResourceClient(
  store: PluginResourceStore,
  onChange?: (change: ResourceClientChange) => void,
  assertCanCreateType?: (type: ResourceType) => void,
): ResourceClient {
  const changed = (
    kind: ResourceClientChange["kind"],
    resource: Readonly<Resource<unknown, unknown>>,
    oldResource?: Readonly<Resource<unknown, unknown>>,
  ): void => {
    try {
      onChange?.(
        kind === "status-updated"
          ? Object.freeze({
              kind,
              oldResource: oldResource!,
              resource,
            })
          : Object.freeze({ kind, resource }),
      );
    } catch {
      // Resource mutation has committed; host reactions must not turn it into failure.
    }
  };
  const assertOwned = (
    resource: Readonly<Resource<unknown, unknown>>,
  ): void => {
    if (resource.metadata.namespace !== store.pluginInstanceId) {
      throw new Error(
        `plugin ResourceClient cannot access ${resource.kind}/${resource.metadata.name} outside ${store.pluginInstanceId}`,
      );
    }
  };

  return Object.freeze({
    get<TSpec, TStatus>(type: ResourceType, name: string) {
      return deepFreeze(store.get<TSpec, TStatus>(type, name));
    },
    list<TSpec, TStatus>(type: ResourceType) {
      return store
        .list<TSpec, TStatus>(type)
        .map((resource) => deepFreeze(resource));
    },
    create<TSpec, TStatus>(
      type: ResourceType,
      init: {
        name: string;
        labels?: Readonly<Record<string, string>>;
        annotations?: Readonly<Record<string, string>>;
        spec: TSpec;
      },
    ) {
      assertCanCreateType?.(type);
      const created = deepFreeze(
        store.create<TSpec, TStatus>({
          type,
          name: init.name,
          ...(init.labels === undefined ? {} : { labels: init.labels }),
          ...(init.annotations === undefined
            ? {}
            : { annotations: init.annotations }),
          spec: init.spec,
        }),
      );
      changed("created", created);
      return created;
    },
    delete(type: ResourceType, name: string) {
      const resource = deepFreeze(store.get(type, name));
      assertOwned(resource);
      store.delete(type, name);
      changed("deleted", resource);
    },
    patchStatus<TSpec, TStatus>(
      resource: Readonly<Resource<TSpec, TStatus>>,
      patch: Partial<TStatus>,
    ) {
      assertOwned(resource);
      const patched = deepFreeze(
        store.patchStatus<TSpec, TStatus>(
          resource,
          resource.metadata.name,
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
        changed("status-updated", patched, resource);
      }
      return patched;
    },
  });
}
