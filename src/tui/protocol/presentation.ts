import type {
  ChatState,
  WritableChatStore,
} from "chat-tui";

import type { Channel } from "../../channel/index.ts";
import type { EventKind } from "../../event/index.ts";
import type { HumanPresentation } from "../../plugin/package.ts";

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
]);

function publishChatState(
  store: WritableChatStore,
  next: ChatState,
): void {
  const timeline = store.getState("timeline");
  const composer = store.getState("composer");
  const activity = store.getState("activity");
  const footer = store.getState("footer");
  store.commit({
    ...(timeline.items === next.timeline.items &&
    timeline.plan === next.timeline.plan &&
    timeline.header === next.timeline.header &&
    timeline.showThoughts === next.timeline.showThoughts
      ? {}
      : { timeline: next.timeline }),
    ...(composer.busy === next.composer.busy &&
    composer.queued === next.composer.queued &&
    composer.picker === next.composer.picker &&
    composer.interactions === next.composer.interactions &&
    composer.placeholder === next.composer.placeholder
      ? {}
      : { composer: next.composer }),
    ...(activity.items === next.activity.items
      ? {}
      : { activity: next.activity }),
    ...(footer.toast === next.footer.toast && footer.text === next.footer.text
      ? {}
      : { footer: next.footer }),
    ...(store.getState("sidecar") === next.sidecar
      ? {}
      : { sidecar: next.sidecar }),
  });
}

function presentationKind(
  store: WritableChatStore,
  next: ChatState,
): HumanPresentation["kind"] | undefined {
  const timeline = store.getState("timeline");
  const composer = store.getState("composer");
  const activity = store.getState("activity");
  const footer = store.getState("footer");
  if (composer.interactions !== next.composer.interactions) return "interaction";
  if (composer.picker !== next.composer.picker) return "picker";
  if (composer.queued !== next.composer.queued) return "queue";
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
    footer.text !== next.footer.text
  ) {
    return "status";
  }
  return undefined;
}

/** Owns the chat-tui side of Channel outbound publication. */
export class ChatPresentation {
  private streamTimer: ReturnType<typeof setTimeout> | undefined;
  private pending = false;
  private running = false;
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
    // A before Hook may synchronously create an Interaction and wait for its
    // answer. Let the reentrant response travel outbound immediately.
    if (
      this.channel.publishingFromHook ||
      !this.channel.has("human.outbound.before")
    ) {
      void this.publishOnce();
      return;
    }
    this.pending = true;
    void this.flush();
  }

  /** Keep Board updates narrow while still publishing through Channel. */
  boardChanged(): void {
    if (this.closed) return;
    const initial = this.build();
    if (!boardPublicationChanged(this.store, initial)) return;
    void this.channel.outbound("board", () => {
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
    this.pending = false;
  }

  private schedule(): void {
    if (this.streamTimer !== undefined) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = undefined;
      this.changed();
    }, STREAM_STATE_FRAME_MS);
  }

  private async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        this.pending = false;
        await this.publishOnce();
      }
    } finally {
      this.running = false;
      if (this.pending) void this.flush();
    }
  }

  private async publishOnce(): Promise<void> {
    const initial = this.build();
    const kind = presentationKind(this.store, initial);
    if (!kind) return;
    await this.channel.outbound(kind, () => {
      if (this.closed) return false;
      const next = this.build();
      if (!presentationKind(this.store, next)) return false;
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
