import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import sharp from 'sharp'
import { decodeMessageId } from '../shared/chat/ids'
import { mapRowsToMessagesLite } from '../shared/chat/decode'
import { normalizeMessage } from '../shared/chat/normalize'
import { decryptDatV3, decryptDatV4, datVersion } from '../shared/chat/imageDecrypt'
import { heicToJpeg, isHeic } from '../electron/services/heicDecoder'

type Locator = ReturnType<typeof decodeMessageId>
type Runtime = {
  ensureConnected(signal?: AbortSignal): Promise<{ accountId: string; accountScope: string; dataDir: string; mode: string; capturedAt?: string; snapshotId?: string }>
  call(method: string, payload?: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<any>
  resourcesPath?: string
}
type Args = { representation?: 'metadata' | 'image' | 'text'; quality?: 'preview' | 'original' }
type ImageBlock = { type: 'image'; data: string; mimeType: string }
type MediaResult = { data: Record<string, unknown>; content?: ImageBlock[] }

const b64 = (data: Buffer): string => data.toString('base64')
const asRecord = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {}
const imageMd5 = (source: string): string | undefined => {
  const m = /(?:md5|imgmd5|origmd5)\s*=\s*["']?([a-f\d]{32})/i.exec(source) || /<md5>([a-f\d]{32})<\/md5>/i.exec(source)
  return m?.[1]?.toLowerCase()
}

function result(messageId: string, kind: string, availability: string, reason?: string, representation: string = 'metadata'): MediaResult {
  return { data: { message_id: messageId, kind, availability, representation, source: 'local', ...(reason && { reason }) } }
}

async function getRow(runtime: Runtime, locator: Locator, signal?: AbortSignal): Promise<Record<string, any> | null> {
  const response = await runtime.call('getMessageByLocator', { sessionId: locator.sessionId, locator: locator.locator }, signal, 2000)
  if (response?.success === false) return null
  if (response?.message === null || response?.row === null || response?.data?.message === null || response?.data?.row === null) return null
  const data = asRecord(response?.data ?? response)
  const candidate = data.row ?? data.message ?? (typeof data.server_id === 'string' || typeof data.local_id === 'string' ? data : null)
  return candidate && typeof candidate === 'object' && Object.keys(candidate).length ? candidate : null
}

function findPath(value: unknown): string | undefined {
  const data = asRecord(value)
  for (const field of ['path', 'full_path', 'file_path', 'filePath', 'local_path', 'localPath', 'image_path', 'imagePath']) {
    const candidate = data[field]
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return undefined
}

async function resolveHardlink(runtime: Runtime, md5: string, accountDir: string, signal?: AbortSignal): Promise<any | null> {
  try {
    return await runtime.call('resolveImageHardlink', { md5, accountDir }, signal, 2000)
  } catch (caught) {
    const error = caught as Error & { code?: string }
    if (error.code === 'CANCELLED' || error.code === 'PROFILE_LOCKED' || error.code === 'PROFILE_CONFIG_INVALID') throw caught
    if (/尚未下载到本机|没有图片附件索引|image.*not.*download/i.test(error.message)) return null
    throw caught
  }
}

async function imageData(runtime: Runtime, body: string, accountDir: string, signal?: AbortSignal): Promise<{ buffer: Buffer; mime: string; transformed: boolean } | { availability: string; reason: string }> {
  const md5 = imageMd5(body)
  if (!md5) return { availability: 'not_downloaded', reason: 'image_locator_missing' }
  const linkResponse = await resolveHardlink(runtime, md5, accountDir, signal)
  const filePath = findPath(linkResponse?.data ?? linkResponse)
  if (!filePath) return { availability: 'not_downloaded', reason: 'local_image_missing' }
  const fileStat = await stat(filePath).catch(() => null)
  if (!fileStat?.isFile()) return { availability: 'not_downloaded', reason: 'local_image_missing' }
  if (fileStat.size > 64 * 1024 * 1024) return { availability: 'too_large', reason: 'source_exceeds_processing_limit' }
  let data: Buffer = await readFile(filePath)
  if (!/\.(?:jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(filePath)) {
    let keysResponse: any
    try {
      keysResponse = await runtime.call('getCachedImageKeys', { accountDir }, signal, 2000)
    } catch (caught) {
      const error = caught as Error & { code?: string }
      if (error.code === 'IMAGE_KEY_REQUIRED') return { availability: 'key_required', reason: 'IMAGE_KEY_REQUIRED' }
      throw caught
    }
    const keys = asRecord(keysResponse?.data ?? keysResponse)
    if (keysResponse?.success === false || keys.verified === false || (keys.xorKey === undefined && !keys.xor_key)) {
      return { availability: 'key_required', reason: 'IMAGE_KEY_REQUIRED' }
    }
    const xorKey = Number(keys.xorKey ?? keys.xor_key)
    const aesKey = String(keys.aesKey ?? keys.aes_key ?? '')
    const version = datVersion(data)
    const candidates: Buffer[] = []
    try {
      if (version === 2 && aesKey.length >= 16) candidates.push(decryptDatV4(data, xorKey, Buffer.from(aesKey, 'ascii').subarray(0, 16)))
      else if (version !== 2) candidates.push(decryptDatV3(data, xorKey))
    } catch { return { availability: 'decode_failed', reason: 'image_decryption_failed' } }
    const decoded = candidates.find(candidate => isHeic(candidate) || candidate[0] === 0xff || candidate.toString('ascii', 1, 4) === 'PNG' || candidate.toString('ascii', 0, 4) === 'RIFF')
    if (!decoded) return { availability: 'decode_failed', reason: 'unsupported_image_data' }
    data = decoded
  }
  let mime = data.subarray(0, 3).toString('hex') === 'ffd8ff' ? 'image/jpeg'
    : data.toString('ascii', 1, 4) === 'PNG' ? 'image/png'
      : data.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : isHeic(data) ? 'image/heic' : 'image/jpeg'
  let transformed = false
  if (isHeic(data)) {
    try {
      const workerPath = runtime.resourcesPath ? join(runtime.resourcesPath, 'mcp', 'heicDecodeWorker.cjs') : undefined
      data = await heicToJpeg(data, { workerPath, signal })
      mime = 'image/jpeg'
      transformed = true
    } catch (caught) {
      const error = caught as Error & { code?: string }
      if (signal?.aborted || error.code === 'CANCELLED') throw caught
      return { availability: 'decode_failed', reason: 'heic_conversion_failed' }
    }
  }
  return { buffer: data, mime, transformed }
}

export async function readMedia(runtime: Runtime, messageId: string, args: Args = {}, signal?: AbortSignal): Promise<MediaResult> {
  const representation = args.representation ?? 'metadata'
  const connected = await runtime.ensureConnected(signal)
  let locator: Locator
  try { locator = decodeMessageId(messageId, connected.accountScope) } catch {
    return result(messageId, 'other', 'unsupported', 'invalid_message_id', representation)
  }
  const row = await getRow(runtime, locator, signal)
  if (!row) return result(messageId, 'other', 'unsupported', 'message_not_found', representation)
  const normalized = normalizeMessage(row, { accountId: connected.accountId, accountScope: connected.accountScope, sessionId: locator.sessionId })
  const body = String(mapRowsToMessagesLite([row], connected.accountId)[0]?.content ?? row.message_content ?? row.compress_content ?? '')
  const kind = normalized.type
  if (representation === 'text') return { data: { message_id: messageId, kind, availability: 'unsupported', representation, source: 'local', reason: kind === 'voice' ? 'no_verified_transcript_available' : 'no_verified_text_representation' } }
  const md5 = imageMd5(body)
  if (representation !== 'image') {
    if (kind !== 'image') return result(messageId, kind, 'unsupported', 'unsupported_format', representation)
    if (!md5) return result(messageId, kind, 'not_downloaded', 'image_locator_missing', representation)
    const accountDir = String(row._account_dir ?? row.account_dir ?? connected.dataDir)
    const link = await resolveHardlink(runtime, md5, accountDir, signal)
    const filePath = findPath(link?.data ?? link)
    const present = filePath ? await stat(filePath).then(value => value.isFile()).catch(() => false) : false
    const extension = filePath?.split('.').pop()?.toLowerCase()
    const mime = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : extension === 'heic' ? 'image/heic' : 'image/jpeg'
    return { data: { message_id: messageId, kind, availability: present ? 'available' : 'not_downloaded', representation, ...(present && { mime_type: mime }), source: 'local', ...(!present && { reason: 'local_image_missing' }) } }
  }
  if (kind !== 'image') return result(messageId, kind, 'unsupported', 'unsupported_format', representation)
  const accountDir = String(row._account_dir ?? row.account_dir ?? connected.dataDir)
  const decoded = await imageData(runtime, body, accountDir, signal)
  if ('availability' in decoded) return result(messageId, kind, decoded.availability, decoded.reason, representation)
  const quality = args.quality ?? 'preview'
  let buffer = decoded.buffer
  let width: number | undefined
  let height: number | undefined
  let transformed = decoded.transformed
  try {
    const meta = await sharp(buffer).metadata()
    width = meta.width; height = meta.height
    if (quality === 'preview') {
      buffer = await sharp(buffer).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
      transformed = true
      const previewMeta = await sharp(buffer).metadata(); width = previewMeta.width; height = previewMeta.height
    }
  } catch { return result(messageId, kind, 'decode_failed', 'image_decode_failed', representation) }
  const maxBytes = quality === 'preview' ? 4 * 1024 * 1024 : 10 * 1024 * 1024
  if (buffer.length > maxBytes) return { data: { message_id: messageId, kind, availability: 'too_large', representation, quality, mime_type: decoded.mime, width, height, transformed, source: 'local', reason: 'image_exceeds_output_budget' } }
  const mime = transformed ? 'image/jpeg' : decoded.mime
  return {
    data: { message_id: messageId, kind, availability: 'available', representation, quality, mime_type: mime, width, height, transformed, source: 'local' },
    content: [{ type: 'image', data: b64(buffer), mimeType: mime }]
  }
}
