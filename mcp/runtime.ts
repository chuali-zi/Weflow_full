import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { LocalBackendClient } from '../electron/services/localBackendClient'
import { isProfileLocked } from '../shared/profileLock'
import { accountScope, personId } from '../shared/chat/ids'

export type RuntimeOptions = { userData: string; dataDir?: string; mode?: 'live' | 'snapshot'; timezone?: string; resourcesPath?: string }
export type Connection = { accountId: string; accountScope: string; dataDir: string; mode: 'live' | 'snapshot'; capturedAt?: string; snapshotId?: string }
export type Freshness = { mode: 'live' | 'snapshot' | 'unconnected'; queried_at: string; connection_id: string | null; revision_start: number | null; revision_end: number | null; snapshot_id: string | null; captured_at: string | null; consistency: 'per_database' | 'fixed_snapshot' | 'unknown' }

export function runtimeError(code: string, message: string, action?: string): Error & { code: string; action?: string } {
  return Object.assign(new Error(message), { code, action })
}
export function defaultUserData(): string { return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'WeFlow-full') }

export class McpRuntime {
  readonly timezone: string
  readonly options: RuntimeOptions
  readonly resourcesPath: string
  private backend: LocalBackendClient
  private connection: Connection | null = null
  private connecting: Promise<Connection> | null = null
  private revision: number | null = null
  private connectionId: string | null = null
  private listeners = new Set<() => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private requestId = 0
  private closed = false
  private modeSource = 'default'

  constructor(options: RuntimeOptions) {
    this.options = { ...options, userData: resolve(options.userData) }
    this.resourcesPath = options.resourcesPath || resolve(__dirname, '..')
    const timezone = options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); this.timezone = timezone } catch { throw runtimeError('INVALID_TIMEZONE', '请输入有效的 IANA 时区。') }
    this.backend = new LocalBackendClient(join(this.options.userData, 'backend'), this.resourcesPath, Boolean(process.env.WEFLOW_BACKEND_ROOT))
    this.backend.onEvent(event => {
      const payload = event.payload as Record<string, any> | undefined
      if (!payload) return
      if (event.type === 'change' || (event.type === 'connection-status' && payload.connectionId !== this.connectionId)) this.invalidate()
      if (typeof payload.revision === 'number') this.revision = payload.revision
      if (typeof payload.connectionId === 'string') this.connectionId = payload.connectionId
    })
  }

  private invalidate(): void { for (const listener of this.listeners) listener() }
  onInvalidate(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  checkProfile(): void {
    const file = join(this.options.userData, 'WeFlow-config.json')
    if (!existsSync(file)) {
      this.invalidate(); this.connection = null; this.backend.dispose()
      throw runtimeError('PROFILE_NOT_PREPARED', '此配置尚未准备，请先运行 WeFlow prepare。', '通过现有 WeFlow 启动或 prepare 流程准备账号。')
    }
    let value: Record<string, unknown>
    try {
      value = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    } catch { this.invalidate(); this.connection = null; this.backend.dispose(); throw runtimeError('PROFILE_CONFIG_INVALID', 'WeFlow 配置格式无效，请先修复配置。') }
    if (isProfileLocked(value)) {
      this.invalidate(); this.connection = null; this.backend.dispose()
      throw runtimeError('PROFILE_LOCKED', '此配置启用了应用锁，独立 MCP 无法继承 GUI 解锁状态。', '使用已准备的独立配置，或在 WeFlow 设置中关闭应用锁。')
    }
  }

  async call<T = any>(method: string, payload: Record<string, any> = {}, signal?: AbortSignal, timeoutMs = 2000): Promise<T> {
    const run = async () => {
      if (this.closed) throw runtimeError('CANCELLED', 'MCP 服务已关闭。')
      if (signal?.aborted) throw runtimeError('CANCELLED', '操作已取消。')
      this.checkProfile()
      const result = await this.backend.call<any>(method, { ...payload, timeoutMs }, undefined, ++this.requestId, { timeoutMs: timeoutMs + 2000, signal })
      this.checkProfile()
      if (result?.success === false) throw runtimeError(String(result.code || 'BACKEND_ERROR'), String(result.error || '本地读取失败。').replace(/[a-f\d]{64}/gi, '[已隐藏]'), typeof result.action === 'string' ? result.action : undefined)
      return result as T
    }
    const pending = this.queue.then(run, run)
    this.queue = pending.catch(() => undefined)
    return pending
  }

  async ensureConnected(signal?: AbortSignal): Promise<Connection> {
    this.checkProfile()
    if (this.connection) return this.connection
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const selection = await this.call<any>('getPreparedSelection', { ...(this.options.dataDir ? { dataDir: this.options.dataDir } : {}) }, signal, 10000)
      const mode = this.options.mode || selection.savedMode || 'live'
      this.modeSource = this.options.mode ? 'argument' : selection.savedMode ? 'saved' : 'default'
      const opened = await this.call<any>('openPreparedData', { accountDir: selection.dataDir, mode }, signal, 10000)
      const owner = String(opened.accountId || selection.accountId || '')
      if (!owner || !selection.dataDir) throw runtimeError('ACCOUNT_REQUIRED', '无法确定已准备的微信账号。')
      const connection: Connection = { accountId: owner, accountScope: accountScope(owner), dataDir: selection.dataDir, mode, capturedAt: opened.capturedAt, snapshotId: opened.snapshotId }
      this.connection = connection
      const status = await this.call<any>('getConnectionStatus', {}, signal)
      this.connectionId = status.connectionId || null
      this.revision = typeof status.revision === 'number' ? status.revision : null
      return connection
    })()
    try { return await this.connecting } catch (error) { this.connection = null; throw error } finally { this.connecting = null }
  }

  async getFreshness(signal?: AbortSignal): Promise<Freshness> {
    const connection = await this.ensureConnected(signal)
    const status = await this.call<any>('getConnectionStatus', {}, signal)
    if (status.state === 'disconnected') {
      this.connection = null
      this.invalidate()
      await this.ensureConnected(signal)
      return this.getFreshness(signal)
    }
    const revision = typeof status.revision === 'number' ? status.revision : null
    const connectionId = status.connectionId || null
    if (this.connectionId !== connectionId || this.revision !== revision) this.invalidate()
    this.connectionId = connectionId; this.revision = revision
    return { mode: connection.mode, queried_at: new Date().toISOString(), connection_id: connectionId, revision_start: revision, revision_end: revision, snapshot_id: connection.snapshotId || null, captured_at: connection.capturedAt || null, consistency: connection.mode === 'live' ? 'per_database' : 'fixed_snapshot' }
  }

  async getStatus(signal?: AbortSignal): Promise<Record<string, any>> {
    try {
      const connection = await this.ensureConnected(signal)
      const freshness = await this.getFreshness(signal)
      const state = await this.call<any>('getConnectionStatus', {}, signal)
      return { schema_version: '1', success: true, account: { id: connection.accountScope, self_id: personId(connection.accountScope, connection.accountId) }, timezone: this.timezone,
        data: { state: state.state, configured_account: connection.accountScope, self: personId(connection.accountScope, connection.accountId), mode_selection_source: this.modeSource,
          capabilities: { text: true, quotes: true, compact_messages: true, message_export: 'local_files', local_images: 'on_demand', live: connection.mode === 'live', complete_group_members: false, voice_transcription: false, ocr: false }, recovery_actions: [] },
        coverage: null, freshness, warnings: [], error: null }
    } catch (caught) {
      const error = caught as Error & { code?: string; action?: string }
      return { schema_version: '1', success: false, account: null, timezone: this.timezone, data: { state: 'unconnected', recovery_actions: error.action ? [error.action] : [] }, coverage: null,
        freshness: { mode: 'unconnected', queried_at: new Date().toISOString(), connection_id: null, revision_start: null, revision_end: null, snapshot_id: null, captured_at: null, consistency: 'unknown' }, warnings: [],
        error: { code: error.code || 'BACKEND_ERROR', message: error.message, retryable: false, action: error.action || '检查 WeFlow 的账号准备与配置。' } }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.backend.cancel(this.requestId)
    this.invalidate(); this.listeners.clear()
    this.backend.dispose()
    this.connection = null
  }
}
