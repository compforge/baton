import type {
  PluginNamespace,
  PluginNamespaceContext,
  PluginNamespaceTemplate,
} from "@compforge/baton-plugin";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function stableSegment(name: string, value: string | undefined): string {
  if (!value || !SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`${name} must be a stable identifier without path separators`);
  }
  return value;
}

export function parsePluginNamespaceTemplate(
  value: unknown,
): PluginNamespaceTemplate {
  if (
    value !== "v1" &&
    value !== "v1/project" &&
    value !== "v1/project/session"
  ) {
    throw new Error(
      "plugin namespace must be v1, v1/project, or v1/project/session",
    );
  }
  return value;
}

/**
 * Resolves a Package declaration before a Binding is created.
 *
 * @rule Persist only canonical namespaces; relative project/session templates
 * are authoring conveniences and must never become storage identity.
 */
export function resolvePluginNamespace(
  template: PluginNamespaceTemplate,
  context: PluginNamespaceContext = {},
): PluginNamespace {
  if (template === "v1") return "v1";
  const projectId = stableSegment("projectId", context.projectId);
  if (template === "v1/project") return `v1/project/${projectId}`;
  const sessionId = stableSegment("sessionId", context.sessionId);
  return `v1/project/${projectId}/session/${sessionId}`;
}

export function parsePluginNamespace(value: unknown): PluginNamespace {
  if (value === "v1") return value;
  if (typeof value !== "string") {
    throw new Error("plugin namespace must be a string");
  }
  const parts = value.split("/");
  if (
    parts.length === 3 &&
    parts[0] === "v1" &&
    parts[1] === "project"
  ) {
    stableSegment("projectId", parts[2]);
    return value as PluginNamespace;
  }
  if (
    parts.length === 5 &&
    parts[0] === "v1" &&
    parts[1] === "project" &&
    parts[3] === "session"
  ) {
    stableSegment("projectId", parts[2]);
    stableSegment("sessionId", parts[4]);
    return value as PluginNamespace;
  }
  throw new Error(
    "plugin namespace must be canonical v1, v1/project/<projectId>, or v1/project/<projectId>/session/<sessionId>",
  );
}

export function pluginNamespaceTemplate(
  namespace: PluginNamespace,
): PluginNamespaceTemplate {
  if (namespace === "v1") return "v1";
  return namespace.includes("/session/")
    ? "v1/project/session"
    : "v1/project";
}

export function namespaceContains(
  owner: PluginNamespace,
  candidate: PluginNamespace,
): boolean {
  return candidate === owner || candidate.startsWith(`${owner}/`);
}
