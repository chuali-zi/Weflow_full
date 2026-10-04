import assert from 'node:assert/strict'
import test from 'node:test'
import { chatId, personId, accountScope } from '../shared/chat/ids'
import { hydrateNames } from '../mcp/names'
import type { NormalizedMessage } from '../shared/chat/normalize'

const accountId = 'wxid_self'
const scope = accountScope(accountId)
const chat = chatId(scope, 'room@chatroom')
const self = personId(scope, accountId)
const sender = personId(scope, 'wxid_alice')
const quoted = personId(scope, 'wxid_bob')
const mentioned = personId(scope, 'wxid_carol')

const message = {
  chat_id: chat,
  sender_id: sender,
  quote: { target_id: null, sender_id: quoted, text: 'quote', state: 'snapshot_only' },
  mentions: { state: 'known', person_ids: [mentioned], everyone: false }
} as NormalizedMessage

test('hydrates only IDs present in messages and uses raw IDs as fallback', async () => {
  const calls: Array<{ method: string; payload: Record<string, unknown>; timeoutMs?: number }> = []
  const result = await hydrateNames({
    call: async (method, payload, _signal, timeoutMs) => {
      calls.push({ method, payload: payload || {}, timeoutMs })
      return { success: true, map: { 'room@chatroom': 'Team room', wxid_alice: 'Alice', wxid_self: 'Me' } }
    }
  }, { accountId, accountScope: scope }, [message, { ...message, sender_id: self }], [chat, chatId(scope, 'wxid_unmatched')])

  assert.deepEqual(result.chats[chat], { display_name: 'Team room', kind: 'group' })
  assert.deepEqual(result.chats[chatId(scope, 'wxid_unmatched')], { display_name: 'wxid_unmatched', kind: 'private' })
  assert.deepEqual(result.people[self], { display_name: 'Me', is_self: true })
  assert.deepEqual(result.people[sender], { display_name: 'Alice', is_self: false })
  assert.deepEqual(result.people[quoted], { display_name: 'wxid_bob', is_self: false })
  assert.deepEqual(result.people[mentioned], { display_name: 'wxid_carol', is_self: false })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'getDisplayNames')
  assert.equal(calls[0].timeoutMs, 2000)
  assert.deepEqual(new Set(calls[0].payload.usernames as string[]), new Set(['room@chatroom', 'wxid_unmatched', accountId, 'wxid_alice', 'wxid_bob', 'wxid_carol']))
})

test('propagates cancellation and profile errors from the runtime', async () => {
  const cancelled = Object.assign(new Error('cancelled'), { code: 'CANCELLED' })
  await assert.rejects(hydrateNames({ call: async () => { throw cancelled } }, { accountId, accountScope: scope }, [message]), error => error === cancelled)

  const locked = Object.assign(new Error('locked'), { code: 'PROFILE_LOCKED' })
  await assert.rejects(hydrateNames({ call: async () => { throw locked } }, { accountId, accountScope: scope }, [message]), error => error === locked)
})
