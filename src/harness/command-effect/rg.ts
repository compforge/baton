import type { ReadOnlyCommandRule } from "./shell.ts";

// ripgrep does not edit matched files, but these options execute another
// program. Keep them outside the read proof because that program is opaque.
const EXECUTABLE_OPTIONS = ["--pre", "--hostname-bin"] as const;

export const rgCommandIsReadOnly: ReadOnlyCommandRule = (args) =>
  !args.some((arg) =>
    EXECUTABLE_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`)),
  );
