import { afterEach, describe, expect, test } from "bun:test";
import {
  InputRenderable,
  TextareaRenderable,
} from "@opentui/core";
import {
  createTestRenderer,
  type TestRendererSetup,
} from "@opentui/core/testing";
import { createRoot, type Root } from "@opentui/react";
import { defaultTheme, type ChatViewState } from "chat-tui";
import { createElement, createRef } from "react";

import type { Manager } from "../src/plugin/manager.ts";
import type {
  AvailablePluginPackage,
  InstalledPluginPackage,
  MarketplaceRegistry,
} from "../src/plugin/marketplace/index.ts";
import {
  BatonTui,
  type BatonTuiHandle,
} from "../src/tui/app.tsx";
import type { BatonChatProtocol } from "../src/tui/protocol/index.ts";

let mounted: { root: Root; setup: TestRendererSetup } | null = null;

afterEach(() => {
  mounted?.root.unmount();
  mounted?.setup.renderer.destroy();
  mounted = null;
});

const view: ChatViewState = {
  transcript: [],
  header: "Baton chat",
  composerPlaceholder: "Chat input",
  footer: "ready",
};

function protocol(options: {
  available?: readonly AvailablePluginPackage[];
  installed?: readonly InstalledPluginPackage[];
} = {}): BatonChatProtocol {
  const marketplace = {
    available: () => options.available ?? [],
    installed: () => options.installed ?? [],
    list: () => [],
  } as unknown as MarketplaceRegistry;
  const pluginManager = {
    listInstances: () => [],
    isInstanceActive: () => false,
  } as unknown as Manager;

  return {
    marketplace,
    pluginManager,
    commands: [],
    mentionCandidates: () => [],
    getView: () => view,
    subscribe: () => () => {},
    subscribeCommands: () => () => {},
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

describe("Plugin screen interaction", () => {
  test("switches sections with arrows and restores the chat composer after Esc", async () => {
    const setup = await createTestRenderer({
      width: 120,
      height: 30,
      kittyKeyboard: true,
      screenMode: "main-screen",
    });
    const root = createRoot(setup.renderer);
    mounted = { root, setup };
    const tui = createRef<BatonTuiHandle>();

    root.render(
      createElement(BatonTui, {
        ref: tui,
        protocol: protocol(),
        theme: defaultTheme,
      }),
    );
    await settle(setup);

    tui.current?.openPlugins();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Search discover");
    expect(setup.renderer.currentFocusedRenderable).toBeInstanceOf(InputRenderable);

    setup.mockInput.pressArrow("right");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Search installed");

    setup.mockInput.pressEscape();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Chat input");
    expect(setup.renderer.currentFocusedRenderable).toBeInstanceOf(TextareaRenderable);
    expect(setup.renderer.currentFocusedRenderable).not.toBeInstanceOf(InputRenderable);

    await setup.mockInput.typeText("focus restored");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("focus restored");
  });

  test("offers Update now for an installed Package with a newer Marketplace version", async () => {
    const setup = await createTestRenderer({
      width: 120,
      height: 30,
      kittyKeyboard: true,
      screenMode: "main-screen",
    });
    const root = createRoot(setup.renderer);
    mounted = { root, setup };
    const tui = createRef<BatonTuiHandle>();
    const manifest = {
      manifestVersion: 1 as const,
      pluginId: "qiankun/requirement-loop",
      version: "0.2.0",
      entry: "./src/index.ts",
      displayName: "Requirement Loop",
    };

    root.render(
      createElement(BatonTui, {
        ref: tui,
        protocol: protocol({
          available: [{
            marketplace: "reqloop",
            packageDir: "/marketplace/requirement-loop",
            manifest: { ...manifest, version: "0.3.0" },
          }],
          installed: [{
            packageDir: "/baton/requirement-loop/0.2.0",
            manifest,
            provenance: {
              marketplace: "reqloop",
              installedAt: "2026-07-25T00:00:00.000Z",
              marketplaceSource: { kind: "local", path: "/marketplace" },
            },
          }],
        }),
        theme: defaultTheme,
      }),
    );
    await settle(setup);

    tui.current?.openPlugins();
    await settle(setup);
    setup.mockInput.pressArrow("right");
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("Update now");

    setup.mockInput.pressArrow("right");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Search marketplaces");

    setup.mockInput.pressArrow("left");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Search installed");
  });
});
