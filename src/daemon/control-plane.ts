import type { VerbResponse } from "../plugin/verb.ts";
import {
  humanActionBelongsToSession,
  HumanInboxStore,
  type DeliveredHumanAction,
  type HumanInboxSession,
} from "../inbox/human.ts";
import {
  PluginHost,
  type PluginHostSession,
  type PluginHostProject,
  type PluginWorkerLauncher,
  type PluginWorkerStatus,
} from "../plugin/host.ts";
import { resolvePluginNamespace } from "../plugin/namespace.ts";
import { DaemonPluginWorkerLauncher } from "./plugin-worker.ts";

export interface AttachedBatonSession extends HumanInboxSession {
  readonly cwd: string;
  readonly attachedAt: string;
  readonly lastSeenAt: string;
}

export interface BatonControlPlaneStatus {
  readonly sessions: readonly AttachedBatonSession[];
  readonly workers: readonly PluginWorkerStatus[];
  readonly pendingHumanActions: number;
}

/** Baton Daemon-owned composition of Plugin Host, live Sessions, and Human Inbox. */
export class BatonControlPlane {
  readonly inbox: HumanInboxStore;
  readonly pluginHost: PluginHost;
  private readonly sessions = new Map<string, AttachedBatonSession>();
  private readonly projects = new Map<string, PluginHostProject>();
  private readonly now: () => Date;
  private readonly packages: () => readonly import("../plugin/host.ts").PluginHostPackage[];
  private readonly closeLauncher?: () => void;
  private closed = false;

  constructor(options: {
    rootDir: string;
    workerLauncher?: PluginWorkerLauncher;
    packages?: () => readonly import("../plugin/host.ts").PluginHostPackage[];
    now?: () => Date;
  }) {
    this.now = options.now ?? (() => new Date());
    for (const project of discoverProjects(options.rootDir)) {
      this.projects.set(project.projectId, project);
    }
    this.inbox = new HumanInboxStore(options.rootDir, { now: this.now });
    const launcher = options.workerLauncher ??
      new DaemonPluginWorkerLauncher(options.rootDir, this.inbox);
    this.pluginHost = new PluginHost(launcher);
    this.packages = options.packages ??
      (launcher instanceof DaemonPluginWorkerLauncher
        ? () => launcher.packages()
        : () => []);
    this.closeLauncher = launcher instanceof DaemonPluginWorkerLauncher
      ? () => launcher.close()
      : undefined;
  }

  async start(): Promise<void> {
    this.assertOpen();
    await this.syncWorkers();
  }

  async attach(session: PluginHostSession): Promise<readonly DeliveredHumanAction[]> {
    this.assertOpen();
    resolvePluginNamespace("v1/project/session", {
      projectId: session.projectId,
      sessionId: session.sessionId,
    });
    const timestamp = this.timestamp();
    const project = this.projects.get(session.projectId);
    if (project && project.cwd !== session.cwd) {
      throw new Error(
        `project ${session.projectId} is attached with conflicting cwd values`,
      );
    }
    this.projects.set(session.projectId, Object.freeze({
      projectId: session.projectId,
      cwd: session.cwd,
    }));
    const previous = this.sessions.get(session.sessionId);
    this.sessions.set(session.sessionId, Object.freeze({
      ...session,
      attachedAt: previous?.attachedAt ?? timestamp,
      lastSeenAt: timestamp,
    }));
    await this.syncWorkers();
    return this.inbox.deliver(session);
  }

  async heartbeat(sessionId: string): Promise<readonly DeliveredHumanAction[]> {
    const session = this.requireSession(sessionId);
    const next = Object.freeze({
      ...session,
      lastSeenAt: this.timestamp(),
    });
    this.sessions.set(sessionId, next);
    await this.syncWorkers();
    return this.inbox.deliver(next);
  }

  async detach(sessionId: string): Promise<void> {
    this.assertOpen();
    if (!this.sessions.delete(sessionId)) return;
    this.inbox.releaseSession(sessionId);
    await this.syncWorkers();
  }

  claim(actionId: string, sessionId: string) {
    return this.inbox.claim(actionId, this.requireSession(sessionId));
  }

  beginExecution(actionId: string, sessionId: string) {
    this.requireSession(sessionId);
    return this.inbox.beginExecution(actionId, sessionId);
  }

  complete(
    actionId: string,
    sessionId: string,
    result: VerbResponse,
    review: boolean,
  ) {
    this.requireSession(sessionId);
    return this.inbox.complete(actionId, sessionId, result, { review });
  }

  review(actionId: string, sessionId: string, accepted: boolean) {
    const session = this.requireSession(sessionId);
    const action = this.inbox.get(actionId);
    if (!humanActionBelongsToSession(action, session)) {
      throw new Error(
        `Session ${sessionId} cannot review action in ${action.namespace}`,
      );
    }
    return this.inbox.review(actionId, sessionId, accepted);
  }

  status(): BatonControlPlaneStatus {
    return Object.freeze({
      sessions: Object.freeze(
        [...this.sessions.values()].sort((left, right) =>
          left.sessionId.localeCompare(right.sessionId)
        ),
      ),
      workers: this.pluginHost.list(),
      pendingHumanActions: this.inbox.list().length,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const sessionId of this.sessions.keys()) {
      this.inbox.releaseSession(sessionId);
    }
    this.sessions.clear();
    await this.pluginHost.close();
    this.closeLauncher?.();
  }

  private requireSession(sessionId: string): AttachedBatonSession {
    this.assertOpen();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Baton Session is not attached: ${sessionId}`);
    return session;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Baton control plane is closed");
  }

  private timestamp(): string {
    const now = this.now();
    if (Number.isNaN(now.getTime())) {
      throw new Error("Baton control plane now() returned an invalid Date");
    }
    return now.toISOString();
  }

  private async syncWorkers(): Promise<void> {
    await this.pluginHost.reconcile(
      this.packages(),
      [...this.sessions.values()],
      [...this.projects.values()],
    );
  }
}

function discoverProjects(rootDir: string): readonly PluginHostProject[] {
  const root = join(rootDir, "projects");
  if (!existsSync(root)) return [];
  const projects: PluginHostProject[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const value = JSON.parse(
        readFileSync(join(root, entry.name, "project.json"), "utf8"),
      ) as { cwd?: unknown };
      if (typeof value.cwd !== "string" || !value.cwd.trim()) continue;
      resolvePluginNamespace("v1/project", { projectId: entry.name });
      projects.push(Object.freeze({ projectId: entry.name, cwd: value.cwd }));
    } catch {
      // A corrupt Project entry must not keep the Daemon from serving healthy Projects.
    }
  }
  return Object.freeze(projects);
}
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
