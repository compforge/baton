// 终端桌面通知（OSC 9）纯逻辑：能力检测白名单、文案消毒、序列构造与事件路由。
import { describe, expect, test } from "bun:test";

import type { AnyEventEnvelope } from "../src/event/index.ts";
import {
  buildNotificationSequences,
  isInsideTmux,
  MAX_NOTIFICATION_MESSAGE_LENGTH,
  sanitizeNotificationText,
  supportsOsc9Notification,
  TerminalNotifier,
} from "../src/view/chat-tui/notifications.ts";

const ESC = "\x1b";
const BEL = "\x07";

describe("supportsOsc9Notification", () => {
  test("whitelists known OSC 9 terminals", () => {
    for (const termProgram of ["iTerm.app", "WezTerm", "ghostty", "WarpTerminal"]) {
      expect(supportsOsc9Notification({ TERM_PROGRAM: termProgram })).toBe(true);
    }
    expect(supportsOsc9Notification({ TERM: "xterm-kitty" })).toBe(true);
    expect(supportsOsc9Notification({ TERM: "xterm-ghostty" })).toBe(true);
  });

  test("stays silent on unknown terminals", () => {
    expect(supportsOsc9Notification({})).toBe(false);
    expect(supportsOsc9Notification({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
    expect(supportsOsc9Notification({ TERM_PROGRAM: "vscode" })).toBe(false);
    expect(supportsOsc9Notification({ TERM: "xterm-256color" })).toBe(false);
  });
});

describe("isInsideTmux", () => {
  test("detects tmux via TMUX env", () => {
    expect(isInsideTmux({ TMUX: "/tmp/tmux-1000/default,1,0" })).toBe(true);
    expect(isInsideTmux({})).toBe(false);
  });
});

describe("sanitizeNotificationText", () => {
  test("strips control characters and bidi marks, collapses whitespace", () => {
    expect(sanitizeNotificationText("turn\nfinished\tnow")).toBe("turn finished now");
    expect(sanitizeNotificationText(`hello${ESC}]8;;evil${ESC}\\ world`)).toBe(
      "hello ]8;;evil \\ world",
    );
    // bidi override / isolate 控制符被剥掉
    expect(sanitizeNotificationText("a‮b⁦c")).toBe("a b c");
  });

  test("truncates long messages by code points", () => {
    const long = "x".repeat(MAX_NOTIFICATION_MESSAGE_LENGTH + 50);
    const sanitized = sanitizeNotificationText(long);
    expect(Array.from(sanitized)).toHaveLength(MAX_NOTIFICATION_MESSAGE_LENGTH);
    expect(sanitized.endsWith("…")).toBe(true);
  });

  test("empty or control-only input sanitizes to empty", () => {
    expect(sanitizeNotificationText("")).toBe("");
    expect(sanitizeNotificationText(` ${ESC}\x07 `)).toBe("");
  });
});

describe("buildNotificationSequences", () => {
  test("emits OSC 9 terminated by BEL", () => {
    expect(buildNotificationSequences("baton: turn finished", {
      osc9: true,
      tmux: false,
      bell: false,
    })).toEqual([`${ESC}]9;baton: turn finished${BEL}`]);
  });

  test("wraps OSC 9 in tmux DCS passthrough with doubled ESC", () => {
    const [sequence] = buildNotificationSequences("hi", { osc9: true, tmux: true, bell: false });
    expect(sequence).toBe(`${ESC}Ptmux;${ESC}${ESC}]9;hi${BEL}${ESC}${ST}`);
  });

  test("unsupported terminals stay silent unless bell is enabled", () => {
    expect(buildNotificationSequences("hi", { osc9: false, tmux: false, bell: false })).toEqual([]);
    expect(buildNotificationSequences("hi", { osc9: false, tmux: false, bell: true })).toEqual([BEL]);
  });

  test("empty messages produce no sequences", () => {
    expect(buildNotificationSequences("  ", { osc9: true, tmux: false, bell: true })).toEqual([]);
  });
});

const ST = "\\";

function fakeEvent(kind: string, payload: unknown): AnyEventEnvelope {
  return { kind, payload } as unknown as AnyEventEnvelope;
}

describe("TerminalNotifier", () => {
  function notifierWith(env: NodeJS.ProcessEnv, config = { enabled: true, bell: false }) {
    const written: string[] = [];
    const notifier = new TerminalNotifier({
      config,
      sessionTitle: () => "my session",
      env,
      write: (sequence) => written.push(sequence),
    });
    return { notifier, written };
  }

  const osc9Env = { TERM_PROGRAM: "iTerm.app" };

  test("notifies when a turn finishes, unless the user cancelled it", () => {
    const { notifier, written } = notifierWith(osc9Env);
    notifier.handleEvent(fakeEvent("_baton_turn_summary", { turnId: "t_1", toolCalls: [] }));
    expect(written).toEqual([`${ESC}]9;baton: turn finished · my session${BEL}`]);

    written.length = 0;
    notifier.handleEvent(fakeEvent("_baton_turn_summary", {
      turnId: "t_2",
      stopReason: "cancelled",
      toolCalls: [],
    }));
    expect(written).toEqual([]);
  });

  test("notifies on blocking interactions only", () => {
    const { notifier, written } = notifierWith(osc9Env);
    notifier.handleEvent(fakeEvent("interaction.requested", {
      interactionId: "i_1",
      kind: "permission",
      title: "Run rm -rf?",
      options: [],
    }));
    expect(written).toEqual([`${ESC}]9;baton: needs your input · Run rm -rf?${BEL}`]);

    written.length = 0;
    notifier.handleEvent(fakeEvent("interaction.requested", {
      interactionId: "i_2",
      kind: "question",
      questions: [{ questionId: "q1", header: "Pick one", question: "Which option?" }],
    }));
    expect(written).toEqual([`${ESC}]9;baton: needs your input · Pick one${BEL}`]);

    // suggested_input 不阻断用户，不通知。
    written.length = 0;
    notifier.handleEvent(fakeEvent("interaction.requested", {
      interactionId: "i_3",
      kind: "suggested_input",
      title: "Try this",
      text: "suggestion",
    }));
    expect(written).toEqual([]);
  });

  test("does nothing when disabled or on unsupported terminals", () => {
    const event = fakeEvent("_baton_turn_summary", { turnId: "t_1", toolCalls: [] });

    const disabled = notifierWith(osc9Env, { enabled: false, bell: false });
    disabled.notifier.handleEvent(event);
    expect(disabled.written).toEqual([]);

    const unsupported = notifierWith({ TERM_PROGRAM: "Apple_Terminal" });
    unsupported.notifier.handleEvent(event);
    expect(unsupported.written).toEqual([]);

    const bell = notifierWith({ TERM_PROGRAM: "Apple_Terminal" }, { enabled: true, bell: true });
    bell.notifier.handleEvent(event);
    expect(bell.written).toEqual([BEL]);
  });
});
