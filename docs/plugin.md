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
  └── PluginInstance（用户级启用配置）
        └── PluginBinding（plugin@marketplace + canonical namespace）
              ├── Command / Mention / Hook
              ├── Controller / Source / Watch
              └── Plugin Worker process
```

- **Package** 由 `pluginId + version` 标识，已安装版本不可原地修改；
- **Instance** 由 `plugin@marketplace` 派生稳定 identity，属于用户控制面，保存 enabled、版本与配置；
- **Binding** 由 Instance 与已解析 namespace 共同确定，拥有激活产生的注册与清理动作，不保存领域事实；
- **Resource** 以 `apiVersion/kind` 标识类型，以 `namespace/name/uid` 标识具体对象；
- **Board** 是 Resource presentation 的派生读模型，不是另一份状态。

Package 用 `namespace` 模板声明 Binding 基数：省略或 `v1` 表示用户级一份，`v1/project` 表示
每个 Project 一份，`v1/project/session` 表示每个 Session 一份。Baton 在 Binding 创建前解析成
canonical namespace；ResourceType 本身不携带 scope，同一种 kind 可以出现在不同 namespace。
同一 `plugin@marketplace + canonical namespace` 同时最多一个活动 Binding 和一个 Worker。

三类事实保持分层：

| 事实来源 | 拥有什么 |
|---|---|
| BatonSession Event Ledger | 该 Session 的输入、Harness 执行、Interaction 与感知历史 |
| Plugin Resource `spec/status` | 领域期望、观测与完成条件 |
| 外部系统 | PR、需求、部署等原生事实 |
| Human Inbox | Baton 与 Human 之间的待决、领取、执行回执与复核状态 |

它们可以通过 reference 和 reconcile 关联，但不能复制成可独立修改的第二真相源。

## 3. Resource 与 reconcile 流程

### 3.1 Resource

Plugin Resource 使用版本化类型身份：

```text
apiVersion + kind             类型
canonical namespace + name + uid  对象 incarnation
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
决定重试，不能因 Worker crash 无条件重复副作用；这个幂等键不进入 `ReconcileContext` verb identity。

Baton-owned Resource 是 Event Ledger 的只读派生视图。当前 `baton.dev/v1alpha1, Kind=Turn`
让 Plugin 用同一 level-based 模型观察 Baton 行为；Plugin 不能修改或重新声明 Baton-owned type。

## 4. PluginContext、ReconcileContext 与 HookContext

三种 Context 对应三种生命周期，不再把所有能力摊平到同一个激活对象：

| Context | 生命周期 | 稳定内容 |
|---|---|---|
| `PluginContext` | 一次 Binding 激活 | Instance、canonical namespace、ResourceClient，以及 Command、Mention、Controller、Hook、lifecycle 注册入口 |
| `ReconcileContext` | 一次 Resource reconcile | 冻结的 `snapshot` 与 `verbs` |
| `HookContext` | 一次 Hook 通知 | `stage`、类型化 `subject`、冻结的 `snapshot` 与 `verbs` |

`PluginContext` 只用于装配，注册入口按概念分组为 `commands.register`、`mentions.register`、
`controllers.register`、`hooks.register` 和 `lifecycle.onClose`。`ReconcileContext` 与
`HookContext` 都只通过 `verbs` 请求 Core 动作；它们不能直接持有 Harness，也不提供通用消息总线。

Binding 的 canonical namespace 同时由 `context.instance.namespace` 与 `context.resources.namespace`
暴露。当前 Resource 固定继承该 namespace，Plugin 不能自行选择另一个 Project/Session scope。

### 4.1 Reconcile 作用域能力

Controller 的第一个参数是 `ReconcileContext`：`snapshot` 提供冻结只读视图，`verbs` 提供
Plugin-facing typed verbs：

- `ask`：请求一个选项或自由文本答案；
- `confirm`：请求 accept / decline 决定；
- `draft`：打开 suggested-input Interaction；用户提交后才创建 HarnessInvocation，并在主 Lane
  形成 user-source Input；
- `harness`：打开 Harness gate Interaction；策略批准后才创建 HarnessInvocation 和
  plugin-source Input，并用 `laneId + newLane` 选择继续既有 Lane 或派生新 Lane。

这些方法不是通用 `send(type, payload)`：`ask/confirm/draft/harness` 都先物化为 Human Inbox
action；选定执行 Session 后，再在该 Session 中物化 Interaction；
`draft/harness` 只有在
对应 Interaction 提交或批准后才能继续物化为 HarnessInvocation。即使宿主策略自动批准 `harness`，
也必须先持久化 Inbox 与 Interaction 的决议事实。identity、准入和终态由 Baton 决定；Plugin
不能提供 topic、路由 callback 或 Harness 原生 DTO。

每次能力调用都必须带有界正整数 `timeoutMs`，并真实 await 到 `success / dismissed / timeout /
failure`。Core 为当前 reconcile 签发 Plugin execution identity；Interaction 和 HarnessInvocation
关联这个 execution，而不绑定触发 reconcile 的 Resource。等待时保留 async continuation，同时
释放 Controller 并发位和 Manager 总并发位；结果先落 ledger，再取回并发位恢复原调用栈，不重新
enqueue Resource。`requeueAfterMs` 仍只负责 Resource 的时间调度。

namespace 决定 Inbox 分发而不是绕过 Inbox：global/project action 对 eligible Session 显示 badge，
并至多产生一次瞬时提示；session action 在 Inbox 持久化后直达目标 Session。任一 eligible Session
可以原子 claim global/project action。用户在哪个 Session 决定交给 Agent，就在该 Session 执行；
执行完成后 action 回到 Inbox 的 pending-review 状态。

`success` 携带业务值：confirm decline 和 Harness gate decline 都是成功回答。用户看到
Interaction 后按 Esc 或关闭卡片返回 `dismissed`；总 deadline 到期返回 `timeout`；Worker/Core
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
failure 收口。Worker/Core 崩溃后不重放进程内调用栈，未完成 verb 在恢复时记录为 failure。

Lane 参数与 Input source 正交：`laneId:"main"` 继续主线，`newLane:true` 从指定 Lane 创建可并行
支线；draft 提交是 user-source，直接 harness 是 plugin-source。Lane 是 BatonSession 原生串并行
边界，不是 Plugin 私有对象、worktree 策略或“前台/后台”标签。`createdFor` 仅记录创建事实，
不会阻止其它 invocation 继续该 Lane。

### 4.2 Hook 通知

Plugin 不是 Human 与 Harness 之间的流式 Adapter，因此不定义泛化的 `PluginInput/PluginEvent`。
Core→Plugin 的入口是 activation、command/mention、reconcile 与 Hook；Plugin→Core 的动作通过注册结果、
Resource API、typed Verb 和各扩展点的明确返回值完成。Hook 只是其中单向的观察面，不是 pub/sub 总线或
可改写主链路的 middleware。

Hook 只暴露 View 与 Harness 的四个稳定 IO 边界：

| stage | subject | 时序 |
|---|---|---|
| `view.input` | `ViewInputRecord` | durable record 之后、Core lowering 之前，inline |
| `view.output` | `ViewOutput` | View publication 之后，deferred |
| `harness.input` | `HarnessInputDispatch` | Adapter 调用之前，inline |
| `harness.output` | `BatonEventReference` | HarnessEvent 提交为 Baton Event 之后，deferred |

inline stage 的同类 Hook 并发执行，Core 等待全部 settled；单个 Hook 抛错或超时只记录结构化日志并
fail open。deferred stage 进入有界、best-effort 队列，不延长 View 或 Harness 主链路。
`view.output` 只表示 View 更新已经发布，不代表人真实看见。

Hook 回调返回 `void`，没有 replacement、allow/deny 或控制流返回值；需要副作用时只能调用
`HookContext.verbs`，由 Core 继续执行权限、持久化和生命周期规则。`input.settled`、Adapter admission
和 delivery outcome 是 Core 的 Event、Attempt 或 Snapshot 事实，不为这些内部阶段增加 Hook stage。

`PluginVerbs.harness()` 接收的是 `HarnessInvocationInput`：它先请求 Core 创建并 gate 一次
HarnessInvocation，最终是否 lowering 为 Core-owned `HarnessInput` 由 Core 决定。两个类型不共享名称，
避免把 Plugin 动作请求误认为已经等待 Adapter 执行的 Harness Input。

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

## 5. Daemon、Plugin Host 与进程边界

```text
Baton Daemon（用户级常驻进程）
  ├── Plugin Host（namespace 管理组件）
  │     └── active Binding × canonical namespace
  │           ├── Resource / Controller / reconcile queue
  │           └── Plugin Worker / Package / Connector
  ├── Human Inbox / Board
  └── Session Gateway
          ↕
    Session process × terminal tab
      └── Channel / Harness Adapter / Harness
```

**Baton Daemon** 是控制面进程 owner。关闭一个 terminal tab 只注销对应 Session；global/project
Binding、Resource 与 Worker 继续存在。

**Plugin Host** 是 Daemon 内部模块，不是第二个 daemon，也不是独立进程。它按 canonical namespace
计算并管理 Binding；每个 Binding 持有对应 Resource store、Controller/reconcile queue 和 Worker，
但 Host 不解释 Resource 的领域内容，也不替 Human Inbox 做人的决议。

**Plugin Worker** 加载一份 Package，保存 Plugin 回调，通过 IPC 执行 activate、Command、Mention、
Source、Watch、Hook、reconcile、present 和 cleanup。Worker 不直接访问 Baton Store、Controller、
Harness 或 TUI。

隔离粒度选择 Binding，因为它同时是 namespace、注册撤销、连接共享和故障回收的原子边界。同一
Project 的 project-scoped Package 必须共享一个 Worker；不同 Project 或 session-scoped Binding 仍隔离。
单次调用起进程会破坏 Source/Connector 生命周期。进程隔离是故障和调度边界，不是安全沙箱：
Plugin 仍以当前用户身份访问文件、网络和子进程。

IPC 只传可结构化克隆的数据。激活完成后注册表封口，避免异步偷注册留下半个 Binding。调用
timeout、非法信封或进程退出时，Daemon 撤销 Binding 的 Command、Mention、Hook、Controller、
Source 和 Board，并把该 Worker 尚未完成的 verb 以 `failure` 收口。Resource、Inbox action、
Interaction、HarnessInvocation 和日志保留为事实，但进程内 continuation 不恢复。当前不自动重启
失败 Worker，因为外部副作用可能已经生效却没有回执。Worker 的一般调用 watchdog 在 verb 等待
期间暂停；该段等待由 verb 自己的必填 timeout 约束。Worker invocation 以 `executionId` 关联
child-call；宿主处理 `verb.invoke` 时必须恢复该 execution 的异步因果作用域，不能依赖进程间自动传播。

## 6. Plugin authoring 约束

Plugin 只能依赖公共类型包：

```ts
import type { PluginPackage, Resource } from "@compforge/baton-plugin";
```

公共包不导出 Daemon、Plugin Host、Worker、Manager、Store、HarnessAdapter 或 Marketplace。作者必须：

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
不同 Binding 仍可能并发访问 Plugin 的 global 私有目录，需要跨进程锁。Event、Resource、Interaction 和
HarnessInvocation 继续使用宿主 API，不能复制到私有 JSON 形成第二真相源。

## 7. 运行与恢复

Daemon 启动时解析 enabled Instance 和不可变 Package entry，Plugin Host 按 namespace 计算活动
Binding 并创建 Worker。完成 activate 后原子安装注册，再启动 Source、恢复待决 action/due time 并
initial reconcile。

关闭时先撤销宿主注册，再停止 Source/Worker；Worker 内先 abort Source，再逆序执行 lifecycle cleanup。
禁用、reload 或版本切换不删除持久数据。升级先验证新 Package，关闭旧 Binding 后激活新版本；
失败时恢复旧 Binding。Resource schema migration 由 Plugin 新版本显式完成，Baton 不猜测。

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
