import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const CLIPBOARD_TIMEOUT_MS = 5_000;
const MAX_CLIPBOARD_BYTES = 25 * 1024 * 1024;

export type ClipboardContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: "image/png"; data: Uint8Array };

function run(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${CLIPBOARD_TIMEOUT_MS}ms`));
    }, CLIPBOARD_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CLIPBOARD_BYTES) {
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (size > MAX_CLIPBOARD_BYTES) {
        reject(new Error(`clipboard content exceeds ${MAX_CLIPBOARD_BYTES} bytes`));
      } else if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

async function macosClipboardImage(): Promise<ClipboardContent | null> {
  const path = join(tmpdir(), `baton-clipboard-${randomUUID()}.png`);
  try {
    await run("osascript", [
      "-e",
      'set imageData to the clipboard as "PNGf"',
      "-e",
      `set fileRef to open for access POSIX file "${path}" with write permission`,
      "-e",
      "set eof fileRef to 0",
      "-e",
      "write imageData to fileRef",
      "-e",
      "close access fileRef",
    ]);
    const data = await readFile(path);
    if (data.length === 0) return null;
    if (data.length > MAX_CLIPBOARD_BYTES) {
      throw new Error(`clipboard image exceeds ${MAX_CLIPBOARD_BYTES} bytes`);
    }
    return { type: "image", mimeType: "image/png", data };
  } catch {
    return null;
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

async function windowsClipboardImage(): Promise<ClipboardContent | null> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($img) {",
    "$ms = New-Object System.IO.MemoryStream",
    "$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
    "[System.Convert]::ToBase64String($ms.ToArray())",
    "}",
  ].join("; ");
  const encoded = await run("powershell.exe", [
    "-NonInteractive",
    "-NoProfile",
    "-Command",
    script,
  ]).catch(() => Buffer.alloc(0));
  if (encoded.length === 0) return null;
  const data = Buffer.from(encoded.toString("utf8").trim(), "base64");
  return data.length > 0 ? { type: "image", mimeType: "image/png", data } : null;
}

async function linuxClipboardImage(): Promise<ClipboardContent | null> {
  const wayland = await run("wl-paste", ["-t", "image/png"]).catch(() => Buffer.alloc(0));
  if (wayland.length > 0) return { type: "image", mimeType: "image/png", data: wayland };
  const x11 = await run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"])
    .catch(() => Buffer.alloc(0));
  return x11.length > 0 ? { type: "image", mimeType: "image/png", data: x11 } : null;
}

async function clipboardText(os: NodeJS.Platform): Promise<string | null> {
  const data =
    os === "darwin"
      ? await run("pbpaste", []).catch(() => Buffer.alloc(0))
      : os === "win32" || release().includes("WSL")
        ? await run("powershell.exe", ["-NonInteractive", "-NoProfile", "-Command", "Get-Clipboard -Raw"])
          .catch(() => Buffer.alloc(0))
        : await run("wl-paste", ["-t", "text/plain"]).catch(async () =>
          run("xclip", ["-selection", "clipboard", "-t", "UTF8_STRING", "-o"])
            .catch(() => Buffer.alloc(0))
        );
  const text = data.toString("utf8");
  return text.length > 0 ? text : null;
}

/** Reads the OS clipboard on explicit Ctrl+V. Native image data wins over text flavors. */
export async function readClipboard(): Promise<ClipboardContent | null> {
  const os = platform();
  const image =
    os === "darwin"
      ? await macosClipboardImage()
      : os === "win32" || release().includes("WSL")
        ? await windowsClipboardImage()
        : os === "linux"
          ? await linuxClipboardImage()
          : null;
  if (image) return image;
  const text = await clipboardText(os);
  return text === null ? null : { type: "text", text };
}
