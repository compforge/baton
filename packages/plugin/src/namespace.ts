/** Namespace template declared by one Plugin Package. */
export type PluginNamespaceTemplate =
  | "v1"
  | "v1/project"
  | "v1/project/session";

/** Canonical namespace persisted by Baton after resolving a template. */
export type PluginNamespace =
  | "v1"
  | `v1/project/${string}`
  | `v1/project/${string}/session/${string}`;

/** Resource namespaces reserved by Baton itself sit outside Plugin tenancy. */
export type ResourceNamespace = PluginNamespace | "baton-system";

export interface PluginNamespaceContext {
  readonly projectId?: string;
  readonly sessionId?: string;
}
