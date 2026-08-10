import { describe, expect, test } from "bun:test";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import { ProposalStore } from "../src/plugin/proposal.ts";
import { PluginResourceStore } from "../src/plugin/resource.ts";
import { sessionDisplayTitle, SessionStore } from "../src/store/store.ts";
import {
  BatonChatProtocol,
  runStatusLabel,
  thoughtDisplayBlocks,
  toolTranscriptItem,
} from "../src/tui/protocol/index.ts";

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
        "controller",
        "plugins",
        "marketplace",
        "lock",
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
      const internals = protocol as unknown as {
        controller: { submit: () => Promise<"completed">; close: () => Promise<void> };
      };
      internals.controller.submit = async () => "completed";

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
      const internals = protocol as unknown as {
        controller: { submit: () => Promise<"completed">; close: () => Promise<void> };
      };
      internals.controller.submit = async () => "completed";

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
      session.append({
        source: { type: "baton" },
        kind: "context_usage_update",
        harness: "codex",
        harnessTargetId: "codex",
        payload: { model: "default", contextUsed: 12_500, contextSize: 200_000 },
      });
      const eventCount = session.readEvents().length;
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      await protocol.command("status", "");
      const status = protocol.stateStore.getState("timeline").items.at(-1);
      expect(status).toMatchObject({
        id: "_baton_status",
        author: "baton",
        text: expect.stringContaining("Context: 12,500 / 200,000 tokens (6%)"),
      });
      expect(session.readEvents()).toHaveLength(eventCount);
      const internals = protocol as unknown as { controller: { submit: () => Promise<"completed"> } };
      internals.controller.submit = async () => "completed";
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
      session.append({
        source: { type: "baton" },
        kind: "context_usage_update",
        harness: "claude-code",
        harnessTargetId: "claude",
        payload: { model: "default", contextUsed: 40_000, contextSize: 200_000 },
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
      expect(session.readEvents()).toHaveLength(0);
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
      session.append({
        source: { type: "harness", harnessTargetId: "claude" },
        harness: "claude-code",
        harnessTargetId: "claude",
        turnId: "t1",
        kind: "proposed_plan",
        payload: { planId: "pl-proposed", content: "# Proposal\n\nReview before implementation." },
      });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      expect(protocol.stateStore.getState("timeline").plan).toBeUndefined();
      expect(protocol.stateStore.getState("timeline").items).toContainEqual({
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
      expect(session.readEvents()).toHaveLength(0);
      await expect(protocol.command("plugins", "extra")).rejects.toThrow("/plugins takes no arguments");
      await protocol.command("reload-plugins", "");
      expect(protocol.stateStore.getState("footer").toast).toEqual({
        text: "Reloaded 0 plugin instances",
        tone: "info",
      });
      await expect(protocol.command("reload-plugins", "extra")).rejects.toThrow(
        "/reload-plugins takes no arguments",
      );
      expect(session.readEvents()).toHaveLength(0);
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
        session.append({
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

      session.append({
        source: { type: "baton" },
        kind: "agent_message_chunk",
        harness: "codex",
        turnId: "t1",
        payload: { messageId: "m_stream", content: { type: "text", text: "latest output" } },
      });
      session.append({
        source: { type: "baton" },
        kind: "interaction.opened",
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
  test("switches the input target and sends a trailing message in one action", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-harness-command-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      const submitted: Array<{ harness: string; text: string }> = [];
      const internals = protocol as unknown as {
        controller: {
          submit: (harness: string, blocks: Array<{ type: string; text?: string }>) => Promise<"completed">;
          compactContext: (harness: string) => Promise<void>;
        };
      };
      internals.controller.submit = async (harness, blocks) => {
        submitted.push({ harness, text: blocks[0]?.text ?? "" });
        return "completed";
      };
      const compacted: string[] = [];
      internals.controller.compactContext = async (harness) => {
        compacted.push(harness);
      };

      await protocol.command("claude", "");
      expect(protocol.stateStore.getState("activity").items?.[0]).toMatchObject({ author: "claude" });

      await protocol.command("codex", "");
      expect(protocol.stateStore.getState("activity").items?.[0]).toMatchObject({ author: "codex" });

      await protocol.submit("/cc review this");
      expect(protocol.stateStore.getState("activity").items?.[0]).toMatchObject({ author: "claude" });
      expect(submitted).toEqual([{ harness: "claude", text: "review this" }]);

      await protocol.submit("/cx fix it");
      expect(submitted.at(-1)).toEqual({ harness: "codex", text: "fix it" });

      await protocol.command("claude", "explain it");
      expect(submitted.at(-1)).toEqual({ harness: "claude", text: "explain it" });

      await protocol.command("codex", "implement it");
      expect(submitted.at(-1)).toEqual({ harness: "codex", text: "implement it" });

      await protocol.command("compact", "");
      expect(compacted).toEqual(["codex"]);
      expect(protocol.stateStore.getState("footer").toast?.text).toBe("codex context compacted");

      await protocol.submit("/c ambiguous");
      expect(submitted).toHaveLength(4);
      expect(protocol.stateStore.getState("timeline").items.at(-1)).toMatchObject({
        id: "_baton_harness_route_error",
        author: "baton",
        text: expect.stringContaining('harness prefix "/c" is ambiguous; matches codex, claude'),
      });
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

      await protocol.command("plan", "");
      expect(mode).toBe("plan");
      expect(protocol.stateStore.getState("footer").toast?.text).toBe("codex mode: Plan");
      expect(protocol.stateStore.getState("activity").items).toHaveLength(1);
      expect(protocol.stateStore.getState("activity").items?.[0]?.label).toBe("default · idle · plan mode");

      await protocol.cycleMode();
      expect(mode).toBe("default");
      expect(protocol.stateStore.getState("footer").toast?.text).toBe("codex mode: Default");
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
          role: "driven" | "observed";
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
      session.append({
        source: { type: "baton" },
        kind: "context_usage_update",
        harness: "codex",
        harnessTargetId: "codex",
        payload: { model: "default", contextUsed: 12_500, contextSize: 200_000 },
      });
      session.append({
        source: { type: "baton" },
        kind: "context_usage_update",
        harness: "codex",
        harnessTargetId: "codex-secondary",
        payload: { model: "default", contextUsed: 150_000, contextSize: 200_000 },
      });
      session.append({
        source: { type: "baton" },
        kind: "context_usage_update",
        harness: "claude-code",
        harnessTargetId: "claude",
        payload: { model: "default", contextUsed: 80_000, contextSize: 200_000 },
      });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      expect(protocol.stateStore.getState("activity").items).toHaveLength(1);
      expect(protocol.stateStore.getState("activity").items?.[0]?.label).toBe("default · idle · context 6%");
      expect(protocol.stateStore.getState("footer").text).not.toContain("context");
      await protocol.command("claude", "");
      expect(protocol.stateStore.getState("activity").items).toHaveLength(1);
      expect(protocol.stateStore.getState("activity").items?.[0]?.label).toBe("default · idle · context 40%");
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
      session.append({
        source: { type: "baton" },
        kind: "context_usage_update",
        harness: "codex",
        harnessTargetId: "codex",
        payload: { model: "gpt-old", contextUsed: 190_000, contextSize: 200_000 },
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
        protocol.stateStore.getState("timeline").items.some((item) => item.type === "block" && item.kind === "plan");

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
      // pin 是"现在时"层：需有回合在运行（observed run 也算）
      internals.state.activeTurns.set("t_obs", {
        turnId: "t_obs",
        harness: "codex",
        harnessTargetId: "codex",
        role: "observed",
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
        role: "observed",
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
        role: "observed",
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
        protocol.stateStore.getState("timeline").items.find((item) => item.type === "block" && item.kind === "plan"),
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
      session.append({
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

  // 委托状态是否可见改由 adapter 报告的生效路由驱动（见 session-controller.test.ts）：
  // 投影不再读 config——config 是意图，且投影层不得按 harness 分支（不变量 #3）。
  test("renders auto-review receipts beside the target tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-auto-review-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.append({
        source: { type: "baton" },
        kind: "tool_call_update",
        harness: "codex",
        turnId: "t1",
        payload: { toolCallId: "tc1", title: "edit src/app.ts", kind: "edit", status: "completed" },
      });
      session.append({
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

      const toolIndex = protocol.stateStore.getState("timeline").items.findIndex((item) => item.id === "tc1");
      // 展示双轴：approved 的 outcome 是 completed（审到底了，不被遮成 warning），
      // 需留痕由正交的 tone 表达（委托代批放行 → 审计痕）
      expect(protocol.stateStore.getState("timeline").items[toolIndex + 1]).toMatchObject({
        id: "approval-review:arv_test1",
        kind: "notice",
        status: "completed",
        tone: "warning",
        title: "Automatic approval review approved (risk: low, authorization: unknown)",
        content: { type: "text", text: "Auto-review returned a low-risk allow decision." },
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
      session.append({
        source: { type: "baton" },
        kind: "user_message",
        harness: "codex",
        turnId: "t1",
        payload: { messageId: "m_user", content: [{ type: "text", text: "## literal" }] },
      });
      session.append({ source: { type: "baton" }, kind: "state_update", harness: "codex", turnId: "t1", payload: { state: "running" } });
      session.append({
        source: { type: "baton" },
        kind: "agent_thought",
        harness: "codex",
        turnId: "t1",
        payload: { messageId: "m_thought", content: [{ type: "text", text: "**Inspecting image**" }] },
      });
      session.append({
        source: { type: "baton" },
        kind: "agent_message_chunk",
        harness: "codex",
        turnId: "t1",
        payload: { messageId: "m_stream", content: { type: "text", text: "## Streaming" } },
      });
      session.append({
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
      expect(protocol.stateStore.getState("timeline").items.find((item) => item.id === "m_thought:0")).toMatchObject({
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

// 启动时的 resume/fork 会话选择已移到 session picker（src/tui/session-picker.tsx，
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

  test("replaces the session-scoped Plugin Manager when switching sessions", async () => {
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
    activeTurns: new Map([[turnId, { turnId, role: "driven" as const, state: "running" as const, phase }]]),
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

  test("approval card follows Interaction opened/resolved events; stale answer is a hint, not a crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-interaction-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      // 事件流是 pending 交互的唯一真相源：opened 落盘即出卡片，id = interactionId
      session.append({
        source: { type: "baton" },
        kind: "interaction.opened",
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

      // 无 live resolver（如崩溃残留）：应答提示 stale，不静默吞掉
      await protocol.resolveInteraction("ix_1", { kind: "approval", optionId: "allow" });
      composer = protocol.stateStore.getState("composer");
      expect(composer.interactions).toHaveLength(1); // 卡片消失只由 resolved 事件驱动
      expect(protocol.stateStore.getState("footer").toast?.text).toContain("no longer pending");

      // resolved 落盘 → 卡片消失
      session.append({
        source: { type: "baton" },
        kind: "interaction.resolved",
        harness: "baton",
        payload: {
          interactionId: "ix_1",
          resolution: { kind: "cancelled", reason: "recovery" },
        },
      });
      expect(protocol.stateStore.getState("composer").interactions).toEqual([]);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("question card follows Interaction opened/resolved events", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-question-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      session.append({
        source: { type: "baton" },
        kind: "interaction.opened",
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
      let resolution: unknown;
      const internals = protocol as unknown as {
        controller: {
          resolveInteraction(id: string, value: unknown): boolean;
        };
      };
      internals.controller.resolveInteraction = (_id, value) => {
        resolution = value;
        return true;
      };
      await protocol.resolveInteraction("ix_2", { kind: "cancelled" });
      expect(resolution).toEqual({
        kind: "cancelled",
        reason: "user",
      });
      await protocol.resolveInteraction("ix_2", {
        kind: "question",
        answers: { q1: ["repository"] },
      });
      expect(resolution).toEqual({
        kind: "question",
        outcome: "answered",
        answers: { q1: ["repository"] },
      });

      session.append({
        source: { type: "baton" },
        kind: "interaction.resolved",
        harness: "baton",
        payload: {
          interactionId: "ix_2",
          resolution: { kind: "cancelled", reason: "recovery" },
        },
      });
      expect(protocol.stateStore.getState("composer").interactions).toEqual([]);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Plugin question routes stable optionId through Plugin Manager", async () => {
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
      session.append({
        source: {
          type: "plugin",
          pluginInstanceId: "reqloop_default",
        },
        kind: "interaction.opened",
        payload: {
          kind: "question",
          interactionId: "ix_plugin",
          requester: {
            type: "plugin",
            pluginInstanceId: "reqloop_default",
          },
          pluginContext: {
            decisionKey: "associate-pr",
            resource: {
              apiVersion: "reqloop.baton.dev/v1alpha1",
              kind: "Requirement",
              namespace: "reqloop_default",
              name: "run_1",
              uid: "pr_resource_uid",
            },
            resourceOwner: "plugin",
          },
          questions: [
            {
              questionId: "decision",
              header: "Associate pull request",
              question: "Choose a requirement",
              options: [
                {
                  optionId: "req_1",
                  label: "REQ-1",
                  description: "First requirement",
                },
                {
                  optionId: "reject",
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

      let resolution: unknown;
      const internals = protocol as unknown as {
        controller: { resolveInteraction(): boolean };
        plugins: {
          resolveInteraction(id: string, value: unknown): Promise<boolean>;
        };
      };
      internals.controller.resolveInteraction = () => {
        throw new Error("Plugin Interaction must not route to Harness");
      };
      internals.plugins.resolveInteraction = async (_id, value) => {
        resolution = value;
        return true;
      };
      await protocol.resolveInteraction("ix_plugin", {
        kind: "question",
        answers: { decision: ["Do not associate"] },
      });
      expect(resolution).toEqual({
        kind: "question",
        outcome: "answered",
        answers: { decision: ["reject"] },
      });
      await protocol.resolveInteraction("ix_plugin", {
        kind: "question",
        answers: { decision: ["REQ-1"] },
      });
      expect(resolution).toEqual({
        kind: "question",
        outcome: "answered",
        answers: { decision: ["req_1"] },
      });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hook trust Interaction uses the approval primitive but keeps its own resolution kind", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-hook-trust-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      session.append({
        source: { type: "baton" },
        kind: "interaction.opened",
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
      let resolution: unknown;
      const internals = protocol as unknown as {
        controller: {
          resolveInteraction(id: string, value: unknown): boolean;
        };
      };
      internals.controller.resolveInteraction = (_id, value) => {
        resolution = value;
        return true;
      };
      await protocol.resolveInteraction("ix_3", { kind: "approval", optionId: "trust" });
      expect(resolution).toEqual({ kind: "hook_trust", outcome: "trusted" });
      session.append({
        source: { type: "baton" },
        kind: "interaction.resolved",
        harness: "baton",
        payload: {
          interactionId: "ix_3",
          resolution: { kind: "cancelled", reason: "recovery" },
        },
      });
      expect(protocol.stateStore.getState("composer").interactions).toEqual([]);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("shows the live Target for an implicit TurnRequest and fixes an explicit one", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-turn-request-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );
      session.append({
        source: { type: "plugin", pluginInstanceId: "reqloop_default" },
        kind: "interaction.opened",
        payload: {
          kind: "permission",
          interactionId: "ix_turn_implicit",
          requester: { type: "plugin", pluginInstanceId: "reqloop_default" },
          turnRequestContext: { turnRequestId: "trq_implicit" },
          title: "Implement requirement",
          description: "Prompt (read-only):\n\nImplement it.",
          options: APPROVAL_OPTIONS,
        },
      });
      expect(
        protocol.stateStore.getState("composer").interactions?.[0],
      ).toMatchObject({
        requester: "reqloop_default",
        approval: { description: expect.stringContaining("Target: codex") },
      });

      await protocol.command("claude", "");
      expect(
        protocol.stateStore.getState("composer").interactions?.[0],
      ).toMatchObject({
        approval: { description: expect.stringContaining("Target: claude") },
      });
      session.append({
        source: { type: "plugin", pluginInstanceId: "reqloop_default" },
        kind: "interaction.opened",
        payload: {
          kind: "permission",
          interactionId: "ix_turn_explicit",
          requester: { type: "plugin", pluginInstanceId: "reqloop_default" },
          turnRequestContext: {
            turnRequestId: "trq_explicit",
            requestedHarnessTargetId: "codex",
          },
          title: "Review requirement",
          options: APPROVAL_OPTIONS,
        },
      });
      expect(
        protocol.stateStore.getState("composer").interactions?.[1],
      ).toMatchObject({
        approval: { description: expect.stringContaining("Target: codex") },
      });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Plugin Proposal projection", () => {
  test("shows proposals in InteractionDock and persists dismiss/submit outcomes", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-plugin-proposal-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const proposals = new ProposalStore({ session });
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );
      const internals = protocol as unknown as { changed(): void };

      const dismissed = proposals.record({
        key: {
          batonSessionId: session.id,
          pluginInstanceId: "reqloop_default",
          resourceApiVersion: "reqloop.baton.dev/v1alpha1",
          resourceKind: "Requirement",
          resourceId: "run_1",
        },
        basedOnGeneration: 1,
        text: "Review the requirement",
      });
      internals.changed();
      expect(protocol.stateStore.getState("composer").interactions).toEqual([
        {
          id: dismissed.proposalId,
          kind: "suggested_input",
          blocking: false,
          requester: "reqloop_default",
          title: "Suggested follow-up",
          text: "Review the requirement",
          cancelResponse: {
            kind: "suggested_input",
            outcome: "dismissed",
          },
        },
      ]);

      await protocol.resolveInteraction(dismissed.proposalId, {
        kind: "suggested_input",
        outcome: "dismissed",
      });
      expect(proposals.get(dismissed.proposalId).resolution?.outcome).toBe("dismissed");
      expect(protocol.stateStore.getState("composer").interactions).toEqual([]);

      const submitted = proposals.record({
        key: {
          batonSessionId: session.id,
          pluginInstanceId: "reqloop_default",
          resourceApiVersion: "reqloop.baton.dev/v1alpha1",
          resourceKind: "Requirement",
          resourceId: "run_2",
        },
        basedOnGeneration: 1,
        text: "Check the implementation",
      });
      internals.changed();
      const submittedInputs: string[] = [];
      protocol.submit = async (text) => {
        submittedInputs.push(text);
      };
      await protocol.resolveInteraction(submitted.proposalId, {
        kind: "suggested_input",
        outcome: "submitted",
        text: "Check the implementation and tests",
      });
      expect(proposals.get(submitted.proposalId).resolution?.outcome).toBe("submitted");
      expect(submittedInputs).toEqual(["Check the implementation and tests"]);
      expect(protocol.stateStore.getState("composer").interactions).toEqual([]);

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
      expect(protocol.stateStore.getState("footer").toast?.text).toContain("steering");
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
    (protocol as unknown as { controller: { submit: () => Promise<"completed"> } }).controller.submit = async () => "completed";
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
      session.append({
        source: { type: "baton" },
        kind: "user_message",
        harness: "claude-code",
        turnId: "t_1",
        payload: { messageId: "m_1", content: [{ type: "text", text: "seeded one" }] },
      });
      session.append({
        source: { type: "baton" },
        kind: "user_message",
        harness: "claude-code",
        turnId: "t_2",
        payload: { messageId: "m_2", content: [{ type: "text", text: "seeded two" }] },
      });
      session.append({
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
