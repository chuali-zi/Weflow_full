# WeFlow 本地整合版

基于 [hicccc77/WeFlow](https://github.com/hicccc77/WeFlow)，内置 wxtext 的数据库密钥获取、认证解密和聊天查询模块。用户只需取得这一个仓库，双击启动，无需另外寻找 WCDB DLL 或 WeLive 导出程序。

本整合版读取准备好的本地聊天副本，支持聊天查看、搜索、基础统计和导出。目标平台是 **Windows x64 + 微信 4.x**。

## 最简单的用法

拿到 Windows 安装包时，直接双击 `WeFlow-Local-5.0.0-Setup.exe` 安装并打开即可，无需安装 Node.js 或 Python。本地已生成的安装包在 `release` 目录。

使用源码仓库时：

1. 将本整合版仓库 clone 或下载到本地。
2. 双击根目录的 **启动 WeFlow.cmd**。
3. 首次启动会自动安装项目内的运行环境和依赖，并完成构建。需要联网，可能花几分钟；后续启动复用已安装的环境。
4. 登录电脑微信，在界面中选择账号，点击 **获取密钥，继续准备**。
5. 从微信托盘菜单正常退出微信，点击 **微信已退出，准备记录并打开**。
6. 准备完成后，直接查看、搜索或导出聊天记录。此时可以重新打开微信。

已经有记录副本时，点击 **直接打开** 即可。需要最新消息时，从首页 **准备 / 更新聊天记录** 重新准备。

关闭微信窗口不等于退出微信。这里的“记录”是准备时的副本，当前没有实时同步。

## 运行环境

启动脚本优先使用本机可用的 Node.js 和 Python，并在项目内建立 Python 环境。缺少合适的运行环境时，自动从官方来源下载便携版。Electron 首先从 GitHub 下载，失败后尝试 npm 镜像，并使用包内的官方校验值验证。无需全局安装 Python 包。

首次启动后生成的 `.venv`、`.runtime`、`node_modules` 等目录均已加入 Git 忽略规则。

数据状态独立保存在：

```text
%APPDATA%\WeFlow-full\backend
```

数据库密钥通过 Windows DPAPI 缓存。聊天副本是明文 SQLite，保存在本机当前用户的应用数据目录；原微信数据库按只读方式复制，不在原文件上运行解密或 SQL。

## 已接入和目前的边界

| 功能 | 整合状态 |
| --- | --- |
| 按数据库获取、验证及缓存密钥 | 已内置 |
| 复制数据库、处理已提交 WAL、逐页认证解密 | 已内置 |
| 联系人、会话、聊天消息、多分库查询 | 已内置 |
| 消息分页、文本搜索、发送者识别、压缩长文本 | 已内置 |
| 基础统计、日期统计、群聊发言统计 | 已内置 |
| 聊天记录导出 | 内置 JSONL 后端连接原 WeFlow 格式转换器 |
| 图片 / 视频 / 语音等附件恢复 | 保留上游处理路径，需要另外验证；图片 AES 密钥自动获取未内置 |
| 完整群成员名单、朋友圈专用查询、部分高级报表 | 尚未完整适配 |
| 实时同步、数据库写操作 | 当前副本模式不提供 |

这是一份可继续维护的整合版源码，并不代表已复刻上游所有原生接口。密钥扫描的实际兼容性仍取决于微信版本；合成测试不能代替真实账号验证。

## 开发与打包

安装环境但不启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch.ps1 -SetupOnly
```

检查、构建并启动：

```powershell
npm run test:backend
npm run build:app
npm start
```

生成 Windows 安装包：

```powershell
npm run package:win
```

安装包包含 `weflow-backend.exe`，使用安装包的人无需安装 Node.js 或 Python。输出在 `release` 目录，文件名含 `WeFlow-Local`。整合版使用独立应用 ID 与数据目录，并关闭指向上游安装包的自动更新，避免覆盖内置后端。

源码接入位置和验证说明见 [docs/integrated-backend.md](docs/integrated-backend.md)。

## 来源与许可

- 主界面、Electron 应用和导出格式：WeFlow，原作者 **cc / hicccc77**，本次基于上游提交 `837697b`。
- 数据库密钥扫描、认证解密、WAL、快照及 DPAPI：本项目原有 `abstract_information/wxtext` 工具，现随仓库放在 `python/wxtext`。
- 本次改动：内置查询适配、准备界面、启动脚本及后端打包。

保留上游作者信息和 [LICENSE](LICENSE)（CC BY-NC-SA 4.0）。上游说明原文保存在 [README.upstream.md](README.upstream.md)；其功能说明与下载链接对应上游版本。
