import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachBatonSession,
  batonDaemonStatus,
  callBatonDaemon,
  detachBatonSession,
  startBatonDaemon,
} from "../src/daemon/client.ts";
import { BatonDaemon } from "../src/daemon/daemon.ts";
import { listenBatonDaemon, type BatonDaemonServer } from "../src/daemon/server.ts";
import { HumanInboxStore } from "../src/inbox/human.ts";
import { MarketplaceRegistry } from "../src/plugin/marketplace/index.ts";
import { PluginSettingsStore } from "../src/plugin/settings.ts";
import { projectDirName, SessionStore } from "../src/store/store.ts";

let daemon: BatonDaemonServer | undefined;

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

describe("Baton Daemon", () => {
  test("drives one project namespace reconcile for Sessions sharing a directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-daemon-"));
    const marketplaceRoot = mkdtempSync(join(tmpdir(), "baton-marketplace-"));
    const cwd = join(root, "workspace");
    const marker = join(root, "reconciled.json");
    const pluginId = "tests/project-controller";
    mkdirSync(join(marketplaceRoot, ".baton-plugin"), { recursive: true });
    mkdirSync(join(marketplaceRoot, "project-controller", ".baton-plugin"), {
      recursive: true,
    });
    mkdirSync(join(marketplaceRoot, "project-controller", "src"), {
      recursive: true,
    });
    writeFileSync(
      join(marketplaceRoot, ".baton-plugin", "marketplace.json"),
      `${JSON.stringify({
        name: "test-project",
        plugins: [{ pluginId, source: "./project-controller" }],
      })}\n`,
    );
    writeFileSync(
      join(
        marketplaceRoot,
        "project-controller",
        ".baton-plugin",
        "plugin.json",
      ),
      `${JSON.stringify({
        manifestVersion: 1,
        pluginId,
        version: "1.0.0",
        entry: "./src/index.ts",
      })}\n`,
    );
    writeFileSync(
      join(marketplaceRoot, "project-controller", "src", "index.ts"),
      `export default {
  pluginId: ${JSON.stringify(pluginId)},
  version: "1.0.0",
  async activate(context) {
    context.controllers.register({
      resourceType: { apiVersion: "tests.baton.dev/v1", kind: "ProjectCheck" },
      sources: [{
        type: "resource",
        sourceId: "project-source",
        async start(source) {
          source.emit({
            name: "shared",
            namespace: ${JSON.stringify(`v1/project/${projectDirName(cwd)}`)},
            spec: {},
          });
        },
      }],
      async reconcile(_reconcile, resource) {
        await Bun.write(
          ${JSON.stringify(marker)},
          JSON.stringify({ namespace: resource.metadata.namespace, name: resource.metadata.name }),
        );
      },
    });
  },
};
`,
    );
    const marketplace = new MarketplaceRegistry({ rootDir: root });
    await marketplace.add(marketplaceRoot);
    marketplace.install(pluginId);
    marketplace.close();
    new PluginSettingsStore(root).set({
      pluginId,
      marketplace: "test-project",
      packageVersion: "1.0.0",
    });
    const session = new SessionStore(root).createSession({ cwd });
    session.releaseLock();

    daemon = await listenBatonDaemon(root);
    await attachBatonSession(root, {
      sessionId: "first",
      projectId: projectDirName(cwd),
      cwd,
    });
    await attachBatonSession(root, {
      sessionId: "second",
      projectId: projectDirName(cwd),
      cwd,
    });
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++) {
      await Bun.sleep(10);
    }

    expect((await batonDaemonStatus(root))?.pluginWorkerCount).toBe(1);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
      namespace: `v1/project/${projectDirName(cwd)}`,
      name: "shared",
    });
  });

  test("owns one root and answers typed status requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-daemon-"));
    daemon = await listenBatonDaemon(root);

    expect(await batonDaemonStatus(root)).toEqual(daemon.status);
    await expect(listenBatonDaemon(root)).rejects.toThrow("already running");
  });

  test("reports a daemon process that exits during startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-daemon-"));
    writeFileSync(join(root, "plugin.yaml"), "version: invalid\nplugins: {}\n");

    await expect(startBatonDaemon(root, { timeoutMs: 5_000 })).rejects.toThrow(
      /Baton Daemon exited before becoming ready \(exit code [1-9][0-9]*\)/,
    );
  });

  test("rejects unknown methods without terminating", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-daemon-"));
    daemon = await listenBatonDaemon(root);
    const response = await callBatonDaemon(root, {
      id: 7,
      method: "future" as "status",
    });
    expect(response).toEqual({
      id: 7,
      ok: false,
      error: "unknown Baton Daemon method",
    });
    expect((await batonDaemonStatus(root))?.pid).toBe(process.pid);
  });

  test("registers Sessions and routes one project action without duplicate transients", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-daemon-"));
    const inbox = new HumanInboxStore(root);
    inbox.create({
      namespace: "v1/project/project-a",
      pluginId: "compforge/reqloop",
      pluginInstanceId: "pb_reqloop",
      executionId: "pex_test",
      request: {
        verb: "confirm",
        input: {
          title: "Handle review",
          prompt: "Continue?",
          timeoutMs: 60_000,
        },
      },
    });
    daemon = await listenBatonDaemon(root);

    const first = await attachBatonSession(root, {
      sessionId: "s1",
      projectId: "project-a",
      cwd: "/project/a",
    });
    const second = await attachBatonSession(root, {
      sessionId: "s2",
      projectId: "project-a",
      cwd: "/project/a",
    });
    expect(first[0]?.delivery).toBe("transient");
    expect(second[0]?.delivery).toBe("badge");
    expect((await batonDaemonStatus(root))?.sessionCount).toBe(2);

    await detachBatonSession(root, "s1");
    expect((await batonDaemonStatus(root))?.sessionCount).toBe(1);
  });

  test("keeps decision and review access inside the action namespace", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-daemon-"));
    const daemon = new BatonDaemon({
      rootDir: root,
      workerLauncher: {
        async launch() {
          return { async close() {} };
        },
      },
      packages: () => [],
    });
    const action = daemon.inbox.create({
      namespace: "v1/project/project-a",
      pluginId: "compforge/reqloop",
      pluginInstanceId: "pb_reqloop",
      executionId: "pex_review",
      request: {
        verb: "confirm",
        input: {
          title: "Handle review",
          prompt: "Continue?",
          timeoutMs: 60_000,
        },
      },
    });
    await daemon.attach({
      sessionId: "same-project",
      projectId: "project-a",
      cwd: "/project/a",
    });
    await daemon.attach({
      sessionId: "other-project",
      projectId: "project-b",
      cwd: "/project/b",
    });
    daemon.claim(action.actionId, "same-project");
    daemon.complete(
      action.actionId,
      "same-project",
      { state: "success", value: "confirmed" },
      true,
    );

    expect(() =>
      daemon.review(action.actionId, "other-project", true)
    ).toThrow("cannot review action");
    expect(
      daemon.review(action.actionId, "same-project", true),
    ).toMatchObject({ phase: "completed" });
    await daemon.close();
  });
});
