import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BatonTargetResource, ResourceRef } from "@compforge/baton-plugin";
import { SessionStore } from "../src/store/store.ts";
import { BatonResourceProvider } from "../src/plugin/baton-resource.ts";
import type { TargetProbe } from "../src/plugin/target-catalog.ts";

const type = { apiVersion: "baton.dev/v1alpha1", kind: "Target" };
const models = [{ id: "fast", label: "Fast", efforts: [{ id: "medium", label: "Medium" }] }];

async function fixture(run: (provider: BatonResourceProvider, ref: ResourceRef, advance: () => void) => Promise<void>, probe?: TargetProbe) {
  const root = mkdtempSync(join(tmpdir(), "baton-target-catalog-"));
  let now = Date.parse("2026-09-14T00:00:00Z");
  try {
    const session = new SessionStore(root).createSession({ cwd: "/repo" });
    const provider = new BatonResourceProvider({ session, targets: () => [{ id: "codex2", harness: "codex" }], probeTarget: probe, now: () => new Date(now) });
    const listed = provider.list(type)[0]!;
    await run(provider, { ...type, namespace: listed.metadata.namespace, name: listed.metadata.name, uid: listed.metadata.uid }, () => { now += 61_000; });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function read(provider: BatonResourceProvider, ref: ResourceRef) {
  return provider.get<BatonTargetResource["spec"], BatonTargetResource["status"]>(ref);
}

describe("builtin Target model catalog", () => {
  test("list is lazy; concurrent gets share one probe; expiry refreshes the same resource", async () => {
    let calls = 0;
    await fixture(async (provider, ref, advance) => {
      expect(provider.list(type)[0]!.status).toEqual({ phase: "Ready", modelCatalog: { phase: "Pending" } });
      expect(calls).toBe(0);
      const [first, second] = await Promise.all([read(provider, ref), read(provider, ref)]);
      expect(calls).toBe(1);
      expect(first).toEqual(second);
      expect(first!.status.modelCatalog).toMatchObject({ phase: "Ready", models });
      expect(Object.isFrozen(first!.status.modelCatalog)).toBe(true);
      await read(provider, ref);
      expect(calls).toBe(1);
      advance();
      const refreshed = await read(provider, ref);
      expect(calls).toBe(2);
      expect(refreshed!.metadata.uid).toBe(first!.metadata.uid);
      expect(refreshed!.metadata.resourceVersion).not.toBe(first!.metadata.resourceVersion);
      expect(refreshed!.metadata.generation).toBe(first!.metadata.generation);
      expect(() => provider.patch(refreshed!, { type: "merge", value: { status: { modelCatalog: {} } } })).toThrow();
    }, async (target) => { expect(target.id).toBe("codex2"); calls++; return { modelCatalog: models }; });
  });

  test("unknown and stale references do not probe", async () => {
    await fixture(async (provider, ref) => {
      expect(await read(provider, { ...ref, name: "missing" })).toBeUndefined();
      expect(await read(provider, { ...ref, uid: "stale" })).toBeUndefined();
    }, async () => { throw new Error("must not probe"); });
  });

  test("unsupported, failed, and empty discovery remain distinct", async () => {
    await fixture(async (provider, ref) => {
      expect((await read(provider, ref))!.status.modelCatalog?.phase).toBe("Unavailable");
    });
    await fixture(async (provider, ref) => {
      expect((await read(provider, ref))!.status.modelCatalog).toMatchObject({ phase: "Failed" });
      expect(JSON.stringify(await read(provider, ref))).not.toContain("sensitive");
    }, async () => { throw new Error("sensitive native message"); });
    await fixture(async (provider, ref) => {
      expect((await read(provider, ref))!.status.modelCatalog).toMatchObject({ phase: "Ready", models: [] });
    }, async () => ({ modelCatalog: [] }));
  });
});
