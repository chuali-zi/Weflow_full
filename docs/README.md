# 文档与仓库导航

首次使用从 [Agent 首次启动与 CLI 排错](agent-first-start.md) 开始。完整命令参数、JSON 输出约定和退出码见 [CLI 使用说明](cli.md)。手动操作 GUI 的流程见仓库根目录 [README](../README.md)。

## 文档

| 文档 | 用途 |
| --- | --- |
| [Agent 首次启动与 CLI 排错](agent-first-start.md) | 从环境检查到打开 GUI 的实际操作顺序、错误恢复和日志位置。 |
| [CLI 使用说明](cli.md) | 命令、参数、输出和退出码。 |
| [本地解密接入说明](integrated-backend.md) | 密钥认证、快照、原 WeFlow 接口接入位置、验证结果和当前能力范围。 |
| [wxtext 架构](wxtext-architecture.md) | 密钥扫描、SQLCipher、WAL 与后端实现的技术说明。 |
| [在线读取实验](online-read-experiment.md) | 微信运行时读取加密库的实测依据与验证边界。 |
| [在线读取新架构](live-architecture.md) | SQLCipher 在线连接、短事务、监控调度与 GUI 的实现架构。 |
| [热加载接入规格](live-spec.md) | 模式、CLI / RPC / 事件、恢复与验收契约。 |
| [完整接入方案](live-integration-plan.md) | 对应当前文件的改动清单、交付阶段与安装包验证。 |
| [热加载验证](live-validation.md) | 当前测试结果、复现命令和未完成的真实 / 安装验收。 |
| [第三方组件](third-party-components.md) | 依赖与第三方组件说明。 |
| [HTTP API](HTTP-API.md) | 上游 HTTP API 的参考文档；其接口与本分支 CLI 是不同入口。 |
| [上游 README](../README.upstream.md) | 保留的上游介绍及作者信息，下载与功能说明对应上游版本。 |

## 代码与入口

正式 CLI / GUI 支持 snapshot 离线副本与 live 在线读取。在线接入按“新架构 → 接入规格 → 实施方案”阅读，已执行的测试以热加载验证为准。旧配置默认 snapshot，需要显式选择 live。

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

# 在线提交经过后端、Worker 和真实聊天页的合成测试
npm run check:live

# 构建 win-unpacked 后验证包内后端和 GUI
npm run check:live -- --packaged

# 冻结后端并生成 Windows 安装包
npm run package:win
```

`scripts/check-desktop.cjs` 默认使用合成账号检查真实 Electron IPC、查询与导出。真实账号验证需要显式提供本地配置，配置和输出均留在 `.runtime`；日常修改无需重复扫描实际聊天数据。
