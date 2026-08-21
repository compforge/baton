/** Canonical namespace of a Plugin-owned Resource. */
export type ResourceNamespace =
  | "v1"
  | `v1/project/${string}`
  | `v1/project/${string}/session/${string}`;

/** Resource namespaces reserved by Baton itself sit outside Plugin tenancy. */
export type AnyResourceNamespace = ResourceNamespace | "baton-system";
