import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { LocalBackendClient } from '../electron/services/localBackendClient'
import { McpRuntime } from '../mcp/runtime'

const root = resolve('.runtime/mcp-resilience')
mkdirSync(root, { recursive: true })

test('seeded transport fuzz ignores non-response frames without killing the client', { timeout: 15000 }, async () => {
  const previous = { root: process.env.WEFLOW_BACKEND_ROOT, python: process.env.WEFLOW_PYTHON }
  process.env.WEFLOW_BACKEND_ROOT = resolve('tests/fixtures/fault-backend')
  process.env.WEFLOW_PYTHON = resolve('.venv/Scripts/python.exe')
  const client = new LocalBackendClient(root, '', true)
  try {
    let seed = 0x57ef10
    const junk = ['null', '[]', 'true', '42', '"text"', '{broken', '{}', '{"id":-1,"result":null}', '{"type":"change","payload":null}']
    for (let i = 0; i < 100; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const frames = [junk[i % junk.length], junk[seed % junk.length]]
      assert.equal((await client.call('fuzz', { frames }, undefined, undefined, { timeoutMs: 1000 })).success, true)
    }
    const first = await client.call('pid')
    await assert.rejects(client.call('malformed', { malformed: true }), { code: 'BACKEND_PROTOCOL_ERROR' })
    assert.notEqual((await client.call('recovered')).pid, first.pid)
    await assert.rejects(client.call('exit', { exit: true }), { code: 'BACKEND_EXITED' })
    assert.equal((await client.call('recovered')).success, true)
    await assert.rejects(client.call('hang', { hang: true }, undefined, undefined, { timeoutMs: 100 }), { code: 'LIVE_READ_TIMEOUT', retryable: true })
    assert.equal((await client.call('recovered')).success, true)
    const child = (client as any).child
    const exited = once(child, 'exit')
    child.kill()
    await exited
    assert.equal((await client.call('recovered')).success, true)
  } finally {
    await client.closeGracefully()
    client.dispose()
    for (const [key, value] of [['WEFLOW_BACKEND_ROOT', previous.root], ['WEFLOW_PYTHON', previous.python]]) {
      if (value === undefined) delete process.env[key!]
      else process.env[key!] = value
    }
  }
})

test('unready status never reports success and persistent disconnect has bounded recovery', async () => {
  const profile = mkdtempSync(join(root, 'status-'))
  writeFileSync(join(profile, 'WeFlow-config.json'), '{}')
  try {
    for (const state of ['disconnected', 'reconnecting', 'needs_key', 'unknown']) {
      const runtime = new McpRuntime({ userData: profile })
      let opens = 0
      ;(runtime as any).backend = {
        call: async (method: string) => {
          if (method === 'getPreparedSelection') return { dataDir: root, accountId: 'synthetic' }
          if (method === 'openPreparedData') {
            // Stop a buggy infinite reconnect loop without hanging the test runner.
            if (++opens > 4) throw Object.assign(new Error('reconnect loop'), { code: 'TEST_RECONNECT_LOOP' })
            return { accountId: 'synthetic' }
          }
          return { state, revision: 0 }
        }, cancel: () => {}, dispose: () => {},
      }
      try {
        const status = await runtime.getStatus()
        assert.equal(status.success, false, state)
        assert.ok(opens <= 2, `unbounded reconnect for ${state}: ${opens}`)
        assert.equal(status.error.code, state === 'needs_key' ? 'KEY_NOT_FOUND' : 'NOT_CONNECTED')
        assert.ok(status.data.recovery_actions.length > 0)
      } finally { await runtime.close() }
    }
  } finally { rmSync(profile, { recursive: true, force: true }) }
})

test('status detects a disconnect between freshness and its final readiness check', async () => {
  const profile = mkdtempSync(join(root, 'race-'))
  writeFileSync(join(profile, 'WeFlow-config.json'), '{}')
  const runtime = new McpRuntime({ userData: profile })
  let checks = 0
  ;(runtime as any).backend = {
    call: async (method: string) => method === 'getPreparedSelection' ? { dataDir: root, accountId: 'synthetic' }
      : method === 'openPreparedData' ? { accountId: 'synthetic' }
        : { state: ++checks < 3 ? 'ready' : 'disconnected', revision: 0 },
    cancel: () => {}, dispose: () => {},
  }
  try { assert.equal((await runtime.getStatus()).success, false) }
  finally { await runtime.close(); rmSync(profile, { recursive: true, force: true }) }
})
