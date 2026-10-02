import { parentPort } from 'worker_threads'
import { join } from 'path'
import { LocalBackendClient } from './services/localBackendClient'

let client: LocalBackendClient | null = null
let lastError: string | null = null
let queue = Promise.resolve()
parentPort?.on('message', (message: any) => {
  queue = queue.then(async () => {
    const { id, type, payload = {} } = message
    try {
      let result: any
      if (type === 'setPaths') {
        client?.dispose()
        client = new LocalBackendClient(join(payload.userDataPath || process.env.WEFLOW_USER_DATA_PATH || process.cwd(), 'backend'), payload.resourcesPath)
        result = { success: true }
      } else if (['setLibPath', 'setLogEnabled', 'setMonitor', 'cloudInit', 'cloudReport', 'cloudStop'].includes(type)) {
        result = { success: true }
      } else if (type === 'getLastInitError') {
        result = lastError
      } else {
        client ||= new LocalBackendClient(join(process.env.WEFLOW_USER_DATA_PATH || process.cwd(), 'backend'))
        result = await client.call(type, payload)
        if (result?.success === false) {
          lastError = [result.error, result.action].filter(Boolean).join(' ')
          if (type === 'open') result = false
        } else if (type === 'open' && result === true) {
          lastError = null
        }
      }
      parentPort!.postMessage({ id, result })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      parentPort!.postMessage({ id, result: type === 'open' ? false : { success: false, error: lastError } })
    }
  }).catch((error) => { lastError = String(error) })
})
parentPort?.on('close', () => client?.dispose())
process.on('exit', () => client?.dispose())
