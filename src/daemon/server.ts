import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";

import { BATON_VERSION } from "../version.ts";
import { batonDaemonPaths, type BatonDaemonPaths } from "./paths.ts";
import {
  BATON_DAEMON_PROTOCOL_VERSION,
  type BatonDaemonResponse,
  type BatonDaemonStatus,
} from "./protocol.ts";
import { BatonControlPlane } from "./control-plane.ts";
import type { VerbResponse } from "../plugin/verb.ts";

const MAX_REQUEST_CHARS = 64 * 1024;

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ownerPid(path: string): number | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof value.pid === "number" ? value.pid : undefined;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export interface BatonDaemonServer {
  readonly status: BatonDaemonStatus;
  close(): Promise<void>;
}

export async function listenBatonDaemon(
  rootDir?: string,
): Promise<BatonDaemonServer> {
  const paths = batonDaemonPaths(rootDir);
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  acquireOwner(paths);
  rmSync(paths.socket, { force: true });

  const startedAt = new Date().toISOString();
  const controlPlane = new BatonControlPlane({ rootDir: paths.rootDir });
  try {
    await controlPlane.start();
  } catch (error) {
    await controlPlane.close().catch(() => {});
    releaseOwner(paths);
    throw error;
  }
  const currentStatus = (): BatonDaemonStatus => {
    const control = controlPlane.status();
    return Object.freeze({
      protocolVersion: BATON_DAEMON_PROTOCOL_VERSION,
      batonVersion: BATON_VERSION,
      pid: process.pid,
      startedAt,
      rootDir: paths.rootDir,
      sessionCount: control.sessions.length,
      pluginWorkerCount: control.workers.length,
      pendingHumanActions: control.pendingHumanActions,
    });
  };
  writeJsonAtomic(paths.owner, currentStatus());

  let closeDaemon!: () => Promise<void>;
  const server = createServer((socket) =>
    handleSocket(socket, currentStatus, controlPlane, () => closeDaemon())
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(paths.socket, 0o600);
  } catch (error) {
    await controlPlane.close().catch(() => {});
    releaseOwner(paths);
    throw error;
  }

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      let closeError: unknown;
      try {
        await controlPlane.close();
      } catch (error) {
        closeError = error;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      } catch (error) {
        closeError ??= error;
      } finally {
        releaseOwner(paths);
      }
      if (closeError !== undefined) throw closeError;
    })();
    return closing;
  };
  closeDaemon = close;
  server.once("close", () => releaseOwner(paths));
  return Object.freeze({ get status() { return currentStatus(); }, close });
}

function acquireOwner(paths: BatonDaemonPaths): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(paths.owner, "wx", 0o600);
      try {
        writeSync(fd, `${JSON.stringify({ pid: process.pid })}\n`);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = ownerPid(paths.owner);
    if (holder !== undefined && pidAlive(holder)) {
      throw new Error(`Baton Daemon is already running with pid ${holder}`);
    }
    rmSync(paths.owner, { force: true });
    rmSync(paths.socket, { force: true });
  }
  throw new Error("could not acquire Baton Daemon ownership");
}

function releaseOwner(paths: BatonDaemonPaths): void {
  if (ownerPid(paths.owner) === process.pid) {
    rmSync(paths.owner, { force: true });
  }
  rmSync(paths.socket, { force: true });
}

function response(
  socket: Socket,
  value: BatonDaemonResponse,
): void {
  socket.end(`${JSON.stringify(value)}\n`);
}

function stringParam(
  params: Record<string, unknown>,
  name: string,
): string {
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
  return value;
}

function handleSocket(
  socket: Socket,
  status: () => BatonDaemonStatus,
  controlPlane: BatonControlPlane,
  close: () => Promise<void>,
): void {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", async (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_REQUEST_CHARS) {
      socket.destroy(new Error("Baton Daemon request is too large"));
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    socket.removeAllListeners("data");
    let request: {
      readonly id?: unknown;
      readonly method?: unknown;
      readonly params?: unknown;
    };
    try {
      request = JSON.parse(buffer.slice(0, newline)) as {
        readonly id?: unknown;
        readonly method?: unknown;
      };
    } catch {
      response(socket, { id: 0, ok: false, error: "invalid JSON request" });
      return;
    }
    if (!Number.isSafeInteger(request.id)) {
      response(socket, { id: 0, ok: false, error: "request id must be an integer" });
      return;
    }
    const id = request.id as number;
    if (request.method === "status") {
      response(socket, { id, ok: true, result: status() });
      return;
    }
    if (request.method === "stop") {
      response(socket, { id, ok: true, result: { stopping: true } });
      setTimeout(() => void close(), 0);
      return;
    }
    const params = request.params && typeof request.params === "object" &&
        !Array.isArray(request.params)
      ? request.params as Record<string, unknown>
      : {};
    try {
      let result: unknown;
      if (request.method === "session.attach") {
        result = await controlPlane.attach({
          sessionId: stringParam(params, "sessionId"),
          projectId: stringParam(params, "projectId"),
          cwd: stringParam(params, "cwd"),
        });
      } else if (request.method === "session.heartbeat") {
        result = await controlPlane.heartbeat(stringParam(params, "sessionId"));
      } else if (request.method === "session.detach") {
        await controlPlane.detach(stringParam(params, "sessionId"));
        result = { detached: true };
      } else if (request.method === "inbox.list") {
        result = await controlPlane.heartbeat(stringParam(params, "sessionId"));
      } else if (request.method === "inbox.claim") {
        result = controlPlane.claim(
          stringParam(params, "actionId"),
          stringParam(params, "sessionId"),
        );
      } else if (request.method === "inbox.begin-execution") {
        result = controlPlane.beginExecution(
          stringParam(params, "actionId"),
          stringParam(params, "sessionId"),
        );
      } else if (request.method === "inbox.complete") {
        if (typeof params.review !== "boolean") {
          throw new Error("review must be a boolean");
        }
        result = controlPlane.complete(
          stringParam(params, "actionId"),
          stringParam(params, "sessionId"),
          params.result as VerbResponse,
          params.review,
        );
      } else if (request.method === "inbox.review") {
        if (typeof params.accepted !== "boolean") {
          throw new Error("accepted must be a boolean");
        }
        result = controlPlane.review(
          stringParam(params, "actionId"),
          stringParam(params, "sessionId"),
          params.accepted,
        );
      } else {
        throw new Error("unknown Baton Daemon method");
      }
      response(socket, { id, ok: true, result });
    } catch (error) {
      response(socket, {
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
