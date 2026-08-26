// Activity 运行期轮换提示语料：baton 自身的功能教学，注入 chat-tui 的
// ActivityState.tips（渲染、10s 轮换与宽度截断都由 chat-tui 负责）。
// 模块级常量，投影热路径只引用不分配；文案跟随现有 UI 的英文短句风格。

export const ACTIVITY_TIPS: string[] = [
  "/queue: recall or delete any queued follow-up",
  "/thoughts: toggle agent reasoning in the timeline",
  "ctrl+shift+y: copy the latest agent reply",
  "ctrl+o: expand collapsed tool output",
  'click a "… +N lines" hint to expand just that block',
  "shift+tab: switch input mode",
  "/target: switch HarnessTarget mid-session",
  "@: reference another baton session or plugin context",
  "large pastes collapse into [Pasted #N ~N lines] tokens",
  "↑: recall your latest queued message into the composer",
];
