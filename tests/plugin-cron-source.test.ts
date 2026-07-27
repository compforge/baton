import { describe, expect, test } from "bun:test";

import type { ReconcileScope } from "../src/plugin/controller.ts";
import {
  CronSourceQueue,
  nextCronSourceAt,
  validateControllerSources,
} from "../src/plugin/cron-source.ts";

const scope: ReconcileScope = {
  batonSessionId: "bs_test",
  pluginInstanceId: "reqloop_default",
  resourceApiVersion: "reqloop.baton.dev/v1alpha1",
  resourceKind: "ReqLoopRun",
};

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

describe("Controller cron Sources", () => {
  test("calculates cron occurrences in the declared time zone", () => {
    expect(
      nextCronSourceAt(
        {
          type: "cron",
          sourceId: "daily-close-check",
          cron: "0 9 * * *",
          timeZone: "Asia/Shanghai",
        },
        new Date("2026-07-26T00:00:00.000Z"),
      ).toISOString(),
    ).toBe("2026-07-26T01:00:00.000Z");
  });

  test("validates duplicate ids, cron expressions, and time zones", () => {
    expect(() =>
      validateControllerSources(
        [
          {
            type: "cron",
            sourceId: "poll",
            cron: "*/5 * * * *",
            timeZone: "UTC",
          },
          {
            type: "cron",
            sourceId: "poll",
            cron: "0 * * * *",
            timeZone: "UTC",
          },
        ],
        new Date("2026-07-26T00:00:00.000Z"),
      ),
    ).toThrow("Controller sourceId already registered: poll");
    expect(() =>
      validateControllerSources(
        [{
          type: "cron",
          sourceId: "poll",
          cron: "not-a-cron",
          timeZone: "UTC",
        }],
        new Date("2026-07-26T00:00:00.000Z"),
      ),
    ).toThrow("invalid Controller cron source poll");
    expect(() =>
      validateControllerSources(
        [{
          type: "cron",
          sourceId: "poll",
          cron: "*/5 * * * *",
          timeZone: "Mars/Olympus",
        }],
        new Date("2026-07-26T00:00:00.000Z"),
      ),
    ).toThrow("invalid Controller cron source poll");
  });

  test("coalesces cron Sources due for the same Controller scope", async () => {
    let now = new Date("2026-07-26T00:00:00.990Z");
    const due: Array<{
      scope: ReconcileScope;
      sourceIds: readonly string[];
    }> = [];
    const queue = new CronSourceQueue({
      now: () => now,
      onDue: (value, sources) => {
        due.push({
          scope: value,
          sourceIds: sources.map((source) => source.sourceId),
        });
      },
    });
    queue.register(scope, [
      {
        type: "cron",
        sourceId: "poll-pr",
        cron: "* * * * * *",
        timeZone: "UTC",
      },
      {
        type: "cron",
        sourceId: "poll-requirement",
        cron: "* * * * * *",
        timeZone: "UTC",
      },
    ]);

    now = new Date("2026-07-26T00:00:01.000Z");
    await waitFor(() => due.length === 1);
    expect(due).toEqual([{
      scope,
      sourceIds: ["poll-pr", "poll-requirement"],
    }]);
    queue.close();
  });

  test("removes every Source owned by a Controller scope", async () => {
    let now = new Date("2026-07-26T00:00:00.990Z");
    let due = 0;
    const queue = new CronSourceQueue({
      now: () => now,
      onDue: () => {
        due += 1;
      },
    });
    queue.register(scope, [{
      type: "cron",
      sourceId: "poll",
      cron: "* * * * * *",
      timeZone: "UTC",
    }]);
    queue.removeScope(scope);
    now = new Date("2026-07-26T00:00:01.000Z");

    await Bun.sleep(30);
    expect(due).toBe(0);
    queue.close();
  });
});
