# WeFlow MCP 实现规格

状态：v1 实现契约。运行和验证见 [使用说明](mcp-usage.md)。日期：2026 年 10 月 3 日。规格版本：v1。代码基线：`170c4a9`。

依据：[PRD](mcp-prd.md)、[架构设计](mcp-architecture.md)。本文的 MUST/必须是实现与验收要求，不代表已完成。首版交付固定 7 个工具、stdio 本机服务、现有 live/snapshot 数据源、可恢复分页和可解释的覆盖信息。

## 1 启动与配置

入口：`weflow-mcp.cmd`。独立命令，不借用会打印 CLI 最终 JSON 或自动准备环境的普通查询命令作为 MCP transport。

| 参数 | 规则 |
| --- | --- |
| `--user-data DIR` | 指定 WeFlow profile；未指定使用 Windows `%APPDATA%/WeFlow-full` |
| `--data-dir DIR` | 指定此实例的 db_storage；未指定读取该 profile 的 backend/settings.json 选择；不确定时报 ACCOUNT_REQUIRED |
| `--mode live|snapshot` | 显式参数优先，其次保存值；没有保存值时 MCP 默认 live；不保存本次覆盖 |
| `--timezone IANA` | 输出业务时区；未指定使用系统 IANA 时区，无法识别时使用 UTC 并在 status 中说明 |

客户端配置示例：

```json
{
  "mcpServers": {
    "weflow": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\wechat\\tools\\WeFlow-full\\build\\mcp\\server.cjs", "--mode", "live"],
      "env": { "WEFLOW_BACKEND_ROOT": "D:\\wechat\\tools\\WeFlow-full\\python" }
    }
  }
}
```

`weflow-mcp.cmd --print-config` 生成当前环境可复制的绝对路径配置。源码版选择现有 Node/Electron，安装版使用包内 WeFlow.exe Node mode，并设置资源位置；配置没有数据库或媒体密钥。配置直接指定可执行文件与独立参数，避免 shell 引号拼接。Windows 路径含空格的实际配置必须联调验证。

服务应完成 MCP 连接与 tools/list，即使数据库尚未准备。首次业务请求懒连接；锁定/缺数据时返回结构化错误。整个运行过程不得自动创建 snapshot、扫描微信进程密钥、写源库或推进微信未读状态。

profile 锁配置使用现有 `WeFlow-config.json` 格式，复用 `isLockMode` 对 decryptKey、aiModelApiKey、aiModelProfilesJson 的 LOCK_PREFIX 判断，不假设存在 lockEnabled。实现将判断抽成小的纯函数并只读配置；禁止借用 ConfigService 的配置迁移/默认写入完成检查。缺配置视为尚未准备，损坏配置返回 PROFILE_CONFIG_INVALID。锁启用即返回 `PROFILE_LOCKED`。每次业务请求至少检查锁配置的修改状态；执行中发现锁启用或配置失效时中止后续读取并清理会话缓存。

## 2 通用参数与时间规则

所有工具 schema 使用明确对象与 `additionalProperties: false`。首次请求必须满足各工具必填项；续读只提交同工具的 `cursor`，不能同时改变会话、过滤或范围。缺省值只有首次请求时解析，续读不能重新计算 now。

时间范围为 `range: {start, end}`，均使用包含 UTC offset 的 RFC3339 字符串；语义是 `[start, end)`。日期或无 offset 字符串不接受，避免客户端与微信时区不同导致误查。到 Python 的秒级范围转换采用 `begin=ceil(startSeconds)`、`end=ceil(endSeconds)-1`；空区间直接返回空结果，不调用将 0 解释成无界的旧接口。

返回消息时间统一 RFC3339 UTC 字符串，响应提供业务 IANA timezone；日期桶按该 timezone 计算，处理 DST。不要复用按 Python 主机默认时区产生的 daily 计数作为任意时区结果。

预算统一：`limit` 1～200，`max_chars` 1,000～40,000，默认 12,000，find_chats 的条数上限另见工具表。字符以 Unicode code point 计，不在代理对中间切段；这不是 token 估算器。预算覆盖规范 JSON 文本（含名称映射、正文与 coverage）；二进制媒体使用独立大小预算。保留元数据空间后分配正文，超限不得删掉 coverage；必要元数据已超出调用方预算时返回 OUTPUT_BUDGET_TOO_SMALL 与所需最小预算。

默认最多 5 个 chat IDs、10 个上下文 message IDs。配置与错误返回不接受任意文件路径/SQL。后端源文件路径只通过服务内部数据发现确定。

## 3 固定工具列表与输入

工具顺序固定如下。描述简短说明用途、适用时机和分页要求，避免将整篇使用手册放进工具 schema。首版不提供 MCP prompt/resource 列表；get_media 直接使用内容块输出图片。

| 工具 | 首次请求核心参数 | 默认与限制 |
| --- | --- | --- |
| `get_status` | `{}` | 返回配置状态和最低限度能力，无自动准备 |
| `find_chats` | `query?: string`、`kind?: private|group|all`、`active_since?: timestamp`、`limit?`、`cursor?` | query 空值按最近活动浏览；默认 10 条，最多 50；仅 private/group，可无消息联系人作为明确候选 |
| `get_chat_overview` | `chat_ids`、`range`、`bucket?: day|week`、`max_chars?`、`cursor?` | 默认 day；超时或桶结果超预算时支持续读，计数标明累计与完成状态 |
| `read_messages` | `chat_ids`、`range?`、`after_message?: string`、`sender_ids?`、`types?`、`direction?: asc|desc`、`limit?`、`max_chars?`、`cursor?` | 默认最近 24 小时、asc、50 条；after_message 与 range 互斥且只用于单会话，从完整排序锚点严格向后读到固定 now |
| `search_messages` | `query: {terms: string[], operator?: any|all, fields?: SearchField[]}`、`chat_ids?`、`range`、`sender_ids?`、`mentions?: self|all|person_id`、`types?`、`limit?`、`max_chars?`、`cursor?` | terms 1～8 个非空字符串，默认 any、20 命中；chat_ids 未给时搜索本账号实际有消息的群聊/私聊 |
| `get_message_context` | `message_ids`、`before?`、`after?`、`include_replies?`、`reply_range?`、`format?: normalized|raw`、`max_chars?`、`cursor?` | 默认 before=5、after=10、include_replies=true；before/after 各 0～50；raw 仅按已知 ID取原格式，无全库导出 |
| `get_media` | `message_id`、`representation?: metadata|image|text`、`quality?: preview|original` | 默认 metadata；图片请求显式 representation=image；text 只返回已可验证的转写/解析结果 |

`types` 使用固定枚举 text、image、voice、video、file、link、quote、forwarded、location、system、other。`sender_ids` 与 mentions 的 person_id 使用工具返回的稳定身份，不能用展示昵称代替。

SearchField 为 text、quote、attachment_title；默认全部三种。terms 作为字面字符串，使用 Unicode NFC 归一化和固定大小写不敏感匹配，保留原文并映射命中位置；不接受正则、SQL 或嵌入式查询语言。任意自然语言问题不是首版语义检索参数。

`mentions` 仅过滤已解析到元数据 ID 的真实 @。未解析元数据标为 unknown；文本称呼仅作搜索命中，不满足真实 @过滤。@全体与明确 @本人分别表示。

## 4 统一响应形状

以下为应用数据结构。MCP 协议包装由官方 SDK 处理，不手写不同版本的握手/通知。

```ts
type ToolData = {
  schema_version: '1';
  success: boolean;
  account: { id: string; self_id: string | null } | null;
  timezone: string;
  data: Record<string, unknown>;
  coverage: Coverage | null;
  freshness: Freshness;
  warnings: Warning[];
  error: ToolError | null;
};

type Freshness = {
  mode: 'live' | 'snapshot' | 'unconnected';
  queried_at: string;
  connection_id: string | null;
  revision_start: number | null;
  revision_end: number | null;
  snapshot_id: string | null;
  captured_at: string | null;
  consistency: 'per_database' | 'fixed_snapshot' | 'unknown';
};

type Coverage = {
  requested_scope: Scope;
  progress: ChatProgress[];
  scope_progress: { selected_chats: number; completed_chats: number; remaining_chats: number };
  scan_complete: boolean;
  returned_count: number;
  has_more: boolean;
  next_cursor: string | null;
  truncated: boolean;
  omissions: Omission[];
  unresolved_content: UnresolvedSummary;
};
```

数据未连接时 account.id 可使用已选择的账号作用域，self_id 未确认则 null；账号未能选定的错误允许 account=null。输入验证失败可使用协议错误；连接/查询业务失败使用 `isError=true` 与 success=false 的同类应用错误对象。部分扫描正常返回 success=true、scan_complete=false、has_more=true，不用 isError 误导 Agent 丢弃已有结果。

每个工具定义 outputSchema。content 中只提供这一份数据的规范 JSON 文本，structuredContent 是同一对象；没有第二份长篇自然语言总结。图片读取可以额外提供 MCP image 内容块，JSON 中不再复制 Base64。[MCP 工具规范](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

`ChatProgress` 至少包含 chat_id、state=`not_started|scanning|complete|error`、scanned_count，以及已覆盖的实际排序区间。多个不连续窗口用 ranges 数组表示，不能用一个 min/max 声称中间都已扫描。requested_scope 包括原范围、过滤条件与账号，UI 名称不作为查询依据。显式选择最多 5 个会话时逐个返回 progress；全账号搜索用 scope_progress 计数并仅返回本页涉及的会话 progress，其他会话顺序留在 cursor，不把几百个未扫群名称塞进每次响应。

`unresolved_content` 按类型/原因汇总数量，并提供本页可定位的消息 ID 样本，注明样本是否完整，不额外引入一套引用分页工具。每条消息保留其媒体/解析状态，完整范围中的记录通过原 read_messages 分页取回；概览里的汇总不能代替原文读取。

## 5 各工具 data 字段

| 工具 | data 核心字段 |
| --- | --- |
| get_status | state、configured_account、self、mode_selection_source、capabilities、recovery_actions；不含密钥/绝对源路径 |
| find_chats | chats；每项 id、kind、display_name、remark/alias、match_basis、last_activity、has_local_messages；不返回完整成员名单 |
| get_chat_overview | chats；每群/人有 requested range、total、sent、received、unknown_sender、type_counts、buckets、local_history_bounds、counts_complete |
| read_messages | chats 名称映射、people 身份映射、messages |
| search_messages | 名称映射、hits；每项 message_id、chat_id、sender_id、sent_at、type、snippets、matched_fields/terms、context_anchor；match_mode=literal；total_hits 可为 null |
| get_message_context | 名称映射、messages、anchors、windows、unresolved_quotes、reply_search_scope、reply_search_complete；重叠窗口合并 |
| get_media | message_id、kind、availability、representation、mime_type、width/height、quality、transformed、source=local、reason、recovery_action；图片内容在 MCP image block |

概览续读返回本次查询的累计计数，`counts_complete` 与 coverage.scan_complete 同步；客户端按累计值替换，不能对重复续读再累加。日期桶超输出预算时仍需排页，并分清 counts_complete 与 has_more。

本机历史边界说明“可读取的本机数据”，不宣称等同于微信服务器全部历史。unknown_sender 不得并入本人或对方数量。

## 6 消息类型与稳定 ID

```ts
type NormalizedMessage = {
  id: string;
  chat_id: string;
  sender_id: string | null;
  is_self: boolean | null;
  sent_at: string;
  type: MessageType;
  text: string;
  text_complete: boolean;
  text_part: { offset: number; end: number; total: number } | null;
  content_status: 'parsed' | 'partial' | 'unparsed';
  mentions: { state: 'known' | 'unknown'; person_ids: string[]; everyone: boolean };
  quote: {
    target_id: string | null;
    sender_id: string | null;
    text: string | null;
    state: 'resolved' | 'snapshot_only' | 'unresolved';
  } | null;
  attachment: { kind: string; title?: string; url?: string; availability: string } | null;
  system_event: string | null;
};
```

ID 使用有版本前缀的 base64url 结构编码，内容为账号作用域、会话原始 ID 与可靠定位字段；base64 只是标识编码，不是加密或鉴权。用户无须解码，服务必须校验版本、账号和发现到的来源白名单，不将 ID 内的字符串直接拼成文件路径或 SQL。

账号作用域由稳定微信账号 ID 派生；chat/person ID 不依赖展示名。消息首选 server_id 字符串且非 0，否则使用相对分库/表/local_id/create_time 定位。必要时在 ID 中保留相对来源以精确取回，不包含绝对目录。相同 server ID 跨分库内容冲突沿用现有冲突错误，不选第一条掩盖冲突。

`server_id`、`local_id`、`sort_seq` 等原始大整数全链路保留精确值，超过 JS 安全整数时用字符串/BigInt 比较，禁止经过 Number 后再生成 ID。稳定排序依据已有 `(create_time, sort_seq, local_id, relative_db)`，多会话再增加 chat_id 作最终 tie-break。

normalized 格式保留原文措辞、否定、日期、数字、姓名与链接；不作情绪改写。forwarded 消息保留可解析标题和子记录引用，子记录超预算同样分段。解析失败提供有界原始内容和 unparsed 状态；format=raw 明确返回原格式，默认不重复原始 XML。

## 7 游标与扫描契约

外部 cursor 是随机有界内存 token，无业务可编辑字段。状态包含：工具及固定参数、账号和数据版本、每会话后端 cursor、pending 原始/规范记录、长正文偏移、概览累计值和未完成阶段。

建议空闲 TTL 10 分钟，最多 128 个 token/32 个活动查询、总正文缓冲不超过 16 MiB；满时回收最早闲置查询并关闭 Python cursor。上下文长结果同样走此预算，不新增磁盘聊天缓存。单个批次超过缓冲上限时减小后续批次并重试原确认位置；单条原始内容仍超上限则返回 RESOURCE_LIMIT 和消息锚点，不能假报读完或丢弃后继续。

续读原 token 必须可重放：同版本内重复调用返回同一页及同一个 next_cursor，不二次推进 Python 可变游标。第一次生成续页后缓存这页结果；分页仍有后续状态的记录不可单独被驱逐造成隐式跳页，回收要以整个查询为单位。版本变化时重放也返回 CURSOR_STALE，不假称当前数据仍一致。

每次原始 fetch 建议最多 100 条。批次已从 Python 取回但正文预算装不下的尾部保存在 pending；下次先输出 pending，不能直接拉新批次覆盖它。读完原始游标但 pending 或长文本还没输出时，scan_complete 可为 true，has_more 仍为 true。

阅读的 limit 计算本页消息条目，超长消息片段带相同 id 与递增 text_part。正文不能因过长永远卡在第一条；每页至少推进一个非空片段。coverage.truncated=true 并给续读方式，text_complete=false 不代表原文永久丢失。

查询范围内的数据版本固定；live 初次请求固定 now 上界并绑定 connection/revision，后续页不能延长 end。快照绑定已打开目录和 capturedAt 的身份，服务运行中不自动切换到后来新建的副本。

scan_complete 表示所有选定会话与原始范围已检查；has_more 表示还有未扫描、未输出或未完成的片段。搜索全扫零命中才是范围内零结果，时限内空结果且 has_more=true 是尚未检查完成。

## 8 查询与上下文算法

**定位**：联系人与实际会话合并，昵称/备注/别名/群名的精确匹配优先，部分匹配其次，同等级按最近活动和稳定 ID 排序。返回 match_basis；多个合理候选不自动读取其中一个。当前只有联系人而无消息时 has_local_messages=false。

**阅读**：按每群时间范围建立后端 cursor，使用有限 lookahead 合并各会话排序；sender/type 过滤后继续推进原始扫描；空过滤页允许有 next_cursor。全范围判定无任务的调用链不得只使用过滤结果替代原始范围阅读。

**搜索**：按规范化字段匹配 terms。hit 返回原文字段的短片段与偏移，不返回整个 XML；命中窗口可由 context 工具取回。全局搜索先按会话最近活动确定扫描顺序，响应声明 order=chat_activity_then_message_time，不假称全局相关性排序；显式多群阅读仍按消息时间归并。扫描未开始的会话保留在 progress，续扫不重新从第一个群开始。

**概览**：批量累加原始行的日期/方向/类型；只有确认完整扫描才标 counts_complete。引用、图片正文等无需为计数深度解析。缓存按账号、完整范围、timezone、mode 和 revision/snapshot 身份隔离；只缓存已完整的结果。

**上下文**：先精确定位 anchor，独立向前/向后读 before/after 条邻居，合并重叠窗口；发送者过滤不能切掉邻居。引用原文按 target ID 独立定位，位于窗口外时标出其角色和时间，不伪装成邻居。

include_replies 默认只检查已取窗口中的直接引用回复；用户给 reply_range 时才扫描那个额外范围。返回实际 reply_search_scope 和完成状态。普通“嗯”“好的”没有可靠引用关系时仍作为附近消息返回，但不得构建成确定性回复边。找不到原始引用只保留引用快照，并标 snapshot_only。

同一 anchor 不存在返回锚点级 MESSAGE_NOT_FOUND，其他锚点仍可返回；该响应包含 warnings 和失败锚点。全体锚点都无法读取时返回业务错误。原始修改/删除与缺库不可用不能都误标为“消息已撤回”。

## 9 最小后端扩展

MCP 不直接访问数据库文件，也不暴露内部 execQuery。以下是拟新增内部 RPC：

| 方法 | 核心输入与行为 |
| --- | --- |
| `openPreparedData` | `{accountDir, mode}`；live 复用 _open_live；snapshot 只 read_active 并检查完整性，不 createSnapshot/ensure_snapshot；返回 connection 状态与 capturedAt |
| `getPreparedSelection` | 只读返回此 profile 的已保存账号/模式和可发现候选；不 StateStore.select、不扫描密钥 |
| `getMessageByLocator` | `{sessionId, serverId? 或 relativeDb/table/localId/createTime}`；发现白名单内参数化查询；返回精确原始行与 source tuple；不沿用仅 localId 找第一条的旧方法 |
| `openMessageCursorAround` | `{sessionId, anchorLocator, direction, batchSize}`；使用完整排序 tuple 严格读取邻居；跨分库归并和 dedup 沿用已有逻辑 |
| `getCachedImageKeys` | 仅读取并验证已有 DPAPI 图片缓存，不调用 acquire 的扫描分支；缺失返回 IMAGE_KEY_REQUIRED，密钥只在内部 RPC 中流转 |

现有 `openMessageCursor / fetchMessageBatch / closeMessageCursor` 继续用于时间范围扫描，所有新方法保持旧 GUI/CLI 接口行为。新 locator/around RPC 同样进行 live 版本核对、deadline/取消检查与短事务释放。

给内部 openMessageCursor 增加可选 afterPosition 完整排序 tuple，用于从服务端已确认的原始扫描位置重建读取，旧调用默认行为不变。确认位置是最后一条原始已处理行，可能不是最后一个匹配/输出消息。RPC 失败或取消后丢弃可能已被推进的 Python cursor，版本一致时从该确认位置重建；不能继续使用进度未知的可变 cursor。

`LocalBackendClient.call` 增加可选 timeoutMs 与 AbortSignal 或等价选项。MCP RPC 执行期限一般 2 秒，传输等待期限留余量约 4 秒；整个扫描工具约 5 秒，期限到前在批次边界暂停并返回续读。某次 RPC 被引擎中断而未返回完整批次时视为失败，不更新扫描游标；版本仍一致才能从上一已确认位置重试。

连接初始化与图片转换分别使用独立期限：初始化建议 10 秒执行/15 秒传输；HEIC 沿用已有限制，最长 60 秒，并支持取消。普通工具的 5 秒扫描期限不能被错误套到初始化或图片转换。客户端断连时先取消当前请求，再关闭自己创建的 Python/Worker；宽限后才终止这些自有进程。

Python 普通请求仍串行，取消通过其输入线程立即置标记。客户端取消排队中请求时移出队列，取消运行中请求时写目标 requestId。取消状态不生成虚假的 complete 或新的已检查基线。

## 10 live 变化与错误恢复

每次 query/fetch 开始及结束核对状态；TS 收到 account-level change 立即使相关活动查询失效。当前后端是账号级 revision，因此首版不承诺会话级精细失效。新 connectionId 使旧 cursor 全部失效；revision 不跨连接比较。

错误形状：`{code, message, retryable, action, recovery?}`。recovery 可以包含原 range、chat IDs 和最后已确认消息锚点，不含 Token/密钥/绝对路径。涉及历史补入/修改时建议重读原范围或对应完整窗口；不能只从最后时间继续就声称无遗漏。

| 错误 | Agent 下一步 |
| --- | --- |
| ACCOUNT_REQUIRED / CHAT_AMBIGUOUS | 明确账号或从 find_chats 候选确定会话 |
| PROFILE_LOCKED / PROFILE_CONFIG_INVALID | 使用可正常读取的已准备 profile 或修复配置，查询不绕过规则 |
| KEY_NOT_FOUND / SNAPSHOT_REQUIRED | 通过既有 WeFlow 准备入口补齐；MCP 不自动准备 |
| LIVE_BUSY | 有界重试；仍失败说明暂不可用 |
| LIVE_READ_TIMEOUT | 缩小范围或恢复上一确认批次；不能断言零结果 |
| CURSOR_STALE / SOURCE_REPLACED | 重读原范围并按稳定 ID 去重 |
| CURSOR_EXPIRED / CURSOR_INVALID | 使用错误提供的原范围重开查询；不同工具不能共用 cursor |
| MESSAGE_NOT_FOUND / MESSAGE_CONFLICT | 说明具体锚点缺失或冲突，不猜测内容 |
| OUTPUT_BUDGET_TOO_SMALL / RESOURCE_LIMIT | 增加输出预算或减小读取批次/范围；原消息锚点保留，不能当作已读完 |
| CANCELLED | 结束当前请求，不推进业务基线 |

## 11 媒体规格

get_media 首版只读取本机下载文件与已缓存可验证文本。默认 metadata 不读大附件。representation=image 支持能独立解密的本机图片及 HEIC 转换；其他格式未经验证返回 unsupported_format。

availability 使用 `available|not_downloaded|key_required|unsupported|decode_failed|too_large`。基础消息始终保留媒体占位及 message_id；不能把“图片读不到”当成整个聊天不存在。

preview 建议最长边 1600 像素、图像内容最多 4 MiB；原图请求上限暂定 10 MiB，超过返回 too_large 与可用 preview 描述。变换只影响输出表示，返回 width/height 和 transformed；原文件不改写。截图任务读取原始清晰度的必要性由 Agent 判断，不将 preview 当作已完成 OCR。

语音文本注明 transcript_source、是否 complete；没有已验证转写返回 unsupported 或 not_available 的明确 reason。此版本不新增转写/OCR 模型，也不联网下载微信附件。

图片密钥通过内部缓存方法读取，不向工具结果或日志透出。附件路径由消息来源与 hardlink 索引确定，工具不接受用户任意 path。

## 12 构建与交付规格

新增 npm 脚本 `build:mcp` 与 `typecheck:mcp`，独立 tsconfig，仅编译 MCP 与共享模块，不为了启动 MCP 构建 GUI 或启动开发服务器。构建复用已有 Vite 的库构建能力并使用独立配置，生成 CJS 入口；不新增另一套打包框架。依赖采用官方 TypeScript MCP SDK 与现有 Zod，版本固定在 lockfile，实际 SDK API 按选择的稳定版本编写。[官方 TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/)

`build:mcp` 输出 server.cjs 与必要媒体 Worker/资产到 build/mcp。安装构建将其复制到 resources/mcp，并将 weflow-mcp.cmd 放到安装根目录；Python 后端继续使用已有冻结包。

源码脚本在环境缺失时将准备命令写 stderr 并退出，不自行下载安装环境污染 MCP 生命周期。环境准备是连接前的独立步骤。安装版使用包内 Electron 的 Node mode，验证 fuse/stdio/依赖后确定；若不支持则包内放独立 Node，不要求用户安装。

构建产物、媒体缓冲和真实聊天 fixture 不提交源码。协议 stdout 上不得出现启动提示、console.log 或 Python 内部事件；日志与诊断写 stderr。退出码非 0 用于启动失败，业务失败通过 MCP 工具结果返回。

## 13 必要验收

| 编号 | 要求与通过标准 |
| --- | --- |
| S1 | 未准备数据库仍能建立 MCP 连接、列出 7 个工具，status 给恢复动作；snapshot 缺失与图片密钥缺失均不触发扫描/创建 |
| S2 | 同名群/备注定位返回依据；未知群成员/@元数据不编造身份 |
| S3 | 同秒、跨库、超过 JS 安全整数和进程重启后按消息 ID精确取回；冲突不被吞掉 |
| S4 | 超长文本分段与取回批次尾部可读完；重复 cursor 重放不跳页；元数据/正文预算都受限 |
| S5 | 多群、过滤零结果和扫描超时明确每群完成状态；搜索 raw XML 不产生伪正文命中 |
| S6 | 邻居/引用/范围内回复合并去重；缺引用原文时快照状态正确；时区、边界和 DST 可核对 |
| S7 | live 变更使旧页失效并给恢复范围，取消不被串行长请求阻塞，snapshot 不自动切换 |
| S8 | 工作群前页任务后页取消、无 @指派及媒体缺口场景给 Agent 正确材料；关系场景保留反例和连续对话 |
| S9 | GUI 关闭的源码版与无外置 Node/Python 的安装版都能联调；profile 锁与协议 stdout 行为一致 |
| S10 | 目标客户端可呈现图片、结构化结果和续读错误；记录基础定位/阅读/搜索耗时及相同场景上下文成本 |

上述主要使用合成 fixture 和客户端端到端检查，已有后端回归确认接口兼容。实际通过项与验证边界见 [实现验证记录](mcp-validation.md)。

## 14 与 PRD 的细化关系

保留 PRD 的 7 个工具和两个主场景。新增细化：overview 支持续读；搜索 query 是明确字面 terms；context 的直接回复只有已扫描窗口/显式 reply_range；媒体首次默认只取 metadata；默认时间/模式和 cursor 重放明确化。

这些变化用于使需求可实施，不扩大到消息发送、自动任务系统或长期监控。后续如将语音/OCR 提升为首版需求，须同时修改 media 能力与对应验收，不能仅改工具描述。
