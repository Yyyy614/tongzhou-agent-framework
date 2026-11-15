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

0.6 预览支持从明确指定的构建清单生成完整 Windows 客户端。便携目录复制完整运行时并保留“同舟”图标及内置登录，不使用本机工作区的 junction。开发构建版本必须与发行版本一致；设备路径、身份、数据库及模型凭证不进入发行配置。

```powershell
node scripts/build-company-harness.mjs --profile=studio --channel=v06
node scripts/package-company-harness.mjs --build-manifest .local/v06/build.json --output artifacts/v0.6.0-preview.1/Tongzhou --server-url http://127.0.0.1:55061 --namespace tongzhou-v06-preview --version 0.6.0 --manifest artifacts/v0.6.0-preview.1/package.json
node scripts/build-company-installer.mjs --release-manifest artifacts/v0.6.0-preview.1/package.json --output artifacts/v0.6.0-preview.1/installer
```

指定的输出目录和发行清单必须尚不存在，构建不会覆盖旧发行。Windows 安装包按当前用户安装，使用独立的预览应用标识，卸载保留设备数据。完整便携目录也可压缩为 ZIP；不要仅复制 exe。

公共体验包默认连接 `http://127.0.0.1:55061`，需要先运行同版本服务；它是员工客户端，不包含公司后端和预置试用账号。在其他电脑使用时，先修改 `resources/app/company.json` 的 `serverURL` 为管理员提供的 HTTPS 地址，再用公司账号登录。自托管步骤见 [QUICKSTART.md](QUICKSTART.md)。正式代码签名、自动更新与干净 Windows 设备验收不因本机便携包验证而视为完成。

发布附件应包含安装包、完整便携 ZIP、说明、SHA256 清单及对应源码。校验 GitHub 附件的大小和 SHA256，并将测试预览标记为 prerelease；二进制不放进 Git 源码历史。

## 服务器与内网部署

部署模板见`deploy/private`，步骤见PRIVATE_DEPLOYMENT.md。使用公司自己的地址、证书和secret文件；先做静态预检，再在独立目标环境构建验证。仓库中的模板不意味着已有生产运维验收。
