# 组织协作与工作辅助 Bot：实际验收

本版仍以原生 DeepSeek Harness 为员工工作入口；后台负责组织、授权和检查。通用工作辅助插件不包含客户/销售/财务领域模型。这里的 Bot 是已实现的框架能力，没有把某个未指定仓库的第三方 SuperAgent 项目伪称为已集成。

## 直接体验

- 桌面快捷方式：**公司Agent协作测试**。
- 独立包：`C:\Users\X\Desktop\公司Agent-组织协作测试`，双击 **公司Agent.exe**。当前电脑已登录 test-employee，单岗位会直接打开原生 Harness。
- 员工的“我的工作与提醒”：一键启动首次登录时打开的本机员工窗口。可查询协作结果、完整任务回执、人工核对、收件箱；自动刷新保留核对草稿。
- 公司后台：`https://agent-test.example.com:8443/`，本轮已经打开 **工作辅助 Bot** 页面；管理短时入口仍由现有桌面“公司Agent管理后台”签发。
- 另一电脑复制整个分发文件夹后打开公司Agent.exe，使用原员工账号密码登录。员工不需要模型总密钥、SSH或开发环境；当前电脑的数据目录不用复制。

已有一个框架测试部门，下设测试一组/二组。test-employee 是普通 employee，teamScope=subtree，显式授予 team.read/dispatch/review。两个自动执行岗位分别由 v02-worker-a、v02-worker-b 所有，直属上级均为 test-employee。部门名只是验证数据，内核没有这些固定部门。

后台新入口：**组织与权限**（部门树、汇报线、团队范围）、**协作工作**（派发、状态、结果、核对）、**工作辅助 Bot**（规则、提醒、事件回执、本人通知）。员工/Agent编辑器可配置新的服务权限和允许派工目标。

## 真实 Harness / DeepSeek

2026-11-13 经公开HTTPS8443验证，不使用模型替身。

| 项目 | 实际结果 |
| --- | --- |
| 原生负责人第1轮 | ad50002d-5b3f-4be0-b349-7989d8bc34c9 成功，实际调用team.list及work.dispatch，3次provider请求 |
| 协作工作 | 78263e7f-eedd-4098-b970-47a2e331a65c，两项原子分配，经员工窗口核对后completed |
| 甲岗位 | dfc0ed95-2ac7-4f91-ba82-406b6c474d19，v02-worker-a身份，4次provider请求，本人INDEX读取、normalize工具、工作报告均有同run审计 |
| 乙岗位 | 1d7ae537-bfeb-43f8-a919-6336d86ad668，v02-worker-b身份，3次provider请求，本人INDEX读取、normalize工具、工作报告均有同run审计 |
| 并行 | 两岗位实际run.createdAt分别15:22:27.483Z、15:22:27.485Z，相差2毫秒，执行时间重叠 |
| 普通负责人核对 | test-employee在员工窗口读两项完整结果，填写依据并approve；不是给负责人升admin，也不是模型工具代替核对 |
| 原生负责人第2轮 | fe0048c5-5ebf-419e-a1f9-8bc11486d650 成功，实际work.read/reminder.schedule/event.publish，3次provider请求 |
| 提醒 | 198fbfbc-81f4-449f-a73a-7f21b0c86c7a，于15:24:33.297Z到期，背景说明进入本人收件箱，检查仅1次送达 |
| 问题辅助 | c7f4ba42-d2ca-4f63-991e-114351a5f7fe，来源plugin:@company/work-assistant，规则生成工作1dcd8f15-fd55-4157-a0bd-90ecc41fa4cc |
| 辅助结果 | e04d08a8-e52c-4c46-8eea-66fb96fcf14d 成功，4次provider请求，处理结果保留waiting_review供用户核对，未发布到外部 |

甲岗位第一次把INDEX@1当作noteId，Schema拒绝后自行改用INDEX成功；账本保留失败信息，未把失败调用隐去。负责人第1轮将queued额外解释成等待员工领取，这不是宿主行为：队列由自动工作进程执行，无人工领取要求。后续岗位说明已补充准确状态语义；模型说明仍以真实回执为准。

同run核验与去重证据：`.local/staging/v02-live-evidence.json`。后台逐员工用量来自provider usage，金额配置未设置时不把金额显示成零成本。截图在 `output/playwright/v02-live-*.png`，均为框架测试数据。

## 本机行为与界面回归

- check/build成功；完整39文件60项测试通过，新增12条提醒并发创建/取消补充回归通过。
- 组织循环、跨公司、私人记忆拒绝、管理范围、批量原子性、并行、幂等、部分失败/未知结果、核对版本冲突、排队及忙碌等待期间撤权均覆盖。
- 提醒跨宿主重启和并发调度只投递一次；伪造系统失败事件拒绝，规则先按员工白名单筛选再限量，辅助失败不递归重放未知动作。
- 真实API+浏览器7项验收：创建部门、调整员工汇报线、双岗位任务、管理员核对、定时提醒、事件规则、普通负责人完整结果及核对。executor为夹具，和上表真实模型分开记录。
- 既有后台自动刷新9项浏览器回归通过，员工/岗位筛选和未保存记忆草稿保留。
- Windows真实AppData重定向及旧断junction升级测试通过。员工路径先规范化，插件链接与实际部署路径校验，单岗位重启直接打开Harness；实际EXE启动、真实DPAPI登录和重复启动复用已验证。
- 0.1旧插件与0.2扩展插件均通过独立包检查；详见INTEGRATION_STANDARD.md。

## 测试服务与发行

仅更新 `/srv/company-agent-staging` 的测试应用，TLS容器、数据库卷和原业务不变。当前测试发行 `/srv/company-agent-staging/framework-20261113T151611Z-j2KClg`，旧容器 `caf-staging-app-before-framework-20261113T151611Z-j2KClg` 保留，发行目录有升级前数据库dump。新增表及字段为增量迁移，未覆盖业务数据库。

部署包SHA256：830980605bdaee99fbe146b5335f39e30cdd5710c22518fd525626202d8464f2。

员工ZIP SHA256：ea35ca070225500e94ed3a67679ab20959a12add3af3a11a3ffdf412864216dc。远端校验一致，后台下载清单已切换本次包，授权HEAD200。发行保持既有0.1插件ABI及Harness锁定版本；功能里程碑与ABI版本分开，详见统一标准。

部署前后11个aisales线上容器ID/启动时间/重启次数一致，原443首页字节相同，测试应用healthy。证据为 `.local/staging/production-{before,after}-v02.txt` 和原站首页摘要。

本版支持通用问题辅助和内部提醒。钉钉/飞书/企微、AI销售、自研业务系统、对外发送/发布、全公司知识审核发布和客户端自动升级渠道仍是后续适配项。尚未实际拿第二台物理电脑登录；本轮验证为同机独立目录与公网测试服务。
