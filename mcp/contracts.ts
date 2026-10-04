export type JsonSchema = Record<string, unknown>

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object', properties, required, additionalProperties: false,
})
const str = { type: 'string' } as const
const int = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum })
const range = obj({ start: { type: 'string', format: 'date-time' }, end: { type: 'string', format: 'date-time' } }, ['start', 'end'])
const cursor = { cursor: { type: 'string', minLength: 1 } }
export const READ_DEFAULT_LIMIT = 500
export const READ_DEFAULT_MAX_CHARS = 120_000
export const READ_MAX_LIMIT = 10_000
export const READ_MAX_CHARS = 2_000_000
const messageTypes = { type: 'array', items: { type: 'string', enum: ['text','image','voice','video','file','link','quote','forwarded','location','system','other'] } }
const paged = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => {
  const { cursor: cursorProperty, ...firstProperties } = properties
  return { type: 'object', properties, additionalProperties: false, oneOf: [obj(firstProperties, required), obj({ cursor: cursorProperty || cursor.cursor }, ['cursor'])] }
}
const outputSchema: JsonSchema = {
  type: 'object', required: ['schema_version', 'success', 'account', 'timezone', 'data', 'coverage', 'freshness', 'warnings', 'error'],
  properties: {
    schema_version: { const: '1' }, success: { type: 'boolean' }, account: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    timezone: str, data: { type: 'object' }, coverage: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    freshness: { type: 'object' }, warnings: { type: 'array', items: { type: 'object' } },
    error: { anyOf: [{ type: 'object' }, { type: 'null' }] },
  }, additionalProperties: false,
}

export const TOOL_DEFINITIONS = [
  { name: 'get_status', description: '查看 WeFlow 本机数据连接与准备状态。', inputSchema: obj({}), outputSchema },
  { name: 'find_chats', description: '按名称查找联系人或群聊；空 query 按最近活动浏览，支持 cursor 续读。', inputSchema: paged({ query: str, kind: { type: 'string', enum: ['private', 'group', 'all'] }, active_since: { type: 'string', format: 'date-time' }, limit: int(1, 50), ...cursor }) , outputSchema },
  { name: 'get_chat_overview', description: '统计指定会话在时间范围内的消息与日期桶；可用 cursor 续读。', inputSchema: paged({ chat_ids: { type: 'array', minItems: 1, maxItems: 5, items: str }, range, bucket: { type: 'string', enum: ['day', 'week'] }, max_chars: int(1000, 40000), ...cursor }, ['chat_ids', 'range']), outputSchema },
  { name: 'read_messages', description: '成批读取连续原文。默认 500 条/120000 字符；format=compact 用带列名的消息数组减少重复字段，normalized 保留完整对象。Agent 可按自己的上下文选择更大 limit/max_chars；cursor 续读沿用格式与预算。上万条记录且可读本机文件时可用 export_messages。', inputSchema: paged({ chat_ids: { type: 'array', minItems: 1, maxItems: 5, items: str }, range, after_message: str, sender_ids: { type: 'array', items: str, maxItems: 100 }, types: messageTypes, direction: { type: 'string', enum: ['asc', 'desc'] }, format: { type: 'string', enum: ['normalized', 'compact'] }, limit: int(1, READ_MAX_LIMIT), max_chars: int(1000, READ_MAX_CHARS), ...cursor }, ['chat_ids']), outputSchema },
  { name: 'search_messages', description: '在消息正文、引用和附件标题中按字面 terms 搜索；支持 cursor 续读。', inputSchema: paged({ query: obj({ terms: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1 } }, operator: { type: 'string', enum: ['any','all'] }, fields: { type: 'array', items: { type: 'string', enum: ['text','quote','attachment_title'] } } }, ['terms']), chat_ids: { type: 'array', minItems: 1, maxItems: 5, items: str }, range, sender_ids: { type: 'array', items: str, maxItems: 100 }, mentions: { oneOf: [{ type: 'string', enum: ['self','all'] }, obj({ person_id: str }, ['person_id'])] }, types: { type: 'array', items: { type: 'string', enum: ['text','image','voice','video','file','link','quote','forwarded','location','system','other'] } }, limit: int(1, 200), max_chars: int(1000, 40000), ...cursor }, ['query', 'range']), outputSchema },
  { name: 'get_message_context', description: '读取指定消息及其前后邻居和可确认引用；长结果支持 cursor 续读。', inputSchema: paged({ message_ids: { type: 'array', minItems: 1, maxItems: 10, items: str }, before: int(0, 50), after: int(0, 50), include_replies: { type: 'boolean' }, reply_range: range, format: { type: 'string', enum: ['normalized','raw'] }, max_chars: int(1000, 40000), ...cursor }, ['message_ids']), outputSchema },
  { name: 'get_media', description: '读取消息的本机媒体状态；仅显式 image 请求返回图片内容。', inputSchema: obj({ message_id: str, representation: { type: 'string', enum: ['metadata','image','text'] }, quality: { type: 'string', enum: ['preview','original'] } }, ['message_id']), outputSchema },
  { name: 'export_messages', description: '将指定范围全部原文连续导出为 messages.jsonl、transcript.txt 和 manifest.json，不受单页字符或条数预算限制。返回服务端本机绝对路径，适合能读取本机文件/执行代码的 Agent；自行选择范围、过滤和后续阅读方式。output_dir 可指定绝对输出目录，每次创建独立子目录。完成导出表示材料已取得；理解与分析由 Agent 完成。', inputSchema: obj({ chat_ids: { type: 'array', minItems: 1, maxItems: 5, items: str }, range, sender_ids: { type: 'array', items: str, maxItems: 100 }, types: messageTypes, direction: { type: 'string', enum: ['asc', 'desc'] }, output_dir: { type: 'string', minLength: 1 } }, ['chat_ids', 'range']), outputSchema },
] as const

export type ToolName = typeof TOOL_DEFINITIONS[number]['name']
export type Freshness = {
  mode: 'live' | 'snapshot' | 'unconnected'; queried_at: string; connection_id: string | null;
  revision_start: number | null; revision_end: number | null; snapshot_id: string | null;
  captured_at: string | null; consistency: 'per_database' | 'fixed_snapshot' | 'unknown'
}
export type ToolError = { code: string; message: string; retryable: boolean; action: string; recovery?: Record<string, unknown> }
export type Coverage = {
  requested_scope: Record<string, unknown>; progress: Array<Record<string, unknown>>;
  progress_complete?: boolean;
  scope_progress: { selected_chats: number; completed_chats: number; remaining_chats: number };
  scan_complete: boolean; returned_count: number; has_more: boolean; next_cursor: string | null;
  truncated: boolean; omissions: Array<Record<string, unknown>>; unresolved_content: Record<string, unknown>
}
export type ToolData = {
  schema_version: '1'; success: boolean; account: { id: string; self_id: string | null } | null;
  timezone: string; data: Record<string, unknown>; coverage: Coverage | null; freshness: Freshness;
  warnings: Array<Record<string, unknown>>; error: ToolError | null
}
