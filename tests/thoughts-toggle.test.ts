// /thoughts：运行时切换当前 TUI 的 showThoughts，立即重投影 timeline；
// 会话级开关，不写回 config.yaml（toast 注明仅本次会话生效）。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import { SessionStore } from "../src/store/store.ts";
import { BatonChatProtocol } from "../src/view/chat-tui/protocol/index.ts";

describe("/thoughts runtime toggle", () => {
  test("toggles timeline.showThoughts immediately and reports session scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-thoughts-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );

      expect(protocol.stateStore.getState("timeline").showThoughts).toBe(true);

      await protocol.command("thoughts", "");
      await Bun.sleep(0);
      expect(protocol.stateStore.getState("timeline").showThoughts).toBe(false);
      expect(protocol.stateStore.getState("footer").toast?.text).toBe(
        "Thoughts hidden (this session only; set showThoughts in config.yaml to persist)",
      );

      await protocol.command("thoughts", "");
      await Bun.sleep(0);
      expect(protocol.stateStore.getState("timeline").showThoughts).toBe(true);
      expect(protocol.stateStore.getState("footer").toast?.text).toContain("Thoughts shown");

      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("starts from the configured showThoughts value", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-thoughts-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(
        store,
        { ...DEFAULT_CONFIG, showThoughts: false },
        { session, resumed: false },
        () => undefined,
      );
      expect(protocol.stateStore.getState("timeline").showThoughts).toBe(false);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
