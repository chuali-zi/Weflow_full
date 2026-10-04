import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { McpRuntime } from '../mcp/runtime'
import { LocalBackendClient } from '../electron/services/localBackendClient'

test('unprepared, damaged and locked profiles fail before launching a backend', async () => {
  const root = resolve('.runtime/mcp-unit')
  mkdirSync(root, { recursive: true })
  const userData = mkdtempSync(join(root, 'profile-'))
  const runtime = new McpRuntime({ userData, timezone: 'America/New_York' })
  try {
    assert.equal((await runtime.getStatus()).error.code, 'PROFILE_NOT_PREPARED')
    writeFileSync(join(userData, 'WeFlow-config.json'), '{broken')
    assert.equal((await runtime.getStatus()).error.code, 'PROFILE_CONFIG_INVALID')
    for (const field of ['decryptKey', 'aiModelApiKey', 'aiModelProfilesJson']) {
      writeFileSync(join(userData, 'WeFlow-config.json'), JSON.stringify({ [field]: 'lock:synthetic' }))
      assert.equal((await runtime.getStatus()).error.code, 'PROFILE_LOCKED')
    }
  } finally {
    await runtime.close()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('an already cancelled backend request does not start the child process', async () => {
  const client = new LocalBackendClient('unused')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(client.call('getSessions', {}, undefined, undefined, { signal: controller.signal }), { code: 'CANCELLED' })
  client.dispose()
})

test('freshness reconnects prepared data after the backend process loses its connection', async () => {
  const root = resolve('.runtime/mcp-unit')
  mkdirSync(root, { recursive: true })
  const userData = mkdtempSync(join(root, 'reconnect-'))
  writeFileSync(join(userData, 'WeFlow-config.json'), '{}')
  const runtime = new McpRuntime({ userData, mode: 'snapshot', timezone: 'UTC' })
  let connected = false, opens = 0
  ;(runtime as any).backend = {
    call: async (method: string) => {
      if (method === 'getPreparedSelection') return { success: true, dataDir: root, accountId: 'wxid_me' }
      if (method === 'openPreparedData') { opens++; connected = true; return { success: true, accountId: 'wxid_me', snapshotId: 'synthetic' } }
      if (method === 'getConnectionStatus') return { success: true, state: connected ? 'ready' : 'disconnected', revision: 0 }
      assert.fail(`unexpected ${method}`)
    }, cancel: () => {}, dispose: () => {}
  }
  try {
    await runtime.ensureConnected()
    connected = false
    assert.equal((await runtime.getFreshness()).mode, 'snapshot')
    assert.equal(opens, 2)
  } finally {
    await runtime.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
