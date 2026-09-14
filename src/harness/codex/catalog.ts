import type { HarnessTargetProbeResult } from "../target.ts";
import { codexModels, codexEfforts } from "./runtime.ts";
import { withCodexPeer, type CodexNativePeer } from "./peer.ts";
import { STARTUP_REQUEST_TIMEOUT_MS } from "./process.ts";

export async function readCodexModelData(peer: CodexNativePeer): Promise<{ data: unknown[] }> {
  const data: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await peer.request("model/list", {
      limit: 200,
      ...(cursor ? { cursor } : {}),
    }, { timeoutMs: STARTUP_REQUEST_TIMEOUT_MS }) as { data?: unknown[]; nextCursor?: string | null };
    if (!Array.isArray(page.data)) throw new Error("Codex model catalog returned invalid data");
    data.push(...page.data);
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor)) throw new Error("Codex model catalog repeated a cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { data };
}

export async function readCodexCatalog(peer: CodexNativePeer): Promise<HarnessTargetProbeResult> {
  const catalog = await readCodexModelData(peer);
  const models = codexModels(catalog);
  return {
    models,
    efforts: codexEfforts(catalog),
    modelCatalog: models.map((model) => ({
      ...model,
      efforts: codexEfforts(catalog, model.id === "default" ? undefined : model.id),
    })),
  };
}

export function probeCodexTarget(options: { command?: string[]; cwd: string; env?: Readonly<Record<string, string>> }): Promise<HarnessTargetProbeResult> {
  return withCodexPeer(options, readCodexCatalog);
}
