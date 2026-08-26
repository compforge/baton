// Activity tips：投影把 baton 的功能教学语料注入 chat-tui ActivityState.tips；
// 语料是模块级常量，投影只引用同一份数组（轮换/截断由 chat-tui 负责）。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import { SessionStore } from "../src/store/store.ts";
import { BatonChatProtocol } from "../src/view/chat-tui/protocol/index.ts";
import { ACTIVITY_TIPS } from "../src/view/chat-tui/tips.ts";

describe("activity tips projection", () => {
  test("publishes the shared tips corpus on the activity state", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-activity-tips-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(
        store,
        DEFAULT_CONFIG,
        { session, resumed: false },
        () => undefined,
      );

      const activity = protocol.stateStore.getState("activity");
      expect(activity.tips).toBe(ACTIVITY_TIPS);
      expect(activity.tips!.length).toBeGreaterThan(0);
      for (const tip of activity.tips!) {
        expect(tip).not.toContain("\n");
      }

      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
