import assert from 'node:assert/strict'
import test from 'node:test'
import { accountScope, chatId, personId } from '../shared/chat/ids'
import { clearCursors, findChats, getChatOverview, getGroupMembers, getMessageContext, readMessages } from '../mcp/query'
import { createTools } from '../mcp/tools'

const scope = accountScope('wxid_me')
const chat = chatId(scope, 'room@chatroom')
function runtime() {
  let revision = 1
  const members = [
    { username: 'wxid_me', nickname: '自己', remark: '私人备注', groupNickname: '', groupNicknameState: 'not_set' },
    { username: 'wxid_quiet', nickname: '小张', remark: '', groupNickname: '2026001 张同学', groupNicknameState: 'set' },
    { username: 'wxid_unknown', nickname: '', remark: '', groupNickname: null, groupNicknameState: 'unknown' },
  ]
  return {
    timezone: 'UTC', options: {},
    ensureConnected: async () => ({ accountId: 'wxid_me', accountScope: scope, dataDir: 'fixture', mode: 'live' as const }),
    getFreshness: async () => ({ mode: 'live' as const, queried_at: '2026-10-24T12:00:00Z', connection_id: 'fixture', revision_start: revision, revision_end: revision, snapshot_id: null, captured_at: null, consistency: 'per_database' as const }),
    getStatus: async () => ({}), close: async () => {},
    call: async (method: string) => { assert.equal(method, 'getGroupMembers'); return { success: true, members } },
    change: () => { revision++ },
  }
}

test('group roster pages preserve names, unknowns, full-group counts and replay', async () => {
  clearCursors()
  const r = runtime()
  const first = await getGroupMembers(r, { chat_id: chat, limit: 1 })
  assert.deepEqual(first.data.summary, { total: 3, set: 1, not_set: 1, unknown: 1 })
  assert.equal(first.data.matched_count, 3)
  assert.deepEqual((first.data.members as any[])[0], {
    person_id: personId(scope, 'wxid_me'), nickname: '自己', contact_remark: '私人备注',
    group_nickname: '', group_nickname_status: 'not_set', is_self: true,
  })
  const args = { cursor: first.coverage!.next_cursor }
  for (const other of [findChats, getChatOverview, getMessageContext, readMessages]) {
    await assert.rejects(other(r, args), { code: 'INVALID_ARGUMENT' })
  }
  const next = await getGroupMembers(r, args)
  assert.deepEqual(await getGroupMembers(r, args), next)
  assert.equal((next.data.members as any[])[0].group_nickname, '2026001 张同学')
  const last = await getGroupMembers(r, { cursor: next.coverage!.next_cursor })
  assert.equal(last.coverage!.has_more, false)
  assert.equal((last.data.members as any[])[0].group_nickname, null)
  r.change()
  await assert.rejects(getGroupMembers(r, args), { code: 'CURSOR_STALE' })
})

test('group nickname filtering retains full summary and rejects invalid scopes', async () => {
  const r = runtime()
  const filtered = await getGroupMembers(r, { chat_id: chat, nickname_status: 'not_set' })
  assert.equal((filtered.data.members as any[]).length, 1)
  assert.equal(filtered.data.matched_count, 1)
  assert.equal((filtered.data.summary as any).total, 3)
  await assert.rejects(getGroupMembers(r, { chat_id: chatId(scope, 'wxid_peer') }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(getGroupMembers(r, { chat_id: chatId(accountScope('other'), 'room@chatroom') }))
  await assert.rejects(getGroupMembers(r, { cursor: 'token', chat_id: chat }), { code: 'INVALID_ARGUMENT' })
  const tools = createTools(r as any)
  try {
    for (const args of [{}, { chat_id: chat, nickname_status: 'changed' }, { chat_id: chat, limit: 0 }]) {
      const reply = await tools.call('get_group_members', args)
      assert.equal((reply.structuredContent.error as any).code, 'INVALID_ARGUMENT')
    }
  } finally { await tools.close() }
})
