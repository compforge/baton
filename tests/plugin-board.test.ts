import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  presentBoardSource,
  selectBoardItems,
} from "../src/plugin/board.ts";
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
  test("presents at most one Board item per Resource and hides undefined results", async () => {
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
    resources.create({
      type: REQ_LOOP_RUN,
      name: "run_deleting",
      spec: { title: "Being removed" },
      status: { phase: "active" },
    });
    resources.requestDeletion(REQ_LOOP_RUN, "run_deleting");

    const candidates = await presentBoardSource<
      { title: string },
      { phase: string }
    >({
      pluginId: "qiankun/reqloop",
      pluginInstanceId: "reqloop_default",
      resourceType: REQ_LOOP_RUN,
      list: () =>
        resources.list<{ title: string }, { phase: string }>(REQ_LOOP_RUN),
      async present(resource) {
        if (resource.status.phase === "closed") return undefined;
        return {
          title: resource.spec.title,
          url: "https://example.com/requirements/run_active",
          status: resource.status.phase,
          detail: "A long requirement title",
        };
      },
    });

    expect(selectBoardItems(candidates)).toEqual([
      {
        id: JSON.stringify([
          "reqloop_default",
          REQ_LOOP_RUN.apiVersion,
          "Requirement",
          "run_active",
        ]),
        pluginId: "qiankun/reqloop",
        pluginInstanceId: "reqloop_default",
        resourceApiVersion: REQ_LOOP_RUN.apiVersion,
        resourceKind: "Requirement",
        resourceId: "run_active",
        title: "Ship it",
        url: "https://example.com/requirements/run_active",
        status: "active",
        detail: "A long requirement title",
      },
    ]);
  });

  test("isolates a broken Resource presentation as a diagnostic item", async () => {
    const resources = store();
    resources.create({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { title: "Ship it" },
    });

    const candidates = await presentBoardSource({
      pluginId: "qiankun/reqloop",
      pluginInstanceId: "reqloop_default",
      resourceType: REQ_LOOP_RUN,
      list: () => resources.list(REQ_LOOP_RUN),
      async present() {
        throw new Error("connector unavailable");
      },
    });

    expect(selectBoardItems(candidates)).toEqual([
      {
        id: JSON.stringify([
          "reqloop_default",
          REQ_LOOP_RUN.apiVersion,
          "Requirement",
          "run_1",
        ]),
        pluginId: "qiankun/reqloop",
        pluginInstanceId: "reqloop_default",
        resourceApiVersion: REQ_LOOP_RUN.apiVersion,
        resourceKind: "Requirement",
        resourceId: "run_1",
        title: "Requirement/run_1",
        status: "presentation failed",
        detail: "connector unavailable",
        tone: "error",
      },
    ]);
  });

  test("keeps the five highest-priority items for each Plugin Resource type", async () => {
    const resources = store();
    const TASK = {
      apiVersion: "reqloop.baton.dev/v1alpha1",
      kind: "Task",
    } as const;
    for (let priority = 1; priority <= 6; priority += 1) {
      resources.create({
        type: REQ_LOOP_RUN,
        name: `requirement_${priority}`,
        spec: { title: `Requirement ${priority}`, priority },
      });
      resources.create({
        type: TASK,
        name: `task_${priority}`,
        spec: { title: `Task ${priority}`, priority },
      });
    }

    const requirementCandidates = await presentBoardSource<
      { title: string; priority: number },
      Record<string, never>
    >({
      pluginId: "qiankun/reqloop",
      pluginInstanceId: "reqloop_default",
      resourceType: REQ_LOOP_RUN,
      list: () => resources.list(REQ_LOOP_RUN),
      async present(resource) {
        return {
          title: resource.spec.title,
          priority: resource.spec.priority,
        };
      },
    });
    const taskCandidates = await presentBoardSource<
      { title: string; priority: number },
      Record<string, never>
    >({
      pluginId: "qiankun/reqloop",
      pluginInstanceId: "reqloop_default",
      resourceType: TASK,
      list: () => resources.list(TASK),
      async present(resource) {
        return {
          title: resource.spec.title,
          priority: resource.spec.priority,
        };
      },
    });

    const selected = selectBoardItems([
      ...requirementCandidates,
      ...taskCandidates,
    ]);
    expect(
      selected
        .filter((item) => item.resourceKind === "Requirement")
        .map((item) => item.resourceId),
    ).toEqual([
      "requirement_6",
      "requirement_5",
      "requirement_4",
      "requirement_3",
      "requirement_2",
    ]);
    expect(
      selected
        .filter((item) => item.resourceKind === "Task")
        .map((item) => item.resourceId),
    ).toEqual([
      "task_6",
      "task_5",
      "task_4",
      "task_3",
      "task_2",
    ]);
  });
});
