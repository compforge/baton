import type { ReadOnlyCommandRule } from "./shell.ts";

const UNSAFE_LOG_OPTIONS = ["--output", "--ext-diff", "--textconv"] as const;

const TAG_LIST_OPTIONS = new Set([
  "-l",
  "--list",
  "-n",
  "--column",
  "--no-column",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--sort",
  "--format",
  "--color",
  "--ignore-case",
  "--omit-empty",
]);

const TAG_LIST_OPTION_PREFIXES = [
  "--column=",
  "--contains=",
  "--no-contains=",
  "--merged=",
  "--no-merged=",
  "--points-at=",
  "--sort=",
  "--format=",
  "--color=",
] as const;

function logIsReadOnly(args: readonly string[]): boolean {
  return !args.some((arg) =>
    UNSAFE_LOG_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`)),
  );
}

function tagListsOnly(args: readonly string[]): boolean {
  if (args.length === 0) return true;

  let listMode = false;
  for (const arg of args) {
    if (TAG_LIST_OPTIONS.has(arg) || /^-n\d+$/.test(arg)) {
      listMode = true;
      continue;
    }
    if (TAG_LIST_OPTION_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      listMode = true;
      continue;
    }
    if (arg.startsWith("-")) return false;
    if (!listMode) return false;
  }
  return true;
}

/** Read semantics for the explicitly supported Git query subcommands. */
export const gitCommandIsReadOnly: ReadOnlyCommandRule = ([subcommand, ...args]) => {
  switch (subcommand) {
    case "status":
      return true;
    case "log":
      return logIsReadOnly(args);
    case "tag":
      return tagListsOnly(args);
    default:
      return false;
  }
};
