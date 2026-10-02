import { join } from 'path'
import { LocalBackendClient } from './localBackendClient'
import type { RunWeliveExportOptions, WeliveExportResult } from './weliveBridge'

export async function runIntegratedExport(options: RunWeliveExportOptions): Promise<WeliveExportResult> {
  const client = new LocalBackendClient(join(options.userDataPath || process.env.WEFLOW_USER_DATA_PATH || process.cwd(), 'backend'), options.resourcesPath)
  const stop = () => client.dispose()
  options.signal?.addEventListener('abort', stop, { once: true })
  try {
    if (options.signal?.aborted) return { success: false, stopped: true, successCount: 0, failCount: 0,
      failedSessionIds: [], failedSessionErrors: {}, sessionOutputPaths: {}, rawSessionOutputPaths: {}, rawExportManifests: {} }
    options.onEvent?.({ type: 'ready', total: options.request.sessionIds.length })
    const result = await client.call('exportRaw', { request: options.request }, (message) => {
      options.onEvent?.({ type: 'progress', phase: 'reading', label: message })
    })
    if (!result.success) throw new Error([result.error, result.action].filter(Boolean).join(' '))
    options.onEvent?.({ type: 'progress', phase: 'complete', current: options.request.sessionIds.length })
    return result
  } catch (error) {
    return { success: false, stopped: options.signal?.aborted, successCount: 0,
      failCount: options.request.sessionIds.length, failedSessionIds: options.request.sessionIds,
      failedSessionErrors: {}, sessionOutputPaths: {}, rawSessionOutputPaths: {}, rawExportManifests: {},
      error: error instanceof Error ? error.message : String(error) }
  } finally {
    options.signal?.removeEventListener('abort', stop)
    client.dispose()
  }
}
