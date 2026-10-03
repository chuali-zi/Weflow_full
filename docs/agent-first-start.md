# Agent 首次启动与 CLI 排错

本指南给 Agent 或自动化脚本一个可恢复的启动顺序。命令行会准备离线副本并复用 WeFlow 原有 GUI；它不会替用户同意协议、解除应用锁或强制结束微信。

## 最短启动

在源码仓库根目录或安装目录的 PowerShell 中运行（命令提示符中可去掉 `.\`）：

```powershell
.\weflow.cmd prepare --launch
```

这是单账号目录时最简单的方式。若电脑上有多个微信数据目录，应先运行 `weflow.cmd accounts`，再明确指定正确的 `db_storage`，不要根据账号名猜旧 C 盘或新 D 盘目录：

```powershell
.\weflow.cmd prepare --data-dir "D:\wechat\xwechat_files\wxid_example\db_storage" --launch
```

源码版入口会准备所需环境；安装版使用包内冻结后端，不要求另外安装 Node.js 或 Python。命令成功后才会配置并打开原版 WeFlow。

## 出错时的推荐顺序

Agent 可先按下面顺序诊断。若密钥缓存完整且通过认证，`keys` 会复用缓存；缓存不完整时，用户需要登录并运行微信，让工具读取尚未缓存的密钥。需要强制重新扫描时使用 `keys --refresh`，同样需要微信已登录运行。

```powershell
.\weflow.cmd doctor
.\weflow.cmd accounts
.\weflow.cmd status --data-dir "D:\wechat\xwechat_files\wxid_example\db_storage"
.\weflow.cmd keys --data-dir "D:\wechat\xwechat_files\wxid_example\db_storage"
```

若 `keys` 返回 `KEY_NOT_FOUND`，查看 JSON 的 `details.missing_databases`、`verified_databases` 和 `unavailable_databases`，确认哪些必需数据库仍缺密钥、已有多少密钥通过认证。所选目录可通过 `status --data-dir` 确认，`directorySource` 表示目录选择依据。请用户保持微信登录、打开目标聊天并浏览一段历史记录，再重试 `keys`；必要时加 `--refresh` 重新扫描。这有助于加载数据库，不保证每个版本都能取得全部密钥。不要让用户提供或把密钥打印到日志。副本错误 `SNAPSHOT_REQUIRED` 的 `details.missing` / `file` 则表示缺少所需副本文件，应运行 `decrypt` 或 `prepare` 重新准备。

密钥齐全后，提醒用户从系统托盘**正常退出微信**，再继续准备和校验快照：

```powershell
.\weflow.cmd decrypt --data-dir "D:\wechat\xwechat_files\wxid_example\db_storage"
.\weflow.cmd verify --data-dir "D:\wechat\xwechat_files\wxid_example\db_storage"
.\weflow.cmd configure --data-dir "D:\wechat\xwechat_files\wxid_example\db_storage"
.\weflow.cmd launch --data-dir "D:\wechat\xwechat_files\wxid_example\db_storage"
```

一般情况下直接用 `prepare --launch` 即可完成这些步骤。微信运行时，`prepare` / `decrypt` 会返回 `NEED_EXIT`（退出码 `10`），已取得的密钥会保留。可以选择等待一段时间：

```powershell
.\weflow.cmd prepare --data-dir "D:\wechat\xwechat_files\wxid_example\db_storage" --wait-exit 180 --launch
```

`--wait-exit` 只等待微信自行退出，到时限仍运行就返回；工具绝不会自动 kill 微信进程。请关闭微信后重跑命令。

## 常见错误恢复

| 结果代码 | 处理方式 |
| --- | --- |
| `NEED_EXIT`（10） | 正常退出微信后重跑 `prepare` 或 `decrypt`。密钥会保留。 |
| `NEED_LOGIN`（11） | 若缓存不完整或使用 `--refresh`，先登录并运行微信，再重试。完整认证缓存可以离线复用。 |
| `KEY_NOT_FOUND`（12） | 查看 `details.missing_databases`、`verified_databases` 和 `unavailable_databases`；保持登录、打开目标聊天和历史记录后重试，必要时 `keys --refresh`。 |
| `ACCOUNT_REQUIRED` / `ACCOUNT_DIRECTORY_MISMATCH`（13） | 用 `accounts` 查看候选目录，并通过 `--data-dir` 明确选择正确的 `db_storage`。多个目录时不要猜测 C、D 盘哪一个是当前账号。 |
| `SNAPSHOT_REQUIRED`（14） | 查看 `details.missing` / `file` 确认缺失项，运行 `decrypt` 或 `prepare` 创建完整副本，再运行查询或 GUI。 |
| `GUI_RUNNING`（15） | 从 WeFlow 托盘或退出选项正常退出占用该 profile 的应用，再运行 `configure`、`launch` 或 `prepare --launch`。仅隐藏窗口仍会占用配置。 |
| `PROFILE_LOCKED`（16） | 改用独立的 `--user-data DIR`，或在原 WeFlow GUI 设置中关闭应用锁。只在 GUI 中解锁不会让 headless CLI 继承解锁状态。 |
| `GUI_NOT_BUILT`（17） | 源码版运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch.ps1 -BuildOnly` 构建 GUI，或通过 `--app` 指定现有 `WeFlow.exe`。 |

若状态显示源数据库变化（`sourceChanged`），请先正常退出微信，再运行 `decrypt` 或 `prepare` 更新副本。工具会保留旧的有效快照，成功后再切换到新副本；不需要删除微信数据库，也不要手动删除旧快照来排错。

## Agent 如何读取结果

成功操作的 stdout 是一个 JSON 对象；`--help` 输出普通帮助文本。stderr 可能包含首次启动环境准备时的人类可读提示，也可能包含进度信息。Agent 应检查退出码和结果 JSON 的 `success`；失败时优先按 `code` 与 `action` 恢复，并查看 `details` 中的数据库和路径建议。不要把 stderr 文本当作最终结果，也不要把密钥写入对话或日志。

默认 profile 位于 `%APPDATA%\WeFlow-full`，CLI 启动的 GUI 日志在 `%APPDATA%\WeFlow-full\logs\cli-gui.log`。若指定 `--user-data DIR`，所有后续 CLI 命令都应继续使用同一个目录；CLI 启动的 GUI 也会共用这个 profile，日志在 `DIR\logs\cli-gui.log`。换用 profile 后，原 profile 中的配置、缓存和快照不会自动带过去。CLI 本身的错误与准备进度需读取本次调用的 stdout / stderr；尚未启动 GUI 时不会生成 GUI 日志。

可用 CLI 列出会话、分页读取消息、搜索并导出原始 JSONL：

```powershell
.\weflow.cmd sessions
.\weflow.cmd messages --session "wxid_example" --limit 100 --offset 0
.\weflow.cmd search --keyword "周末" --session "wxid_example" --limit 50
.\weflow.cmd export --session "wxid_example" --output "D:\wechat\exports"
```

现有 WeFlow GUI 仍提供 TXT、HTML、ChatLab JSON 和 WeClone CSV 导出。`verify` 若把依赖微信专用 `MMFtsTokenizer` 的 FTS 项列入 `limitedChecks`，表示该项检查受缺少微信 tokenizer 的环境限制；应结合普通 SQLite 完整性和可用查询结果判断，不要将其描述为所有 FTS 检查均已通过。媒体恢复及全部高级统计能力不属于这里的保证范围。

快照是本机的明文 SQLite 副本，密钥缓存受 Windows DPAPI 保护。源微信数据库不会被解密或修改；请不要删除源数据库，也不要向用户或日志输出密钥。
