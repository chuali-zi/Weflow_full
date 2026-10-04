# WeFlow

基于 [hicccc77/WeFlow](https://github.com/hicccc77/WeFlow) 的本地解密接入分支。WeFlow 原有界面和操作流程保留；本分支把 wxtext 的微信数据库密钥获取、认证解密和只读查询接入现有流程。

## 安装

安装指令：[installed.md](https://github.com/chuali-zi/Weflow_full/blob/main/installed.md)。把下面这段话复制给能操作本机终端的 Agent，让它完成 WeFlow 和 Codex MCP 的安装、配置与连接验证：

```text
请阅读并执行 https://github.com/chuali-zi/Weflow_full/blob/main/installed.md ，帮我在本机安装 WeFlow，并将它的 MCP 接入 Codex。复用已有安装和配置，默认使用 live 模式，完成后验证 CLI 与 MCP 的实际连接。需要我登录微信或选择账号时再告诉我。
```

详细的环境准备、常见报错、复杂 CLI 用法和 MCP 注册步骤均在该文件中。

## MCP（聊天读取）

已准备的账号可以通过 `weflow-mcp.cmd` 提供给 Agent。当前包含 8 个工具：定位群聊/私聊、消息概览、成批原文读取、字面检索、上下文与引用、本机图片、连接状态和完整范围文件导出。原文读取默认 500 条、120,000 字符，可选紧凑格式；大量记录可一次导出 JSONL 与连续阅读文本。范围、预算和分析方式由调用方 Agent 选择。

安装与客户端接入见 [installed.md](https://github.com/chuali-zi/Weflow_full/blob/main/installed.md)；工具调用和读取限制见 [MCP 使用说明](docs/mcp-usage.md)。CLI 的完整命令、JSON 输出和退出码见 [CLI 使用说明](docs/cli.md)。

## 接入范围

| 能力 | 当前范围 |
| --- | --- |
| 数据目录与密钥 | 识别配置目录并按数据库校验密钥；密钥按数据库分别缓存。原有外部密钥工具配置仍由 WeFlow 使用；未配置时调用内置 wxtext。 |
| 聊天数据库 | live 使用只读 SQLCipher 查询微信 DB/WAL；snapshot 复制、重放已提交 WAL、逐页认证解密后以只读 SQLite 查询。两者均要求完整核心消息分库。 |
| 聊天查询 | 联系人、会话、消息分页、文本搜索、发送者识别、压缩长文本及基础统计。 |
| 导出 | 保留 WeFlow 原有格式和入口；显式配置的第三方导出程序仍按原配置使用，内置原始 JSONL 接入可用时交给原格式转换器。 |
| 热加载 | 内置 live 连接检测提交并失效缓存，刷新列表和当前消息窗口，处理同秒消息、修改和删除；浏览历史时保持消息锚点。 |
| 图片 | 已接入账号 V2 图片密钥自动获取、本机附件索引和内置解密；在线聊天页自动重试晚到附件。未下载到本机的图片需要先由微信下载。 |
| 其他能力 | 视频/语音等其他媒体、完整群成员名单、朋友圈专用查询和部分高级报表尚未完整接入或验证；不支持向微信源数据库写入。 |

手动 GUI 流程会继续按原设置使用显式配置的密钥获取 `.exe`、WCDB `.dll` 或 WeLive 导出 `.exe`。CLI 的 `configure` / `prepare` / `launch` 会将目标 profile 的密钥提供程序和 WCDB 切换到内置后端，接入已经验证的 live 或 snapshot 数据源；详见 [CLI 配置说明](docs/cli.md)。

## 验证状态

当前后端 **30 项回归测试**通过，源码及包内资源的 Electron 在线测试验证了 20 条同秒新增、修改、删除、历史补入、滚动锚点和独立在线导出。真实微信继续运行时，live verify 读到 **411 个实际聊天会话**，源码约 2.2 秒完成；包内 CLI 同样通过，并已用 live 启动现有 profile。最终 Windows 安装包已生成，完整交互安装尚未验收。在线架构、接口和复现方法见 [热加载文档](docs/live-validation.md)。以下整库解密、大规模导出和完整性结果属于此前 snapshot 验证。

已在真实微信 **4.1.13.65** 上验证数据库首页密钥：微信配置指向的 D 盘目录有 **21 / 21** 个数据库通过 HMAC 认证；旧 C 盘目录为 **0 / 18**。独立打包后端能够按微信配置选择 D 盘，且缓存的 **21** 个密钥全部通过相应数据库认证；21 个数据库均已整库解密。

源码 CLI 的 snapshot `prepare` 已成功写入用户默认 `%APPDATA%\WeFlow-full` 配置（21 个数据库、411 个会话）。独立 profile 上的 `doctor`、`accounts`、`status`、`keys`、`verify`、`configure`、`sessions`、`messages`、`search` 和 `export` 命令均通过；冻结后端的 `verify` 也通过。

使用真实 profile 启动原 WeFlow GUI，无需手动连接数据库或补写配置即可自动进入 `#/home`。界面列出 700 个上游会话项（其中含联系人虚拟会话；后端实际有消息的会话为 411 个），实测读取 50 条消息、搜索返回 20 条。TXT、HTML、JSON 和 WeClone CSV 导出通过；JSON 与 WeClone CSV 各包含 **8,173** 条消息。未验证通用 CSV 格式。

普通数据库完整性检查通过；依赖微信专用 `MMFtsTokenizer` 的 FTS 检查作为有限检查列在 `limitedChecks`。最终冻结资源目录（`win-unpacked`）中的 CLI 配置和原 GUI 预配置测试已通过：700 个界面会话项、50 条消息、20 条搜索结果和 8,173 条导出记录；统计为 85,841 条消息，统计缓存已成功写入 profile/cache。NSIS 安装程序已生成；验证覆盖包内资源，未执行完整交互安装验收。

## 本地数据

运行状态和聊天副本保存在当前 Windows 用户的应用数据目录；密钥缓存由 Windows DPAPI 保护。snapshot 是明文 SQLite，应按本机聊天数据管理。live 在加密源库上执行只读查询，常规查看不生成整库明文副本；导出会生成所选内容的明文文件。

首次启动生成的 `.venv`、`.runtime`、`node_modules` 等目录已加入 Git 忽略规则。

## 开发与打包

开发环境准备见 [installed.md](https://github.com/chuali-zi/Weflow_full/blob/main/installed.md)，更多文档见[文档导航](docs/README.md)。源码检查与构建：

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

HEIC 原图预览使用 [heic-decode](https://github.com/catdad-experiments/heic-decode)（ISC）和其依赖 [libheif-js](https://github.com/catdad-experiments/libheif-js)（LGPL-3.0），感谢这些项目的维护者。组件保留各自的许可，使用未修改的 npm 发布版本；源码和许可可在对应仓库及随包依赖中查看。

本仓库是独立维护的衍生版本。上游说明原文保存在 [README.upstream.md](README.upstream.md)，其中的功能说明与下载链接对应上游版本。

## 许可证

本衍生版本及本分支对 WeFlow 的修改采用 **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International（CC BY-NC-SA 4.0，署名—非商业性使用—相同方式共享）**，完整条款见 [LICENSE](LICENSE) 和 [官方许可说明](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)。

在遵守条款的前提下，可以复制、修改和分享本项目：

- 保留原作者、项目来源、许可证及免责声明，并说明所做的修改。
- 仅用于非商业目的；商业使用需要另外取得相关权利人的授权。
- 分享修改后的衍生版本时，使用相同或许可允许的兼容条款。

本分支沿用上游许可，不增加额外限制。上游的非商业与相同方式共享要求仍然适用，因此不能将整个衍生版本改为 MIT、Apache-2.0 或 CC0。第三方依赖与另有许可声明的组件继续遵循各自的许可证。
