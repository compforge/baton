import { useRenderer } from "@opentui/react";
import { useEffect } from "react";

import type { BatonChatProtocol } from "./protocol/index.ts";

const INSERT_RETRY_LIMIT = 20;
const INSERT_RETRY_MS = 25;

/**
 * 把协议层召回的排队文本注入 composer 编辑器。召回发生在 picker 关闭之后，
 * 焦点回到 composer 有一帧延迟，所以做有限重试；找不到编辑器就放弃
 * （召回本身已完成，toast 已告知用户）。
 */
export function ComposerInsertBridge(props: { protocol: BatonChatProtocol }): null {
  const renderer = useRenderer();

  useEffect(
    () =>
      props.protocol.subscribeComposerInsert((text) => {
        let attempts = 0;
        const tryInsert = (): void => {
          const editor = renderer.currentFocusedEditor;
          if (editor) {
            editor.insertText(text);
            return;
          }
          attempts += 1;
          if (attempts < INSERT_RETRY_LIMIT) setTimeout(tryInsert, INSERT_RETRY_MS);
        };
        setTimeout(tryInsert, 0);
      }),
    [props.protocol, renderer],
  );

  return null;
}
