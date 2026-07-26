import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { printBoardSource } from "../src/plugin/board.ts";
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

describe("Plugin Board print", () => {
  test("prints at most one Board item per Resource and hides undefined results", () => {
    const resources = store();
    resources.create({
      kind: "ReqLoopRun",
      resourceId: "run_active",
      spec: { title: "Ship it" },
      status: { phase: "active" },
    });
    resources.create({
      kind: "ReqLoopRun",
      resourceId: "run_closed",
      spec: { title: "Already shipped" },
      status: { phase: "closed" },
    });

    expect(
      printBoardSource<{ title: string }, { phase: string }>({
        pluginId: "qiankun/reqloop",
        pluginInstanceId: "reqloop_default",
        resourceKind: "ReqLoopRun",
        list: () =>
          resources.list<{ title: string }, { phase: string }>("ReqLoopRun"),
        print(resource) {
          if (resource.status.phase === "closed") return undefined;
          return {
            title: resource.spec.title,
            status: resource.status.phase,
          };
        },
      }),
    ).toEqual([
      {
        id: JSON.stringify([
          "reqloop_default",
          "ReqLoopRun",
          "run_active",
        ]),
        pluginId: "qiankun/reqloop",
        pluginInstanceId: "reqloop_default",
        resourceKind: "ReqLoopRun",
        resourceId: "run_active",
        title: "Ship it",
        status: "active",
      },
    ]);
  });

  test("isolates a broken Resource print as a diagnostic item", () => {
    const resources = store();
    resources.create({
      kind: "ReqLoopRun",
      resourceId: "run_1",
      spec: { title: "Ship it" },
    });

    expect(
      printBoardSource({
        pluginId: "qiankun/reqloop",
        pluginInstanceId: "reqloop_default",
        resourceKind: "ReqLoopRun",
        list: () => resources.list("ReqLoopRun"),
        print() {
          throw new Error("connector unavailable");
        },
      }),
    ).toEqual([
      {
        id: JSON.stringify([
          "reqloop_default",
          "ReqLoopRun",
          "run_1",
        ]),
        pluginId: "qiankun/reqloop",
        pluginInstanceId: "reqloop_default",
        resourceKind: "ReqLoopRun",
        resourceId: "run_1",
        title: "ReqLoopRun/run_1",
        status: "print failed",
        detail: "connector unavailable",
        tone: "error",
      },
    ]);
  });
});
