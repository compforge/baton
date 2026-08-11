import type {
  ReconcileOperationRef,
  ResourceRef,
} from "@compforge/baton-plugin";

export interface ReconcileOperationScope {
  readonly batonSessionId: string;
  readonly pluginInstanceId: string;
  readonly resourceOwner: "plugin" | "baton";
  readonly resource: ResourceRef;
}

/**
 * A reconcile operation is scoped by its Resource incarnation and namespaced by
 * the capability verb. Keep this tuple as the single identity source for every
 * durable object materialized by ReconcileContext.
 */
export function reconcileOperationIdentity(
  scope: ReconcileOperationScope,
  operation: ReconcileOperationRef,
): string {
  return JSON.stringify([
    scope.batonSessionId,
    scope.pluginInstanceId,
    scope.resourceOwner,
    scope.resource.apiVersion,
    scope.resource.kind,
    scope.resource.namespace,
    scope.resource.name,
    scope.resource.uid,
    operation.verb,
    operation.key,
  ]);
}

export function reconcileOperationLabel(
  operation: ReconcileOperationRef,
): string {
  return `${operation.verb}(${operation.key})`;
}
