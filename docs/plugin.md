# Baton Plugin 设计

> 本文分成两部分：第一部分面向 Baton 维护者，定义 Manager、Supervisor、Runner 和持久状态的
> 边界；第二部分面向三方 Plugin 作者，定义 `@compforge/baton-plugin` 的使用规范。
> Baton 的全局进程与线程模型见 [kernel](./kernel.md)，长期 loop 的产品位置见
> [Loop Engineering](./loop-engineering.md)。

## 1. 共同模型

Plugin 让长期领域 loop 在不进入 Baton core 的前提下拥有自己的 Resource、Controller、
Connector 和用户入口。Baton 不理解 Requirement、Deployment、Review 等领域语义，只提供
生命周期、调度、持久化、权限、Board、Context 和受控输出。

```text
PluginPackage（不可变交付物）
    └── PluginInstance（用户配置）
          └── PluginBinding（当前 BatonSession 的一次活动绑定）
                ├── Command / ContextProvider
                ├── Controller / Source / Watch
                └── Runner process
```

- **Package** 由 `pluginId + version` 标识；已安装版本不可原地修改。
- **Instance** 由 `plugin@marketplace` 派生稳定 `pluginInstanceId`，保存 enabled、版本与配置。
- **Binding** 是一次临时激活，拥有全部注册与清理动作，不保存领域事实。
- **Resource** 以 `spec` 表达期望，以 `status` 表达观测；属于当前 BatonSession。
- **Board** 是 Resource 的派生展示，不是另一份状态。

外部平台继续拥有其事实，Session Event Ledger 继续拥有 Baton 执行历史，Plugin Resource
拥有领域期望与观测。三者不能互相冒充。

## 2. 面向 Baton 维护者：Plugin host

### 2.1 组件边界

```text
Baton host process
  └── Manager
        ├── Instance / Resource / Proposal / Interaction stores
        ├── reconcile queues、Sources、Watches、Board cache
        └── Supervisor
              └── one Runner process per active Binding
                    └── third-party Package + Connector
```

**Manager** 是唯一装配入口。它负责恢复 Instance、创建 Binding、注册代理、控制 reconcile
容量、持久化结果、维护 Board 缓存，并在关闭时按依赖逆序撤销。

**Supervisor** 只负责子进程生命周期：创建 Runner、设置调用 deadline、观察退出、强制回收
失去响应的进程，以及关闭全部 Runner。它不理解 Resource 或领域策略。

**Runner** 加载一份 Package，保存 Plugin 回调，并通过 IPC 执行 `activate`、Command、
ContextProvider、Source、Watch、`reconcile`、`present` 和 cleanup。Runner 不直接访问 Baton
Store、Controller、Harness 或 TUI。

产品路径中的 Marketplace Plugin 必须进入 Runner。进程内 Package 入口只保留给 Baton 自身的
可信内建能力和单元测试 seam，不能成为三方 Plugin 的回退路径。

### 2.2 为什么按 Binding 分进程

隔离粒度选择 Binding，而不是 Package 或单次调用：

1. Binding 已经是注册、关闭和故障撤销的原子边界；
2. 同一 Package 在不同 Session 的配置、Resource 与 Connector 不应共享可变全局状态；
3. 同一 Binding 内的 Source、Controller 和 cleanup 需要共享局部连接与缓存；
4. 单次调用起进程会丢失上述生命周期，并引入不必要的启动成本。

一个 Plugin 的同步死循环、同步子进程或模块加载不会占用 Baton 的 UI 事件循环。它仍会阻塞
自己的 Runner；调用 deadline 到期后，Supervisor 终止该 Runner，Manager 撤销整个 Binding。

进程隔离是**故障与调度边界，不是安全沙箱**。Plugin 仍以当前用户身份访问文件、环境变量、
网络和子进程。权限声明、secret 注入、签名与 OS sandbox 是另一层安全能力，不能用“单独进程”
替代。

### 2.3 IPC 契约

IPC 只传可结构化克隆的数据，不传函数或宿主对象：

```text
host → Runner
  activate(entry, instance, session)
  invoke(handlerId, args)
  start-source / stop-source
  close

Runner → host
  activation registrations
  resource get/list/create/delete/patchStatus
  source emit
  toast / log / source-error
```

激活时，Runner 把回调保存在本进程的 handler table，只把 `handlerId` 和声明性 metadata
返回 Manager。Manager 据此安装宿主代理。激活完成后注册表封口，防止异步偷注册造成无法原子
回滚的半个 Binding。

所有跨进程请求都是 Promise。Manager 的队列和 UI 不同步等待进程输出；Board presentation
在后台刷新缓存，render 只读取最近一份完整快照；Context 搜索只允许最新 query 发布结果。

每个 parent call 都有 deadline 和有限 pending 表。超时、IPC 断开、异常退出或非法信封都使
Runner 进入失败态：

1. 拒绝全部 pending call；
2. 终止失去响应的子进程；
3. 向 Source 报告失败；
4. 通知 Manager 撤销 Binding 的 Command、ContextProvider、Controller、Source 和 Board；
5. 保留 Resource、Proposal、Interaction 与日志，供 reload 或下次启动恢复。

当前不自动重启失败 Runner。Controller 可能刚对外产生了效果却未拿到回执；无条件重启会扩大
重复副作用。Plugin 应使用稳定 operation key，并在重试前重新观察外部状态。用户显式 reload
或下次 Baton 启动会从持久事实重建 Binding。

Source 的 `emit` 等待 host acknowledgement，从而形成自然背压；toast 与诊断日志是短寿命
旁路，不能承载领域状态。关闭时先撤销宿主注册，再停止 Runner；Runner 内部先 abort Source，
再逆序执行 `onClose`。

### 2.4 调度与一致性

Manager 保持以下约束：

- 同一 Resource key 不并发 reconcile，不同 key 可受 Controller 与 Manager 容量限制并发；
- 事件只负责 wake，reconcile 每次重新读取最新 Resource；
- Resource 变化、Source、Watch、cron、`requeueAfterMs` 和错误退避进入同一 keyed queue；
- Plugin Output 先持久化，再通知 UI；
- 激活失败整体回滚，不能留下部分注册；
- Runner 失败只撤销临时 Binding，不删除持久事实；
- Board、Context 与 TUI 都消费派生快照，不持有 Plugin 回调。

`ResourceClient` 的宿主实现只允许 Instance 操作自己的 Resource。Baton-owned Resource 是
Event Ledger 的只读派生视图。Resource type owner、namespace、uid 和 resourceVersion 都在
host 边界校验，不能信任 Runner 自报。

### 2.5 恢复与升级

启动顺序是：

1. 读取用户级启用配置和不可变 Package entry；
2. 为每个 enabled Instance 创建 Runner 并执行激活；
3. 原子安装注册并启动 Source；
4. 恢复待处理 Proposal、Interaction、Resource due time；
5. 对当前 Resource 做 initial reconcile。

升级先解析并校验新 Package，再关闭旧 Binding、切换版本并激活；失败时恢复旧版本与旧
Binding。Resource schema migration 必须由新版本显式完成，不能由 Manager 猜测。

### 2.6 Plugin 持久化与数据目录

Plugin 自写文件按 `global`、`project`、`session`、`instance` 四种 scope 归属，生命周期依次
收窄；`instance` 一定属于某个 BatonSession。Baton Project 由 cwd 标识，从 Plugin 视角就是
同一 workspace 下跨 Session 的持久化边界。Manager 激活 Binding 前创建目录，再通过
`PluginActivationContext.dataDirs` 传给进程内 Package 或 Runner：

```text
~/.baton/
├── plugins/<encoded-plugin-id>/                         # global
└── projects/<project-key>/
    ├── plugins/<encoded-plugin-id>/                     # project/workspace
    └── sessions/<baton-session-id>/
        └── plugins/
            └── <encoded-plugin-id>/                     # session
                └── <plugin-instance-id>/                # instance
```

```ts
const { global, project, session, instance } = context.dataDirs;
```

| scope | owner 与生命周期 | 适合 | 不适合 |
|---|---|---|---|
| `global` | 当前用户的 Plugin；跨 Project、跨 Session、跨 Package 版本保留 | 用户级 Connector 配置、账号无关的 Plugin 数据 | workspace observation、Session 决议 |
| `project` | Plugin + Baton Project；同一 cwd/workspace 的 Session 共享 | Repository/PR observation checkpoint、workspace 索引 | 其它 cwd 的状态、Session 私有进度 |
| `session` | Plugin + BatonSession；同 Plugin 的 Session 数据 | Session 级配置、只对当前 Session 有意义的共享附件或中间状态 | 跨 Session cursor、某个 Instance 的私有执行状态 |
| `instance` | PluginInstance；一定隶属当前 BatonSession | 单次 Binding/Instance 的私有执行快照、Connector 局部状态 | 用户配置、跨 Instance 协作事实 |

Plugin 配置只定义到 `global`、`project`、`session` 三层，不增加 Instance 级配置；更窄 scope
的配置覆盖更宽 scope，具体 schema 与合并策略由 Plugin 定义。运行数据可以按需写入全部四层。
前三层目录按 `pluginId` 隔离，不按 Package version 或运行时 Instance id 分叉；`instance`
目录在所属 Plugin 的 Session 目录下按 `pluginInstanceId` 隔离。Baton 只约定各 scope 的根目录，
Plugin 自己决定是否在其中组织 `data/`、`cache/`、`state/` 等子目录；Package version 不参与
路径。

文件名和内容由 Plugin 拥有，但必须遵守：

1. 不自行拼接 `~/.baton`、Project key、Session id 或其它 Plugin 的目录，只使用
   `context.dataDirs`；
2. 持久文件带 schema version，写入使用临时文件 + atomic rename；`project` 可能被多个
   Session Runner 并发写，Plugin 还必须使用跨进程文件锁；
3. 可安全丢失和重建的内容放 Plugin 自己的 `cache/` 子目录；会改变准入、水位或恢复行为的
   checkpoint 属于持久状态，不能伪装成 cache；
4. Event Ledger、Resource、Proposal、Interaction 等 Baton 事实继续使用宿主 API 和专用
   Store，不能复制到私有 JSON 形成第二真相源；
5. Plugin 日志继续调用 `context.logger`，由 Baton 写入当前 `session.log` 并补齐 Plugin
   provenance；不要直接在数据目录另建日志真相源。统一日志模型与运维入口见
   [Baton 日志体系](./logging.md)；
6. secret 不写日志、Resource、Project 或 Session 数据。普通配置文件即使权限受限也不等于
   secret store；正式 SecretBinding 落地前优先使用环境变量或既有凭证管理器。

禁用、reload 或切换 Package version 不删除上述目录。Instance 与 Session 数据随 Session
归档或删除；Project 数据随对应 cwd/workspace 保留；global 数据只有显式 purge 才应删除。

## 3. 面向三方开发者：Plugin authoring

### 3.1 依赖与入口

Plugin 只能依赖公共包：

```ts
import type {
  PluginPackage,
  Resource,
} from "@compforge/baton-plugin";
```

默认导出一份 `PluginPackage`，其 `pluginId`、`version` 必须与 manifest 一致：

```ts
const plugin: PluginPackage = {
  pluginId: "example/tasks",
  version: "0.1.0",
  async activate(context) {
    // 同步完成注册；需要等待的初始化可以 await。
  },
};

export default plugin;
```

公共包只包含协议与作者类型，不导出 Manager、Supervisor、Runner、Store、HarnessAdapter 或
Marketplace，也不提供运行期常量或 helper。Plugin 从该包一律使用 `import type`；ResourceType
descriptor 和纯映射 helper 留在自己的源码中。这样安装后的 Package 不需要借用宿主
`node_modules`。Plugin 不能导入 Baton 私有源码。

### 3.2 异步与可传输规则

以下入口必须返回 Promise：`activate`、Command `execute`、Context `search/provide`、Source
`start/emit`、EventHandler、`reconcile`、`present` 和 ResourceClient 操作。

Plugin 作者还必须遵守：

- 不使用 `spawnSync`、`execSync` 或同步网络桥接；外部命令使用异步进程 API，并设置 timeout、
  输出上限和取消；
- 跨边界参数与返回值只使用普通对象、数组、字符串、数字、布尔值和 `null/undefined`；
- 不返回函数、class instance、stream、socket、文件句柄、DOM/Node 对象或带循环引用的对象；
- 不把 module global 当成可恢复状态；缓存可以丢，事实必须进入 Resource 或外部系统；
- 长期订阅在 `Source.start` 中安装，并响应 `context.signal`；其它连接通过 `onClose` 清理；
- Connector 自己设置 HTTP、DB、Git 等外部资源的并发、timeout 与容量。

Runner 隔离能保护 composer，不等于允许 Plugin 阻塞自己的进程。同步阻塞会让该 Binding 的
所有 handler 一起停顿，并最终触发 deadline 回收。

`context.logger` 提供 `debug/info/warn/error(message, context)`。生命周期和低频聚合结果使用
`info`，实体列表、路径和轮询范围使用 `debug`；可继续运行的降级使用 `warn`，当前操作失败
使用 `error`。`context.attributes` 可以保存嵌套 JSON 值，错误放 `context.error`，不要把数组
拼成不可查询的字符串：

```ts
context.logger.info("PullRequest discovery completed", {
  component: "pull-request-source.forge",
  attributes: { repositories: 3, admitted: 2 },
});
context.logger.debug("Discovered PullRequests", {
  component: "pull-request-source.forge",
  attributes: { pullRequests: ["compforge/baton#228", "compforge/reqloop#52"] },
});
```

Runner stdout/stderr 会被宿主有界采集用于兜底排障，但缺少结构化字段。Plugin 应使用 logger，
并对轮询产生的相同结果去重。日志不是 Resource 状态，不得包含 secret。

### 3.3 Resource 与 Controller

Resource 使用版本化类型身份：

```ts
const TASK = {
  apiVersion: "example.baton.dev/v1alpha1",
  kind: "Task",
  shortNames: ["task"],
} as const;

type Task = Resource<
  { readonly title: string },
  { readonly phase?: "open" | "done"; readonly observedGeneration?: number }
>;
```

- `spec` 是期望与用户认可的 contract；
- `status` 是可重新观测或计算的当前状态；
- `generation` 只随 spec 变化；
- `resourceVersion` 是 opaque 乐观并发 token；
- `shortNames` 是不参与身份的紧凑展示别名，沿用 Kubernetes CRD 命名，Board 使用第一个；
- `uid` 固定一次具体创建，删除重建后变化；
- `owner` 只表达同一 PluginInstance 内的结构所有权，并用 `uid` 固定 owner incarnation；
- `deletionTimestamp` 表示删除已经进入 reconcile 生命周期；
- `labels` 是受 Kubernetes 风格 key / value 约束的可检索 metadata；
- `annotations` 是不参与检索、仅要求非空 key 和 string value 的宽松 metadata。

`ResourceClient.list(type, { matchLabels })` 对 label 做精确 AND 匹配；annotation 不提供
selector。两类 metadata 都通过 `patchMetadata()` 按键更新，`null` 删除单键，并以
`resourceVersion` 做乐观并发；metadata 更新不推进 `generation`。不要用二者替代 spec、
status、identity、owner 或领域引用。

`ResourceClient.delete()` 是删除请求，不是立即移除：Baton 先持久化
`deletionTimestamp`，并对 `owner` 指向该 Resource 的所有后代做同样标记。terminating Resource
会从 Board 隐藏，但仍交给所属 Controller reconcile；reconcile 成功后宿主最终删除，失败则沿用
现有退避并在重启后恢复。首版只支持一个结构 owner，不提供 finalizer、多 owner 或 orphan
policy。Source、使用关系和领域关联都不是结构 owner，不能借 owner cascade 表达保留策略。
完整的创建、保留、删除状态机及与 controller-runtime 的差距见
[Plugin Resource 生命周期](./resource-lifecycle.md)。

Controller 管理一个 primary `resourceType`：

```ts
context.registerController({
  resourceType: TASK,
  async reconcile(_baton, resource: Task) {
    const next = await observeTask(resource.spec);
    await context.resources.patchStatus(resource, {
      phase: next.phase,
      observedGeneration: resource.metadata.generation,
    });
  },
  async present(resource: Task) {
    return {
      title: resource.spec.title,
      url: resource.status.url,
      status: resource.status.phase,
      priority: resource.status.phase === "blocked" ? 100 : 0,
    };
  },
});
```

`reconcile` 必须 level-based、幂等：事件只代表“可能变化”，不是必须恰好执行一次的命令。
可能已生效却拿不到回执的外部操作使用稳定 operation key，重试前先 observe。

`present` 只做只读、可重复的派生，不改变 Resource 或外部系统。持续进度和错误进入 status /
Board；toast 只用于一次操作或状态边沿的反馈。Plugin 可以返回有限数值 `priority` 表达同一
Plugin Instance、同一 Resource Type 内的展示优先级，数值越大越靠前，缺省为 `0`；Baton
固定展示每组前 5 个，避免单类 Resource 挤占共享 Board。`url` 是可选的原生终端超链接，
具体打开手势由用户的终端决定。detail 的溢出展示由 UI 统一处理，不进入 Plugin 契约。

### 3.4 Source、Watch 与定时唤醒

- **Source** 发现外部对象并 `emit` primary Resource；不 patch status，不产生 Output。
- **Watch** 把已存在的 secondary Resource 变化映射成 primary `ReconcileRequest`。
- **cron Source** 固定周期 enqueue 当前 Resource。
- **`requeueAfterMs`** 表示当前 Resource 本次 reconcile 后的动态复查。

四条路径最后都进入同一 keyed queue。`Source.start()` 只有在初始扫描和 live subscription
都 ready 后才 resolve；关闭时必须停止 watcher 和异步任务。

### 3.5 Command、Context 与 Output

Command 是用户显式入口，适合创建、选择或修改 Resource。远端 picker 搜索通过
`searchQuery` 重入同一 Command；Plugin 返回完整结果页，Baton 负责 debounce 和丢弃旧响应。

ContextProvider 只提供用户用 `@` 明确选择的只读上下文。`search` 不产生副作用；`provide`
按 `maxChars` 控制输出，不返回 secret。

Controller 不直接调用 Harness。当前可返回两类受控 Output：

- `proposed-input`：用户审核、编辑或丢弃后，才成为普通 Input；
- `interaction`：Baton 先持久化决议，再重新 enqueue 原 Resource。

等待用户决议时不要在 Runner 中保存 Promise continuation。下一次 reconcile 从
`baton.pluginInteractions` 读取持久结果。

### 3.6 作者自检

发布前至少确认：

1. Package 与 manifest 身份一致，版本目录不可变；
2. 所有跨边界回调都是 async 且返回可传输数据；
3. 外部 I/O 有 timeout、容量与取消，产品代码没有同步子进程；
4. reconcile、Source emit 和外部副作用可重放、可去重；
5. crash 后只靠 Resource、Event Ledger 和外部事实即可恢复；
6. cleanup 会停止订阅、连接与自建子进程；
7. 日志和 Context 不包含 secret；
8. Plugin 不导入 Baton 私有类型，也不直接访问 Harness。

`@compforge/baton-plugin` 0.2.0 是本进程契约的首个版本：公开回调统一 Promise 化，三方
Package 默认在独立 Runner 中执行。0.1.x 的同步作者契约不作为兼容目标。

## 4. References

- [`packages/plugin/README.md`](../packages/plugin/README.md) — 最短作者示例
- [`docs/resource-lifecycle.md`](./resource-lifecycle.md) — Resource 准入、owner、删除与恢复
- [`docs/kernel.md`](./kernel.md) — Baton 进程、事件循环与稳定内核
- [`docs/loop-engineering.md`](./loop-engineering.md) — Baton Plugin 与 Harness Plugin 的分层
- [`controller-runtime`](https://github.com/kubernetes-sigs/controller-runtime) — level-based
  reconcile、Source、Watch 与 workqueue 的主要参照
