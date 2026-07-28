import type {
  CreateEvent,
  DeleteEvent,
  EventResource,
  UpdateEvent,
} from "./event.ts";
import type { ReconcileRequest } from "./reconcile.ts";
import type { Resource } from "./resource.ts";

/**
 * Transforms watched Resource events into requests for the Controller's primary
 * Resource type.
 */
export interface EventHandler {
  create(event: CreateEvent): readonly ReconcileRequest[];
  update(event: UpdateEvent): readonly ReconcileRequest[];
  delete(event: DeleteEvent): readonly ReconcileRequest[];
}

export type MapFunc<TSpec = unknown, TStatus = unknown> = (
  resource: Readonly<Resource<TSpec, TStatus>>,
) => readonly ReconcileRequest[];

function uniqueRequests(
  requests: readonly ReconcileRequest[],
): readonly ReconcileRequest[] {
  const unique = new Map<string, ReconcileRequest>();
  for (const request of requests) {
    if (!unique.has(request.name)) unique.set(request.name, request);
  }
  return Object.freeze([...unique.values()]);
}

function typedResource<TSpec, TStatus>(
  resource: EventResource,
): Readonly<Resource<TSpec, TStatus>> {
  return resource as Readonly<Resource<TSpec, TStatus>>;
}

/**
 * Runs the map function for create/delete objects and for both the old and new
 * update snapshots, matching controller-runtime's EnqueueRequestsFromMapFunc.
 */
export function enqueueRequestsFromMapFunc<TSpec = unknown, TStatus = unknown>(
  map: MapFunc<TSpec, TStatus>,
): EventHandler {
  return Object.freeze({
    create(event: CreateEvent) {
      return uniqueRequests(
        map(typedResource<TSpec, TStatus>(event.object)),
      );
    },
    update(event: UpdateEvent) {
      return uniqueRequests([
        ...map(typedResource<TSpec, TStatus>(event.oldObject)),
        ...map(typedResource<TSpec, TStatus>(event.newObject)),
      ]);
    },
    delete(event: DeleteEvent) {
      return uniqueRequests(
        map(typedResource<TSpec, TStatus>(event.object)),
      );
    },
  });
}
