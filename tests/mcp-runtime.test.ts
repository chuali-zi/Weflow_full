import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { McpRuntime } from '../mcp/runtime'
import { LocalBackendClient } from '../electron/services/localBackendClient'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createTools } from '../mcp/tools'

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

test('a real backend exit clears the cached connection and the next read starts a new backend', async () => {
  const root = resolve('.runtime/mcp-unit')
  mkdirSync(root, { recursive: true })
  const destination = mkdtempSync(join(root, 'process-recovery-'))
  const python = resolve('.venv/Scripts/python.exe')
  const generated = spawnSync(python, ['python/tests/create_mcp_fixture.py', destination], {
    encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('python') },
  })
  assert.equal(generated.status, 0, generated.stderr)
  const fixture = JSON.parse(generated.stdout)
  const runtime = new McpRuntime({ userData: fixture.userDataPath, mode: 'snapshot' })
  const tools = createTools(runtime)
  try {
    assert.equal((await tools.call('find_chats', { limit: 1 })).structuredContent.success, true)
    const child = (runtime as any).backend.child
    const exited = once(child, 'exit')
    child.stdin.end()
    await exited
    assert.equal((runtime as any).connection, null)
    assert.equal((await tools.call('find_chats', { limit: 1 })).structuredContent.success, true)
    assert.notEqual((runtime as any).backend.child.pid, child.pid)
  } finally {
    await (runtime as any).backend.closeGracefully()
    await tools.close()
    rmSync(destination, { recursive: true, force: true })
  }
})

test('a backend read timeout discards the cached connection before reopening prepared data', async () => {
  const root = resolve('.runtime/mcp-unit')
  mkdirSync(root, { recursive: true })
  const userData = mkdtempSync(join(root, 'timeout-'))
  writeFileSync(join(userData, 'WeFlow-config.json'), '{}')
  const runtime = new McpRuntime({ userData, mode: 'snapshot' })
  let opens = 0, disposed = 0
  ;(runtime as any).backend = {
    call: async (method: string) => {
      if (method === 'getPreparedSelection') return { dataDir: root, accountId: 'wxid_me' }
      if (method === 'openPreparedData') { opens++; return { accountId: 'wxid_me' } }
      if (method === 'getConnectionStatus') return { state: 'ready', revision: 0 }
      return { success: false, code: 'LIVE_READ_TIMEOUT', error: 'synthetic timeout' }
    }, cancel: () => {}, dispose: () => { disposed++ },
  }
  try {
    await runtime.ensureConnected()
    await assert.rejects(runtime.call('getSessions'), { code: 'LIVE_READ_TIMEOUT', retryable: true })
    assert.equal(disposed, 1)
    await runtime.ensureConnected()
    assert.equal(opens, 2)
  } finally {
    await runtime.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
