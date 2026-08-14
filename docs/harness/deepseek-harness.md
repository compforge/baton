# DeepSeek Harness Adapter

本文只描述 DeepSeek Harness（DSH）相对 [Harness 公共契约](../harness.md) 的协议差异、恢复
策略和当前能力边界。端到端 Input/Event 时序以 [工作流](../workflow.md) 为准，wire shape 以
`@compforge/dsh-agent-sdk`、Adapter 和契约测试为事实来源。

## 1. 接入与配置

Baton 通过 `@compforge/dsh-agent-sdk` 启动 DSH JSON-RPC runtime 子进程。runtime 必须包含
`@deepseek-ai/dsh-sdk-jsonrpc-server`，启动 argv 由用户在 `~/.baton/config.yaml` 显式提供：

```yaml
targets:
  dsh:
    harness: dsh
    command:
      - dsh-jsonrpc-agent
      - /absolute/path/to/cordis.yml
    # provider 可选；Baton 默认使用 prod
    provider: deepseek-official
    model: prod
```

未配置 DSH Target 的 `command` 不影响 Codex 或 Claude Code；只有选择该 Target 时 open 才会给出可操作的
配置错误。子进程继承 Baton 环境与当前 workspace cwd；Baton 不读取或保存 provider 凭证，也不
覆盖 SDK runtime/provider 的输出 token 上限。

启动顺序为：

```text
create DshClient → initialize runtime → select/create native session
                 → publish HarnessSessionBinding
```

## 2. Session 与恢复

DSH SDK session ID 是稳定 HarnessSession identity，也是 v1 resume state 的内容。新会话在
`open()` 时由 SDK 铸造 ID 并立即发布 Binding；已有 resume state 时使用原 ID 建立 session。
取消会关闭当前 runtime，下一轮重新初始化 runtime 后仍以该 ID 继续，因此 BatonSession 内的
恢复路径不依赖进程存活。

当前 DSH SDK 协议不提供只读历史查询或 session catalog，所以 DSH 不注册外部 Session
Inspector：`baton resume <native-id>` 的自动纳管仍只适用于已经实现 Inspector 的 Harness。
已经进入 BatonSession 的 DSH binding 可以正常随 BatonSession resume。

## 3. 当前 Capability

| Capability | DSH 映射 |
|---|---|
| text prompt | `session/prompt.contentBlocks` |
| streaming | `session.event` 中的 assistant chunk/message、tool、usage、todo |
| subagent lifecycle | `subagent.started` / `subagent.finished` → `task_update` |
| session resume | SDK session ID + Baton v1 resume state |

当前不声明 image/audio/resource prompt、compact、same-turn steer、Session config、Interaction、
reconcile、approval routing 或 textgen。unsupported prompt block 在 admission 前明确报错；model、
provider 是 runtime 启动配置，不伪装成可热切换的 `/model` 能力。

## 4. Input、取消与终态

空闲时 `sendTurn` 调用 SDK `session.send()` 并返回 `accepted/new_turn`。Controller 已经持久化
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
- `tool/call` / `tool/result` → 同一 Baton tool call 的 running/terminal upsert；
- `todo/write` → plan snapshot；
- `turn/end.reason` → Baton stop reason 与结构化 error；
- `subagent.started` / `subagent.finished` → task lifecycle。

SDK 会同时转发已发现子 agent 的 `session.event`。Adapter 不把子 agent 内部 transcript 混入根
会话，只投影 task lifecycle；所有原生通知仍进入 native trace，映射后的 Event 也在 `raw` 保留
直接上游 notification。

## 6. 代码与测试锚点

- `src/harness/dsh/adapter.ts` — SDK lifecycle、session resume、事件 mapping 与 coarse cancel
- `src/harness/registry.ts` — `dsh` / `deepseek` identity 和 Adapter factory
- `tests/dsh-adapter.test.ts` — binding、mapping、admission、终态与 cancel/reconnect
- `tests/harnesses.test.ts`、`tests/config.test.ts` — registry 与用户配置契约
