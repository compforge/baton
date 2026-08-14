import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

import { CodexAdapter } from "../src/harness/codex/adapter.ts";

describe("Codex Adapter shutdown", () => {
  test("Esc sends Ctrl-C to a live command without closing app-server", async () => {
    const command = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    const adapter = new CodexAdapter({
      openInteraction: async () => ({
        kind: "permission",
        outcome: "selected",
        optionId: "decline",
      }),
    });
    const requests: string[] = [];
    const runtime = {
      threadId: "thread-1",
      activeTurn: { turnId: "turn-1", finalized: false },
      codexTurnId: "codex-turn-1",
      activeCommandProcesses: new Map([["command-1", command.pid!]]),
      peer: {
        request: async (method: string) => {
          requests.push(method);
          return {};
        },
      },
    };
    const seams = adapter as unknown as { threads: Map<string, typeof runtime> };
    seams.threads.set("thread-1", runtime);

    await adapter.cancel({ harness: "codex", handleId: "thread-1" });
    for (let i = 0; i < 100 && command.exitCode === null && command.signalCode === null; i++) {
      await Bun.sleep(5);
    }

    expect(requests).toEqual(["turn/interrupt"]);
    expect(command.signalCode).toBe("SIGINT");
  });

  test("escalates from SIGTERM and waits for an uncooperative app-server to exit", async () => {
    const script = `
      const readline = require("node:readline");
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      const rl = readline.createInterface({ input: process.stdin });
      const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
      rl.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") send({ id: message.id, result: {} });
        if (message.method === "thread/start") {
          send({ id: message.id, result: { thread: { id: "thread-shutdown" } } });
        }
      });
    `;
    const adapter = new CodexAdapter({
      command: [process.execPath, "-e", script],
      shutdownGraceMs: 20,
      openInteraction: async () => ({
        kind: "permission",
        outcome: "selected",
        optionId: "decline",
      }),
    });
    const ref = await adapter.open({ cwd: "/tmp" }, () => {});
    const seams = adapter as unknown as {
      threads: Map<string, { child: { pid?: number } }>;
    };
    const pid = seams.threads.get(ref.handleId)?.child.pid;
    expect(pid).toBeNumber();

    await adapter.close(ref);

    expect(seams.threads.size).toBe(0);
    expect(() => process.kill(pid!, 0)).toThrow();
  });
});
