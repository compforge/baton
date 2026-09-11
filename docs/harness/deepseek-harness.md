# DeepSeek Harness Adapter

本文只描述 DeepSeek Harness（DSH）相对 [Harness 公共契约](../harness.md) 的协议差异、恢复
策略和当前能力边界。端到端 Input/Event 时序以 [工作流](../workflow.md) 为准，wire shape 以
`@deepseek-ai/dsh-sdk-client`、Adapter 和契约测试为事实来源。

## 1. 接入与配置

Baton 直接使用官方 `@deepseek-ai/dsh-sdk-client` 0.1.5-rc.2 的 `DeepSeekHarness`，由 SDK
解析并启动同版本 `@deepseek-ai/dsh` 的 `sdk` profile，无需另装自维护 Agent SDK 或配置启动命令。
在 DSH 中完成 provider 凭证配置后，可直接选择 `/dsh`：

```yaml
targets:
  dsh:
    harness: dsh
    model: deepseek-flash
    # provider: deepseek-official
    # reasoningEffort: max
    # maxTokens: 49152
    # dshHome: /absolute/path/to/dsh-home
    # patches: [/absolute/path/to/automation.cordis.patch.yml]
```

默认 provider 由官方 SDK 选择。`reasoningEffort`、`maxTokens` 直接交给 SDK；未设置时保留
模型原生默认值。图片需要所选 provider/model 支持视觉输入。子进程继承 Baton 环境与 workspace
cwd，Target 的 `env` 可覆盖环境；Baton 不读取或保存 provider 凭证。

自定义 runtime 可设置 `dshBin`（DSH 的 JavaScript CLI 模块绝对路径）、`profile` 与 `patches`。
旧 `command` 配置会明确报迁移错误：删除它以使用 SDK 自带 runtime，或将自定义启动配置迁入
上述原生选项。旧默认 `model: prod` 也需要改为 `model: deepseek-flash`，或实际配置的模型 ID。
SDK 拥有进程启动、初始化、请求超时和退出清理，Baton 不再维护另一层启动协议。

启动顺序为 `DeepSeekHarness.start()` → `session(id?)` → 发布 HarnessSessionBinding。

## 2. Session 与恢复

DSH SDK session ID 是稳定 HarnessSession identity，也是 v1 resume state 的内容。新会话在
`open()` 时由 SDK 铸造 ID 并立即发布 Binding；已有 resume state 时使用原 ID 建立 session。
取消会关闭当前 runtime，下一轮重新初始化 runtime 后仍以该 ID 继续，因此 BatonSession 内的
恢复路径不依赖进程存活。DSH 只在路由或容量变化时记录 `request/context`；Adapter 将最近一次
effective model 与 context window 一并保存在 DSH 自己的 resume state 中，保证进程重建后仍能
将下一次 usage 配成完整的 context window 快照。

当前 DSH SDK 协议不提供只读历史查询或 session catalog，所以 DSH 不注册外部 Session
Inspector：`baton resume <native-id>` 的自动纳管仍只适用于已经实现 Inspector 的 Harness。
已经进入 BatonSession 的 DSH binding 可以正常随 BatonSession resume。

## 3. 当前 Capability

| Capability | DSH 映射 |
|---|---|
| text / image prompt | `session/prompt.contentBlocks` |
| streaming | `session.event` 中的 assistant chunk/message、tool、usage、todo |
| context window | `request/context` 的有效路由 + `assistant/message.usage` 的当次输入占用快照 |
| subagent lifecycle | `subagent.started` / `subagent.finished` → `task_update` |
| session resume | SDK session ID + Baton v1 resume state |

当前不声明 audio/resource prompt、compact、same-turn steer、Session config、Interaction、
reconcile、approval routing 或 textgen。unsupported prompt block 在 admission 前明确报错；model、
provider 是 runtime 启动配置，不伪装成可热切换的 `/model` 能力。

## 4. Input、取消与终态

空闲时 `sendTurn` 将文本与图片转换为 SDK content blocks，启动 `session.run()` 并返回
`accepted/new_turn`。SDK 负责等待 durable inbox receipt 到 agent idle，Adapter 通过
`onNotification` 消费通知。图片的本地归档文件转为内联 base64，格式校验与持久附件由 DSH 承担。Controller 已经持久化
原始 `user_message` 和 Baton running 开界；Adapter 只报告 DSH 产出与终态。

DSH stdio 协议当前没有 steer。存在活跃 Turn 时，后续输入返回 `rejected`，由 Controller 排成
follow-up，不能在同一原生 session 上并行启动第二轮。

协议也尚未暴露细粒度 cancel。Baton 的取消实现是关闭整个 SDK runtime，等待进程清理后发恰好
一次 `idle/cancelled`；后续输入会创建新 runtime 并使用相同 session ID。该语义比假装原生已确认
单 Turn cancel 更诚实，但代价是取消会重启该 Adapter handle 拥有的进程。

正常、DSH turn error、stream/transport error、cancel 和 host close 都经同一个幂等终态出口。
错误路径先发 `_baton_error_update`，再发 `idle/error`。

## 5. 事件归一

- `assistant/chunk` 的 text/reasoning delta → agent message/thought chunk；
- `assistant/message` → 对应完整 message/thought upsert，并在缺少 usage chunk 时补 usage；
- `request/context` 缓存 effective model 与 context window，但不单独发不完整快照；
  `assistant/message.usage` 将 uncached input、cache read 和 cache write 相加，与缓存路由严格配对后
  生成 `context_window_update`。其中 `modelSelection` 来自 Target 配置，`effectiveModel` 来自 DSH
  路由；
- `tool/call` / `tool/result` → 同一 Baton tool call 的 running/terminal upsert；
- `todo/write` → 带确定性 entry ID 的 plan snapshot，空 snapshot → `plan_remove`；
- `turn/end.reason` → Baton stop reason 与结构化 error；
- `subagent.started` / `subagent.finished` → task lifecycle。

SDK 会同时转发已发现子 agent 的 `session.event`。Adapter 不把子 agent 内部 transcript 混入根
会话，只投影 task lifecycle；所有原生通知仍进入 native trace，映射后的 Event 也在 `raw` 保留
直接上游 notification。

## 6. 代码与测试锚点

- `src/harness/dsh/adapter.ts` — SDK lifecycle、session resume、事件 mapping 与 coarse cancel
- `src/harness/dsh/config.ts`、`prompt.ts` — 原生启动选项与文本/图片输入
- `src/harness/registry.ts` — `dsh` / `deepseek` identity 和 Adapter factory
- `tests/dsh-adapter.test.ts` — binding、mapping、admission、终态与 cancel/reconnect
- `tests/harnesses.test.ts`、`tests/config.test.ts` — registry 与用户配置契约
