# 服务器测试环境

2026-11-13：员工账号密码与独立HTTPS代理已上线测试，地址为 `https://agent-test.example.com:8443`。经用户明确确认，仅新增全部IPv4来源的TCP8443云防火墙允许规则，原22/80/443/Ping四条规则保留。公网证书校验、健康检查、账号登录、Windows原生Harness任务及HTTPS管理登录均通过。换机步骤见 [员工账号说明](ACCOUNTS.md)。

2026-11-13 已部署到 `203.0.113.10`，并完成本机原生 Harness 连接云端的验证。物理第二台电脑尚未验收。

## 体验入口

- 双击工作区 `.local/云端测试员工.cmd`，打开已登录的“账号换机验证员工”，点击“打开 Harness”。工作在原生客户端中完成。
- 双击 `.local/云端测试后台.cmd`，以新的短时入口打开云端管理后台。
- 员工客户端直接使用公网HTTPS；操作员后台脚本仍用已有管理SSH连接签发短时票据，再打开HTTPS网页，不向员工分发管理连接。
- 当前员工发行清单为 `.local/staging/employee-client-https-release.json`，设备目录为 `.local/staging/https-employee-device`。另一台电脑仅需HTTPS员工ZIP和自己的账号。
- 原来的本机4317服务和第一轮SSH隧道发行/设备目录保留，旧隧道包不用于账号版跨电脑体验。未导入真实公司人员或业务数据。

## 隔离配置

| 项目 | 测试范围 |
| --- | --- |
| 目录 | `/srv/company-agent-staging` |
| 容器 | `caf-staging-app`、`caf-staging-db`、`caf-staging-tls` |
| 网络 | `caf-staging-network`，不连接现有业务网络 |
| 数据库 | PostgreSQL18.4 / `caf_staging`，独立随机密码 |
| 数据卷 | `caf-staging-pgdata`，PG18 挂载到 `/var/lib/postgresql` |
| 文件 | 当前 `accounts-20261113T100410Z/release` 只读；`state` 可写；`private` 存测试凭证与证书副本 |
| 入口 | 独立TLS代理公开8443；应用仅服务器loopback14317；数据库不映射主机端口 |
| 上限 | 应用 1 CPU /1.5 GiB；数据库 0.5 CPU /512 MiB；TLS代理0.25 CPU /128 MiB |
| 日志 | 各容器 10 MB ×3 |

没有修改现有Nginx、DNS、80/443、Docker daemon或线上数据库，也没有重启线上容器。防火墙仅按用户确认新增8443，不改原规则。原443首页内容摘要和11个线上容器ID/启动时间/重启次数均与变更前一致。共享服务器仍存在磁盘/网络资源竞争；测试包上传限速约1 MB/s，这不是硬件隔离。

测试TLS代理使用服务器内同域名有效证书的独立副本，未改原证书或原站点配置。副本当前有效期至2027-02-01，续期后需单独刷新副本并重新加载测试代理，尚无自动同步。原旧测试应用容器 `caf-staging-app-before-accounts` 停止保留；不要与新应用同时启动。升级前数据库dump已保存，还原尚未演练。

应用以 UID1000、只读根文件系统、移除 capabilities 和 no-new-privileges 运行。受限大小的 `/tmp` tmpfs 显式允许 exec，因为 Harness 的原生 N-API 模块会先复制到缓存再加载，noexec 会使真实任务启动失败。只接受审查过的插件，尚未提供完整的不可信插件沙箱。

## 构建与版本

- Node24.17.0 bookworm-slim：`sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532`。
- PostgreSQL18.4 bookworm：`sha256:882236b897e39051d2368c5ccc6cda944904723506b2dfc97f2a8f5bc9afa382`。
- Docker Hub 直连超时，实际只为本项目从腾讯云 `mirror.ccs.tencentyun.com/library/…@sha256:…` 拉取，不修改全局镜像源。
- 一次性限额构建容器使用 pnpm11.28.5、冻结 lockfile、显式 `--ignore-scripts`，不升级服务器系统依赖。
- `node --env-file=.env scripts/staging/prepare.mjs` 构造新的白名单发行目录；`node scripts/staging/validate-artifact.mjs` 检查运行文件、空状态挂载点和私密内容排除。
- `.env`、本机员工数据、数据库、node_modules、私钥不进入源码包。模型配置白名单和新数据库凭证单独保存在 `.local/staging/private` 后上传，不复制本机旧员工令牌。
- 独立员工包命令：`node scripts/build-employee-client.mjs --server-url https://agent-test.example.com:8443 --manifest .local/staging/employee-client-https-release.json`，保留默认本机和旧隧道发行清单。ZIP不含员工身份、SSH私钥、管理员令牌或模型总密钥。

`deploy.sh` 拒绝同名已有容器或非本项目目录，不自动覆盖正在运行的发行。0.1 尚无自动滚动升级。

## 第二台 Windows 电脑

1. 管理员在云端后台为该员工创建身份和Agent，配置预设、插件及权限，签发一次性激活码。
2. 将HTTPS账号版员工ZIP复制到第二台电脑，解压整个CompanyAgent，不复制第一台电脑的identity.json或员工数据。无需安装开发环境或配置SSH。
3. 双击“启动员工Agent.cmd”。首次选择“首次接入 / 重置密码”，用管理员给的码设置个人密码；之后直接用员工编号和密码登录。
4. 同一员工换电脑使用已有Agent和私人记忆；不同员工分别测试岗位、记忆和权限隔离。后台查看设备、日志、报告和用量归属，再验证设备撤销。

旧受限SSH测试账号仅保留作第一轮测试连接，无sudo/Docker组和命令/PTY权限，目标限制为loopback14317，不属于新员工包。正式推广仍需客户端统一更新及完整生产验收。

## 停止和恢复

通过已有 Ubuntu 管理连接执行：

```bash
cd /srv/company-agent-staging
bash rollback.sh
```

脚本核对目录标记和项目 label，只停止测试容器，保留数据和卷。恢复已有测试容器：

```bash
sudo docker start caf-staging-db
sudo docker exec caf-staging-db pg_isready -U caf_test -d caf_staging
# 上一步确认 ready 后
sudo docker start caf-staging-app
curl --fail http://127.0.0.1:14317/health
sudo docker start caf-staging-tls
curl --fail https://agent-test.example.com:8443/health
```

永久撤销测试网络凭证时，先停测试，核对 `/home/caf-stage-tunnel` 属于本项目后将该账号的 `.ssh/authorized_keys` 改名保存；不修改 Ubuntu 原有 authorized_keys 或 SSH 全局设置。

可用 `sudo docker exec caf-staging-db pg_dump -U caf_test -d caf_staging -Fc > private/caf-staging.dump` 备份数据库并设置600权限，另保存 state 和受保护的 private。备份还原尚未演练；停止和重建测试容器、保留数据卷已实际执行。

## 验证证据

2026-11-13 自动更新增量：只更新当前测试发行中的app.js、ui.js和views.js，使用 `scripts/staging/update-console.sh` 原子交换web目录，未重启应用。旧web保留于 `/srv/company-agent-staging/console-refresh-20261113T114003Z/next-web`，部署失败时脚本会尝试交换回旧目录；本轮未演练更新完成后的人工回滚。见 [后台自动更新说明](CONSOLE.md)。真实原生任务和后台自动同步证据为 `.local/staging/console-live-native-smoke.json`；前后生产容器快照为 production-before-live-refresh.txt / production-after-live-refresh.txt。

以下前三份为当前公网账号版实际验收：

- `account-two-profiles-smoke.json`：同一物理电脑上两份全新设备配置，通过公网注册/登录同账号，独立设备凭证、同账号记忆、跨员工拒绝及员工管理权限拒绝。
- `account-native-https-smoke.json`：Windows原生Harness真实任务 `6fefaac5-1273-44e4-80dc-7f98f4e4a353` 成功，插件/记忆/报告回执和7次模型请求用量，另一设备配置读取结果成功。
- `console-https-smoke.json`：公网HTTPS管理登录、Secure Cookie、来源检查、匿名下载拒绝及授权下载成功。
- `production-before-accounts.txt` 与 `production-final-accounts.txt`：11个线上容器ID、StartedAt、RestartCount一致；`original-sales-before.html` 与 `original-sales-final.html` 内容SHA256一致。
- `deployment.json`：当前公网测试地址、隔离范围和最终复查结果。物理第二台电脑尚未验收。

下列为第一轮SSH隧道历史证据，位于 `.local/staging`：

- `.local/staging/production-before.txt` 与 production-after.txt：11个线上容器 ID、StartedAt、RestartCount 相同。
- live-harness-smoke.json：Linux 真实官方 SDK + DeepSeek，插件、显式记忆读取、报告回执成功；3请求、879输入/216输出 tokens。
- isolation-smoke.json：激活和独立岗位、私人记忆双向拒绝、管理权限拒绝、真实插件调用、重复激活拒绝、撤销设备后拒绝。
- native-onboarding-smoke.json：独立 Windows 员工包原生 Harness 经隧道连接云端，任务、插件、报告成功；3请求、1937输入/379输出 tokens；另一员工0请求。
- 员工客户端与测试隧道进程退出后，两个一键入口重新建立连接；已保存身份无需再次激活，原生 Harness 可重新打开。测试连接执行命令、转发至线上80端口均被拒绝。
- 员工ZIP已上传服务器并校验SHA256，管理端下载接口HEAD返回200/application/zip。第一轮隧道版未附带私钥；目前后台已切换为无需隧道的HTTPS账号版ZIP。
- 首次失败日志保留，修复了容器挂载点和原生模块加载条件，没有覆盖失败历史。

重复验收原生回合使用 `node scripts/staging/verify-onboarding.mjs --settle --run-id <本次回合ID>`，按该回合检查终态、用量和回执；不存在的回合必须失败，不能复用历史成功充当本次结果。

尚未接入钉钉、飞书、企微、业务系统或真实第二台电脑；没有宣称生产可用。
