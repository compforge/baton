import { decodePasteBytes } from "@opentui/core";
import { usePaste, useRenderer } from "@opentui/react";

import {
  INPUT_LAYER_PRIORITY,
  useInputBindings,
} from "chat-tui";

import type { BatonChatProtocol } from "./protocol/index.ts";
import type { ClipboardContent } from "./clipboard.ts";

export function ClipboardPasteInput(props: { protocol: BatonChatProtocol }): null {
  const renderer = useRenderer();

  const insertClipboardContent = async (provided?: ClipboardContent): Promise<boolean> => {
    const editor = renderer.currentFocusedEditor;
    if (!editor || !props.protocol.composerAcceptsPaste()) return false;
    const content = await props.protocol.prepareClipboardPaste(provided, editor.plainText);
    if (content === null) return false;
    editor.insertText(content);
    return true;
  };

  // Keymap commands receive a CommandContext argument. Keep this zero-argument
  // wrapper so that context can never be mistaken for provided clipboard bytes.
  const pasteFromSystemClipboard = async (): Promise<boolean> =>
    insertClipboardContent();

  useInputBindings(() => ({
    priority: INPUT_LAYER_PRIORITY.surface + 1,
    commands: [{ name: "baton.composer.paste", run: pasteFromSystemClipboard }],
    bindings: [{ key: "ctrl+v", cmd: "baton.composer.paste" }],
  }));

  // Some terminals report an image-only Cmd+V as an empty bracketed paste.
  // Non-empty text paste remains owned by the focused textarea.
  usePaste((event) => {
    if (!props.protocol.composerAcceptsPaste()) return;
    if (event.metadata?.mimeType === "image/png") {
      event.preventDefault();
      void insertClipboardContent({
        type: "image",
        mimeType: "image/png",
        data: event.bytes,
      });
      return;
    }
    if (decodePasteBytes(event.bytes).length > 0) return;
    event.preventDefault();
    void pasteFromSystemClipboard();
  });

  return null;
}
