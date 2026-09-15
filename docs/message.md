# Message

## 交互对象与事实

Message 表达参与者之间的交互，是可寻址、可引用、可渲染的协作对象。Event 记录对象发生的
变化，是 append-only 的事实；一条 Message 可以由创建、内容追加、消费或决议等多个 Event
还原。实时更新与历史重放使用相同投影，不存在可绕开 Event 独立修改的消息事实库。

Message 包含 Input、Output、InputRequest、InputResponse。Input / Output 保留任务输入与
执行输出的含义；Interaction 只是 InputRequest 与 InputResponse 的统称，没有额外的实体身份。
ViewInput 与 ViewOutput 是 View/Core 边界契约，不等于消息分类，也不是 Message 的子类。

## 身份、参与者与关联

每条 Message 有独立身份、创建时间、source / target Actor 与可选回复关系。Actor 用 kind / key
区分参与者类型与实例；Harness Actor 使用具体 HarnessTarget，Plugin Actor 使用 PluginInstance。
当前单用户宿主以稳定的 local 身份表达用户与 Baton，不把操作系统用户名写入历史。

Message source 是作者，Event source 是事实报告者。Harness 补报用户输入的消费回执，不会因此
成为那条输入的作者。target 表示消息面向谁，不证明已经执行，也不赋予对方权限；无特定 target
不意味着广播调度。Actor 的开放类型不自动获得 Core 的执行能力。

消息归属由所在的 Session 或 Inbox owner 确定，不因进入某个视图而改变。全局、项目级 Inbox
事项可以先于领取它的 Session 存在；共享 Message 字段不要求预先绑定 Session。
Lane、Turn 和 Harness 原生身份仍是执行关联，不参与 Message 或 Actor 的身份定义。
公共 Message 不携带投递状态或 Plugin execution 上下文；Session 投影按消息身份关联这些信息。
Output 的生成状态属于 Output，Input 的投递与消费状态属于输入执行投影，二者不能互相替代。

回复关系可以未知、明确为空、指向一条或多条消息。它表达“回应什么”，不表示所有消费过的输入，
也不构成调度依赖或全序。一条回答可以回应多条输入，一条输入也可以收到多个阶段输出。
同一消息身份不能从 Input 变为 Output 或请求，引用必须能在所属协作空间中解析。

## 请求与答复

InputRequest 承载强类型问题、审批或草稿请求。它的消息身份同时作为等待关联；InputResponse
有自己的消息身份，且必须明确回应一条请求。请求的多个问题通过各自的 question identity 对应答案，
不为每个问题另造协作请求。

人通过已有 ViewInput 路径提交答案；Core 检查请求是否仍待决、答复方是否有权处理，以及答案是否
符合请求约束，再持久化答复事实，最后恢复对应 Harness 或 Plugin continuation。普通 Input 即使写着
“同意”并引用请求，也不会成为审批结果；答复也不会自动进入普通 prompt Queue。
策略作出的真实决议以 Baton 为作者，不能伪装成人的操作。

取消、超时与恢复失败终结请求，但不伪造 InputResponse。第一个有效终态生效，迟到或重复答复
不能改变已交付结果，也不能再次触发动作。continuation、定时器和恢复机制仍由交互执行模块拥有，
不进入 Message 公共字段。

请求终态只由 Session 的统一投影规则接受。请求保存决议状态与答复引用，答案正文属于
InputResponse；等待者从已提交投影读取结果，不再各自解释终态 Event 或保存另一份决议。
实时作答、历史重放、超时和恢复遵守同一规则；Session 通知只唤醒等待者重新读取，通知本身不授权执行。
运行时与事件协议共用 Message 契约。请求事实直接携带 InputRequest，答复事实直接携带
InputResponse；身份、作者、接收方和回复关系均由消息明确提供，不从事件报告者或重放序号推导。
取消事实按请求的 messageId 终结等待，不产生答复消息。

不同消息没有统一的业务完成状态：Input 的消费、Output 的生成结束、InputRequest 的决议终结
相互独立，更不等于整个 Turn 或业务已经完成。

## 投影与展示

Input 从 Queue 准入开始即可按消息身份查询，但未执行或未消费时不提前占据已执行 Transcript
位置。投递与消费仍由 Queue、Attempt 和回执表达，具体顺序见[工作流](./workflow.md)。
消息正文与作者属于 Message；交付记录可以保留执行所需快照，不成为另一份可独立修改的消息。
Queue 首次准入提供原始正文，后续状态迁移只更新执行记录。显式消息内容更新可以修改正文；
已知 Input 的 Harness 回显只补执行关联，不追加重复正文，也不把 transport Context 写回历史。
未经过 Baton Queue 的外部历史消息仍按完整内容替换、chunk 追加的语义投影。

Transcript 选择性展示 Message 流，并结合相关执行活动形成协作历史。Queue 展示等待执行或消费
的 Input；Interaction Dock / Inbox 展示待处理请求；请求终结后可以在历史中展示请求与明确答复。
它们引用同一消息身份，不因跨视图展示复制协作对象。敏感问题的答案不进入 Transcript 或回复预览。

内容、待决请求与答复可以保留职责明确的索引，通过公共查询入口统一寻址，不要求把全部状态塞进
一个大 Map。Event、Message 与 Transcript 的身份和顺序不能互相替代。

## 实现入口

- `src/message/` — 公共类型、Actor、事实归一与消息查询
- `src/interaction/` — 强类型请求与答案、等待、决议和 continuation
- `src/store/` — 与执行事实共同重建消息投影
- `src/view/chat-tui/` — 消息选择、交互卡片与历史展示
