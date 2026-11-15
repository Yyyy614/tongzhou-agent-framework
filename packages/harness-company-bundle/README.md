# Harness 公司岗位参考包

原生 Harness bundle，兼容已验证的 0.2.2-rc.2。`presets.json` 是范式来源；在框架根目录运行 `npm run build` 生成 `cordis.patch.yml`，再按官方 bundle 格式安装。

内含岗位员工、团队负责人、跨团队统筹三个参考预设，只组合原生 `dsh-agent-preset` 与 `dsh-persona`。职责模板不授予权限、不转移记忆，也不包含销售、财务等业务实现。框架服务端固定每个 Agent 实际使用的预设版本和插件版本。

原生包可作为其他业务的组合范式。只有预设不构成公司连接；完整的员工身份、受控模型网关与公司工具由框架启动器生成独立的受管连接 bundle。SDK-minimal 通过 `binding.mjs` 使用同一原生 registry。

见框架根目录 `docs/HARNESS_COMPANY.md`。
