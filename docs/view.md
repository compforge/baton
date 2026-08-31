# Baton View

本文定义 Baton 如何把协作事实投影到人的操作界面：TUI 有哪些区域、每类内容映射到哪里、什么属于
当前态、什么进入可回看的历史，以及 Transcript 如何在不损失事实的前提下压缩展示。它不定义 Input、
Turn、Event 和恢复如何流转；这些流程见[工作流](./workflow.md)。Harness IO 见
[Harness](./harness.md)。

## 1. 分层与硬边界

```text
Human
  ↕ keyboard / pointer / screen
chat-tui                         通用终端 UI 库
  ↕ ChatProtocol / ChatState
Baton View Adapter               src/view/chat-tui
  ↕ ViewInput / Projection publication
Baton Core
```

- `chat-tui` 是可被 Baton、Doctor 等产品共同使用的公共库，拥有通用 chat shell、composer、焦点、
  键位、终端渲染与 UI protocol；它不依赖 Baton 的 Session、Plugin、Harness 或 Event 模型。
- `src/view/` 是 Baton 的 View Adapter 领域。内置 `src/view/chat-tui/` 把 chat-tui intent 翻译为
  Baton `ViewInput`，再把 Core `Projection` 投影为 chat-tui `ChatState`。一次成功 publication 形成
  轻量 `ViewOutput`，作为稳定 output 边界而不暴露具体 surface DTO。
- `@compforge/baton-ui` 目前没有独立契约或独立消费者，因此不建立发布包。只有出现第二个进程或仓库
  需要复用“Baton 客户端协议”，且该协议可以脱离宿主运行时独立版本化时，才从 `src/view/` 提取公共包。
  Doctor 复用 chat-tui 本身，不构成这个提取条件。

> **硬规则：展示压缩只能发生在 `SessionState → View` 的投影中。几乎没有任何理由为了少显示几行，
> 改写、合并或丢弃 Ledger / Session 事实；完整原始记录必须保留给 resume、审计和重投影。**

同一条规则适用于 live、resume 和 replay：三者必须从相同事实经相同 View 投影得到相同的可见结果。

## 2. TUI 区域与内容映射

chat-tui 的主壳按概念分成历史区、当前态 dock、输入区、辅助区和浮层。下表定义语义归属，不把当前
像素布局提升为稳定协议。

| 区域 | 展示内容 | 生命周期 / 来源 |
|---|---|---|
| Timeline Header | 当前 Session、Target 等时间线标题 | View 配置；不是历史事实 |
| Transcript | 用户/agent 消息、已完成 reasoning 摘要、工具/文件变更摘要、错误、已完成任务卡片 | 从 Session Projection 派生的可回看历史 |
| Plan Pin | 当前执行计划及 entry 状态 | 活跃计划的当前态；完成或撤下后离开 pin，必要时在 Transcript 留一次结果 |
| Queue | queued follow-up 与尚未 applied 的 steer | Core Queue / Input 投影；属于未来态，不提前进入 Transcript |
| Interaction Dock | approval、question、suggested input | Core `Interaction` 的待决当前态；回答或取消后退出 |
| Activity | `Working`、retry、当前工具等短寿命运行状态 | 当前 Turn 的现在时；完成后消失，不作为历史逐行沉淀 |
| Parallel | 正在运行的 side Lane、原生 subagent 或异步 task | 并行工作的现在时；终结后由 Transcript 任务卡片承接历史 |
| Composer | 草稿、补全、目标模式与提交入口 | View 本地编辑态；提交后成为 `ViewInput` |
| Footer / Toast | 键位提示、一次性操作回执、警告 | View 状态或已确认事实的短寿命反馈 |
| Sidecar / Board | Plugin Board sections 与资源状态 | Board Projection；是共享读模型，不是 Session 历史替代品 |
| Picker / Queue manager | session、command、mention、queue 等选择与管理界面 | 具体 View 的临时 overlay；选择结果再翻译为 typed intent |

区域选择遵循时态，而不是来源：同一个 Harness 事件在执行中可以只贡献 Activity，完成后再贡献
Transcript；同一个 side Lane 在运行中位于 Parallel，结束后进入可回看的任务卡片。View 不复制事实，
只为同一 Projection 选择合适的当前态或历史态表达。

## 3. View input、publication 与 owner

View input 只表达人的语义动作：

```text
chat-tui intent → Baton View Adapter → ViewInput → Channel → Core owner
```

prompt、command、configuration、Interaction response 和 interrupt 都先成为 `ViewInput`。View 可以做
编辑态、焦点和本地 picker 等短寿命交互，但不创建 `HarnessInput`，也不直接调用 Harness 或 Plugin。
Core 决定输入如何持久化、lowering、授权与调度。

View output 只消费 Core 已建立的投影：

```text
Event → Core reducer → Projection → Baton View Adapter → ChatState → chat-tui
                                      └─ publication → ViewOutput
```

View 不从 Ledger 另建状态机，不把“已渲染”解释为“用户已阅读”，也不自行宣布 Turn 或领域 loop 完成。
Plugin 可以通过 `view.input` 和 `view.output` Hook 观察两个边界：前者在持久记录之后、Core lowering
之前 inline 通知，后者在 publication 之后 deferred 通知。Hook 不能替换 `ViewInput` 或修改
`ViewOutput`。

| 内容 | Owner |
|---|---|
| composer 草稿、焦点、键位、终端布局 | chat-tui / 具体 View surface |
| 系统/终端剪贴板读取、写入、格式协商与 fallback | OpenTUI `ClipboardService`；Baton 只解释 representation |
| intent 与 `ViewInput`、Projection 与 `ChatState` 的映射 | Baton View Adapter |
| ViewOutput publication、Queue、Turn、Interaction 与 Event 生命周期 | Baton Core 对应 domain |
| Harness 原生协议和流式输出归一 | Harness Adapter |
| Resource、Connector 与领域完成条件 | Plugin |

Interaction 会由 UI 呈现和收集回答，但 requested/answered/cancelled 生命周期仍归
`src/interaction/`。Queue pane 的召回、删除、重排或立即派发都经 Baton View Adapter 翻译到
Controller/Queue typed path。桌面通知（OSC 9）只观察已确认的 live Event，不产生或修改 Core 事实。

## 4. Transcript 展示策略

Transcript 的目标不是复刻 event log，而是在有限屏幕中保留最高信息密度，并让用户仍能看到上一条
input、关键结论、执行过的 command 和改动过的文件。原始事件量、UI 行数和信息量是三件不同的事。

### 4.1 投影规则

Transcript 先把每条事实投影为原子 block，再只按 Baton 已知语义合并相邻且兼容的 block。每条事实
从第一条起就进入稳定的 `TranscriptGroupItem`；可合并项只追加 members 并更新摘要。chat-tui 只负责
默认收起和 `Ctrl+O` 展开，不反向猜测 Harness effect 或 reasoning 边界。

| 内容 | 默认展示 | 完整信息 |
|---|---|---|
| 用户与 agent 正文 | 保留正文；agent 正文可以流式更新同一条消息 | Session / Ledger 与展开后的 block |
| Reasoning / thought | 流式阶段只在 Activity 显示 `Working`；完成后才把非空有效摘要写入 Transcript；`<!-- -->` 等空占位隐藏 | Session / Ledger 保留 Harness 上报的完整 reasoning；`/thoughts` 控制历史摘要是否可见 |
| 连续只读探索 | 相邻 read/list/search/安全 command 合并成一行有数量和代表动作的摘要 | group members 保留逐项 command、路径和 output |
| 写文件、编辑与 diff | 保留一行文件路径、操作和统计；写操作会打断只读探索组 | members 中保留完整 diff / output |
| 失败与拒绝 | 不藏在成功组里，默认直接可见并保留诊断 | 原始 tool/result 事实 |
| Plan | 活跃时放 Plan Pin，避免和历史重复；结束后按结果保留一次 | 原始 `plan_update` / `plan_remove` 事实 |
| queued / steer | 未执行或未 applied 时只在 Queue；applied 后才进入 Transcript | Input、Attempt 与 delivery receipt |
| side Lane / subagent | 运行中放 Parallel；完成后压成任务卡片进入 Transcript | Lane 内完整 transcript 与事件 |

`Planning`、`Inspecting` 这类文本不是稳定内容类型，只是 reasoning 标题或运行期阶段标签。它们不应
因为英文措辞不同就各占一条历史记录：运行中由 Activity 承载，完成后只有正文确实提供了结论、判断
或下一步时才进入 Transcript。供应商差异必须在 Harness Adapter 的稳定语义与 `raw` 中收住，不能在
chat-tui 写 provider 分支。

### 4.2 参考实现策略

以下是 2026-08-31 对本工作区最新代码的观察，用于解释取舍，不是 Baton 的运行时依赖或兼容契约。
上游行为变化时应重新核对对应 commit。

| 参考实现 | 当时版本 | Reasoning | 工具与长历史 |
|---|---|---|---|
| Codex | `a9519cbc` | delta 不进入主历史，只从首个加粗标题更新当前 status，缺省为 `Working`；final 才生成 reasoning summary，并过滤 `<!-- -->` 空占位 | 连续成功探索可折为 `Ran N commands` / `Explored`；主历史仅保留有限预览，`Ctrl+T` 打开完整 transcript |
| Kimi Code | `96192773` | live thinking 在 transcript 显示末尾 2 行；final 默认保留开头 2 行，可用 `Ctrl+O` 展开 | 普通结果默认 3 行、shell 10 行；长会话保留最近 15 turns，单 turn 的旧 steps/assistant 消息折成 summary |
| OpenCode | `dc4449df` | terminal TUI 的 minimal 模式是一行 `Thinking/Thought`，可点击展开；空或加密占位不显示。Desktop/Web 默认关闭 reasoning summaries | terminal tool output 有行数/字符上限并可展开；Desktop/Web 的 shell/edit 默认收起 |

Codex 的“主历史”和 `Ctrl+T` 完整 transcript 是两个 surface；Baton 当前把主可回看区域命名为
Transcript，因此这里对齐的是 Codex 主历史的信息密度，而不是照搬它的命名。Kimi 把少量 live thinking
放进 transcript，反馈更直接，但仍会持续改变历史区并顶走上一条 input；OpenCode 则更依赖模式与展开。

Baton 当前选择 Codex 风格作为基线：流式 reasoning 只贡献 Activity，final 有效摘要才进入 Transcript；
同时保留 Kimi/OpenCode 的“摘要 + 展开”优点用于工具、diff 和较长结果。这个选择只改变 View 投影，
不改变 Session、Ledger、Harness Adapter 或 Context 注入的事实。

### 4.3 可验证性

展示策略至少覆盖以下回归：流式 thought 不增长 Transcript、final 摘要只出现一次、空占位不可见、
连续只读工具稳定成组、写操作与失败打断分组、展开仍能看到完整 members，以及 live/replay 得到相同
Transcript。测试应围绕 Projection 输入输出，不通过篡改上游事实制造期望 UI。

## 5. 接入另一种 View

新增 Web、IDE 或其它 Human surface 时，应只增加新的 View Adapter：

1. 把 surface intent 完整翻译为现有 `ViewInput`；
2. 通过 Channel 提交，而不是绕过 Core owner；
3. 从 live/replay 共用的 Projection 构建 surface state；
4. 将 Interaction answer 作为 `ViewInput` 回送；
5. 保持 Harness 与 Plugin 分支不进入 View。

若新 surface 暴露了现有 Projection 无法表达的稳定协作事实，应先补 Event/Projection 契约；仅为某个
页面布局服务的字段留在该 View Adapter，不提升为 Core 概念。
