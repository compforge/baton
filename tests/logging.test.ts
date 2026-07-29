import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type LogEntry,
  SessionLogger,
} from "../src/logging.ts";

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), "baton-logging-")), "session.log");
}

function records(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function entry(
  level: LogEntry["level"],
  message: string,
  attributes?: LogEntry["attributes"],
): LogEntry {
  return {
    level,
    source: "baton",
    component: "test.logging",
    message,
    ...(attributes ? { attributes } : {}),
  };
}

describe("SessionLogger", () => {
  test("filters levels and preserves bounded structured attributes", async () => {
    const path = logPath();
    const logger = new SessionLogger(path, "bs_test", { level: "info" });

    logger.log(entry("debug", "hidden"));
    logger.log(entry("info", "visible", {
      repositories: ["compforge/baton", "compforge/reqloop"],
      result: { admitted: 2, limited: false },
    }));
    await logger.close();

    expect(records(path)).toEqual([
      expect.objectContaining({
        batonSessionId: "bs_test",
        level: "info",
        source: "baton",
        component: "test.logging",
        message: "visible",
        attributes: {
          repositories: ["compforge/baton", "compforge/reqloop"],
          result: { admitted: 2, limited: false },
        },
      }),
    ]);
  });

  test("writes private files and rotates one previous generation", async () => {
    const path = logPath();
    const logger = new SessionLogger(path, "bs_test", { maxBytes: 400 });
    logger.log(entry("info", "a".repeat(180)));
    await logger.flush();
    logger.log(entry("warn", "b".repeat(180)));
    await logger.close();

    expect(existsSync(`${path}.1`)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
    expect(records(`${path}.1`)[0]?.message).toBe("a".repeat(180));
    expect(records(path)[0]?.message).toBe("b".repeat(180));
  });

  test("bounds queue memory and records the number of dropped entries", async () => {
    const path = logPath();
    const logger = new SessionLogger(path, "bs_test", {
      maxQueueBytes: 500,
    });
    for (let index = 0; index < 20; index++) {
      logger.log(entry("info", `${index}:${"x".repeat(120)}`));
    }
    await logger.close();

    const warning = records(path).find((record) =>
      record.component === "logging"
    );
    expect(warning).toMatchObject({
      level: "warn",
      attributes: {
        droppedEntries: expect.any(Number),
      },
    });
  });
});
