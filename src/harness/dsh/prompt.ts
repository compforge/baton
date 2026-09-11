import { readFile } from "node:fs/promises";
import type { SdkPromptContentBlock } from "@deepseek-ai/dsh-sdk-client";
import type { PromptBlock } from "../../input/blocks.ts";

/** Convert Baton attachments to the SDK's durable inline-image admission format. */
export async function dshPromptInput(blocks: PromptBlock[]): Promise<SdkPromptContentBlock[]> {
  const content: SdkPromptContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type !== "image") throw new Error(`dsh prompt block was not admitted: ${block.type}`);
    const mimeType = block.mimeType;
    if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp" && mimeType !== "image/gif") {
      throw new Error(`dsh adapter does not support image mime type: ${mimeType}`);
    }
    const data = block.data ?? (block.path ? (await readFile(block.path)).toString("base64") : undefined);
    if (!data) throw new Error("dsh image prompt block requires path or base64 data");
    content.push({ type: "image", mimeType, data });
  }
  return content;
}
