import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, chmod, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { parse, stringify } from 'smol-toml'
import { McpClientSetupService, discoverMcpCli } from '../electron/services/mcpClientSetup'
import { buildMcpLaunch } from '../shared/mcpLaunch'
import { checkMcpConnection } from '../shared/mcpConnectionCheck'
import type { McpClientId, McpLaunchConfig, McpConnectionCheck } from '../shared/mcpSetup'

const passed = (): McpConnectionCheck => ({ success: true, checks: { transport_connected: true, tools_listed: true, data_readable: true } })
async function fixture(t: any, client: McpClientId, segment = '中文 用户 & % ! (测试)') {
  const home = await mkdtemp(join(tmpdir(), 'weflow-setup-'))
  t.after(async () => { if (dirname(home) === resolve(tmpdir())) await rm(home, { recursive: true, force: true }) })
  const base = join(home, segment)
  await mkdir(base, { recursive: true })
  const profile = join(base, 'profile')
  const configDir = join(base, 'client')
  const configFile = join(configDir, client === 'codex' ? 'config.toml' : '.claude.json')
  const launch: McpLaunchConfig = { command: process.execPath,
    args: [join(base, 'server.cjs'), '--user-data', profile, '--data-dir', join(base, 'db_storage'), '--mode', 'snapshot'],
    env: { ELECTRON_RUN_AS_NODE: '1', WEFLOW_PYTHON: join(base, 'python.exe'), NODE_OPTIONS: '', PYTHONHOME: '' } }
  const checked: McpLaunchConfig[] = []
  const context = () => ({ launch, profile, mode: 'snapshot' as const, account: 'fixture-account' })
  const service = new McpClientSetupService({ userData: profile, home, env: {}, context,
    check: async value => { checked.push(structuredClone(value)); return passed() } })
  const target = { client, configDir }
  const decode = (raw: string): any => client === 'codex' ? structuredClone(parse(raw)) : JSON.parse(raw)
  const encode = (doc: any) => client === 'codex' ? stringify(doc) : JSON.stringify(doc)
  const rootKey = client === 'codex' ? 'mcp_servers' : 'mcpServers'
  const read = async () => decode(await readFile(configFile, 'utf8'))
  const put = async (doc: any) => { await mkdir(configDir, { recursive: true }); await writeFile(configFile, encode(doc)) }
  return { home, base, profile, configDir, configFile, launch, checked, context, service, target, rootKey, read, put }
}

for (const client of ['codex', 'claude'] as const) {
  test(`${client}: install, read back, repeat, check and remove using special-character paths`, async t => {
    const f = await fixture(t, client)
    const result = await f.service.install(f.target)
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(result.changed, true)
    assert.equal(result.name, 'weflow')
    assert.deepEqual(f.checked, [f.launch, f.launch], 'verify the actual saved command after preflight')
    const first = await readFile(f.configFile, 'utf8')
    assert.deepEqual((await f.read())[f.rootKey].weflow.args, f.launch.args)
    assert.equal((await f.service.install(f.target)).changed, false)
    assert.equal(await readFile(f.configFile, 'utf8'), first)
    assert.equal((await f.service.check(f.target, 'weflow')).success, true)
    const removed = await f.service.remove(f.target, 'weflow')
    assert.equal(removed.success, true)
    assert.ok(removed.backup)
    assert.equal(await readFile(removed.backup!, 'utf8'), first)
    assert.deepEqual((await f.read())[f.rootKey], {})
    assert.equal((await f.service.inspect(f.target)).inspection?.registrations.length, 0)
  })

  test(`${client}: preserve unrelated fields and name collisions`, async t => {
    const f = await fixture(t, client)
    const foreign = { command: 'another-app', args: ['do-not-touch'], env: { FIXTURE: 'example' } }
    const original = { model: 'fixture-model', permissions: { custom: true }, nested: { values: [1, 2, 3] },
      [f.rootKey]: { weflow: foreign, 'weflow-local': foreign, unrelated: { url: 'https://example.invalid/mcp' } } }
    await f.put(original)
    const result = await f.service.install(f.target)
    assert.equal(result.name, 'weflow-local-2')
    assert.equal(result.success, true)
    const after = await f.read()
    delete after[f.rootKey]['weflow-local-2']
    assert.deepEqual(after, original)
    assert.equal((await f.service.remove(f.target, 'weflow')).success, false)
    assert.equal((await f.service.remove(f.target, result.name!)).success, true)
    assert.deepEqual(await f.read(), original)
  })

  test(`${client}: do not execute or remove an externally changed registration`, async t => {
    const f = await fixture(t, client)
    await f.service.install(f.target)
    const edited = await f.read()
    edited[f.rootKey].weflow.env.USER_CHANGE = 'keep'
    await f.put(edited)
    const before = await readFile(f.configFile, 'utf8')
    const count = f.checked.length
    assert.equal((await f.service.check(f.target, 'weflow')).code, 'REGISTRATION_CHANGED')
    assert.equal(f.checked.length, count)
    assert.equal((await f.service.remove(f.target, 'weflow')).code, 'REGISTRATION_CHANGED')
    assert.equal(await readFile(f.configFile, 'utf8'), before)
    const installed = await f.service.install(f.target)
    assert.equal(installed.name, 'weflow-local')
    assert.deepEqual((await f.read())[f.rootKey].weflow, edited[f.rootKey].weflow)
  })

  test(`${client}: malformed config remains byte-for-byte unchanged`, async t => {
    const f = await fixture(t, client)
    await mkdir(f.configDir, { recursive: true })
    const raw = client === 'codex' ? '[mcp_servers.weflow\nbroken' : '{"mcpServers":'
    await writeFile(f.configFile, raw)
    assert.equal((await f.service.install(f.target)).code, 'CONFIG_INVALID')
    assert.equal(await readFile(f.configFile, 'utf8'), raw)
    assert.equal((await f.service.inspect(f.target)).code, 'CONFIG_INVALID')
  })

  test(`${client}: failed preflight never writes a client config`, async t => {
    const f = await fixture(t, client)
    const service = new McpClientSetupService({ userData: f.profile, home: f.home, env: {}, context: f.context,
      check: async () => ({ ...passed(), success: false, error: { code: 'PROFILE_LOCKED', message: 'locked' } }) })
    assert.equal((await service.install(f.target)).code, 'PREFLIGHT_FAILED')
    assert.equal(existsSync(f.configFile), false)
  })

  test(`${client}: retain a valid registration when the later data check fails`, async t => {
    const f = await fixture(t, client)
    let calls = 0
    const service = new McpClientSetupService({ userData: f.profile, home: f.home, env: {}, context: f.context,
      check: async () => ++calls === 1 ? passed() : { ...passed(), success: false, error: { code: 'SOURCE_REPLACED', message: 'source changed' } } })
    const result = await service.install(f.target)
    assert.equal(result.code, 'REGISTERED_CHECK_FAILED')
    assert.ok((await f.read())[f.rootKey].weflow)
    assert.equal((await service.inspect(f.target)).inspection?.registrations[0].managed, true)
  })

  test(`${client}: simultaneous clicks are serialized and create one registration`, async t => {
    const f = await fixture(t, client)
    const results = await Promise.all([f.service.install(f.target), f.service.install(f.target), f.service.install(f.target)])
    assert.ok(results.every(result => result.success))
    assert.deepEqual(results.map(result => result.changed), [true, false, false])
    assert.deepEqual(Object.keys((await f.read())[f.rootKey]), ['weflow'])
  })

  test(`${client}: custom config home and UTF-8 BOM are supported`, async t => {
    const f = await fixture(t, client)
    await f.put({ [f.rootKey]: {} })
    await writeFile(f.configFile, '\uFEFF' + await readFile(f.configFile, 'utf8'))
    const env = client === 'codex' ? { CODEX_HOME: f.configDir } : { CLAUDE_CONFIG_DIR: f.configDir }
    const service = new McpClientSetupService({ userData: f.profile, home: f.home, env, context: f.context, check: async () => passed() })
    const installed = await service.install({ client })
    assert.equal(installed.success, true)
    assert.equal(installed.inspection?.configFile, f.configFile)
  })

  test(`${client}: repair an owned old runtime path while preserving client policy`, async t => {
    const f = await fixture(t, client)
    await f.service.install(f.target)
    const changed = await f.read()
    changed[f.rootKey].weflow.enabled = false
    changed[f.rootKey].weflow.disabled_tools = ['export_messages']
    await f.put(changed)
    // Reuse a matching existing connection and adopt its explicit policy.
    const other = new McpClientSetupService({ userData: join(f.base, 'setup-state-2'), home: f.home, env: {}, context: f.context, check: async () => passed() })
    assert.equal((await other.install(f.target)).success, true)
    f.launch.command = join(f.base, 'new-runtime.exe')
    const result = await other.install(f.target)
    assert.equal(result.name, 'weflow')
    const entry = (await f.read())[f.rootKey].weflow
    assert.equal(entry.command, f.launch.command)
    assert.equal(entry.enabled, false)
    assert.deepEqual(entry.disabled_tools, ['export_messages'])
    assert.ok(result.notices?.some(value => value.includes('禁用')))
  })
}

test('reject relative config homes and shell script executables', async t => {
  const f = await fixture(t, 'codex')
  assert.equal((await f.service.install({ client: 'codex', configDir: 'relative' })).code, 'PATH_INVALID')
  if (process.platform === 'win32') assert.equal((await f.service.install({ ...f.target, cliPath: join(f.base, 'codex.cmd') })).code, 'CLI_INVALID')
  assert.equal(existsSync(f.configFile), false)
})

test('an active config lock is respected and a dead process lock is recovered', async t => {
  const f = await fixture(t, 'claude')
  await mkdir(f.configDir, { recursive: true })
  const lock = `${f.configFile}.weflow-lock`
  await writeFile(lock, String(process.pid))
  assert.equal((await f.service.install(f.target)).code, 'SETUP_BUSY')
  await writeFile(lock, '2147483647')
  assert.equal((await f.service.install(f.target)).success, true)
  assert.equal(existsSync(lock), false)
})

test('a concurrent external config write is preserved', async t => {
  const f = await fixture(t, 'claude')
  await f.put({ mcpServers: {} })
  // Exercise the write boundary directly: another application changed the file
  // after it was read, before the atomic replacement.
  const before = await readFile(f.configFile, 'utf8')
  const external = '{"external":"keep","mcpServers":{}}'
  await writeFile(f.configFile, external)
  await assert.rejects((f.service as any).replace(f.configFile, before, '{"mcpServers":{"weflow":{}}}'), { code: 'CONFIG_CHANGED' })
  assert.equal(await readFile(f.configFile, 'utf8'), external)
  assert.ok(!(await readdir(f.configDir)).some(name => name.endsWith('.tmp')))
})

test('damaged ownership state is not silently reset', async t => {
  const f = await fixture(t, 'claude')
  await mkdir(join(f.profile, 'mcp-client-setup'), { recursive: true })
  await writeFile(join(f.profile, 'mcp-client-setup', 'registrations.json'), '{bad')
  assert.equal((await f.service.install(f.target)).code, 'STATE_INVALID')
  assert.equal(existsSync(f.configFile), false)
})

test('read-only configuration failure leaves the original intact', async t => {
  const f = await fixture(t, 'claude')
  await f.put({ mcpServers: {} })
  const before = await readFile(f.configFile, 'utf8')
  await chmod(f.configFile, 0o444)
  t.after(() => chmod(f.configFile, 0o600).catch(() => {}))
  const result = await f.service.install(f.target)
  assert.equal(result.success, false)
  assert.equal(await readFile(f.configFile, 'utf8'), before)
})

test('launch generation pins project Python and clears inherited runtime overrides', async t => {
  const f = await fixture(t, 'codex')
  await mkdir(join(f.base, '.venv', 'Scripts'), { recursive: true })
  await writeFile(join(f.base, '.venv', 'Scripts', 'python.exe'), '')
  await writeFile(join(f.base, 'server.cjs'), '')
  const config = buildMcpLaunch({ executable: process.execPath, serverPath: join(f.base, 'server.cjs'), userData: f.profile, sourceRoot: f.base, mode: 'live' })
  assert.equal(config.env.WEFLOW_PYTHON, join(f.base, '.venv', 'Scripts', 'python.exe'))
  assert.equal(config.env.NODE_OPTIONS, '')
  assert.equal(config.env.PYTHONHOME, '')
  assert.equal(config.env.NODE_PATH, '')
  assert.ok(config.args.includes(f.profile))
  assert.throws(() => buildMcpLaunch({ executable: 'missing.exe', serverPath: join(f.base, 'server.cjs'), userData: f.profile, sourceRoot: f.base }))
})

test('a config directory junction is updated through its real target', async t => {
  const f = await fixture(t, 'claude')
  await mkdir(f.configDir, { recursive: true })
  const alias = join(f.base, 'client-alias')
  await symlink(f.configDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const result = await f.service.install({ client: 'claude', configDir: alias })
  assert.equal(result.success, true, JSON.stringify(result))
  assert.ok((await f.read()).mcpServers.weflow)
  assert.equal((await f.service.remove({ client: 'claude', configDir: alias }, 'weflow')).success, true)
})

test('long client config paths work independently of the snapshot backend path limit', async t => {
  const f = await fixture(t, 'claude')
  const configDir = join(f.base, ...Array(8).fill('long-client-directory-123456789'))
  assert.ok(configDir.length > 260)
  const result = await f.service.install({ client: 'claude', configDir })
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(JSON.parse(await readFile(join(configDir, '.claude.json'), 'utf8')).mcpServers.weflow.command, f.launch.command)
})

test('packaged launch requires bundled backend and sets package module paths', async t => {
  const f = await fixture(t, 'codex')
  const resources = join(f.base, 'resources')
  const server = join(resources, 'mcp', 'server.cjs')
  await mkdir(dirname(server), { recursive: true })
  await writeFile(server, '')
  const input = { executable: process.execPath, serverPath: server, userData: f.profile, resourcesPath: resources }
  assert.throws(() => buildMcpLaunch(input), /后端缺失/)
  await mkdir(join(resources, 'backend'), { recursive: true })
  await writeFile(join(resources, 'backend', 'weflow-backend.exe'), '')
  const config = buildMcpLaunch(input)
  assert.equal(config.env.WEFLOW_PYTHON, '')
  assert.equal(config.env.WEFLOW_BACKEND_ROOT, '')
  assert.ok(config.env.NODE_PATH.includes('app.asar.unpacked'))
})

test('real MCP and native clients round-trip in isolated config homes', { skip: process.env.WEFLOW_SETUP_INTEGRATION !== '1', timeout: 120000 }, async t => {
  const f = await fixture(t, 'codex')
  const root = resolve(__dirname, '../..')
  const python = [join(root, '.venv/Scripts/python.exe'), join(root, '.runtime/python/python.exe')].find(existsSync)
  assert.ok(python, 'prepare project Python first')
  // Snapshot fixtures append database hashes and UUIDs; keep their root short
  // enough for the current Python snapshot backend's Windows path limit.
  await mkdir(join(root, '.runtime'), { recursive: true })
  const syntheticRoot = await mkdtemp(join(root, '.runtime', 'ms-'))
  t.after(async () => { if (dirname(syntheticRoot) === join(root, '.runtime')) await rm(syntheticRoot, { recursive: true, force: true }) })
  const fixtureOutput = execFileSync(python, ['python/tests/create_mcp_fixture.py', syntheticRoot], {
    cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONPATH: join(root, 'python') }, timeout: 60000,
  })
  const data = JSON.parse(fixtureOutput)
  const launch = buildMcpLaunch({ executable: process.execPath, serverPath: join(root, 'build/mcp/server.cjs'),
    userData: data.userDataPath, dataDir: data.dataDir, mode: 'snapshot', sourceRoot: root })
  const previousEnv = Object.fromEntries(['NODE_OPTIONS', 'PYTHONHOME', 'PYTHONPATH', 'WEFLOW_PYTHON', 'WEFLOW_BACKEND_ROOT'].map(key => [key, process.env[key]]))
  try {
    process.env.NODE_OPTIONS = '--require missing-startup-module'
    process.env.PYTHONHOME = join(f.base, 'wrong-python')
    process.env.PYTHONPATH = join(f.base, 'wrong-modules')
    process.env.WEFLOW_PYTHON = join(f.base, 'wrong-python.exe')
    process.env.WEFLOW_BACKEND_ROOT = join(f.base, 'wrong-backend')
    assert.equal((await checkMcpConnection(launch, f.base)).success, true, 'minimal PATH, foreign cwd, poisoned parent environment, explicit runtime')
    if (process.platform === 'win32') {
      const printed = require('cross-spawn').sync(join(root, 'weflow-mcp.cmd'), ['--print-config', '--user-data', data.userDataPath,
        '--data-dir', data.dataDir, '--mode', 'snapshot'], { cwd: f.base, encoding: 'utf8',
        env: { ...process.env, PATH: join(process.env.SystemRoot || 'C:\\Windows', 'System32') } })
      assert.equal(printed.status, 0, printed.stderr)
      const generated = JSON.parse(printed.stdout).mcpServers.weflow
      assert.equal(generated.env.WEFLOW_PYTHON, launch.env.WEFLOW_PYTHON)
      assert.equal((await checkMcpConnection(generated, f.base)).success, true, 'source launcher survives missing PATH runtimes and poisoned environment')
    }
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
  const cli = await discoverMcpCli('codex')
  assert.ok(cli, 'native Codex is required for real-client acceptance')
  const context = () => ({ launch, profile: data.userDataPath, mode: 'snapshot' as const, account: 'synthetic' })
  const service = new McpClientSetupService({ userData: data.userDataPath, home: f.home, context, env: {} })
  await f.put({ model: 'fixture-model', mcp_servers: { unrelated: { command: 'keep' } } })
  const before = await readFile(f.configFile, 'utf8')
  await writeFile(f.configFile, '# keep this user comment\n' + before)
  const result = await service.install({ ...f.target, cliPath: cli })
  assert.equal(result.success, true, JSON.stringify(result))
  assert.ok((await readFile(f.configFile, 'utf8')).includes('# keep this user comment'))
  const readback = JSON.parse(execFileSync(cli, ['mcp', 'get', result.name!, '--json'], {
    cwd: f.base, encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_HOME: f.configDir }, timeout: 20000,
  }))
  assert.equal(readback.transport.command, launch.command)
  assert.deepEqual(readback.transport.args, launch.args)
  assert.equal((await service.remove(f.target, result.name!)).success, true)
  const claude = await discoverMcpCli('claude')
  assert.ok(claude, 'native Claude Code is required for real-client acceptance')
  const claudeDir = join(f.base, 'claude-config')
  const claudeTarget = { client: 'claude' as const, configDir: claudeDir }
  const installed = await service.install(claudeTarget)
  assert.equal(installed.success, true, JSON.stringify(installed))
  const details = execFileSync(claude, ['mcp', 'get', installed.name!], { cwd: f.base, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir }, timeout: 30000 })
  assert.ok(details.includes(launch.command), details)
  assert.ok(/Connected|connected/i.test(details), details)
  assert.equal((await service.remove(claudeTarget, installed.name!)).success, true)
  const packagedRoot = process.env.WEFLOW_SETUP_PACKAGE
  if (packagedRoot) {
    assert.ok(existsSync(join(packagedRoot, 'resources/backend/weflow-backend.exe')), 'provided package root must contain its frozen backend')
    const packaged = buildMcpLaunch({ executable: join(packagedRoot, 'WeFlow.exe'), serverPath: join(packagedRoot, 'resources/mcp/server.cjs'),
      userData: data.userDataPath, dataDir: data.dataDir, mode: 'snapshot', resourcesPath: join(packagedRoot, 'resources') })
    const packagedCheck = await checkMcpConnection(packaged, f.base)
    assert.equal(packagedCheck.success, true, 'bundled Electron and frozen backend without source Python env: ' + JSON.stringify(packagedCheck))
  }
})
