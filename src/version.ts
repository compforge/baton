import { readFileSync } from "node:fs";

export const BATON_VERSION = readFileSync(
  new URL("../VERSION", import.meta.url),
  "utf8",
).trim();
