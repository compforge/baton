import { findCommandIsReadOnly } from "./find.ts";
import { gitCommandIsReadOnly } from "./git.ts";
import { rgCommandIsReadOnly } from "./rg.ts";
import { sedCommandIsReadOnly } from "./sed.ts";
import type { ReadOnlyCommandRules } from "./shell.ts";

/**
 * Registry for command-level semantics. Add simple readers here; move commands
 * with meaningful argument semantics into their own rule module.
 */
export const READ_ONLY_COMMAND_RULES: ReadOnlyCommandRules = new Map([
  ["find", findCommandIsReadOnly],
  ["git", gitCommandIsReadOnly],
  ["head", () => true],
  ["rg", rgCommandIsReadOnly],
  ["sed", sedCommandIsReadOnly],
]);
