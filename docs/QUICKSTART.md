# 快速开始

## 1. 环境与依赖

需要Node.js 24.9或更新版本、Git、可连接的PostgreSQL。锁定的包管理器为pnpm 11.28.5。Windows原生桌面还需要PowerShell 7、7-Zip和固定版本的Harness/Electron，后端及插件开发不要求先构建桌面。

当前`console`和`console:studio`的一键打开浏览器操作同样依赖Windows与PowerShell 7。其他系统可手动访问后端地址，使用本机私有身份登录；不要把这两个一键打开命令当成跨平台入口。

在项目根目录执行：

```powershell
node scripts/bootstrap-deps.mjs
```

该脚本在项目工具目录准备pnpm并按锁文件安装，不修改系统代理。已有正确版本pnpm时也可以执行`pnpm install --frozen-lockfile`。仓库默认禁止依赖安装脚本，桌面运行时有单独的显式准备步骤。

## 2. 开发数据库

使用已有专用开发数据库时，在当前终端设置`DATABASE_URL`，该用户需要建表和创建schema权限。不要使用生产数据库来跑测试。

完整测试包含杀进程与恢复验证，数据库必须通过回环地址（`127.0.0.1`、`localhost`或`::1`）访问。远端专用开发数据库可用于普通宿主；运行完整测试时，使用本地测试库，或将专用测试库通过SSH端口转发到回环地址。

也可安装PostgreSQL命令行工具后执行：

```powershell
node scripts/local-postgres.mjs
```

脚本在项目`.local/postgres`创建开发集群，只监听127.0.0.1:55437；随机口令写入`.local/database.json`。此目录不提交、不放进源码包。

## 3. 配置与验证

```powershell
Copy-Item .env.example .env
npm run check
npm run build
npm test
```

在`.env`填写自己的模型API配置。自动化测试使用受控替身，不要求真实模型Key；真实对话才需要它。`.env`仅由带`--env-file`的启动命令加载；使用外部数据库跑`check/test`时，在终端环境设置`DATABASE_URL`，不要假定测试自动读取`.env`。

## 4. 普通开发宿主

```powershell
npm start
```

默认端口4317，`GET /health`用于检查服务。另开终端执行`npm run console`，会签发一次性入口并在Windows浏览器中打开。无匿名管理员入口，模型Key不能作为后台登录令牌。

不自动打开浏览器时，可执行`npm run console -- --no-open`，然后在本机私有`.local/console-entry.json`中读取`origin`与`code`，组合`origin/#entry=code`手动打开；不要把一次性入口写入公共日志或聊天。也可直接访问后台并使用`.local/access.json`里的本机管理员身份登录。

## 5. 当前同舟管理工作台

```powershell
npm run studio
```

此参考服务固定使用127.0.0.1:4917，数据在`.local/ui-integrated/host`，独立于4317和旧开发服务。它只安装通用验证插件，生成隔离账号，不连接真实业务系统。

另开终端执行`npm run console:studio`。测试员工账号信息保存在本机`.local/ui-integrated/employee.json`，只供开发者在自己的本机测试；不得提交或打包给所有员工。

## 6. 原生员工使用

按照[构建说明](BUILD_AND_DISTRIBUTION.md)准备原生运行时并构建。同舟在应用内登录、选择获分配的岗位，进入工作中心或原生对话。账号、记忆、插件和用量由服务端按权限返回；本机聊天记录不自动漫游。

## 常见问题

- 数据库连接失败：检查PostgreSQL是否启动、端口和当前终端的DATABASE_URL；不删除旧`.local`来解决连接问题。
- 提示宿主已运行：一个root/schema只允许一个宿主执行恢复。关闭自己启动的前台进程，或选择新root；不强制抢锁。
- 没有模型凭证：可以验证管理和确定性插件功能，但真实模型工作不可用。不要把替身通过说成真实推理成功。
- 浏览器能访问、原生电脑不能访问：跨电脑需要可达HTTPS地址与受信任证书。本机4917开发版不等于跨电脑安装包。
