import { describe, expect, test } from "bun:test";

import { validatePluginOutput } from "../src/plugin/output.ts";

describe("PluginOutput", () => {
  test("accepts the Baton-owned proposed-input kind", () => {
    expect(() =>
      validatePluginOutput({
        kind: "proposed-input",
        text: "Continue the task.",
      }),
    ).not.toThrow();
  });

  test("rejects unknown kinds and empty proposed input", () => {
    expect(() =>
      validatePluginOutput({ kind: "custom-output", text: "anything" }),
    ).toThrow("unsupported PluginOutput kind");
    expect(() =>
      validatePluginOutput({ kind: "proposed-input", text: " " }),
    ).toThrow("proposed-input text must not be empty");
  });

  test("accepts a durable single-choice Interaction", () => {
    expect(() =>
      validatePluginOutput({
        kind: "interaction",
        decisionKey: "associate-pr",
        title: "Associate pull request",
        prompt: "Which requirement should own this pull request?",
        options: [
          { optionId: "req_1", label: "REQ-1" },
          {
            optionId: "reject",
            label: "Do not associate",
            role: "reject",
          },
        ],
      }),
    ).not.toThrow();
  });

  test("rejects ambiguous Interaction options", () => {
    expect(() =>
      validatePluginOutput({
        kind: "interaction",
        decisionKey: "associate-pr",
        title: "Associate pull request",
        prompt: "Choose",
        options: [
          { optionId: "req_1", label: "Requirement" },
          { optionId: "req_1", label: "Another requirement" },
        ],
      }),
    ).toThrow("optionId is duplicated");

    expect(() =>
      validatePluginOutput({
        kind: "interaction",
        decisionKey: "associate-pr",
        title: "Associate pull request",
        prompt: "Choose",
        options: [
          { optionId: "req_1", label: "Requirement" },
          { optionId: "req_2", label: "Requirement" },
        ],
      }),
    ).toThrow("option label is duplicated");
  });
});
