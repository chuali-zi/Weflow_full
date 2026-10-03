# WeFlow CLI

CLI 支持 `snapshot` 离线副本和 `live` 在线读取。在线模式使用只读 SQLCipher 连接，可在微信运行时查询新提交的消息；GUI 接入同一读取模式并监听变化。架构及事件契约见 [接入规格](live-spec.md)。

`weflow.cmd` 是给 Agent 和脚本使用的 Windows 命令行入口。它复用仓库内的 wxtext 密钥获取、解密和查询后端；准备完成后可以写入 WeFlow 现有配置并启动原版 GUI。

首次启动的推荐顺序、常见错误恢复方式和 Agent 示例见[Agent 首次启动与 CLI 排错](agent-first-start.md)。

## 最短用法

在仓库根目录或安装目录运行：

```bat
weflow.cmd prepare --mode live --launch
```

`prepare --mode live` 获取并缓存逐库密钥、验证在线连接、配置 WeFlow；不需要退出微信。`--launch` 在成功后启动 GUI。若检测到多个账号目录，请明确指定其中的 `db_storage`：

```bat
weflow.cmd prepare --mode live --data-dir "D:\wechat\xwechat_files\wxid_example\db_storage" --launch
```

需要固定副本或大范围导出时可显式选择 `snapshot`。离线流程要求微信正常退出后再复制聊天数据库。微信仍运行时返回退出码 `10`，保留已取得的密钥；也可以最多等待 180 秒：

```bat
weflow.cmd prepare --mode snapshot --wait-exit 180 --launch
```

CLI 只等待，不会自动关闭或结束微信进程。`--wait-exit` 只用于 snapshot；live 显式传入它会返回参数错误。

源码仓库中的 `weflow.cmd` 首次运行会自动准备依赖，`prepare`、`configure` 和 `launch` 还会构建 GUI。安装目录中的 `weflow.cmd` 使用包内冻结后端，不需要 Node.js 或 Python。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `doctor` | 检查后端运行环境、微信进程和可发现的数据目录。 |
| `accounts` | 列出发现到的微信账号目录。 |
| `status` | 查看目标账号模式、密钥覆盖及连接 / 副本状态；单次 CLI 状态不代表持续监控。 |
| `keys` | 获取并缓存密钥。完整且通过认证的缓存可直接复用，不要求微信正在运行；缓存不足时，或指定 `keys --refresh` 强制扫描时，需要微信已登录并运行。 |
| `decrypt` | 使用已缓存的密钥创建或更新副本，并验证副本。 |
| `verify` | snapshot 检查副本完整性；live 验证认证连接、必需库覆盖及基础查询，不做全库完整性检查。 |
| `configure` | 验证所选读取模式，再接入 WeFlow 配置。 |
| `launch` | 验证、配置所选模式并启动 GUI。 |
| `prepare` | 获取密钥，按所选模式准备、验证、配置；加 `--launch` 打开 GUI。 |
| `sessions` | 列出当前读取模式中的会话。 |
| `messages --session USERNAME` | 分页读取会话消息，默认 50 条、偏移量 0。可用 `--limit` 和 `--offset` 指定范围。 |
| `search --keyword 关键词` | 搜索消息；可用 `--session USERNAME` 限定会话，并用 `--limit` / `--offset` 分页。 |
| `export --session USERNAME --output DIR` | 将单个会话导出为原始 JSONL 文件。 |

例如，准备好所选读取模式后查询和导出：

```bat
weflow.cmd sessions
weflow.cmd messages --session "wxid_example" --limit 100 --offset 0
weflow.cmd search --keyword "周末" --session "wxid_example" --limit 50
weflow.cmd export --session "wxid_example" --output "D:\wechat\exports"
```

查询命令使用已缓存密钥或已有副本，不会自动扫描密钥。`--mode live|snapshot` 优先于该账号保存的模式；没有保存值时默认 snapshot。临时查询覆盖不保存模式；成功的 `prepare` / `configure` / `launch` 和 GUI 模式切换保存选择，位于 `backend/settings.json.database_modes`。`decrypt` 始终创建离线副本且不修改模式；`decrypt --mode live` 返回参数错误。

`--data-dir` 可指向 `db_storage`、其账号目录或唯一账号所在的数据目录。多个目录无法唯一判断时，请指定目标账号。全局选项 `--mode`、`--user-data DIR`、`--data-dir DIR`、`--app WeFlow.exe` 和 `--quiet` 可放在命令名前或子命令后。

在线查询结果提供 `freshness`，包含 `connectionId`、`revision`、`queriedAt` 和 `consistency: "per_database"`。各分库在各自短事务中读取，不能将它解释成跨库全局快照。在线导出使用独立后端捕获数据再转换；大范围捕获超时可缩小范围或改用 snapshot。

默认用户配置和后端状态目录为 `%APPDATA%\WeFlow-full`。如使用 `--user-data`，本次 CLI 启动的 GUI 也会使用同一目录。配置阶段通过 WeFlow 自己的 `ConfigService` 写入密钥和账号设置，并标记首次向导已完成；CLI 不会代用户同意协议或解除 WeFlow 应用锁。新 profile 仍可能显示用户协议；已启用应用锁的 profile 仍需要在 GUI 中正常解锁。

`configure` 以及会调用它的 `prepare` / `launch` 会把该 profile 的 WCDB 与密钥提供程序设置切换到内置后端，以便 GUI 打开刚验证的 live 或 snapshot 数据源。若需要保留另一个 profile 的第三方工具配置，可使用独立的 `--user-data DIR`，并在后续命令中继续传入同一目录。

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
| `18` | `LIVE_ENGINE_UNAVAILABLE` | 使用启动脚本安装正式依赖，或重新安装包含 SQLCipher 的版本。 |
| `19` | `LIVE_BUSY` | 数据库短暂繁忙，稍后重试。 |
| `20` | `LIVE_READ_TIMEOUT` | 缩小查询或导出范围；大范围导出可用 snapshot。 |
| `21` | `SOURCE_REPLACED` | 等待重新认证连接；必要时重新获取密钥。 |
| `22` | `CURSOR_STALE` | 数据已提交变化，重取当前页并创建新游标。 |
| `23` | `CANCELLED` | 操作已取消，可重新发起查询。 |

除退出码外，JSON 结果会包含 `success`；错误时通常还会有 `code`、`error`、`action` 和 `details`。不要只检查进程是否启动：以退出码 `0` 和 stdout 中的 `success: true` 为准。
