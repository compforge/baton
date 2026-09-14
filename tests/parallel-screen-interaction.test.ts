import { afterEach, describe, expect, test } from "bun:test";
import {
  InputRenderable,
  TextareaRenderable,
  type ClipboardService,
} from "@opentui/core";
import {
  createTestRenderer,
  type TestRendererSetup,
} from "@opentui/core/testing";
import { createRoot, type Root } from "@opentui/react";
import { createChatStore, defaultTheme } from "chat-tui";
import { createElement, createRef } from "react";

import {
  BatonTui,
  type BatonTuiHandle,
} from "../src/view/chat-tui/app.tsx";
import type { BatonParallelItem } from "../src/view/chat-tui/parallel/model.ts";
import type { BatonChatProtocol } from "../src/view/chat-tui/protocol/index.ts";

let mounted: { root: Root; setup: TestRendererSetup } | null = null;

const clipboard: ClipboardService = {
  read: async () => ({ status: "unsupported" }),
  writeText: async () => ({
    host: { status: "not-attempted" },
    terminal: { status: "attempted", capability: "supported" },
  }),
  clear: async () => ({
    host: { status: "not-attempted" },
    terminal: { status: "attempted", capability: "supported" },
  }),
  dispose: async () => {},
};

afterEach(() => {
  mounted?.root.unmount();
  mounted?.setup.renderer.destroy();
  mounted = null;
});

function protocol(items: BatonParallelItem[]): BatonChatProtocol {
  return {
    commands: [],
    mentionCandidates: () => [],
    stateStore: createChatStore({
      timeline: { items: [], header: "Baton chat" },
      composer: { placeholder: "Chat input" },
      activity: {},
      parallel: { items },
      footer: { text: "ready" },
      sidecar: undefined,
    }),
    listParallelItems: () => items,
    subscribeCompletions: () => () => {},
    submit: () => {},
    command: () => {},
    cancel: () => {},
    exit: () => {},
    resolvePicker: () => {},
    resolveInteraction: () => {},
  } as unknown as BatonChatProtocol;
}

async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.flush();
}

describe("Parallel screen interaction", () => {
  test("switches tabs and restores the chat composer after Esc", async () => {
    const setup = await createTestRenderer({
      width: 120,
      height: 30,
      kittyKeyboard: true,
      screenMode: "main-screen",
    });
    const root = createRoot(setup.renderer);
    mounted = { root, setup };
    const tui = createRef<BatonTuiHandle>();

    root.render(createElement(BatonTui, {
      ref: tui,
      protocol: protocol([]),
      theme: defaultTheme,
      clipboard,
    }));
    await settle(setup);

    tui.current?.openParallel();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Search all");
    expect(setup.renderer.currentFocusedRenderable).toBeInstanceOf(InputRenderable);

    setup.mockInput.pressArrow("right");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Search tasks");

    setup.mockInput.pressEscape();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Chat input");
    expect(setup.renderer.currentFocusedRenderable).toBeInstanceOf(TextareaRenderable);
  });

  test("maps a Tasks tab selection to the protocol stop action", async () => {
    const setup = await createTestRenderer({
      width: 120,
      height: 30,
      kittyKeyboard: true,
      screenMode: "main-screen",
    });
    const root = createRoot(setup.renderer);
    mounted = { root, setup };
    const tui = createRef<BatonTuiHandle>();
    const task: BatonParallelItem = {
      id: "task:main:claude:native-1",
      kind: "task",
      sourceId: "native-1",
      actions: ["stop"],
      icon: "◇",
      name: "claude/Explore",
      description: "Inspect adapter",
      progress: "running · Read",
    };
    const chat = protocol([task]);
    const actions: string[] = [];
    chat.resolveParallelAction = async (itemId, action) => {
      actions.push(`${itemId}:${action}`);
      return "Stop requested for background task native-1";
    };

    root.render(createElement(BatonTui, {
      ref: tui,
      protocol: chat,
      theme: defaultTheme,
      clipboard,
    }));
    await settle(setup);

    tui.current?.openParallel();
    await settle(setup);
    setup.mockInput.pressArrow("right");
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Stop task");

    setup.mockInput.pressEnter();
    await settle(setup);
    expect(actions).toEqual(["task:main:claude:native-1:stop"]);
    expect(setup.captureCharFrame()).toContain("Stop requested for background task native-1");
  });
});
