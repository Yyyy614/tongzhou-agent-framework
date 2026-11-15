# 构建与交付

## 源码包

源码仓库应包含代码、锁文件、通用插件、设计与运行文档，以及带许可证的vendor模块。`.env`、`.local`、`.tools`、员工设备身份、数据库、实际报告、输出截图和安装程序不进入源码包。

运行`node scripts/source-package.mjs`可从当前Git提交生成源码ZIP、文件清单和SHA256。它只打包已提交文件，拒绝把未提交的产品改动误说成已包含在归档中。默认输出到被忽略的`artifacts`。

源码包不等于员工安装包，也不包含模型Key或官方完整桌面运行时。

## 后端构建

```powershell
npm run check
npm test
npm run build
```

构建产物在`dist`，并生成Harness连接包及Web结果展示模块。测试需要开发PostgreSQL；真实模型smoke单独运行。

## Windows同舟0.5.1本机开发版

需要PowerShell 7和7-Zip。按固定版本准备工具与官方运行时：

```powershell
node scripts/prepare-company-tools.mjs
node scripts/prepare-company-tools.mjs --electron-runtime
pwsh -NoProfile -File scripts/setup-harness-desktop.ps1
```

官方安装程序和ASAR必须匹配`harness-desktop.lock.json`的版本、签名与SHA256。如果上游latest下载已改变，检查会拒绝它；应获取对应基线或审查升级，不跳过校验。

vendor中的固定上游模块已包含在仓库；通常不需要重新执行`prepare-company-source.mjs`，该脚本用于审查后的上游来源更新。

生成带品牌图标的本机exe还需要资源编辑依赖：

```powershell
npm install --prefix .tools/company-installer-tools --ignore-scripts --no-audit --no-fund --package-lock=false resedit@1.7.2 pe-library@0.4.1
npm run build:harness:studio
node scripts/build-studio-desktop.mjs
```

脚本生成`.local/ui-integrated/app`和`.local/ui-integrated/desktop-0.5.1`，只修改新的runtime副本。后者通过junction引用工作区，因此**不可当作跨电脑安装包发送**。关闭自己的测试程序后，可用`--resume`更新已核对的这个测试副本；脚本拒绝覆盖未知运行目录。

产品名与图形入口是`packages/company-ui/brand.mjs`及`assets`；公司账号和数据不会因为换品牌而更换。桌面发行0.5.1与框架0.1 ABI分别管理。

## 跨电脑发行

现有`package-company-harness.mjs`和`build-company-installer.mjs`提供固定HTTPS服务、独立设备命名空间、完整运行时复制和Windows安装流程。这条路径目前绑定旧的0.4开发构建清单，不会自动把0.5.1本机junction版转成便携版。

发布最新同舟前，需要把打包清单明确切到已验收的0.5.1构建，保留完整runtime、应用图标、服务地址、设备命名空间和许可证，随后在干净Windows电脑验收。不能只复制本机exe或把开发账号、DPAPI身份、`.env`放进安装包。正式代码签名、自动更新与回滚需要另外配置和验收。

## 服务器与内网部署

部署模板见`deploy/private`，步骤见PRIVATE_DEPLOYMENT.md。使用公司自己的地址、证书和secret文件；先做静态预检，再在独立目标环境构建验证。仓库中的模板不意味着已有生产运维验收。
