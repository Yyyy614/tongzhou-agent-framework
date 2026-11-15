# 第三方组件与来源

本仓库包含框架源代码、通用验证插件及公司版 Harness 的适配层，不包含员工数据、模型凭证或官方桌面完整运行时。

| 组件 | 使用方式 | 来源与说明 |
| --- | --- | --- |
| DeepSeek Harness | SDK、执行适配、原生桌面扩展 | https://github.com/deepseek-ai/deepseek-harness |
| Harness 桌面模块 | `vendor/harness-desktop` 中的固定版本代码 | 原始MIT许可证保留在该目录的LICENSE，来源及SHA256见两个harness lock文件 |
| Electron | 桌面运行时 | 开发工具按固定版本下载；不提交二进制缓存 |
| TypeScript、Fastify、pg、pg-boss、AJV等 | 框架依赖 | 精确解析版本见pnpm-lock.yaml，各包保留自身许可证 |

品牌名称和图形在 `packages/company-ui`；当前“同舟”与双帆共舟图形是此发行层的工作品牌，可替换，不改变框架协议。

本项目原创代码尚未指定开源许可证；上传仓库不等同于已选择开源授权。第三方文件继续按各自许可证和保留的归属信息处理。
