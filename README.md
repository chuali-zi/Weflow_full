# WeFlow

基于 [hicccc77/WeFlow](https://github.com/hicccc77/WeFlow) 的本地解密接入分支。WeFlow 原有界面和操作流程保留；本分支把 wxtext 的微信数据库密钥获取、认证解密和只读查询接入现有流程。

Windows 安装包使用现有构建入口，位于 `release` 目录，当前文件名为 `WeFlow-Local-5.0.0-Setup.exe`。安装后无需另装 Node.js 或 Python。源码用户可按下面步骤启动。

## 使用

1. Clone 或下载本仓库，在 Windows 上双击根目录的 **启动 WeFlow.cmd**。首次启动会在仓库内准备运行环境、安装依赖并构建，需要联网；后续启动复用已准备的环境。
2. 在 WeFlow 原有欢迎/数据库设置界面，选择或填写微信数据目录根路径。登录电脑微信后，点击原有的 **自动获取密钥** 按钮。
3. 如果同一个微信账号有多套数据目录，密钥会按各数据库首页认证。唯一匹配的目录会自动填回原有路径栏；无法唯一判断时，按原有错误提示选择正确路径。
4. 点击原有的**连接数据库**操作。首次连接或检测到数据库 / WAL 有变化时，如果微信仍在运行，WeFlow 会提示先退出。请从系统托盘菜单**正常退出微信**，再点一次原有的**连接数据库**操作，完成副本准备或更新。准备完成后即可按原有方式查看和搜索聊天记录。

只关闭微信主窗口不代表微信已退出。源数据库以只读方式处理；副本是准备时的离线快照，当前不实时同步微信的新消息。连接时若检查到源库及 WAL 元信息没有变化，会复用现有副本；检测到变化时，按上述提示正常退出微信并再次连接即可更新。

## CLI（Agent / 脚本）

一条命令获取密钥、准备并验证副本、配置现有 WeFlow，然后打开原版 GUI：

```bat
weflow.cmd prepare --launch
```

有多个微信数据目录时明确指定目标；微信仍运行时可让命令最多等待 180 秒：

```bat
weflow.cmd prepare --data-dir "D:\wechat\xwechat_files\wxid_example\db_storage" --wait-exit 180 --launch
```

命令只等待微信正常退出，**不会结束微信进程**。默认不等待时，如果微信仍运行会以退出码 `10` 结束；已取得的密钥会保留，正常退出后重新运行命令即可。源码目录的 `weflow.cmd` 会自动准备依赖并构建 GUI；安装目录的同名脚本直接使用包内后端，不需要 Node.js 或 Python。首次使用与错误恢复见 [Agent 首次启动指南](docs/agent-first-start.md)，命令参数和退出码见 [CLI 使用说明](docs/cli.md)。

## 接入范围

| 能力 | 当前范围 |
| --- | --- |
| 数据目录与密钥 | 识别配置目录并按数据库校验密钥；密钥按数据库分别缓存。原有外部密钥工具配置仍由 WeFlow 使用；未配置时调用内置 wxtext。 |
| 聊天数据库 | 完整消息分库作为准备要求；复制数据库、合并已提交 WAL、逐页认证解密后，以只读 SQLite 查询。 |
| 聊天查询 | 联系人、会话、消息分页、文本搜索、发送者识别、压缩长文本及基础统计。 |
| 导出 | 保留 WeFlow 原有格式和入口；显式配置的第三方导出程序仍按原配置使用，内置原始 JSONL 接入可用时交给原格式转换器。 |
| 其他能力 | 图片/视频/语音等媒体、完整群成员名单、朋友圈专用查询和部分高级报表尚未完整接入或验证；实时同步和数据库写操作不在离线副本范围内。 |

手动 GUI 流程会继续按原设置使用显式配置的密钥获取 `.exe`、WCDB `.dll` 或 WeLive 导出 `.exe`。CLI 的 `configure` / `prepare` / `launch` 会将目标 profile 的密钥提供程序和 WCDB 切换到内置后端，接入已经验证的副本；详见 [CLI 配置说明](docs/cli.md)。

## 验证状态

已在真实微信 **4.1.13.65** 上验证数据库首页密钥：微信配置指向的 D 盘目录有 **21 / 21** 个数据库通过 HMAC 认证；旧 C 盘目录为 **0 / 18**。独立打包后端能够按微信配置选择 D 盘，且缓存的 **21** 个密钥全部通过相应数据库认证；21 个数据库均已整库解密。

已通过 **17 项 Python 回归测试**。源码 CLI 的 `prepare` 已成功写入用户默认 `%APPDATA%\WeFlow-full` 配置（21 个数据库、411 个会话）。独立 profile 上的 `doctor`、`accounts`、`status`、`keys`、`verify`、`configure`、`sessions`、`messages`、`search` 和 `export` 命令均通过；冻结后端的 `verify` 也通过。

使用真实 profile 启动原 WeFlow GUI，无需手动连接数据库或补写配置即可自动进入 `#/home`。界面列出 700 个上游会话项（其中含联系人虚拟会话；后端实际有消息的会话为 411 个），实测读取 50 条消息、搜索返回 20 条。TXT、HTML、JSON 和 WeClone CSV 导出通过；JSON 与 WeClone CSV 各包含 **8,173** 条消息。未验证通用 CSV 格式。

普通数据库完整性检查通过；依赖微信专用 `MMFtsTokenizer` 的 FTS 检查作为有限检查列在 `limitedChecks`。最终冻结资源目录（`win-unpacked`）中的 CLI 配置和原 GUI 预配置测试已通过：700 个界面会话项、50 条消息、20 条搜索结果和 8,173 条导出记录；统计为 85,841 条消息，统计缓存已成功写入 profile/cache。NSIS 安装程序已生成；验证覆盖包内资源，未执行完整交互安装验收。

## 本地数据

运行状态和解密后的聊天副本保存在当前 Windows 用户的应用数据目录；密钥缓存由 Windows DPAPI 保护。副本是明文 SQLite，应按本机聊天数据管理。源微信数据库不在原位置解密或执行 SQL。

首次启动生成的 `.venv`、`.runtime`、`node_modules` 等目录已加入 Git 忽略规则。

## 开发与打包

更多文档见[文档导航](docs/README.md)。只准备运行环境：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch.ps1 -SetupOnly
```

源码检查与构建：

```powershell
npm run typecheck
npm run build:app
```

生成 Windows 安装包：

```powershell
npm run package:win
```

安装包内含独立后端。上游作者信息及许可保留于 [LICENSE](LICENSE)（CC BY-NC-SA 4.0），原始上游说明见 [README.upstream.md](README.upstream.md)。接入范围和技术说明见 [docs/integrated-backend.md](docs/integrated-backend.md)。

## 来源与致谢

- 主界面、Electron 应用和导出格式来自 [WeFlow](https://github.com/hicccc77/WeFlow)，原作者 **cc / hicccc77**，本分支基于上游提交 [`837697b`](https://github.com/hicccc77/WeFlow/commit/837697b)。
- 数据库密钥扫描、认证解密、WAL、快照及 DPAPI：本项目原有 `abstract_information/wxtext` 工具，现随仓库放在 `python/wxtext`。
- 本分支由 [chuali-zi](https://github.com/chuali-zi) 维护：将本地密钥获取、解密与查询能力接入 WeFlow 原有页面及数据库接口，增加 CLI、首次启动、错误恢复和后端打包支持。

感谢 **cc / hicccc77** 和 [WeFlow 的所有贡献者](https://github.com/hicccc77/WeFlow/graphs/contributors) 提供完整的聊天界面、查询与导出功能，让本分支能够在已有成果上接入本地解密和 Agent 使用流程。也感谢 SQLCipher、SQLite、Microsoft Windows API、Zstandard 等项目的公开文档，以及 wxtext 研发时使用的公开参考资料，具体链接见 [研发依据](docs/wxtext-architecture.md#研发依据)。

本仓库是独立维护的衍生版本。上游说明原文保存在 [README.upstream.md](README.upstream.md)，其中的功能说明与下载链接对应上游版本。

## 许可证

本衍生版本及本分支对 WeFlow 的修改采用 **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International（CC BY-NC-SA 4.0，署名—非商业性使用—相同方式共享）**，完整条款见 [LICENSE](LICENSE) 和 [官方许可说明](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)。

在遵守条款的前提下，可以复制、修改和分享本项目：

- 保留原作者、项目来源、许可证及免责声明，并说明所做的修改。
- 仅用于非商业目的；商业使用需要另外取得相关权利人的授权。
- 分享修改后的衍生版本时，使用相同或许可允许的兼容条款。

本分支沿用上游许可，不增加额外限制。上游的非商业与相同方式共享要求仍然适用，因此不能将整个衍生版本改为 MIT、Apache-2.0 或 CC0。第三方依赖与另有许可声明的组件继续遵循各自的许可证。
