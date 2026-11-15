# 内部市场、资料与自动协作（0.6 隔离候选）

这是同一通用宿主的能力治理和协作入口。业务规则仍由独立 `agent-plugin.json` 或 `SKILL.md` 包提供，不写入内核。参考 iflytek/skillhub 的贡献/审核/版本治理、DeepSeek dsh-superagent-prototype 的来源/订阅/归属/执行分离；没有直接合并第三方服务或宣称兼容其私有发布协议。

## 员工贡献与安装

1. 在公司 Harness 内登录、选择本人岗位，进入工作中心 → 内部市场。
2. 可以直接编辑单文件 Skill，或上传含 `SKILL.md` / `agent-plugin.json` 的目录。目录最多128个文件、5MB；不上传 `.env`、私钥、依赖目录和客户私有资料。
3. 候选包单独保存，仅做路径、大小、凭证模式、清单、Schema、版本和 Skill frontmatter 检查；不执行入口、依赖安装或 Skill 脚本。静态检查通过不等于代码安全，可信代码仍需人工审查。
4. 贡献者不能审核自己。管理员在内部能力市场查看全部候选文件、权限声明和历史，审核通过后另行发布。部门审核者限于获准的本部门范围；可执行插件须公司管理员发布。
5. 发布范围决定内容发现范围；发布时选择员工、岗位预设或部门的授权名单，可先少量试用。工具/宿主服务授权必须是已审清单的子集，不改写员工全局权限。扩大推广需要明确的新发布，不会自动变更所有岗位。
6. 员工在本人岗位安装已发布版本。插件可填写符合配置 Schema 的岗位配置；外部凭证使用公司渠道的 `connection:` 引用。安装后更新原生 Host 的租约和工具描述，保留该岗位记忆与数据目录。
7. Skill 正文及 `references/` 等审过的附属文件按需分页读取，脚本仅作为数据。Skill 文字不能授予任何工具、数据或发布权限。
8. 同一标识/版本不可覆盖。升级先移除旧版本再安装新版本。撤回会阻止之后的 Skill 展开和工具调用；历史安装、调用回执及记忆保留。

可上传 `examples/plugins/market-text` 验证业务替换：它只规范化显式传入的文本，可配置 `prefix`。该能力完全位于包目录，宿主通过统一协议发现和调用它。

当前模块 Worker 并不是操作系统安全沙箱。不要批准不可信代码在宿主上执行；本阶段不自动运行员工上传的脚本，也没有公共互联网市场自动同步。

## 资源、上下文与回传

资源引用的固定格式：

```json
{"id":"资源UUID","version":1}
```

`POST /v1/resources` 创建资料/成果，正文版本不可改写；`POST /v1/resources/:id/versions` 创建新版本；`PUT /v1/resources/:id/access` 用当前 revision 明确改变读者。个人、部门、公司及显式工作范围的 ACL 属于宿主。管理员身份本身不能展开个人资源。部门/公司资料发布还需 `resource.publish` 或管理员权限。

`GET /v1/resources?query=关键词&domain=分域` 只搜索已经授权的语料，返回元数据和覆盖范围，不返回隐藏正文片段。默认不列出各任务的私有过程原文。正文使用 `GET /v1/resources/:id?version=1&offset=0` 分页读取；过期或旧版本会明确标注。

Harness 的工作资料页可选协作工作及资源。`PUT /v1/harness/clients/:id/context` 保存下一回合的范围；工作选择只提供参考，不会隐式派工或恢复。清除资料范围会让下一回合独立开始。原生直接附件不作为权限来源，需要先保存为版本化资源。

实际模型网关使用宿主管理的单回合消息：不透传客户端的旧 system、整段旧会话或客户端自报工具结果。同轮只接纳模型真实返回及公司 MCP 的确认回执。需要旧成果时，读取检查点的结果引用，再按权限展开来源。预算超限或来源变更会拒绝后续请求，而不是静默切掉必要证据。

工具新增：`resource_index`、`resource_read`、`resource_create`、`skill_index`、`skill_read`；获准的岗位还可使用 `work_report` 提交 `{facts,artifacts,issues}`。执行中的管理工作可用 `resource_create.shareWithWork=true` 共享成果给该项工作当前获准参与者；私人对话不能借一个参考 workId 扩大共享。

`GET /v1/tasks/:id/result` 返回宿主控制事实、可读的 Agent 报告、成果引用及未决问题。模型事实标为 `agent_reported`，不能代替审批或成功回执；被撤权的引用不会出现在接收者摘要中。完整输出保存在本人私有资源中。旧任务按原有规则兼容，新任务即使成果登记失败也不会回退共享原文。

当前目录是有界 SQL 授权检索，不包含全量企业搜索、向量检索、文档连接器或自动刷新派生摘要。过期派生结论会标注来源变化，仍需重新核实。

## 管理员配置一次的事件来源

管理后台 → 自动协作 → 添加公司来源：默认观察模式；选择岗位预设或具体岗位、事件类型、职责、外部平台员工 ID 与公司身份映射。平台应用凭证仍由“外部机器人与 CLI”管理，不能从群昵称猜测身份。员工不需要再建个人 Bot 或逐个配岗位。

来源可勾选订阅框架新事件，例如插件的通用事件以及 `work.task_failed`。只订阅来源创建后的新事件；重复扫描不重复建工。工作结果未知只通知核实，原有监控不自动重放动作，辅助工作不会无限触发自己。

普通平台消息或 Webhook 的统一输入：

```json
{
  "externalUserId":"公司已映射的外部身份",
  "event":{
    "externalEventId":"来源内不可重复的消息ID",
    "threadId":"稳定会话ID",
    "eventType":"request",
    "summary":"有界的当前输入",
    "intent":"auto",
    "subjectRef":{"system":"权威系统名","id":"权威对象ID"}
  }
}
```

发送至 `POST /v1/hooks/event-sources/:sourceId`，使用创建来源时仅展示一次的 `Authorization: Bearer` 来源凭证。只允许映射中该来源的通用外部身份。已登录公司 CLI 可使用 `POST /v1/event-sources/:sourceId/events` 直接提交 event；不能伪造 principalId 或 companyId。

有有效 Thread 订阅就继续原工作；执行中到来的输入持久等待当前轮次结束，不重新执行已完成动作。明确 `intent=new` 才另建工作。跨入口只依据同一公司、同一员工、同一关联组和精确 subjectRef 找订阅，不作宽泛语义合并。

无订阅时先按岗位规则选候选。单候选确定归属；多候选且启用语义时，模型只看摘要与候选职责，无工具/私有记忆，按公司渠道记用量；越界输出、判断失败或歧义进入待处理。管理员在自动协作页确认归属，不能用这一按钮重放已有执行。

来源停用、人员映射或连接版本撤回会阻止路由、续接及新动作。停止/等待/结果待核实的工作不自动重启。受管平台普通消息支持自动协作；停止、恢复、核实使用工作中心明确操作，旧个人绑定入口保留原来的控制命令。

公司回信只发送状态与去工作中心查看的提示，不把私有过程或其他员工的原文发进群。发送结果未知的回信不自动重发。

## 隔离运行

使用独立 PostgreSQL 和新的 `FRAMEWORK_ROOT` 对应目录。`scripts/start-next-isolated.mjs` 只接受显式 `DATABASE_URL`，种子身份、Host 和凭证在 `.local/v06`，HTTP 仅监听回环 `127.0.0.1:55061`。本机模型凭证通过环境传入，不写进员工客户端。

```text
pnpm build
node scripts/start-next-isolated.mjs
node scripts/build-company-harness.mjs --profile=studio --channel=v06
```

原生构建需要按现有运行时准备流程安装的固定官方 Harness/Electron 工具。0.6 本机候选不替换旧桌面入口或0.4跨电脑安装包；当前证据不能代表签名、自动更新、干净设备安装、生产负载或真实平台授权验收。

参考：[iflytek/skillhub](https://github.com/iflytek/skillhub)、[DeepSeek SuperAgent 原型](https://github.com/deepseek-ai/dsh-superagent-prototype)、[Agent Skills 格式](https://agentskills.io/specification)。DeepSeek 仓库是研究原型，不能据此宣称完全无需管理员配置或已经具备生产级公司自动化。
