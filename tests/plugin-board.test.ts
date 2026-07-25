import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectBoardSource } from "../src/plugin/board.ts";
import { PluginResourceStore } from "../src/plugin/resource.ts";

const roots: string[] = [];

function store(): PluginResourceStore {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-board-"));
  roots.push(root);
  return new PluginResourceStore({
    session: {
      id: "bs_test",
      dir: join(root, "projects", "project", "sessions", "bs_test"),
    },
    pluginInstanceId: "reqloop_default",
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Plugin Board projection", () => {
  test("isolates a broken resource projection as a diagnostic item", () => {
    const resources = store();
    resources.create({
      kind: "ReqLoopRun",
      resourceId: "run_1",
      spec: { title: "Ship it" },
    });

    expect(
      projectBoardSource({
        pluginId: "qiankun/reqloop",
        pluginInstanceId: "reqloop_default",
        resourceKind: "ReqLoopRun",
        store: resources,
        projector: {
          project() {
            return [
              { key: "duplicate", title: "First" },
              { key: "duplicate", title: "Second" },
            ];
          },
        },
      }),
    ).toEqual([
      {
        id: JSON.stringify([
          "reqloop_default",
          "ReqLoopRun",
          "run_1",
          "__projection_error",
        ]),
        pluginId: "qiankun/reqloop",
        pluginInstanceId: "reqloop_default",
        resourceKind: "ReqLoopRun",
        resourceId: "run_1",
        title: "ReqLoopRun/run_1",
        status: "projection failed",
        detail: "duplicate Board item key: duplicate",
        tone: "error",
      },
    ]);
  });
});
