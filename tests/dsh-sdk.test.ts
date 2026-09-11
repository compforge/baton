import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { DshAdapter } from "../src/harness/dsh/adapter.ts";
import type { AnyEventDraft } from "../src/event/index.ts";
import { DEFAULT_DSH_TARGET_CONFIG, resolveDshTargetConfig } from "../src/harness/dsh/config.ts";

test("published DSH SDK initializes and closes its matching runtime without a custom command", async () => {
  const home = await mkdtemp(join(tmpdir(), "baton-dsh-sdk-"));
  // No user home, credentials, or model requests: verify the installed plugin tree and launch contract.
  const harness = new DeepSeekHarness({
    model: resolveDshTargetConfig(DEFAULT_DSH_TARGET_CONFIG).model,
    cwd: home,
    dshHome: home,
    env: { PATH: process.env.PATH, HOME: home },
    initializeTimeoutMs: 15_000,
  });
  try {
    await harness.start();
    expect(harness.session().id).toBeTruthy();
  } finally {
    await harness.close();
    await rm(home, { recursive: true, force: true });
  }
}, 25_000);

test("adapter uses official SDK receipt-to-idle collection for mixed text and image prompts", async () => {
  const events: AnyEventDraft[] = [];
  const adapter = new DshAdapter({ dshBin: fileURLToPath(new URL("./fixtures/dsh-runtime.mjs", import.meta.url)) });
  let onIdle!: () => void;
  const idle = new Promise<void>((resolve) => { onIdle = resolve; });
  const ref = await adapter.open({ cwd: tmpdir() }, (event) => {
    events.push(event);
    if (event.kind === "state_update") onIdle();
  });
  const blocks = [
    { type: "text" as const, text: "describe" },
    { type: "image" as const, mimeType: "image/png", data: "AA==" },
  ];
  try {
    expect(await adapter.sendTurn(ref, { turnId: "t_sdk", messageId: "m_sdk", blocks })).toEqual({ accepted: true, effective: "new_turn" });
    await idle;
    expect(events.filter((event) => event.kind === "state_update")).toEqual([
      expect.objectContaining({ turnId: "t_sdk", payload: { state: "idle", stopReason: "end_turn" } }),
    ]);
    expect(events.find((event) => event.kind === "agent_message")?.payload).toMatchObject({
      content: [{ type: "text", text: JSON.stringify(blocks) }],
    });
  } finally {
    await adapter.close(ref);
  }
});
