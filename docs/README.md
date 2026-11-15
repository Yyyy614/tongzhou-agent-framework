# 文档入口

先从根目录README了解当前能力与边界，再按任务选择：

| 任务 | 文档 |
| --- | --- |
| 首次安装、启动、打开后台 | [快速开始](QUICKSTART.md) |
| 理解模块责任及实际实现 | [架构概览](ARCHITECTURE.md) |
| 开发能力包、统一插件插座 | [接入标准](INTEGRATION_STANDARD.md)、[协议](PROTOCOL.md) |
| 深入设计及待建设内容 | [总体设计1.1](FRAMEWORK_DESIGN.md) |
| 工作停止、等待、核实与恢复 | [A2工作控制](WORK_CONTROL_A2.md) |
| 连续轮次、工作历史与交接 | [A1工作连续性](WORK_CONTINUITY_A1.md) |
| 企业机器人及CLI | [外部入口](ENTRY_CONNECTORS.md) |
| 员工账号与设备接入 | [账号](ACCOUNTS.md)、[员工接入](EMPLOYEE_ONBOARDING.md) |
| Windows桌面、源码包、独立发行 | [构建与打包](BUILD_AND_DISTRIBUTION.md) |
| 远程回执测试与端口故障 | [故障原因与回归验证](REMOTE_RECEIPT_TEST_FIX.md) |
| 内网/自有服务器部署 | [私有部署](PRIVATE_DEPLOYMENT.md) |
| Harness扩展与公司UI | [Harness适配](HARNESS_COMPANY.md)、[窗口与品牌修订](UI_CHROME_BRAND.md) |

`V02/V03/V04/V041`、`ACCEPTANCE`、`QA`及`REVIEW`等文件是阶段性规格和验收记录，描述的是对应版本；不能代替当前代码或当作所有设计均已完成。原始设计截图、执行日志、数据库、员工设备状态和本机缓存不包含在源码仓库中。

运行与开发的关键约定在根目录AGENTS.md和CONTRIBUTING.md。旧验收记录中的公司地址已改为文档示例，部署时使用自己的配置，不沿用文档中的示例账号或地址。

`docs/ci/check.yml.example`提供Linux/PostgreSQL CI模板，尚未在本次Windows环境运行，初次上传不自动启用。按目标平台验收并授予所需工作流权限后，再复制到`.github/workflows/check.yml`。
