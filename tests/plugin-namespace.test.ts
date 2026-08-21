import { describe, expect, test } from "bun:test";

import {
  namespaceContains,
  parseResourceNamespace,
  projectResourceNamespace,
  resourceNamespaceScope,
  sessionResourceNamespace,
} from "../src/plugin/namespace.ts";

describe("Resource namespace", () => {
  test("constructs canonical project and Session namespaces", () => {
    expect(projectResourceNamespace("project-a"))
      .toBe("v1/project/project-a");
    expect(sessionResourceNamespace("project-a", "bs_1"))
      .toBe("v1/project/project-a/session/bs_1");
  });

  test("rejects unresolved and malformed namespaces", () => {
    expect(() => parseResourceNamespace("v1/project"))
      .toThrow("canonical");
    expect(() => parseResourceNamespace("v1/project/a/session/../b"))
      .toThrow("canonical");
    expect(() => projectResourceNamespace("../a")).toThrow("projectId");
    expect(() => sessionResourceNamespace("a", "../b")).toThrow("sessionId");
  });

  test("derives Resource scope and descendant relationships", () => {
    const project = parseResourceNamespace("v1/project/project-a");
    const session = parseResourceNamespace(
      "v1/project/project-a/session/bs_1",
    );
    expect(resourceNamespaceScope("v1")).toBe("global");
    expect(resourceNamespaceScope(project)).toBe("project");
    expect(resourceNamespaceScope(session)).toBe("session");
    expect(namespaceContains(project, session)).toBe(true);
    expect(namespaceContains(session, project)).toBe(false);
    expect(namespaceContains(project, "v1/project/project-b")).toBe(false);
  });
});
