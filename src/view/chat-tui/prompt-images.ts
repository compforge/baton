import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ContentBlock, PromptBlock } from "../../event/index.ts";

const ATTACHMENT_DIRECTORY = "attachments";
const IMAGE_TOKEN_SOURCE = String.raw`\[Image #(\d+)\]`;

export function composerImageToken(index: number): string {
  return `[Image #${index}]`;
}

export async function archiveClipboardImage(
  batonRoot: string,
  data: Uint8Array,
): Promise<{ path: string }> {
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 24);
  const filename = `clipboard-${hash}.png`;
  const directory = join(batonRoot, ATTACHMENT_DIRECTORY);
  const path = join(directory, filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, data, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { path };
}

/** Resolves durable image placeholders into ordered prompt blocks at submit time. */
export function composerPromptBlocks(text: string, imagePaths: readonly string[]): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  let offset = 0;
  for (const match of text.matchAll(new RegExp(IMAGE_TOKEN_SOURCE, "g"))) {
    const index = match.index;
    const imageIndex = Number(match[1]);
    const path = imagePaths[imageIndex - 1];
    // A user may type the same text literally. Only placeholders registered by
    // the active composer become image blocks.
    if (!path) continue;
    if (index > offset) blocks.push({ type: "text", text: text.slice(offset, index) });
    if (!existsSync(path)) {
      throw new Error(`pasted image attachment is missing: ${path}`);
    }
    blocks.push({ type: "image", mimeType: "image/png", path });
    offset = index + match[0].length;
  }
  if (offset < text.length) blocks.push({ type: "text", text: text.slice(offset) });
  return blocks.length > 0 ? blocks : [{ type: "text", text }];
}

/** Reconstructs editable composer text without embedding image bytes or absolute paths. */
export function composerTextOf(blocks: ReadonlyArray<ContentBlock | PromptBlock>): string {
  let imageIndex = 0;
  return blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      const path = block.type === "image" && typeof block.path === "string" ? block.path : undefined;
      if (!path) return "";
      imageIndex += 1;
      return composerImageToken(imageIndex);
    })
    .join("");
}

/** Restores the path registry used by an editable composer from persisted blocks. */
export function composerImagePathsOf(
  blocks: ReadonlyArray<ContentBlock | PromptBlock>,
): string[] {
  return blocks.flatMap((block) =>
    block.type === "image" && typeof block.path === "string" ? [block.path] : []
  );
}
