# 公司私有部署

同一套框架可放到公司主机。员工软件连接公司内网HTTPS地址，账号、组织、任务、记忆、日志、用量与渠道配置存到本地主机；更换云端/内网地址不需要改业务插件接口。

当前已交付部署文件与静态预检，未提供公司主机，尚未在目标内网机器执行Docker部署。当前电脑没有Docker；配置验证不等同于镜像构建、主机运行或离线模型验收。

## 目标主机准备

推荐使用专门长期运行的Linux主机或虚拟机、SSD、稳定局域网地址及备份盘；容量和并发按实际文件量和负载测试确定。先保持MAX_CONCURRENT_AGENTS=3，监测内存/CPU/等待时间再提高。员工数量不等于同时推理任务数。外部模型API不要求这台主机有GPU；本地模型/生图/视频则需另评估显存与模型部署。

1. 安装Docker Engine及Compose插件。检查本机172.29.83.0/24与公司网络/现有容器不冲突；冲突时同时修改Compose网络、固定地址和TRUSTED_PROXY_IP。
2. 将本项目源代码放到专用目录；不要复制开发机.env/.local/设备身份。复制deploy/private/.env.example为同目录.env，填真实LAN_IP、内网DNS名称及端口。DNS应把名称指向该主机局域网地址，端口仅允许公司网段。
3. 在deploy/private/private/database-password.txt保存随机强密码（至少24字符），目录仅主机管理员可读；勿提交源码。Compose作为文件secret挂载，不把口令写到配置或日志。该文件不由预检自动生成或输出。
4. 执行 `node scripts/private/preflight.mjs` 检查配置，再执行 `docker compose --env-file deploy/private/.env -f deploy/private/compose.yaml config --quiet`；配置检查本身不启容器。
5. 确认目标主机和端口后执行 `docker compose --env-file deploy/private/.env -f deploy/private/compose.yaml up -d --build`。
6. 网关使用Caddy内部CA。公司IT应把其根证书分发到员工电脑信任库，或改用公司已有受信任证书；软件启动的Node客户端与原生进程启用系统CA支持，不关闭TLS校验、不自动改Windows信任设置。证书/CA私钥属于公司机密，不放入员工安装包。若服务端调用另一个使用内部CA的模型端点，还需为应用容器配置只读根证书及NODE_EXTRA_CA_CERTS；不能假设容器自动继承主机信任库。
7. 健康检查通过后，在服务器通过已有ConsoleSessions签发管理员短时入口（写入私有文件，参照scripts/staging/issue-console.mjs；将来源改为内网PUBLIC_ORIGIN）。在后台创建组织、员工及岗位、设置模型渠道，再生成指向内网HTTPS地址的员工包。员工用公司账号密码登录。

Compose不发布数据库或应用端口，只把HTTPS绑定到指定LAN_IP。网关有固定代理IP，应用不信任来自任意地址的转发头。服务项目标签、网络与数据卷独立于原云端测试项目。新主机部署不应通过复制旧测试容器命令覆盖公司的其他系统。

## 数据、容量和备份

| 数据 | 保存位置 |
| --- | --- |
| 组织、账号验证、任务、记忆正文、日志、用量、加密渠道凭证 | database数据卷的PostgreSQL |
| 私有记忆Markdown投影、插件包、SDK运行目录、设备/接入状态 | state数据卷 |
| 渠道解密主密钥 | state卷host/.channel-vault-key，权限受主机控制 |
| 内网CA与HTTPS证书 | certificates卷；保护CA私钥 |

数据库dump必须与state（尤其解密主密钥）、证书和受保护数据库密码一起纳入备份。恢复到隔离目录/空数据库演练，保持FRAMEWORK_ROOT不变（数据库命名空间与路径关联）。先停服务取得一致备份，保留旧数据；不要执行`down -v`清空数据卷。数据容量可扩SSD/磁盘卷，但完整大文件资料库、对象存储、索引更新和知识审核发布仍需后续接入，当前不能把任意大文件夹视为已经具备知识检索。

这是权威业务数据集中保存的位置。员工电脑仍会保存受Windows DPAPI保护的设备登录身份、原生Harness聊天/运行缓存及本机工作文件；集中存储不等于终端没有数据。员工离职时应撤销设备，并按公司终端管理制度处理缓存和文件。

## 数据在本地与完全离线

数据持久存储在公司主机，并不意味着模型推理在公司。如果使用DeepSeek等外部API，经过权限筛选后提交的提示、工具结果及必要知识片段仍发送给对应提供商。后台接口文档应明确每个渠道的用途与数据去向。

完全离线要在内网另部署模型服务，并提供框架支持的Anthropic兼容接口；生图/视频/语音也各需本地模型或内网服务。可通过现有部署端环境配置受信任的内网模型端点（服务间网络使用公司安全策略）；员工客户端仍用HTTPS。公司“AI大脑”还包括知识索引、权限、SOP版本、可靠业务连接、反馈与审核，而不是仅增加硬盘容量。

官方依据：[PostgreSQL容器数据目录](https://hub.docker.com/_/postgres)、[Caddy发布](https://github.com/caddyserver/caddy/releases/tag/v2.11.8)。此处版本为本次配置固定版本，正式投产前应在目标硬件构建、恢复和压测。
