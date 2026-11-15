# 插件接入协议 1.0

manifest 0.1.0 的完整校验规则见根目录 `plugin.schema.json`。包内工具 id 与插件 id 组合为 `@scope/package:local.tool`。所有版本精确绑定，安装后同版本不同内容被拒绝；依赖必须已经安装且启用。一个岗位可同时绑定最多 16 个不同插件。配置通过包内 configSchema 校验，插件初始化时收到 `ctx.config`。

## 本地模块

导出 `apply(ctx)`，使用 `ctx.tools.register(id, handler)` 注册全部声明工具，不多也不少。handler 接收 `(input, {runRef,signal,services})`。`services.memory.read({noteId})`、`proposeWrite({noteId,markdown,expectedVersion,sourceRefs})` 和 `reports.record({summary})` 由宿主绑定主体；不接受任意员工或 Agent 编号。服务能力是声明、员工和岗位授权的交集，每次调用重新检查。

## 远程插件

manifest 的 entry 使用 `{kind:'remote',connectionRef:'connection:your-system'}`。地址与可选服务端令牌在可信宿主 `createFramework({connections:{...}})` 配置，不放入能力包。只允许 HTTPS 或开发用 loopback HTTP，拒绝 URL 内嵌凭证、query 和跳转。使用 JSON-RPC 2.0 POST，返回相同 id。

0.3员工软件同期增加宿主管理连接：管理员在“渠道与接口”登记kind=plugin、protocol=company-jsonrpc、授权范围与加密凭证，插件仍使用上述connectionRef，不改变包格式。宿主按实际员工身份解析连接，凭证留在宿主与受信远程适配器之间；更新凭证会切换worker缓存版本。静态connections配置继续兼容。protocol=http只登记平台文档，必须另写插件将平台API转换成工具契约，不能把任意HTTP地址当作JSON-RPC插件。详见V03_ACCEPTANCE.md。

| 方法 | params / result |
| --- | --- |
| `plugin.initialize` | `{protocol:'1.0',pluginId,version,config}` / `{protocol:'1.0',tools:['local.tool']}` |
| `plugin.health` | `{}` / `{status:'ready'}` |
| `capability.describe` | `{}` / 能力描述；本地 worker 当前返回协议与工具 id |
| `tool.invoke` | `{invocationId,runId,toolId,input,idempotencyKey,context}` / 严格符合 outputSchema 的值 |
| `plugin.shutdown` | `{}` / `{closed:true}`；应只排空这个连接实例，不关闭整个远程系统 |

context 由宿主生成，包含 companyId、principalId、agentId、runId、pluginId、pluginVersion。服务端必须鉴别调用者，不能仅信任这些字符串。JSON-RPC 标准 error 外加 `error.data.code` 表达框架错误。网络失败、超时和不确定回执不得自动重复写操作。当前远程插件不支持反向 stdio 宿主服务调用；需要记忆等服务时使用运行适配的短期网关。

## 远程 Agent

岗位配置 `runtime:'remote',connectionRef:'connection:your-agent'`。同一可信连接实现 `run.start`、`run.status`、`run.result`、`run.cancel`。start 接收 protocol、prompt、idempotencyKey 和宿主 context，返回 `{runId,state}`；status 返回 state；result 返回 `{output:string,usage?:{inputTokens,outputTokens}}`；cancel 返回 `{accepted:boolean}`。不支持原会话恢复时明确拒绝，不假称恢复。

context 附带本任务 modelURL、mcpURL 和短期 token；token 仅在本任务期限及权限内有效，结束和撤权后不能继续访问。若远程服务自行调用模型，上报用量记为 remote-reported。不要同时把网关实测和同一批远程上报重复作为已结算消费。

## 权限、写入和记忆

工具必须同时出现在员工 `tool.invoke:<完整工具名>` 与岗位 allowedTools 中；admin 仍受公司范围、岗位工具范围和 schema 限制。write 工具额外需要管理员一次性批准，精确绑定主体、岗位、插件版本及输入摘要，有效 15 分钟。重复成功请求返回原回执，不再次消耗审批或执行。审批未满足时返回 APPROVAL_REQUIRED；原任务不会自行续跑。

工作查看使用 `agent.read:<id>`；派工使用 `agent.execute:<id>`；私有记忆额外需要所有者身份、公司 admin 或明确的 `memory.read:<id>`/`memory.execute:<id>`。插件自用服务还需要 memory.self.read、memory.self.propose_write、report.self.write 的人员与岗位授权。授权被撤销后重新检查。

记忆 id 是简单标识符，禁止自由文件路径。写入提供 expectedVersion，0 表示新建。数据库决定 ACL 和版本，Markdown 投影失败会记录 memory.projection_pending。投影暂不保证文件系统并发写入的最终顺序，读取和模型上下文始终以数据库为准。
