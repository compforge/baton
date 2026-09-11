import type { ReadOnlyCommandRule } from "./shell.ts";

const READ_ONLY_COMMANDS = new Set(["list", "ls", "view", "whoami"]);

/** Read semantics for npm package-tree and registry queries. */
export const npmCommandIsReadOnly: ReadOnlyCommandRule = (args) => {
  let index = 0;
  const cacheOption = args[index];
  if (cacheOption === "--cache") {
    if (!args[index + 1]) return false;
    index += 2;
  } else if (cacheOption?.startsWith("--cache=")) {
    index += 1;
  }

  return READ_ONLY_COMMANDS.has(args[index] ?? "");
};
