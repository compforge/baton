import { describe, expect, test } from "bun:test";

import {
  namespaceContains,
  parsePluginNamespace,
  parsePluginNamespaceTemplate,
  pluginNamespaceTemplate,
  resolvePluginNamespace,
} from "../src/plugin/namespace.ts";

describe("Plugin namespace", () => {
  test("resolves Package templates into canonical Binding identity", () => {
    expect(resolvePluginNamespace("v1")).toBe("v1");
    expect(resolvePluginNamespace("v1/project", { projectId: "project-a" }))
      .toBe("v1/project/project-a");
    expect(resolvePluginNamespace("v1/project/session", {
      projectId: "project-a",
      sessionId: "bs_1",
    })).toBe("v1/project/project-a/session/bs_1");
  });

  test("rejects unresolved and malformed namespaces", () => {
    expect(() => resolvePluginNamespace("v1/project")).toThrow("projectId");
    expect(() => resolvePluginNamespace("v1/project/session", {
      projectId: "project-a",
    })).toThrow("sessionId");
    expect(() => parsePluginNamespace("v1/project"))
      .toThrow("canonical");
    expect(() => parsePluginNamespace("v1/project/a/session/../b"))
      .toThrow("canonical");
    expect(() => parsePluginNamespaceTemplate("project"))
      .toThrow("plugin namespace");
  });

  test("derives cardinality and descendant access", () => {
    const project = parsePluginNamespace("v1/project/project-a");
    const session = parsePluginNamespace(
      "v1/project/project-a/session/bs_1",
    );
    expect(pluginNamespaceTemplate(project)).toBe("v1/project");
    expect(pluginNamespaceTemplate(session)).toBe("v1/project/session");
    expect(namespaceContains(project, session)).toBe(true);
    expect(namespaceContains(session, project)).toBe(false);
    expect(namespaceContains(project, "v1/project/project-b")).toBe(false);
  });
});
