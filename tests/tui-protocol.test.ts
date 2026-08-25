import { describe, expect, test } from "bun:test";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptBlockItem, TranscriptItem } from "chat-tui";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import type { InteractionResult } from "../src/interaction/types.ts";
import { PluginResourceStore } from "../src/plugin/resource.ts";
import { MAIN_LANE_ID } from "../src/lane.ts";
import { sessionDisplayTitle, SessionStore } from "../src/store/store.ts";
import {
  BatonChatProtocol,
  runStatusLabel,
  thoughtDisplayBlocks,
  toolTranscriptItem,
} from "../src/view/chat-tui/protocol/index.ts";
import {
  toolGroupKey,
  toolGroupTranscriptItem,
} from "../src/view/chat-tui/protocol/transcript.ts";

function transcriptBlocks(items: readonly TranscriptItem[]): TranscriptBlockItem[] {
  return items.flatMap((item) => {
    if (item.type === "block") return [item];
    if (item.type === "group") return item.members;
    return [];
  });
}

function transcriptBlock(
  items: readonly TranscriptItem[],
  id: string,
): TranscriptBlockItem | undefined {
  return transcriptBlocks(items).find((item) => item.id === id);
}

function stubCompletedSend(
  protocol: BatonChatProtocol,
  onSend?: (harness: string, blocks: Array<{ type: string; text?: string }>) => void,
): void {
  const controller = (protocol as unknown as {
    controller: {
      sendTurn: (
        harness: string,
        blocks: Array<{ type: string; text?: string }>,
      ) => Promise<{
        effective: "new_turn";
        queued: false;
        outcome: Promise<"completed">;
      }>;
    };
  }).controller;
  controller.sendTurn = async (harness, blocks) => {
    onSend?.(harness, blocks);
    return {
      effective: "new_turn",
      queued: false,
      outcome: Promise.resolve("completed"),
    };
  };
}

describe("BatonChatProtocol exit", () => {
  test("restores the TUI only after controller and session cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-exit-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const calls: string[] = [];
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, (sessionId) => {
        calls.push(`quit:${sessionId}`);
      });

      const internals = protocol as unknown as {
        controller: { close: () => Promise<void> };
        plugins: { close: () => Promise<void> };
        marketplace: { close: () => void };
        session: { releaseLock: () => void };
      };
      internals.controller.close = async () => {
        calls.push("controller");
      };
      internals.plugins.close = async () => {
        calls.push("plugins");
      };
      internals.marketplace.close = () => {
        calls.push("marketplace");
      };
      internals.session.releaseLock = () => {
        calls.push("lock");
      };

      await protocol.exit();
      expect(calls).toEqual([
        "plugins",
        "controller",
        "lock",
        "marketplace",
        `quit:${session.id}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol picker search", () => {
  test("debounces remote queries and discards stale responses", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-picker-search-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );
      const calls: string[] = [];
      let resolveFirst: ((value: {
        title: string;
        options: Array<{
          name: string;
          description: string;
          value: string;
        }>;
        search: {
          mode: "remote";
          query: string;
        };
      }) => void) | undefined;
      const first = new Promise<{
        title: string;
        options: Array<{
          name: string;
          description: string;
          value: string;
        }>;
        search: {
          mode: "remote";
          query: string;
        };
      }>((resolve) => {
        resolveFirst = resolve;
      });
      const internals = protocol as unknown as {
        openPicker(picker: {
          title: string;
          options: Array<{
            name: string;
            description: string;
            value: string;
          }>;
          search: {
            mode: "remote";
            query: string;
          };
          onSearch(query: string): Promise<{
            title: string;
            options: Array<{
              name: string;
              description: string;
              value: string;
            }>;
            search: {
              mode: "remote";
              query: string;
            };
          }>;
          onSelect(value: string): void;
        }): void;
      };
      internals.openPicker({
        title: "Requirements",
        options: [],
        search: { mode: "remote", query: "" },
        async onSearch(query) {
          calls.push(query);
          if (query === "first") return await first;
          return {
            title: "Requirements",
            options: [{
              name: "Second result",
              description: "REQ-2",
              value: "REQ-2",
            }],
            search: { mode: "remote", query },
          };
        },
        onSelect() {},
      });
      const pickerId = protocol.stateStore.getState("composer").picker!.id;

      protocol.searchPicker(pickerId, "ignored");
      protocol.searchPicker(pickerId, "first");
      await Bun.sleep(300);
      expect(calls).toEqual(["first"]);
      protocol.searchPicker(pickerId, "second");
      await Bun.sleep(300);
      expect(calls).toEqual(["first", "second"]);
      expect(protocol.stateStore.getState("composer").picker).toMatchObject({
        search: {
          mode: "remote",
          query: "second",
          loading: false,
        },
        options: [{ value: "REQ-2" }],
      });

      resolveFirst?.({
        title: "Requirements",
        options: [{
          name: "Stale result",
          description: "REQ-1",
          value: "REQ-1",
        }],
        search: { mode: "remote", query: "first" },
      });
      await Bun.sleep(0);
      expect(protocol.stateStore.getState("composer").picker?.options).toEqual([
        {
          name: "Second result",
          description: "REQ-2",
          value: "REQ-2",
        },
      ]);

      protocol.resolvePicker(pickerId, null);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol plugin command diagnostics", () => {
  test("records command failures in the current session log", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-plugin-command-log-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );
      const internals = protocol as unknown as {
        plugins: {
          listCommands(): Array<{
            pluginId: string;
            commandId: string;
            name: string;
            description: string;
          }>;
          executeCommand(): Promise<never>;
        };
      };
      internals.plugins.listCommands = () => [{
        pluginId: "qiankun/reqloop",
        commandId: "requirements",
        name: "requirements",
        description: "Browse requirements",
      }];
      internals.plugins.executeCommand = async () => {
        throw new Error("Meegle CLI failed: backend unavailable");
      };

      await expect(
        protocol.command("requirements", ""),
      ).rejects.toThrow("Meegle CLI failed: backend unavailable");
      await session.flushLogs();

      const log = JSON.parse(
        readFileSync(join(session.dir, "session.log"), "utf8").trim(),
      );
      expect(log).toMatchObject({
        batonSessionId: session.id,
        level: "error",
        component: "plugin.command",
        message: "Plugin command /requirements failed",
        pluginId: "qiankun/reqloop",
        error: {
          name: "Error",
          message: "Meegle CLI failed: backend unavailable",
        },
        attributes: {
          command: "requirements",
          phase: "invoke",
        },
      });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol plugin source diagnostics", () => {
  test("keeps the toast concise and writes the full error to the session log", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-plugin-source-log-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );
      await protocol.pluginManager.start();
      const resources = new PluginResourceStore({
        session,
        pluginInstanceId: "pi_reqloop",
      });
      const registration = protocol.pluginManager.registerController({
        store: resources,
        resourceType: {
          apiVersion: "reqloop.baton.dev/v1alpha1",
          kind: "PullRequest",
        },
        sources: [{
          type: "resource",
          sourceId: "forge",
          async start(context) {
            context.reportError(
              new Error("Could not list Forge PullRequests for openai/plugins", {
                cause: new Error(
                  "GET /repos/openai/plugins/pulls returned 404",
                ),
              }),
            );
          },
        }],
        async reconcile() {},
      });

      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (protocol.stateStore.getState("footer").toast) break;
        await Bun.sleep(5);
      }
      expect(protocol.stateStore.getState("footer").toast).toEqual({
        text: "Plugin source forge failed for pi_reqloop/PullRequest",
        tone: "error",
      });
      await session.flushLogs();

      const log = readFileSync(join(session.dir, "session.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((entry) => entry.component === "plugin.source");
      expect(log).toMatchObject({
        batonSessionId: session.id,
        level: "error",
        component: "plugin.source",
        message: "Plugin source forge failed",
        pluginInstanceId: "pi_reqloop",
        error: {
          message: "Could not list Forge PullRequests for openai/plugins",
          cause: {
            message: "GET /repos/openai/plugins/pulls returned 404",
          },
        },
        attributes: {
          resourceApiVersion: "reqloop.baton.dev/v1alpha1",
          resourceKind: "PullRequest",
          sourceId: "forge",
        },
      });

      registration.close();
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol session preview", () => {
  test("captures the first raw user input before mention expansion", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-preview-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      stubCompletedSend(protocol);

      await protocol.submit("Implement session previews");
      await protocol.submit("Do not replace the preview");
      expect(store.openSession(session.id).meta.preview).toBe("Implement session previews");
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("names a fork from its first queued input and keeps the source as description", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-fork-name-"));
    try {
      const store = new SessionStore(root);
      const source = store.createSession({ cwd: "/repo" });
      source.setPreviewIfEmpty("Design session labels");
      const session = store.forkSession(source.id);
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      stubCompletedSend(protocol);

      expect(sessionDisplayTitle(session.meta)).toBe("fork: Design session labels");
      await protocol.submit("Implement fork session labels");
      await protocol.submit("Do not replace the fork name");

      const reopened = store.openSession(session.id);
      expect(reopened.meta.title).toBe("Implement fork session labels");
      expect(reopened.meta.description).toBe("fork: Design session labels");
      expect(sessionDisplayTitle(reopened.meta)).toBe("Implement fork session labels");
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol status command", () => {
  test("shows current session information without persisting command output", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-status-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.setPreviewIfEmpty("Implement status command");
      session.appendEvent({
        source: { type: "baton" },
        kind: "context_window_update",
        harness: "codex",
        harnessTargetId: "codex",
        laneId: MAIN_LANE_ID,
        payload: { modelSelection: "default", usedTokens: 12_500, capacityTokens: 200_000 },
      });
      // Target aggregate now points at the side Lane's newer sample; /status must
      // still render the current main Lane binding instead of leaking side work.
      session.appendEvent({
        source: { type: "baton" },
        kind: "context_window_update",
        harness: "codex",
        harnessTargetId: "codex",
        laneId: "hl_side",
        payload: { modelSelection: "default", usedTokens: 180_000, capacityTokens: 200_000 },
      });
      const eventCount = session.ledger.read().length;
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      await protocol.command("status", "");
      const status = protocol.stateStore.getState("timeline").items.at(-1);
      expect(status).toMatchObject({
        id: "_baton_status",
        author: "baton",
        text: expect.stringContaining("Context: 12,500 / 200,000 tokens (6%)"),
      });
      expect(session.ledger.read().slice(eventCount).map((event) => event.kind)).toEqual([
        "input.received",
        "input.settled",
      ]);
      stubCompletedSend(protocol);
      await protocol.submit("continue");
      expect(protocol.stateStore.getState("timeline").items.some((item) => item.id === "_baton_status")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("context lookup keys by HarnessTarget id, not the Harness wire key", async () => {
    // Harness 描述协议类型（"claude-code"），Target（"claude"）才是状态实例的查询键。
    // 两者故意取不同值，防止投影重新拿 Harness 代替 Target。
    const root = mkdtempSync(join(tmpdir(), "baton-tui-status-claude-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.appendEvent({
        source: { type: "baton" },
        kind: "context_window_update",
        harness: "claude-code",
        harnessTargetId: "claude",
        laneId: MAIN_LANE_ID,
        payload: { modelSelection: "default", usedTokens: 40_000, capacityTokens: 200_000 },
      });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      await protocol.command("claude", "");
      await protocol.command("status", "");
      const status = protocol.stateStore.getState("timeline").items.at(-1);
      expect(status).toMatchObject({
        id: "_baton_status",
        text: expect.stringContaining("Context: 40,000 / 200,000 tokens (20%)"),
      });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol Board", () => {
  test("maps Board items to the optional sidecar and hides it when empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-board-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );
      let items = [
        {
          id: "board-item-1",
          pluginId: "qiankun/reqloop",
          pluginInstanceId: "reqloop_default",
          resourceApiVersion: "reqloop.baton.dev/v1alpha1",
          resourceKind: "HelloCounter",
          resourceShortName: "Counter",
          resourceId: "counter",
          title: "Hello counter",
          url: "https://example.com/counters/hello",
          status: "2 / 3",
          detail: "A long counter title",
          tone: "success" as const,
        },
      ];
      const internals = protocol as unknown as {
        plugins: { listBoardItems: () => typeof items };
        boardChanged: () => void;
      };
      internals.plugins.listBoardItems = () => items;
      let timelineNotifications = 0;
      let composerNotifications = 0;
      let activityNotifications = 0;
      let sidecarNotifications = 0;
      let footerNotifications = 0;
      protocol.stateStore.subscribe("timeline", () => timelineNotifications++);
      protocol.stateStore.subscribe("composer", () => composerNotifications++);
      protocol.stateStore.subscribe("activity", () => activityNotifications++);
      protocol.stateStore.subscribe("sidecar", () => sidecarNotifications++);
      protocol.stateStore.subscribe("footer", () => footerNotifications++);
      internals.boardChanged();

      expect(protocol.stateStore.getState("sidecar")).toEqual({
        title: "Board",
        mode: "auto",
        sections: [
          {
            id: JSON.stringify([
              "reqloop_default",
              "reqloop.baton.dev/v1alpha1",
              "HelloCounter",
            ]),
            title: "Counter",
            items: [
              {
                id: "board-item-1",
                title: "Hello counter",
                url: "https://example.com/counters/hello",
                status: "2 / 3",
                detail: "A long counter title",
                tone: "success",
              },
            ],
          },
        ],
      });
      expect(protocol.stateStore.getState("footer").text).toContain("board:1");
      expect({
        timelineNotifications,
        composerNotifications,
        activityNotifications,
        sidecarNotifications,
        footerNotifications,
      }).toEqual({
        timelineNotifications: 0,
        composerNotifications: 0,
        activityNotifications: 0,
        sidecarNotifications: 1,
        footerNotifications: 1,
      });
      const sidecar = protocol.stateStore.getState("sidecar");
      internals.boardChanged();
      expect(protocol.stateStore.getState("sidecar")).toBe(sidecar);
      items = [{ ...items[0]!, status: "3 / 3" }];
      internals.boardChanged();
      expect({
        timelineNotifications,
        composerNotifications,
        activityNotifications,
        sidecarNotifications,
        footerNotifications,
      }).toEqual({
        timelineNotifications: 0,
        composerNotifications: 0,
        activityNotifications: 0,
        sidecarNotifications: 2,
        footerNotifications: 1,
      });

      await protocol.command("board", "hide");
      expect(protocol.stateStore.getState("sidecar")?.mode).toBe("hidden");
      await protocol.command("board", "");
      expect(protocol.stateStore.getState("sidecar")?.mode).toBe("open");
      await protocol.command("board", "");
      expect(protocol.stateStore.getState("sidecar")?.mode).toBe("hidden");
      await protocol.command("board", "");
      expect(protocol.stateStore.getState("sidecar")?.mode).toBe("open");
      protocol.dismissSidecar();
      expect(protocol.stateStore.getState("sidecar")?.mode).toBe("hidden");

      items = [];
      internals.boardChanged();
      expect(protocol.stateStore.getState("sidecar")).toBeUndefined();
      expect(protocol.stateStore.getState("footer").text).not.toContain("board:");
      await protocol.command("board", "");
      expect(protocol.stateStore.getState("footer").toast).toEqual({
        text: "Board has no items",
        tone: "info",
      });
      expect(session.ledger.read()).toHaveLength(10);
      expect(session.ledger.read().every((event) =>
        event.kind === "input.received" || event.kind === "input.settled"
      )).toBe(true);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol proposed plan", () => {
  test("renders a completed proposal as history, not as the live plan pin", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-proposed-plan-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.appendEvent({
        source: { type: "harness", harnessTargetId: "claude" },
        harness: "claude-code",
        harnessTargetId: "claude",
        turnId: "t1",
        kind: "proposed_plan",
        payload: { planId: "pl-proposed", content: "# Proposal\n\nReview before implementation." },
      });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      expect(protocol.stateStore.getState("timeline").plan).toBeUndefined();
      expect(transcriptBlock(protocol.stateStore.getState("timeline").items, "pl-proposed")).toEqual({
        type: "block",
        id: "pl-proposed",
        kind: "proposed_plan",
        status: "completed",
        author: "claude",
        title: "Proposed plan",
        content: { type: "text", text: "# Proposal\n\nReview before implementation." },
      });

      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol plugins command", () => {
  test("opens the client Plugin manager without changing session state", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-plugins-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      let opened = 0;
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
        { openPlugins: () => opened++ },
      );

      await protocol.command("plugins", "");

      expect(opened).toBe(1);
      expect(session.ledger.read().map((event) => event.kind)).toEqual([
        "input.received",
        "input.settled",
      ]);
      await expect(protocol.command("plugins", "extra")).rejects.toThrow("/plugins takes no arguments");
      await protocol.command("reload-plugins", "");
      expect(protocol.stateStore.getState("footer").toast).toEqual({
        text: "Reloaded 0 plugin instances",
        tone: "info",
      });
      await expect(protocol.command("reload-plugins", "extra")).rejects.toThrow(
        "/reload-plugins takes no arguments",
      );
      expect(session.ledger.read()).toHaveLength(8);
      expect(session.ledger.read().every((event) =>
        event.kind === "input.received" || event.kind === "input.settled"
      )).toBe(true);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol streaming State", () => {
  test("limits stream publications so composer rendering gets idle frames", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-stream-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      let notifications = 0;
      protocol.stateStore.subscribe("timeline", () => notifications++);

      for (const text of ["one ", "two ", "three"]) {
        session.appendEvent({
          source: { type: "baton" },
          kind: "agent_message_chunk",
          harness: "codex",
          turnId: "t1",
          payload: { messageId: "m_stream", content: { type: "text", text } },
        });
      }

      expect(notifications).toBe(0);
      await Bun.sleep(50);
      expect(notifications).toBe(0);
      await Bun.sleep(75);
      expect(notifications).toBe(1);
      expect(protocol.stateStore.getState("timeline").items).toContainEqual(
        expect.objectContaining({ id: "m_stream", text: "one two three" }),
      );
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flushes pending stream state immediately when an interaction arrives", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-stream-interaction-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      let notifications = 0;
      protocol.stateStore.subscribe("timeline", () => notifications++);

      session.appendEvent({
        source: { type: "baton" },
        kind: "agent_message_chunk",
        harness: "codex",
        turnId: "t1",
        payload: { messageId: "m_stream", content: { type: "text", text: "latest output" } },
      });
      session.appendEvent({
        source: { type: "baton" },
        kind: "interaction.requested",
        harness: "codex",
        turnId: "t1",
        payload: {
          kind: "permission",
          interactionId: "ix_stream",
          requester: { type: "harness", harnessTargetId: "codex" },
          title: "Run command?",
          options: [],
        },
      });

      expect(notifications).toBe(1);
      expect(protocol.stateStore.getState("composer").interactions?.[0]?.id).toBe("ix_stream");
      expect(protocol.stateStore.getState("timeline").items).toContainEqual(
        expect.objectContaining({ id: "m_stream", text: "latest output" }),
      );
      await Bun.sleep(125);
      expect(notifications).toBe(1);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol harness commands", () => {
  test("selects an additional configured Target by id", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-target-command-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const config = {
        ...DEFAULT_CONFIG,
        targets: {
          ...DEFAULT_CONFIG.targets,
          "dsh-test": { harness: "dsh", model: "prod" },
        },
      };
      const protocol = new BatonChatProtocol(store, config, { session, resumed: false }, () => undefined);
      const submitted: string[] = [];
      stubCompletedSend(protocol, (target) => submitted.push(target));

      await protocol.command("target", "dsh-test");
      await protocol.submit("inspect this");

      expect(submitted).toEqual(["dsh-test"]);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("switches the input target and sends a trailing message in one action", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-harness-command-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      const submitted: Array<{ harness: string; text: string }> = [];
      const internals = protocol as unknown as {
        controller: {
          compactContext: (harness: string) => Promise<void>;
        };
      };
      stubCompletedSend(protocol, (harness, blocks) => {
        submitted.push({ harness, text: blocks[0]?.text ?? "" });
      });
      const compacted: string[] = [];
      internals.controller.compactContext = async (harness) => {
        compacted.push(harness);
      };

      await protocol.command("claude", "");
      expect(protocol.stateStore.getState("activity").items?.[0]).toMatchObject({ author: "claude" });

      await protocol.command("codex", "");
      expect(protocol.stateStore.getState("activity").items?.[0]).toMatchObject({ author: "codex" });

      await protocol.command("dsh", "");
      expect(protocol.stateStore.getState("activity").items?.[0]).toMatchObject({ author: "dsh" });

      await protocol.command("cc", "review this");
      expect(protocol.stateStore.getState("activity").items?.[0]).toMatchObject({ author: "claude" });
      expect(submitted).toEqual([{ harness: "claude", text: "review this" }]);

      await protocol.command("cx", "fix it");
      expect(submitted.at(-1)).toEqual({ harness: "codex", text: "fix it" });

      await protocol.command("claude", "explain it");
      expect(submitted.at(-1)).toEqual({ harness: "claude", text: "explain it" });

      await protocol.command("codex", "implement it");
      expect(submitted.at(-1)).toEqual({ harness: "codex", text: "implement it" });

      await protocol.command("deepseek", "inspect it");
      expect(submitted.at(-1)).toEqual({ harness: "dsh", text: "inspect it" });

      await protocol.command("codex", "");

      await protocol.command("compact", "");
      expect(compacted).toEqual(["codex"]);
      expect(protocol.stateStore.getState("footer").toast?.text).toBe("codex context compacted");

      await protocol.submit("/c ambiguous");
      expect(submitted.at(-1)).toEqual({ harness: "codex", text: "/c ambiguous" });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("switches Plan mode with /plan and cycles back with Shift+Tab intent", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-mode-command-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      let mode = "default";
      const controller = (
        protocol as unknown as {
          controller: {
            getConfig: () => Promise<Array<{
              id: string;
              type: "select";
              name: string;
              category: string;
              value: string;
              options: Array<{ value: string; name: string }>;
            }>>;
            setConfig: (_target: string, _id: string, value: string) => Promise<unknown>;
          };
        }
      ).controller;
      controller.getConfig = async () => [{
        id: "mode",
        type: "select",
        name: "Mode",
        category: "mode",
        value: mode,
        options: [
          { value: "default", name: "Default" },
          { value: "plan", name: "Plan" },
        ],
      }];
      controller.setConfig = async (_target, _id, value) => {
        mode = value;
        session.setHarnessSession("codex", {
          harnessTargetId: "codex",
          harness: "codex",
          ...(value === "default" ? {} : { mode: value }),
        });
        return [];
      };
      const submitted: Array<{ harness: string; text: string }> = [];
      stubCompletedSend(protocol, (harness, blocks) => {
        submitted.push({ harness, text: blocks[0]?.text ?? "" });
      });

      await protocol.command("plan", "");
      expect(mode).toBe("plan");
      expect(protocol.stateStore.getState("footer").toast?.text).toBe("codex mode: Plan");
      expect(protocol.stateStore.getState("activity").items).toHaveLength(1);
      expect(protocol.stateStore.getState("activity").items?.[0]?.label).toBe("default · plan mode · idle");

      await protocol.command("plan", "investigate the failure");
      expect(mode).toBe("plan");
      expect(submitted).toEqual([{ harness: "codex", text: "investigate the failure" }]);

      await protocol.cycleMode();
      expect(mode).toBe("default");
      expect(protocol.stateStore.getState("footer").toast?.text).toBe("codex mode: Default");

      controller.setConfig = async () => {
        throw new Error("mode change failed");
      };
      await expect(protocol.command("plan", "do not send this")).rejects.toThrow("mode change failed");
      expect(submitted).toEqual([{ harness: "codex", text: "investigate the failure" }]);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("toggles Fast mode and shows it in the harness status", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-fast-command-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );
      let fast = false;
      const controller = (
        protocol as unknown as {
          controller: {
            getConfig: () => Promise<Array<{
              id: string;
              type: "boolean";
              name: string;
              value: boolean;
            }>>;
            setConfig: (_target: string, _id: string, value: boolean) => Promise<unknown>;
          };
        }
      ).controller;
      controller.getConfig = async () => [{ id: "fast", type: "boolean", name: "Fast", value: fast }];
      controller.setConfig = async (_target, _id, value) => {
        fast = value;
        session.appendEvent({
          kind: "config_option_update",
          source: { type: "harness", harnessTargetId: "codex" },
          harness: "codex",
          harnessTargetId: "codex",
          laneId: MAIN_LANE_ID,
          payload: {
            options: [{ id: "fast", type: "boolean", name: "Fast", value: fast }],
          },
        });
        return [];
      };
      const submitted: Array<{ harness: string; text: string }> = [];
      stubCompletedSend(protocol, (harness, blocks) => {
        submitted.push({ harness, text: blocks[0]?.text ?? "" });
      });

      await protocol.command("fast", "");
      expect(protocol.stateStore.getState("footer").toast?.text).toBe(
        "codex Fast mode: on (takes effect next turn)",
      );
      expect(protocol.stateStore.getState("activity").items?.[0]?.label).toBe("default · Fast · idle");

      await protocol.command("fast", "continue with the fix");
      expect(protocol.stateStore.getState("footer").toast).toBeNull();
      expect(protocol.stateStore.getState("activity").items?.[0]?.label).not.toContain("Fast");
      expect(submitted).toEqual([{ harness: "codex", text: "continue with the fix" }]);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("maps /h and /eh to effort levels and sends trailing text", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-effort-shortcuts-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      const selected: string[] = [];
      const controller = (
        protocol as unknown as {
          controller: {
            listEfforts: () => Promise<Array<{ id: string; label: string }>>;
            setEffort: (_target: string, effort: string) => Promise<void>;
          };
        }
      ).controller;
      controller.listEfforts = async () => [
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra high" },
      ];
      controller.setEffort = async (_target, effort) => {
        selected.push(effort);
      };
      const submitted: Array<{ harness: string; text: string }> = [];
      stubCompletedSend(protocol, (harness, blocks) => {
        submitted.push({ harness, text: blocks[0]?.text ?? "" });
      });

      await protocol.command("h", "fix this issue");
      await protocol.command("eh", "analyze the root cause");
      expect(selected).toEqual(["high", "xhigh"]);
      expect(submitted).toEqual([
        { harness: "codex", text: "fix this issue" },
        { harness: "codex", text: "analyze the root cause" },
      ]);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol State projection", () => {
  type ViewInternals = {
    state: {
      plans: Map<string, { planId: string; harness?: string; entries: Array<{ content: string; status: string }> }>;
      perTarget: Map<string, { lastPlanId?: string }>;
      timeline: Array<{ type: string; id: string }>;
      activeTurns: Map<
        string,
        {
          turnId: string;
          harness?: string;
          harnessTargetId?: string;
          state: "running" | "requires_action";
          startedAt?: number;
        }
      >;
    };
    changed: () => void;
  };

  test("idle agent status explicitly confirms the harness is no longer running", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-agentstatus-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      const runStatus = protocol.stateStore.getState("activity").items;
      const footer = protocol.stateStore.getState("footer").text;
      const composer = protocol.stateStore.getState("composer");
      // 主行常驻：idle 显式可见，无计时/中断提示
      expect(runStatus).toHaveLength(1);
      expect(runStatus?.[0]).toMatchObject({
        author: "codex",
        label: "default · idle",
      });
      expect(runStatus?.[0]?.startedAt).toBeUndefined();
      expect(runStatus?.[0]?.hint).toBeUndefined();
      expect(footer).toStartWith(`session: ${session.id}  `);
      expect(composer.placeholder).toContain("Ctrl+J newline");
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("agent status shows an explicitly selected effort beside the model", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-effort-status-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.setHarnessSession("codex", {
        harnessTargetId: "codex",
        harness: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
      });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      expect(protocol.stateStore.getState("activity").items?.[0]?.label).toBe("gpt-5.6-sol · xhigh · idle");

      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("agent status shows context usage for its harness and model", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-context-status-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.appendEvent({
        source: { type: "baton" },
        kind: "context_window_update",
        harness: "codex",
        harnessTargetId: "codex",
        laneId: MAIN_LANE_ID,
        payload: { modelSelection: "default", usedTokens: 12_500, capacityTokens: 200_000 },
      });
      session.appendEvent({
        source: { type: "baton" },
        kind: "context_window_update",
        harness: "codex",
        harnessTargetId: "codex-secondary",
        laneId: MAIN_LANE_ID,
        payload: { modelSelection: "default", usedTokens: 150_000, capacityTokens: 200_000 },
      });
      session.appendEvent({
        source: { type: "baton" },
        kind: "context_window_update",
        harness: "claude-code",
        harnessTargetId: "claude",
        laneId: MAIN_LANE_ID,
        payload: { modelSelection: "default", usedTokens: 80_000, capacityTokens: 200_000 },
      });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      expect(protocol.stateStore.getState("activity").items).toHaveLength(1);
      expect(protocol.stateStore.getState("activity").items?.[0]?.label).toBe("default · idle · context 6.3%");
      expect(protocol.stateStore.getState("footer").text).not.toContain("context");
      await protocol.command("claude", "");
      expect(protocol.stateStore.getState("activity").items).toHaveLength(1);
      expect(protocol.stateStore.getState("activity").items?.[0]?.label).toBe("default · idle · context 40.0%");
      expect(protocol.stateStore.getState("footer").text).not.toContain("context");

      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("agent status omits context usage reported for an old model", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-stale-context-status-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.appendEvent({
        source: { type: "baton" },
        kind: "context_window_update",
        harness: "codex",
        harnessTargetId: "codex",
        laneId: MAIN_LANE_ID,
        payload: { modelSelection: "gpt-old", usedTokens: 190_000, capacityTokens: 200_000 },
      });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      expect(protocol.stateStore.getState("activity").items?.[0]?.label).toBe("default · idle");

      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plan shows in exactly one place: pin while unfinished, transcript once done", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-plan-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      const internals = protocol as unknown as ViewInternals;
      const planInTranscript = () =>
        transcriptBlocks(protocol.stateStore.getState("timeline").items)
          .some((item) => item.kind === "plan");

      internals.state.plans.set("p1", {
        planId: "p1",
        harness: "codex",
        entries: [
          { content: "step one", status: "completed" },
          { content: "step two", status: "in_progress" },
        ],
      });
      internals.state.timeline.push({ type: "plan", id: "p1" });
      // 归属查询键在统一 per-Target 槽（reduce 里由 plan_update 维护；这里直接摆内部状态）
      internals.state.perTarget.set("codex", { lastPlanId: "p1" });
      // pin 是"现在时"层：只要当前 Target 有 Turn 在运行即可。
      internals.state.activeTurns.set("t_obs", {
        turnId: "t_obs",
        harness: "codex",
        harnessTargetId: "codex",
        state: "running",
      });
      internals.changed();
      expect(protocol.stateStore.getState("timeline").plan).toEqual([
        { content: "step one", status: "completed" },
        { content: "step two", status: "in_progress" },
      ]);
      expect(protocol.stateStore.getState("footer").text).toContain("plan:1/2");
      // 互补显示：进行中归 pin，transcript 不重复渲染（过去时区域不该有实时改写的块）
      expect(planInTranscript()).toBe(false);

      // plan 跟随 harness：切到另一家后不再占用 pinned 层，切回则恢复。
      await protocol.command("claude", "");
      expect(protocol.stateStore.getState("timeline").plan).toBeUndefined();
      expect(protocol.stateStore.getState("footer").text).not.toContain("plan:");
      expect(planInTranscript()).toBe(true);
      await protocol.command("codex", "");
      expect(protocol.stateStore.getState("timeline").plan).toHaveLength(2);
      expect(planInTranscript()).toBe(false);

      // idle 且未完成：pin 卸下（搁置即过去时）——否则状态更新缺失/中途放弃时 pin 永驻
      internals.state.activeTurns.clear();
      internals.changed();
      expect(protocol.stateStore.getState("timeline").plan).toBeUndefined();
      expect(protocol.stateStore.getState("footer").text).not.toContain("plan:");
      expect(planInTranscript()).toBe(true);

      // 同一种 Harness 的另一个 Target 在跑，不得把当前 Target 的 plan 重新上 pin。
      internals.state.activeTurns.set("t_sibling", {
        turnId: "t_sibling",
        harness: "codex",
        harnessTargetId: "codex-secondary",
        state: "running",
      });
      internals.changed();
      expect(protocol.stateStore.getState("timeline").plan).toBeUndefined();
      expect(planInTranscript()).toBe(true);

      // 当前 Target 的回合重新开跑：未完成 plan 重新上 pin，transcript 卡随之撤下
      internals.state.activeTurns.clear();
      internals.state.activeTurns.set("t_obs", {
        turnId: "t_obs",
        harness: "codex",
        harnessTargetId: "codex",
        state: "running",
      });
      internals.changed();
      expect(protocol.stateStore.getState("timeline").plan).toHaveLength(2);
      expect(planInTranscript()).toBe(false);

      // 全部完成：即使仍在运行，pin 停发、footer 摘要撤下，终态卡在 transcript 原位供回看
      internals.state.plans.set("p1", {
        planId: "p1",
        harness: "codex",
        entries: [
          { content: "step one", status: "completed" },
          { content: "step two", status: "completed" },
        ],
      });
      internals.changed();
      expect(protocol.stateStore.getState("timeline").plan).toBeUndefined();
      expect(protocol.stateStore.getState("footer").text).not.toContain("plan:");
      expect(planInTranscript()).toBe(true);
      expect(
        transcriptBlocks(protocol.stateStore.getState("timeline").items)
          .find((item) => item.kind === "plan"),
      ).toMatchObject({ id: "p1", status: "completed" });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol transcript projection", () => {
  test("labels a Plugin-source user-role message with its Plugin identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-plugin-input-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.appendEvent({
        source: { type: "plugin", pluginInstanceId: "reqloop_default" },
        kind: "user_message",
        harness: "codex",
        harnessTargetId: "codex",
        turnId: "t_plugin",
        payload: {
          messageId: "m_plugin",
          content: [{ type: "text", text: "Implement requirement." }],
        },
      });
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );
      expect(
        protocol.stateStore.getState("timeline").items.find(
          (item) => item.id === "m_plugin",
        ),
      ).toMatchObject({
        role: "user",
        author: "reqloop_default",
        text: "Implement requirement.",
      });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("projects a side Lane as one HarnessInvocation card and hides its raw transcript", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-worker-lane-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.setHarnessTarget("codex", {
        harnessTargetId: "codex",
        harness: "codex",
      });
      session.ensureHarnessInvocationLane("hl_worker", "hinv_worker", MAIN_LANE_ID);
      session.appendEvent({
        source: { type: "plugin", pluginInstanceId: "reqloop_default" },
        kind: "_baton_harness_invocation_recorded",
        payload: {
          invocationId: "hinv_worker",
          executionId: "pex_worker",
          verb: "harness",
          title: "Implement requirement",
          prompt: "Implement REQ-1",
          laneId: MAIN_LANE_ID,
          newLane: true,
          harnessTargetId: "codex",
        },
      });
      session.appendEvent({
        source: { type: "baton" },
        kind: "_baton_harness_invocation_scheduled",
        payload: {
          invocationId: "hinv_worker",
          messageId: "m_worker",
          turnId: "t_worker",
          harnessTargetId: "codex",
          laneId: "hl_worker",
        },
      });
      const coordinate = {
        harness: "codex",
        harnessTargetId: "codex",
        laneId: "hl_worker",
        turnId: "t_worker",
      } as const;
      session.appendEvent({
        source: { type: "plugin", pluginInstanceId: "reqloop_default" },
        kind: "user_message",
        ...coordinate,
        payload: {
          messageId: "m_worker",
          content: [{ type: "text", text: "Implement REQ-1" }],
        },
      });
      session.appendEvent({
        source: { type: "harness", harnessTargetId: "codex" },
        kind: "agent_message",
        ...coordinate,
        payload: {
          messageId: "m_worker_answer",
          content: [{ type: "text", text: "Implemented and tested." }],
        },
      });
      session.appendEvent({
        source: { type: "harness", harnessTargetId: "codex" },
        kind: "state_update",
        ...coordinate,
        payload: { state: "idle", stopReason: "end_turn" },
      });
      session.summarizeTurn("t_worker");

      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );
      const items = protocol.stateStore.getState("timeline").items;
      expect(items.find((item) => item.id === "m_worker")).toBeUndefined();
      expect(items.find((item) => item.id === "m_worker_answer")).toBeUndefined();
      expect(transcriptBlock(items, "harness-invocation:hinv_worker")).toMatchObject({
        kind: "task",
        status: "completed",
        title: "Implement requirement · completed",
        content: {
          lines: expect.arrayContaining([
            "Lane: hl_worker",
            "Implemented and tested.",
          ]),
        },
      });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 委托状态是否可见改由 adapter 报告的生效路由驱动（见 session-controller.test.ts）：
  // 投影不再读 config——config 是意图，且投影层不得按 harness 分支（不变量 #3）。
  test("renders auto-review receipts beside the target tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-auto-review-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.appendEvent({
        source: { type: "baton" },
        kind: "tool_call_update",
        harness: "codex",
        turnId: "t1",
        payload: { toolCallId: "tc1", title: "edit src/app.ts", kind: "edit", status: "completed" },
      });
      session.appendEvent({
        source: { type: "baton" },
        kind: "approval_review_update",
        harness: "codex",
        turnId: "t1",
        payload: {
          reviewId: "arv_test1",
          toolCallId: "tc1",
          decision: "approved",
          riskLevel: "low",
          userAuthorization: "unknown",
          rationale: "Auto-review returned a low-risk allow decision.",
        },
      });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      const items = protocol.stateStore.getState("timeline").items;
      const toolIndex = items.findIndex((item) => item.id === "group:tc1");
      // 展示双轴：approved 的 outcome 是 completed（审到底了，不被遮成 warning），
      // 需留痕由正交的 tone 表达（委托代批放行 → 审计痕）
      expect(items[toolIndex + 1]).toMatchObject({
        type: "group",
        id: "group:approval-review:arv_test1",
        members: [{
        id: "approval-review:arv_test1",
        kind: "notice",
        status: "completed",
        tone: "warning",
        title: "Automatic approval review approved (risk: low, authorization: unknown)",
        content: { type: "text", text: "Auto-review returned a low-risk allow decision." },
        }],
      });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("renders agent messages as Markdown with an explicit streaming boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-markdown-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.appendEvent({
        source: { type: "baton" },
        kind: "user_message",
        harness: "codex",
        turnId: "t1",
        payload: { messageId: "m_user", content: [{ type: "text", text: "## literal" }] },
      });
      session.appendEvent({ source: { type: "baton" }, kind: "state_update", harness: "codex", turnId: "t1", payload: { state: "running" } });
      session.appendEvent({
        source: { type: "baton" },
        kind: "agent_thought",
        harness: "codex",
        turnId: "t1",
        payload: { messageId: "m_thought", content: [{ type: "text", text: "**Inspecting image**" }] },
      });
      session.appendEvent({
        source: { type: "baton" },
        kind: "agent_message_chunk",
        harness: "codex",
        turnId: "t1",
        payload: { messageId: "m_stream", content: { type: "text", text: "## Streaming" } },
      });
      session.appendEvent({
        source: { type: "baton" },
        kind: "agent_message",
        harness: "codex",
        turnId: "t1",
        payload: { messageId: "m_done", content: [{ type: "text", text: "**Done**" }] },
      });

      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: true }, () => undefined);
      const messages = protocol.stateStore.getState("timeline").items.filter((item) => item.type === "message");
      expect(messages).toEqual([
        {
          type: "message",
          id: "m_user",
          role: "user",
          author: "you",
          text: "## literal",
          format: "plain",
        },
        {
          type: "message",
          id: "m_stream",
          role: "agent",
          author: "codex",
          text: "## Streaming",
          format: "markdown",
          streaming: true,
        },
        {
          type: "message",
          id: "m_done",
          role: "agent",
          author: "codex",
          text: "**Done**",
          format: "markdown",
          streaming: false,
        },
      ]);
      // thought/tool block 的归属走一等 author 字段，不再拼进 title
      expect(transcriptBlock(protocol.stateStore.getState("timeline").items, "m_thought:0")).toMatchObject({
        author: "codex",
        title: "Inspecting image",
      });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("thoughtDisplayBlocks", () => {
  test("turns Codex title-only summaries into separate blocks", () => {
    expect(thoughtDisplayBlocks("**Inspecting files**\n\n<!-- -->\n**Planning changes**\n\n<!-- -->")).toEqual([
      { title: "Inspecting files" },
      { title: "Planning changes" },
    ]);
  });

  test("hides an incomplete streaming placeholder", () => {
    expect(thoughtDisplayBlocks("**Inspecting files**\n\n<!--")).toEqual([{ title: "Inspecting files" }]);
  });

  test("keeps an ordinary thought body", () => {
    expect(thoughtDisplayBlocks("**Comparing options**\n\nThe second approach is smaller.")).toEqual([
      { title: "Comparing options", content: "The second approach is smaller." },
    ]);
  });
});

describe("toolTranscriptItem", () => {
  test("keeps command source separate from its output", () => {
    expect(
      toolTranscriptItem({
        toolCallId: "tc_cmd",
        harness: "codex",
        title: "Bash: git status --short",
        kind: "execute",
        status: "completed",
        content: [{ type: "text", text: " M src/index.ts\n" }],
        locations: [],
        rawInput: { command: "git status --short" },
      }),
    ).toEqual({
      type: "block",
      id: "tc_cmd",
      kind: "tool",
      author: "codex",
      title: "Ran · git status --short · 1 line",
      status: "completed",
      content: [
        { type: "command", command: "git status --short" },
        { type: "output", lines: [" M src/index.ts"] },
      ],
    });
  });

  test("maps diff blocks to op-tagged chat-tui diff content", () => {
    const patch = "--- src/index.ts\n+++ src/index.ts\n@@ -1 +1 @@\n-old\n+new";
    expect(
      toolTranscriptItem({
        toolCallId: "tc_edit",
        title: "edit src/index.ts",
        kind: "edit",
        status: "completed",
        content: [{ type: "diff", changes: [{ operation: "modify", path: "src/index.ts" }], patch }],
        locations: [],
      }),
    ).toEqual({
      type: "block",
      id: "tc_edit",
      kind: "tool",
      title: "Edit · src/index.ts · 1 file · +1 -1",
      status: "completed",
      content: [{ type: "diff", op: "modify", path: "src/index.ts", oldPath: undefined, patch }],
    });
  });

  test("patchless diff still yields an op-tagged block; open operations normalize", () => {
    const item = toolTranscriptItem({
      toolCallId: "tc_patch",
      title: "apply patch",
      kind: "edit",
      status: "completed",
      content: [
        { type: "diff", changes: [{ operation: "add", path: "a.ts" }] },
        { type: "diff", changes: [{ operation: "update", path: "b.ts" }] },
        { type: "diff", changes: [{ operation: "rename", path: "d.ts", oldPath: "c.ts" }] },
      ],
      locations: [],
    });
    expect(item.content).toEqual([
      { type: "diff", op: "add", path: "a.ts", oldPath: undefined, patch: undefined },
      { type: "diff", op: "modify", path: "b.ts", oldPath: undefined, patch: undefined },
      { type: "diff", op: "move", path: "d.ts", oldPath: "c.ts", patch: undefined },
    ]);
  });

  test("keeps the filename when compacting a long tool path", () => {
    const path = `/workspace/${"deep/".repeat(20)}important-file.ts`;
    const item = toolTranscriptItem({
      toolCallId: "tc_read",
      title: `Read: ${path}`,
      kind: "read",
      status: "completed",
      content: [{ type: "text", text: "one\ntwo" }],
      locations: [],
      rawInput: { file_path: path },
    });
    expect(item.title).toStartWith("Read · …");
    expect(item.title).toContain("important-file.ts");
    expect(item.title).toEndWith("· 2 lines");
  });
});

describe("tool call grouping", () => {
  const tool = (
    toolCallId: string,
    kind: string,
    status: "pending" | "in_progress" | "completed" | "failed" = "completed",
  ) => ({
    toolCallId,
    harness: "codex",
    harnessTargetId: "codex",
    turnId: "t1",
    title: `${kind[0]!.toUpperCase()}${kind.slice(1)}: ${toolCallId}`,
    kind,
    status,
    content: [{ type: "text" as const, text: `${toolCallId} output\n` }],
    locations: [],
    rawInput: kind === "search" ? { pattern: toolCallId } : { file_path: `${toolCallId}.ts` },
  });

  test("groups only successful exploratory tools with the same projection coordinates", () => {
    const read = tool("tc_read", "read");
    expect(toolGroupKey(read)).toBe(toolGroupKey({ ...read, toolCallId: "tc_read_2" }));
    expect(toolGroupKey({ ...read, turnId: "t2" })).not.toBe(toolGroupKey(read));
    expect(toolGroupKey({ ...read, harnessTargetId: "codex-2" })).not.toBe(toolGroupKey(read));
    expect(toolGroupKey({ ...read, status: "failed" })).toBeUndefined();
    expect(toolGroupKey(tool("tc_edit", "edit"))).toBeUndefined();
  });

  test("adapter-reported effect takes precedence over the kind fallback", () => {
    // 未上报 effect:按 kind 兜底(read/search/fetch 可组,execute 不组)——老 harness 行为不变
    expect(toolGroupKey(tool("tc_exec", "execute"))).toBeUndefined();
    // 上报后以 effect 为准:只读 execute 可组,标 write 的 read 不组
    const execRead = { ...tool("tc_exec_ro", "execute"), effect: "read" };
    expect(toolGroupKey(execRead)).toBe(toolGroupKey({ ...tool("tc_exec_ro2", "execute"), effect: "read" }));
    expect(toolGroupKey({ ...tool("tc_read_w", "read"), effect: "write" })).toBeUndefined();
  });

  test("renders a read-only execute group with command text per line", () => {
    const exec = (
      toolCallId: string,
      command: string,
      status: "completed" | "in_progress" = "completed",
    ) => ({
      ...tool(toolCallId, "execute", status),
      effect: "read",
      rawInput: { command },
    });
    expect(toolGroupTranscriptItem([
      exec("tc_one", "head -80 src/lane.ts"),
      exec("tc_two", "grep -rn task src/ | head -20", "in_progress"),
    ])).toEqual({
      type: "group",
      id: "group:tc_one",
      collapsedByDefault: true,
      summary: {
        type: "block",
        id: "group:tc_one:summary",
        kind: "tool",
        author: "codex",
        title: "Ran ×2 · grep -rn task src/ | head -20",
        status: "in_progress",
      },
      members: [
        {
          type: "block",
          id: "tc_one",
          kind: "tool",
          author: "codex",
          title: "Ran · head -80 src/lane.ts · 1 line",
          status: "completed",
          content: [
            { type: "command", command: "head -80 src/lane.ts" },
            { type: "output", lines: ["tc_one output"] },
          ],
        },
        {
          type: "block",
          id: "tc_two",
          kind: "tool",
          author: "codex",
          title: "Running · grep -rn task src/ | head -20 · 1 line",
          status: "in_progress",
          content: [
            { type: "command", command: "grep -rn task src/ | head -20" },
            { type: "output", lines: ["tc_two output"] },
          ],
        },
      ],
    });
  });

  test("projects a compact group with stable first-member identity", () => {
    expect(toolGroupTranscriptItem([
      tool("src/one", "read"),
      tool("src/two", "read", "in_progress"),
    ])).toEqual({
      type: "group",
      id: "group:src/one",
      collapsedByDefault: true,
      summary: {
        type: "block",
        id: "group:src/one:summary",
        kind: "tool",
        author: "codex",
        title: "Read ×2 · src/two.ts",
        status: "in_progress",
      },
      members: [
        {
          type: "block",
          id: "src/one",
          kind: "tool",
          author: "codex",
          title: "Read · src/one.ts · 1 line",
          status: "completed",
          content: [{ type: "output", lines: ["src/one output"] }],
        },
        {
          type: "block",
          id: "src/two",
          kind: "tool",
          author: "codex",
          title: "Read · src/two.ts · 1 line",
          status: "in_progress",
          content: [{ type: "output", lines: ["src/two output"] }],
        },
      ],
    });
  });

  test("groups consecutive reads in the session transcript and preserves boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-tool-groups-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const appendTool = (
        toolCallId: string,
        kind: "read" | "search" | "execute",
        status: "completed" | "failed" = "completed",
        effect?: "read",
      ) => session.appendEvent({
        source: { type: "harness" as const, harnessTargetId: "codex" },
        kind: "tool_call_update" as const,
        harness: "codex",
        harnessTargetId: "codex",
        turnId: "t1",
        payload: {
          toolCallId,
          title: `${kind[0]!.toUpperCase()}${kind.slice(1)}: ${toolCallId}`,
          kind,
          ...(effect !== undefined ? { effect } : {}),
          status,
          rawInput: kind === "execute"
            ? { command: toolCallId }
            : kind === "search"
              ? { pattern: toolCallId }
              : { file_path: `${toolCallId}.ts` },
          content: [{ type: "text" as const, text: "result\n" }],
        },
      });
      appendTool("one", "read");
      appendTool("two", "read");
      appendTool("bad", "read", "failed");
      appendTool("three", "read");
      appendTool("query", "search");
      appendTool("status", "execute");
      appendTool("probe1", "execute", "completed", "read");
      appendTool("probe2", "execute", "completed", "read");

      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );
      expect(protocol.stateStore.getState("timeline").items).toMatchObject([
        {
          type: "group",
          id: "group:one",
          collapsedByDefault: true,
          summary: { title: "Read ×2 · two.ts" },
          members: [{ id: "one" }, { id: "two" }],
        },
        {
          type: "group",
          id: "group:bad",
          members: [{ id: "bad", status: "failed" }],
        },
        {
          type: "group",
          id: "group:three",
          collapsedByDefault: true,
          summary: { title: "Read · three.ts · 1 line" },
          members: [{ id: "three" }],
        },
        {
          type: "group",
          id: "group:query",
          collapsedByDefault: true,
          summary: { title: "Search · query · 1 line" },
          members: [{ id: "query" }],
        },
        {
          type: "group",
          id: "group:status",
          members: [{ id: "status", title: "Ran · status · 1 line" }],
        },
        {
          type: "group",
          id: "group:probe1",
          collapsedByDefault: true,
          summary: { title: "Ran ×2 · probe2" },
          members: [{ id: "probe1" }, { id: "probe2" }],
        },
      ]);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps thought and read in separate adjacent block groups", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-compact-blocks-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const appendThought = (messageId: string, title: string) => session.appendEvent({
        source: { type: "harness" as const, harnessTargetId: "codex" },
        kind: "agent_thought" as const,
        harness: "codex",
        harnessTargetId: "codex",
        turnId: "t1",
        payload: {
          messageId,
          content: [{ type: "text" as const, text: `**${title}**` }],
        },
      });
      const appendRead = (toolCallId: string) => session.appendEvent({
        source: { type: "harness" as const, harnessTargetId: "codex" },
        kind: "tool_call_update" as const,
        harness: "codex",
        harnessTargetId: "codex",
        turnId: "t1",
        payload: {
          toolCallId,
          title: `Read: ${toolCallId}`,
          kind: "read",
          effect: "read" as const,
          status: "completed" as const,
          rawInput: { file_path: `${toolCallId}.ts` },
          content: [{ type: "text" as const, text: "result\n" }],
        },
      });

      appendThought("thought-1", "Inspecting files");
      appendThought("thought-2", "Planning reads");
      appendRead("read-1");
      appendRead("read-2");
      appendThought("thought-3", "Planning write");

      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );
      expect(protocol.stateStore.getState("timeline").items).toMatchObject([
        {
          type: "group",
          id: "group:thought-1:0",
          collapsedByDefault: true,
          summary: { kind: "thought", title: "Thought ×2 · Planning reads" },
          members: [{ title: "Inspecting files" }, { title: "Planning reads" }],
        },
        {
          type: "group",
          id: "group:read-1",
          collapsedByDefault: true,
          summary: { kind: "tool", title: "Read ×2 · read-2.ts" },
          members: [{ id: "read-1" }, { id: "read-2" }],
        },
        {
          type: "group",
          id: "group:thought-3:0",
          collapsedByDefault: true,
          summary: { kind: "thought", title: "Planning write" },
          members: [{ id: "thought-3:0", title: "Planning write" }],
        },
      ]);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// 启动时的 resume/fork 会话选择已移到 session picker（src/view/chat-tui/session-picker.tsx，
// 不经过 BatonChatProtocol）；/sessions 的会话内切换浮层仍由 protocol 承载。

describe("BatonChatProtocol sessions picker", () => {
  test("only shows sessions from the current project", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-project-sessions-"));
    try {
      const store = new SessionStore(root);
      const current = store.createSession({ cwd: "/repo" });
      const sibling = store.createSession({ cwd: "/repo" });
      const other = store.createSession({ cwd: "/other" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session: current, resumed: false }, () => undefined);

      await protocol.command("sessions", "");

      const values = protocol.stateStore.getState("composer").picker?.options.map((option) => option.value) ?? [];
      expect(values).toHaveLength(2);
      expect(values).toContain(current.id);
      expect(values).toContain(sibling.id);
      expect(values).not.toContain(other.id);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replaces the Channel-local compatibility Plugin Manager when switching sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-plugin-session-"));
    try {
      const store = new SessionStore(root);
      const current = store.createSession({ cwd: "/repo" });
      const sibling = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session: current, resumed: false },
        () => undefined,
      );
      const previous = protocol.pluginManager;
      const internals = protocol as unknown as {
        switchSession(
          open: () => { session: typeof sibling },
        ): Promise<void>;
      };

      await internals.switchSession(() => {
        sibling.acquireLock();
        return { session: sibling };
      });

      expect(protocol.pluginManager).not.toBe(previous);
      await expect(previous.start()).rejects.toThrow("plugin Manager is closed");
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runStatusLabel", () => {
  const base = { activeTurns: new Map(), toolCalls: new Map(), lastError: undefined, lastSeq: 5 };
  const withPhase = (turnId: string, phase: { phase: string; title?: string }) => ({
    ...base,
    activeTurns: new Map([[turnId, { turnId, state: "running" as const, phase }]]),
  });

  test("defaults to thinking", () => {
    expect(runStatusLabel(base)).toBe("thinking…");
  });

  test("phase overrides thinking; title wins over generic phase text", () => {
    expect(runStatusLabel(withPhase("t1", { phase: "compacting", title: "Compacting context…" }), "t1")).toBe(
      "Compacting context…",
    );
    expect(runStatusLabel(withPhase("t1", { phase: "warming" }), "t1")).toBe("warming…");
  });

  test("shows the current tool activity instead of generic thinking", () => {
    const toolCalls = new Map([
      [
        "tc1",
        {
          toolCallId: "tc1",
          turnId: "t1",
          title: "Read: /repo/src/main.ts",
          kind: "read",
          status: "in_progress",
          content: [],
          locations: [],
        },
      ],
    ]);
    expect(runStatusLabel({ ...base, toolCalls }, "t1")).toBe("reading…");
    expect(runStatusLabel({ ...base, toolCalls }, "t2")).toBe("thinking…");
    toolCalls.get("tc1")!.status = "completed";
    expect(runStatusLabel({ ...base, toolCalls }, "t1")).toBe("thinking…");
  });

  test("phase is per-turn: another turn's phase does not leak", () => {
    const state = withPhase("t1", { phase: "compacting" });
    expect(runStatusLabel(state, "t2")).toBe("thinking…");
    // turnId 缺省时退化为任一带 phase 的 turn
    expect(runStatusLabel(state)).toBe("compacting…");
  });

  test("willRetry shows retrying only while the error is the latest event", () => {
    const err = { message: "boom", willRetry: true, seq: 5 };
    expect(runStatusLabel({ ...base, lastError: err })).toBe("retrying…");
    // 其后有任何事件（lastSeq 前进）即视为已恢复
    expect(runStatusLabel({ ...base, lastError: err, lastSeq: 6 })).toBe("thinking…");
  });
});

describe("interaction eventization: pending projects from the event stream", () => {
  const APPROVAL_OPTIONS = [
    { optionId: "allow", name: "Allow", polarity: "allow" as const, lifetime: "once" as const },
    { optionId: "deny", name: "Deny", polarity: "reject" as const, lifetime: "once" as const },
  ];

  test("approval card follows Interaction requested/terminal events; stale answer is a hint, not a crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-interaction-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      // 事件流是 pending 交互的唯一真相源：requested 落盘即出卡片，id = interactionId
      session.appendEvent({
        source: { type: "baton" },
        kind: "interaction.requested",
        harness: "claude-code",
        turnId: "t1",
        payload: {
          kind: "permission",
          interactionId: "ix_1",
          requester: { type: "harness", harnessTargetId: "claude-code" },
          title: "Write file?",
          description: "/repo/output.txt",
          options: APPROVAL_OPTIONS,
        },
      });
      let composer = protocol.stateStore.getState("composer");
      expect(composer.interactions?.[0]).toMatchObject({
        id: "ix_1",
        kind: "approval",
        blocking: true,
        requester: "claude",
        cancelResponse: { kind: "cancelled" },
        approval: {
          title: "Write file?",
          description: "/repo/output.txt",
        },
      });

      // 无 live continuation（如崩溃残留）：应答提示 stale，不静默吞掉
      await protocol.resolveInteraction("ix_1", { kind: "approval", optionId: "allow" });
      composer = protocol.stateStore.getState("composer");
      expect(composer.interactions).toHaveLength(1); // 卡片消失只由 terminal 事件驱动
      expect(protocol.stateStore.getState("footer").toast?.text).toContain("no longer pending");

      // cancelled 落盘 → 卡片消失
      session.appendEvent({
        source: { type: "baton" },
        kind: "interaction.cancelled",
        harness: "baton",
        payload: {
          interactionId: "ix_1",
          reason: "recovery",
        },
      });
      expect(protocol.stateStore.getState("composer").interactions).toEqual([]);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("question card follows Interaction requested/terminal events", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-question-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      session.appendEvent({
        source: { type: "baton" },
        kind: "interaction.requested",
        harness: "codex",
        turnId: "t1",
        payload: {
          kind: "question",
          interactionId: "ix_2",
          requester: { type: "harness", harnessTargetId: "codex" },
          questions: [{ questionId: "q1", header: "Scope", question: "Which scope?" }],
        },
      });
      expect(protocol.stateStore.getState("composer").interactions?.[0]).toMatchObject({
        id: "ix_2",
        kind: "question",
        blocking: true,
        requester: "codex",
        cancelResponse: { kind: "cancelled" },
      });
      let result: unknown;
      const internals = protocol as unknown as {
        controller: {
          completeInteraction(id: string, value: unknown): boolean;
        };
      };
      internals.controller.completeInteraction = (_id, value) => {
        result = value;
        return true;
      };
      await protocol.resolveInteraction("ix_2", { kind: "cancelled" });
      expect(result).toEqual({
        kind: "cancelled",
        reason: "user",
      });
      await protocol.resolveInteraction("ix_2", {
        kind: "question",
        answers: { q1: ["repository"] },
      });
      expect(result).toEqual({
        kind: "question",
        outcome: "answered",
        answers: { q1: ["repository"] },
      });

      session.appendEvent({
        source: { type: "baton" },
        kind: "interaction.cancelled",
        harness: "baton",
        payload: {
          interactionId: "ix_2",
          reason: "recovery",
        },
      });
      expect(protocol.stateStore.getState("composer").interactions).toEqual([]);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Plugin question routes stable choice value through Plugin Manager", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-plugin-question-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );
      session.appendEvent({
        source: {
          type: "plugin",
          pluginInstanceId: "reqloop_default",
        },
        kind: "interaction.requested",
        payload: {
          kind: "question",
          interactionId: "ix_plugin",
          requester: {
            type: "plugin",
            pluginInstanceId: "reqloop_default",
          },
          pluginContext: { executionId: "pex_plugin", verb: "ask" },
          questions: [
            {
              questionId: "decision",
              header: "Associate pull request",
              question: "Choose a requirement",
              choices: [
                {
                  value: "req_1",
                  label: "REQ-1",
                  description: "First requirement",
                },
                {
                  value: "reject",
                  label: "Do not associate",
                  description: "",
                  role: "reject",
                },
              ],
            },
          ],
        },
      });
      expect(protocol.stateStore.getState("composer").interactions?.[0]).toMatchObject({
        id: "ix_plugin",
        kind: "question",
        requester: "reqloop_default",
        cancelResponse: {
          kind: "question",
          answers: { decision: ["Do not associate"] },
        },
        question: {
          questions: [
            {
              options: [
                {
                  label: "REQ-1",
                  description: "First requirement",
                },
                {
                  label: "Do not associate",
                  description: "",
                },
              ],
            },
          ],
        },
      });

      let result: unknown;
      const internals = protocol as unknown as {
        controller: { completeInteraction(): boolean };
        plugins: {
          completeInteraction(id: string, value: unknown): Promise<boolean>;
        };
      };
      internals.controller.completeInteraction = () => {
        throw new Error("Plugin Interaction must not route to Harness");
      };
      internals.plugins.completeInteraction = async (_id, value) => {
        result = value;
        return true;
      };
      await protocol.resolveInteraction("ix_plugin", {
        kind: "question",
        answers: { decision: ["Do not associate"] },
      });
      expect(result).toEqual({
        kind: "question",
        outcome: "answered",
        answers: { decision: ["reject"] },
      });
      await protocol.resolveInteraction("ix_plugin", {
        kind: "question",
        answers: { decision: ["REQ-1"] },
      });
      expect(result).toEqual({
        kind: "question",
        outcome: "answered",
        answers: { decision: ["req_1"] },
      });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hook trust Interaction uses the approval primitive but keeps its own answer kind", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-hook-trust-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      session.appendEvent({
        source: { type: "baton" },
        kind: "interaction.requested",
        harness: "codex",
        turnId: "t1",
        payload: {
          kind: "hook_trust",
          interactionId: "ix_3",
          requester: { type: "harness", harnessTargetId: "codex" },
          harnessName: "Codex",
          hooks: [
            {
              key: "hook1",
              source: "plugin",
              sourcePath: "/plugins/devloop/hooks.json",
              trustStatus: "modified",
              command: "python hook.py",
              pluginId: "devloop@devloop",
            },
          ],
        },
      });
      expect(protocol.stateStore.getState("composer").interactions?.[0]).toMatchObject({
        id: "ix_3",
        kind: "approval",
        blocking: true,
        requester: "codex",
        cancelResponse: { kind: "approval", optionId: "skip" },
        approval: {
          title: "Trust 1 Codex hook?",
          options: [{ optionId: "trust" }, { optionId: "skip" }],
        },
      });
      let result: unknown;
      const internals = protocol as unknown as {
        controller: {
          completeInteraction(id: string, value: unknown): boolean;
        };
      };
      internals.controller.completeInteraction = (_id, value) => {
        result = value;
        return true;
      };
      await protocol.resolveInteraction("ix_3", { kind: "approval", optionId: "trust" });
      expect(result).toEqual({ kind: "hook_trust", outcome: "trusted" });
      session.appendEvent({
        source: { type: "baton" },
        kind: "interaction.cancelled",
        harness: "baton",
        payload: {
          interactionId: "ix_3",
          reason: "recovery",
        },
      });
      expect(protocol.stateStore.getState("composer").interactions).toEqual([]);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Plugin draft projection", () => {
  test("a suggested-input Interaction stays editable before invocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-harness-invocation-input-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );
      let submitted: unknown;
      const internals = protocol as unknown as {
        plugins: {
          completeInteraction(
            id: string,
            result: InteractionResult,
          ): Promise<boolean>;
        };
      };
      internals.plugins.completeInteraction = async (id, result) => {
        submitted = { id, result };
        if (result.kind === "cancelled") {
          session.appendEvent({
            kind: "interaction.cancelled",
            source: { type: "user" },
            payload: { interactionId: id, reason: result.reason },
          });
        } else {
          session.appendEvent({
            kind: "interaction.answered",
            source: { type: "user" },
            payload: { interactionId: id, answer: result },
          });
        }
        return true;
      };
      session.appendEvent({
        kind: "interaction.requested",
        source: {
          type: "plugin",
          pluginInstanceId: "reqloop_default",
        },
        payload: {
          interactionId: "ix_edit",
          kind: "suggested_input",
          requester: {
            type: "plugin",
            pluginInstanceId: "reqloop_default",
          },
          pluginContext: { executionId: "pex_edit", verb: "draft" },
          title: "Handle review",
          text: "Handle every review comment.",
          harnessTargetId: "codex",
        },
      });
      expect(protocol.stateStore.getState("composer").interactions).toMatchObject([{
        id: "ix_edit",
        kind: "suggested_input",
        title: "Handle review · Target codex",
        text: "Handle every review comment.",
      }]);

      await protocol.resolveInteraction("ix_edit", {
        kind: "suggested_input",
        outcome: "submitted",
        text: "Handle only the valid review comments.",
      });
      expect(submitted).toEqual({
        id: "ix_edit",
        result: {
          kind: "suggested_input",
          outcome: "submitted",
          blocks: [{
            type: "text",
            text: "Handle only the valid review comments.",
          }],
        },
      });
      expect(session.meta.preview).toBe("Handle only the valid review comments.");
      expect(protocol.stateStore.getState("composer").interactions).toEqual([]);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a manual Harness gate uses approval and keeps its answer kind", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-harness-gate-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );
      let completed: unknown;
      const internals = protocol as unknown as {
        plugins: {
          completeInteraction(
            id: string,
            result: InteractionResult,
          ): Promise<boolean>;
        };
      };
      internals.plugins.completeInteraction = async (id, result) => {
        completed = { id, result };
        return true;
      };
      session.appendEvent({
        kind: "interaction.requested",
        source: {
          type: "plugin",
          pluginInstanceId: "reqloop_default",
        },
        payload: {
          interactionId: "ix_run",
          kind: "harness_invocation",
          requester: {
            type: "plugin",
            pluginInstanceId: "reqloop_default",
          },
          pluginContext: { executionId: "pex_run", verb: "harness" },
          title: "Implement",
          prompt: "Implement req_1.",
          laneId: "main",
          newLane: false,
        },
      });
      expect(protocol.stateStore.getState("composer").interactions).toMatchObject([{
        id: "ix_run",
        kind: "approval",
        blocking: true,
        cancelResponse: { kind: "cancelled" },
        approval: {
          title: "Implement",
          description: "Implement req_1.",
          options: [
            { optionId: "approve" },
            { optionId: "decline" },
          ],
        },
      }]);

      await protocol.resolveInteraction("ix_run", {
        kind: "approval",
        optionId: "approve",
      });
      expect(completed).toEqual({
        id: "ix_run",
        result: { kind: "harness_invocation", outcome: "approved" },
      });
      await protocol.resolveInteraction("ix_run", {
        kind: "approval",
        optionId: "decline",
      });
      expect(completed).toEqual({
        id: "ix_run",
        result: { kind: "harness_invocation", outcome: "declined" },
      });
      await protocol.resolveInteraction("ix_run", { kind: "cancelled" });
      expect(completed).toEqual({
        id: "ix_run",
        result: { kind: "cancelled", reason: "user" },
      });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol steer submit", () => {
  function protocolWith(root: string) {
    const store = new SessionStore(root);
    const session = store.createSession({ cwd: "/repo" });
    return new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
  }

  test("busy + steerable: Enter steers instead of queueing", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-steer-"));
    try {
      const protocol = protocolWith(root);
      const calls: string[] = [];
      const internals = protocol as unknown as {
        controller: {
          sendTurn: (harness: string, blocks: unknown) => Promise<{ effective: "steer" }>;
        };
      };
      internals.controller.sendTurn = async () => {
        calls.push("sendTurn");
        return { effective: "steer" };
      };

      await protocol.submit("prefer approach B");
      expect(calls).toEqual(["sendTurn"]);
      expect(protocol.stateStore.getState("footer").toast?.text).toContain("queued for the current turn");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejected steer degrades honestly: toast says follow-up, not steer", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-steer-degrade-"));
    try {
      const protocol = protocolWith(root);
      const internals = protocol as unknown as {
        controller: {
          sendTurn: () => Promise<{
            effective: "new_turn";
            queued: true;
            reason: string;
            outcome: Promise<string>;
          }>;
        };
      };
      let resolveOutcome: ((value: string) => void) | undefined;
      const outcome = new Promise<string>((resolve) => {
        resolveOutcome = resolve;
      });
      internals.controller.sendTurn = async () => ({
        effective: "new_turn",
        queued: true,
        reason: "provider rejected",
        outcome,
      });

      const submitted = protocol.submit("prefer approach B");
      await Bun.sleep(1); // 让 protocol 走到降级状态提示、停在等待 outcome 处
      const degraded = protocol.stateStore.getState("footer").toast?.text;
      expect(degraded).toContain("queued as follow-up");
      expect(degraded).not.toContain("steering");
      resolveOutcome?.("completed");
      await submitted;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("queued follow-ups suppress steer: order intent wins over injection", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-steer-queue-"));
    try {
      const protocol = protocolWith(root);
      const calls: string[] = [];
      const internals = protocol as unknown as {
        controller: {
          sendTurn: () => Promise<{
            effective: "new_turn";
            queued: true;
            outcome: Promise<"completed">;
          }>;
        };
      };
      internals.controller.sendTurn = async () => {
        calls.push("sendTurn");
        return { effective: "new_turn", queued: true, outcome: Promise.resolve("completed") };
      };

      await protocol.submit("after those");
      expect(calls).toEqual(["sendTurn"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol clipboard image", () => {
  test("archives the image and submits an image prompt block to the active Harness", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-clipboard-image-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      let submitted: unknown;
      const internals = protocol as unknown as {
        controller: {
          promptCapabilities: () => { image: { supported: true } };
          sendTurn: (target: string, blocks: unknown) => Promise<{
            effective: "new_turn";
            queued: false;
            outcome: Promise<"completed">;
          }>;
        };
      };
      internals.controller.promptCapabilities = () => ({ image: { supported: true } });
      internals.controller.sendTurn = async (_target, blocks) => {
        submitted = blocks;
        return { effective: "new_turn", queued: false, outcome: Promise.resolve("completed") };
      };

      const token = await protocol.prepareClipboardPaste({
        type: "image",
        mimeType: "image/png",
        data: Uint8Array.from([137, 80, 78, 71]),
      });
      expect(token).toBe("[Image #1] ");
      await protocol.submit(`inspect ${token}`);

      expect(submitted).toEqual([
        { type: "text", text: "inspect " },
        {
          type: "image",
          mimeType: "image/png",
          path: expect.stringMatching(/\/attachments\/clipboard-[a-f0-9]{24}\.png$/),
        },
        { type: "text", text: " " },
      ]);

      const recalled = protocol.historyPrev("");
      expect(recalled).toEqual({ text: "inspect [Image #1]" });
      await protocol.submit(recalled!.text);
      expect(submitted).toEqual([
        { type: "text", text: "inspect " },
        {
          type: "image",
          mimeType: "image/png",
          path: expect.stringMatching(/\/attachments\/clipboard-[a-f0-9]{24}\.png$/),
        },
      ]);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol input history", () => {
  function makeProtocol(prefix: string) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const store = new SessionStore(root);
    const session = store.createSession({ cwd: "/repo" });
    const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
    stubCompletedSend(protocol);
    return { root, store, session, protocol };
  }

  test("↑ walks newest→oldest and stops at the oldest; ↓ returns then restores empty draft", async () => {
    const { root, protocol } = makeProtocol("baton-hist-walk-");
    try {
      await protocol.submit("first");
      await protocol.submit("second");
      await protocol.submit("third");
      expect(protocol.historyPrev("")).toEqual({ text: "third" });
      expect(protocol.historyPrev("third")).toEqual({ text: "second" });
      expect(protocol.historyPrev("second")).toEqual({ text: "first" });
      expect(protocol.historyPrev("first")).toBeNull(); // 已到最旧，停住
      expect(protocol.historyNext("first")).toEqual({ text: "second" });
      expect(protocol.historyNext("second")).toEqual({ text: "third" });
      expect(protocol.historyNext("third")).toEqual({ text: "" }); // 越过最新 → 恢复空草稿
      expect(protocol.historyNext("")).toBeNull(); // 未在浏览
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("editing a recalled entry stops navigation (null → cursor move)", async () => {
    const { root, protocol } = makeProtocol("baton-hist-edit-");
    try {
      await protocol.submit("a");
      await protocol.submit("b");
      expect(protocol.historyPrev("")).toEqual({ text: "b" });
      expect(protocol.historyPrev("b-edited")).toBeNull();
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stash restores a half-typed draft when ↓ passes the newest entry", async () => {
    const { root, protocol } = makeProtocol("baton-hist-stash-");
    try {
      await protocol.submit("one");
      expect(protocol.historyPrev("typed draft")).toEqual({ text: "one" });
      expect(protocol.historyNext("one")).toEqual({ text: "typed draft" });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("adjacent duplicate submissions collapse into one entry", async () => {
    const { root, protocol } = makeProtocol("baton-hist-dedup-");
    try {
      await protocol.submit("same");
      await protocol.submit("same");
      await protocol.submit("other");
      expect(protocol.historyPrev("")).toEqual({ text: "other" });
      expect(protocol.historyPrev("other")).toEqual({ text: "same" });
      expect(protocol.historyPrev("same")).toBeNull(); // 只有一条 "same"
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("seeds history from a resumed session's persisted user messages", () => {
    const root = mkdtempSync(join(tmpdir(), "baton-hist-seed-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.appendEvent({
        source: { type: "baton" },
        kind: "user_message",
        harness: "claude-code",
        turnId: "t_1",
        payload: { messageId: "m_1", content: [{ type: "text", text: "seeded one" }] },
      });
      session.appendEvent({
        source: { type: "baton" },
        kind: "user_message",
        harness: "claude-code",
        turnId: "t_2",
        payload: { messageId: "m_2", content: [{ type: "text", text: "seeded two" }] },
      });
      session.appendEvent({
        source: { type: "plugin", pluginInstanceId: "reqloop_default" },
        kind: "user_message",
        harness: "claude-code",
        turnId: "t_plugin",
        payload: {
          messageId: "m_plugin",
          content: [{ type: "text", text: "plugin prompt" }],
        },
      });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      expect(protocol.historyPrev("")).toEqual({ text: "seeded two" });
      expect(protocol.historyPrev("seeded two")).toEqual({ text: "seeded one" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
