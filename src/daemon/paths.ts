import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface BatonDaemonPaths {
  readonly rootDir: string;
  readonly runDir: string;
  readonly socket: string;
  readonly owner: string;
}

export function batonDaemonPaths(rootDir?: string): BatonDaemonPaths {
  const root = resolve(rootDir ?? join(homedir(), ".baton"));
  const runDir = join(root, "run");
  return Object.freeze({
    rootDir: root,
    runDir,
    socket: join(runDir, "daemon.sock"),
    owner: join(runDir, "daemon.json"),
  });
}

