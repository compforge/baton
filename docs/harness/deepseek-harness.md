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
| same-turn steer | 原生 `session/prompt` 入队，`agent/inbox/spliced` 确认消费 |
| session resume | SDK session ID + Baton v1 resume state |

当前不声明 audio/resource prompt、compact、Session config、Interaction、
reconcile、approval routing 或 textgen。unsupported prompt block 在 admission 前明确报错；model、
provider 是 runtime 启动配置，不伪装成可热切换的 `/model` 能力。

## 4. Input、取消与终态

空闲时 `sendTurn` 将文本与图片转换为 SDK content blocks，通过官方 `HarnessClient.prompt`
提交，使用官方 `subscribeSessionTree` 接收通知。图片的格式校验与持久附件由 DSH 承担。
`DeepSeekHarness` 继续拥有启动与 session identity；单 prompt 的 `session.run()` 不适用于 Baton
一个 Turn 承载多条输入的投递追踪，因此 Adapter 用 SDK 的底层公开接口关联 Input 与原生消息 ID，
不复制 stdio、JSON-RPC 或进程清理实现。

存在匹配的活跃 Turn 时，追加和 Queue 的 dispatch-now 走同一 `session/prompt`，返回
`accepted/steer`。RPC response 只证明入队；`agent/inbox/spliced.inserted` 才产生
`input_delivery_update(applied)`。通知可能早于 response，关联前暂存回执；根消息与所有追加输入
都已消费且收到 agent idle 后才收口一个 Baton Turn。不同 Turn 或清理期间的追加会被拒绝并保留在
Baton Queue。原生明确拒绝只将对应追加标为 `failed`，不结束仍运行的主输入。

协议尚未暴露细粒度 cancel。Baton 关闭整个 SDK runtime，必须等 SDK 证明进程退出后才发
`idle/cancelled`。即使 Core cancel grace 提前收口，下一次 admission 也会等待同一清理 Promise；
清理失败时阻止创建替代 runtime。transport 失败同样先清理，下一条用原 session ID 重连，
不会重放失败的当前输入。

DSH 声明 explicit delivery tracking，并由 Adapter 保留取消时的投递判定责任（`survives`），
不授权 Core 在 cancel 前直接回收原生 pending 输入。取消或断线后未观察到消费回执，不足以证明
输入没有执行：这些输入落 `uncertain` 并显示警告，恢复时不自动重发，用户确认结果后再决定。
尚未交给 DSH 的 Baton queued 输入仍可撤回、删除、重排，并在当前 Turn 结束后继续。

正常、DSH turn error、transport error、cancel 和 host close 经同一个幂等终态出口。
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
- `src/harness/dsh/activity.ts` — 原生 inbox 消息、消费回执与单 Turn 活动边界
- `tests/dsh-queue.test.ts` — 官方 SDK + 子进程的追加、取消、重连和 Controller Queue 集成
- `src/harness/dsh/config.ts`、`prompt.ts` — 原生启动选项与文本/图片输入
- `src/harness/registry.ts` — `dsh` / `deepseek` identity 和 Adapter factory
- `tests/dsh-adapter.test.ts` — binding、mapping、admission、终态与 cancel/reconnect
- `tests/harnesses.test.ts`、`tests/config.test.ts` — registry 与用户配置契约
