import type {
  Resource,
  ResourceClient as PublicResourceClient,
  ResourceListOptions,
  ResourceMergePatch,
  ResourceOwnerReference,
  ResourceRef,
  ResourceNamespace,
  ResourceType,
} from "@compforge/baton-plugin";

import { PluginResourceStore } from "./resource.ts";

export type ResourceClient = PublicResourceClient;

export type ResourceClientChange = {
  readonly pluginInstanceId: string;
} & (
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
    }
);

export interface BatonResourceAccess {
  handles(type: ResourceType): boolean;
  get<TSpec, TStatus>(
    ref: ResourceRef,
  ): Readonly<Resource<TSpec, TStatus>> | undefined;
  list<TSpec, TStatus>(
    type: ResourceType,
    options?: ResourceListOptions,
  ): readonly Readonly<Resource<TSpec, TStatus>>[];
  patch<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: ResourceMergePatch,
  ): Readonly<Resource<TSpec, TStatus>>;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Routes Core projections and isolates Plugin-owned state by PluginInstance. */
export function createResourceClient(
  store: PluginResourceStore,
  onChange?: (change: ResourceClientChange) => void,
  assertCanCreateType?: (type: ResourceType) => void,
  batonResources?: BatonResourceAccess,
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
              pluginInstanceId: store.pluginInstanceId,
              kind,
              oldResource: oldResource!,
              resource,
            })
          : Object.freeze({
              pluginInstanceId: store.pluginInstanceId,
              kind,
              resource,
            }),
      );
    } catch {
      // Resource mutation has committed; host reactions must not turn it into failure.
    }
  };
  const assertOwned = (
    resource: Readonly<Resource<unknown, unknown>>,
  ): void => {
    if (resource.metadata.namespace === "baton-system") {
      throw new Error(
        `plugin ResourceClient cannot mutate Baton-owned ${resource.kind}/${resource.metadata.name}`,
      );
    }
  };

  async function get<TSpec, TStatus>(
    ref: ResourceRef,
  ): Promise<Readonly<Resource<TSpec, TStatus>> | undefined> {
    if (batonResources?.handles(ref)) {
      return batonResources.get<TSpec, TStatus>(ref);
    }
    if (ref.namespace === "baton-system") {
      throw new Error(
        `plugin ResourceClient cannot access Baton-owned ${ref.kind}/${ref.name}`,
      );
    }
    const current = store.find<TSpec, TStatus>(
      ref,
      ref.name,
      ref.namespace,
    );
    if (
      !current ||
      (ref.uid !== undefined && current.metadata.uid !== ref.uid)
    ) {
      return undefined;
    }
    return deepFreeze(current);
  }

  return Object.freeze({
    get,
    async list<TSpec, TStatus>(
      type: ResourceType,
      options?: ResourceListOptions,
    ) {
      if (batonResources?.handles(type)) {
        return batonResources.list<TSpec, TStatus>(type, options);
      }
      return store
        .list<TSpec, TStatus>(type, options)
        .map((resource) => deepFreeze(resource));
    },
    async create<TSpec, TStatus>(
      type: ResourceType,
      init: {
        name: string;
        namespace?: ResourceNamespace;
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
          ...(init.namespace === undefined
            ? {}
            : { namespace: init.namespace }),
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
    async delete(
      type: ResourceType,
      name: string,
      namespace: ResourceNamespace = "v1",
    ) {
      const resource = deepFreeze(store.get(type, name, namespace));
      assertOwned(resource);
      for (const update of store.requestDeletion(
        type,
        name,
        undefined,
        namespace,
      )) {
        try {
          onChange?.(Object.freeze({
            pluginInstanceId: store.pluginInstanceId,
            kind: "deletion-requested",
            oldResource: deepFreeze(update.oldResource),
            resource: deepFreeze(update.resource),
          }));
        } catch {
          // Deletion is durable; host reactions must not turn it into failure.
        }
      }
    },
    async patch<TSpec, TStatus>(
      resource: Readonly<Resource<TSpec, TStatus>>,
      patch: ResourceMergePatch,
    ) {
      if (batonResources?.handles(resource)) {
        return batonResources.patch(resource, patch);
      }
      throw new Error(
        `Resource ${resource.apiVersion}/${resource.kind} does not support generic patch`,
      );
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
            namespace: resource.metadata.namespace as ResourceNamespace,
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
            namespace: resource.metadata.namespace as ResourceNamespace,
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
