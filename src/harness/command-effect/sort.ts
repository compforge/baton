import type { ReadOnlyCommandRule } from "./shell.ts";

const OUTPUT_OPTIONS = ["-o", "-T", "--output", "--temporary-directory", "--compress-program"] as const;

/** Keep sort read-only only while it writes its result to stdout. */
export const sortCommandIsReadOnly: ReadOnlyCommandRule = (args) =>
  !args.some((arg) => OUTPUT_OPTIONS.some((option) =>
    arg === option || arg.startsWith(`${option}=`) || (option.length === 2 && arg.startsWith(option)),
  ));
