import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configPath,
  DEFAULT_CONFIG,
  ensureConfigFile,
  loadConfig,
  targetEnvironmentFor,
} from "../src/config/config.ts";
import { resolveClaudeTargetConfig } from "../src/harness/claude/config.ts";
import { resolveCodexTargetConfig } from "../src/harness/codex/config.ts";
import { resolveDshTargetConfig } from "../src/harness/dsh/config.ts";

let root: string;
let savedEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-config-"));
  savedEnv = process.env.BATON_CLAUDE_BIN;
  delete process.env.BATON_CLAUDE_BIN;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.BATON_CLAUDE_BIN;
  else process.env.BATON_CLAUDE_BIN = savedEnv;
});

describe("config", () => {
  test("missing file yields defaults", () => {
    expect(loadConfig(root)).toEqual(DEFAULT_CONFIG);
  });

  test("ensureConfigFile creates defaults once and keeps user edits", () => {
    const path = ensureConfigFile(root);
    expect(path.endsWith("config.yaml")).toBe(true);
    expect(existsSync(path)).toBe(true);
    writeFileSync(path, "defaultTarget: claude\n");
    ensureConfigFile(root);
    expect(loadConfig(root).defaultTarget).toBe("claude");
  });

  test("partial file merges over defaults", () => {
    writeFileSync(configPath(root), "mentionBudgetChars: 8000\n");
    const config = loadConfig(root);
    expect(config.mentionBudgetChars).toBe(8000);
    expect(config.defaultTarget).toBe("codex");
    expect(config.targets.codex).toEqual({
      harness: "codex",
      command: ["codex", "app-server"],
    });
  });

  test("custom HarnessTargets are first-class configuration coordinates", () => {
    writeFileSync(configPath(root), [
      "defaultTarget: dsh-prod",
      "targets:",
      "  dsh-prod:",
      "    harness: dsh",
      "    command: [dsh-jsonrpc-agent, /tmp/cordis.yml]",
      "    provider: deepseek-official",
      "    model: prod",
      "textgenPrefer: dsh-prod",
      "",
    ].join("\n"));
    const config = loadConfig(root);
    expect(config.defaultTarget).toBe("dsh-prod");
    expect(config.textgenPrefer).toBe("dsh-prod");
    expect(resolveDshTargetConfig(config.targets["dsh-prod"]!)).toEqual({
      command: ["dsh-jsonrpc-agent", "/tmp/cordis.yml"],
      provider: "deepseek-official",
      model: "prod",
    });
  });

  test("HarnessTarget env is preserved and strictly validated at the runtime boundary", () => {
    writeFileSync(configPath(root), [
      "targets:",
      "  codex2:",
      "    harness: codex",
      "    env:",
      "      CODEX_HOME: /Users/me/.codex2",
      "",
    ].join("\n"));
    const target = loadConfig(root).targets.codex2!;
    expect(targetEnvironmentFor(target, "codex2")).toEqual({
      CODEX_HOME: "/Users/me/.codex2",
    });

    expect(() => targetEnvironmentFor({ harness: "codex", env: { "BAD-NAME": "x" } }, "bad"))
      .toThrow("invalid variable name");
    expect(() => targetEnvironmentFor(
      { harness: "codex", env: { CODEX_HOME: 2 } as unknown as Record<string, string> },
      "bad",
    )).toThrow("CODEX_HOME must be a string");
  });

  test("Harness-specific modules own defaults and validation", () => {
    writeFileSync(
      configPath(root),
      [
        "targets:",
        "  codex:",
        "    harness: codex",
        "    command: []",
        "    approvalReviewer: nope",
        "  dsh:",
        "    harness: dsh",
        "    command: []",
        "    provider: ''",
        "    model: ''",
        "",
      ].join("\n"),
    );
    const config = loadConfig(root);
    expect(resolveCodexTargetConfig(config.targets.codex!)).toEqual({
      command: ["codex", "app-server"],
    });
    expect(resolveDshTargetConfig(config.targets.dsh!)).toEqual({
      model: "prod",
    });
  });

  test("textgen model overrides require a non-empty string map", () => {
    writeFileSync(configPath(root), "textgenModels:\n  codex: gpt-small\n  claude: haiku\n");
    expect(loadConfig(root).textgenModels).toEqual({ codex: "gpt-small", claude: "haiku" });

    writeFileSync(configPath(root), "textgenModels: [haiku]\n");
    expect(loadConfig(root).textgenModels).toBeUndefined();
    writeFileSync(configPath(root), 'textgenModels: { claude: "" }\n');
    expect(loadConfig(root).textgenModels).toBeUndefined();
  });

  test("invalid values fall back to defaults", () => {
    writeFileSync(configPath(root), "defaultTarget: missing\nmentionBudgetChars: -1\nlogLevel: noisy\n");
    const config = loadConfig(root);
    expect(config.defaultTarget).toBe("codex");
    expect(config.mentionBudgetChars).toBe(DEFAULT_CONFIG.mentionBudgetChars);
    expect(config.logLevel).toBe("info");
  });

  test("corrupt yaml falls back to defaults instead of throwing", () => {
    writeFileSync(configPath(root), "[not: yaml");
    expect(loadConfig(root)).toEqual(DEFAULT_CONFIG);
  });

  test("env BATON_CLAUDE_BIN overrides file", () => {
    writeFileSync(
      configPath(root),
      "targets:\n  claude:\n    harness: claude\n    executable: /from/file\n",
    );
    process.env.BATON_CLAUDE_BIN = "/from/env";
    const config = loadConfig(root);
    expect(resolveClaudeTargetConfig(config.targets.claude!)).toEqual({ executable: "/from/env" });
  });

  test("Codex Target approvalReviewer accepts known values only", () => {
    writeFileSync(configPath(root), "targets:\n  codex:\n    harness: codex\n    approvalReviewer: auto_review\n");
    let config = loadConfig(root);
    expect(resolveCodexTargetConfig(config.targets.codex!).approvalReviewer).toBe("auto_review");
    writeFileSync(configPath(root), "targets:\n  codex:\n    harness: codex\n    approvalReviewer: user\n");
    config = loadConfig(root);
    expect(resolveCodexTargetConfig(config.targets.codex!).approvalReviewer).toBe("user");
  });

  // 缺省不下发 = 跟随 codex 自己的解析（config.toml / profile / 企业 requirements 照常
  // 生效，codex 自身默认就是 user）。baton 不替 codex 定审批的安全默认。
  test("an absent or unknown reviewer stays unset — codex decides for itself", () => {
    writeFileSync(configPath(root), "defaultTarget: codex\n");
    let config = loadConfig(root);
    expect(resolveCodexTargetConfig(config.targets.codex!).approvalReviewer).toBeUndefined();
    writeFileSync(configPath(root), "targets:\n  codex:\n    harness: codex\n    approvalReviewer: yolo\n");
    config = loadConfig(root);
    expect(resolveCodexTargetConfig(config.targets.codex!).approvalReviewer).toBeUndefined();
  });

  // config 不再推导生效值：它曾复刻 codex 的方言解析来喂 footer，但那必然算错——
  // 企业 requirements 能覆盖用户配置和启动参数。生效值只认 codex 回吐（approvalRoute）。
  test("config does not second-guess the effective reviewer from the Codex command", () => {
    writeFileSync(
      configPath(root),
      'targets:\n  codex:\n    harness: codex\n    approvalReviewer: user\n    command: [codex, -c, \'approvals_reviewer="auto_review"\', app-server]\n',
    );
    const config = loadConfig(root);
    expect(resolveCodexTargetConfig(config.targets.codex!).approvalReviewer).toBe("user");
  });

  test("legacy flat Harness fields are ignored", () => {
    writeFileSync(configPath(root), "defaultAgent: claude\ndshModel: legacy\n");
    expect(loadConfig(root)).toEqual(DEFAULT_CONFIG);
  });

  test("notifications accept a boolean shorthand or an object", () => {
    writeFileSync(configPath(root), "notifications: false\n");
    expect(loadConfig(root).notifications).toEqual({ enabled: false, bell: false });

    writeFileSync(configPath(root), "notifications: true\n");
    expect(loadConfig(root).notifications).toEqual({ enabled: true, bell: false });

    writeFileSync(configPath(root), "notifications:\n  enabled: true\n  bell: true\n");
    expect(loadConfig(root).notifications).toEqual({ enabled: true, bell: true });

    writeFileSync(configPath(root), "notifications:\n  bell: true\n");
    expect(loadConfig(root).notifications).toEqual({ enabled: true, bell: true });

    writeFileSync(configPath(root), "notifications: noisy\n");
    expect(loadConfig(root).notifications).toEqual(DEFAULT_CONFIG.notifications);
  });

  test("invalid Target ids are ignored", () => {
    writeFileSync(
      configPath(root),
      "defaultTarget: bad:target\ntargets:\n  bad:target:\n    harness: dsh\n",
    );
    expect(loadConfig(root)).toEqual(DEFAULT_CONFIG);
  });
});
