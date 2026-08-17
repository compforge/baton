# Claude Code Harness Adapter

本文只描述 Claude Code 相对 [Harness 公共契约](../harness.md) 的协议差异、恢复策略和非显而易见
取舍。端到端 Input/Event 时序以 [工作流](../workflow.md) 为准，具体 SDK shape 以 Adapter 和
契约测试为事实来源。

## 1. 接入方式

Baton 通过 Claude Agent SDK 的 streaming `query()` 接入 Claude Code。SDK 启动本机 Claude CLI，
继承本机环境与登录态；Baton 不持有凭证。真实 Session 显式恢复 Claude Code 的 system prompt、
settings source、Plugin 与 MCP 配置，使其行为尽量接近直接运行 Claude Code。

`open()` 只登记运行时，不立即创建 SDK query。首个 `sendTurn` 才建立长生命周期 streaming
query 和 prompt channel，因此冷启动成本属于第一轮 admission；Adapter 必须在 query 异常和
关闭路径收口活跃 Turn。

Target probe 与真实 Session 分离。probe 使用不可持久化、禁用 tools/MCP 的独立 query，只做
initialize/control 握手并发现 model、effort 和 command；它不创建用户消息或可恢复 Session。

## 2. Session 与恢复

Claude `session_id` 是稳定 HarnessSession identity。resume state 已知时，Adapter 可在 open
立即发布 Binding；新 Session 的 identity 要等 SDK 首个 `system/init`，此时通过 Binding sink
发布。

旧版本曾把 Baton 进程内 `hs_` handle 当作原生 Session ID。迁移判断只留在 Claude Adapter
边界：遇到该形状时不尝试 resume，等待新 init 发布真实 identity；core 不学习 Claude ID
方言。

模型、effort 或 mode 改变可能要求替换 query options。配置只影响后续 Turn，不能在活跃 Turn
中切换 mode；替换旧 query 时必须让旧消费循环退出而不伪造错误终态。

## 3. 当前 Capability

| Capability | Claude Code 映射 |
|---|---|
| text prompt | streaming prompt channel 中的 `SDKUserMessage` |
| image prompt | Adapter 读取 path-backed block，并转成 SDK base64 image block |
| compact | 在空闲 Session 中发送原生 `/compact` control Turn |
| Session config | model、effort、permission mode |

当前不声明独立 Context sync、submit side-channel、reconcile、approval routing、audio、
embedded resource 或 resource link。跨 Harness catch-up 因此回落到预算受控的 prompt prepend；
unsupported prompt block 在 admission 前明确报错。

Claude Agent SDK 当前没有与 Codex `thread/read.status` 等价的权威 live 状态查询，因此 stall 只做
Harness-neutral 的 L1 notice，不根据启发式采样自动 finalize。用户可以继续等待或 cancel。

## 4. Input 与控制映射

空闲时 `sendTurn` 确保 streaming query 存在，把消息 offer 给 prompt channel，并返回
`new_turn`。Controller 已经持久化原始 `user_message` 和 Baton running 开界，Adapter 不重复发送。

运行中且 Baton turn ID 匹配时，同一 prompt channel 接受新的 `SDKUserMessage`，登记
调用方签发的 UUID，并补 `delivery:"steer"` 用户消息正文。Adapter 声明
`steering: { deliveryTracking: "explicit", cancelOwnership: "survives" }`。
Turn 不匹配或 channel 已关闭时返回 `rejected`，由 Controller 排成 follow-up。

Claude CLI 的投递回执是 Queue 事实源，经一等事件 `input_delivery_update` 报告：
`command_lifecycle.queued` 仍留在 Composer Queue；`started` / `completed` 报告 `applied`
并进入 Transcript；`cancelled` / `discarded` 报告 `failed` 并生成 warning。消息直接折入活跃
Turn 时可能没有 lifecycle frame，此时 success result 的 `user_message_uuid` 是关联后的
`applied` 回执。CLI 可能让 queued command 跨过当前 Turn 才启动，回执允许迟到于 Turn 收口，
只补 `deliveryOutcome`，不回迁 status。

Harness 自行开始的 Turn 没有对应 Queue item。后台消息在上一 Queue-driven Turn 结束后到达时，
Adapter 铸造新的普通 Turn；下一条 Human Input 到达前会先明确收口该 Turn，避免两类消息共用
`currentTurn` 发生归属混淆。

cancel 调用 SDK `interrupt()`，但保持 streaming query 存活，等待 SDK result 或消费循环给出
`idle/cancelled`。close 主动关闭 channel/query；仍有活跃 Turn 时合成 cancelled 终态。

## 5. Interaction 与输出

Claude SDK 的 `canUseTool` 是用户协作入口：

- `AskUserQuestion` → question Interaction；
- 普通工具权限 → permission Interaction；
- `ExitPlanMode` → Baton 捕获 proposed plan，并拒绝继续自动实施，等待用户后续确认。

Adapter 通过 `OpenInteraction` 等待 Baton result，再返回 SDK `PermissionResult`。Interaction ID 和生命周期由
Controller 拥有，Claude `toolUseID` 只用于关联原生请求。

主要输出映射包括：

- assistant text/thinking 与 partial message → agent message/thought；
- tool_use/tool_result → tool lifecycle；
- Edit/Write 等工具输入 → DiffBlock；
- TodoWrite → 带确定性 entry ID 的 plan snapshot；TaskCreate/TaskUpdate 保留原生 task ID，删除最后
  一个 entry 时发 `plan_remove`；两条路径都抑制重复工具卡；
- task started/progress/notification → task lifecycle；
- result modelUsage → usage、context window 与 cost snapshot；
- result、query error、stream close → Turn 终态。

Agent SDK 的一条 streaming query 可以跨多个 Turn 长期存在，因此终态必须绑定具体
`ClaudeTurn`；旧消费循环的迟到结束不能终结新 Turn。

## 6. SDK 演进边界

Claude Agent SDK 与 Claude Code 会快速演进，Baton 持续升级 SDK，但不以功能逐项对齐为目标。
升级与协议采纳分开判断：进程、hook、streaming 和类型修复可以直接受益；新增 wire 事实只有在
加强现有 Baton 语义时，才由 Claude Adapter 归一。

- assistant 的 `aborted`、result 的 `terminal_reason` / `api_error_status` 可以细化既有消息与 Turn
  终态；model usage 的 canonical model / provider、时间戳和 subagent retry 等观测信息可以按需
  进入现有 usage、task、日志或 `raw`，不为它们新增 core 概念。
- message UUID、command lifecycle 和 interrupt receipt 等只服务 Claude 投递、关联或中断正确性的
  事实留在 Adapter 内；`sendTurn` 仍只表达 admission，`cancel` 的权威确认仍是最终
  `idle/cancelled` Event。
- 公开 protocol capability 与 changelog 已定义、但 TypeScript `SDKMessage` 联合暂未跟上的
  frame，可以在 Adapter wire 边界做最小结构窄化，不向 core 扩散。只能靠版本猜测或解析
  SDK 私有实现的字段不接入；未知 wire 保守保留在 `raw` 或显式 ignored inventory。

只有 Controller 必须依据某个事实改变 Input / Turn 状态，并且该事实能形成跨 Harness 的 owner、
生命周期和恢复语义时，才把它提升为公共 Event、receipt 或 Capability；单家 Claude 方言不修改
`HarnessAdapter`。

## 7. 外部 Session Inspector

只读 Inspector 使用 SDK 的 `getSessionInfo()` 和 `getSessionMessages()`：

1. 读取 identity、cwd、custom title/summary/first prompt；
2. 把 durable user/assistant/tool/thinking blocks 映射为 Baton Turn；
3. 剥离 Baton 历史注入标签，避免 Context 被误认作用户输入；
4. 计算完整 `HarnessHistoryBoundary`。

`getSessionInfo()` 可能对没有可提取 summary 的有效 Session 返回空，因此消息列表也是存在性
兜底。durable history 不提供可靠 stop reason，Inspector 使用 `unknown`，不能伪造 `end_turn`。

## 8. 代码与测试锚点

- `src/harness/claude/adapter.ts` — streaming query、Interaction、Capability 与 mapping
- `src/harness/claude/settings.ts` — Claude settings、Plugin 与 MCP 加载
- `src/harness/claude/native-session.ts` — 只读历史 Inspector
- `tests/claude-send-turn.test.ts`、`tests/claude-turn-race.test.ts` — submit/steer 与终态竞速
- `tests/adapter-model.test.ts`、`tests/config.test.ts` — model、effort 和 mode
- `tests/native-session-providers.test.ts`、`tests/adapter-mapping.test.ts` — 历史纳管与交互映射
