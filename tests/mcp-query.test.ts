import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { TOOL_DEFINITIONS } from '../mcp/contracts'
import { CursorStore } from '../mcp/cursors'
import { clearCursors, getChatOverview, getMessageContext, readMessages, searchMessages } from '../mcp/query'
import { accountScope, chatId, messageId, personId } from '../shared/chat/ids'
import { normalizeMessage } from '../shared/chat/normalize'
import { exportMessages } from '../mcp/export'
import { createTools } from '../mcp/tools'
import { ConversationTools, conversationRef } from '../mcp/conversation'

test('MCP publishes the reading tools and bulk export with closed input objects', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map(tool => tool.name), [
    'get_status', 'get_group_members', 'find_chats', 'get_chat_overview', 'read_messages', 'search_messages', 'get_message_context', 'get_media', 'export_messages',
    'read_conversation', 'export_conversation', 'get_conversation_context',
  ])
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal((tool.inputSchema as any).additionalProperties, false)
    assert.equal(tool.inputSchema.type, 'object')
    for (const keyword of ['oneOf', 'anyOf', 'allOf']) assert.equal(tool.inputSchema[keyword], undefined)
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
  fetchedBatches = 0
  closedCursors = 0
  private nextCursor = 1
  private cursors = new Map<number, { rows: any[]; index: number; size: number }>()
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
      const cursor = this.nextCursor++; this.cursors.set(cursor, { rows: values, index: 0, size: payload.batchSize }); return { success: true, cursor }
    }
    if (method === 'fetchMessageBatch') {
      this.fetchedBatches++
      const state = this.cursors.get(payload.cursor)!; const rows = state.rows.slice(state.index, state.index + state.size); state.index += rows.length
      return { success: true, rows, hasMore: state.index < state.rows.length }
    }
    if (method === 'closeMessageCursor') { this.cursors.delete(payload.cursor); this.closedCursors++; return { success: true } }
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
      const cursor = this.nextCursor++; this.cursors.set(cursor, { rows: values, index: 0, size: payload.batchSize }); return { success: true, cursor }
    }
    if (method === 'getContactsCompact') return { success: true, contacts: [] }
    if (method === 'getSessions') return { success: true, sessions: [] }
    if (method === 'getDisplayNames') return { success: true, map: {} }
    throw new Error(`unexpected RPC ${method}`)
  }
}
const fixedRange = { start: '2026-09-01T00:00:00Z', end: '2026-10-04T00:00:00Z' }

test('fresh reads retry transient failures once, while continuations and cancellations do not retry', async () => {
  for (const code of ['BACKEND_EXITED', 'BACKEND_STOPPED', 'BACKEND_PROTOCOL_ERROR', 'NOT_CONNECTED', 'LIVE_READ_TIMEOUT', 'CURSOR_STALE']) {
    const runtime = new FakeRuntime(), call = runtime.call.bind(runtime)
    let attempts = 0
    runtime.call = async (method, payload) => {
      if (method === 'getContactsCompact' && ++attempts === 1) throw Object.assign(new Error('synthetic failure'), { code })
      return call(method, payload)
    }
    const tools = createTools(runtime as any)
    try {
      assert.equal((await tools.call('find_chats', { limit: 1 })).structuredContent.success, true, code)
      assert.equal(attempts, 2, code)
    } finally { await tools.close() }
  }
  for (const [args, code, expectedAttempts] of [
    [{ limit: 1 }, 'BACKEND_EXITED', 2],
    [{ cursor: 'old-query' }, 'BACKEND_EXITED', 1],
    [{ limit: 1 }, 'CANCELLED', 1],
    [{ limit: 1 }, 'KEY_NOT_FOUND', 1],
  ] as const) {
    const runtime = new FakeRuntime()
    let attempts = 0
    runtime.getFreshness = async () => { attempts++; throw Object.assign(new Error('synthetic failure'), { code }) }
    const tools = createTools(runtime as any)
    try {
      const output = await tools.call('find_chats', args)
      assert.equal((output.structuredContent.error as any).code, code)
      assert.equal(attempts, expectedAttempts)
    } finally { await tools.close() }
  }
})

test('flat schemas still enforce first-call requirements and cursor-only continuation', async () => {
  clearCursors()
  const tools = createTools(new FakeRuntime() as any)
  try {
    for (const [name, args] of [
      ['read_messages', {}], ['get_chat_overview', { chat_ids: [chatId(scope, 'a')] }],
      ['search_messages', { range: fixedRange }], ['get_message_context', {}],
      ['read_messages', { cursor: 'missing', chat_ids: [chatId(scope, 'a')] }],
      ['find_chats', { cursor: '' }],
    ] as const) {
      const output = await tools.call(name, args)
      assert.equal((output.structuredContent.error as any).code, 'INVALID_ARGUMENT')
    }
    const first = await tools.call('read_messages', { chat_ids: [chatId(scope, 'a')] })
    assert.equal(first.structuredContent.success, true)
    const continued = await tools.call('read_messages', { cursor: 'missing' })
    assert.equal((continued.structuredContent.error as any).code, 'CURSOR_EXPIRED')
  } finally { await tools.close() }
})

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

test('default reads exceed the old 50-message page and compact reads fit more original messages', async () => {
  clearCursors()
  const runtime = new FakeRuntime(), session = 'room@chatroom'
  runtime.rows[session] = Array.from({ length: 1000 }, (_, n) => row(session, n, `消息 ${n}🙂`))
  const args = { chat_ids: [chatId(scope, session)], range: fixedRange }
  const defaults = await readMessages(runtime, args)
  assert.ok((defaults.data.messages as any[]).length > 50)
  assert.ok(Array.from(JSON.stringify(defaults)).length <= 120_000)
  const normalized = await readMessages(runtime, { ...args, limit: 1000, max_chars: 80_000 })
  const compact = await readMessages(runtime, { ...args, limit: 1000, max_chars: 80_000, format: 'compact' })
  assert.ok((compact.data.messages as any[]).length > (normalized.data.messages as any[]).length)
  assert.ok(Array.from(JSON.stringify(compact)).length <= 80_000)
  const columns = compact.data.message_columns as string[]
  assert.equal((compact.data.messages as any[])[0][columns.indexOf('text')], '消息 0🙂')
  assert.equal((compact.data.chats as any)[(compact.data.messages as any[])[0][1]].id, chatId(scope, session))
  assert.equal((compact.data.people as any)[(compact.data.messages as any[])[0][2]].id, personId(scope, 'wx_sender'))
  assert.equal(compact.data.format, 'compact')
  runtime.rows[session] = Array.from({ length: 10_000 }, (_, n) => row(session, n, `消息 ${n}`))
  const before = runtime.fetchedBatches
  const small = await readMessages(runtime, { ...args, format: 'compact', limit: 10_000, max_chars: 4000 })
  assert.ok(small.coverage?.has_more)
  assert.equal(runtime.fetchedBatches - before, 1, 'a small output budget must not scan all 10000 requested rows')
})

test('compact cursor pages retain Unicode long text, quotes, mentions and unavailable media', async () => {
  clearCursors()
  const runtime = new FakeRuntime(), session = 'room@chatroom', original = '正文🙂\n'.repeat(1500)
  runtime.rows[session] = [row(session, 1, original), row(session, 2, '', { local_type: 34 }),
    row(session, 3, '<msg><appmsg><title>回应</title><refermsg><svrid>9001</svrid><fromusr>wx_other</fromusr><content>引用内容</content></refermsg></appmsg><atuserlist>wx_target</atuserlist></msg>', { local_type: 49 })]
  let page = await readMessages(runtime, { chat_ids: [chatId(scope, session)], range: fixedRange, format: 'compact', max_chars: 4000 })
  const messages: any[] = []
  let pages = 0
  while (true) {
    assert.equal(page.data.format, 'compact')
    assert.ok(Array.from(JSON.stringify(page)).length <= 4000)
    messages.push(...page.data.messages as any[])
    if (!page.coverage?.next_cursor) break
    const cursor = page.coverage.next_cursor
    page = await readMessages(runtime, { cursor })
    assert.deepEqual(await readMessages(runtime, { cursor }), page)
    assert.ok(++pages < 30)
  }
  assert.equal(messages.filter(message => message[4] === 'text').map(message => message[5]).join(''), original)
  assert.equal(messages.find(message => message[4] === 'voice')[6].attachment.availability, 'unknown')
  const quote = messages.find(message => message[4] === 'quote')
  assert.equal(quote[6].quote.text, '引用内容')
  assert.deepEqual(quote[6].mentions.person_ids, [personId(scope, 'wx_target')])
  assert.equal(page.coverage?.scan_complete, true)
})

async function exportTestRoot(t: { after(fn: () => Promise<void>): void }) {
  const parent = resolve('.runtime/mcp-unit-exports')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('conversation cleaning preserves bodies, duplicates, identity, mentions, quotes and media', async () => {
  clearCursors()
  const runtime = new FakeRuntime(), session = 'room@chatroom', reader = new ConversationTools(runtime)
  const body = 'wf1_这是正文中的编号；提交 a1b2c3；订单 123456；🙂\n保留换行'
  runtime.rows[session] = [row(session, 0, body), row(session, 1, body, { sender_username: 'wx_other' }),
    row(session, 2, '<msg><appmsg><title>收到</title><type>57</type><refermsg><svrid>9000</svrid><chatusr>wx_sender</chatusr><content>wf1_引用原文</content></refermsg></appmsg></msg>', { local_type: 49 }),
    row(session, 3, '@所有人 @张三', { source: '<atuserlist>wx_sender,notify@all</atuserlist>' }),
    row(session, 4, '', { local_type: 34 })]
  const call = runtime.call.bind(runtime)
  runtime.call = async (method, payload) => method === 'getDisplayNames'
    ? { success: true, map: { [session]: '测试群', wx_sender: '同名', wx_other: '同名' } } : call(method, payload)
  const args = { chat_ids: [chatId(scope, session)], range: fixedRange, max_chars: 20000 }
  const original: any = await readMessages(runtime, args)
  const cleaned: any = await reader.read(args)
  assert.deepEqual(cleaned.data.messages.map((m: any) => m.text), original.data.messages.map((m: any) => m.text))
  assert.equal(cleaned.data.messages.length, 5)
  assert.equal(cleaned.data.messages[0].sender, cleaned.data.messages[1].sender)
  assert.notEqual(cleaned.data.messages[0].sender_ref, cleaned.data.messages[1].sender_ref)
  assert.equal(cleaned.data.messages[2].quote.ref, cleaned.data.messages[0].ref)
  assert.equal(cleaned.data.messages[2].quote.text, 'wf1_引用原文')
  assert.equal(cleaned.data.messages[3].mentions.everyone, true)
  assert.equal(cleaned.data.messages[3].mentions.people[0], '同名')
  assert.equal(cleaned.data.messages[4].media.kind, 'voice')
  assert.match(cleaned.data.messages[4].media.note, /尚未读取/)
  assert.ok(JSON.stringify(cleaned).length < JSON.stringify(original).length)
  const analysis: any = await reader.read({ ...args, mode: 'analysis' })
  assert.equal(analysis.data.people[analysis.data.messages[0].sender].display_name, '同名')
  assert.equal(analysis.data.messages[0].type, 'text')
})

for (const mode of ['analysis', 'reading'] as const) {
test(`clean ${mode} pages use the response budget and preserve every message body`, async () => {
  clearCursors()
  const runtime = new FakeRuntime(), session = 'room@chatroom', reader = new ConversationTools(runtime)
  runtime.rows[session] = Array.from({ length: 1000 }, (_, n) => row(session, n, `消息 ${n}：${'中文🙂原文'.repeat(30)}`))
  const bodies = new Map<string, string>()
  let page: any = await reader.read({ chat_ids: [chatId(scope, session)], range: fixedRange, mode, max_chars: 120_000 })
  let pages = 0
  while (true) {
    const size = Array.from(JSON.stringify(page)).length
    assert.ok(size <= 120_000)
    assert.equal(page.data.mode, mode)
    for (const message of page.data.messages) bodies.set(message.ref, (bodies.get(message.ref) || '') + message.text)
    if (!page.coverage.has_more) break
    assert.ok(size >= 108_000, `non-final ${mode} page only used ${size} of 120000 characters`)
    page = await reader.read({ cursor: page.coverage.next_cursor })
    assert.ok(++pages < 10)
  }
  assert.ok(pages > 0)
  assert.equal(page.coverage.scan_complete, true)
  assert.deepEqual([...bodies.values()], runtime.rows[session].map(message => message.message_content))
})

test(`clean ${mode} pagination and context preserve Unicode text, budgets, replay, mode, timezones and media lookup`, async () => {
  clearCursors()
  const runtime = new FakeRuntime(), session = 'room@chatroom', reader = new ConversationTools(runtime)
  const long = '中文🙂\n'.repeat(2000)
  runtime.rows[session] = [row(session, 0, '开头'), row(session, 1, long), row(session, 2, '结束')]
  let page: any = await reader.read({ chat_ids: [chatId(scope, session)], range: fixedRange, mode, timezone: 'America/New_York', max_chars: 4000 })
  assert.ok(Array.from(JSON.stringify(page)).length <= 4000)
  const all = [...page.data.messages]
  let count = 0
  while (page.coverage.has_more) {
    const cursor = page.coverage.next_cursor
    page = await reader.read({ cursor })
    assert.deepEqual(await reader.read({ cursor }), page)
    assert.ok(Array.from(JSON.stringify(page)).length <= 4000)
    assert.equal(page.data.mode, mode)
    assert.equal(page.timezone, 'America/New_York')
    assert.match(page.data.messages[0].time, /-04:00$/)
    all.push(...page.data.messages)
    assert.ok(++count < 30)
  }
  const target = conversationRef(messageId(scope, session, runtime.rows[session][1]))
  assert.equal(all.filter(m => m.ref === target).map(m => m.text).join(''), long)
  assert.equal(all.at(-1).text, '结束')
  let context: any = await reader.context({ message_refs: [target], before: 0, after: 0, mode, include_source_ids: true, max_chars: 4000 })
  const parts = [...context.data.messages]
  while (context.coverage.has_more) {
    const cursor = context.coverage.next_cursor
    context = await reader.context({ cursor })
    assert.deepEqual(await reader.context({ cursor }), context)
    assert.ok(Array.from(JSON.stringify(context)).length <= 4000)
    assert.equal(context.data.source_ids[target], messageId(scope, session, runtime.rows[session][1]))
    parts.push(...context.data.messages)
  }
  assert.equal(parts.map(m => m.text).join(''), long)
  const after: any = await reader.read({ chat_ids: [chatId(scope, session)], after_message: target })
  assert.equal(after.data.messages[0].text, '结束')
  assert.ok(!JSON.stringify(after.coverage).includes('serverId'))
  await assert.rejects(() => reader.read({ chat_ids: [chatId(scope, session)], timezone: 'invalid/timezone' }), { code: 'INVALID_ARGUMENT' })
  reader.clear()
  await assert.rejects(() => reader.context({ message_refs: [target] }), { code: 'REFERENCE_EXPIRED' })
  await assert.rejects(() => reader.context({ message_refs: [target], references_file: resolve('.runtime/missing-references.jsonl') }), { code: 'ENOENT' })
})
}

test('clean export streams full records and restores exported references after restart', async t => {
  const root = await exportTestRoot(t), runtime = new FakeRuntime(), session = 'room@chatroom', reader = new ConversationTools(runtime)
  runtime.rows[session] = Array.from({ length: 1100 }, (_, n) => row(session, n, n === 0 ? '正文哈希 abc123🙂\n'.repeat(2000) : `消息 ${n}`))
  const args = { chat_ids: [chatId(scope, session)], range: fixedRange, output_dir: root, mode: 'analysis', timezone: 'America/New_York' }
  const output: any = await reader.export(args, root)
  assert.equal(output.success, true)
  assert.equal(output.data.message_count, 1100)
  const records = (await readFile(output.data.files.jsonl.path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  const refs = (await readFile(output.data.files.references.path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(records.map(m => m.text), runtime.rows[session].map(r => r.message_content))
  assert.equal(refs.length, records.length)
  assert.equal(new Set(refs.map(r => r.ref)).size, 1100)
  assert.ok(!JSON.stringify(records).includes('wf1_'))
  const transcript = await readFile(output.data.files.transcript.path, 'utf8')
  assert.ok(transcript.includes(records[0].text))
  assert.ok(!transcript.includes('wf1_'))
  const manifest = JSON.parse(await readFile(output.data.files.manifest.path, 'utf8'))
  assert.equal(manifest.status, 'complete')
  assert.equal(manifest.cleaning.body_preserved, true)
  assert.equal(manifest.timezone, args.timezone)
  const restarted = new ConversationTools(runtime)
  const context: any = await restarted.context({ message_refs: [refs[1099].ref], references_file: output.data.files.references.path, before: 0, after: 0, include_source_ids: true })
  assert.equal(context.data.messages[0].text, '消息 1099')
  assert.equal(context.data.source_ids[refs[1099].ref], refs[1099].message_id)
  assert.equal(runtime.closedCursors, 1)
})

test('clean export retains partial files and explicit cancellation or stale-data failure', async t => {
  const root = await exportTestRoot(t), session = 'room@chatroom'
  for (const reason of ['cancel', 'stale']) {
    const runtime = new FakeRuntime(), reader = new ConversationTools(runtime), controller = new AbortController()
    runtime.rows[session] = Array.from({ length: 1500 }, (_, n) => row(session, n, `原文 ${n}`))
    const output: any = await reader.export({ chat_ids: [chatId(scope, session)], range: fixedRange, output_dir: root }, root, controller.signal, async () => {
      if (reason === 'cancel') controller.abort()
      else runtime.getFreshness = async () => ({ ...fresh, revision_end: 2 })
    })
    assert.equal(output.success, false)
    assert.equal(output.data.status, reason === 'cancel' ? 'cancelled' : 'failed')
    assert.equal(output.coverage.scan_complete, false)
    assert.equal(output.data.message_count, 1000)
    assert.equal(JSON.parse(await readFile(output.data.files.manifest.path, 'utf8')).status, output.data.status)
    assert.equal((await readFile(output.data.files.references.path, 'utf8')).trimEnd().split('\n').length, 1000)
    assert.equal(runtime.closedCursors, 1)
  }
})

test('export streams 10000 messages from multiple chats in order with complete long text and original metadata', async t => {
  const root = await exportTestRoot(t), runtime = new FakeRuntime(), a = 'first@chatroom', b = 'second@chatroom'
  const longText = '保留长原文🙂\n'.repeat(4000)
  runtime.rows[a] = Array.from({ length: 5000 }, (_, n) => row(a, n * 2, n === 20 ? longText : `a ${n}`))
  runtime.rows[b] = Array.from({ length: 5000 }, (_, n) => row(b, n * 2 + 1, n === 0 ? '' : `b ${n}`, n === 0 ? { local_type: 34 } : {}))
  const args = { chat_ids: [chatId(scope, a), chatId(scope, b)], range: fixedRange, output_dir: root }
  const output: any = await exportMessages(runtime, args, root)
  assert.equal(output.success, true)
  assert.equal(output.data.message_count, 10_000)
  assert.equal(output.coverage.scan_complete, true)
  const messages = (await readFile(output.data.files.jsonl.path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  assert.equal(messages.length, 10_000)
  assert.equal(new Set(messages.map(message => message.id)).size, 10_000)
  assert.deepEqual(messages.map(message => message.sent_at), [...messages.map(message => message.sent_at)].sort())
  assert.equal(messages[40].text, longText)
  assert.equal(messages[40].text_complete, true)
  assert.equal(messages[40].text_part, null)
  assert.equal(messages[1].attachment.availability, 'unknown')
  assert.equal(runtime.fetchedBatches, 10)
  assert.equal(runtime.closedCursors, 2)
  const transcript = await readFile(output.data.files.transcript.path, 'utf8')
  assert.ok(transcript.includes(longText))
  assert.ok(transcript.includes(messages[40].id))
  const manifest = JSON.parse(await readFile(output.data.files.manifest.path, 'utf8'))
  assert.equal(manifest.status, 'complete')
  assert.equal(manifest.message_count, 10_000)
  assert.ok(manifest.people[personId(scope, 'wx_sender')])
  const filtered: any = await exportMessages(runtime, { ...args, types: ['voice'], direction: 'desc' }, root)
  assert.notEqual(filtered.data.output_dir, output.data.output_dir)
  assert.equal(filtered.data.message_count, 1)
  assert.equal(filtered.coverage.scan_complete, true)
})

test('cancelled export retains readable partial files and marks them incomplete', async t => {
  const root = await exportTestRoot(t), runtime = new FakeRuntime(), session = 'room@chatroom', controller = new AbortController()
  runtime.rows[session] = Array.from({ length: 2500 }, (_, n) => row(session, n, `消息 ${n}`))
  const output: any = await exportMessages(runtime, { chat_ids: [chatId(scope, session)], range: fixedRange, output_dir: root }, root, controller.signal,
    async () => { controller.abort() })
  assert.equal(output.success, false)
  assert.equal(output.data.status, 'cancelled')
  assert.equal(output.data.message_count, 1000)
  assert.equal(output.coverage.scan_complete, false)
  assert.equal((await readFile(output.data.files.jsonl.path, 'utf8')).trimEnd().split('\n').length, 1000)
  assert.equal(JSON.parse(await readFile(output.data.files.manifest.path, 'utf8')).status, 'cancelled')
  assert.equal(runtime.closedCursors, 1)
})

test('export never reports complete when the data version changes during reading', async t => {
  const root = await exportTestRoot(t), runtime = new FakeRuntime(), session = 'room@chatroom'
  runtime.rows[session] = Array.from({ length: 2500 }, (_, n) => row(session, n, `消息 ${n}`))
  const output: any = await exportMessages(runtime, { chat_ids: [chatId(scope, session)], range: fixedRange, output_dir: root }, root, undefined,
    async () => { runtime.getFreshness = async () => ({ ...fresh, revision_end: 2 }) })
  assert.equal(output.success, false)
  assert.equal(output.error.code, 'CURSOR_STALE')
  assert.equal(output.data.message_count, 1000)
  assert.equal(output.coverage.scan_complete, false)
  assert.equal(JSON.parse(await readFile(output.data.files.manifest.path, 'utf8')).status, 'failed')
  assert.equal(runtime.closedCursors, 1)
})
