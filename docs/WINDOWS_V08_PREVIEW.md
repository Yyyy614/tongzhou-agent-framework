# 同舟0.8 Windows隔离体验版

从[0.8 Release](https://github.com/Yyyy614/tongzhou-agent-framework/releases/tag/v0.8.0-preview.1)下载安装向导或完整便携ZIP。完整解压后双击“同舟.exe”，包含桌面和Node运行时；登录、岗位选择和工作中心都在Harness内。

本轮默认连接本机`http://127.0.0.1:55081`。包只含客户端，不把旧云端0.7当作0.8后台；公开下载不提供公开员工账号。

## 启动配套宿主

克隆同版本源码，按README配置Node、依赖、独立开发PostgreSQL及`.env`中的模型渠道，在源码目录运行：

```powershell
node scripts/build.mjs
node --env-file=.env scripts/start-v08-isolated.mjs
```

宿主仅监听本机，使用`.local/v08/host`对应的新schema初始化合成员工与岗位，保留既有隔离数据。管理员凭证写入`.local/v08/access.json`，员工账号写入`.local/v08/employee.json`；安全发放，不能上传。后台为`http://127.0.0.1:55081/console`。DATABASE_URL须指向开发数据库，不要填写生产库试运行。

登录岗位后，在“工作依据与记忆”选择工作、查看历史、归档完成条目和展开来源集合。“应用到下一回合”仅关联工作，不自动恢复已停止或待核实的执行。已有草稿先保存/载入再归档；归档期间新输入保留并提示合并。

## 另一台电脑和私有部署

另一台电脑需有同版本、可访问的HTTPS宿主。管理员部署后修改安装目录`resources/app/company.json`中的公开`serverURL`，再用该宿主创建的员工账号登录。配置文件不写API Key或密码。内网部署沿用相同权限、存储和来源规则；模型是否出网由公司渠道决定。本轮没有切换旧云端服务。

0.8使用独立安装GUID、安装名称、快捷方式“同舟（0.8隔离测试）”、任务栏身份和`v08-company-test`设备命名空间，不覆盖旧安装。本机开发版与公开包也分开保存身份。

预览程序未签名、未启用自动更新。本机最终发行目录已验证首次登录、岗位/独立记忆/能力同步和真实模型调用独立插件；跨物理电脑、真实IM和正式负载仍待部署后验收。完整证据见[0.8交付记录](V08_DELIVERY.md)。
