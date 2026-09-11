import { describe, expect, test } from "bun:test";

import { externalUrlCommand } from "../src/view/chat-tui/external-url.ts";

describe("externalUrlCommand", () => {
  test("uses the platform launcher without a shell", () => {
    expect(externalUrlCommand("https://example.com/pulls/42", "darwin")).toEqual([
      "open",
      "https://example.com/pulls/42",
    ]);
    expect(externalUrlCommand("https://example.com/pulls/42", "linux")).toEqual([
      "xdg-open",
      "https://example.com/pulls/42",
    ]);
    expect(externalUrlCommand("https://example.com/pulls/42", "win32")).toEqual([
      "rundll32.exe",
      "url.dll,FileProtocolHandler",
      "https://example.com/pulls/42",
    ]);
  });

  test("accepts only browser URLs without embedded credentials", () => {
    expect(() => externalUrlCommand("file:///tmp/report", "darwin")).toThrow(
      "Unsupported external URL protocol: file:",
    );
    expect(() =>
      externalUrlCommand("https://user:secret@example.com", "darwin")
    ).toThrow("External URLs with embedded credentials are not supported");
  });
});
