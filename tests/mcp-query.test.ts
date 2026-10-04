import test from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_DEFINITIONS } from '../mcp/contracts'
import { CursorStore } from '../mcp/cursors'
import { clearCursors, getChatOverview, getMessageContext, readMessages, searchMessages } from '../mcp/query'
import { accountScope, chatId, messageId, personId } from '../shared/chat/ids'
import { normalizeMessage } from '../shared/chat/normalize'

test('MCP publishes exactly the seven stable tools with closed input objects', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map(tool => tool.name), [
    'get_status', 'find_chats', 'get_chat_overview', 'read_messages', 'search_messages', 'get_message_context', 'get_media',
  ])
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal((tool.inputSchema as any).additionalProperties, false)
    assert.ok(tool.outputSchema)
  }
})

test('cursor repeats return the same page and next token without advancing state', async () => {
  const store = new CursorStore()
  const first = store.start({ index: 0 }, 'live:c1:1')
  let executions = 0
  const page = () => store.advance<{ index: number }, { index: number }>(first, 'live:c1:1', async state => {
    executions++
    state.index++
    return { state, hasMore: state.index < 2, value: { index: state.index } }
  })
  const a = await page()
  const b = await page()
  assert.deepEqual(b, a)
  assert.equal(executions, 1)
  assert.ok(a.next)
})

test('cursor rejects a data-version change', async () => {
  const store = new CursorStore()
  const token = store.start({ value: 1 }, 'snapshot:a')
  await assert.rejects(() => store.advance(token, 'snapshot:b', async state => ({ state, hasMore: false, value: null })), { code: 'CURSOR_STALE' })
})

const scope = accountScope('fixture-account')
const fresh = { mode: 'snapshot' as const, queried_at: '2026-10-03T12:00:00.000Z', connection_id: null, revision_start: 1, revision_end: 1, snapshot_id: 'fixture', captured_at: '2026-10-03T11:00:00.000Z', consistency: 'fixed_snapshot' as const }
function row(sessionId: string, n: number, text: string, extra: Record<string, unknown> = {}) {
  return { server_id: String(9000 + n), local_id: n + 1, create_time: 1_790_000_000 + n, sort_seq: n, local_type: 1, is_send: 0,
    sender_username: 'wx_sender', message_content: text, _relative_db: 'message/message_0.db', _table_name: `Chat_${sessionId}`, ...extra }
}
class FakeRuntime {
  timezone = 'UTC'
  connection = { accountId: 'fixture-account', accountScope: scope, dataDir: 'fixture', mode: 'snapshot' as const, snapshotId: 'fixture' }
  rows: Record<string, any[]> = {}
  openedAround = 0
  private nextCursor = 1
  private cursors = new Map<number, { rows: any[]; index: number }>()
  async ensureConnected() { return this.connection }
  async getFreshness() { return fresh }
  async getStatus() { return { schema_version: '1', success: true, account: { id: scope, self_id: null }, timezone: 'UTC', data: {}, coverage: null, freshness: fresh, warnings: [], error: null } }
  async close() {}
  async call(method: string, payload: any = {}) {
    if (method === 'openMessageCursor') {
      let values = [...(this.rows[payload.sessionId] || [])]
      values = values.filter(r => (!payload.beginTimestamp || r.create_time >= payload.beginTimestamp) && (!payload.endTimestamp || r.create_time <= payload.endTimestamp))
      values.sort((a, b) => (a.create_time - b.create_time) || (a.sort_seq - b.sort_seq) || String(a._relative_db).localeCompare(String(b._relative_db)))
      if (payload.afterPosition) values = values.filter(r => r.create_time > payload.afterPosition[0] || (r.create_time === payload.afterPosition[0] && r.sort_seq > payload.afterPosition[1]))
      if (!payload.ascending) values.reverse()
      const cursor = this.nextCursor++; this.cursors.set(cursor, { rows: values, index: 0 }); return { success: true, cursor }
    }
    if (method === 'fetchMessageBatch') {
      const state = this.cursors.get(payload.cursor)!; const rows = state.rows.slice(state.index, state.index + 100); state.index += rows.length
      return { success: true, rows, hasMore: state.index < state.rows.length }
    }
    if (method === 'getMessageByLocator') {
      const list = this.rows[payload.sessionId] || []
      const message = list.find(r => payload.locator?.serverId ? String(r.server_id) === payload.locator.serverId : String(r.local_id) === String(payload.locator?.localId))
      if (!message) throw Object.assign(new Error('missing'), { code: 'MESSAGE_NOT_FOUND' })
      return { success: true, message }
    }
    if (method === 'openMessageCursorAround') {
      this.openedAround++
      const list = this.rows[payload.sessionId] || []; const anchor = list.find(r => String(r.server_id) === payload.anchorLocator.serverId)
      const index = list.indexOf(anchor), count = payload.batchSize - 1
      let values = payload.direction === 'desc' ? list.slice(Math.max(0, index - count), index).reverse() : list.slice(index + 1, index + 1 + count)
      const cursor = this.nextCursor++; this.cursors.set(cursor, { rows: values, index: 0 }); return { success: true, cursor }
    }
    if (method === 'getContactsCompact') return { success: true, contacts: [] }
    if (method === 'getSessions') return { success: true, sessions: [] }
    if (method === 'getDisplayNames') return { success: true, map: {} }
    throw new Error(`unexpected RPC ${method}`)
  }
}
const fixedRange = { start: '2026-09-01T00:00:00Z', end: '2026-10-04T00:00:00Z' }

test('read emits buffered rows after the raw cursor is done and resumes one message at a time', async () => {
  clearCursors()
  const runtime = new FakeRuntime(), session = 'room@chatroom', id = chatId(scope, session)
  runtime.rows[session] = [row(session, 1, 'one'), row(session, 2, 'two'), row(session, 3, 'three')]
  let result: any = await readMessages(runtime as any, { chat_ids: [id], range: fixedRange, limit: 1, max_chars: 4000 })
  const messages = [...result.data.messages]
  while (result.coverage.next_cursor) {
    result = await readMessages(runtime as any, { cursor: result.coverage.next_cursor })
    messages.push(...result.data.messages)
  }
  assert.deepEqual(messages.map(m => m.text), ['one', 'two', 'three'])
})

test('after_message starts at the old anchor and reads forward to the fixed current upper bound', async () => {
  clearCursors()
  const runtime = new FakeRuntime(), session = 'room@chatroom'
  const anchor = row(session, 1, 'old anchor'), next = row(session, 2, 'old continuation')
  runtime.rows[session] = [anchor, next]
  const anchorId = normalizeMessage(anchor, { accountId: runtime.connection.accountId, accountScope: scope, sessionId: session }).id
  const result = await readMessages(runtime as any, { chat_ids: [chatId(scope, session)], after_message: anchorId, limit: 10, max_chars: 4000 })
  assert.deepEqual(result.data.messages.map((m: any) => m.text), ['old continuation'])
  assert.equal((result.coverage.requested_scope as any).range.start, new Date(anchor.create_time * 1000).toISOString())
})

test('multi-chat merge waits for each chat head and returns global message-time order', async () => {
  clearCursors()
  const runtime = new FakeRuntime(), a = 'a@chatroom', b = 'b@chatroom'
  runtime.rows[a] = [row(a, 1, 'a1'), row(a, 3, 'a3')]
  runtime.rows[b] = [row(b, 2, 'b2'), row(b, 4, 'b4')]
  const result = await readMessages(runtime as any, { chat_ids: [chatId(scope, a), chatId(scope, b)], range: fixedRange, limit: 10, max_chars: 12000 })
  assert.deepEqual(result.data.messages.map(m => m.text), ['a1', 'b2', 'a3', 'b4'])
})

test('literal search scans past nonmatching messages and stable person mentions filter correctly', async () => {
  clearCursors()
  const runtime = new FakeRuntime(), session = 'room@chatroom'
  runtime.rows[session] = Array.from({ length: 60 }, (_, i) => row(session, i, i === 59 ? '<msg><atuserlist>wx_target</atuserlist><content>needle</content></msg>' : `ordinary ${i}`))
  const result = await searchMessages(runtime as any, { query: { terms: ['needle'] }, chat_ids: [chatId(scope, session)], range: fixedRange, mentions: { person_id: personId(scope, 'wx_target') }, limit: 1, max_chars: 4000 })
  assert.equal(result.data.hits.length, 1)
  assert.equal(result.data.hits[0].matched_terms[0], 'needle')
})

test('zero-hit search coverage counts unavailable content across scanned rows', async () => {
  clearCursors()
  const runtime = new FakeRuntime(), session = 'room@chatroom'
  runtime.rows[session] = [row(session, 1, '', { local_type: 34 })]
  const result = await searchMessages(runtime as any, { query: { terms: ['absent'] }, chat_ids: [chatId(scope, session)], range: fixedRange, max_chars: 4000 })
  assert.equal(result.data.hits.length, 0)
  assert.equal(result.coverage.unresolved_content.by_type['voice:unknown'], 1)
  assert.equal(result.coverage.unresolved_content.samples.length, 1)
})

test('context coverage reports unavailable anchor content', async () => {
  clearCursors()
  const runtime = new FakeRuntime(), session = 'room@chatroom', anchor = row(session, 7, '', { local_type: 34 })
  runtime.rows[session] = [anchor]
  const id = normalizeMessage(anchor, { accountId: runtime.connection.accountId, accountScope: scope, sessionId: session }).id
  const output = await getMessageContext(runtime as any, { message_ids: [id], before: 0, after: 0, max_chars: 4000 })
  assert.equal(output.coverage.unresolved_content.by_type['voice:unknown'], 1)
})

test('context zero-neighbor bounds return only the anchor and raw mode retains original content', async () => {
  clearCursors()
  const runtime = new FakeRuntime(), session = 'room@chatroom', anchor = row(session, 7, '<msg>raw text</msg>')
  runtime.rows[session] = [row(session, 6, 'before'), anchor, row(session, 8, 'after')]
  const id = normalizeMessage(anchor, { accountId: runtime.connection.accountId, accountScope: scope, sessionId: session }).id
  const output = await getMessageContext(runtime as any, { message_ids: [id], before: 0, after: 0, format: 'raw', max_chars: 4000 })
  assert.equal(output.data.messages.length, 1)
  assert.equal(output.data.messages[0].raw, '<msg>raw text</msg>')
  assert.equal(runtime.openedAround, 0)
})

test('overview counts raw rows exactly once and reports completion', async () => {
  clearCursors()
  const runtime = new FakeRuntime(), session = 'room@chatroom'
  runtime.rows[session] = [row(session, 1, 'one'), row(session, 2, 'two'), row(session, 3, 'three')]
  const result = await getChatOverview(runtime as any, { chat_ids: [chatId(scope, session)], range: fixedRange, bucket: 'day', max_chars: 4000 })
  assert.equal(result.data.chats[0].total, 3)
  assert.equal(result.data.chats[0].counts_complete, true)
})

test('explicit reply_range scans only direct quote replies and reports its scope', async () => {
  clearCursors()
  const runtime = new FakeRuntime(), session = 'room@chatroom'
  const anchor = row(session, 1, 'anchor')
  const reply = row(session, 2, '<msg><appmsg><refermsg><svrid>9001</svrid><content>anchor</content></refermsg></appmsg></msg>', { local_type: 49 })
  runtime.rows[session] = [anchor, reply]
  const id = normalizeMessage(anchor, { accountId: runtime.connection.accountId, accountScope: scope, sessionId: session }).id
  const output = await getMessageContext(runtime as any, { message_ids: [id], before: 0, after: 0, reply_range: fixedRange, max_chars: 4000 })
  assert.equal(output.success, true)
  assert.equal(output.data.replies.length, 1)
  assert.equal(output.data.reply_search_complete, true)
  assert.equal(output.data.reply_search_scope.kind, 'reply_range')
})
