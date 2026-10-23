import test from 'node:test'
import assert from 'node:assert/strict'
import { initialAgentToolNames, resolveAgentToolRequest } from '../electron/services/agentToolCatalog'

test('chat and auto runs can discover and read conversations on their first step', () => {
  for (const source of ['auto', 'chat'] as const) {
    const names = initialAgentToolNames(source)
    assert.ok(names.has('list_conversation_manifest'))
    assert.ok(names.has('read_raw_messages'))
    assert.ok(names.has('read_memory'))
    assert.ok(!names.has('web_search'))
  }
})

test('web and moments runs do not expose chat reading outside their source', () => {
  for (const source of ['web', 'moments'] as const) {
    const names = initialAgentToolNames(source, 'web_search')
    assert.ok(!names.has('list_conversation_manifest'))
    assert.ok(!names.has('read_raw_messages'))
    assert.equal(names.has('web_search'), source === 'web')
  }
  assert.ok(initialAgentToolNames('auto', 'web_search').has('web_search'))
  assert.ok(!initialAgentToolNames('chat', 'web_search').has('web_search'))
})

test('loading an optional capability preserves the initial reading tools', () => {
  const initial = initialAgentToolNames('auto')
  const result = resolveAgentToolRequest(initial, ['search_raw_messages', 'missing_tool'], [
    ...initial, 'search_raw_messages',
  ])
  assert.deepEqual(result.newlyEnabled, ['search_raw_messages'])
  assert.deepEqual(result.rejectedTools, ['missing_tool'])
  for (const name of initial) assert.ok(result.enabledTools.includes(name))
})
