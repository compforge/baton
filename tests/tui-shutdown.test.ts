import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import {
  installTerminationHandlers,
  signalExitCode,
  type BatonTerminationSignal,
} from "../src/cli/termination.ts";

class SignalProcess extends EventEmitter {
  signal(signal: BatonTerminationSignal): void {
    this.emit(signal);
  }
}

describe("TUI termination", () => {
  test("maps POSIX termination exit codes", () => {
    expect(signalExitCode("SIGHUP")).toBe(129);
    expect(signalExitCode("SIGTERM")).toBe(143);
  });

  test("the first signal drains once and then exits", async () => {
    const proc = new SignalProcess();
    const calls: string[] = [];
    const remove = installTerminationHandlers({
      process: proc,
      timeoutMs: 100,
      shutdown: async (signal) => {
        calls.push(`shutdown:${signal}`);
      },
      exit: (code) => calls.push(`exit:${code}`),
    });

    proc.signal("SIGTERM");
    await Bun.sleep(0);
    expect(calls).toEqual(["shutdown:SIGTERM", "exit:143"]);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    remove();
  });

  test("a second signal forces exit while cleanup is stuck", async () => {
    const proc = new SignalProcess();
    const calls: string[] = [];
    installTerminationHandlers({
      process: proc,
      timeoutMs: 100,
      shutdown: async () => new Promise<void>(() => {}),
      exit: (code) => calls.push(`exit:${code}`),
    });

    proc.signal("SIGTERM");
    await Bun.sleep(0);
    proc.signal("SIGTERM");
    expect(calls).toEqual(["exit:143"]);
  });

  test("a deadline prevents stuck cleanup from pinning Baton", async () => {
    const proc = new SignalProcess();
    const calls: string[] = [];
    installTerminationHandlers({
      process: proc,
      timeoutMs: 5,
      shutdown: async () => new Promise<void>(() => {}),
      exit: (code) => calls.push(`exit:${code}`),
    });

    proc.signal("SIGHUP");
    await Bun.sleep(15);
    expect(calls).toEqual(["exit:129"]);
  });
});
