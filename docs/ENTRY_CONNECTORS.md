# A2远程隔离验证与外部入口

本轮目标：保持原8443测试服务、原账号/数据、原443业务不动，新增独立A2服务与数据库，通过8443的/a2路径提供访问。机器人适配器独立于业务内核，三个平台使用官方SDK双向长连接，CLI走同样公司账号、Work、权限、记忆、日志和用量接口。

## 接入与简便配置约定

- 企业微信优先复用官方开源CLI公开的二维码创建/查询流程；只能真实平台授权后取得Bot ID/Secret，不能用普通说明链接冒充授权二维码。
- 钉钉与飞书先提供管理员引导配置应用及连接检测；平台应用凭证只配置一次，员工绑定不用复制应用Secret。
- 绑定外部账号不能仅凭昵称或第一个发消息的人自动授予公司权限；采用短期绑定码、平台认证的sender ID和公司账号内的二次确认。
- 默认双向单聊；群聊只给受理/状态提示，工作正文在需要公司登录的工作页读取，避免把私人记忆成果直接发给群成员。
- 收消息持久登记后立即应答，后台创建Work；重复平台事件/进程重启不重复派工。回复丢失进入未知，不自动再发一次。
- 停止、等待、恢复和查询使用明确命令与工作引用；恢复要求指定新指令，不能因为普通消息自动恢复停止工作。
- 缺平台凭证时只声明协议夹具与真实服务器CLI验证；真正扫码/平台收发需要用户在自己的平台授权，不能把夹具算成真实联调。

## 一手依据

- [钉钉Stream官方说明](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/overview/)
- [飞书长连接文档](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)
- [企微官方Node SDK](https://github.com/WecomTeam/aibot-node-sdk)
- [企微官方CLI二维码实现](https://github.com/WecomTeam/wecom-cli/blob/1d48b6c9ecd1b4897c4bf728d564bfda1d62fbde/crates/wecom-cli/src/auth/qrcode.rs)
- [WorkBuddy扫码与手动接入流程](https://cloud.tencent.com/document/product/1831/134441)

## 实现与接口

三个入口共用可选可信入口模块 `EntryConnections`，通过 `ENABLE_ENTRY_CONNECTORS=1` 启用。平台 SDK 位于独立包 `connectors/im-bridge`，使用自己的精确版本和 lock；业务插件清单、根依赖与 Work 内核不需要引用平台 SDK。受限环境的 SDK 子进程只通过 IPC 传递认证事件和回复，不继承模型总密钥、不转储 SDK 的原始请求日志。生产启动前需在该目录执行 `npm ci --ignore-scripts --omit=dev`。

| 能力 | 接口或位置 |
| --- | --- |
| 公司连接配置、更新同一应用密钥、启停 | `GET/POST /v1/admin/entries`、`PUT /v1/admin/entries/:id`、`POST /v1/admin/entries/:id/enabled` |
| 创建/轮询企微授权二维码 | `POST /v1/admin/entries/qr`、`GET /v1/admin/entries/qr/:id`；公司管理员本人、5分钟有效、服务端限频 |
| 本人可用连接/岗位/绑定 | `GET /v1/entries/mine` |
| 发出绑定码、查询候选平台账号、确认 | `POST /v1/entries/bind`、`GET /v1/entries/bind/:id`、`POST /v1/entries/bind/:id/confirm` |
| 撤销本人绑定 | `POST /v1/entries/bindings/:id/revoke`；原记录保留，待处理事件重新鉴权 |
| 最近50次受理/回复记录 | `GET /v1/entries/events`；管理员限本公司，员工限本人 |
| 公司账号 CLI | `scripts/agent-cli.mjs`；复用员工登录、Work、控制、核实、历史接口 |

连接密钥与平台消息使用宿主 AES-GCM 密钥加密保存；二维码服务端 `scode` 和 Bot Secret 不返回列表、不进入审计正文。备份新宿主数据时必须同时保全 `.entry-key`，丢失该文件无法恢复加密连接。此版本面向公司审查过的 SDK 和插件，不宣称提供不可信代码沙箱。

平台事件按连接和平台消息 ID 幂等持久化后才确认。等待中的 Work 不占用入口消费者；控制指令优先，等待事件按更新时间轮转。已完成的副作用沿用 A2 回执复用。发送结果未知不自动重发，改密钥/撤销绑定后旧事件不会继续使用旧授权。准入拒绝、执行结果待核实、发送结果待核实分别显示，已提交 Work 的异常不会被表述为“未执行”。

## 管理员和员工操作

1. 在独立测试后台左侧打开“外部机器人与 CLI”。企微点“企微扫码创建”，填写测试连接名，再点“生成企微授权二维码”，用企业微信扫码并确认。二维码过期需重新生成。
2. 钉钉/飞书使用“配置钉钉 / 飞书 / 企微”：在对应平台创建企业自建测试应用、启用机器人和官方长连接，配置接收消息事件与所需发送权限，将可用范围先限测试员工。钉钉填写 Client ID/Client Secret；飞书填写 App ID/App Secret。列表显示连接状态，密钥不回显；修正凭证使用“修改密钥”。通知用群Webhook不能替代这个双向接入。
3. 员工在自己的授权工作中心点“连接机器人”→“绑定本人账号”，选择公司连接和自己的岗位，将一次性 `/bind ...` 指令发给机器人，再回公司工作中心核对真实平台用户编号并确认。配置应用与授予员工身份分开，管理员没有仅靠昵称自动授予权限的捷径。
4. 绑定后，单聊发送任务。`/status` 返回本人近期工作及 `W-000001` 这样的短编号；`/stop W-000001 原因`、`/wait W-000001 问题`、`/resume W-000001 明确新要求` 走同一工作控制。完整结果需公司权限；群聊仅发状态。

CLI 使用 Node24.9+，从项目根目录运行；密码交互输入或从标准输入读取，不通过明文命令行参数传递：

```powershell
node scripts/agent-cli.mjs login --server https://agent-test.example.com:8443/a2 --username 员工账号
node scripts/agent-cli.mjs agents
node scripts/agent-cli.mjs work create --agent 自己的岗位ID --text "执行通用验证" --key 唯一请求号 --wait
node scripts/agent-cli.mjs work get --id 工作UUID
node scripts/agent-cli.mjs work history --id 工作UUID
node scripts/agent-cli.mjs work stop --id 工作UUID --reason "停止原因" --key 唯一控制号 --wait
```

CLI 用 `--config` 指定独立账号文件；Windows 用 DPAPI 保护设备令牌和请求日志，其他平台文件权限0600。修改命令必须带 `--key`；重试同一键会复用首次请求及 revision，换参数不可复用该键。网络中断不自动换键重放。CLI 目前接受底层 Work UUID，机器人短编号不等于 UUID。

## 真实服务器验收（2026-11-14）

- 独立 URL 为 `https://agent-test.example.com:8443/a2/`。新 `/srv/company-agent-a2-test`、`caf-a2-app`、`caf-a2-db`、网络及数据卷，仅新增 `/a2/` 代理；原测试应用未升级，原账号和发行下载清单未改。新连接 cookie 使用 `/a2/`、Secure、HttpOnly，公开前保存原代理和原始数据校验值。
- 新建3个隔离账号/岗位（负责人、测试员工、同级核对员工）。Windows CLI经公网HTTPS实际公司账号登录，只列本人岗位；跨员工记忆403，原生客户端 model/MCP 地址均带 `/a2`。没有导出公司模型总密钥。
- 真实 Linux Harness SDK/DeepSeek：工作 `8cf84fe1-47d4-4256-8c63-79a50aa93c5d` 第一轮报告后 `work_wait`；只重启新 A2 应用，等待状态与 revision 保持。员工通过CLI显式恢复，读取本人 checkpoint、复用报告回执，规范化输出 `A2 CLOUD RESUMED`。两轮共6个provider计量请求，2767输入/291输出tokens；报告1条、回执复用1次，旧Task为cancelled、新Task成功，后台可查日志和用量。
- 工作 `6d137e61-8580-4f12-8f02-53b382b587e4` 在真实执行中由CLI发停止。模型请求在途取消，响应/计费没有可信回执，因此先保留 `reconciliation_required`，没有冒称已确认停止。核对旧执行进程0、动作账本0、停止后工具成功数0并保持稳定后，由独立管理员提供证据确认执行端关闭，最终为stopped，旧Task仍保留reconciliation_required。此请求计量继续标为unavailable，不编造tokens或退款。
- HTTPS后台实际生成企微官方授权二维码、展示280px图像并持续轮询；管理员页和员工连接页可打开，员工没有管理员配置按钮和管理员API请求；页面无脚本异常，1440/1365宽度无横向溢出。扫码确认/三平台真实消息收发尚未完成，协议测试和二维码生成不替代真实企业授权。
- 原34个容器ID、启动时间、重启计数和运行状态逐项一致；原员工/Agent/记忆/账号的数量与内容hash一致；443业务页和8443根测试页字节一致。新数据库独立保留本次所有旧轮次、审计、任务和用量。
- 59文件128项全量测试、类型检查和构建通过。用户随后要求先模拟而不实际扫码，新增3个平台完整流程测试；接入相关4文件19项复测和类型检查通过。模拟经过真实HTTP契约、数据库、EntryWorker、Work和TaskQueue；平台Transport和任务执行器为替身，覆盖字段校验、未绑定拒收、绑定码/跨公司拒绝/本人确认、重复消息只执行一次、短编号查询、等待/新轮恢复/停止和撤销后拒收。该模拟的停止发生于工作结果返回后，不替代上述真实执行中停止验收；也不代表三平台认证或模型实际调用。
- 其余自动测试覆盖真实PG、SDK子进程+本地WebSocket协议、三个平台消息归一、持久确认失败分类、控制队列、防错误指令付费派工、群聊隔离、未知发送、二维码授权协议夹具、CLI实际进程和DPAPI、子路径原生客户端地址、提交后未知提示及未知标记保持。夹具未调用真实客户账号。

本轮未重打员工安装包、未切换原发行服务，未接客户/财务等真实业务。原8443根入口的旧员工不能直接当新A2账号使用，这正是隔离测试的边界。后续需先完成真实企业授权收发，再选择把经过验收的入口能力合并到公司Harness发行和正式部署。

## 运维与保留

- `scripts/staging/a2-baseline.sh`：只在新测试根首次执行，拒绝覆盖原基线。
- `deploy-a2.sh`：首次部署；发现同名容器/网络/数据卷就拒绝隐式复用。
- `update-a2-candidate.sh`：仅对已经停止的隔离候选更新，先备份源码；不删除state或数据库卷。
- `publish-a2-route.sh`：添加单独子路径；改旧测试代理之前先备份并安装回退，失败恢复。
- `verify-a2-preservation.sh`：比对原容器、原4类数据校验值与两个原首页。
- `unpublish-a2-route.sh`：仅当其余代理未变化时撤除/a2，写前备份当前版本、失败恢复；数据库和记录保留。

服务器共享硬件，CPU/RAM限额与独立数据库降低影响，不能声称硬件完全隔离。执行中模型请求取消后可能留下无法向服务商确认的计量；保留未知比宣称零消耗准确。企微二维码创建协议来自官方CLI，属于可能变化的平台能力，后续应监控官方变更。
