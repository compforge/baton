import type { ClipboardService } from "@opentui/core";
import { ChatShell, type Theme } from "chat-tui";
import {
  forwardRef,
  useImperativeHandle,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { PluginScreen } from "./plugins/screen.tsx";
import { ClipboardPasteInput } from "./clipboard-paste.tsx";
import { BatonChatProtocol } from "./protocol/index.ts";

export interface BatonTuiHandle {
  openPlugins(): void;
}

interface BatonTuiProps {
  protocol: BatonChatProtocol;
  theme: Theme;
  clipboard: ClipboardService;
}

/**
 * Keep screen changes inside one React tree. Imperative root.render() calls from
 * a key handler can leave OpenTUI pointing at the input that was just removed.
 */
export const BatonTui = forwardRef<BatonTuiHandle, BatonTuiProps>(
  function BatonTui(props, ref): ReactNode {
    const [screen, setScreen] = useState<"chat" | "plugins">("chat");
    const [, setProtocolRevision] = useState(0);

    useEffect(
      () =>
        props.protocol.subscribeCompletions(() =>
          setProtocolRevision((value) => value + 1),
        ),
      [props.protocol],
    );

    useImperativeHandle(ref, () => ({
      openPlugins() {
        setScreen("plugins");
      },
    }));

    if (screen === "plugins") {
      return (
        <PluginScreen
          protocol={props.protocol}
          registry={props.protocol.marketplace}
          manager={props.protocol.pluginManager}
          theme={props.theme}
          onBack={() => setScreen("chat")}
        />
      );
    }

    return (
      <>
        <ClipboardPasteInput protocol={props.protocol} clipboard={props.clipboard} />
        <ChatShell
          protocol={props.protocol}
          commands={props.protocol.commands}
          mentions={props.protocol.mentionCandidates}
          theme={props.theme}
          clipboard={props.clipboard}
        />
      </>
    );
  },
);
