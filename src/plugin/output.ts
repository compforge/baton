import type { PluginOutput } from "@compforge/baton-plugin";

export type { PluginOutput } from "@compforge/baton-plugin";

function nonEmpty(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
}

export function validatePluginOutput(value: unknown): asserts value is PluginOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reconcile output must be a PluginOutput object");
  }
  const output = value as Record<string, unknown>;
  if (output.kind === "proposed-input") {
    nonEmpty("reconcile proposed-input text", output.text);
    return;
  }
  if (output.kind !== "interaction") {
    throw new Error(`unsupported PluginOutput kind: ${String(output.kind)}`);
  }
  nonEmpty("reconcile interaction decisionKey", output.decisionKey);
  nonEmpty("reconcile interaction title", output.title);
  nonEmpty("reconcile interaction prompt", output.prompt);
  if (output.allowOther !== undefined && typeof output.allowOther !== "boolean") {
    throw new Error("reconcile interaction allowOther must be a boolean");
  }
  if (output.options === undefined) return;
  if (!Array.isArray(output.options) || output.options.length === 0) {
    throw new Error("reconcile interaction options must be a non-empty array");
  }
  const optionIds = new Set<string>();
  const labels = new Set<string>();
  for (const [index, value] of output.options.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`reconcile interaction options[${index}] must be an object`);
    }
    const option = value as Record<string, unknown>;
    nonEmpty(`reconcile interaction options[${index}].optionId`, option.optionId);
    nonEmpty(`reconcile interaction options[${index}].label`, option.label);
    if (optionIds.has(option.optionId)) {
      throw new Error(`reconcile interaction optionId is duplicated: ${option.optionId}`);
    }
    if (labels.has(option.label)) {
      throw new Error(`reconcile interaction option label is duplicated: ${option.label}`);
    }
    optionIds.add(option.optionId);
    labels.add(option.label);
    if (
      option.description !== undefined &&
      typeof option.description !== "string"
    ) {
      throw new Error(
        `reconcile interaction options[${index}].description must be a string`,
      );
    }
    if (
      option.role !== undefined &&
      option.role !== "default" &&
      option.role !== "reject"
    ) {
      throw new Error(
        `reconcile interaction options[${index}].role is invalid: ${String(option.role)}`,
      );
    }
  }
}
