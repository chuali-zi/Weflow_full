# WeFlow MCP v1 实现与验证

## 2026-10-16 稳定性与模拟重启验证

本轮使用独立合成账号，未重启电脑、未关闭微信、未修改真实账号配置。采用实际结束测试进程、保留磁盘准备状态、创建新 stdio 客户端的方式模拟重启后的冷启动；不覆盖 Windows 登录、自启策略、磁盘断电损坏或第三方客户端自身的重连实现。

故障注入先在修复前复现了三类失败：后端输出 JSON `null` 导致未捕获异常；持续 disconnected 触发无限重连；状态查询的末尾发生断连却仍返回成功。修复后，异常帧不再崩溃，缺失 result 的响应明确报协议错误并释放后端，恢复次数有界，未就绪连接不再报告成功。管道写入错误会立即使连接失效，超时错误明确标记可重试。

| 本轮检查 | 结果 |
| --- | --- |
| `npm run test:mcp` | 43 项通过，含 100 轮固定种子后端帧注入、畸形响应、进程退出、卡住超时、持续断连与状态竞态。 |
| `npm run fuzz:mcp`，默认种子 `5762832` | snapshot / live 均通过；共 6 次冷启动、2 次 MCP 主进程强退、2 次后端强退、200 个随机无效工具请求、200 个异常协议帧、4 次健康检查。另验证并发请求、profile 丢失/损坏/锁定后修复、旧游标和短引用过期、测试后端随主进程退出。 |
| `npm run check:mcp`，snapshot / live | 两种模式均通过 11 个工具的完整源码 stdio 联调，包含分页、长文、清洗读取、上下文、千条读取、万条导出及 live 旧游标失效。 |
| `npm run build:mcp`、`npm run typecheck:electron` | 通过；构建仍有现有的 Vite `inlineDynamicImports` 弃用提示。 |

增加 `weflow-mcp.cmd --check`，用临时真实 MCP 客户端验证握手、工具列表、状态和会话读取；输出不包含聊天正文，成功退出 0，失败退出 1。它验证独立连接，不会修复其他 Agent 的旧管道。恢复步骤同时写入 MCP 启动 instructions 与使用文档。

本轮未重新打包 Windows 安装程序，也未强制重连用户正在使用的 MCP 客户端。下文为之前版本的验证记录。

日期：2026 年 10 月 3 日。实现基线：`170c4a9`。运行说明见 [MCP 使用说明](mcp-usage.md)。

## 实现结果

服务使用固定版本 `@modelcontextprotocol/sdk` 1.32.0，由 SDK 协商协议版本。`mcp/server.ts` 提供独立 stdio 入口，`mcp/runtime.ts` 复用常驻 Python 后端，当前提供 8 个工具。`mcp/query.ts` 支持成批读取，`mcp/format.ts` 提供带短引用的紧凑原文，`mcp/export.ts` 连续写入 JSONL/TXT 和状态 manifest。`shared/chat` 提供共享正文解码、稳定标识、消息归一化和纯图片解密；名称映射只查询实际涉及的人和会话。

Python 新增准备状态读取、打开已有数据、精确消息定位、邻居游标和已缓存图片密钥读取。查询不会调用获取密钥或创建 snapshot。live 状态查询检测实际数据库提交；缓存失效后旧游标返回 `CURSOR_STALE`。profile 锁、损坏与删除会停止连接并清理查询内容。

可靠非零 server ID 按精确字符串编码，超过 JavaScript 安全整数也能往返；无 server ID 时使用分库、表、local ID、时间定位。原文可拆段取回，同一游标可重放。字面搜索使用完整解码正文进行匹配，再返回短片段，不依赖外部模型或索引。

## 已执行验证

| 检查 | 结果 |
| --- | --- |
| 后端回归 `npm run test:backend` 对应 Python unittest 套件 | 37 项通过。 |
| MCP 回归 `npm run test:mcp` | 30 项全部通过，覆盖消息标识、归一化、媒体、名称、游标、扫描、回复、profile、取消、连接恢复、紧凑格式、万条导出及客户端兼容的参数声明。 |
| `npm run typecheck`、`npm run build:app` | renderer/Electron 类型检查与桌面构建通过。 |
| `npm run build:mcp` | MCP 类型检查、server.cjs 与 HEIC worker 构建通过。 |
| `npm run check:desktop` | 真实 Electron IPC、Worker、聊天读取、搜索及 TXT/HTML/JSON/WeClone 导出通过。 |
| 源码入口 snapshot/live | 本次官方 MCP 客户端经实际入口完成连接、8 个工具发现、千条紧凑读取、万条导出及 progress 通知。 |
| Windows 包内入口 snapshot/live | 基线版本使用包内 Electron Node mode、冻结 Python/SQLCipher 后端通过；目录含空格，fixture 数据路径含空格和中文。本次批量读取更新未重新打包验证。 |
| 源码/包内 `--print-config` | 生成的绝对路径配置直接连接成功，无需手工拼接 shell 引号。 |

端到端 fixture 包含同名群聊、私聊、跨消息分库、超过安全整数的 ID、任务后续取消、引用和 6,760 个 Unicode 字符的长消息。测试用每页 1 条、4,000 字符预算刻意制造续读，验证所有长文片段可恢复、最终消息不遗漏、重复游标不推进、概览不会重复统计、上下文可继续取回。

批量读取更新加入独立的 10,000 条短消息合成群。在 snapshot 与 live 的源码 stdio 联调中，紧凑读取一次返回 1,000 条完整消息，规范 JSON 约 242,000 个 Unicode 字符；一次 export_messages 调用完成 10,000 条导出，文件中的条数、消息 ID 去重、首尾正文和最后一条 progress 通知均核对通过。紧凑格式保留消息稳定 ID，并把重复的会话/参与者 ID 放入本页短引用映射。

单元测试另验证两会话共 10,000 条记录的有序导出、完整 Unicode 长文、媒体状态、类型过滤、独立输出目录，以及取消/数据版本变化时保留部分文件但标记未完成。本次 snapshot/live 各进行两次导出（小范围与万条范围），累计导出调用耗时约 0.43/0.47 秒；这些是本机合成数据库测试数据。

live 检查通过独立进程向合成 SQLCipher 库追加消息并 COMMIT，然后确认旧 MCP 游标失效。测试修改仅作用于合成 fixture，不写入真实微信数据库。

一次本机合成测试中，源码首次 status 连接约 0.23～0.27 秒，包内首次连接约 0.59～0.81 秒。后续群聊定位约 9～18 毫秒，短搜索约 6～8 毫秒。这些是小型 fixture 的联调数据，不能作为大规模真实账号的性能保证。脚本每次输出工具调用数、累计耗时和最大规范 JSON 字符数，可持续比较。

## 验证边界

基线与批量读取验证使用合成数据和官方 Node MCP 客户端。2026-10-04 另按用户授权，在已有 Windows 环境使用 Claude Code 2.1.234 实测卸载、安装及真实账号的指定会话查询；聊天正文、账号标识、密钥和原始日志均未写入仓库。本轮未验收第三方客户端的图片呈现。合成媒体测试验证 DAT 解密、图片输出预算、缺本机文件、缺图片密钥、类型识别和取消。尚未新增语音转写、OCR、视频播放、语义检索和完整群成员查询。

客户端联调发现并修复两个兼容性问题：环境准备显式加载当前 PowerShell 的 Utility 模块，避免继承的其他版本模块遮蔽 `Get-FileHash`；分页工具改用平铺对象输入声明，避免部分客户端跳过带顶层 `oneOf` 的工具。首次调用的必填参数及 cursor-only 续读约束仍由服务端执行，并有回归覆盖。只提供仓库 URL 的提示词没有触发安装；加入按 `installed.md` 安装并接入当前客户端的简短任务后，Agent 才执行完整安装流程。

修复后再次用卸载脚本移除 Claude Code 用户级注册，随后运行 `claude -p` 完成安装、CLI 验证和 stdio 连接验收。新启动的查询进程加载全部 8 个工具，直接调用 `find_chats` 和 `read_messages` 成功返回指定会话最新消息，未回退到 CLI。该次查询为 3 轮、约 47.6 秒；这是包含模型推理的本机端到端耗时，不代表数据库查询耗时或稳定性统计。测试复用已有依赖和已认证密钥，不覆盖无环境、无密钥的首次安装。实际 CLI 为 Claude Code 2.1.234，沿用本机配置的 `glm-5.3[1m]` 模型。

Windows 联调使用 `release/mcp preview/win-unpacked`。`npm run package:win` 已接入 MCP 构建与资源复制，可生成包含 MCP 的新安装包；旧 `release` 安装程序不代表本轮构建。

## 复现

```powershell
npm run build:mcp
npm run test:mcp
npm run check:mcp

$env:WEFLOW_MCP_CHECK_MODE = 'live'
npm run check:mcp

$env:WEFLOW_MCP_CHECK_PACKAGE = (Resolve-Path 'release/mcp preview/win-unpacked').Path
npm run check:mcp

$env:WEFLOW_MCP_CHECK_CONFIG = '1'
npm run check:mcp
```

不同模式可分别在新终端运行，或清除上述环境变量后恢复默认源码 snapshot 检查。测试产物均位于 Git 忽略的 `.runtime`、`build` 和 `release`。
