# WeFlow CLI

`weflow.cmd` 是给 Agent 和脚本使用的 Windows 命令行入口。它复用仓库内的 wxtext 密钥获取、解密和查询后端；准备完成后可以写入 WeFlow 现有配置并启动原版 GUI。

首次启动的推荐顺序、常见错误恢复方式和 Agent 示例见[Agent 首次启动与 CLI 排错](agent-first-start.md)。

## 最短用法

在仓库根目录或安装目录运行：

```bat
weflow.cmd prepare --launch
```

`prepare` 会按顺序获取并缓存逐库密钥、准备和验证离线副本、配置 WeFlow。`--launch` 会在成功后启动 GUI。若检测到多个账号目录，请明确指定其中的 `db_storage`：

```bat
weflow.cmd prepare --data-dir "D:\wechat\xwechat_files\wxid_example\db_storage" --launch
```

聊天数据库只能在微信正常退出后稳定复制。微信仍运行时，CLI 默认立即返回退出码 `10`，但保留已取得的密钥；退出微信后重新运行同一条 `prepare` 命令即可。也可以让 CLI 最多等待 180 秒：

```bat
weflow.cmd prepare --wait-exit 180 --launch
```

CLI 只等待，不会自动关闭或结束微信进程。

源码仓库中的 `weflow.cmd` 首次运行会自动准备依赖，`prepare`、`configure` 和 `launch` 还会构建 GUI。安装目录中的 `weflow.cmd` 使用包内冻结后端，不需要 Node.js 或 Python。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `doctor` | 检查后端运行环境、微信进程和可发现的数据目录。 |
| `accounts` | 列出发现到的微信账号目录。 |
| `status` | 查看目标账号密钥缓存和副本状态，包括可认证的密钥数、副本库数及源数据是否变化。 |
| `keys` | 获取并缓存密钥。完整且通过认证的缓存可直接复用，不要求微信正在运行；缓存不足时，或指定 `keys --refresh` 强制扫描时，需要微信已登录并运行。 |
| `decrypt` | 使用已缓存的密钥创建或更新副本，并验证副本。 |
| `verify` | 检查现有副本、数据库完整性和基本聊天查询。有限的 FTS 检查会列入结果 `limitedChecks`。 |
| `configure` | 验证现有副本，再把它接入 WeFlow 配置。 |
| `launch` | 验证副本、配置 WeFlow 并启动 GUI。 |
| `prepare` | 依次执行密钥获取、解密、验证和配置；加 `--launch` 在成功后打开 GUI。 |
| `sessions` | 列出副本中的会话。 |
| `messages --session USERNAME` | 分页读取会话消息，默认 50 条、偏移量 0。可用 `--limit` 和 `--offset` 指定范围。 |
| `search --keyword 关键词` | 搜索消息；可用 `--session USERNAME` 限定会话，并用 `--limit` / `--offset` 分页。 |
| `export --session USERNAME --output DIR` | 将单个会话导出为原始 JSONL 文件。 |

例如，检查已有副本后读取会话和消息：

```bat
weflow.cmd sessions
weflow.cmd messages --session "wxid_example" --limit 100 --offset 0
weflow.cmd search --keyword "周末" --session "wxid_example" --limit 50
weflow.cmd export --session "wxid_example" --output "D:\wechat\exports"
```

查询命令只使用已有的完整副本，不会自动获取密钥或刷新快照。`--data-dir` 可指向 `db_storage`、其账号目录或唯一账号所在的数据目录。多个目录无法唯一判断时，请指定目标账号。全局选项 `--user-data DIR`、`--data-dir DIR`、`--app WeFlow.exe` 和 `--quiet` 可放在命令名前或子命令后。

默认用户配置和后端状态目录为 `%APPDATA%\WeFlow-full`。如使用 `--user-data`，本次 CLI 启动的 GUI 也会使用同一目录。配置阶段通过 WeFlow 自己的 `ConfigService` 写入密钥和账号设置，并标记首次向导已完成；CLI 不会代用户同意协议或解除 WeFlow 应用锁。新 profile 仍可能显示用户协议；已启用应用锁的 profile 仍需要在 GUI 中正常解锁。

`configure` 以及会调用它的 `prepare` / `launch` 会把该 profile 的 WCDB 与密钥提供程序设置切换到内置后端，以便 GUI 打开刚验证的副本。若需要保留另一个 profile 的第三方工具配置，可使用独立的 `--user-data DIR`，并在后续命令中继续传入同一目录。

## 输出与退出码

成功命令的结果以单个 JSON 对象写到 stdout；`--help` 输出普通帮助文本。stderr 可能包含启动提示或进度信息，不能假定每一行都是 JSON。使用管道时，请分别读取 stdout、stderr，并根据进程退出码判断是否成功。

| 退出码 | 含义 | 建议操作 |
| ---: | --- | --- |
| `0` | 成功 | 读取 stdout 的 JSON 结果。 |
| `1` | 未分类运行错误 | 查看 JSON 错误、目录和环境。 |
| `2` | 参数错误 | 检查命令参数；运行 `weflow.cmd --help`。 |
| `10` | `NEED_EXIT`，微信仍运行，副本不能准备 | 正常退出微信后重跑 `prepare` 或 `decrypt`；CLI 不会结束微信。 |
| `11` | `NEED_LOGIN`，未找到已登录的微信进程 | 若密钥缓存不完整或在强制刷新，先登录并运行微信，再重试 `keys` 或 `prepare`。完整认证缓存可复用。 |
| `12` | `KEY_NOT_FOUND`，尚有必需数据库密钥未通过认证 | 保持微信登录、打开目标聊天和历史记录后重试；已验证密钥会保留。 |
| `13` | `ACCOUNT_REQUIRED` / `ACCOUNT_DIRECTORY_MISMATCH` | 使用 `accounts` 查看路径，并用 `--data-dir` 指定正确账号。 |
| `14` | `SNAPSHOT_REQUIRED`，副本缺失或不完整 | 运行 `decrypt` 或 `prepare`。 |
| `15` | `GUI_RUNNING`，同一 WeFlow 配置已被 GUI 占用 | 从 WeFlow 托盘或退出选项正常退出应用，再运行 `configure`、`launch` 或 `prepare --launch`。仅隐藏窗口仍会占用配置。 |
| `16` | `PROFILE_LOCKED`，目标配置使用应用锁，headless CLI 无法继承 GUI 解锁状态 | 指定独立 `--user-data DIR` profile，或在原 WeFlow GUI 设置中关闭应用锁后重试。仅在 GUI 中解锁不会让 headless CLI 获得解锁状态。 |
| `17` | `GUI_NOT_BUILT`，找不到 GUI | 源码版运行 `启动 WeFlow.cmd` 完成构建，或使用 `--app` 指定 `WeFlow.exe`。 |

除退出码外，JSON 结果会包含 `success`；错误时通常还会有 `code`、`error`、`action` 和 `details`。不要只检查进程是否启动：以退出码 `0` 和 stdout 中的 `success: true` 为准。
