import { describe, expect, test } from "bun:test";

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../src/store/store.ts";

const repoRoot = join(import.meta.dir, "..");

describe("baton version", () => {
  test("reads the product version from VERSION", () => {
    const version = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();
    const result = runCli(["version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(`baton ${version}`);
  });
});

describe("baton sessions", () => {
  test("lists only sessions from the requested project", () => {
    const root = mkdtempSync(join(tmpdir(), "baton-cli-project-sessions-"));
    try {
      const store = new SessionStore(root);
      const current = store.createSession({ cwd: "/repo" });
      const other = store.createSession({ cwd: "/other" });

      const result = Bun.spawnSync(
        [process.execPath, "src/cli/bin.ts", "sessions", "--root", root, "--cwd", "/repo"],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
      );
      const output = result.stdout.toString();

      expect(result.exitCode).toBe(0);
      expect(output).toContain(current.id);
      expect(output).not.toContain(other.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("baton logs", () => {
  test("filters structured session logs by level and Plugin", () => {
    const root = mkdtempSync(join(tmpdir(), "baton-cli-logs-"));
    try {
      const session = new SessionStore(root).createSession({ cwd: "/repo" });
      writeFileSync(join(session.dir, "session.log"), [
        {
          timestamp: "2026-07-29T00:00:00.000Z",
          batonSessionId: session.id,
          level: "info",
          source: "baton",
          component: "session.lifecycle",
          message: "Session created",
        },
        {
          timestamp: "2026-07-29T00:00:01.000Z",
          batonSessionId: session.id,
          level: "warn",
          source: "plugin",
          component: "plugin.compforge/reqloop.forge",
          pluginId: "compforge/reqloop",
          message: "Forge request was rate limited",
        },
      ].map((record) => JSON.stringify(record)).join("\n"));

      const result = runCli([
        "logs",
        session.id,
        "--root",
        root,
        "--level",
        "warn",
        "--plugin",
        "compforge/reqloop",
        "--json",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Forge request was rate limited");
      expect(result.stdout.toString()).not.toContain("Session created");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("baton plugins", () => {
  test("registers a Marketplace and installs a Package", () => {
    const root = mkdtempSync(join(tmpdir(), "baton-cli-plugins-"));
    const marketplace = mkdtempSync(join(tmpdir(), "baton-cli-marketplace-"));
    try {
      mkdirSync(join(marketplace, ".baton-plugin"), { recursive: true });
      writeFileSync(
        join(marketplace, ".baton-plugin", "marketplace.json"),
        JSON.stringify({
          name: "reqloop",
          plugins: [{ pluginId: "qiankun/requirement-loop", source: "./requirement-loop" }],
        }),
      );
      mkdirSync(join(marketplace, "requirement-loop", ".baton-plugin"), {
        recursive: true,
      });
      mkdirSync(join(marketplace, "requirement-loop", "src"), { recursive: true });
      writeFileSync(
        join(marketplace, "requirement-loop", ".baton-plugin", "plugin.json"),
        JSON.stringify({
          manifestVersion: 1,
          pluginId: "qiankun/requirement-loop",
          version: "0.1.0",
          entry: "./src/index.ts",
        }),
      );
      writeFileSync(
        join(marketplace, "requirement-loop", "src", "index.ts"),
        "export default { pluginId: 'qiankun/requirement-loop', version: '0.1.0', activate() {} };\n",
      );

      const added = runCli([
        "plugins",
        "marketplace",
        "add",
        marketplace,
        "--root",
        root,
      ]);
      expect(added.exitCode).toBe(0);
      expect(added.stdout.toString()).toContain("added marketplace reqloop");

      const available = runCli(["plugins", "available", "--root", root]);
      expect(available.exitCode).toBe(0);
      expect(available.stdout.toString()).toContain(
        "qiankun/requirement-loop@reqloop  0.1.0",
      );

      const installed = runCli([
        "plugins",
        "install",
        "qiankun/requirement-loop",
        "--root",
        root,
      ]);
      expect(installed.exitCode).toBe(0);
      expect(installed.stdout.toString()).toContain(
        "installed and enabled qiankun/requirement-loop@reqloop  0.1.0",
      );
      expect(readFileSync(join(root, "plugin.yaml"), "utf8")).toContain(
        "qiankun/requirement-loop@reqloop:",
      );

      const listed = runCli(["plugins", "list", "--root", root]);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout.toString()).toContain(
        "qiankun/requirement-loop@reqloop  0.1.0  enabled",
      );

      const removed = runCli([
        "plugins",
        "marketplace",
        "remove",
        "reqloop",
        "--root",
        root,
      ]);
      expect(removed.exitCode).toBe(0);
      expect(removed.stdout.toString()).toContain("removed marketplace reqloop");

      const marketplaces = runCli(["plugins", "marketplace", "list", "--root", root]);
      expect(marketplaces.exitCode).toBe(0);
      expect(marketplaces.stdout.toString()).toContain("(no marketplaces registered)");

      const installedAfterRemoval = runCli(["plugins", "list", "--root", root]);
      expect(installedAfterRemoval.exitCode).toBe(0);
      expect(installedAfterRemoval.stdout.toString()).toContain(
        "qiankun/requirement-loop@reqloop  0.1.0  enabled",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(marketplace, { recursive: true, force: true });
    }
  });
});

function runCli(args: string[]) {
  return Bun.spawnSync([process.execPath, "src/cli/bin.ts", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
}
