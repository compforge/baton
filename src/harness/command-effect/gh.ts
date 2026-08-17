import type { ReadOnlyCommandRule } from "./shell.ts";

/** Read semantics for the narrow GitHub release query surface. */
export const ghCommandIsReadOnly: ReadOnlyCommandRule = ([group, action, ...args]) =>
  group === "release"
  && (action === "list" || action === "view")
  && !args.some((arg) => arg === "--web" || arg.startsWith("--web="));
