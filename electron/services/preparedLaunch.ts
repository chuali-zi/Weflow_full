import { dirname, join, resolve } from 'path'
import { mkdirSync } from 'fs'
import type { ConfigService } from './config'
import { LocalBackendClient } from './localBackendClient'

type BridgeResult = {
  success: boolean
  mode?: 'snapshot' | 'live'
  code?: string
  error?: string
  action?: string
  details?: Record<string, unknown>
  dataDir?: string
  dbPath?: string
  accountId?: string
  sessionCount?: number
}

function failure(result: any, fallback = '本地解密准备失败。'): BridgeResult {
  const code = typeof result?.code === 'string' ? result.code : 'PREPARE_FAILED'
  const error = String(result?.error || result?.message || fallback).replace(/[a-f\d]{64}/gi, '[已隐藏]')
  const action = String(result?.action || result?.hint || '').replace(/[a-f\d]{64}/gi, '[已隐藏]')
  const details: Record<string, unknown> = {}
  for (const key of ['suggestedDbPath', 'suggestedDataDir', 'missing_databases', 'candidates', 'file']) {
    if (result?.details?.[key] !== undefined) details[key] = result.details[key]
  }
  return { success: false, code, error, ...(action ? { action } : {}), ...(Object.keys(details).length ? { details } : {}) }
}

function cleanDataDir(value: string): string {
  const dataDir = resolve(String(value || '').trim())
  if (!value || dataDir === dirname(dataDir)) throw new Error('请提供具体的 db_storage 目录。')
  return dataDir
}

export async function configurePreparedLaunch(
  config: ConfigService,
  userDataPath: string,
  resourcesPath: string,
  requestedDataDir: string,
  requestedMode: 'snapshot' | 'live' = 'snapshot'
): Promise<BridgeResult> {
  let backend: LocalBackendClient | null = null
  try {
    if (config.isLockMode() && !config.isUnlocked()) {
      return { success: false, code: 'PROFILE_LOCKED', error: '此 WeFlow 配置启用了应用锁，命令行无法继承 GUI 的解锁状态。请使用独立的 --user-data 配置目录，或在原 GUI 设置中关闭应用锁后重试。' }
    }
    const dataDir = cleanDataDir(requestedDataDir)
    const mode = requestedMode === 'live' ? 'live' : 'snapshot'
    backend = new LocalBackendClient(join(userDataPath, 'backend'), resourcesPath)
    // connectionConfig is deliberately an internal bridge. Its key is only
    // consumed here and is never returned by the CLI.
    const connection = await backend.call<any>(mode === 'live' ? 'connectionConfig' : 'snapshotConfig', { dataDir, mode })
    if (!connection?.success) return failure(connection, mode === 'live' ? '没有找到可用的在线数据库连接。' : '没有找到已准备的聊天记录副本。')
    const accountId = String(connection.accountId || '').trim()
    const decryptKey = String(connection.key || connection.decryptKey || '').trim()
    const dbPath = String(connection.dbPath || '').trim()
    if (!accountId || !dbPath || !/^[a-f\d]{64}$/i.test(decryptKey)) {
      return { success: false, code: mode === 'live' ? 'CONNECTION_CONFIG_INVALID' : 'SNAPSHOT_CONFIG_INVALID',
        error: mode === 'live' ? '在线连接缺少有效的账号、密钥或数据根目录。' : '记录副本缺少有效的账号、密钥或数据根目录。' }
    }

    const opened = await backend.call<any>('open', { accountDir: dataDir, mode, ...(decryptKey ? { hexKey: decryptKey } : {}) })
    if (opened !== true && !(opened && typeof opened === 'object' && opened.success === true)) {
      if (opened && typeof opened === 'object' && opened.success === false) {
        return failure(opened, mode === 'live' ? '无法打开在线数据库连接。' : '无法打开已准备的聊天记录副本。')
      }
      const initError = await backend.call<any>('getLastInitError').catch(() => null)
      return failure(typeof initError === 'string' ? { code: 'OPEN_FAILED', error: initError } : opened,
        mode === 'live' ? '无法打开在线数据库连接。' : '无法打开已准备的聊天记录副本。')
    }
    const sessions = await backend.call<any>('getSessions', { mode })
    if (!sessions?.success || !Array.isArray(sessions.sessions)) {
      return failure(sessions, '聊天会话验证失败。')
    }

    const configuredCachePath = String(config.get('cachePath') || '').trim()
    if (!configuredCachePath) {
      const defaultCachePath = join(userDataPath, 'cache')
      mkdirSync(defaultCachePath, { recursive: true })
      config.set('cachePath', defaultCachePath)
    }

    const accountConfigs = config.get('accountConfigs') || {}
    const previousAccountConfig = accountConfigs[accountId] || {}
    config.set('dbPath', dbPath)
    // Keep the authenticated contact key inside the existing ConfigService
    // bridge; it is never returned in the CLI result.
    config.set('decryptKey', decryptKey)
    config.set('myAccountId', accountId)
    config.set('accountConfigs', {
      ...accountConfigs,
      [accountId]: { ...previousAccountConfig, decryptKey, updatedAt: Date.now() }
    })
    config.set('wcdbLibPath', '')
    config.set('keyProviderPath', '')
    config.set('onboardingDone', true)

    // Persist the selected mode only after every ConfigService write above
    // succeeds. A failed bridge must leave the previous mode untouched.
    const modeResult = await backend.call<any>('setReadMode', { dataDir, mode })
    if (modeResult && typeof modeResult === 'object' && modeResult.success === false) {
      return failure(modeResult, mode === 'live' ? '在线读取模式验证失败。' : '离线读取模式验证失败。')
    }

    return { success: true, code: 'CONFIGURED', mode, dataDir, dbPath, accountId, sessionCount: sessions.sessions.length }
  } catch (error) {
    return failure({ code: 'PREPARE_FAILED', error: error instanceof Error ? error.message : String(error) })
  } finally {
    if (backend) {
      try { await backend.call('shutdown') } catch { /* backend may already have exited */ }
      await backend.closeGracefully().catch(() => undefined)
    }
  }
}
