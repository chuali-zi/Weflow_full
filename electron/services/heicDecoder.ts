import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'

export function isHeic(data: Buffer): boolean {
  if (data.length < 16 || data.toString('ascii', 4, 8) !== 'ftyp') return false
  const end = Math.min(data.length, data.readUInt32BE(0))
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    if (offset === 12) continue // minor version, not a compatible brand
    if (['heic', 'heix', 'hevc', 'hevx'].includes(data.toString('ascii', offset, offset + 4))) return true
  }
  return false
}

// HEIC decoding is CPU intensive; keep it outside Electron's main thread.
export function heicToJpeg(data: Buffer): Promise<Buffer> {
  const workerPath = [join(__dirname, 'heicDecodeWorker.js'), join(__dirname, '../dist-electron/heicDecodeWorker.js')]
    .find(path => existsSync(path))
  if (!workerPath) return Promise.reject(new Error('HEIC 图片转换组件缺失，请重新安装应用。'))
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: data })
    let settled = false
    const finish = (error?: Error, result?: Uint8Array) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      if (error) reject(error)
      else if (result) resolve(Buffer.from(result))
    }
    const timer = setTimeout(() => finish(new Error('HEIC 图片转换超时，请重试。')), 60_000)
    worker.once('message', (result: { data?: Uint8Array; error?: string }) => {
      finish(result.error ? new Error(result.error) : result.data ? undefined : new Error('HEIC 转换没有生成图片。'), result.data)
    })
    worker.once('error', error => finish(error))
    worker.once('exit', code => {
      if (!settled) finish(new Error(`HEIC 图片转换进程已退出 (${code})。`))
    })
  })
}
