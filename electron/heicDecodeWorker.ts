import { parentPort, workerData } from 'worker_threads'
import sharp from 'sharp'

const decode = require('heic-decode') as (input: { buffer: Buffer }) => Promise<{
  width: number; height: number; data: Uint8ClampedArray
}>

async function convert() {
  try {
    const image = await decode({ buffer: Buffer.from(workerData) })
    const data = await sharp(Buffer.from(image.data), {
      raw: { width: image.width, height: image.height, channels: 4 }
    }).jpeg({ quality: 95 }).toBuffer()
    parentPort?.postMessage({ data })
  } catch {
    parentPort?.postMessage({ error: 'HEIC 图片转换失败，请等待微信完成原图下载后重试。' })
  }
}

void convert()
