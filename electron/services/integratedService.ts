import { app } from 'electron'
import { join } from 'path'
import { LocalBackendClient } from './localBackendClient'

let client: LocalBackendClient | null = null
export function integratedClient(): LocalBackendClient {
  if (!client) {
    client = new LocalBackendClient(join(app.getPath('userData'), 'backend'))
    app.once('before-quit', () => client?.dispose())
  }
  return client
}
