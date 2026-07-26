import { describe, expect, test } from "bun:test";

import type { ReconcileScope } from "../src/plugin/controller.ts";
import {
  nextResourceScheduleAt,
  ResourceScheduleQueue,
  validateResourceSchedules,
} from "../src/plugin/schedule.ts";

const scope: ReconcileScope = {
  batonSessionId: "bs_test",
  pluginInstanceId: "reqloop_default",
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

describe("Plugin Resource schedules", () => {
  test("calculates cron occurrences in the declared time zone", () => {
    expect(
      nextResourceScheduleAt(
        {
          scheduleId: "daily-close-check",
          cron: "0 9 * * *",
          timeZone: "Asia/Shanghai",
        },
        new Date("2026-07-26T00:00:00.000Z"),
      ).toISOString(),
    ).toBe("2026-07-26T01:00:00.000Z");
  });

  test("validates duplicate ids, cron expressions, and time zones", () => {
    expect(() =>
      validateResourceSchedules(
        [
          {
            scheduleId: "poll",
            cron: "*/5 * * * *",
            timeZone: "UTC",
          },
          {
            scheduleId: "poll",
            cron: "0 * * * *",
            timeZone: "UTC",
          },
        ],
        new Date("2026-07-26T00:00:00.000Z"),
      ),
    ).toThrow("Resource scheduleId already registered: poll");
    expect(() =>
      validateResourceSchedules(
        [{
          scheduleId: "poll",
          cron: "not-a-cron",
          timeZone: "UTC",
        }],
        new Date("2026-07-26T00:00:00.000Z"),
      ),
    ).toThrow("invalid Resource schedule poll");
    expect(() =>
      validateResourceSchedules(
        [{
          scheduleId: "poll",
          cron: "*/5 * * * *",
          timeZone: "Mars/Olympus",
        }],
        new Date("2026-07-26T00:00:00.000Z"),
      ),
    ).toThrow("invalid Resource schedule poll");
  });

  test("coalesces schedules due for the same Resource scope", async () => {
    let now = new Date("2026-07-26T00:00:00.990Z");
    const due: ReconcileScope[] = [];
    const queue = new ResourceScheduleQueue({
      now: () => now,
      onDue: (value) => due.push(value),
    });
    queue.register(scope, [
      {
        scheduleId: "poll-pr",
        cron: "* * * * * *",
        timeZone: "UTC",
      },
      {
        scheduleId: "poll-requirement",
        cron: "* * * * * *",
        timeZone: "UTC",
      },
    ]);

    now = new Date("2026-07-26T00:00:01.000Z");
    await waitFor(() => due.length === 1);
    expect(due).toEqual([scope]);
    queue.close();
  });

  test("removes every schedule owned by a Resource scope", async () => {
    let now = new Date("2026-07-26T00:00:00.990Z");
    let due = 0;
    const queue = new ResourceScheduleQueue({
      now: () => now,
      onDue: () => {
        due += 1;
      },
    });
    queue.register(scope, [{
      scheduleId: "poll",
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
