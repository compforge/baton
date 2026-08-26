import type {
  ChatState,
  WritableChatStore,
} from "chat-tui";

import type { Channel } from "../../../channel/index.ts";
import type { EventKind } from "../../../event/index.ts";
import type { ViewOutput } from "../../../plugin/package.ts";

// Transcript reordering and full terminal commits are materially heavier than
// composer painting. Coalesce only streaming facts; terminal and Interaction
// updates still flush immediately.
const STREAM_STATE_FRAME_MS = 100;
const COALESCED_STREAM_EVENT_KINDS: ReadonlySet<EventKind> = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call_content_chunk",
  "usage_update",
  "context_window_update",
]);
const NON_PRESENTATION_EVENT_KINDS: ReadonlySet<EventKind> = new Set([
  "input.received",
  "input.settled",
  "harness_input.updated",
  "_baton_queue_reordered",
]);

function queueStateEqual(
  left: ChatState["queue"],
  right: ChatState["queue"],
): boolean {
  if (left?.manager?.title !== right?.manager?.title) return false;
  const leftItems = left?.items ?? [];
  const rightItems = right?.items ?? [];
  if (leftItems.length !== rightItems.length) return false;
  return leftItems.every((item, index) => {
    const candidate = rightItems[index];
    return (
      candidate !== undefined &&
      item.id === candidate.id &&
      item.text === candidate.text &&
      item.tag === candidate.tag &&
      (item.actions?.join("\u0000") ?? "") ===
        (candidate.actions?.join("\u0000") ?? "")
    );
  });
}

function publishChatState(
  store: WritableChatStore,
  next: ChatState,
): void {
  const timeline = store.getState("timeline");
  const composer = store.getState("composer");
  const queue = store.getState("queue");
  const activity = store.getState("activity");
  const parallel = store.getState("parallel");
  const footer = store.getState("footer");
  store.commit({
    ...(timeline.items === next.timeline.items &&
    timeline.plan === next.timeline.plan &&
    timeline.header === next.timeline.header &&
    timeline.showThoughts === next.timeline.showThoughts
      ? {}
      : { timeline: next.timeline }),
    ...(composer.busy === next.composer.busy &&
    composer.picker === next.composer.picker &&
    composer.interactions === next.composer.interactions &&
    composer.placeholder === next.composer.placeholder
      ? {}
      : { composer: next.composer }),
    ...(queueStateEqual(queue, next.queue)
      ? {}
      : { queue: next.queue }),
    ...(activity.items === next.activity.items
      ? {}
      : { activity: next.activity }),
    ...(parallel === next.parallel ? {} : { parallel: next.parallel }),
    ...(footer.toast === next.footer.toast && footer.text === next.footer.text
      ? {}
      : { footer: next.footer }),
    ...(store.getState("sidecar") === next.sidecar
      ? {}
      : { sidecar: next.sidecar }),
  });
}

function viewOutputKind(
  store: WritableChatStore,
  next: ChatState,
): ViewOutput["kind"] | undefined {
  const timeline = store.getState("timeline");
  const composer = store.getState("composer");
  const queue = store.getState("queue");
  const activity = store.getState("activity");
  const parallel = store.getState("parallel");
  const footer = store.getState("footer");
  if (composer.interactions !== next.composer.interactions) return "interaction";
  if (composer.picker !== next.composer.picker) return "picker";
  if (
    !queueStateEqual(queue, next.queue)
  ) return "queue";
  if (store.getState("sidecar") !== next.sidecar) return "board";
  if (footer.toast !== next.footer.toast) return "toast";
  if (timeline.items !== next.timeline.items || timeline.plan !== next.timeline.plan) {
    return "transcript";
  }
  if (
    timeline.header !== next.timeline.header ||
    timeline.showThoughts !== next.timeline.showThoughts ||
    composer.busy !== next.composer.busy ||
    composer.placeholder !== next.composer.placeholder ||
    activity.items !== next.activity.items ||
    parallel !== next.parallel ||
    footer.text !== next.footer.text
  ) {
    return "status";
  }
  return undefined;
}

/** Owns the chat-tui side of ViewOutput publication. */
export class ChatViewPublisher {
  private streamTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly channel: Channel,
    private readonly store: WritableChatStore,
    private readonly build: () => ChatState,
  ) {}

  event(kind: EventKind): void {
    if (this.closed) return;
    if (NON_PRESENTATION_EVENT_KINDS.has(kind)) return;
    if (COALESCED_STREAM_EVENT_KINDS.has(kind)) {
      this.schedule();
      return;
    }
    this.changed();
  }

  changed(): void {
    if (this.closed) return;
    if (this.streamTimer !== undefined) {
      clearTimeout(this.streamTimer);
      this.streamTimer = undefined;
    }
    // View output has no inline Hook. Start publication immediately so a
    // non-streaming Event and its surface state remain one synchronous edge;
    // Plugin observation is deferred by Channel after the commit.
    void this.publishOnce();
  }

  /** Keep Board updates narrow while still publishing through Channel. */
  boardChanged(): void {
    if (this.closed) return;
    const initial = this.build();
    if (!boardPublicationChanged(this.store, initial)) return;
    void this.channel.publishViewOutput("board", () => {
      if (this.closed) return false;
      const next = this.build();
      if (!boardPublicationChanged(this.store, next)) return false;
      const currentFooter = this.store.getState("footer");
      this.store.commit({
        ...(this.store.getState("sidecar") === next.sidecar
          ? {}
          : { sidecar: next.sidecar }),
        ...(currentFooter.toast === next.footer.toast &&
        currentFooter.text === next.footer.text
          ? {}
          : { footer: next.footer }),
      });
      return true;
    });
  }

  close(): void {
    this.closed = true;
    if (this.streamTimer !== undefined) clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
  }

  private schedule(): void {
    if (this.streamTimer !== undefined) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = undefined;
      this.changed();
    }, STREAM_STATE_FRAME_MS);
  }

  private async publishOnce(): Promise<void> {
    const initial = this.build();
    const kind = viewOutputKind(this.store, initial);
    if (!kind) return;
    await this.channel.publishViewOutput(kind, () => {
      if (this.closed) return false;
      const next = this.build();
      if (!viewOutputKind(this.store, next)) return false;
      publishChatState(this.store, next);
      return true;
    });
  }
}

function boardPublicationChanged(
  store: WritableChatStore,
  next: ChatState,
): boolean {
  const footer = store.getState("footer");
  return (
    store.getState("sidecar") !== next.sidecar ||
    footer.toast !== next.footer.toast ||
    footer.text !== next.footer.text
  );
}
