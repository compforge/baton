import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { presentBoardSource } from "../src/plugin/board.ts";
import { PluginResourceStore } from "../src/plugin/resource.ts";

const roots: string[] = [];
const REQ_LOOP_RUN = {
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "Requirement",
} as const;

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

describe("Plugin Board presentation", () => {
  test("presents at most one Board item per Resource and hides undefined results", () => {
    const resources = store();
    resources.create({
      type: REQ_LOOP_RUN,
      name: "run_active",
      spec: { title: "Ship it" },
      status: { phase: "active" },
    });
    resources.create({
      type: REQ_LOOP_RUN,
      name: "run_closed",
      spec: { title: "Already shipped" },
      status: { phase: "closed" },
    });

    expect(
      presentBoardSource<{ title: string }, { phase: string }>({
        pluginId: "qiankun/reqloop",
        pluginInstanceId: "reqloop_default",
        resourceType: REQ_LOOP_RUN,
        list: () =>
          resources.list<{ title: string }, { phase: string }>(REQ_LOOP_RUN),
        present(resource) {
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
          REQ_LOOP_RUN.apiVersion,
          "Requirement",
          "run_active",
        ]),
        pluginId: "qiankun/reqloop",
        pluginInstanceId: "reqloop_default",
        resourceKind: "Requirement",
        resourceId: "run_active",
        title: "Ship it",
        status: "active",
      },
    ]);
  });

  test("isolates a broken Resource presentation as a diagnostic item", () => {
    const resources = store();
    resources.create({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { title: "Ship it" },
    });

    expect(
      presentBoardSource({
        pluginId: "qiankun/reqloop",
        pluginInstanceId: "reqloop_default",
        resourceType: REQ_LOOP_RUN,
        list: () => resources.list(REQ_LOOP_RUN),
        present() {
          throw new Error("connector unavailable");
        },
      }),
    ).toEqual([
      {
        id: JSON.stringify([
          "reqloop_default",
          REQ_LOOP_RUN.apiVersion,
          "Requirement",
          "run_1",
        ]),
        pluginId: "qiankun/reqloop",
        pluginInstanceId: "reqloop_default",
        resourceKind: "Requirement",
        resourceId: "run_1",
        title: "Requirement/run_1",
        status: "presentation failed",
        detail: "connector unavailable",
        tone: "error",
      },
    ]);
  });
});
