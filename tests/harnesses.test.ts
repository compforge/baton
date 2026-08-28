import type { OpenInteraction } from "../src/harness/adapter.ts";
import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG, targetConfigFor } from "../src/config/config.ts";
import {
  createHarnessAdapter,
  parseHarness,
  HARNESS_REGISTRY,
  HARNESSES,
  harnessDefinitionFor,
  harnessSessionKey,
  harnessShortName,
  configuredHarnessTargets,
  resolveHarnessTarget,
  resolveHarnessTargetSelection,
} from "../src/harness/registry.ts";
import { agentColorFor } from "../src/view/chat-tui/theme.ts";

const openInteraction: OpenInteraction = async (req) =>
  req.kind === "permission"
    ? { kind: "permission", outcome: "selected", optionId: "deny" }
    : { kind: "question", outcome: "answered", answers: {} };

describe("harness registry", () => {
  test("registers the first bundled harnesses and their native session keys", () => {
    expect(HARNESSES).toEqual(["codex", "claude", "dsh"]);
    expect(HARNESS_REGISTRY.find((harness) => harness.id === "codex")?.aliases).toEqual(["cx"]);
    expect(HARNESS_REGISTRY.find((harness) => harness.id === "claude")?.aliases).toEqual(["cc"]);
    expect(HARNESS_REGISTRY.find((harness) => harness.id === "dsh")?.aliases).toEqual(["deepseek"]);
    expect(harnessSessionKey("codex")).toBe("codex");
    expect(harnessSessionKey("claude")).toBe("claude-code");
    expect(harnessSessionKey("dsh")).toBe("deepseek-harness");
  });

  test("constructs adapters without putting harness branches in the TUI or session controller", () => {
    const create = (target: { id: string; harness: "codex" | "claude" | "dsh" }) =>
      createHarnessAdapter(target, {
        openInteraction,
        targetConfig: targetConfigFor(DEFAULT_CONFIG, target.harness),
      });
    expect(create({ id: "codex-a", harness: "codex" }).harness).toBe("codex");
    expect(create({ id: "claude-a", harness: "claude" }).harness).toBe("claude-code");
    expect(create({ id: "dsh-a", harness: "dsh" }).harness).toBe("deepseek-harness");
  });

  test("rejects invalid Target env before constructing an adapter", () => {
    expect(() => createHarnessAdapter(
      { id: "codex2", harness: "codex" },
      {
        openInteraction,
        targetConfig: {
          harness: "codex",
          env: { CODEX_HOME: 2 } as unknown as Record<string, string>,
        },
      },
    )).toThrow("HarnessTarget codex2 env CODEX_HOME must be a string");
  });

  test("lowers validated Target env into the adapter", () => {
    const adapter = createHarnessAdapter(
      { id: "codex2", harness: "codex" },
      {
        openInteraction,
        targetConfig: {
          harness: "codex",
          env: { CODEX_HOME: "/Users/me/.codex2" },
        },
      },
    );
    expect((adapter as unknown as { options: { env?: Record<string, string> } }).options.env)
      .toEqual({ CODEX_HOME: "/Users/me/.codex2" });
  });

  test("resolves configured HarnessTargets and maps Harness aliases to their default Target", () => {
    expect(configuredHarnessTargets(DEFAULT_CONFIG)).toEqual([
      { id: "codex", harness: "codex" },
      { id: "claude", harness: "claude" },
      { id: "dsh", harness: "dsh" },
    ]);
    expect(resolveHarnessTarget(DEFAULT_CONFIG, "codex")).toEqual({ id: "codex", harness: "codex" });
    expect(resolveHarnessTargetSelection(DEFAULT_CONFIG, "cc")).toEqual({ id: "claude", harness: "claude" });
    expect(resolveHarnessTargetSelection(DEFAULT_CONFIG, "deepseek")).toEqual({ id: "dsh", harness: "dsh" });
    expect(resolveHarnessTarget(DEFAULT_CONFIG, "missing")).toBeUndefined();
  });

  test("normalizes canonical id and wire key to one definition (三套命名空间的唯一汇合点)", () => {
    // 用户侧 "claude" 与事件/持久化侧 "claude-code" 归到同一个 definition
    expect(harnessDefinitionFor("claude")).toBe(harnessDefinitionFor("claude-code"));
    expect(harnessDefinitionFor("cc")).toBe(harnessDefinitionFor("claude"));
    expect(harnessDefinitionFor("claude")?.id).toBe("claude");
    expect(harnessDefinitionFor("codex")?.sessionKey).toBe("codex");
    expect(harnessDefinitionFor("deepseek")).toBe(harnessDefinitionFor("deepseek-harness"));
    // harness 是开放扩展点：未知输入不 throw
    expect(harnessDefinitionFor("unknown-agent")).toBeUndefined();
  });

  test("shortName drives both timeline author and color key; unknown passes through", () => {
    expect(harnessShortName("claude-code")).toBe("claude");
    expect(harnessShortName("claude")).toBe("claude");
    expect(harnessShortName("codex")).toBe("codex");
    expect(harnessShortName("deepseek-harness")).toBe("dsh");
    expect(harnessShortName("some-new-agent")).toBe("some-new-agent");
    // 认色从 registry 派生：不再靠注释约定 theme 与 label 两处一致
    for (const definition of HARNESS_REGISTRY) {
      expect(agentColorFor(definition.shortName)).toBe(definition.color);
    }
  });

  test("parseHarness accepts canonical ids and user aliases (wire key 不是用户词汇)", () => {
    expect(parseHarness("claude")).toBe("claude");
    expect(parseHarness(" CODEX ")).toBe("codex");
    expect(parseHarness("cc")).toBe("claude");
    expect(parseHarness("CX")).toBe("codex");
    expect(parseHarness("DeepSeek")).toBe("dsh");
    expect(parseHarness("claude-code")).toBeNull();
    expect(parseHarness("gpt")).toBeNull();
  });
});
