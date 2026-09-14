import type { SelectRenderable, TabSelectRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
  Transcript,
  type Theme,
  useStoreState,
} from "chat-tui";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { BatonChatProtocol } from "../protocol/index.ts";
import {
  parallelPanelHeight,
  parallelTabItems,
  type BatonParallelItem,
  type ParallelAction,
  type ParallelTab,
} from "./model.ts";

const TABS: ReadonlyArray<{ name: string; description: string; value: ParallelTab }> = [
  { name: "All", description: "All current parallel work", value: "all" },
  { name: "Tasks", description: "Harness-native background tasks", value: "tasks" },
  { name: "Runs", description: "Side Lanes and Harness invocations", value: "runs" },
];

interface ParallelScreenProps {
  protocol: BatonChatProtocol;
  theme: Theme;
  onBack: () => void;
}

export function ParallelScreen(props: ParallelScreenProps): ReactNode {
  const timeline = useStoreState(props.protocol.stateStore, "timeline");
  const terminal = useTerminalDimensions();
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <Transcript
        header={timeline.header}
        items={timeline.items}
        showThoughts={timeline.showThoughts}
        theme={props.theme}
      />
      <ParallelPanel
        protocol={props.protocol}
        theme={props.theme}
        height={parallelPanelHeight(terminal.height)}
        onBack={props.onBack}
      />
    </box>
  );
}

interface ParallelPanelProps {
  protocol: BatonChatProtocol;
  theme: Theme;
  height: number;
  onBack: () => void;
}

interface ParallelNotice {
  readonly text: string;
  readonly tone: "success" | "error";
}

function ParallelPanel(props: ParallelPanelProps): ReactNode {
  useStoreState(props.protocol.stateStore, "parallel");
  const [tab, setTab] = useState<ParallelTab>("all");
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string>();
  const [notice, setNotice] = useState<ParallelNotice>();
  const tabs = useRef<TabSelectRenderable | null>(null);
  const list = useRef<SelectRenderable | null>(null);
  const allItems = props.protocol.listParallelItems();
  const items = parallelTabItems(tab, allItems, query);
  const detail = detailId
    ? allItems.find((item) => item.id === detailId)
    : undefined;

  useEffect(() => {
    if (detailId && !detail) {
      setDetailId(undefined);
      setNotice({ text: "Parallel work finished", tone: "success" });
    }
  }, [detail, detailId]);

  const openSelected = useCallback(() => {
    const key = String(list.current?.getSelectedOption()?.value ?? "");
    if (!items.some((item) => item.id === key)) return;
    setNotice(undefined);
    setDetailId(key);
  }, [items]);

  useKeyboard((key) => {
    if (key.name === "escape") {
      key.preventDefault();
      if (detailId) {
        setDetailId(undefined);
        setNotice(undefined);
      } else {
        props.onBack();
      }
      return;
    }
    if (
      key.name === "tab" ||
      ((detailId || !query) && (key.name === "left" || key.name === "right"))
    ) {
      key.preventDefault();
      if (key.name === "left" || key.shift) tabs.current?.moveLeft();
      else tabs.current?.moveRight();
      return;
    }
    if (detailId) return;
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      if (key.name === "up") list.current?.moveUp();
      else list.current?.moveDown();
      return;
    }
    if (key.name === "return" || key.name === "linefeed" || key.name === "kpenter") {
      key.preventDefault();
      openSelected();
    }
  });

  const chooseTab = (next: ParallelTab) => {
    setTab(next);
    setQuery("");
    setDetailId(undefined);
    setNotice(undefined);
  };

  return (
    <box
      border={["top"]}
      borderColor={props.theme.accent}
      style={{
        height: props.height,
        flexShrink: 0,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: props.theme.overlayBackground,
      }}
    >
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <text fg={props.theme.accent} style={{ width: 12, flexShrink: 0 }}>
          Parallel
        </text>
        <tab-select
          ref={tabs}
          focused={false}
          options={[...TABS]}
          tabWidth={16}
          showDescription={false}
          showUnderline={false}
          showScrollArrows={false}
          wrapSelection
          textColor={props.theme.dim}
          selectedTextColor={props.theme.overlayBackground}
          selectedBackgroundColor={props.theme.accent}
          style={{ flexGrow: 1 }}
          onChange={(_index, option) => {
            if (option) chooseTab(option.value as ParallelTab);
          }}
        />
      </box>

      {detail ? (
        <ParallelDetail
          item={detail}
          protocol={props.protocol}
          theme={props.theme}
          notice={notice}
          onNotice={setNotice}
          onBack={() => {
            setDetailId(undefined);
            setNotice(undefined);
          }}
        />
      ) : (
        <>
          <box
            border
            borderColor={props.theme.border}
            style={{ height: 3, flexShrink: 0, marginTop: 1 }}
          >
            <input
              focused
              value={query}
              width="100%"
              placeholder={`Search ${tab}`}
              onInput={setQuery}
              onSubmit={openSelected}
            />
          </box>
          {items.length > 0 ? (
            <select
              key={`${tab}:${query}`}
              ref={list}
              focused={false}
              style={{ flexGrow: 1, marginTop: 1 }}
              options={items.map((item) => ({
                name: `${item.icon ?? "•"} ${item.name}`,
                description: [item.description, item.progress].filter(Boolean).join(" · "),
                value: item.id,
              }))}
              textColor="#ffffff"
              descriptionColor={props.theme.dim}
              selectedTextColor={props.theme.accent}
              selectedDescriptionColor="#ffffff"
              selectedBackgroundColor={props.theme.border}
              showScrollIndicator
              onSelect={openSelected}
            />
          ) : (
            <text fg={props.theme.dim} style={{ flexGrow: 1, marginTop: 1 }}>
              {emptyMessage(tab, query)}
            </text>
          )}
          {notice ? (
            <text fg={notice.tone === "success" ? props.theme.success : props.theme.error}>
              {notice.text}
            </text>
          ) : null}
          <text fg={props.theme.dim}>
            {"type to search · ↑↓ select · enter view · ←→/tab switch section · esc back"}
          </text>
        </>
      )}
    </box>
  );
}

interface ParallelDetailProps {
  item: BatonParallelItem;
  protocol: BatonChatProtocol;
  theme: Theme;
  notice?: ParallelNotice;
  onNotice: (notice: ParallelNotice) => void;
  onBack: () => void;
}

function ParallelDetail(props: ParallelDetailProps): ReactNode {
  const [acting, setActing] = useState(false);
  const actions = [
    ...props.item.actions.map((action) => actionOption(action)),
    { name: "Back to parallel list", description: "Return to the current section", value: "back" },
  ];

  const runAction = async (value: string): Promise<void> => {
    if (acting) return;
    if (value === "back") {
      props.onBack();
      return;
    }
    if (value !== "stop") return;
    setActing(true);
    try {
      const message = await props.protocol.resolveParallelAction(
        props.item.id,
        value,
      );
      props.onNotice({ text: message, tone: "success" });
    } catch (error) {
      props.onNotice({
        text: `Parallel action failed: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    } finally {
      setActing(false);
    }
  };

  return (
    <box style={{ flexGrow: 1, flexDirection: "column", marginTop: 1 }}>
      <scrollbox style={{ flexGrow: 1 }} focused={false}>
        <text selectable>
          <strong>{props.item.description ?? props.item.name}</strong>
          {`\nKind: ${props.item.kind}`}
          {`\nOwner: ${props.item.name}`}
          {`\nStatus: ${props.item.progress ?? "running"}`}
          {props.item.tokens === undefined
            ? ""
            : `\nTokens: ${props.item.tokens.toLocaleString("en-US")}`}
          <span fg={props.theme.dim}>{`\nID: ${props.item.sourceId}`}</span>
        </text>
      </scrollbox>
      {props.notice ? (
        <text
          fg={props.notice.tone === "success" ? props.theme.success : props.theme.error}
          style={{ flexShrink: 0 }}
        >
          {props.notice.text}
        </text>
      ) : null}
      <select
        focused
        showDescription={false}
        style={{ height: actions.length, flexShrink: 0, marginTop: 1 }}
        options={actions}
        selectedTextColor={props.theme.accent}
        selectedBackgroundColor={props.theme.border}
        onSelect={(_index, option) => {
          if (option) void runAction(String(option.value));
        }}
      />
      <text fg={props.theme.dim}>
        {acting ? "working…" : "↑↓ select · enter action · esc back"}
      </text>
    </box>
  );
}

function actionOption(action: ParallelAction): {
  name: string;
  description: string;
  value: ParallelAction;
} {
  return {
    name: "Stop task",
    description: "Ask the owning Harness to stop this background task",
    value: action,
  };
}

function emptyMessage(tab: ParallelTab, query: string): string {
  if (query.trim()) return "No matching parallel work";
  if (tab === "tasks") return "No background Harness tasks are running";
  if (tab === "runs") return "No side Lanes or Harness invocations are running";
  return "No parallel work is running";
}
