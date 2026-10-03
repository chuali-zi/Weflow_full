import { dirname, join, resolve } from 'path'
import { mkdirSync } from 'fs'
import type { ConfigService } from './config'
import { LocalBackendClient } from './localBackendClient'

type BridgeResult = {
  success: boolean
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
  requestedDataDir: string
): Promise<BridgeResult> {
  let backend: LocalBackendClient | null = null
  try {
    if (config.isLockMode() && !config.isUnlocked()) {
      return { success: false, code: 'PROFILE_LOCKED', error: '此 WeFlow 配置启用了应用锁，命令行无法继承 GUI 的解锁状态。请使用独立的 --user-data 配置目录，或在原 GUI 设置中关闭应用锁后重试。' }
    }
    const dataDir = cleanDataDir(requestedDataDir)
    backend = new LocalBackendClient(join(userDataPath, 'backend'), resourcesPath)
    const snapshot = await backend.call<any>('snapshotConfig', { dataDir })
    if (!snapshot?.success) return failure(snapshot, '没有找到已准备的聊天记录副本。')
    const accountId = String(snapshot.accountId || '').trim()
    const decryptKey = String(snapshot.key || '').trim()
    const dbPath = String(snapshot.dbPath || '').trim()
    if (!accountId || !/^[a-f\d]{64}$/i.test(decryptKey) || !dbPath) {
      return { success: false, code: 'SNAPSHOT_CONFIG_INVALID', error: '记录副本缺少有效的账号、密钥或数据根目录。' }
    }

    const opened = await backend.call<any>('open', { accountDir: dataDir })
    if (opened !== true) {
      if (opened && typeof opened === 'object' && opened.success === false) {
        return failure(opened, '无法打开已准备的聊天记录副本。')
      }
      const initError = await backend.call<any>('getLastInitError').catch(() => null)
      return failure(typeof initError === 'string' ? { code: 'OPEN_FAILED', error: initError } : opened,
        '无法打开已准备的聊天记录副本。')
    }
    const sessions = await backend.call<any>('getSessions')
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
    config.set('decryptKey', decryptKey)
    config.set('myAccountId', accountId)
    config.set('accountConfigs', {
      ...accountConfigs,
      [accountId]: { ...previousAccountConfig, decryptKey, updatedAt: Date.now() }
    })
    config.set('wcdbLibPath', '')
    config.set('keyProviderPath', '')
    config.set('onboardingDone', true)

    return { success: true, code: 'CONFIGURED', dataDir, dbPath, accountId, sessionCount: sessions.sessions.length }
  } catch (error) {
    return failure({ code: 'PREPARE_FAILED', error: error instanceof Error ? error.message : String(error) })
  } finally {
    if (backend) {
      try { await backend.call('shutdown') } catch { /* backend may already have exited */ }
      await backend.closeGracefully().catch(() => undefined)
    }
  }
}
