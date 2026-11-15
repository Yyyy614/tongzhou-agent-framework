# 同舟 0.6 Windows 体验版

此版本把公司账号登录、岗位选择、工作中心和能力市场接进真正的 Harness。包含完整桌面运行时，无需另外安装 Node 或依赖本项目工作区。

## 下载与启动

在仓库的 [Releases](https://github.com/Yyyy614/tongzhou-agent-framework/releases) 下载带 `Preview` 的 Windows x64 附件。

- `Tongzhou-Preview-0.6.0-win-x64-Setup.exe`：安装向导，按当前 Windows 用户安装。
- `Tongzhou-Preview-0.6.0-win-x64.zip`：完整解压，双击“同舟.exe”，保留整个目录。
- `SHA256SUMS.txt`：安装包与 ZIP 的校验值。

## 公司服务与账号

体验包默认连接本机 `http://127.0.0.1:55061` 的 **0.6 服务**。这不是一个自带公司数据库或公开账号的演示服务。框架后端的安装和员工创建步骤见 [QUICKSTART.md](QUICKSTART.md) 和 [EMPLOYEE_ONBOARDING.md](EMPLOYEE_ONBOARDING.md)。

其他电脑连接时，先把安装目录或解压目录内 `resources/app/company.json` 的 `serverURL` 改成管理员提供的 HTTPS 公司服务地址。不要在该文件放 API Key、员工密码或设备令牌。当前后台接口与客户端应来自相同版本，旧 0.4 测试地址不代表已经部署 0.6。

进入应用后，用公司账号登录；管理员分配的岗位、插件、授权资料、独立记忆和用量来自公司服务。账号与岗位切换在 Harness 内完成。Windows 显示缩放保持系统默认。

## 数据和发行边界

预览设备使用独立命名空间 `tongzhou-v06-preview`，按公司服务地址隔离保存登录状态。发行包不含本项目的登录身份、模型凭证、数据库或员工工作记录，也不会替换旧客户端目录。

当前为尚未签名的预发布版本，自动更新尚未启用。本机验证包括从解压副本启动、真实公司账号登录、选岗、读取记忆与用量；未声称已在全新 Windows 设备完成安装验收。本次上传不部署公司服务器。
