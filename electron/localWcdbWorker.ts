import { parentPort } from 'worker_threads'
import { join } from 'path'
import { LocalBackendClient } from './services/localBackendClient'

let client: LocalBackendClient | null = null
let lastError: string | null = null
let queue = Promise.resolve()
const describeError = (result: any): string => {
  const parts = [result?.code, result?.message || result?.error, result?.hint || result?.action]
    .filter((value) => typeof value === 'string' && value.trim())
  if (result?.details && typeof result.details === 'object') {
    const detail = Object.entries(result.details)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
      .join('; ')
    if (detail) parts.push(detail)
  }
  return parts.join('\n') || '本地数据库操作失败。'
}
parentPort?.on('message', (message: any) => {
  queue = queue.then(async () => {
    const { id, type, payload = {} } = message
    try {
      let result: any
      if (type === 'setPaths') {
        client?.dispose()
        client = new LocalBackendClient(join(payload.userDataPath || process.env.WEFLOW_USER_DATA_PATH || process.cwd(), 'backend'), payload.resourcesPath)
        result = { success: true }
      } else if (type === 'setLibPath') {
        result = String(payload.libPath || '').trim()
          ? { success: false, error: '已配置外部 WCDB 库，应该使用原生 WCDB Worker。' }
          : { success: true }
      } else if (type === 'setLogEnabled') {
        result = { success: true }
      } else if (['setMonitor', 'cloudInit', 'cloudReport', 'cloudStop'].includes(type)) {
        result = { success: false, error: '内置离线后端不支持实时监控或云端数据收集。' }
      } else if (type === 'getLastInitError') {
        result = lastError
      } else {
        client ||= new LocalBackendClient(join(process.env.WEFLOW_USER_DATA_PATH || process.cwd(), 'backend'))
        result = await client.call(type, payload)
        if (result?.success === false) {
          lastError = describeError(result)
          // Existing WeFlow renderers read `error` directly. Keep the structured
          // fields too, and include the action/details in the legacy string so
          // directory suggestions and exit instructions remain visible.
          result = { ...result, error: lastError }
          if (type === 'open') result = false
        } else if (type === 'open' && result === true) {
          lastError = null
        }
      }
      parentPort!.postMessage({ id, result })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      parentPort!.postMessage({ id, result: type === 'open' ? false : { success: false, error: lastError, code: 'BACKEND_TRANSPORT_ERROR' } })
    }
  }).catch((error) => { lastError = String(error) })
})
parentPort?.on('close', () => client?.dispose())
process.on('exit', () => client?.dispose())
