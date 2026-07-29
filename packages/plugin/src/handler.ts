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
  create(event: CreateEvent): Promise<readonly ReconcileRequest[]>;
  update(event: UpdateEvent): Promise<readonly ReconcileRequest[]>;
  delete(event: DeleteEvent): Promise<readonly ReconcileRequest[]>;
}

export type MapFunc<TSpec = unknown, TStatus = unknown> = (
  resource: Readonly<Resource<TSpec, TStatus>>,
) => Promise<readonly ReconcileRequest[]>;
