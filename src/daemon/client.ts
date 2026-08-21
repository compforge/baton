import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

import { batonDaemonPaths } from "./paths.ts";
import type {
  BatonDaemonRequest,
  BatonDaemonResponse,
  BatonDaemonStatus,
} from "./protocol.ts";
import type {
  DeliveredHumanAction,
  HumanAction,
  HumanInboxSession,
} from "../inbox/human.ts";
import type { VerbResponse } from "../plugin/verb.ts";
import type { PluginHostSession } from "../plugin/host.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_START_TIMEOUT_MS = 5_000;

function daemonResult(response: BatonDaemonResponse): unknown {
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

function daemonStatus(value: unknown): BatonDaemonStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Baton Daemon returned an invalid status response");
  }
  const status = value as Partial<BatonDaemonStatus>;
  if (
    typeof status.pid !== "number" ||
    typeof status.batonVersion !== "string" ||
    typeof status.rootDir !== "string" ||
    typeof status.sessionCount !== "number" ||
    typeof status.pluginWorkerCount !== "number" ||
    typeof status.pendingHumanActions !== "number"
  ) {
    throw new Error("Baton Daemon returned an invalid status response");
  }
  return status as BatonDaemonStatus;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callBatonDaemon(
  rootDir: string | undefined,
  request: BatonDaemonRequest,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<BatonDaemonResponse> {
  const path = batonDaemonPaths(rootDir).socket;
  return await new Promise<BatonDaemonResponse>((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error(`Baton Daemon request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (
      error?: Error,
      response?: BatonDaemonResponse,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(buffer.slice(0, newline)) as BatonDaemonResponse);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) finish(new Error("Baton Daemon closed without a response"));
    });
  });
}

export async function batonDaemonStatus(
  rootDir?: string,
): Promise<BatonDaemonStatus | undefined> {
  try {
    const response = await callBatonDaemon(rootDir, { id: 1, method: "status" });
    return daemonStatus(daemonResult(response));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return undefined;
    throw error;
  }
}

let nextRequestId = 10;
type BatonDaemonCall = BatonDaemonRequest extends infer Request
  ? Request extends BatonDaemonRequest
    ? Omit<Request, "id">
    : never
  : never;

async function callResult(
  rootDir: string | undefined,
  request: BatonDaemonCall,
): Promise<unknown> {
  return daemonResult(await callBatonDaemon(rootDir, {
    ...request,
    id: nextRequestId++,
  } as BatonDaemonRequest));
}

export async function attachBatonSession(
  rootDir: string | undefined,
  session: PluginHostSession,
): Promise<readonly DeliveredHumanAction[]> {
  return await callResult(rootDir, {
    method: "session.attach",
    params: session,
  }) as readonly DeliveredHumanAction[];
}

export async function heartbeatBatonSession(
  rootDir: string | undefined,
  sessionId: string,
): Promise<readonly DeliveredHumanAction[]> {
  return await callResult(rootDir, {
    method: "session.heartbeat",
    params: { sessionId },
  }) as readonly DeliveredHumanAction[];
}

export async function detachBatonSession(
  rootDir: string | undefined,
  sessionId: string,
): Promise<void> {
  await callResult(rootDir, {
    method: "session.detach",
    params: { sessionId },
  });
}

export async function claimHumanAction(
  rootDir: string | undefined,
  actionId: string,
  sessionId: string,
): Promise<HumanAction> {
  return await callResult(rootDir, {
    method: "inbox.claim",
    params: { actionId, sessionId },
  }) as HumanAction;
}

export async function beginHumanActionExecution(
  rootDir: string | undefined,
  actionId: string,
  sessionId: string,
): Promise<HumanAction> {
  return await callResult(rootDir, {
    method: "inbox.begin-execution",
    params: { actionId, sessionId },
  }) as HumanAction;
}

export async function completeHumanAction(
  rootDir: string | undefined,
  actionId: string,
  sessionId: string,
  result: VerbResponse,
  review: boolean,
): Promise<HumanAction> {
  return await callResult(rootDir, {
    method: "inbox.complete",
    params: { actionId, sessionId, result, review },
  }) as HumanAction;
}

export async function reviewHumanAction(
  rootDir: string | undefined,
  actionId: string,
  sessionId: string,
  accepted: boolean,
): Promise<HumanAction> {
  return await callResult(rootDir, {
    method: "inbox.review",
    params: { actionId, sessionId, accepted },
  }) as HumanAction;
}

export async function startBatonDaemon(
  rootDir?: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<BatonDaemonStatus> {
  const current = await batonDaemonStatus(rootDir);
  if (current) return current;
  const paths = batonDaemonPaths(rootDir);
  const entry = fileURLToPath(new URL("./main.ts", import.meta.url));
  const nullFd = openSync("/dev/null", "a+");
  let launchError: Error | undefined;
  try {
    const child = spawn(process.execPath, [entry, "--root", paths.rootDir], {
      detached: true,
      stdio: ["ignore", nullFd, nullFd],
    });
    child.once("error", (error) => {
      launchError = new Error(`Baton Daemon could not start: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      const outcome = code === null
        ? `signal ${signal ?? "unknown"}`
        : `exit code ${code}`;
      launchError ??= new Error(
        `Baton Daemon exited before becoming ready (${outcome})`,
      );
    });
    child.unref();
  } finally {
    closeSync(nullFd);
  }

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const status = await batonDaemonStatus(paths.rootDir);
      if (status) return status;
    } catch (error) {
      lastError = error;
    }
    if (launchError) throw launchError;
    await delay(25);
  }
  if (launchError) throw launchError;
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Baton Daemon did not become ready${detail}`);
}

export async function stopBatonDaemon(rootDir?: string): Promise<boolean> {
  if (!existsSync(batonDaemonPaths(rootDir).socket)) return false;
  try {
    const response = await callBatonDaemon(rootDir, { id: 1, method: "stop" });
    if (!response.ok) throw new Error(response.error);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return false;
    throw error;
  }
}
