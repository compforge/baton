export function externalUrlCommand(
  value: string,
  platform: NodeJS.Platform = process.platform,
): [string, ...string[]] {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported external URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("External URLs with embedded credentials are not supported");
  }

  if (platform === "darwin") return ["open", url.href];
  if (platform === "win32") {
    return ["rundll32.exe", "url.dll,FileProtocolHandler", url.href];
  }
  return ["xdg-open", url.href];
}

/** Open a user-selected URL with the local desktop host, never through a shell. */
export async function openExternalUrl(value: string): Promise<void> {
  const child = Bun.spawn(externalUrlCommand(value), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`External URL launcher exited with code ${exitCode}`);
  }
}
