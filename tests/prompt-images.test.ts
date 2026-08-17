import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { claudeUserMessage } from "../src/harness/claude/adapter.ts";
import {
  archiveClipboardImage,
  composerPromptBlocks,
  composerTextOf,
} from "../src/view/chat-tui/prompt-images.ts";

describe("clipboard prompt images", () => {
  test("archives image bytes in the Baton attachment store and resolves the placeholder in order", async () => {
    const batonRoot = await mkdtemp(join(tmpdir(), "baton-prompt-image-"));
    try {
      const image = Uint8Array.from([137, 80, 78, 71]);
      const archived = await archiveClipboardImage(batonRoot, image);
      expect(await readFile(archived.path)).toEqual(Buffer.from(image));

      const blocks = composerPromptBlocks("before [Image #1] after", [archived.path]);
      expect(blocks).toEqual([
        { type: "text", text: "before " },
        { type: "image", mimeType: "image/png", path: archived.path },
        { type: "text", text: " after" },
      ]);
      expect(composerTextOf(blocks)).toBe("before [Image #1] after");
    } finally {
      await rm(batonRoot, { recursive: true, force: true });
    }
  });

  test("leaves an unregistered image marker as literal text", () => {
    expect(composerPromptBlocks("inspect [Image #1]", [])).toEqual([
      { type: "text", text: "inspect [Image #1]" },
    ]);
  });

  test("Claude hydrates a path-backed image into the SDK base64 image block", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "baton-claude-image-"));
    try {
      const path = join(sessionDir, "image.png");
      await writeFile(path, "hello");
      const message = await claudeUserMessage([
        { type: "text", text: "inspect" },
        { type: "image", mimeType: "image/png", path },
      ]);
      expect(message.message.content).toEqual([
        { type: "text", text: "inspect" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
        },
      ]);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});
