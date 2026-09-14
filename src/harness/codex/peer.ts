import { spawn } from "node:child_process";
import { codexLaunchCommand } from "./launch.ts";
import { JsonRpcPeer } from "./jsonrpc.ts";
import { STARTUP_REQUEST_TIMEOUT_MS, SHUTDOWN_GRACE_MS, terminateCodexProcess } from "./process.ts";

export interface CodexNativePeer {
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

/** Read-only app-server operations share bounded startup/cleanup without opening a thread. */
export async function withCodexPeer<T>(
  options: { command?: string[]; cwd: string; env?: Readonly<Record<string, string>> },
  operation: (peer: CodexNativePeer) => Promise<T>,
): Promise<T> {
  const [command, ...args] = codexLaunchCommand(options.command);
  const child = spawn(command as string, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const peer = new JsonRpcPeer((line) => child.stdin.write(line));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => peer.feed(chunk));
  // Drain diagnostics without publishing potentially sensitive native stderr.
  child.stderr.resume();
  child.once("error", (error) => peer.close(`codex app-server spawn error: ${error.message}`));
  child.once("close", (code) => peer.close(`codex app-server exited (${code})`));
  try {
    await peer.request("initialize", {
      clientInfo: { name: "baton", version: "0.0.1", title: "baton" },
      capabilities: { experimentalApi: true },
    }, { timeoutMs: STARTUP_REQUEST_TIMEOUT_MS });
    peer.notify("initialized", {});
    return await operation(peer);
  } finally {
    peer.close("read-only operation complete");
    await terminateCodexProcess(child, SHUTDOWN_GRACE_MS);
  }
}
