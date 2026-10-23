import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { parse, stringify } from 'smol-toml'
import { checkMcpConnection } from '../../shared/mcpConnectionCheck'
import type { McpClientId, McpClientTarget, McpLaunchConfig, McpSetupInspection, McpSetupResult } from '../../shared/mcpSetup'

type ObjectMap = Record<string, any>
type Context = { launch: McpLaunchConfig; profile: string; mode: 'live' | 'snapshot'; account: string }
type ManagedEntry = { client: McpClientId; configFile: string; name: string; value: ObjectMap }
type SetupOptions = {
  userData: string
  context: () => Context | Promise<Context>
  env?: NodeJS.ProcessEnv
  home?: string
  check?: typeof checkMcpConnection
}
const object = (value: unknown): value is ObjectMap => Boolean(value && typeof value === 'object' && !Array.isArray(value))
function plain(value: any): any {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(plain)
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
  return value
}
const equal = (left: unknown, right: unknown) => isDeepStrictEqual(plain(left), plain(right))
const samePath = (left: string, right: string) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)
const fail = (code: string, message: string) => Object.assign(new Error(message), { code })

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function decode(client: McpClientId, raw?: string): ObjectMap {
  if (raw === undefined) return {}
  try {
    const value = client === 'codex' ? parse(raw.replace(/^\uFEFF/, '')) : JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (!object(value)) throw new Error()
    const root = value[client === 'codex' ? 'mcp_servers' : 'mcpServers']
    if (root !== undefined && !object(root)) throw new Error()
    return value
  } catch { throw fail('CONFIG_INVALID', '客户端配置无法解析，已保留原文件。请修复配置或选择正确的配置目录。') }
}
const servers = (client: McpClientId, doc: ObjectMap): ObjectMap => doc[client === 'codex' ? 'mcp_servers' : 'mcpServers'] || {}
function setServers(client: McpClientId, doc: ObjectMap, entries: ObjectMap): void {
  doc[client === 'codex' ? 'mcp_servers' : 'mcpServers'] = entries
}
function encode(client: McpClientId, doc: ObjectMap): string {
  return client === 'codex' ? stringify(doc) : JSON.stringify(doc, null, 2) + '\n'
}
function launchFrom(value: ObjectMap): McpLaunchConfig {
  if (!object(value) || typeof value.command !== 'string' || !isAbsolute(value.command)
    || !Array.isArray(value.args) || !value.args.every((item: unknown) => typeof item === 'string')
    || !object(value.env) || !Object.values(value.env).every(item => typeof item === 'string')) {
    throw fail('REGISTRATION_INVALID', '保存的 MCP 启动配置不完整，请重新接入。')
  }
  return { command: value.command, args: value.args, env: value.env }
}
function sameConnection(value: ObjectMap, launch: McpLaunchConfig): boolean {
  if (!object(value) || !Array.isArray(value.args) || typeof value.args[0] !== 'string') return false
  const argument = (args: string[], name: string) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const profile = argument(value.args, '--user-data')
  const targetProfile = argument(launch.args, '--user-data')
  return samePath(value.args[0], launch.args[0]) && Boolean(profile && targetProfile && samePath(profile, targetProfile))
    && argument(value.args, '--data-dir') === argument(launch.args, '--data-dir')
    && argument(value.args, '--mode') === argument(launch.args, '--mode')
}

/** Native CLI discovery never executes .cmd/.ps1 wrappers through a shell. */
export async function discoverMcpCli(client: McpClientId, env = process.env, home = homedir()): Promise<string | undefined> {
  const dirs = (env.PATH || env.Path || '').split(delimiter).map(value => value.replace(/^"|"$/g, '')).filter(Boolean)
  if (client === 'claude') dirs.unshift(join(home, '.local', 'bin'))
  const candidates = dirs.map(dir => join(dir, process.platform === 'win32' ? `${client}.exe` : client))
  if (client === 'codex' && process.platform === 'win32') {
    const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    for (const dir of [...dirs, join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm')]) {
      for (const base of [join(dir, 'node_modules', '@openai'), join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai')]) {
        candidates.push(join(base, `codex-win32-${process.arch}`, 'vendor', triple, 'codex', 'codex.exe'))
      }
      candidates.push(join(dir, 'node_modules', '@openai', 'codex', 'vendor', triple, 'codex', 'codex.exe'))
    }
    const bin = join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin')
    candidates.push(join(bin, 'codex.exe'))
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth === 0) return
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries.slice(0, 100)) {
        if (entry.isDirectory()) {
          candidates.push(join(dir, entry.name, 'codex.exe'))
          await walk(join(dir, entry.name), depth - 1)
        }
      }
    }
    await walk(bin, 3)
  }
  for (const file of candidates) {
    if (await stat(file).then(value => value.isFile()).catch(() => false)) return resolve(file)
  }
  return undefined
}

export class McpClientSetupService {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly stateDir: string
  private readonly env: NodeJS.ProcessEnv
  private readonly home: string
  constructor(private readonly options: SetupOptions) {
    this.stateDir = join(options.userData, 'mcp-client-setup')
    this.env = options.env || process.env
    this.home = options.home || homedir()
  }

  private async target(input: McpClientTarget): Promise<{ client: McpClientId; configFile: string; cliPath?: string }> {
    if (!input || !['codex', 'claude'].includes(input.client)) throw fail('CLIENT_INVALID', '请选择 Codex 或 Claude Code。')
    if (input.configDir && !isAbsolute(input.configDir)) throw fail('PATH_INVALID', '客户端配置目录必须是绝对路径。')
    if (input.cliPath && (!isAbsolute(input.cliPath) || (process.platform === 'win32' && !/\.exe$/i.test(input.cliPath)))) {
      throw fail('CLI_INVALID', '请选择客户端原生可执行文件（Windows 为 .exe），不要选择批处理或 PowerShell 脚本。')
    }
    const client = input.client
    const configDir = input.configDir || (client === 'codex' ? this.env.CODEX_HOME : this.env.CLAUDE_CONFIG_DIR)
    if (configDir && !isAbsolute(configDir)) throw fail('PATH_INVALID', '客户端配置环境变量指向相对路径，请选择其实际配置目录。')
    const configFile = client === 'codex' ? join(configDir || join(this.home, '.codex'), 'config.toml')
      : configDir ? join(configDir, '.claude.json') : join(this.home, '.claude.json')
    let resolvedFile = resolve(configFile)
    const info = await lstat(resolvedFile).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
    if (info) {
      try { resolvedFile = await realpath(resolvedFile) } catch { throw fail('CONFIG_LINK_INVALID', '客户端配置链接的目标不可访问，已保留链接。请修复后重试。') }
    } else {
      const parent = await realpath(dirname(resolvedFile)).catch(() => undefined)
      if (parent) resolvedFile = join(parent, basename(resolvedFile))
    }
    const cliPath = input.cliPath || await discoverMcpCli(client, this.env, this.home)
    if (input.cliPath && !await stat(input.cliPath).then(value => value.isFile()).catch(() => false)) throw fail('CLI_MISSING', '所选客户端程序不存在。')
    return { client, configFile: resolvedFile, cliPath }
  }

  private async loadState(): Promise<ManagedEntry[]> {
    const raw = await readOptional(join(this.stateDir, 'registrations.json'))
    if (raw === undefined) return []
    try {
      const value = JSON.parse(raw)
      if (value.version !== 1 || !Array.isArray(value.entries) || !value.entries.every((entry: any) =>
        ['codex', 'claude'].includes(entry.client) && typeof entry.configFile === 'string' && typeof entry.name === 'string' && object(entry.value))) throw new Error()
      return value.entries
    } catch { throw fail('STATE_INVALID', 'WeFlow 接入记录损坏，已保留现场。请先修复 mcp-client-setup/registrations.json。') }
  }

  private async saveState(entries: ManagedEntry[]): Promise<void> {
    await mkdir(this.stateDir, { recursive: true })
    const file = join(this.stateDir, 'registrations.json')
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify({ version: 1, entries }, null, 2), { mode: 0o600, flag: 'wx' })
      await rename(temp, file)
    } finally { await rm(temp, { force: true }) }
  }

  private async inspection(input: McpClientTarget): Promise<McpSetupInspection> {
    const target = await this.target(input)
    const context = await this.options.context()
    const doc = decode(target.client, await readOptional(target.configFile))
    const managed = await this.loadState()
    return { ...target, profile: context.profile, mode: context.mode, account: context.account,
      registrations: Object.entries(servers(target.client, doc)).filter(([name, value]) => name.startsWith('weflow') || managed.some(entry =>
        entry.client === target.client && samePath(entry.configFile, target.configFile) && entry.name === name))
        .map(([name, value]) => ({ name, enabled: value?.enabled !== false, current: sameConnection(value, context.launch),
          managed: managed.some(entry => entry.client === target.client && samePath(entry.configFile, target.configFile)
            && entry.name === name && equal(entry.value, value)) })) }
  }

  private async guard(run: () => Promise<McpSetupResult>): Promise<McpSetupResult> {
    try { return await run() } catch (error) {
      const code = (error as NodeJS.ErrnoException).code || 'SETUP_FAILED'
      const systemError = ['EACCES', 'EPERM', 'EROFS'].includes(code)
      return { success: false, code, error: systemError ? '无法写入客户端配置，请检查目录权限或文件占用。'
        : error instanceof Error ? error.message.replace(/[a-f\d]{64}/gi, '[已隐藏]') : 'MCP 接入未完成。' }
    }
  }

  inspect(input: McpClientTarget): Promise<McpSetupResult> {
    return this.guard(async () => ({ success: true, inspection: await this.inspection(input) }))
  }

  private enqueue(run: () => Promise<McpSetupResult>): Promise<McpSetupResult> {
    const result = this.queue.then(() => this.guard(run), () => this.guard(run))
    this.queue = result
    return result
  }

  private async locked<T>(file: string, run: () => Promise<T>): Promise<T> {
    await mkdir(dirname(file), { recursive: true })
    const lockPath = `${file}.weflow-lock`
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const lock = await open(lockPath, 'wx', 0o600)
        try {
          await lock.writeFile(String(process.pid))
          return await run()
        } finally { await lock.close(); await rm(lockPath, { force: true }) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const owner = Number(await readOptional(lockPath))
        let alive = true
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0) } catch (probe) { alive = (probe as NodeJS.ErrnoException).code !== 'ESRCH' }
        }
        if (alive || attempt > 0) throw fail('SETUP_BUSY', '另一个接入操作正在使用此配置，请稍后重试。')
        await rm(lockPath)
      }
    }
    throw fail('SETUP_BUSY', '配置正被使用。')
  }

  private async replace(file: string, before: string | undefined, after: string): Promise<string | undefined> {
    if (before === after) return undefined
    if (before !== undefined) await access(file, constants.W_OK)
    const backupDir = join(this.stateDir, 'backups')
    await mkdir(backupDir, { recursive: true })
    const backup = before === undefined ? undefined : join(backupDir, `${basename(file)}.${Date.now()}.${randomUUID()}.bak`)
    if (backup) await writeFile(backup, before!, { mode: 0o600, flag: 'wx' })
    const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
    try {
      const mode = await stat(file).then(value => value.mode & 0o777).catch(() => 0o600)
      await writeFile(temp, after, { mode, flag: 'wx' })
      if (await readOptional(file) !== before) throw fail('CONFIG_CHANGED', '客户端配置在接入期间发生变化，未覆盖新内容，请重试。')
      await rename(temp, file)
      if (await readOptional(file) !== after) throw fail('CONFIG_CHANGED', '客户端在写入后修改了配置，请重新检查。')
      return backup
    } finally { await rm(temp, { force: true }) }
  }

  private async codexText(cliPath: string | undefined, raw: string | undefined, name: string, launch: McpLaunchConfig, expected: ObjectMap): Promise<string> {
    if (!cliPath) return encode('codex', expected)
    // Let the official CLI edit a disposable copy. It never writes the live user's
    // file; the completed result is compared and installed atomically below.
    await mkdir(this.stateDir, { recursive: true })
    const staging = await mkdtemp(join(this.stateDir, 'codex-stage-'))
    try {
      if (raw !== undefined) await writeFile(join(staging, 'config.toml'), raw, { mode: 0o600 })
      const args = ['mcp', 'add', name, ...Object.entries(launch.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--', launch.command, ...launch.args]
      await new Promise<void>((resolveRun, reject) => {
        execFile(cliPath, args, { cwd: staging, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024,
          env: { ...this.env, CODEX_HOME: staging, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '' } }, error => error ? reject(fail('CLIENT_CLI_FAILED', 'Codex 配置命令执行失败或超时，未修改原配置。请检查客户端版本或选择正确程序。')) : resolveRun())
      })
      const generated = await readOptional(join(staging, 'config.toml'))
      // Older CLIs may discard per-server settings. Preserve those settings using
      // the parsed document instead of accepting a lossy CLI result.
      return equal(decode('codex', generated), expected) ? generated! : encode('codex', expected)
    } finally {
      if (samePath(dirname(staging), this.stateDir)) await rm(staging, { recursive: true, force: true })
    }
  }

  install(input: McpClientTarget): Promise<McpSetupResult> {
    return this.enqueue(async () => {
      const target = await this.target(input)
      const context = await this.options.context()
      const preflight = await (this.options.check || checkMcpConnection)(context.launch)
      if (!preflight.success) return { success: false, code: 'PREFLIGHT_FAILED', check: preflight,
        error: preflight.error?.message, action: preflight.error?.action }
      const written = await this.locked(target.configFile, async () => {
        const raw = await readOptional(target.configFile)
        const doc = decode(target.client, raw)
        const entries = { ...servers(target.client, doc) }
        const state = await this.loadState()
        const managedEntries = state.filter(entry => entry.client === target.client && samePath(entry.configFile, target.configFile) && equal(entries[entry.name], entry.value))
        const managed = managedEntries.find(entry => sameConnection(entry.value, context.launch)) || (managedEntries.length === 1 ? managedEntries[0] : undefined)
        const externallyChanged = (key: string) => state.some(entry => entry.client === target.client && samePath(entry.configFile, target.configFile) && entry.name === key && !equal(entry.value, entries[key]))
        let name = managed?.name || Object.keys(entries).find(key => !externallyChanged(key) && sameConnection(entries[key], context.launch)) || 'weflow'
        if (!managed && entries[name] && (externallyChanged(name) || !sameConnection(entries[name], context.launch))) {
          name = 'weflow-local'
          for (let suffix = 2; Object.hasOwn(entries, name); suffix++) name = `weflow-local-${suffix}`
        }
        const previous = entries[name]
        const desired = { ...(object(previous) ? previous : {}), ...context.launch,
          ...(target.client === 'claude' ? { type: 'stdio' } : {}) }
        const changed = !equal(previous, desired)
        entries[name] = desired
        setServers(target.client, doc, entries)
        let backup: string | undefined
        let text: string | undefined
        if (changed) {
          text = target.client === 'codex' ? await this.codexText(target.cliPath, raw, name, context.launch, doc) : encode(target.client, doc)
          if (!equal(decode(target.client, text), doc)) throw fail('SERIALIZATION_FAILED', '客户端配置序列化未通过校验，未修改原配置。')
        }
        // Persist ownership before changing the client file, so a crash after
        // rename can be recovered by a subsequent install/remove operation.
        await this.saveState([...state.filter(entry => !(entry.client === target.client && samePath(entry.configFile, target.configFile) && entry.name === name)),
          { client: target.client, configFile: target.configFile, name, value: desired }])
        if (text !== undefined) {
          try { backup = await this.replace(target.configFile, raw, text) }
          catch (error) { await this.saveState(state); throw error }
        }
        const saved = servers(target.client, decode(target.client, await readOptional(target.configFile)))[name]
        if (!equal(saved, desired)) throw fail('READBACK_FAILED', '配置回读与写入内容不一致，请重试。')
        return { name, changed, backup, saved }
      })
      const check = await (this.options.check || checkMcpConnection)(launchFrom(written.saved))
      const notices = this.restrictions(target.client, written.saved)
      if (!target.cliPath) notices.push('未检测到客户端原生 CLI；已按客户端格式保存配置，请在实际使用的客户端中确认加载。')
      return { success: check.success, code: check.success ? 'REGISTERED' : 'REGISTERED_CHECK_FAILED', ...written, saved: undefined,
        check, reloadRequired: true, inspection: await this.inspection(input).catch(() => undefined), notices,
        ...(!check.success ? { error: check.error?.message, action: check.error?.action } : {}) }
    })
  }

  private restrictions(client: McpClientId, entry: ObjectMap): string[] {
    const notes = ['独立连接检查不代表客户端已有会话已加载；请在目标客户端重新加载 MCP 或新开会话。']
    if (entry.enabled === false) notes.push('此服务在客户端配置中被禁用；已保留该选择，请在客户端启用后使用。')
    if (client === 'codex' && (entry.enabled_tools || entry.disabled_tools)) notes.push('此服务存在客户端工具筛选设置；实际可用工具以客户端为准。')
    return notes
  }

  private async owned(input: McpClientTarget, name: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name || '')) throw fail('NAME_INVALID', '无效的服务名称。')
    const target = await this.target(input)
    const raw = await readOptional(target.configFile)
    const doc = decode(target.client, raw)
    const entry = servers(target.client, doc)[name]
    const state = await this.loadState()
    const owned = state.find(item => item.client === target.client && samePath(item.configFile, target.configFile) && item.name === name)
    if (!owned || !equal(owned.value, entry)) throw fail('REGISTRATION_CHANGED', '此条目未由当前 WeFlow 管理，或已被外部修改。已保留原配置，可重新接入生成独立条目。')
    return { target, raw, doc, entry, state }
  }

  check(input: McpClientTarget, name: string): Promise<McpSetupResult> {
    return this.enqueue(async () => {
      const { entry, target } = await this.owned(input, name)
      const check = await (this.options.check || checkMcpConnection)(launchFrom(entry))
      return { success: check.success, name, check, reloadRequired: true,
        notices: this.restrictions(target.client, entry), inspection: await this.inspection(input),
        ...(!check.success ? { error: check.error?.message, action: check.error?.action } : {}) }
    })
  }

  remove(input: McpClientTarget, name: string): Promise<McpSetupResult> {
    return this.enqueue(async () => {
      const target = await this.target(input)
      return this.locked(target.configFile, async () => {
        const { raw, doc, state } = await this.owned(input, name)
        const entries = { ...servers(target.client, doc) }
        delete entries[name]
        setServers(target.client, doc, entries)
        const backup = await this.replace(target.configFile, raw, encode(target.client, doc))
        await this.saveState(state.filter(entry => !(entry.client === target.client && samePath(entry.configFile, target.configFile) && entry.name === name)))
        return { success: true, name, changed: true, backup, reloadRequired: true, inspection: await this.inspection(input).catch(() => undefined),
          notices: ['已移除所选 MCP 配置。请在客户端重新加载；WeFlow 账号与数据已保留。'] }
      })
    })
  }
}
