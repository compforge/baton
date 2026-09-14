import { describe, expect, test } from "bun:test";

import {
  parallelPanelHeight,
  parallelTabItems,
  type BatonParallelItem,
} from "../src/view/chat-tui/parallel/model.ts";

const items: BatonParallelItem[] = [
  {
    id: "task:main:claude:native-1",
    kind: "task",
    sourceId: "native-1",
    actions: ["stop"],
    name: "claude/Explore",
    description: "Inspect adapter",
    progress: "running · Read",
  },
  {
    id: "lane:side",
    kind: "lane",
    sourceId: "side",
    actions: [],
    name: "codex",
    description: "Lane side",
    progress: "running",
  },
  {
    id: "invocation:worker",
    kind: "invocation",
    sourceId: "worker",
    actions: [],
    name: "dsh",
    description: "Run checks",
    progress: "queued",
  },
];

describe("Parallel manager projection", () => {
  test("keeps Tasks as one tab of the same Parallel item set", () => {
    expect(parallelTabItems("all", items)).toEqual(items);
    expect(parallelTabItems("tasks", items).map((item) => item.kind)).toEqual(["task"]);
    expect(parallelTabItems("runs", items).map((item) => item.kind)).toEqual([
      "lane",
      "invocation",
    ]);
  });

  test("searches display and native identity within the selected tab", () => {
    expect(parallelTabItems("tasks", items, "native-1")).toEqual([items[0]!]);
    expect(parallelTabItems("all", items, "RUN CHECKS")).toEqual([items[2]!]);
    expect(parallelTabItems("tasks", items, "codex")).toEqual([]);
  });

  test("uses the same bounded panel sizing as other manager screens", () => {
    expect(parallelPanelHeight(24)).toBe(12);
    expect(parallelPanelHeight(10)).toBe(8);
  });
});
