# 公司 Agent 框架与 Harness 扩展

产品边界：框架内核管理员工身份、授权、Agent、工具挂载、记忆、任务、日志、用量和版本；岗位预设定义工作范式；Harness 桌面、Harness Web、机器人和管理后台是入口。业务系统通过独立插件接入，内核不内置部门业务。管理后台继续用于运维配置，不替代员工使用的 Harness。

## 已实现的参考范式

`packages/harness-company-bundle` 是原生 Harness bundle：`package.json → dsh.bundle.patch → cordis.patch.yml`。构建从 `presets.json` 生成 `@deepseek-ai/dsh-agent-preset` 行，并通过原生 `dsh-persona` 组成岗位。当前有岗位员工、团队负责人、跨团队统筹三类参考范式。它们不限定编程，也不自动授予权限。销售、财务、人事等岗位组合应作为外部业务包添加。

Agent 用 `preset: {id, version}` 固定范式版本，个人回复风格、岗位补充指令、工具挂载和权限独立配置。管理员通过 Agent 编辑页选择预设；升级范式需要显式更改版本。开发者可在可信部署目录提供同协议的 `presets.json`，通过 `FrameworkOptions.presetDirectories` 注册；同一 id/version 不可重复。框架不会执行预设 JSON 中的代码。

Harness SDK 的真实进程使用原生 preset registry 挂载；已有 SDK-minimal 流程没有选择界面，因此 bundle 的 binding 扩展在 `agent/created` 时挂载已授权岗位预设。桌面与 Web 采用原生选择机制。受管员工连接默认只配置该员工被分配的岗位，完整三类目录用于框架开发参考。

## 本机体验

```powershell
cd C:\projects\tongzhou-agent-framework
npm run build
pwsh -NoProfile -File scripts/start.ps1 -SkipBuild
pwsh -NoProfile -File scripts/setup-harness-desktop.ps1
# 首次参考验证会建立 reference-bot，仅使用通用验证插件，并产生模型费用
npm run smoke:bot
# 打开真正的官方 Harness Windows 客户端，挂载公司连接包
npm run harness
# 可选的原生 Harness Web 入口
npm run harness -- --web
# 可选的任务型 Bot 参考入口
npm run bot
```

这里使用官方签名的 Desktop `0.2.2-rc.2` 及其完整原生界面与运行时，不重写官方聊天界面，也未修改签名二进制。公司二开当前采用原生 bundle、岗位预设与服务端适配，而非维护一份整个上游仓库的 fork。锁文件固定安装包、EXE、ASAR 摘要；下载地址变化但摘要不匹配时停止。包只解压在项目 `.tools` 下，没有操作其他 Harness 安装和用户个人 profile。安装工具需要本机已有 7-Zip。

启动器为当前员工申请两小时的、固定到一个 Agent 的连接。桌面只获得连接凭证；DeepSeek 总密钥保留在公司服务端。首次连接只注入该 Agent 的限长 INDEX；其他笔记由记忆工具按需检索和读取。原生对话的每个工作回合通过现有宿主并发、工具白名单、上下文与 token 预算校验，按员工与 Agent 记录真实 provider usage。

公司连接是 `@company/framework-connection` 原生 bundle，位于每个公司 profile 自己的 deployments 目录。刷新连接只更新它自己的包，员工 `cordis.patch.yml`、自定义插件、界面偏好和会话不被覆盖。原生会话标题使用本地确定性回退；关闭后台标题模型请求，避免辅助请求与主任务争抢一个 Agent。公司模式的模型请求只向服务商暴露公司实际授予的工具，原生 UI 的本地工具展示不能改变服务端授权。

插件必须部署在 `profiles/<入口>/deployments` 内：Harness 的官方依赖路由只覆盖 profile 和已声明的 linked root，放到 home 顶层会导致官方组件无法解析。原生桌面通过 `--user-data-dir` 同时隔离 Electron 偏好与缓存；`DSH_HOME` 隔离 Harness 配置、会话和存储，不依赖仅开发环境支持的用户目录变量。

公司连接插件通过公开的 `session/event`、`agent/created`、`llm/stream` 生命周期挂载。每次模型与工具请求都绑定原生会话和回合，另一个聊天不能借用正在执行的回合。停止后等待已开始的工具与计量收尾，再释放岗位占用；未知回执保留待核对。员工或岗位配置变化后旧连接失效，重新打开客户端获取最新授权，不能继续使用旧配置。每位员工最多五个连接；一个连接同时只执行一个原生工作回合。

开发启动默认使用本机 `alice → reference-bot`。开发账号文件 `.local/access.json` 只用于开发机，不能打包发给员工。手工 `--token-file` 仍可用于调试；普通员工现在使用独立客户端和一次性激活码接入，见 [EMPLOYEE_ONBOARDING.md](EMPLOYEE_ONBOARDING.md)。关闭后重开刷新原生连接，服务端重启使旧连接失效。SSO、统一更新与生产部署仍未完成。

## Bot 与消息入口标准

本机 `POST /v1/bot/messages` 接收 `{agentId, conversationId, messageId, text}`，员工身份从已验证的登录凭证读取；客户端不能指定 principalId 或冒用平台身份。返回现有异步任务回执，通过 `/v1/tasks/:id` 查询。消息身份先持久化再受理，重复投递复用原任务；同一消息改内容或改目标会被拒绝。崩溃发生在受理与回执之间时，可重投相同消息安全恢复。

可信渠道适配器在完成平台验签与组织成员映射后调用 `BotGateway.accept({principalId, channelId}, normalizedMessage)`。平台自己的 app/tenant/sender/conversation 身份必须纳入服务端 `channelId` 与身份映射命名空间，不能直接相信回调内声称的公司员工编号。对外消息回复、附件、群与个人会话的访问、幂等确认由适配器实现；发给谁也由明确的负责人/会话绑定决定。当前只有本机验证入口；钉钉、飞书、企微仍标记未连接，没有伪造成功回调或发送真实消息。

不同入口沿用同一 Agent 的记忆、授权与审计。同一 Agent 正在执行时，队列只对宿主明确确认“尚未开始执行”的并发占用等待重试，最多 30 秒；回执未知、外部副作用未知和普通远程 CONFLICT 均不自动重放。不同 Agent 可在宿主当前三个并发额度内并行。

## 当前范围

这是可运行的框架参考版本。机器人入口目前按消息创建任务，长期信息存入 Agent 自己的记忆；尚未实现跨聊天的自动对话摘要、附件与群消息平台适配。Harness 原生会话保留自身对话历史，但仍受公司最终上下文预算限制。

完整的公司品牌客户端、员工 SSO、统一安装与更新分发、后台管理界面在 Harness 内的进一步整合、生产网络部署和真实通讯平台应用仍需开发。Windows 员工长期身份现已采用 DPAPI 保护。官方 Desktop 的升级操作不能视为公司发布系统，生产发行仍需公司渠道与签名策略。本版不承诺无人审批的付款、投放或发布。

真实桌面、Bot 和跨入口验证结果见 [HARNESS_QA.md](HARNESS_QA.md)。
