import { TOOL_DEFINITIONS, type ToolData } from './contracts'
import { attachCursorInvalidation, clearCursors, findChats, getChatOverview, getMessageContext, getStatus, readMessages, searchMessages } from './query'
import type { McpRuntime } from './runtime'
import { personId } from '../shared/chat/ids'
import { exportMessages, type ExportProgress } from './export'

export type CallToolResult = { content: Array<Record<string, unknown>>; structuredContent: Record<string, unknown>; isError?: boolean }

function result(data: ToolData, extra: Array<Record<string, unknown>> = []): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }, ...extra],
    structuredContent: data as unknown as Record<string, unknown>,
    ...(data.success ? {} : { isError: true }),
  }
}
function validObject(args: unknown): args is Record<string, any> {
  return !!args && typeof args === 'object' && !Array.isArray(args)
}
function validate(value: any, schema: any, path = 'arguments'): string | null {
  if (!schema || typeof schema !== 'object') return null
  if (schema.oneOf || schema.anyOf) {
    const choices = schema.oneOf || schema.anyOf
    if (!choices.some((choice: any) => validate(value, choice, path) === null)) return `${path} 格式无效。`
    return null
  }
  const type = schema.type
  if (type === 'object') {
    if (!validObject(value)) return `${path} 必须是对象。`
    for (const key of schema.required || []) if (!(key in value)) return `${path}.${key} 为必填项。`
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in (schema.properties || {}))) return `${path}.${key} 不受支持。`
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in value) { const error = validate(value[key], child, `${path}.${key}`); if (error) return error }
  } else if (type === 'array') {
    if (!Array.isArray(value)) return `${path} 必须是数组。`
    if (schema.minItems != null && value.length < schema.minItems) return `${path} 项数过少。`
    if (schema.maxItems != null && value.length > schema.maxItems) return `${path} 项数过多。`
    for (let i = 0; i < value.length; i++) { const error = validate(value[i], schema.items, `${path}[${i}]`); if (error) return error }
  } else if (type === 'string') {
    if (typeof value !== 'string') return `${path} 必须是字符串。`
    if (schema.minLength != null && value.length < schema.minLength) return `${path} 不能为空。`
    if (schema.format === 'date-time' && !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return `${path} 必须是带 UTC offset 的 RFC3339 时间。`
  } else if (type === 'integer') {
    if (!Number.isInteger(value)) return `${path} 必须是整数。`
    if (schema.minimum != null && value < schema.minimum || schema.maximum != null && value > schema.maximum) return `${path} 超出允许范围。`
  } else if (type === 'boolean' && typeof value !== 'boolean') return `${path} 必须是布尔值。`
  if (schema.enum && !schema.enum.includes(value)) return `${path} 值无效。`
  return null
}
function failData(runtime: McpRuntime, error: any): ToolData {
  return {
    schema_version: '1', success: false, account: null, timezone: runtime.timezone,
    data: {}, coverage: null,
    freshness: { mode: 'unconnected', queried_at: new Date().toISOString(), connection_id: null, revision_start: null, revision_end: null, snapshot_id: null, captured_at: null, consistency: 'unknown' },
    warnings: [], error: { code: error?.code || 'QUERY_FAILED', message: String(error?.message || error), retryable: !!error?.retryable, action: error?.action || '稍后重试。' },
  }
}

export function createTools(runtime: McpRuntime): { call(name: string, args: unknown, signal?: AbortSignal, onProgress?: ExportProgress): Promise<CallToolResult>; close(): Promise<void> } {
  attachCursorInvalidation(runtime)
  const definitions = new Map<string, (typeof TOOL_DEFINITIONS)[number]>(TOOL_DEFINITIONS.map(d => [d.name, d]))
  return {
    async call(name, args, signal, onProgress) {
      if (!definitions.has(name)) return result(failData(runtime, Object.assign(new Error(`未知工具：${name}`), { code: 'UNKNOWN_TOOL' })))
      if (!validObject(args)) return result(failData(runtime, Object.assign(new Error('工具参数必须是 JSON 对象。'), { code: 'INVALID_ARGUMENT' })))
      const schemaError = validate(args, (definitions.get(name) as any).inputSchema)
      if (schemaError) return result(failData(runtime, Object.assign(new Error(schemaError), { code: 'INVALID_ARGUMENT' })))
      try {
        let data: ToolData
        switch (name) {
          case 'get_status': data = await getStatus(runtime, signal); break
          case 'find_chats': data = await findChats(runtime, args, signal); break
          case 'get_chat_overview': data = await getChatOverview(runtime, args, signal); break
          case 'read_messages': data = await readMessages(runtime, args, signal); break
          case 'search_messages': data = await searchMessages(runtime, args, signal); break
          case 'get_message_context': data = await getMessageContext(runtime, args, signal); break
          case 'export_messages': {
            data = await exportMessages(runtime, args, runtime.options.userData, signal, onProgress)
            const files = data.data.files as Record<string, { uri: string; mime_type: string; bytes: number }> | undefined
            return result(data, Object.entries(files || {}).map(([name, file]) => ({
              type: 'resource_link', uri: file.uri, name, mimeType: file.mime_type, size: file.bytes,
              description: '服务端本机导出文件；完整性见 manifest.json。',
            })))
          }
          case 'get_media': {
            const media = await import('./media')
            const output = await media.readMedia(runtime, args.message_id, args, signal)
            const [connection, freshness] = await Promise.all([runtime.ensureConnected(signal), runtime.getFreshness(signal)])
            const mediaData: ToolData = { schema_version: '1', success: true,
              account: { id: connection.accountScope, self_id: personId(connection.accountScope, connection.accountId) }, timezone: runtime.timezone,
              data: output.data, coverage: null, freshness, warnings: [], error: null }
            return result(mediaData, output.content || [])
          }
          default: return result(failData(runtime, Object.assign(new Error(`未知工具：${name}`), { code: 'UNKNOWN_TOOL' })))
        }
        return result(data)
      } catch (e) { return result(failData(runtime, e)) }
    },
    async close() { clearCursors(); await runtime.close() },
  }
}
