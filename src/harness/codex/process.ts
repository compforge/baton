import type { ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * 启动期请求（initialize / thread resume/start）的显式超时：这些请求发生在 turn 提交
 * 之前，卡死会永久占住全局 turn 队列（preparing 状态的可取消性也依赖它兜底退出）。
 * turn/start 刻意不设——老版本 app-server 会合法地阻塞到 turn 结束。
 */
export const STARTUP_REQUEST_TIMEOUT_MS = 30_000;
export const RECONCILE_REQUEST_TIMEOUT_MS = 10_000;
export const SHUTDOWN_GRACE_MS = 2_000;

export function waitForChildClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("close", onClose);
  });
}

export function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have changed state between the check and group signal;
      // fall back to ChildProcess.kill for platforms without a live group.
    }
  }
  child.kill(signal);
}

/** Esc is Ctrl-C for a live Codex command; keep app-server and its thread alive. */
export function interruptCommandProcess(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGINT");
      return;
    } catch {
      // Older Codex versions may report a PID which is not the process-group leader.
    }
  }
  try {
    process.kill(pid, "SIGINT");
  } catch {
    // The command may have completed between its last item update and Esc.
  }
}

export async function terminateCodexProcess(
  child: ChildProcessWithoutNullStreams,
  graceMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const graceful = waitForChildClose(child, graceMs);
  signalProcessTree(child, "SIGTERM");
  if (await graceful) return true;
  const forced = waitForChildClose(child, graceMs);
  signalProcessTree(child, "SIGKILL");
  return forced;
}

