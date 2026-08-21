import { mkdirSync } from "node:fs";
import {
  basename,
  dirname,
  join,
} from "node:path";

import type {
  PluginDataDirectories,
  PluginSessionContext,
} from "@compforge/baton-plugin";

import type { PluginInstance } from "./instance.ts";

const RESERVED_GLOBAL_NAMES = new Set([
  "marketplaces",
  "marketplaces.json",
  "packages",
]);

function pluginDirectoryName(pluginId: string): string {
  if (!pluginId.trim()) throw new Error("pluginId must not be empty");
  const name = encodeURIComponent(pluginId);
  if (RESERVED_GLOBAL_NAMES.has(name)) {
    throw new Error(`pluginId conflicts with Baton Plugin storage: ${pluginId}`);
  }
  return name;
}

function projectDirectory(sessionDir: string): {
  readonly batonRoot: string;
  readonly project: string;
} {
  const sessions = dirname(sessionDir);
  if (basename(sessions) !== "sessions") {
    throw new Error(
      `Plugin data requires a BatonSession under a sessions directory: ${sessionDir}`,
    );
  }
  const project = dirname(sessions);
  const projects = dirname(project);
  if (basename(projects) !== "projects") {
    throw new Error(
      `Plugin data requires a BatonSession under a Project directory: ${sessionDir}`,
    );
  }
  return {
    batonRoot: dirname(projects),
    project,
  };
}

/**
 * Creates the writable directories owned by one Plugin at each persistence
 * scope. Plugin identity owns global/Project/Session paths; the concrete
 * Plugin Binding owns the narrowest path.
 */
export function preparePluginDataDirectories(
  session: PluginSessionContext & { readonly dir: string },
  instance: Pick<PluginInstance, "pluginId" | "pluginInstanceId">,
): PluginDataDirectories {
  const layout = projectDirectory(session.dir);
  const plugin = pluginDirectoryName(instance.pluginId);
  const sessionData = join(session.dir, "plugins", plugin);
  const directories = Object.freeze({
    global: join(layout.batonRoot, "plugins", plugin),
    project: join(layout.project, "plugins", plugin),
    session: sessionData,
    instance: join(sessionData, instance.pluginInstanceId),
  });
  for (const path of Object.values(directories)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return directories;
}
