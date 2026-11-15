# 公司 Harness 0.4.1：云端测试与员工安装包

日期：2026-11-14。员工发行0.4.1；框架0.1及插件ABI保持不变。本次只交付公司版Harness的云端员工入口，FRAMEWORK_DESIGN.md中的后续工作、上下文、事件和发布体系没有被标为全部实现。

## 另一台电脑怎么用

1. 从当前电脑桌面复制 **公司Harness-云端测试-0.4.1-安装.exe** 到另一台Windows x64电脑，运行安装器。
2. 安装后打开桌面 **公司Harness（云端测试）**。它直接运行公司Harness，在软件内部登录和选择岗位。
3. 测试账号为 **harness-cloud-test**；密码已单独保存在当前桌面的 **公司Harness云端测试-账号说明.txt**，没有放入安装包。分配资料核对岗和库存核对岗。
4. 在工作中心点击“账号与岗位”切换。通过账号取得服务器上的岗位、预设、授权工具与私人记忆；不需要SSH、Node、原官方Harness或模型Key。

测试服务为 `https://agent-test.example.com:8443`。原云端test-employee账号及其他既有账号也能登录新软件，仍取得各自原岗位和服务端记忆；原账号密码、旧软件和原下载清单保留。

**服务端记忆与本地聊天不同**：私人笔记、岗位配置、日志和用量由公司服务保存；聊天历史仍保存在每台电脑的岗位目录，不自动跨电脑同步。不要复制另一台电脑的identity文件来代替登录。

## 发行物和实际安装

| 项目 | 当前结果 |
| --- | --- |
| 桌面安装包 | C:/Users/X/Desktop/公司Harness-云端测试-0.4.1-安装.exe |
| 大小 | 258553988字节，约259 MB |
| SHA256 | 42c8f7b9c1dfd8c2bb39d2042ac709d0dd186fe8954f6b4f0df2b872063157dd |
| 本机安装实测 | NSIS每用户静默安装退出码0，实际进入已安装的Harness并执行真实模型任务 |
| 本机安装目录 | C:/Users/X/AppData/Local/Programs/CompanyHarnessCloudTest |
| 桌面快捷方式 | 公司Harness（云端测试）.lnk，目标是安装目录中的公司Harness.exe，无外置启动器 |
| 设备数据目录 | %APPDATA%/CompanyHarness/cloud-v04-test/公司地址摘要；与0.4本机隔离版、0.3旧版分开 |
| 凭证检查 | 公司自有15个代码/配置文件中没有已知实际模型Key、员工密码、管理令牌或设备身份文件；安装后主进程和工作中心摘要与发行清单一致 |

安装器提供每用户向导，未作公司代码签名。实际安装路径使用静默安装参数验证；向导逐页人工操作、卸载再安装、OTA更新及物理第二台电脑本轮未验收。配置设为卸载保留AppData，本轮没有据此宣称已经完成卸载恢复测试。

## 服务器和数据保留

复用原独立测试环境 `/srv/company-agent-staging` 的caf-staging-app/db/tls和公网8443。关键dist/index.js、runtime.js、server.js、employee-access.js与本地摘要一致，故不升级、不重启原服务，也不改数据库结构、DNS、防火墙、80/443或旧下载指针。

通过已鉴权公开接口新增harness-cloud-test、权限验证员工harness-cloud-peer、三个明确命名的验收岗位及两个独立业务包和private-memory通用包。新插件从独立imports目录安装，未覆盖原发行。用户账号仍由服务端按员工/岗位授权，不在客户端硬编码身份。

变更前的测试数据库dump、state文件备份、原记录和运行状态摘要在服务器 `harness-cloud-041-before`；核对结果在 `harness-cloud-041-after`。32条原员工、岗位、已完成run摘要及原私有记忆文件保持相同，原测试app的容器ID/启动时间/重启次数不变。11个线上容器及原443首页前后相同。

准备脚本只认精确的本轮ID和完成的本地归属记录；同名ID冲突或记录丢失即停止。只有本次新建员工能首次注册，已有账号登录失败不自动重置密码。中断后归属不完整时需要操作员核对，不能自动认领同名账号。

## 真实验收

| 路径 | 实际结果 |
| --- | --- |
| 两份干净设备配置 | 同账号经公网登录；设备ID和受保护凭证不同；得到同样的两岗位、已挂载插件与各自INDEX |
| 权限 | 其他员工私有记忆403，员工访问管理接口403；撤销B设备后B返回401；A存在且未撤销/过期，随后原生工作中心请求和换岗成功 |
| 公司包原生任务 | ca1c8143-2622-4327-9475-555566dcfeef，harness-client/succeeded；document.check、本人INDEX、memory_write、报告实际执行；4次provider请求 |
| 跨设备新记忆 | A新建CROSS_DEVICE_CHECK，B从服务端读到CLOUD_041_SECOND_DEVICE_READY；两个岗位的INDEX标记不同 |
| 实际安装版任务 | b53bb539-4153-40ec-933c-bf5eda8c8090，harness-client/succeeded；读取上述云端笔记、调用document.check、记录报告；3次provider请求，最终回复“安装版接通”及缺少项 |
| 原账号兼容 | 原test-employee密码登录成功，原岗位和INDEX可读；临时兼容设备随后注销，没有重置原密码或撤销其他设备 |
| 原生界面 | 错误密码提示、正确登录、同窗口换岗、两个岗位历史隔离、安装后重新登录并打开原聊天均验证；原生窗口数1 |
| 云端后台 | 打开管理会话，按新员工/岗位筛选；新笔记、工具/报告日志和逐次provider用量实际可见，自动更新继续运行 |
| 检查 | 类型检查、构建通过；50文件81测试通过；src中34个内核源文件与接入前摘要相同 |

本轮两次真实原生任务共7次provider请求，均归属新测试员工及资料岗位。金额费率未配置，未将未知金额记为零。库存包已挂载并可跨岗位加载，本轮云端没有另作库存真实模型任务；其本机真实工具执行证据见V04_ACCEPTANCE.md。

## 复现与回退范围

- 通用发行配置：scripts/company-release-config.mjs；package-company-harness.mjs支持--server-url、--namespace、--version及独立--manifest；拒绝不安全地址、设备命名空间及覆盖已有产物。
- 构建Windows包前先沿用0.4工具/源码/固定运行时检查。示例：`node scripts/package-company-harness.mjs --output <新目录> --server-url https://agent-test.example.com:8443 --namespace cloud-v04-test --version 0.4.1 --manifest <新清单>`。
- 安装器工具固定electron-builder26.18.0，装在.tools/company-installer-tools，使用--ignore-scripts。`node scripts/build-company-installer.mjs --release-manifest <清单> --output <新目录> --mirror`；镜像下载仍使用随固定工具发布的摘要验证，不关闭TLS校验。[NSIS配置参考](https://www.electron.build/nsis/)
- 云端只增加验收数据，回退可先停用这两个专用测试员工；旧客户端、旧下载清单和原服务继续使用。不需要重建或恢复整个测试数据库。备份保留用于有选择地恢复，不自动覆盖后续新增工作。
- 本地证据在被Git忽略的.local/company-cloud-041、.local/v041-*.log；截图在output/playwright/v041-*.png。没有提交或推送。正式签名、统一更新、并发压测、真实业务平台及物理第二台电脑验收仍需后续完成。
