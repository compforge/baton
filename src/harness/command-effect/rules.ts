import { findCommandIsReadOnly } from "./find.ts";
import { ghCommandIsReadOnly } from "./gh.ts";
import { gitCommandIsReadOnly } from "./git.ts";
import { npmCommandIsReadOnly } from "./npm.ts";
import { rgCommandIsReadOnly } from "./rg.ts";
import { sedCommandIsReadOnly } from "./sed.ts";
import type { ReadOnlyCommandRules } from "./shell.ts";
import { sortCommandIsReadOnly } from "./sort.ts";
import { uniqCommandIsReadOnly } from "./uniq.ts";

const SIMPLE_READER = Object.assign(
  () => true,
  { acceptsPassiveExpansion: true as const },
);

/**
 * Registry for command-level semantics. Add simple readers here; move commands
 * with meaningful argument semantics into their own rule module.
 */
export const READ_ONLY_COMMAND_RULES: ReadOnlyCommandRules = new Map([
  ["cat", SIMPLE_READER],
  ["cd", SIMPLE_READER],
  ["echo", SIMPLE_READER],
  ["find", findCommandIsReadOnly],
  ["gh", ghCommandIsReadOnly],
  ["git", gitCommandIsReadOnly],
  ["grep", SIMPLE_READER],
  ["head", SIMPLE_READER],
  ["ls", SIMPLE_READER],
  ["npm", npmCommandIsReadOnly],
  ["pwd", SIMPLE_READER],
  ["rg", rgCommandIsReadOnly],
  ["sed", sedCommandIsReadOnly],
  ["sort", sortCommandIsReadOnly],
  ["tail", SIMPLE_READER],
  ["uniq", uniqCommandIsReadOnly],
  ["wc", SIMPLE_READER],
  ["which", SIMPLE_READER],
]);
