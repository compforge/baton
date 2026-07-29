import type {
  Resource,
  ResourceClient as PublicResourceClient,
  ResourceListOptions,
  ResourceOwnerReference,
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
      readonly kind: "metadata-updated";
      readonly oldResource: Readonly<Resource<unknown, unknown>>;
      readonly resource: Readonly<Resource<unknown, unknown>>;
    }
  | {
      readonly kind: "deletion-requested";
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
    kind: "created" | "status-updated" | "metadata-updated" | "deleted",
    resource: Readonly<Resource<unknown, unknown>>,
    oldResource?: Readonly<Resource<unknown, unknown>>,
  ): void => {
    try {
      onChange?.(
        kind === "status-updated" || kind === "metadata-updated"
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
    async get<TSpec, TStatus>(type: ResourceType, name: string) {
      return deepFreeze(store.get<TSpec, TStatus>(type, name));
    },
    async list<TSpec, TStatus>(
      type: ResourceType,
      options?: ResourceListOptions,
    ) {
      return store
        .list<TSpec, TStatus>(type, options)
        .map((resource) => deepFreeze(resource));
    },
    async create<TSpec, TStatus>(
      type: ResourceType,
      init: {
        name: string;
        labels?: Readonly<Record<string, string>>;
        annotations?: Readonly<Record<string, string>>;
        owner?: ResourceOwnerReference;
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
          ...(init.owner === undefined ? {} : { owner: init.owner }),
          spec: init.spec,
        }),
      );
      changed("created", created);
      return created;
    },
    async delete(type: ResourceType, name: string) {
      const resource = deepFreeze(store.get(type, name));
      assertOwned(resource);
      for (const update of store.requestDeletion(type, name)) {
        try {
          onChange?.(Object.freeze({
            kind: "deletion-requested",
            oldResource: deepFreeze(update.oldResource),
            resource: deepFreeze(update.resource),
          }));
        } catch {
          // Deletion is durable; host reactions must not turn it into failure.
        }
      }
    },
    async patchMetadata<TSpec, TStatus>(
      resource: Readonly<Resource<TSpec, TStatus>>,
      patch: {
        readonly labels?: Readonly<Record<string, string | null>>;
        readonly annotations?: Readonly<Record<string, string | null>>;
      },
    ) {
      assertOwned(resource);
      const patched = deepFreeze(
        store.patchMetadata<TSpec, TStatus>(
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
        changed("metadata-updated", patched, resource);
      }
      return patched;
    },
    async patchStatus<TSpec, TStatus>(
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
