# 统一接入标准：插件、身份、任务与事件

本版扩展现有插件插座，不将销售、财务或客户字段引入内核。DeepSeek Harness 是员工交互与 Agent 运行层；公司宿主负责身份、授权、计量、独立记忆与持久协作。

## 插件包与兼容

入口仍为 `agent-plugin.json`，由根目录 `plugin.schema.json` 验证。包版本不可变，挂载锁定精确版本；升级另发版本。现有 schemaVersion=0.1.0、协议1.0、engine.framework 的0.1插件ABI继续兼容；新增 schemaVersion=0.2.0 在同一ABI上声明工具级 hostServices 和 host effect。旧宿主不认识0.2结构时拒绝安装，不能静默降级。产品功能里程碑“下一版”不等于把旧包的版本范围强行改成兼容。

标准包包含入口模块或已注册远程连接、配置Schema、每项工具的输入/输出Schema、权限请求、预设、事件类型和依赖。调用顺序为 plugin.initialize → capability.describe / plugin.health → tool.invoke → plugin.shutdown。注册工具集合必须与清单一致。模块用 `apply(ctx)` 注册工具；完整类型见 src/plugin-sdk.ts，实际范例见 packages/work-assistant。

工具的 effect：read 表示读取；host 表示使用受控宿主服务改变内部任务/提醒/事件状态；write 表示外部写入，仍需精确输入的一次性管理员审批。host 工具要求0.2清单且非空 hostServices；不能用 host 标签绕过外部写工具的声明与审批。插件包是经过管理员审核的代码，标签不提供恶意代码沙箱保证。

有效能力取交集：已启用且挂载的精确包版本、工具声明、工具级 hostServices、Agent.allowedTools、Agent.servicePermissions、员工工具与服务授权，以及当前组织范围。预设和插件请求不授予权限。每次调用重新检查，已排队工作开始前重查派工授权、源插件版本和允许目标。

开发检查：先运行 `pnpm build`，再执行 `node scripts/check-plugin.mjs packages/work-assistant`。该命令在隔离目录验证包/Schema/注册工具/生命周期，不连接公司DB、不授予服务、不调用模型。远程插件需额外用自己的测试服务验收协议；真实业务动作与审批必须单独回归。

## 身份与服务

API 的 principal/company 来自认证，不能在正文指定。插件只收到 runRef 和绑定当前调用的服务，不能传入另一人的身份。服务参数用相同严格Schema验证；时间必须是有Z或明确偏移的ISO时间。外部系统主键只用 subjectRef={system,id} 引用，不被当成工具授权。

| 宿主服务 / SDK | 必要能力 | 作用 |
| --- | --- | --- |
| team.list / services.team.list | team.read | 当前授权人员及岗位摘要 |
| work.dispatch / services.work.dispatch | work.dispatch + 目标派工及查看范围 | 一项工作分配1至8个不同Agent |
| work.list、work.read | work.read + 当前目标查看范围 | 本人可见工作及结果摘要 |
| reminder.create / services.reminders.schedule | reminder.write + 目标范围 | 持久提醒，默认当前Agent |
| reminder.list | reminder.read | 本人收到或发起的提醒 |
| inbox.list | inbox.self.read | 本人通知，不查询他人收件箱 |
| event.publish | event.self.publish | 绑定插件来源、当前Agent的问题事件 |
| memory.read、memory.write、report.record | 现有 memory.self.*、report.self.write | 当前Agent的独立记忆及报告 |

派工和提醒的跨Agent目标还必须在源Agent.delegates内，团队权限不自动扩大可调用工具或私有记忆。模型没有人工核对宿主服务。

## 工作、状态与回执

`POST /v1/work`：{title,idempotencyKey,assignments:[{agentId,prompt}],dueAt?,subjectRef?}。HTTP202只代表接受；返回workId、taskId、ownerId、状态和结果引用。每项任务以目标所有者身份执行，保留发起者。创建在同一事务入队，任一目标无权时整批拒绝。重复同键同内容返回同一工作，同键变更返回409。

队列任务：queued → running → succeeded / failed / waiting_approval / reconciliation_required / cancelled。工作汇总：queued / running / needs_attention / waiting_review → completed 或 changes_requested。全部任务成功后仍等待人核对。人工POST `/v1/work/:id/review`：{revision,decision:approve|reject,reason}；版本变化或已有不同决定时409。负责人可看工作结果；完整结果通过授权 taskId 查询，不复制对方私人笔记或全部聊天。期限到达发一次通知，不谎报完成、不强制重放。

组织变动会重新限制可见分配；摘要可能含受限任务数量。taskId / workId / runId / invocationId / eventId / reminderId分别标识不同生命周期，不能相互替代。工具有 invocationId / runId / outcome / output / evidenceRefs 回执；业务插件应返回业务引用和真实执行状态。网络超时后的未知动作必须核对，不能直接当失败重做。

同一项协作共享预算组、各员工分别记用量。由Harness当前轮发起的工作继承当前轮预算；工作分配不能再发起另一棵派工树。通用自动异常辅助每个原失败任务最多一次；结果不确定只通知。辅助工作中发布的事件只记录，不再次自动触发工作。

## 提醒、问题与外部通道

`POST /v1/assistant/reminders`：{agentId,title,dueAt,details?,subjectRef?,idempotencyKey}；到期写入对应员工内部收件箱。取消、投递、幂等和通知在事务中处理。到期重新验证创建者、源岗位/工具授权、接收岗位所有者，失权则取消。后台调度不消耗模型。

`POST /v1/assistant/events`：{agentId,type,summary,subjectRef?,idempotencyKey}。来源由宿主绑定，管理员规则固定事件类型、来源员工白名单、处理岗位和提示模板。模型写在summary里的“管理员”“新授权”无效。规则只创建受限工作，处理结果等待人核对。普通事件可匹配规则；work.task_failed来自可信任务监控，只有已知failed才触发一次辅助。规则所有者失去管理员资格时不再启动处理。

钉钉、飞书、企微、自研系统接入时：适配器验证各平台签名/时效及防重放，将平台用户映射到公司员工身份，将messageId映射到幂等键；路由同一工作/事件服务并保留来源命名空间与subjectRef。不得信任Webhook正文里的principalId。对外消息、约定提醒投递及发布必须取得对应通道配置与工具授权。本版已经有通用内部工作Bot和收件箱，尚未连接任何真实通信平台或客户系统。
