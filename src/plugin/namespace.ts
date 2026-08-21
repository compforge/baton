import type {
  ResourceNamespace,
} from "@compforge/baton-plugin";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function stableSegment(name: string, value: string | undefined): string {
  if (!value || !SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`${name} must be a stable identifier without path separators`);
  }
  return value;
}

export function parseResourceNamespace(value: unknown): ResourceNamespace {
  if (value === "v1") return value;
  if (typeof value !== "string") {
    throw new Error("Resource namespace must be a string");
  }
  const parts = value.split("/");
  if (
    parts.length === 3 &&
    parts[0] === "v1" &&
    parts[1] === "project"
  ) {
    stableSegment("projectId", parts[2]);
    return value as ResourceNamespace;
  }
  if (
    parts.length === 5 &&
    parts[0] === "v1" &&
    parts[1] === "project" &&
    parts[3] === "session"
  ) {
    stableSegment("projectId", parts[2]);
    stableSegment("sessionId", parts[4]);
    return value as ResourceNamespace;
  }
  throw new Error(
    "Resource namespace must be canonical v1, v1/project/<projectId>, or v1/project/<projectId>/session/<sessionId>",
  );
}

export function projectResourceNamespace(projectId: string): ResourceNamespace {
  return `v1/project/${stableSegment("projectId", projectId)}`;
}

export function sessionResourceNamespace(
  projectId: string,
  sessionId: string,
): ResourceNamespace {
  const project = stableSegment("projectId", projectId);
  const session = stableSegment("sessionId", sessionId);
  return `v1/project/${project}/session/${session}`;
}

export function resourceNamespaceScope(
  namespace: ResourceNamespace,
): "global" | "project" | "session" {
  if (namespace === "v1") return "global";
  return namespace.includes("/session/") ? "session" : "project";
}

export function namespaceContains(
  owner: ResourceNamespace,
  candidate: ResourceNamespace,
): boolean {
  return candidate === owner || candidate.startsWith(`${owner}/`);
}
