import type { EventHandler } from "./handler.ts";
import type { ResourceType } from "./resource.ts";

/**
 * Observes a secondary Baton Resource type and maps its events to the
 * Controller's primary Resource through an EventHandler.
 */
export interface Watch {
  readonly resourceType: ResourceType;
  readonly handler: EventHandler;
}
