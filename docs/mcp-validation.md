# WeFlow MCP v1 实现与验证

日期：2026 年 10 月 3 日。实现基线：`170c4a9`。运行说明见 [MCP 使用说明](mcp-usage.md)。

## 实现结果

服务使用固定版本 `@modelcontextprotocol/sdk` 1.32.0，由 SDK 协商协议版本。`mcp/server.ts` 提供独立 stdio 入口，`mcp/runtime.ts` 复用常驻 Python 后端，当前提供 8 个工具。`mcp/query.ts` 支持成批读取，`mcp/format.ts` 提供带短引用的紧凑原文，`mcp/export.ts` 连续写入 JSONL/TXT 和状态 manifest。`shared/chat` 提供共享正文解码、稳定标识、消息归一化和纯图片解密；名称映射只查询实际涉及的人和会话。

Python 新增准备状态读取、打开已有数据、精确消息定位、邻居游标和已缓存图片密钥读取。查询不会调用获取密钥或创建 snapshot。live 状态查询检测实际数据库提交；缓存失效后旧游标返回 `CURSOR_STALE`。profile 锁、损坏与删除会停止连接并清理查询内容。

可靠非零 server ID 按精确字符串编码，超过 JavaScript 安全整数也能往返；无 server ID 时使用分库、表、local ID、时间定位。原文可拆段取回，同一游标可重放。字面搜索使用完整解码正文进行匹配，再返回短片段，不依赖外部模型或索引。

## 已执行验证

| 检查 | 结果 |
| --- | --- |
| 后端回归 `npm run test:backend` 对应 Python unittest 套件 | 37 项通过。 |
| MCP 回归 `npm run test:mcp` | 29 项全部通过，覆盖消息标识、归一化、媒体、名称、游标、扫描、回复、profile、取消、连接恢复、紧凑格式及万条导出。 |
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

当前 MCP 验证使用合成数据和官方 Node MCP 客户端；未在本轮读取真实账号，也未验收第三方客户端的图片呈现。合成媒体测试验证 DAT 解密、图片输出预算、缺本机文件、缺图片密钥、类型识别和取消。尚未新增语音转写、OCR、视频播放、语义检索和完整群成员查询。

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
