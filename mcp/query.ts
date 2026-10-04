import { CursorStore } from './cursors'
import { chatId, decodeChatId, decodeMessageId, personId } from '../shared/chat/ids'
import { normalizeMessage } from '../shared/chat/normalize'
import { mapRowsToMessagesLite } from '../shared/chat/decode'
import { hydrateNames } from './names'
import type { Coverage, Freshness, ToolData } from './contracts'

type Runtime = {
  timezone: string
  ensureConnected(signal?: AbortSignal): Promise<{ accountId: string; accountScope: string; dataDir: string; mode: 'live'|'snapshot'; capturedAt?: string|null; snapshotId?: string|null }>
  call(method: string, payload?: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<any>
  getFreshness(signal?: AbortSignal): Promise<Freshness>
  getStatus(signal?: AbortSignal): Promise<any>
  onInvalidate?(listener: () => void): () => void
}

type ScanChat = { id: string; sessionId: string; cursor: number | null; done: boolean; scanned: number; pending: any[]; ranges: Array<{ start: string; end: string }>; lastPosition?: unknown }
type UnresolvedContent = { by_type: Record<string, number>; samples: string[]; count: number }
type ScanState = { tool: string; scope: Record<string, unknown>; chats: ScanChat[]; pending: any[]; returned: any[]; returnedCount: number; openedAt: string; end: string; filters: Record<string, any>; stats: Record<string, any>; unresolvedContent: UnresolvedContent }
const cursors = new CursorStore()
const activeByRuntime = new WeakMap<object, () => void>()
export function attachCursorInvalidation(runtime: Runtime): void {
  if (activeByRuntime.has(runtime as object)) return
  const unsubscribe = runtime.onInvalidate?.(() => cursors.invalidate())
  if (unsubscribe) activeByRuntime.set(runtime as object, unsubscribe)
}
export function clearCursors(): void { cursors.clear() }

const isoNow = () => new Date().toISOString()
function fail(code: string, message: string, retryable = false, action = '检查参数后重试。'): Error & { code: string; retryable: boolean; action: string } {
  return Object.assign(new Error(message), { code, retryable, action })
}
function errorInfo(e: any) { return { code: e?.code || 'QUERY_FAILED', message: String(e?.message || e), retryable: !!e?.retryable, action: e?.action || '稍后重试。', ...(e?.recovery && { recovery: e.recovery }) } }
function emptyUnresolved(): UnresolvedContent { return { by_type: {}, samples: [], count: 0 } }
function unresolvedReason(message: any): string | null {
  if (message.content_status === 'unparsed') return 'unparsed'
  if (message.content_status === 'partial') return 'partial'
  if (message.attachment && message.attachment.availability !== 'available') return `${message.type}:${message.attachment.availability}`
  if (message.quote?.state === 'unresolved' || message.quote?.state === 'snapshot_only') return `quote:${message.quote.state}`
  return null
}
function addUnresolved(summary: UnresolvedContent, message: any): void {
  const reason = unresolvedReason(message)
  if (!reason) return
  summary.count++
  summary.by_type[reason] = (summary.by_type[reason] || 0) + 1
  if (summary.samples.length < 20) summary.samples.push(message.id)
}
function summarizeUnresolved(messages: any[]): UnresolvedContent {
  const summary = emptyUnresolved()
  for (const message of messages) addUnresolved(summary, message)
  return summary
}
function makeCoverage(scope: Record<string, unknown>, chats: ScanChat[], returnedCount: number, complete: boolean, next: string | null, truncated = false, messages: any[] = [], unresolved = summarizeUnresolved(messages)): Coverage {
  const done = chats.filter(c => c.done && !c.pending.length).length
  const visibleProgress = chats.slice(0, 10).map(c => ({ chat_id: c.id, state: c.done && !c.pending.length ? 'complete' : c.cursor === null && c.scanned === 0 ? 'not_started' : 'scanning', scanned_count: c.scanned, ranges: c.ranges }))
  return { requested_scope: scope, progress: visibleProgress, progress_complete: chats.length <= visibleProgress.length, scope_progress: { selected_chats: chats.length, completed_chats: done, remaining_chats: chats.length - done }, scan_complete: complete, returned_count: returnedCount, has_more: !!next, next_cursor: next, truncated, omissions: [], unresolved_content: { by_type: unresolved.by_type, samples: unresolved.samples, samples_complete: unresolved.count <= unresolved.samples.length } }
}
function dataResult(runtime: Runtime, conn: Awaited<ReturnType<Runtime['ensureConnected']>>, freshness: Freshness, data: Record<string, unknown>, coverage: Coverage | null, returned: number, success = true, error: any = null): ToolData {
  return { schema_version: '1', success, account: { id: conn.accountScope, self_id: personId(conn.accountScope, conn.accountId) }, timezone: runtime.timezone, data, coverage, freshness, warnings: [], error: error ? errorInfo(error) : null }
}
function fitContextOutput(messages: any[], state: any, maxChars: number, build: (items: any[], hasMore: boolean, truncated: boolean) => ToolData): ToolData {
  let truncated = false
  let output = build(messages, state.remaining.length > 0, truncated)
  while (Array.from(JSON.stringify(output)).length > maxChars && messages.length) {
    const index = messages.length - 1, last = messages[index], chars = codePoints(last.text || '')
    const field = last.raw !== undefined ? 'raw' : 'text'
    const value = String(last[field] || '')
    const valueChars = field === 'text' ? chars : codePoints(value)
    if (valueChars.length > 1) {
      const over = Array.from(JSON.stringify(output)).length - maxChars + 24
      if (over < valueChars.length) {
        const keep = Math.max(1, valueChars.length - over)
        if (field === 'text') {
          const offset = last.text_part?.offset || 0, total = last.text_part?.total || valueChars.length
          messages[index] = { ...last, text: valueChars.slice(0, keep).join(''), text_complete: false, text_part: { offset, end: offset + keep, total } }
          state.remaining.unshift({ ...last, text: valueChars.slice(keep).join(''), text_complete: false, text_part: { offset: offset + keep, end: total, total } })
        } else {
          const offset = last.raw_part?.offset || 0, total = last.raw_part?.total || valueChars.length
          messages[index] = { ...last, raw: valueChars.slice(0, keep).join(''), raw_part: { offset, end: offset + keep, total } }
          state.remaining.unshift({ ...last, raw: valueChars.slice(keep).join(''), raw_part: { offset: offset + keep, end: total, total } })
        }
      } else state.remaining.unshift(messages.splice(index, 1)[0])
    } else state.remaining.unshift(messages.splice(index, 1)[0])
    truncated = true
    output = build(messages, state.remaining.length > 0, truncated)
  }
  if (messages.length === 0 && state.remaining.length > 0) throw fail('OUTPUT_BUDGET_TOO_SMALL', 'max_chars 不足以容纳一条上下文消息。', false, '请提高 max_chars 后续读。')
  if (Array.from(JSON.stringify(output)).length > maxChars) throw fail('OUTPUT_BUDGET_TOO_SMALL', 'max_chars 不足以容纳上下文元数据。', false, '请将 max_chars 提高后重开或续读。')
  return output
}
function stamp(date: Date): string { return date.toISOString() }
function timeRange(range: any, now: Date): { start: string; end: string; begin: number; finish: number } {
  const end = range ? strictTime(range.end) : now
  const start = range ? strictTime(range.start) : new Date(end.getTime() - 24 * 3600_000)
  if (start > end) throw fail('INVALID_RANGE', 'range.start 必须早于或等于 range.end。')
  const s = Math.ceil(start.getTime() / 1000), e = Math.ceil(end.getTime() / 1000)
  return { start: stamp(start), end: stamp(end), begin: s, finish: e - 1 }
}
function strictTime(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw fail('INVALID_TIME', '时间必须是带 UTC offset 的 RFC3339 字符串。')
  const d = new Date(value); if (!Number.isFinite(d.getTime())) throw fail('INVALID_TIME', '时间格式无效。'); return d
}
function checkCursorArgs(args: any): void {
  if (Object.prototype.hasOwnProperty.call(args, 'cursor') && Object.keys(args).some(k => k !== 'cursor')) throw fail('INVALID_ARGUMENT', '续读时只能提交 cursor。')
  if (Object.prototype.hasOwnProperty.call(args, 'cursor') && (typeof args.cursor !== 'string' || !args.cursor)) throw fail('INVALID_ARGUMENT', 'cursor 必须是非空字符串。')
}
function idSessions(conn: Awaited<ReturnType<Runtime['ensureConnected']>>, ids: string[]): Array<{ id: string; sessionId: string }> {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5) throw fail('INVALID_ARGUMENT', 'chat_ids 必须包含 1 到 5 个会话。')
  return ids.map(id => ({ id, sessionId: decodeChatId(id, conn.accountScope) }))
}
async function createScans(runtime: Runtime, conn: Awaited<ReturnType<Runtime['ensureConnected']>>, chats: Array<{id:string;sessionId:string}>, tool: string, scope: Record<string, unknown>, range: ReturnType<typeof timeRange>, filters: Record<string, any>): Promise<ScanState> {
  return { tool, scope, chats: chats.map(c => ({ ...c, cursor: null, done: false, scanned: 0, pending: [], ranges: [] })), pending: [], returned: [], returnedCount: 0, openedAt: range.start, end: range.end, filters: { ...filters, timezone: runtime.timezone }, stats: {}, unresolvedContent: emptyUnresolved() }
}
async function getRawBatch(runtime: Runtime, scan: ScanChat, state: ScanState, signal?: AbortSignal): Promise<void> {
  if (scan.done) return
  if (state.filters.finish < state.filters.begin) { scan.done = true; return }
  if (scan.cursor === null) {
    let afterPosition: unknown = state.filters.afterMessage?.sessionId === scan.sessionId ? state.filters.afterPosition : undefined
    if (state.filters.afterMessage?.sessionId === scan.sessionId) {
      if (!afterPosition) {
        const found = await runtime.call('getMessageByLocator', { sessionId: scan.sessionId, locator: state.filters.afterMessage.locator }, signal, 2000)
        const row = found?.message ?? found?.data?.message
        if (!found?.success || !row) throw fail('MESSAGE_NOT_FOUND', 'after_message 锚点无法定位。', false, '从 find_chats 选择会话后重新读取范围。')
        afterPosition = [row.create_time ?? row.createTime, row.sort_seq ?? row.sortSeq ?? 0, row.local_id ?? row.localId ?? 0, row._relative_db ?? '']
      }
    }
    const opened = await runtime.call('openMessageCursor', { sessionId: scan.sessionId, batchSize: 100, ascending: state.filters.direction !== 'desc', beginTimestamp: state.filters.begin, endTimestamp: state.filters.finish, ...(afterPosition ? { afterPosition } : {}) }, signal, 2000)
    if (!opened?.success) throw fail('READ_FAILED', opened?.error || '无法打开消息游标。', true)
    scan.cursor = opened.cursor
  }
  const batch = await runtime.call('fetchMessageBatch', { cursor: scan.cursor }, signal, 2000)
  if (!batch?.success) throw fail('READ_FAILED', batch?.error || '读取消息批次失败。', true)
  const rows = Array.isArray(batch.rows) ? batch.rows : []
  for (const row of rows) {
    scan.scanned++
    const message = normalizeMessage(row, { accountId: (state as any).accountId, accountScope: (state as any).accountScope, sessionId: scan.sessionId })
    addUnresolved(state.unresolvedContent, message)
    scan.pending.push(message)
    if (scan.ranges.length) scan.ranges[scan.ranges.length - 1].end = message.sent_at
    else scan.ranges.push({ start: message.sent_at, end: message.sent_at })
    if (state.tool === 'get_chat_overview') {
      const date = formatBucket(new Date(message.sent_at), state.filters.timezone || 'UTC', state.filters.bucket || 'day')
      const key = `${message.chat_id}|${date}`
      const aggregate = state.stats[key] || { chat_id: message.chat_id, start: date, total: 0, sent: 0, received: 0, unknown_sender: 0, type_counts: {} }
      aggregate.total++
      if (message.is_self === true) aggregate.sent++; else if (message.is_self === false) aggregate.received++; else aggregate.unknown_sender++
      aggregate.type_counts[message.type] = (aggregate.type_counts[message.type] || 0) + 1
      state.stats[key] = aggregate
    }
  }
  if (!batch.hasMore) scan.done = true
}
function passFilter(message: any, filters: Record<string, any>, scope: string): boolean {
  if (filters.sender_ids?.length && !filters.sender_ids.includes(message.sender_id)) return false
  if (filters.types?.length && !filters.types.includes(message.type)) return false
  if (filters.mentions) {
    if (filters.mentions === 'self' && !(message.mentions.person_ids || []).includes(filters.selfId)) return false
    if (filters.mentions === 'all' && !message.mentions.everyone) return false
    if (typeof filters.mentions === 'object' && !(message.mentions.person_ids || []).includes(filters.mentions.person_id)) return false
  }
  return true
}
function codePoints(s: string): string[] { return Array.from(s) }
function unresolvedQuotes(messages: any[]) {
  return messages.filter(message => message.quote && message.quote.state !== 'resolved').map(message => ({ message_id: message.id, target_id: message.quote.target_id, sender_id: message.quote.sender_id, text: message.quote.text, state: message.quote.state }))
}
async function resolveQuotes(runtime: Runtime, conn: Awaited<ReturnType<Runtime['ensureConnected']>>, messages: any[], signal?: AbortSignal): Promise<any[]> {
  const byId = new Map(messages.map(message => [message.id, message]))
  const output = [], originals: any[] = []
  for (const message of messages) {
    if (!message.quote?.target_id) { output.push(message); continue }
    const present = byId.get(message.quote.target_id)
    if (present) { output.push({ ...message, quote: { ...message.quote, state: 'resolved' } }); continue }
    try {
      const decoded = decodeMessageId(message.quote.target_id, conn.accountScope)
      const located = await runtime.call('getMessageByLocator', { sessionId: decoded.sessionId, locator: decoded.locator }, signal, 2000)
      const row = located?.message || located?.data?.message
      if (located?.success && row) {
        const resolvedMessage = { ...message, quote: { ...message.quote, state: 'resolved' } }
        const original = normalizeMessage(row, { accountId: conn.accountId, accountScope: conn.accountScope, sessionId: decoded.sessionId })
        if (!byId.has(original.id)) { (original as any).__raw = String(mapRowsToMessagesLite([row], conn.accountId)[0]?.content ?? row.message_content ?? row.compress_content ?? ''); originals.push(original); byId.set(original.id, original) }
        output.push(resolvedMessage)
      } else output.push({ ...message, quote: { ...message.quote, state: message.quote.text ? 'snapshot_only' : 'unresolved' } })
    } catch (error: any) {
      if (error?.code === 'MESSAGE_NOT_FOUND') output.push({ ...message, quote: { ...message.quote, state: message.quote.text ? 'snapshot_only' : 'unresolved' } })
      else throw error
    }
  }
  return [...output, ...originals]
}
async function scanReplyRange(runtime: Runtime, conn: Awaited<ReturnType<Runtime['ensureConnected']>>, state: any, signal?: AbortSignal): Promise<void> {
  const started = Date.now(), targetIds = new Set(state.anchors.map((a: any) => a.message_id))
  for (const scan of state.replyScans || []) {
    while (!scan.done && Date.now() - started < 4200 && !signal?.aborted) {
      if (scan.cursor === null) {
        const opened = await runtime.call('openMessageCursor', { sessionId: scan.sessionId, batchSize: 100, ascending: true, beginTimestamp: scan.begin, endTimestamp: scan.finish }, signal, 2000)
        if (!opened?.success) throw fail('READ_FAILED', opened?.error || '无法打开回复范围游标。', true)
        scan.cursor = opened.cursor
      }
      const batch = await runtime.call('fetchMessageBatch', { cursor: scan.cursor }, signal, 2000)
      if (!batch?.success) throw fail('READ_FAILED', batch?.error || '读取回复范围失败。', true)
      for (const row of batch.rows || []) {
        const message = normalizeMessage(row, { accountId: conn.accountId, accountScope: conn.accountScope, sessionId: scan.sessionId })
        addUnresolved(state.unresolvedContent, message)
        if (message.quote?.target_id && targetIds.has(message.quote.target_id)) state.replies.push(message)
      }
      if (!batch.hasMore) scan.done = true
    }
    if (Date.now() - started >= 4200) break
  }
  state.replyComplete = (state.replyScans || []).every((scan: any) => scan.done)
  state.replyScope = { kind: 'reply_range', range: state.scope.reply_range, sessions: state.replyScans.map((scan: any) => scan.sessionId) }
}
function pushWithinBudget(messages: any[], candidates: any[], maxChars: number, reserve = Math.min(1500, Math.floor(maxChars * 0.35))): { emitted: any[]; tail: any[]; truncated: boolean } {
  const emitted: any[] = []; let left = Math.max(0, maxChars - reserve); let truncated = false
  for (const original of candidates) {
    const message = structuredClone(original)
    const needed = JSON.stringify(message).length
    if (needed <= left) { emitted.push(message); left -= needed; continue }
    const field = message.raw !== undefined ? 'raw' : 'text'
    const chars = codePoints(message[field] || '')
    if (chars.length && left > 120) {
      const take = Math.min(chars.length, Math.max(1, left - 240))
      const partField = field === 'raw' ? 'raw_part' : 'text_part'
      const offset = message[partField]?.offset || 0
      message[field] = chars.slice(0, take).join('')
      if (field === 'text') message.text_complete = false
      message[partField] = { offset, end: offset + take, total: message[partField]?.total || offset + chars.length }
      emitted.push(message)
      const remaining = { ...original, [field]: chars.slice(take).join(''), ...(field === 'text' && { text_complete: false }), [partField]: { offset: offset + take, end: offset + chars.length, total: message[partField].total } }
      return { emitted, tail: [remaining, ...candidates.slice(emitted.length)], truncated: true }
    }
    return { emitted, tail: candidates.slice(emitted.length), truncated: true }
  }
  return { emitted, tail: [], truncated }
}

async function scanPage(runtime: Runtime, conn: Awaited<ReturnType<Runtime['ensureConnected']>>, state: ScanState, limit: number, maxChars: number, signal?: AbortSignal) {
  ;(state as any).accountId = conn.accountId; (state as any).accountScope = conn.accountScope
  const started = Date.now(); const candidates: any[] = []
  while (Date.now() - started < 4200 && candidates.length < limit && !signal?.aborted) {
    if (state.pending.length) { candidates.push(state.pending.shift()); continue }
    const missingHeads = state.chats.filter(c => !c.done && !c.pending.length)
    for (const c of missingHeads) { if (Date.now() - started >= 4200) break; await getRawBatch(runtime, c, state, signal) }
    const heads = state.chats.filter(c => c.pending.length).sort((a,b) => {
      const aTime = a.pending[0].sent_at, bTime = b.pending[0].sent_at
      return (aTime < bTime ? -1 : aTime > bTime ? 1 : a.id.localeCompare(b.id)) * (state.filters.direction === 'desc' ? -1 : 1)
    })
    if (heads.length) {
      const c = heads[0]; const m = c.pending.shift()
      if (passFilter(m, state.filters, conn.accountScope) && (state.tool !== 'search_messages' || matchMessage(m, state.filters))) candidates.push(m)
      continue
    }
    if (state.chats.every(c => c.done)) break
  }
  const fitted = state.tool === 'search_messages'
    ? fitSearchHits(candidates, state.filters.terms || [], state.filters.fields || ['text', 'quote', 'attachment_title'], maxChars)
    : { ...pushWithinBudget([], candidates, maxChars), sources: candidates }
  state.pending.unshift(...fitted.tail)
  state.returnedCount += fitted.emitted.length
  const done = state.chats.every(c => c.done && !c.pending.length) && !state.pending.length
  return { messages: fitted.emitted, sources: state.tool === 'search_messages' ? fitted.sources : fitted.emitted, done, truncated: fitted.truncated }
}
async function scanOverview(runtime: Runtime, conn: Awaited<ReturnType<Runtime['ensureConnected']>>, state: ScanState, signal?: AbortSignal) {
  ;(state as any).accountId = conn.accountId; (state as any).accountScope = conn.accountScope
  const started = Date.now()
  for (const chat of state.chats) {
    while (!chat.done && Date.now() - started < 4200 && !signal?.aborted) {
      await getRawBatch(runtime, chat, state, signal)
      chat.pending = []
    }
    if (Date.now() - started >= 4200) break
  }
  return { done: state.chats.every(chat => chat.done) }
}

function normalizeSearch(s: string): string { return s.normalize('NFC').toLocaleLowerCase('und') }
function matchMessage(m: any, filters: Record<string, any>): boolean {
  const fields = filters.fields || ['text','quote','attachment_title']
  const values: Record<string,string> = { text: m.text || '', quote: m.quote?.text || '', attachment_title: m.attachment?.title || '' }
  const hits = (filters.terms || []).map((term: string) => fields.some((field: string) => normalizeSearch(values[field] || '').includes(normalizeSearch(term))))
  return filters.operator === 'all' ? hits.every(Boolean) : hits.some(Boolean)
}
function toHits(messages: any[], terms: string[], requestedFields: string[]) {
  return messages.map(m => {
    const snippets: any[] = []; const matchedTerms: string[] = []; const fields: string[] = []
    for (const [field, source] of Object.entries({ text: m.text || '', quote: m.quote?.text || '', attachment_title: m.attachment?.title || '' }).filter(([field]) => requestedFields.includes(field))) {
      const normalized = normalizeSearch(source as string)
      for (const term of terms) { const at = normalized.indexOf(normalizeSearch(term)); if (at >= 0) { const text = source as string; snippets.push({ field, text: text.slice(Math.max(0, at - 60), Math.min(text.length, at + term.length + 100)), offset: null }); matchedTerms.push(term); if (!fields.includes(field)) fields.push(field) } }
    }
    return { message_id: m.id, chat_id: m.chat_id, sender_id: m.sender_id, sent_at: m.sent_at, type: m.type, snippets, matched_fields: fields, matched_terms: [...new Set(matchedTerms)], context_anchor: m.id }
  })
}
function fitSearchHits(messages: any[], terms: string[], fields: string[], maxChars: number) {
  const emitted: any[] = [], sources: any[] = []; let left = Math.max(0, maxChars - Math.min(1200, Math.floor(maxChars * .25)))
  for (let i = 0; i < messages.length; i++) {
    const source = messages[i], hit = toHits([source], terms, fields)[0]
    const size = Array.from(JSON.stringify(hit)).length
    if (size > left) return { emitted, sources, tail: messages.slice(i), truncated: true }
    emitted.push(hit); sources.push(source); left -= size
  }
  return { emitted, sources, tail: [], truncated: false }
}
function versionKey(f: Freshness) { return `${f.mode}:${f.connection_id || f.snapshot_id || ''}:${f.revision_end ?? ''}:${f.captured_at || ''}` }
async function verifiedFreshness(runtime: Runtime, start: Freshness, signal?: AbortSignal): Promise<Freshness> {
  const end = await runtime.getFreshness(signal)
  if (versionKey(end) !== versionKey(start)) throw fail('CURSOR_STALE', '读取期间数据版本发生变化，请重读原范围。', false, '重读原范围并按稳定消息 ID 去重。')
  return { ...start, revision_end: end.revision_end }
}

export async function getStatus(runtime: Runtime, signal?: AbortSignal) { return runtime.getStatus(signal) }

export async function findChats(runtime: Runtime, args: any, signal?: AbortSignal): Promise<ToolData> {
  checkCursorArgs(args)
  const conn = await runtime.ensureConnected(signal); const fresh = await runtime.getFreshness(signal)
  let filtered: any[], index: number, limit: number, selectedQuery: string
  if (args.cursor) {
    const tokenState = await cursors.advance<any, any>(args.cursor, versionKey(fresh), async s => { const start = s.index; s.index = Math.min(s.items.length, start + s.limit); return { state: s, hasMore: s.index < s.items.length, value: { items: s.items.slice(start, s.index), index: s.index, total: s.items.length, scope: s.scope, freshness: s.freshness } } })
    filtered = tokenState.value.items; index = tokenState.value.index - filtered.length; limit = filtered.length || 10; selectedQuery = ''
    const chats = filtered.map((x: any) => ({ id: chatId(conn.accountScope, x.raw), kind: x.kind, display_name: x.row.remark || x.row.nick_name || x.raw, remark: x.row.remark || null, alias: x.row.alias || null, match_basis: x.exact ? 'exact' : x.query ? 'partial' : 'recent_activity', last_activity: x.activeAt ? new Date(x.activeAt*1000).toISOString() : null, has_local_messages: !!x.activity }))
    const coverage = { requested_scope: tokenState.value.scope, progress: [], scope_progress: { selected_chats: tokenState.value.total, completed_chats: tokenState.value.total, remaining_chats: 0 }, scan_complete: true, returned_count: chats.length, has_more: !!tokenState.next, next_cursor: tokenState.next, truncated: false, omissions: [], unresolved_content: { by_type: {}, samples: [], samples_complete: true } } as Coverage
    return dataResult(runtime, conn, tokenState.value.freshness, { chats }, coverage, chats.length)
  }
  const resp = await runtime.call('getContactsCompact', {}, signal, 3000)
  const records = Array.isArray(resp?.contacts) ? resp.contacts : []
  const sessionResp = await runtime.call('getSessions', {}, signal, 3000)
  const sessions = Array.isArray(sessionResp?.sessions) ? sessionResp.sessions : []
  const recent = new Map(sessions.map((s: any) => [String(s.username), s]))
  const query = String(args.query || '').trim().normalize('NFC').toLocaleLowerCase('und')
  filtered = records.map((r: any) => {
    const raw = String(r.username || ''), kind = raw.includes('@chatroom') ? 'group' : r.local_type === 1 ? 'private' : 'other'
    const names = [r.remark, r.nick_name, r.alias, raw].filter(Boolean).map(String)
    const exact = names.some(n => n.normalize('NFC').toLocaleLowerCase('und') === query)
    const partial = names.some(n => n.normalize('NFC').toLocaleLowerCase('und').includes(query))
    const activity = recent.get(raw)
    const activeAt = Number((activity as any)?.last_timestamp || (activity as any)?.sort_timestamp || 0)
    const since = args.active_since ? strictTime(args.active_since).getTime() / 1000 : 0
    return { row: r, raw, kind, exact, partial, activity, query, activeAt, since }
  }).filter((x: any) => ['group','private'].includes(x.kind) && (args.kind === undefined || args.kind === 'all' || x.kind === args.kind) && (!x.since || x.activeAt >= x.since) && (!query || x.exact || x.partial))
    .sort((a: any,b: any) => Number(b.exact)-Number(a.exact) || b.activeAt-a.activeAt || String(a.raw).localeCompare(String(b.raw)))
  limit = args.limit ?? 10
  const queryFreshness = await verifiedFreshness(runtime, fresh, signal)
  const scope = xScope(args, conn.accountId)
  const initialState = { items: filtered, index: Math.min(limit, filtered.length), limit, scope, freshness: queryFreshness }
  const initialToken = cursors.start(initialState, versionKey(fresh))
  const first = await cursors.advance<any, any>(initialToken, versionKey(fresh), async s => ({ state: s, hasMore: s.index < s.items.length, value: { items: s.items.slice(0, limit), index: limit, total: s.items.length, scope, freshness: queryFreshness } }))
  filtered = first.value.items
  const chats = filtered.map((x: any) => ({ id: chatId(conn.accountScope, x.raw), kind: x.kind, display_name: x.row.remark || x.row.nick_name || x.raw, remark: x.row.remark || null, alias: x.row.alias || null, match_basis: x.exact ? 'exact' : query ? 'partial' : 'recent_activity', last_activity: x.activeAt ? new Date(x.activeAt*1000).toISOString() : null, has_local_messages: !!x.activity }))
  const next = first.next
  const coverage = { requested_scope: first.value.scope, progress: [], scope_progress: { selected_chats: first.value.total, completed_chats: first.value.total, remaining_chats: 0 }, scan_complete: true, returned_count: chats.length, has_more: !!next, next_cursor: next, truncated: false, omissions: [], unresolved_content: { by_type: {}, samples: [], samples_complete: true } } as Coverage
  return dataResult(runtime, conn, first.value.freshness, { chats }, coverage, chats.length)
}
function xScope(args: any, account: string) { return { query: args.query || '', kind: args.kind || 'all', active_since: args.active_since || null, account } }

async function scanTool(runtime: Runtime, tool: string, args: any, signal?: AbortSignal): Promise<ToolData> {
  const conn = await runtime.ensureConnected(signal); const freshness = await runtime.getFreshness(signal); const version = versionKey(freshness)
  let state: ScanState | undefined
  if (!args.cursor) {
    const range = timeRange(args.range, new Date())
    const chats = args._globalSearch ? (args.chat_ids || []).map((id: string) => ({ id, sessionId: decodeChatId(id, conn.accountScope) })) : idSessions(conn, args.chat_ids)
    const filters: any = { direction: args.direction || 'asc', begin: range.begin, finish: range.finish, sender_ids: args.sender_ids, types: args.types, mentions: args.mentions, selfId: personId(conn.accountScope, conn.accountId), terms: args.query?.terms, operator: args.query?.operator, fields: args.query?.fields, bucket: args.bucket }
    if (tool === 'read_messages' && args.after_message) {
      if (args.range || chats.length !== 1) throw fail('INVALID_ARGUMENT', 'after_message 仅用于单会话，且不能与 range 同时使用。')
      const anchor = decodeMessageId(args.after_message, conn.accountScope)
      if (anchor.sessionId !== chats[0].sessionId) throw fail('INVALID_ARGUMENT', 'after_message 必须属于所选会话。')
      const located = await runtime.call('getMessageByLocator', { sessionId: anchor.sessionId, locator: anchor.locator }, signal, 2000)
      const row = located?.message ?? located?.data?.message
      if (!located?.success || !row) throw fail('MESSAGE_NOT_FOUND', 'after_message 锚点无法定位。', false, '从 find_chats 选择会话后重新读取范围。')
      const anchorTime = Number(row.create_time ?? row.createTime ?? anchor.locator.createTime)
      if (!Number.isFinite(anchorTime) || anchorTime < 0) throw fail('MESSAGE_NOT_FOUND', 'after_message 锚点缺少可用时间。')
      filters.afterMessage = anchor
      filters.afterPosition = [row.create_time ?? row.createTime, row.sort_seq ?? row.sortSeq ?? 0, row.local_id ?? row.localId ?? 0, row._relative_db ?? '']
      range.start = new Date(anchorTime * 1000).toISOString()
      range.begin = Math.ceil(anchorTime)
      filters.begin = range.begin
    }
    const scope = args._globalSearch ? { kind: 'account_all', selected_chat_count: chats.length, range: { start: range.start, end: range.end }, filters } : { chat_ids: args.chat_ids, range: { start: range.start, end: range.end }, filters }
    state = await createScans(runtime, conn, chats, tool, scope, range, filters)
    state.filters.limit = args.limit ?? (tool === 'search_messages' ? 20 : 50)
    state.filters.maxChars = args.max_chars ?? 12000
  }
  const token = args.cursor || cursors.start(state!, version)
  const page = await cursors.advance<ScanState, any>(token, version, async (s) => {
    const scanned = await scanPage(runtime, conn, s, s.filters.limit, s.filters.maxChars, signal)
    const queryFreshness = await verifiedFreshness(runtime, freshness, signal)
    let messages = scanned.messages
    let sourceMessages = scanned.sources
    const hydrated = await hydrateNames(runtime, conn, sourceMessages, [], signal)
    let truncated = scanned.truncated
    const maxChars = s.filters.maxChars
    const estimate = () => {
      const more = !scanned.done || s.pending.length > 0 || s.chats.some(c => c.pending.length > 0 || !c.done)
      const scope = s.scope
      const coverage = makeCoverage(scope, s.chats, messages.length, scanned.done, more ? 'A'.repeat(24) : null, truncated, sourceMessages, s.unresolvedContent)
      const displayed = messages
      const visibleIds = new Set(displayed.flatMap((m: any) => [m.chat_id, m.sender_id].filter(Boolean)))
      const chats = Object.fromEntries(Object.entries(hydrated.chats).filter(([id]) => visibleIds.has(id)))
      const people = Object.fromEntries(Object.entries(hydrated.people).filter(([id]) => visibleIds.has(id)))
      const data = tool === 'read_messages'
        ? dataResult(runtime, conn, queryFreshness, { chats, people, messages: displayed }, coverage, displayed.length)
        : dataResult(runtime, conn, queryFreshness, { chats, people, match_mode: 'literal', order: 'chat_activity_then_message_time', total_hits: null, hits: displayed }, coverage, displayed.length)
      return { data, more }
    }
    let built = estimate()
    while (Array.from(JSON.stringify(built.data)).length > maxChars && messages.length) {
      const index = messages.length - 1
      const last = messages[index]
      if (tool === 'read_messages' && codePoints(last.text || '').length > 1) {
        const original = codePoints(last.text)
        const over = Array.from(JSON.stringify(built.data)).length - maxChars + 24
        if (over >= original.length) {
          const [omitted] = messages.splice(index, 1)
          s.pending.unshift(omitted)
          truncated = true
          built = estimate()
          continue
        }
        const keep = Math.max(1, original.length - over)
        const offset = last.text_part?.offset || 0
        const total = last.text_part?.total || original.length
        const fragment = { ...last, text: original.slice(0, keep).join(''), text_complete: false, text_part: { offset, end: offset + keep, total } }
        const remainder = { ...last, text: original.slice(keep).join(''), text_complete: false, text_part: { offset: offset + keep, end: total, total } }
        messages[index] = fragment
        s.pending.unshift(remainder)
      } else {
        const [omitted] = messages.splice(index, 1)
        s.pending.unshift(tool === 'search_messages' ? sourceMessages[index] : omitted)
        if (tool === 'search_messages') sourceMessages.splice(index, 1)
      }
      truncated = true
      built = estimate()
    }
    if (messages.length === 0 && s.pending.length > 0 && Array.from(JSON.stringify(built.data)).length + 300 > maxChars) throw fail('OUTPUT_BUDGET_TOO_SMALL', 'max_chars 不足以容纳一条消息及其引用元数据。', false, '请将 max_chars 提高后重开或续读。')
    if (Array.from(JSON.stringify(built.data)).length > maxChars) throw fail('OUTPUT_BUDGET_TOO_SMALL', 'max_chars 不足以容纳必要的响应元数据。', false, '请将 max_chars 提高到至少 1000。')
    const hasMore = built.more || s.pending.length > 0
    return { state: s, hasMore, value: { data: built.data } }
  })
  const data = page.value.data as ToolData
  if (data.coverage) { data.coverage.next_cursor = page.next; data.coverage.has_more = !!page.next }
  return data
}

export async function readMessages(runtime: Runtime, args: any, signal?: AbortSignal) { checkCursorArgs(args); return scanTool(runtime, 'read_messages', args, signal) }
export async function searchMessages(runtime: Runtime, args: any, signal?: AbortSignal) {
  checkCursorArgs(args)
  if (args.cursor) return scanTool(runtime, 'search_messages', args, signal)
  if (!Array.isArray(args.query?.terms) || args.query.terms.length < 1 || args.query.terms.length > 8 || args.query.terms.some((t: any) => typeof t !== 'string' || !t.trim())) throw fail('INVALID_ARGUMENT', 'query.terms 必须包含 1 到 8 个非空字面词。')
  if (!args.chat_ids) { const found = await runtime.call('getContactsCompact', {}, signal, 3000); const conn = await runtime.ensureConnected(signal); args = { ...args, _globalSearch: true, chat_ids: (found.contacts || []).filter((c: any) => c.local_type === 1 || c.local_type === 2).map((c: any) => chatId(conn.accountScope, c.username)) } }
  return scanTool(runtime, 'search_messages', args, signal)
}

export async function getChatOverview(runtime: Runtime, args: any, signal?: AbortSignal): Promise<ToolData> {
  checkCursorArgs(args)
  const conn = await runtime.ensureConnected(signal), freshness = await runtime.getFreshness(signal), version = versionKey(freshness)
  let state: ScanState | undefined
  if (!args.cursor) {
    const range = timeRange(args.range, new Date()), chats = idSessions(conn, args.chat_ids)
    const filters: any = { direction: 'asc', begin: range.begin, finish: range.finish, bucket: args.bucket || 'day' }
    const scope = { chat_ids: args.chat_ids, range: { start: range.start, end: range.end }, bucket: filters.bucket }
    state = await createScans(runtime, conn, chats, 'get_chat_overview', scope, range, filters)
  }
  if (state) { state.filters.maxChars = args.max_chars ?? 12000; state.filters.bucketOffset = 0 }
  const token = args.cursor || cursors.start(state!, version)
  const page = await cursors.advance<ScanState, any>(token, version, async s => {
    const p = await scanOverview(runtime, conn, s, signal)
    const queryFreshness = await verifiedFreshness(runtime, freshness, signal)
    const groups = new Map<string, any>()
    for (const row of Object.values(s.stats) as any[]) {
      const item = groups.get(row.chat_id) || { range: s.scope.range, total: 0, sent: 0, received: 0, unknown_sender: 0, type_counts: {}, buckets: [], local_history_bounds: null, counts_complete: p.done }
      item.total += row.total; item.sent += row.sent; item.received += row.received; item.unknown_sender += row.unknown_sender; item.buckets.push(row)
      for (const [type, count] of Object.entries(row.type_counts)) item.type_counts[type] = (item.type_counts[type] || 0) + Number(count)
      groups.set(row.chat_id, item)
    }
    for (const chat of s.chats) if (!groups.has(chat.id)) groups.set(chat.id, { range: s.scope.range, total: 0, sent: 0, received: 0, unknown_sender: 0, type_counts: {}, buckets: [], local_history_bounds: null, counts_complete: p.done })
    const ordered = [...groups.values()].flatMap((g: any) => g.buckets).sort((a: any,b: any) => a.start.localeCompare(b.start) || a.chat_id.localeCompare(b.chat_id))
    // New scan batches may insert earlier buckets from another chat. Freeze the
    // ordered set before advancing result offsets, so those buckets are retained.
    if (!s.filters.scanFinished) s.filters.bucketOffset = 0
    if (p.done) s.filters.scanFinished = true
    const offset = s.filters.bucketOffset || 0, chosen: any[] = []
    const build = (bucketRows: any[]) => {
      const byChat = new Map<string, any[]>(); for (const row of bucketRows) { const arr = byChat.get(row.chat_id) || []; arr.push(row); byChat.set(row.chat_id, arr) }
      const chats = [...groups.entries()].map(([chat_id, data]: any) => ({ chat_id, ...data, buckets: byChat.get(chat_id) || [], buckets_partial: (byChat.get(chat_id)?.length || 0) < data.buckets.length }))
      const more = !p.done || offset + chosen.length < ordered.length
      const coverage = makeCoverage(s.scope, s.chats, 0, p.done, more ? 'A'.repeat(24) : null, false, [], s.unresolvedContent)
      return dataResult(runtime, conn, queryFreshness, { chats }, coverage, 0)
    }
    let output = build(chosen)
    const budget = s.filters.maxChars || 12000
    for (let i = offset; i < ordered.length; i++) {
      chosen.push(ordered[i]); const trial = build(chosen)
      if (Array.from(JSON.stringify(trial)).length > budget) { chosen.pop(); break }
      output = trial
    }
    if (Array.from(JSON.stringify(output)).length > budget) throw fail('OUTPUT_BUDGET_TOO_SMALL', 'max_chars 不足以容纳概览元数据。', false, '请将 max_chars 提高。')
    s.filters.bucketOffset = offset + chosen.length
    const more = !p.done || s.filters.bucketOffset < ordered.length
    if (more) { output.coverage!.has_more = true; output.coverage!.next_cursor = 'A'.repeat(24) }
    return { state: s, hasMore: more, value: { data: output } }
  })
  const output = page.value.data as ToolData
  if (output.coverage) { output.coverage.next_cursor = page.next; output.coverage.has_more = !!page.next }
  return output
}
function formatBucket(date: Date, tz: string, bucket: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const p = Object.fromEntries(parts.map(x => [x.type, x.value])); let day = `${p.year}-${p.month}-${p.day}`
  if (bucket === 'week') { const local = new Date(`${day}T12:00:00Z`); const weekday = (local.getUTCDay() + 6) % 7; local.setUTCDate(local.getUTCDate() - weekday); day = local.toISOString().slice(0,10) }
  return day
}

export async function getMessageContext(runtime: Runtime, args: any, signal?: AbortSignal): Promise<ToolData> {
  checkCursorArgs(args)
  const conn = await runtime.ensureConnected(signal), fresh = await runtime.getFreshness(signal)
  const version = versionKey(fresh)
  if (args.cursor) {
    const page = await cursors.advance<any, any>(args.cursor, version, async state => {
      if (state.replyScans?.length && !state.replyComplete) await scanReplyRange(runtime, conn, state, signal)
      const fitted = pushWithinBudget([], state.remaining, state.maxChars)
      state.remaining = fitted.tail
      const replyPageCount = Math.max(1, Math.min(50, Math.floor(state.maxChars / 180)))
      const replyEdges = (state.replies || []).slice(state.replyOffset || 0, (state.replyOffset || 0) + replyPageCount).map((m: any) => ({ message_id: m.id, target_id: m.quote.target_id }))
      const output = fitContextOutput(fitted.emitted, state, state.maxChars, (items, more, truncated) => {
        const coverage = makeCoverage(state.scope, [], items.length, true, more ? 'A'.repeat(24) : null, truncated || fitted.truncated, [], state.unresolvedContent)
        const visibleIds = new Set([...items, ...(state.replies || []).slice(state.replyOffset || 0, (state.replyOffset || 0) + replyPageCount)].flatMap((m: any) => [m.chat_id, m.sender_id].filter(Boolean)))
        const chats = Object.fromEntries(Object.entries(state.chats || {}).filter(([id]) => visibleIds.has(id)))
        const people = Object.fromEntries(Object.entries(state.people || {}).filter(([id]) => visibleIds.has(id)))
        const data = dataResult(runtime, conn, state.freshness, { chats, people, messages: items, anchors: state.anchors, windows: state.windows, unresolved_quotes: unresolvedQuotes(items), replies: replyEdges, reply_search_scope: state.replyScope, reply_search_complete: state.replyComplete }, coverage, items.length)
        data.warnings = state.warnings
        return data
      })
      state.replyOffset = (state.replyOffset || 0) + replyEdges.length
      return { state, hasMore: state.remaining.length > 0 || state.replyOffset < (state.replies || []).length || !state.replyComplete, value: { data: output } }
    })
    const output = page.value.data as ToolData
    if (output.coverage) { output.coverage.next_cursor = page.next; output.coverage.has_more = !!page.next }
    return output
  }
  if (!args.message_ids?.length || args.message_ids.length > 10) throw fail('INVALID_ARGUMENT', 'message_ids 必须包含 1 到 10 个 ID。')
  const anchors: any[] = [], messages: any[] = [], warnings: any[] = [], windows: any[] = [], rawById = new Map<string, string>()
  for (const id of args.message_ids) {
    let decoded: ReturnType<typeof decodeMessageId>
    try { decoded = decodeMessageId(id, conn.accountScope) } catch { throw fail('INVALID_ARGUMENT', 'message_id 无效或属于其他账号。') }
    const { sessionId, locator } = decoded
    let located: any
    try { located = await runtime.call('getMessageByLocator', { sessionId, locator }, signal, 2000) }
    catch (error: any) {
      if (error?.code === 'MESSAGE_NOT_FOUND') { anchors.push({ message_id: id, state: 'error', error: { code: 'MESSAGE_NOT_FOUND' } }); warnings.push({ code: 'MESSAGE_NOT_FOUND', message_id: id }); continue }
      throw error
    }
    const anchorRow = located?.message ?? located?.data?.message
    if (!located?.success || !anchorRow) { anchors.push({ message_id: id, state: 'error', error: { code: 'MESSAGE_NOT_FOUND' } }); warnings.push({ code: 'MESSAGE_NOT_FOUND', message_id: id }); continue }
    const anchor = normalizeMessage(anchorRow, { accountId: conn.accountId, accountScope: conn.accountScope, sessionId }); messages.push(anchor)
  rawById.set(anchor.id, String(mapRowsToMessagesLite([anchorRow], conn.accountId)[0]?.content ?? anchorRow.message_content ?? anchorRow.compress_content ?? ''))
    anchors.push({ message_id: id, state: 'found' })
      const readAround = async (direction: 'asc'|'desc', count: number) => {
        if (count === 0) return []
        const around = await runtime.call('openMessageCursorAround', { sessionId, anchorLocator: locator, direction, batchSize: Math.max(1, Math.min(50, count + 1)) }, signal, 2500)
        if (!around?.success || around.cursor === undefined) throw fail('READ_FAILED', around?.error || '无法读取上下文邻居。', true)
        const batch = await runtime.call('fetchMessageBatch', { cursor: around.cursor }, signal, 2000)
        if (!batch?.success) throw fail('READ_FAILED', batch?.error || '读取上下文邻居失败。', true)
        return (batch?.rows || []).map((row: any) => { const message = normalizeMessage(row, { accountId: conn.accountId, accountScope: conn.accountScope, sessionId }); rawById.set(message.id, String(mapRowsToMessagesLite([row], conn.accountId)[0]?.content ?? row.message_content ?? row.compress_content ?? '')); return message })
      }
      const before = await readAround('desc', args.before ?? 5)
      const after = await readAround('asc', args.after ?? 10)
      const beforeMessages = before.slice(0, args.before ?? 5).reverse()
      const afterMessages = after.filter((m: any) => m.id !== anchor.id).slice(0, args.after ?? 10)
      const windowMessages = [...beforeMessages, anchor, ...afterMessages]
      messages.push(...windowMessages)
      windows.push({ anchor_id: id, before_count: beforeMessages.length, after_count: afterMessages.length, first_message_id: windowMessages[0]?.id || null, last_message_id: windowMessages[windowMessages.length - 1]?.id || null })
  }
  if (!messages.length) throw fail('MESSAGE_NOT_FOUND', '所有指定消息都无法读取。')
  const queryFreshness = await verifiedFreshness(runtime, fresh, signal)
  let uniqueNormalized = [...new Map(messages.map(m=>[m.id,m])).values()].sort((a,b)=>a.sent_at.localeCompare(b.sent_at))
  uniqueNormalized = await resolveQuotes(runtime, conn, uniqueNormalized, signal)
  for (const m of uniqueNormalized) if ((m as any).__raw) rawById.set(m.id, (m as any).__raw)
  uniqueNormalized = uniqueNormalized.map(({ __raw, ...m }: any) => m)
  const hydrated = await hydrateNames(runtime, conn, uniqueNormalized, args.message_ids.map((id: string) => { try { return chatId(conn.accountScope, decodeMessageId(id, conn.accountScope).sessionId) } catch { return '' } }).filter(Boolean), signal)
  const unique = args.format === 'raw' ? uniqueNormalized.map(m => ({ id: m.id, chat_id: m.chat_id, sender_id: m.sender_id, sent_at: m.sent_at, type: m.type, raw: rawById.get(m.id) || '', ...(m.quote && { quote: m.quote }) })) : uniqueNormalized
  const maxChars = args.max_chars ?? 12000
  const fitted = pushWithinBudget([], unique, maxChars, Math.min(1200, Math.floor(maxChars * .25)))
  const scope = { message_ids: args.message_ids, before: args.before ?? 5, after: args.after ?? 10, reply_range: args.reply_range || null }
  const replyRange = args.reply_range ? { start: strictTime(args.reply_range.start).toISOString(), end: strictTime(args.reply_range.end).toISOString() } : null
  const replyScans = replyRange && args.include_replies !== false ? [...new Set(anchors.filter((a:any)=>a.state==='found').map((a:any)=>decodeMessageId(a.message_id, conn.accountScope).sessionId))].map(sessionId => ({ sessionId, cursor: null, done: false, begin: Math.ceil(Date.parse(replyRange.start)/1000), finish: Math.ceil(Date.parse(replyRange.end)/1000)-1 })) : []
  const anchorIds = new Set(anchors.filter((a:any)=>a.state==='found').map((a:any)=>a.message_id))
  const state = { remaining: fitted.tail, maxChars, freshness: queryFreshness, scope, anchors, warnings, windows, chats: hydrated.chats, people: hydrated.people, unresolvedContent: summarizeUnresolved(uniqueNormalized), replies: args.include_replies === false ? [] : uniqueNormalized.filter(m=>m.quote?.target_id && anchorIds.has(m.quote.target_id) && !anchorIds.has(m.id)), replyOffset: 0, replyScans, replyScope: args.include_replies === false ? 'disabled' : replyRange ? { kind: 'reply_range', range: replyRange } : 'anchor_windows', replyComplete: !replyScans.length }
  if (replyScans.length) await scanReplyRange(runtime, conn, state, signal)
  const output = fitContextOutput(fitted.emitted, state, maxChars, (items, more, truncated) => {
    const coverage = makeCoverage(scope, [], items.length, true, more ? 'A'.repeat(24) : null, truncated || fitted.truncated, [], state.unresolvedContent)
    const replyPageCount = Math.max(1, Math.min(50, Math.floor(maxChars / 180)))
    const replyEdges = state.replies.slice(state.replyOffset, state.replyOffset + replyPageCount).map((m: any) => ({ message_id: m.id, target_id: m.quote.target_id }))
    const visibleIds = new Set([...items, ...state.replies.slice(state.replyOffset, state.replyOffset + replyPageCount)].flatMap((m: any) => [m.chat_id, m.sender_id].filter(Boolean)))
    const chats = Object.fromEntries(Object.entries(state.chats).filter(([id]) => visibleIds.has(id)))
    const people = Object.fromEntries(Object.entries(state.people).filter(([id]) => visibleIds.has(id)))
    const data = dataResult(runtime, conn, queryFreshness, { chats, people, messages: items, anchors, windows, unresolved_quotes: unresolvedQuotes(items), replies: replyEdges, reply_search_scope: state.replyScope, reply_search_complete: state.replyComplete }, coverage, items.length)
    data.warnings = warnings
    return data
  })
  state.replyOffset = Math.min(state.replies.length, Math.max(1, Math.min(50, Math.floor(maxChars / 180))))
  const next = state.remaining.length || state.replyOffset < state.replies.length || !state.replyComplete ? cursors.start(state, version) : null
  if (output.coverage) { output.coverage.next_cursor = next; output.coverage.has_more = !!next }
  return output
}
