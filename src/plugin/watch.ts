import type {
  ReconcileRequest,
  Watch,
} from "@compforge/baton-plugin";

import type { ResourceClientChange } from "./resource-client.ts";
import {
  resourceTypeKey,
  validateResourceType,
} from "./resource.ts";
import { parseResourceNamespace } from "./namespace.ts";

export function validateWatches(
  watches: readonly Watch[] | undefined,
): void {
  for (const watch of watches ?? []) {
    validateResourceType(watch.resourceType);
    for (const event of ["create", "update", "delete"] as const) {
      if (typeof watch.handler[event] !== "function") {
        throw new Error(
          `Controller Watch EventHandler must provide ${event}() for ` +
            `${watch.resourceType.apiVersion}/${watch.resourceType.kind}`,
        );
      }
    }
  }
}

function validateRequests(
  requests: readonly ReconcileRequest[],
): readonly ReconcileRequest[] {
  if (!Array.isArray(requests)) {
    throw new Error("Controller Watch EventHandler must return ReconcileRequest[]");
  }
  const unique = new Map<string, ReconcileRequest>();
  for (const request of requests) {
    if (!request || typeof request.name !== "string" || !request.name.trim()) {
      throw new Error(
        "Controller Watch EventHandler returned a ReconcileRequest with an empty name",
      );
    }
    const namespace = request.namespace === undefined
      ? undefined
      : parseResourceNamespace(request.namespace);
    const key = JSON.stringify([namespace, request.name]);
    if (!unique.has(key)) {
      unique.set(key, Object.freeze({
        name: request.name,
        ...(namespace === undefined ? {} : { namespace }),
      }));
    }
  }
  return Object.freeze([...unique.values()]);
}

function appendRequests(
  target: ReconcileRequest[],
  requests: readonly ReconcileRequest[],
): void {
  if (!Array.isArray(requests)) {
    throw new Error("Controller Watch EventHandler must return ReconcileRequest[]");
  }
  target.push(...requests);
}

export async function watchRequests(
  watches: readonly Watch[],
  change: ResourceClientChange,
): Promise<readonly ReconcileRequest[]> {
  const observedType = resourceTypeKey(change.resource);
  const requests: ReconcileRequest[] = [];
  for (const watch of watches) {
    if (resourceTypeKey(watch.resourceType) !== observedType) continue;
    if (change.kind === "created") {
      appendRequests(
        requests,
        await watch.handler.create(Object.freeze({
          object: change.resource,
        })),
      );
      continue;
    }
    if (
      change.kind === "status-updated" ||
      change.kind === "metadata-updated" ||
      change.kind === "deletion-requested"
    ) {
      appendRequests(
        requests,
        await watch.handler.update(Object.freeze({
          oldObject: change.oldResource,
          newObject: change.resource,
        })),
      );
      continue;
    }
    appendRequests(
      requests,
      await watch.handler.delete(Object.freeze({
        object: change.resource,
      })),
    );
  }
  return validateRequests(requests);
}
