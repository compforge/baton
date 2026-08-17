import type { ReadOnlyCommandRule } from "./shell.ts";

const UNSAFE_REVISION_QUERY_OPTIONS = ["--output", "--ext-diff", "--textconv"] as const;

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

function revisionQueryIsReadOnly(args: readonly string[]): boolean {
  return !args.some((arg) =>
    UNSAFE_REVISION_QUERY_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`)),
  );
}

function branchListsOnly(args: readonly string[]): boolean {
  if (args.length === 1 && args[0] === "--show-current") return true;
  if (args[0] !== "--list" && args[0] !== "-l") return false;
  return args.slice(1).every((arg) => !arg.startsWith("-"));
}

function remoteListsOnly(args: readonly string[]): boolean {
  return args.length === 0
    || (args.length === 1 && (args[0] === "-v" || args[0] === "--verbose"));
}

function lsRemoteIsReadOnly(args: readonly string[]): boolean {
  return !args.some((arg) => arg === "--upload-pack" || arg.startsWith("--upload-pack="));
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
    case "show":
      return revisionQueryIsReadOnly(args);
    case "branch":
      return branchListsOnly(args);
    case "remote":
      return remoteListsOnly(args);
    case "ls-remote":
      return lsRemoteIsReadOnly(args);
    case "tag":
      return tagListsOnly(args);
    default:
      return false;
  }
};
