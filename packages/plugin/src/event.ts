import type { Resource } from "./resource.ts";

export type EventResource = Readonly<Resource<unknown, unknown>>;

/** A Baton Resource was created. */
export interface CreateEvent {
  readonly object: EventResource;
}

/** A Baton Resource changed; both snapshots are available for reverse mapping. */
export interface UpdateEvent {
  readonly oldObject: EventResource;
  readonly newObject: EventResource;
}

/** A Baton Resource was deleted; object contains its last persisted snapshot. */
export interface DeleteEvent {
  readonly object: EventResource;
}
