# 文档与仓库导航

首次使用从 [Agent 首次启动与 CLI 排错](agent-first-start.md) 开始。完整命令参数、JSON 输出约定和退出码见 [CLI 使用说明](cli.md)。手动操作 GUI 的流程见仓库根目录 [README](../README.md)。

## 文档

| 文档 | 用途 |
| --- | --- |
| [Agent 首次启动与 CLI 排错](agent-first-start.md) | 从环境检查到打开 GUI 的实际操作顺序、错误恢复和日志位置。 |
| [CLI 使用说明](cli.md) | 命令、参数、输出和退出码。 |
| [本地解密接入说明](integrated-backend.md) | 密钥认证、快照、原 WeFlow 接口接入位置、验证结果和当前能力范围。 |
| [wxtext 架构](wxtext-architecture.md) | 密钥扫描、SQLCipher、WAL 与后端实现的技术说明。 |
| [第三方组件](third-party-components.md) | 依赖与第三方组件说明。 |
| [HTTP API](HTTP-API.md) | 上游 HTTP API 的参考文档；其接口与本分支 CLI 是不同入口。 |
| [上游 README](../README.upstream.md) | 保留的上游介绍及作者信息，下载与功能说明对应上游版本。 |

## 代码与入口

| 位置 | 职责 |
| --- | --- |
| `weflow.cmd` | Agent / 脚本入口；源码版准备环境，安装版使用冻结后端。 |
| `启动 WeFlow.cmd` | 直接启动原 WeFlow GUI 的源码入口。 |
| `python/weflow_backend/cli.py` | CLI 编排、结果与退出码；复用现有后端。 |
| `python/weflow_backend/` | 账号发现、完整快照、只读聊天查询、原始 JSONL 导出与 RPC。 |
| `python/wxtext/` | 微信进程与密钥扫描、逐库认证、DPAPI、复制、WAL 和解密。 |
| `electron/services/preparedLaunch.ts` | 通过 WeFlow 原 `ConfigService` 写入已验证账号配置；不创建新 UI。 |
| `electron/services/localBackendClient.ts`、`electron/localWcdbWorker.ts` | Electron 与本地后端通信，适配现有 WCDB Worker 协议。 |
| `src/`、`electron/` | WeFlow 原界面、应用与导出功能。 |
| `scripts/` | 启动、环境准备、构建、后端打包和桌面验证脚本。 |
| `python/tests/` | 后端与 CLI 的回归测试、合成测试数据生成器。 |

运行与构建产物保持在忽略目录中：`.venv`、`.runtime`、`node_modules`、`build`、`dist`、`dist-electron`、`release`。本机真实账号测试、截图和导出放在 `.runtime`，不随源码提交。安装程序输出到 `release`。

默认 profile 在 `%APPDATA%\WeFlow-full`，其中 `backend` 保存 DPAPI 密钥缓存和明文聊天快照，`cache` 保存派生缓存，`logs/cli-gui.log` 保存 CLI 启动的 GUI 日志。指定 `--user-data` 时这些数据落在对应目录；后续命令需继续使用同一目录。

## 常用开发命令

```powershell
# 仅准备依赖，不打开 GUI
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch.ps1 -SetupOnly

# 后端与 CLI 回归测试
npm run test:backend

# 类型检查和应用构建
npm run build:app

# 冻结后端并生成 Windows 安装包
npm run package:win
```

`scripts/check-desktop.cjs` 默认使用合成账号检查真实 Electron IPC、查询与导出。真实账号验证需要显式提供本地配置，配置和输出均留在 `.runtime`；日常修改无需重复扫描实际聊天数据。
