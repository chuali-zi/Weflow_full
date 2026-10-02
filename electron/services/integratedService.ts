import { app } from 'electron'
import { join } from 'path'
import { ConfigService } from './config'
import { LocalBackendClient } from './localBackendClient'
import { wcdbService } from './wcdbService'

let client: LocalBackendClient | null = null
export function integratedClient(): LocalBackendClient {
  if (!client) {
    client = new LocalBackendClient(join(app.getPath('userData'), 'backend'))
    app.once('before-quit', () => client?.dispose())
  }
  return client
}
export async function activateIntegratedSnapshot(dataDir: string): Promise<any> {
  const result = await integratedClient().call('snapshotConfig', { dataDir })
  if (!result.success) return result
  await wcdbService.close()
  const config = new ConfigService()
  config.set('dbPath', result.dbPath)
  config.set('myAccountId', result.accountId)
  config.set('decryptKey', result.key)
  const accounts = config.get('accountConfigs') || {}
  config.set('accountConfigs', { ...accounts, [result.accountId]: { ...accounts[result.accountId], decryptKey: result.key, updatedAt: Date.now() } })
  config.set('onboardingDone', true)
  return { success: true, accountId: result.accountId, capturedAt: result.capturedAt }
}
