# 同舟：窗口与品牌细节修订

2026-11-15，沿用已确认的A管理/C员工方向，属于原方向迭代，不重新出三个方向。

用户要求去掉顶部黑栏、换简单名称、再处理一轮UI；补充“图标应该也是默认的应用图标，要有设计，这些小细节不能忽略”。名称暂用“同舟”，品牌集中在`packages/company-ui/brand.mjs`，不改业务与身份标识。

## 实施约定

- Windows测试版使用原生caption overlay与DSH官方AppFrame现有的拖动/留白约定，原生最小化、最大化、关闭保留。取消常驻系统菜单栏，应用菜单移到融合标题栏。账号页和实际Harness工作区都覆盖。
- 图形为原创双帆共舟，银灰/石墨/青绿延续既定方向。应用内、登录、后台、页签、Windows窗口/任务栏、exe资源与桌面快捷方式统一。ICO提供16/24/32/48/64/128/256七档尺寸。
- 减少全大写英文标签和无意义按钮尾箭头；正文14px起、标签12px起，主动作和focus样式统一。
- 继续使用4917隔离服务、原隔离账号及原隔离device。线上、旧应用、4417服务和原有数据不切换。`integratedChrome`仅studio构建开启，classic窗口配置保持。
- 新开发用exe在`.local/ui-integrated/desktop-0.5.1`，只编辑此新副本的资源，不修改共享Electron。此运行目录通过junction连接工作区，属于本机开发测试，不能当作跨电脑安装包分发。

## 依据与验收范围

已读本地Huashu Design的workflow、web、typography和polish-loop：保留已选方向，清理模板装饰，正式迭代至少两轮看图。窗口参考已固定的DSH源码`apps/desktop/src/main.ts`及`preload-windows.ts`，使用公开Electron接口：https://www.electronjs.org/docs/latest/tutorial/custom-title-bar 。

验收应包含完整OS窗口截图（含非网页外框），而非只截webContents：菜单栏消失、原生窗口按钮不遮挡内容、拖动/收侧栏/菜单/Esc、深浅色与缩放、登录/岗位切换、原记忆与日志用量入口、应用图标资源、快捷方式、Web品牌与375/1440视口。记录浏览器异常和资源错误，避免只监听pageerror漏掉模块MIME失败。

最终截图、验证日志和结论保存在`.local/ui-integrated/chrome-v2`；本文件在完成后补充实测结果。

## 实测完成

- 0.5.1实机窗口没有原来的系统标题条与常驻菜单栏。标题栏安全区宽1103px，应用区域从48px到1103px，未覆盖右侧原生按钮；菜单栏隐藏状态为true。完整OS窗口截图为`final-window.png`，包含网页截图看不到的外框和按钮。
- 窗口最大化、最小化、还原通过；真实设置页切换深/浅色通过。125%缩放后实际弹出菜单锚点为(75,45)，符合按钮CSS坐标换算；中文菜单为同舟/编辑/查看。缩放问题先失败后修复，记录`zoom-red.log`和`zoom-green.log`。
- 原隔离账号继续选岗，REFERENCE_CHECK笔记中的完整UUID可读，原用量记录继续存在。新UI没有清空设备或迁移内核数据。
- exe的ProductName为同舟、FileDescription为同舟智能工作空间，应用内与空会话图形、Windows图标、快捷方式、后台favicon统一。后台图标HTTP200、类型image/svg+xml。
- TypeScript与构建通过；6文件13项相关测试通过。12个管理端页面21项浏览器检查通过，原生10项检查通过；最终页面异常及模块资源错误均为0。
- Standards审查0项确认缺陷；Spec发现1项P2（缩放菜单锚点）已修复并复审关闭，另补齐空会话品牌图形。
- 桌面入口为“同舟 - 测试版”和“同舟管理台 - 测试版”。exe是依赖此工作区的本机开发运行目录；跨电脑安装仍走原来的独立发行流程。

两轮打磨记录追加到`design-demos/ui-refresh/polish-log.md`。4917隔离环境继续使用原测试数据；云端、旧客户端、原有公司数据未切换。
