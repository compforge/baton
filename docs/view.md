# Baton View

本文定义 Baton 的 View 边界。View 负责把人的操作接入 Baton，并把 Baton 的协作状态呈现给人；
它不是第四类参与者，也不拥有 Core 的持久事实。UI 是 View 的一种具体实现技术。Harness IO 见
[Harness](./harness.md)，三方主流程见
[工作流](./workflow.md)。

## 1. 分层

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

目录上的 `src/view/`、`src/harness/`、`src/plugin/` 分别收住 View、Harness、Plugin 三方的接入差异；
三方仍只通过 Core-owned 对象和稳定 verb 协作。

## 2. 入站与出站

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

transcript、queue、Interaction、status、toast、Board 和 picker 都是 Projection 或其 surface 映射。
View 不从 Ledger 另建状态机，不把“已渲染”解释为“用户已阅读”，也不自行宣布 Turn 或领域 loop 完成。

Transcript 先把每条事实投影为原子 block，再只按 Baton 已知语义合并相邻且兼容的 block。think 与
只读工具各有独立 merge key，不彼此合并；副作用未知、写操作、失败和其它可见事实都会结束当前组。
每条 block 事实从第一条起就进入稳定的 `TranscriptGroupItem`；可合并的 think/read 后续只追加 members
并更新摘要，write、失败及其它事实使用不增加展示行的透明单成员 group。chat-tui 只负责默认收起和
Ctrl+O 展开，不反向猜测 Harness effect 或 reasoning 边界。Activity 只显示通用 thinking 状态，不承载
reasoning 标题或正文。

Plugin 可以通过 `view.input` 和 `view.output` Hook 观察这两个边界。前者在持久记录之后、Core lowering
之前 inline 通知；后者在 publication 之后 deferred 通知。Hook 不能替换 ViewInput 或修改 ViewOutput。

## 3. Owner 边界

| 内容 | Owner |
|---|---|
| composer 草稿、焦点、键位、终端布局 | chat-tui / 具体 View surface |
| intent 与 `ViewInput`、Projection 与 `ChatState` 的映射 | Baton View Adapter |
| ViewOutput publication、Queue、Turn、Interaction 与 Event 生命周期 | Baton Core 对应 domain |
| Harness 原生协议和流式输出归一 | Harness Adapter |
| Resource、Connector 与领域完成条件 | Plugin |

Interaction 会由 UI 呈现和收集回答，但 requested/answered/cancelled 生命周期仍归
`src/interaction/`。composer queue 只是 Core Queue 的视图，不是 UI 自己的待执行队列。Session lease、
Channel、Plugin runner 和 Harness Adapter 的创建与关闭属于 Baton host 的装配职责；具体 TUI 入口可以
触发这些 application 操作，但不能把它们提升为 chat-tui 的公共概念。

## 4. 接入另一种 View

新增 Web、IDE 或其它 Human surface 时，应只增加新的 View Adapter：

1. 把 surface intent 完整翻译为现有 `ViewInput`；
2. 通过 Channel 提交，而不是绕过 Core owner；
3. 从 live/replay 共用的 Projection 构建 surface state；
4. 将 Interaction answer 作为 `ViewInput` 回送；
5. 保持 Harness 与 Plugin 分支不进入 View。

若新 surface 暴露了现有 Projection 无法表达的稳定协作事实，应先补 Event/Projection 契约；仅为某个
页面布局服务的字段留在该 View Adapter，不提升为 Core 概念。
