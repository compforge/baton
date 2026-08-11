# Plugin Resource 生命周期

> 本文描述 Baton 当前已经实现的 Resource 准入、所有权、删除与恢复契约。领域对象应在什么
> 条件下进入系统、保留多久、何时请求删除，仍由各 Plugin 决定。Plugin host 与作者接口见
> [Plugin](./plugin.md)。

## 1. 理念与概念

外部对象与 Resource 是两份不同的事实。PR、需求或部署可以一直存在于外部系统，但只有在
当前 BatonSession 的工作范围内被用户明确选中，或被 Source 的准入策略选中后，才需要成为
内部 Resource。Connector 只适配外部能力，不因为 `list()` 看到了对象就天然拥有创建 Resource
的权力。

Resource 进入 Baton 后有三层彼此独立的状态：

- **存储生命周期**：Resource 是否 active、terminating 或已经物理删除；
- **领域有效性**：外部对象是否仍开放、仍被使用或仍值得保留，由 Plugin 的 status 与策略表达；
- **Board 可见性**：`present()` 是否产生卡片，是从 Resource 派生的读模型。

因此，“Source 本轮没有发现”“外部对象已经关闭”和“Board 不再展示”都不等于 Resource 已经
删除。只有显式删除请求会进入 Baton 的 terminating 流程。

BatonSession 是 Plugin 数据的物理容器，PluginInstance namespace 是 Resource 的隔离边界。
`metadata.owner` 只表示 namespace 内 Resource 之间的结构所有权，不表示 Source provenance、
使用关系或一般领域关联。

## 2. 创建与准入

Resource 有两条创建路径：

1. **显式领域意图**：Command 等用户认可的流程调用 `ResourceClient.create()`。例如用户从
   picker 选择一项需求后，将它落成 Requirement。
2. **外部对象准入**：Controller 的 Resource Source 根据自己的有界策略调用 `emit()`。例如
   只把当前 workspace 中的仓库或近期开放 PR 落成 Resource。

```text
外部系统中的对象
       │
       ├── 用户明确选择 ── Command ── ResourceClient.create()
       │
       └── 满足准入策略 ── Source ─── emit()
                                      │
                                      ▼
                              Active Resource
```

`Source.emit()` 以稳定的 type、namespace 和 name materialize 一次对象。对相同内容的重复
emit 只是 keyed wakeup；它不会偷偷更新 `spec`。同一 identity 的 `spec` 或 owner 不一致时，
Baton 拒绝该 emit；Source 本次提供的 label / annotation 键也必须仍保持相同值。Resource 上由
其它控制路径后来补充的 metadata 键不会与 Source 冲突。

这两条路径共享以下约束：

- `uid` 由 Baton 为本次 incarnation 分配；删除后以同名重建会得到新的 `uid`；
- namespace 固定为当前 PluginInstance，Plugin 不能跨 namespace 操作 Resource；
- owner 如果存在，必须指向同 namespace 内一份已存在且未 terminating 的 Resource；
- owner 必须携带 `uid`，避免同名 owner 重建后意外继承旧 dependents；
- owner 在当前 incarnation 内不可变。

Connector 不属于 Baton 公共概念。Plugin 作者应让 Connector 返回外部领域对象，由同时了解
准入策略和 Resource schema 的 Source 或显式 Command 决定是否创建；Baton 目前通过接口边界
支持这种分工，但不会识别 Plugin 内部某个对象是否名为 Connector。

## 3. Labels 与 annotations

两者都属于 Plugin 可通过 `ResourceClient.patchMetadata()` 按键修改的 string metadata；`null`
删除单个键，未出现在 patch 中的键保持不变。metadata 更新只推进 `resourceVersion`，不推进
表达 spec revision 的 `generation`。

- **label** 用于机器可读的分组与选择。`ResourceClient.list(type, { matchLabels })` 对所有键执行
  精确 AND 匹配；key / value 使用 Kubernetes 风格的长度和字符限制。当前每个 session 的
  Resource 数量很少，宿主按该语义扫描实现，不承诺物理索引。
- **annotation** 用于展示偏好、用户 retention deadline 等不参与检索的扩展信息。Baton 只要求
  key 非空、value 为 string，不把其内容解释为 selector，也不施加 label 的字符限制。

Plugin 不应把需要检索的状态藏进 annotation，也不应因为 annotation 更宽松就把大体积外部
payload 复制进 Resource。`spec`、`status`、owner、identity 和删除状态仍各自使用专用字段，
不能经 metadata patch 修改。

## 4. Active 与保留

Resource 创建后由所属 Controller 进行 level-based reconcile。Source、Watch、cron 和 timer
只负责唤醒；Controller 每次都重新读取 Resource 和必要的外部事实，再更新 status 或输出下一步
动作。

`ResourceClient.get(ref)` 在省略 uid 时按名称读取当前对象，带 uid 时重新读取同一 incarnation。
带 uid 的对象已删除或被同名重建时返回 `undefined`，避免 continuation 把旧决定写到
replacement；namespace 越界仍会失败。

Source 只证明“这次观察到了候选”，不维护完整集合真相。一次 list 可能分页、超时、权限变化或
只覆盖滑动窗口，所以 Source omission 不会触发删除。Plugin 若要自动回收，必须基于可恢复的
领域证据，例如显式使用关系、连续观测的 `lastSeenAt`、terminal TTL 或用户删除决定，再调用
`ResourceClient.delete()`。

Board 同样不拥有保留策略。Plugin 可以让 `present()` 对 cold、离开范围或 terminal 的 Resource
返回 `undefined`，以后重新活跃时复用原 Resource；这只改变展示，不改变存储生命周期。

## 5. 删除状态机

`ResourceClient.delete()` 是删除请求，不是立即移除：

```text
Active
  │ ResourceClient.delete()
  ▼
Terminating
  │ deletionTimestamp 已持久化
  │ Board 隐藏，Controller 仍 reconcile
  ├── reconcile 失败 ── 保留 Resource，按既有退避重试
  │
  └── reconcile 成功
          ▼
       Deleted
       物理移除并发布 delete event
```

删除请求会完成以下动作：

1. 给目标 Resource 写入一次 `deletionTimestamp`，推进 `resourceVersion`，并清除旧的动态调度；
2. 递归找到 owner 指向目标 incarnation 的结构后代，给它们写入同一批删除请求；
3. 以 update event 唤醒各自 Controller，并立即从 Board 派生视图隐藏 terminating Resource；
4. Controller 仍收到完整 Resource，可在看到 `deletionTimestamp` 后释放自己拥有的外部效果；
5. reconcile 成功后 Baton 物理删除该 Resource，并把最终 delete event 路由给 Watches；
   仍未决的关联 Interaction 同时以 requester 原因收口；
6. reconcile 失败时不删除，沿用普通错误退避；Baton 重启后 initial reconcile 会重新处理它。

当前没有公开 finalizer。所属 Controller 的一次成功 reconcile 是唯一删除屏障；Plugin 若需要
cleanup，必须在 terminating 分支完成，只有能确认 cleanup 已完成或无需 cleanup 时才成功返回。
terminating reconcile 返回的 Output 和 `requeueAfterMs` 不会进入普通发布路径。

级联目前是“先给全部已知后代持久化删除请求，再各自独立 reconcile”，不等待 child 删除后才
删除 owner，因此更接近 background propagation。删除请求幂等，已有 timestamp 不会重写；最终
删除后，Source 仍可按同名 identity 重新创建一份带新 `uid` 的 Resource。

## 6. Owner 的边界

当前 `metadata.owner` 是一条单 owner、同 PluginInstance、UID-pinned 的结构边：

```text
Owner Resource (uid=A)
├── Dependent 1 (owner.uid=A)
└── Dependent 2 (owner.uid=A)
```

适合使用 owner 的关系必须满足：dependent 没有 owner 就不应独立存在，并且 owner 删除时应一起
进入 cleanup。以下关系不应使用 owner：

- 某个 Source 首次发现了 Resource；
- 某个 session、用户或 agent 最近使用了 Resource；
- PR 关联 Requirement，但 PR 仍可独立存在；
- Repository 暂时出现在 Workspace 的扫描结果中，离开后仍希望保留以便复用。

这些关系应使用领域 status、ResourceRef 或未来的 Usage / lease 模型表达。顶层 Resource 可以
没有 owner；它仍物理归属于当前 BatonSession 中的 PluginInstance namespace。

## 7. 与 controller-runtime 的当前差距

Baton 借鉴 Kubernetes 的 level-based reconcile 与删除时间戳，但当前不是完整的 Kubernetes
garbage collector：

| 能力 | Baton 当前状态 |
|---|---|
| `deletionTimestamp` + terminating reconcile | 已支持 |
| owner UID 防止同名重建误继承 | 已支持 |
| 结构后代级联请求 | 已支持，background 风格 |
| 重启后继续处理已标记 Resource | 已支持 |
| 多 owner / controller owner 选择 | 未支持 |
| finalizers 与多方 cleanup barrier | 未支持 |
| foreground / background / orphan propagation policy | 未支持 |
| grace period | 未支持 |
| 独立 GC 扫描与级联崩溃恢复对账 | 未支持 |
| Usage、lease、TTL 或 last-seen retention policy | 不属于 Baton 当前通用生命周期 |

所以当前闭环应准确表述为：**每一份已经被标记的 Resource，都能经过 Controller 成功或重试，
最终物理删除；结构 owner 可以同步扩散删除请求。**它还不能声称拥有 controller-runtime
级别的多方 finalization、可选 propagation 或独立 GC 自愈能力。

后续只有出现“多个参与方都必须阻止删除”“需要 orphan/foreground 语义”或“级联必须跨崩溃
严格对账”的真实场景时，再引入 finalizer、propagation policy 或独立 GC controller。领域对象
何时变 cold、何时过期，优先留在 Plugin retention policy，不进入通用 owner 机制。
