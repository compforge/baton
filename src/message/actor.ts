import type { EventSource } from "../event/index.ts";
import type { ActorRef } from "./types.ts";

// Baton currently has one local human principal; do not leak an OS username into history.
export const HUMAN_ACTOR: ActorRef = { kind: "user", key: "local" };
export const BATON_ACTOR: ActorRef = { kind: "baton", key: "local" };

export function actorOf(source: EventSource): ActorRef {
  switch (source.type) {
    case "user": return { ...HUMAN_ACTOR };
    case "baton": return { ...BATON_ACTOR };
    case "harness": return { kind: "harness", key: source.harnessTargetId };
    case "plugin": return { kind: "plugin", key: source.pluginInstanceId };
    case "schedule": return { kind: "schedule", key: source.scheduleId };
  }
}
