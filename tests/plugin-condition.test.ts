import {
  expect,
  test,
} from "bun:test";

import type {
  ConditionedStatus,
  ResourceCondition,
} from "@compforge/baton-plugin";

interface ExampleStatus extends ConditionedStatus {
  readonly phase: "active" | "done";
}

test("conditions are an optional part of a Plugin-owned status schema", () => {
  const statusWithoutConditions: ExampleStatus = { phase: "active" };
  const ready = {
    type: "Ready",
    status: "True",
    observedGeneration: 3,
    lastTransitionTime: "2026-07-27T00:00:00.000Z",
    reason: "Reconciled",
    message: "The Resource is ready.",
  } as const satisfies ResourceCondition;
  const statusWithConditions: ExampleStatus = {
    phase: "done",
    conditions: [ready],
  };

  expect(statusWithoutConditions.conditions).toBeUndefined();
  expect(statusWithConditions.conditions).toEqual([ready]);
});
