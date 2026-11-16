# 资料、工作记忆与实际上下文契约

适用 0.7 预览版。Harness 是交互与执行器；身份、权限、来源、工作状态、版本和费用归属由宿主管理。业务模块沿用插件 ABI，不把部门规则写入内核。

## 接入资料模块

`MemoryDomain` 描述可见范围、责任人、来源适配器、索引版本和覆盖状态。目录只展示当前身份可发现的域，不表示已经读取域内全文。

`ResourceRef = { id, version }` 指向不可变资源版本。资源另有当前版本、修订、有效期及授权代数。标题、摘要、索引、统计和正文均服从来源权限。

可信宿主通过 `FrameworkOptions.memorySources(host)` 注册 `MemorySource`：

```ts
interface MemorySource {
  search(principalId, domain, query, limit): Promise<{ refs: ResourceRef[]; hasMore: boolean }>;
  read(principalId, ref, query, limit): Promise<VersionedResourceFragment>;
  version(principalId, ref): Promise<{ version: number; revision: string }>;
}
```

身份参数由宿主传入。适配器只能返回已登记的标准资源引用；宿主复核引用、片段、摘要和版本，插件不能自行声明管理员身份或扩大可见范围。外部数据库、文件和 MCP 模块先把其权威版本登记为资源，再接上述适配器。独立文件适配见 `examples/sources/reference-file.mjs`，业务插件见 `examples/plugins/`。

## 检索与读取

- `GET /v1/memory-domains`：可见目录。
- `POST /v1/agents/:agentId/recall`：`query`、`purpose`、可选 `workId/resources/domains`，以及字符、读取、域数和深度预算。
- `GET /v1/resources`：授权范围和查询条件内分页检索；游标绑定调用者和查询。
- `GET /v1/resources/:id?version=&offset=&limit=`：有限片段、当前有效性、版本及续读位置。

顺序为明确引用、当前工作的有效引用、可见资料域、域内候选、正文片段。选择采用确定规则和有限中英文词条，不做全公司上下文拼接。中文主题短语保留原文，避免不同系统 ICU 词典把专有名词拆散。

返回 `coverage`，区分无匹配、部分覆盖、索引落后与来源不可用；索引落后时回到授权原库。`complete` 仅表示选定范围的查询完成，片段仍可能不是全文。没有授权的资源不通过错误提示暴露。

## 工作与独立笔记

`work_memory_versions` 按工作、岗位和执行身份只追加修订，保存目标、决定、阻塞、下一步及成果引用。`memory_versions` 保留独立 Markdown 笔记的旧版本和实际来源。宿主状态、审批、控制代数和动作回执与 Agent 整理的笔记分开。

- `GET/PUT /v1/work/:id/memory/:agentId`：读取和带期望修订的幂等保存。
- `POST /v1/agents/:agentId/work-context`：明确关联、恢复入口绑定，或返回候选供选择。
- `POST /v1/work/:id/memory/:agentId/rebuild-request`：失效笔记的受限重建任务。

旧笔记不自动注入新上下文。重建从新回合的有效证据开始，保留历史，不继承旧正文；受限任务只读资料及更新对应工作笔记。原工作停止或控制代数变化后，入场、模型发送和保存事务均拒绝旧任务。停止再恢复不会复活旧排队请求。

## 实际 ContextPack

宿主先保留身份、授权与控制约束，再放当前输入、工作状态、有限笔记、相关片段及可展开引用。原生 Harness、后台 SDK 和远程适配共用实际模型网关；客户端历史、工具消息和模型填的引用均不能成为授权依据。

`execution_sources` 记录真实进入执行的输入、资料、笔记和工具结果依赖。`model_context_requests` 保存每次网关请求的来源清单、哈希、字符量、预算及遗漏；它解释宿主管理的模型请求，不声称覆盖服务商在网络层添加的元数据。

默认预留输出 1024 tokens、工具返回 2048 tokens，在 16000 tokens 管理窗口内检查最终请求。读取共享每轮次数、字符和分页深度预算；普通插件的自有字段不被当成框架分页协议。无关资料增加不导致全量聊天或资源自动载入。

## 派生内容、事件和发布

自动报告、笔记、摘要及候选经验继承宿主实际来源；接收者必须能读取全部依赖。填写公开引用、清空引用或修改资源本身的分享范围不能清除来源约束。未知旧来源保守保持本人可见。

来源变化后，旧记录仍在，但事实标为历史，不能进入当前结论摘要。checkpoint 展开的旧结果与回执也登记到新运行的真实来源；读取后撤权不能通过跳过依赖继续发送模型。

资料修改、删除和撤权在同一事务写出索引更新意图。消费者幂等、按当前权威版本投影，失效相关缓存、派生内容及上下文。只通知相关订阅；执行订阅先持久记录事件，服务重启后补发，并再次鉴权。

经验依次经过个人候选、人工验证说明、提交、独立审核、限定范围发布、安装、反馈与停用。静态包校验和人工验证不是自动证明业务正确；个人反馈不会自动变成公司规则。

员工在 Harness 的“工作依据与记忆”查看来源、预算、遗漏、笔记及候选经验；管理员在“上下文与资料域”查看授权投影和用量。技术标识收在详情中。检索和确定性笔记压缩记录为本地处理、模型调用为零；模型执行及事件归属调用按真实网关用量独立计量。


## 0.8 来源搜索续查

`MemorySource.search(principalId, domain, query, limit, {cursor?, maxScans?})` 保持前四个参数兼容，返回 `refs, hasMore, nextCursor?, scanned?`。可分页源另实现 `indexVersion(principalId, domain)`，版本必须随索引内容变化。适配器先在可读匹配内应用 limit，扫描上限与正文读取限额分开；文件示例始终从标准资源服务读取内容与授权。

宿主 `/v1/agents/:agentId/recall` 增加 `cursor` 和 `maxScans`。返回的游标为一天有效的随机引用，不含内部候选位置；它绑定公司、员工、岗位、工作、查询、资料域、源版本和权威授权/资料/记忆变化水位。变化或跨范围续查返回 CONFLICT，请重新查询。`coverage.omissions[].continuation` 提供各域的具体续查参数，单域也提供顶层 nextCursor。分页不支持的旧适配器继续运行，但 hasMore 时明确 pagination-unsupported，不伪造游标。

内部 scanned 仅用于限额和操作记录，不显示给员工。hasMore 表示扫描尚未完成，不能解释为还有多少可见或隐藏资料。无匹配、扫描限制、读取/字符限制、来源中断与版本冲突分别表达。返回片段仍进行宿主标准版本和正文复验，适配器声明不授予任何新权限。

工作笔记旧版本通过原读取接口 `?revision=N` 查看，返回 currentRevision 与 source-changed；正文沿用底层权限。生成成果保存生成时的不可变来源快照；最终执行过程仍受完整 Run 账本约束。work_report 的宿主回执同样封存当时来源，之后的修订不能让旧报告重新变成当前。


## 0.8 事件与工作关联

新接入显式传入 conversationId（会话容器），threadId 为兼容字段；可信平台可提供 topicId（真实话题）与 replyToEventId（同来源外部事件ID）。缺少 conversationId 的旧调用继续把 threadId 视为专用工作话题，旧记录不迁移覆盖。受管 IM 入口会传入真实 conversationId，不再把一个群当成一项工作。

可靠关联按已认证的 workId/人工选择、回复、话题及受管对象匹配；多个不同工作冲突或没有可靠关联时要求选择。intent=new 明确创建新事项；intent=continue 没有可验证关联不会猜测。员工可在统一入口用 `/new 描述`、`/continue 工作UUID 描述` 明确选择，后者仍复验参与权限；其他控制继续使用工作中心。飞书适配保留官方消息事件中的 thread_id、parent_id/root_id；不支持关系字段的渠道使用显式选择，不猜造回复关系。[飞书官方事件说明](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)。

同群多工作订阅并存。对象关联需管理员配置 correlationGroup、subjectSystems；只有受管身份的 Webhook/宿主事件及平台适配器可声明该命名空间的 subjectRef。跨人员另需 crossPrincipalCorrelation=true，并在关联、输入接纳及执行前核实参与权限，标题相似或模型建议不作为授权。关联组属于公司命名空间，不跨租户。来源调整、身份撤销、停止及等待仍由原控制路径复验。

`POST /v1/events/:id/resolve` 可带 workId 确认现有工作，不带则明确创建新工作；请求必须带当前 revision 与 reason。`POST /v1/events/:id/association` 纠正后续关系，记录理由、版本和政策修订。已执行事件的原 workId、任务和回执不修改、不重放；associationWorkId 表达后续纠正。待确认候选只含当前人可参与的工作；隐藏候选和别人的事件正文不展示。后台 history 可追查判断与纠正理由。


## 0.8 长期工作记忆与来源集合

工作状态仍来自宿主；当前工作笔记、旧修订、归档条目、输入账本及经验候选分别保留。每次笔记写入创建不可变、带摘要校验的 source-set（version=1），以有向无环的父集合+本次新增来源保存完整沿袭。当前笔记只保存集合引用，不把所有历史来源内联。原依赖数组保留原记录，新写入兼容转为集合；不清历史，不提高旧512上限。

来源集合按当前身份展开验证。目录 `GET /v1/source-sets/:id?limit=20&cursor=...` 使用绑定身份、集合版本和当前授权指纹的不透明续查；标题与引用均依当前授权。缓存只缓存不可变成员，权限和底层版本每次权威复查；集合修复/删除的数据库代数可使成员缓存失效。未知来源或校验预算不足保持待核实，不放行派生正文。当前同步验证预算为10000个集合节点/来源；超过预算明确要求专门核验，不承诺无限规模或生产负载。

`GET /v1/work/:id/memory/:agentId/history` 分页列出历史修订，`?revision=N` 按授权读取历史正文。`POST .../organize` 接受 expectedRevision、idempotencyKey、changes[{section,index,reason}]：把选定的个人笔记条目归档，保留其他决定、阻塞、下一步和全部底层依赖。CAS、精确幂等回执及宿主停止条件沿用保存路径。归档不等于完成审批或动作。Harness tool work_memory_organize 使用同一契约与回合刷新。

`POST /v1/work/:id/recipient-summary` 用接收者有权读取的成果引用、有限资料摘录和宿主状态独立整理进展，保留真实来源。没有把私人笔记、原报告或完整过程文本作为生成输入。当前采用确定性整理，无额外模型调用；摘录明确标为未核实结论，不从隐藏结果推断业务事实。候选经验仍走原独立审核与范围发布机制。
