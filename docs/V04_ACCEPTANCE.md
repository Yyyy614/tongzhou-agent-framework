# Harness公司发行版0.4：隔离验收

日期：2026-11-14。员工软件版本0.4.0，框架插件ABI维持0.1；既有agent-plugin包不需要修改兼容范围。

## 直接体验

- 双击桌面 **公司Harness（0.4隔离测试）**，实际执行 `C:\Users\X\Desktop\公司Harness-0.4隔离测试\公司Harness.exe`。保留整个文件夹。
- 登录、岗位选择和工作台在同一个公司Harness应用窗口内；工作中心位于Harness侧栏，账号与岗位也可从应用“公司”菜单打开。只有后台Host/Chromium辅助进程，没有另一个桌面启动器。
- 当前测试员工为v04-employee，分配资料核对岗、库存核对岗。测试过程中已在软件内登录；用户可从工作中心切换岗位、查看本人通知、提醒与公司接口说明。
- 本机独立后台 `http://127.0.0.1:4417/` 已另开登录会话，用量显示本轮10次服务商实测请求。后台的记忆、日志及员工/Agent配置连接同一隔离内核。
- 这套员工账号属于隔离数据库，与云端原test-employee不是同一账号库。原桌面“公司Agent（内测）”及0.3目录、云端8443测试发行和全部已有数据保留；本轮没有执行迁移或云端切换。

当前是未经公司签名的Windows x64内部便携包，未提供生产安装器或OTA更新。包固定本机4417，仅用于当前电脑；拿到第二台电脑前需另配置可访问的公司地址，不能将localhost包称为跨电脑发行已完成。

## 实现位置与分层

| 层 | 实现 |
| --- | --- |
| 公司桌面组合 | desktop/company-main.mjs、company-preload.mjs、welcome；原生账号、设备保护、同窗口导航与Host生命周期 |
| 可复用会话服务 | client/company-session.mjs；设备凭证、受管岗位连接、独立profile与切换/退出/恢复 |
| 上游桌面模块 | vendor/harness-desktop；固定提交e8f7b93a344964de3dca1ace9e72b6e4d6de87cb的9个未修改模块，含MIT许可与逐文件摘要 |
| Harness界面扩展 | @company/harness-workspace；原生客户端插槽注册工作中心与公司名称，不使用嵌套应用窗口或DOM拼接侧栏 |
| 公司能力插件 | agent-plugin.json + Schema + module/JSON-RPC；由既有宿主授权并转换为Harness可用工具 |
| 内核 | src原有身份/权限/记忆/任务/日志/用量；本轮34文件摘要保持不变 |

桌面组合层从源码构建；Host运行时与聊天界面复用已固定摘要的官方0.2.2-rc.2产物，并非重新编译整个上游仓库。公司包使用Electron44.7.0，不运行/修改官方DeepSeek Harness桌面EXE。原生界面插件与业务agent-plugin是两层格式，适配关系由公司宿主承担，不声称两种包可以不经适配互换。

设备身份由Electron safeStorage/Windows保护，不保存密码。模型总Key仍在服务端；原生工作台只获得岗位范围的短期连接。账号、岗位组合生成独立DSH_HOME目录，切换先处理当前任务与连接、确认本地Host退出，再启动目标岗位。正在执行的工作切换需明确停止确认。

## 实际运行证据

| 验收 | 结果 |
| --- | --- |
| 原生软件登录 | 公司账号表单在应用内；错误密码提示、正确登录、两岗位选择、退出再登录均通过 |
| 单窗口 | 登录→Harness工作区→原生侧栏工作中心→岗位切换始终同一BrowserWindow，窗口数1 |
| 资料岗位真实run | bc4b8da9-8d3f-4edc-b3a8-753d9dcbeb76，harness-client/succeeded，实际document.check、memory_read、report_record，3次provider请求 |
| 库存岗位真实run | e1dd93d2-352f-4000-a82c-f4658dd7fe80，harness-client/succeeded，实际inventory.compare、本人INDEX、报告与内部提醒，4次provider请求 |
| 最终便携包真实run | a46c4763-b219-4ca3-828c-19734a1e8277，harness-client/succeeded，资料工具、本人INDEX与报告，3次provider请求 |
| 记忆与历史 | 资料岗标记DOCUMENTS_PRIVATE_INDEX，库存岗INVENTORY_PRIVATE_INDEX；换岗不出现对方聊天，返回原岗及退出重登后保留本人原聊天 |
| 工作中心 | 提醒送达后标题/说明可读，通知标记已读与接口展开通过；自动更新保留当前页面 |
| Host故障 | 仅终止本轮拥有的空闲Host后，提示重新进入；正常“进入岗位”重建成功，不依赖额外刷新按钮 |
| 断网与恢复 | 仅停止本机4417服务；未知状态显示重试，不显示错误登录表单；离线退出确认本地Host退出，按员工/公司持久待清理项；重连清理完成，设备身份和原聊天保留 |
| 布局 | 实际1240×860窗口、820×680窄窗口及明暗主题检查；无水平溢出；长通知可换行，内容可垂直滚动 |
| 源码/运行时 | src的34文件未改；固定asar及缓存内20523个运行时文件逐一校验通过 |
| 自动测试 | check/build通过；48文件79项测试通过。模型故障/HTTP夹具证据与上面真实模型证据分开 |

10次provider请求分别归属于测试员工的两个岗位。金额费率未配置，后台不把未知金额当作零。没有真实客户资料、仓库写操作、财务审批、外部消息或对外发布。业务包只用于验证框架。

原生工作中心还包含既有协作结果、完整任务查询与人工核对入口；本轮实机重点验证的是账号、换岗、提醒、接口目录与两种业务工具，没有在新原生页面重跑真实多人派工及人工签审。相关内核能力的前次验收见V02_ACCEPTANCE.md，不能用前次浏览器证据代替本轮未执行的原生签审。

## 独立插件开发与换业务

`node scripts/create-plugin.mjs <新目录> --id @scope/package` 在独立目录生成包，不导入内核源码或数据库。已有目录拒绝覆盖。开发者替换plugin.mjs及输入输出Schema，通过 `node scripts/check-plugin.mjs <包目录>` 检查后，由管理员安装、授权和挂载。

examples/plugins/document-check和inventory-check是两个独立业务包，只包含字面词项核对与数量差异计算。公共SDK测试在新的独立目录复制/安装它们，原岗位从资料包切为库存包，只修改Agent配置；旧工具拒绝，私人笔记仍为原版本。库存包另发布0.1.1并精确绑定，再退回0.1.0，均通过公开release接口。源文件摘要前后相同。实际原生工具调用也已按上表验证。

通用private-memory包另示范受控Host服务调用；连接目录与工作辅助包沿用既有标准。插件权限是请求，只有公司人员授权、岗位授权和已挂载工具/服务的交集生效。安装不同能力不会自动获得别的员工记忆、管理权限或外部写入权限。

## 可复现构建

1. 按项目README准备Node及依赖，执行check/build；保留既有.env与数据，不把它们放进包。
2. 使用scripts/setup-harness-desktop.ps1取得并验证固定官方产物。
3. 运行 `node scripts/prepare-company-tools.mjs` 安装固定构建工具；再运行 `node scripts/prepare-company-tools.mjs --electron-runtime`。GitHub下载不可用时可加`--mirror`，仍使用Electron npm包随附的校验摘要，不关闭TLS校验。
4. 运行 `node scripts/prepare-company-runtime.mjs`。缺失缓存提取到新目录；既有缓存不自动覆盖。库存清单必须与固定asar内原文一致，所有已记录文件再按字节数/SHA256验证。
5. 运行 `node scripts/build-company-harness.mjs` 生成本机隔离开发应用。vendor源码摘要不匹配时拒绝构建；prepare-company-source.mjs只用于维护者在审查上游提交后重新记录来源。
6. 运行 `node scripts/package-company-harness.mjs --output <不存在的新目录>` 生成独立Windows目录。仅复制已构建代码、固定运行时与许可；不复制开发机配置目录、设备身份、管理员凭证或.env。已有目标目录拒绝覆盖。

当前本机服务由 `node --env-file=.env scripts/start-v04-isolated.mjs` 启动。它只初始化`.local/v04-isolated/host`，账号辅助文件也仅在该隔离目录，不覆盖项目原.local/access.json。现有包只是当前电脑的开发试验发行，通用公司地址的发布配置、公司签名和升级渠道仍需下一阶段交付。

## 保存位置、保留范围与审查

权威测试数据在`.local/v04-isolated/host`对应的独立PostgreSQL schema fw_79515389048656；员工新软件数据在`%APPDATA%\CompanyHarness\v04-isolated\<公司地址摘要>`，每员工/岗位另有独立Harness目录。旧0.3的CompanyAgentFramework目录未迁移或清空。员工本地会话与公司服务端记忆是不同数据，换机时不可将二者混为已经同步的聊天历史。

两轴只读复审核对v1/v2/v3冻结摘要，修复连接泄漏、离线收尾、Host健康、状态读取竞态、通知字段及跨账号补偿归属；原问题均关闭。测试的失败→通过日志、真实run证据、便携包验收、内核/运行时摘要在被Git忽略的.local/v04-*.json与日志中；截图在output/playwright/v04-*.png。不包含真实密钥。

最终v4两轴均核对108/108文件摘要，运行时helper、构建接入、窗口标题事件和交付说明没有新增确定性阻断。最终包另实测桌面快捷方式直接启动、重复点击复用同一窗口，标题为“公司 Agent Harness · 资料核对岗”。15个公司自有代码/配置文件通过已知实际凭证检查；不含员工密码、模型总Key、管理员凭证或设备身份文件，固定上游运行时另按摘要校验。

交付时只读复查，原11个线上容器ID/启动时间/重启次数及443首页与上版相同。本轮未部署云端、未修改DNS/防火墙、未切换下载清单、未提交或推送。真实第二台物理电脑、生产压测、公司知识发布、签名安装器、自动升级与业务平台适配均不在本轮完成声明中。
