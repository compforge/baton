# Baton Plugin

Plugin 让长期领域 loop 拥有自己的 Resource、Controller、Connector 和用户入口，而不把领域模型
固化在 Baton 中。本文定义 Plugin 的理念、运行模型和主流程；公共 TypeScript API 与最短示例见
[`packages/plugin/README.md`](../packages/plugin/README.md)，Resource 删除等细节见
[Resource 生命周期](./resource-lifecycle.md)。

## 1. 理念与边界

Baton Plugin 是 Baton 的领域扩展机制。它用 Resource `spec/status` 保存长期目标与观测，由 Controller
执行 level-based reconcile，并通过 Connector 适配外部系统。

从控制论看，Plugin 是围绕领域目标运行的负反馈控制器：`spec` 给出期望，Controller 先读取最新
Resource，再通过 Connector 重新观察外部事实，根据偏差请求人、Harness 或外部系统采取行动，最后
更新 `status`。下一轮 reconcile 重新执行同一观察过程；完成由领域事实是否收敛到目标决定，不能由
单次 Harness Turn 自行宣布。

```text
read Resource → read external facts through Connector → act → update status
      ▲                                                        │
      └──────── Resource / Source / Watch / cron / requeue ─────┘
```

- `spec` 是用户认可的期望与 Contract；
- `status` 是 Controller 重新观察或计算的当前状态；
- signal 只提示“可能变化”，reconcile 每次重新读取 Resource 与外部事实；
- `ask/confirm/draft/harness` 让 reconcile 可以请求人的决定或 Harness 执行，不要求先把业务穷举成
  DSL。

这些 verbs 扩展的是 reconcile 作用域内的行动方式，不改变 Plugin 的稳定状态模型。Plugin 可以等待
当前调用的终态并组合后续步骤，但不能直接持有 Harness，也不能把进程内调用栈当成恢复状态；长期
loop 仍由 Resource facts 与下一次 level-based reconcile 推进。

### 1.1 三种扩展边界

| 边界 | 职责 |
|---|---|
| **Baton Plugin** | 定义领域 Resource、Controller 与 Connector，观察和推进跨 Session、跨系统的长期 loop |
| **Harness** | Codex、Claude Code 等智能执行协议，负责推理、工具调用和原生 Session |
| **Harness Plugin** | skill、hook、command 等 Harness 内扩展，约束当前 agent 小闭环 |

devloop 属于 Harness Plugin：它规范开发、lint/test、commit 和 PR/MR，不注册为 Baton Plugin。
reqloop 是独立仓库中的 Requirement Loop 项目，也是 Baton Plugin/Marketplace 的一个示例：它拥有
Requirement、Deployment、Evaluation 等领域模型与 Connector。外部系统适配留在 Plugin 内部，
不提升为 Baton 的另一种顶层运行角色。

## 2. 共同模型与事实边界

```text
PluginPackage（不可变交付物）
  └── PluginInstance（用户配置身份）
        └── PluginBinding（当前 BatonSession 的活动绑定）
              ├── Command / Mention / Hook
              ├── Controller / Source / Watch
              └── Runner process
```

- **Package** 由 `pluginId + version` 标识，已安装版本不可原地修改；
- **Instance** 由 `plugin@marketplace` 派生稳定 identity，属于一个 BatonSession，保存 enabled、
  版本与配置；
- **Binding** 拥有当前激活产生的注册与清理动作，不保存领域事实；
- **Resource** 以 `apiVersion/kind` 标识类型，以 `namespace/name/uid` 标识具体对象；
- **Board** 是 Resource presentation 的派生读模型，不是另一份状态。

三类事实保持分层：

| 事实来源 | 拥有什么 |
|---|---|
| BatonSession Event Ledger | Baton 输入、执行、Interaction 与感知历史 |
| Plugin Resource `spec/status` | 领域期望、观测与完成条件 |
| 外部系统 | PR、需求、部署等原生事实 |

它们可以通过 reference 和 reconcile 关联，但不能复制成可独立修改的第二真相源。

## 3. Resource 与 reconcile 流程

### 3.1 Resource

Plugin Resource 使用版本化类型身份：

```text
apiVersion + kind             类型
namespace + name + uid        对象 incarnation
generation                    spec revision
resourceVersion               opaque 并发 token
owner                         同 Instance 内的结构 owner
labels / annotations          可检索分组 / 宽松扩展 metadata
```

`generation` 只随 spec 变化；Controller 可用 `status.observedGeneration` 表达观测水位。labels
使用精确 AND selector，annotations 不参与检索。两者都不能代替 identity、spec、status、owner
或领域引用。

Resource 删除是 reconcile 生命周期，不是立即移除：Baton 先设置 `deletionTimestamp`，向结构
后代级联删除请求，并在 terminating reconcile 成功后最终移除。完整契约见
[Resource 生命周期](./resource-lifecycle.md)。

### 3.2 统一唤醒

```text
Resource change / startup / Source / Watch / cron / requeueAfter
                             │
                             ▼
                    keyed reconcile queue
                             │ same key coalesces
                             ▼
              reconcile(ReconcileContext, latest Resource)
                             │
                   ┌─────────┼─────────┐
                   ▼         ▼         ▼
                status    Connector   Output
```

- 同一 Resource key 不并发 reconcile，不同 key 受 Controller 与 Manager 容量限制；
- **Source** 发现外部对象并 emit primary Resource，不 patch status、不产生 Output；
- **Watch** 把已存 secondary Resource 变化映射成 primary reconcile request；
- **cron Source** 固定周期 enqueue 当前 Resource；
- **`requeueAfterMs`** 表示单个 Resource 动态决定的下一次复查；
- 错误进入同一退避队列，reconcile 必须 level-based、幂等、可重放。

Plugin 对外部系统写入时仍应使用领域自己的幂等键。无法确认是否生效时，先重新观察外部状态再
决定重试，不能因 Runner crash 无条件重复副作用；这个幂等键不进入 `ReconcileContext` verb identity。

Baton-owned Resource 是 Event Ledger 的只读派生视图。当前 `baton.dev/v1alpha1, Kind=Turn`
让 Plugin 用同一 level-based 模型观察 Baton 行为；Plugin 不能修改或重新声明 Baton-owned type。

## 4. PluginContext、ReconcileContext 与 HookContext

三种 Context 对应三种生命周期，不再把所有能力摊平到同一个激活对象：

| Context | 生命周期 | 稳定内容 |
|---|---|---|
| `PluginContext` | 一次 Binding 激活 | Instance、Session、ResourceClient，以及 Command、Mention、Controller、Hook、lifecycle 注册入口 |
| `ReconcileContext` | 一次 Resource reconcile | 冻结的 `snapshot` 与 `verbs` |
| `HookContext` | 一次 Hook 通知 | `stage`、类型化 `subject`、冻结的 `snapshot` 与 `verbs` |

`PluginContext` 只用于装配，注册入口按概念分组为 `commands.register`、`mentions.register`、
`controllers.register`、`hooks.register` 和 `lifecycle.onClose`。`ReconcileContext` 与
`HookContext` 都只通过 `verbs` 请求 Core 动作；它们不能直接持有 Harness，也不提供通用消息总线。

### 4.1 Reconcile 作用域能力

Controller 的第一个参数是 `ReconcileContext`：`snapshot` 提供冻结只读视图，`verbs` 提供
Plugin-facing typed verbs：

- `ask`：请求一个选项或自由文本答案；
- `confirm`：请求 accept / decline 决定；
- `draft`：打开 suggested-input Interaction；用户提交后才创建 HarnessInvocation，并在主 Lane
  形成 user-source Input；
- `harness`：打开 Harness gate Interaction；策略批准后才创建 HarnessInvocation 和
  plugin-source Input，并用 `laneId + newLane` 选择继续既有 Lane 或派生新 Lane。

这些方法不是通用 `send(type, payload)`：`ask/confirm/draft/harness` 都先物化为 Interaction；
`draft/harness` 只有在
对应 Interaction 提交或批准后才能继续物化为 HarnessInvocation。即使宿主策略自动批准 `harness`，
也必须先持久化 Interaction 的 requested/answered 事实。identity、准入和终态由 Baton 决定；Plugin
不能提供 topic、路由 callback 或 Harness 原生 DTO。

每次能力调用都必须带有界正整数 `timeoutMs`，并真实 await 到 `success / dismissed / timeout /
failure`。Core 为当前 reconcile 签发 Plugin execution identity；Interaction 和 HarnessInvocation
关联这个 execution，而不绑定触发 reconcile 的 Resource。等待时保留 async continuation，同时
释放 Controller 并发位和 Manager 总并发位；结果先落 ledger，再取回并发位恢复原调用栈，不重新
enqueue Resource。`requeueAfterMs` 仍只负责 Resource 的时间调度。

`success` 携带业务值：confirm decline 和 Harness gate decline 都是成功回答。用户看到
Interaction 后按 Esc 或关闭卡片返回 `dismissed`；总 deadline 到期返回 `timeout`；Runner/Core
中断、dispatch error 等返回 `failure`，可选 `error` 只用于诊断。draft/harness 的 deadline 覆盖
Interaction gate 与后续整个 HarnessInvocation，不在 gate 通过后重置。

verb 等待期间 Resource 或关联事实仍可能变化。continuation 恢复后，Plugin 应使用带 uid 的
`ResourceClient.get(ref)` 重新取得同一 incarnation 的最新版本并重新验证领域前提；返回
`undefined` 表示该对象已经删除或被同名新 incarnation 取代。等待前的 `resourceVersion` 不能
用于后续 patch，也不能把旧回答应用到 replacement。

Plugin 可以自由组合这些 primitives：有的 gate 由策略自动批准，有的等待用户，再按结果进入
draft、主 Lane 或新 Lane。这个策略属于领域逻辑和宿主 policy，不由 Baton 从 Plugin 类型推断；
Interaction、Harness routing、权限、并发、取消和恢复仍由 Baton 承接。完整契约见
[`@compforge/baton-plugin` README](../packages/plugin/README.md)。

Resource 删除不会替 live Plugin execution 决定 verb 终态；当前调用仍由回答、Esc、timeout 或
failure 收口。Runner/Core 崩溃后不重放进程内调用栈，未完成 verb 在恢复时记录为 failure。

Lane 参数与 Input source 正交：`laneId:"main"` 继续主线，`newLane:true` 从指定 Lane 创建可并行
支线；draft 提交是 user-source，直接 harness 是 plugin-source。Lane 是 BatonSession 原生串并行
边界，不是 Plugin 私有对象、worktree 策略或“前台/后台”标签。`createdFor` 仅记录创建事实，
不会阻止其它 invocation 继续该 Lane。

### 4.2 Hook 通知

Hook 让 Core 把 human、Plugin、Harness 协调路径上的事实通知 Plugin。stage 由三个正交维度组成：

| boundary | direction | phase | stages |
|---|---|---|---|
| `human` | `inbound` / `outbound` | `before` / `after` | `human.inbound.before/after`、`human.outbound.before/after` |
| `harness` | `inbound` / `outbound` | `before` / `after` | `harness.inbound.before/after`、`harness.outbound.before/after` |

direction 沿 Human→Harness 定义：Human 输入和 Core→Harness delivery 属于 inbound，Harness output
和 Core→Human presentation 属于 outbound。Hook 回调返回 `void`，没有 replacement、allow/deny
或控制流返回值；需要副作用时只能调用
`HookContext.verbs`。因此 Hook 是通知面，Verb 是动作面。

`before` 同一 stage 的回调并发执行，Core 等待全部 settled；单个回调抛错或超时只记录结构化日志，
不阻断用户输入或 Harness 主链路。`after` 进入有界、best-effort 的异步队列，不延长主链路。
`human.outbound.after` 只表示 chat-tui state store 已接收 presentation，不代表用户真实看见。

Human inbound 的 typed subject 覆盖 prompt、command、Harness/model/effort/mode configuration、
Interaction response 与 interrupt。Core 先把 `input.received` 写入 Event Ledger，再把带稳定
`inputId/eventId` 的 record 交给 before；lowering 完成后先写 `input.settled`，再触发 after。
prompt lowering 出来的 HarnessInput 使用独立 `messageId`，通过 `parentEventId` 关联 Human Input。
Human outbound 覆盖 transcript、queue、Interaction、status、toast、Board 与 picker 的 state
publication。等待 outbound before 时允许合并连续更新；before Hook 通过 Verb 产生的重入
Interaction 会直接发布并只发送 after，避免 Hook 等待尚未展示给人的问题而自锁。

Harness inbound 的 subject 是一次准备发送的 `HarnessDelivery`。新 Turn 复用持久 Delivery
Attempt 的 identity；steer 的 identity 只关联本次 same-turn send。before 位于 Adapter 调用之前，
after 在 admission receipt 或 throw 后发送，并区分 `accepted/rejected/error`，不等待 Turn 完成。
Harness outbound 的 subject 是已进入 Event Ledger、带 `eventId/seq` 的 `HarnessEventRecord`。
before/after 都发生在 WAL commit 之后，不阻塞 Harness EventSink，也不提供事件替换能力。

### 4.3 Board

Controller 的 `present(resource)` 把一份 Resource 派生为至多一个 Board 条目。Baton 补齐 owner、
Resource reference 和身份，再生成面向用户的 Board view。`present` 只读、可重复，不能修改
Resource 或外部系统。

Board 是共享协作读模型，但不是 Event、Resource 或外部系统的真相源。当前按 Plugin Instance
和 Resource Type 分组排序，每组只展示有限条目，避免一个 Plugin 占满侧栏。持续状态进入
Resource status/Board；toast 只用于一次操作或状态边沿的短寿命反馈。

### 4.4 Mention 与 Context

Mention 提供用户通过 `@` 明确选择的只读 Context。`search` 无副作用，`resolve` 遵守
`maxChars`，不能返回 secret。Binding 关闭时注册整体撤销。

必须区分：

> Board 更新 ≠ Context 已交付 ≠ Harness 已被唤醒。

Plugin presentation 变化只更新读模型；只有用户提交 Input 或 HarnessInvocation 准备执行时，Baton
才组装 Context，并以 DeliveryReceipt 记录 transport 已接受。

## 5. Host 与进程边界

```text
Baton host process
  ├── Interaction / Input / HarnessInvocation
  └── Plugin Manager
        ├── Instance / Resource stores
        ├── reconcile continuation / invocation correlation
        ├── keyed reconcile queues / Sources / Watches / Board cache
        └── Supervisor
              └── Runner process × active Binding
                    └── third-party Package + Connector
```

**Manager** 是 Plugin 侧唯一装配入口，负责恢复 Instance、创建 Binding、安装注册、持久化 Resource、
把 reconcile verbs 先 lowering 到 Baton-owned Interaction、再把批准的执行 gate lowering 到
HarnessInvocation，并控制 reconcile 容量和维护 Board cache。

**Supervisor** 只负责 Runner 子进程的启动、deadline、退出和回收，不理解 Resource 或领域策略。

**Runner** 加载一份 Package，保存 Plugin 回调，通过 IPC 执行 activate、Command、Mention、
Source、Watch、Hook、reconcile、present 和 cleanup。Runner 不直接访问 Baton Store、Controller、Harness
或 TUI。

隔离粒度选择 Binding，因为它同时是注册撤销、局部连接共享和故障回收的原子边界。同一 Package
在不同 Session 的可变状态不能共享；单次调用起进程又会破坏 Source/Connector 生命周期。
进程隔离是故障和调度边界，不是安全沙箱：Plugin 仍以当前用户身份访问文件、网络和子进程。

IPC 只传可结构化克隆的数据。激活完成后注册表封口，避免异步偷注册留下半个 Binding。调用
timeout、非法信封或进程退出时，Manager 撤销 Binding 的 Command、Mention、Hook、Controller、
Source 和 Board，并把该 Runner 尚未完成的 verb 以 `failure` 收口。Resource、Interaction、
HarnessInvocation 和日志保留为事实，但进程内 continuation 不恢复。当前不自动重启失败 Runner，
因为外部副作用可能已经生效却没有回执。Runner 的一般调用 watchdog 在 verb 等待期间暂停；该段
等待由 verb 自己的必填 timeout 约束。

## 6. Plugin authoring 约束

Plugin 只能依赖公共类型包：

```ts
import type { PluginPackage, Resource } from "@compforge/baton-plugin";
```

公共包不导出 Manager、Supervisor、Runner、Store、HarnessAdapter 或 Marketplace。作者必须：

1. 让 activate、Command、Mention、Hook、Source、Watch、reconcile 和 present 等跨边界入口保持 async；
2. 只返回可结构化传输的数据，不返回函数、class instance、stream、socket 或文件句柄；
3. 为 HTTP、DB、Git 和子进程设置 timeout、并发/连接容量、取消与输出上限；
4. 不把 module global 当恢复状态，事实进入 Resource、Event Ledger 或外部系统；
5. Source 和连接响应 abort，清理通过 `context.lifecycle.onClose` 注册，cleanup 能停止订阅和自建进程；
6. 日志使用结构化 `context.logger`，不包含 secret，也不代替 Resource status；
7. 不导入 Baton 私有源码，不解析 Board 展示文本，不直接访问 Harness。

数据目录按 owner 而非 Package version 划分：

| scope | 生命周期与用途 |
|---|---|
| `global` | 当前用户下跨 Project/Session 的 Plugin 数据 |
| `project` | 同 cwd/workspace 跨 Session 的 observation checkpoint 与索引 |
| `session` | 当前 BatonSession 内同 Plugin 共享的数据 |
| `instance` | 当前 PluginInstance 私有执行数据 |

Plugin 只使用 `context.dataDirs`，不自行拼接 `~/.baton`。持久文件带 schema version 并原子替换；
project scope 可能被多 Runner 并发写，需要跨进程锁。Event、Resource、Interaction 和
HarnessInvocation 继续使用宿主 API，不能复制到私有 JSON 形成第二真相源。

## 7. 运行与恢复

启动时，Manager 解析 enabled Instance 和不可变 Package entry，为每个活动 Binding 创建 Runner，
完成 activate 后原子安装注册，再启动 Source、恢复待决 HarnessInvocation/due time 并 initial reconcile。

关闭时先撤销宿主注册，再停止 Source/Runner；Runner 内先 abort Source，再逆序执行 lifecycle cleanup。
禁用、reload 或版本切换不删除持久数据。升级先验证新 Package，关闭旧 Binding 后激活新版本；
失败时恢复旧 Binding。Resource schema migration 由 Plugin 新版本显式完成，Manager 不猜测。

权限采用渐进信任：安装 Plugin 不等于授权 Connector 副作用，时间触发也不会自动扩大权限。
敏感操作必须在具体 operation/scope 上获得可见决议和回执；secret 不进入 Resource、Context、
日志或普通配置文件。

## 8. References

- [`packages/plugin/README.md`](../packages/plugin/README.md) — 公共 API 和最短作者示例
- [Resource 生命周期](./resource-lifecycle.md) — 创建、owner、metadata 与删除状态机
- [Kernel](./kernel.md) — core、Harness 与 Plugin 的顶层边界
- [工作流](./workflow.md) — Input/Interaction 如何进入统一执行路径
- [日志体系](./logging.md) — Plugin 结构化诊断
- reqloop 领域设计：<https://github.com/qiankunli/reqloop/blob/main/docs/reqloop.md>
