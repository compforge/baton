import type { ReadOnlyCommandRule } from "./shell.ts";

// find is a reader by default, but these actions can delete files, execute
// arbitrary commands, prompt before execution, or write results to a file.
const EFFECTFUL_ACTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
]);

export const findCommandIsReadOnly: ReadOnlyCommandRule = (args) =>
  !args.some((arg) => EFFECTFUL_ACTIONS.has(arg));
