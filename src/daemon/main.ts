#!/usr/bin/env bun

import { listenBatonDaemon } from "./server.ts";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const daemon = await listenBatonDaemon(argValue("--root"));

let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  void daemon.close().finally(() => process.exit(0));
};

process.once("SIGINT", close);
process.once("SIGTERM", close);

