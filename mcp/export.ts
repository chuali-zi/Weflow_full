import { mkdir, mkdtemp, open, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readMessageBatches, type Runtime } from './query'
import { hydrateNames } from './names'
import { formatTranscriptMessage } from './format'
import type { ToolData } from './contracts'
import type { NormalizedMessage } from '../shared/chat/normalize'

export type ExportProgress = (count: number, message: string) => Promise<void>

export async function exportMessages(
  runtime: Runtime, args: any, userData: string, signal?: AbortSignal, onProgress?: ExportProgress,
): Promise<ToolData> {
  if (args.output_dir && !isAbsolute(args.output_dir)) {
    throw Object.assign(new Error('output_dir 必须是绝对目录。'), { code: 'INVALID_ARGUMENT' })
  }
  const batches = readMessageBatches(runtime, args, signal)
  let jsonl: FileHandle | undefined, transcript: FileHandle | undefined
  try {
    // Validate and read the first batch before creating an export directory.
    let next = await batches.next()
    let latest = next.value as ToolData
    const conn = await runtime.ensureConnected(signal)
    const names = await hydrateNames(runtime, conn, [], args.chat_ids, signal)
    const root = resolve(args.output_dir || join(userData, 'mcp-exports'))
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(join(root, 'weflow-'))
    const paths = {
      jsonl: join(directory, 'messages.jsonl'), transcript: join(directory, 'transcript.txt'), manifest: join(directory, 'manifest.json'),
    }
    let count = 0, status: 'running' | 'complete' | 'cancelled' | 'failed' = 'running'
    let error: ToolData['error'] = null
    const startedAt = new Date().toISOString()
    const manifest = () => ({
      schema_version: '1', status, started_at: startedAt, updated_at: new Date().toISOString(),
      account: latest.account, timezone: runtime.timezone, message_time_format: 'UTC RFC3339',
      message_count: count, chats: names.chats, people: names.people,
      coverage: latest.coverage ? { ...latest.coverage, returned_count: count, scan_complete: status === 'complete' } : null,
      freshness: latest.freshness, files: paths, error,
    })
    try {
      jsonl = await open(paths.jsonl, 'wx')
      transcript = await open(paths.transcript, 'wx')
      await transcript.writeFile(`WeFlow 聊天原文\n消息时间：UTC RFC3339\n请求范围：${JSON.stringify(latest.coverage?.requested_scope)}\n参与者和完整消息字段见 manifest.json / messages.jsonl。\n\n`, 'utf8')
      await writeFile(paths.manifest, JSON.stringify(manifest(), null, 2) + '\n', 'utf8')
      while (!next.done) {
        if (signal?.aborted) throw Object.assign(new Error('导出已取消。'), { code: 'CANCELLED' })
        const batch = next.value as ToolData
        const messages = batch.data.messages as NormalizedMessage[]
        const unnamed = messages.filter(message => (
          !names.chats[message.chat_id] || (message.sender_id && !names.people[message.sender_id])
          || (message.quote?.sender_id && !names.people[message.quote.sender_id])
          || message.mentions.person_ids.some(id => !names.people[id])
        ))
        if (unnamed.length) {
          const additional = await hydrateNames(runtime, conn, unnamed, [], signal)
          Object.assign(names.chats, additional.chats)
          Object.assign(names.people, additional.people)
        }
        if (messages.length) {
          await jsonl.writeFile(messages.map(message => JSON.stringify(message) + '\n').join(''), 'utf8')
          await transcript.writeFile(messages.map(message => formatTranscriptMessage(message, names)).join(''), 'utf8')
        }
        count += messages.length
        latest = batch
        if (onProgress) await onProgress(count, `已导出 ${count} 条消息`).catch(() => undefined)
        next = await batches.next()
      }
      status = 'complete'
    } catch (caught: any) {
      status = signal?.aborted || caught?.code === 'CANCELLED' ? 'cancelled' : 'failed'
      error = {
        code: caught?.code || 'EXPORT_FAILED', message: String(caught?.message || caught), retryable: false,
        action: '已写入文件保留在 output_dir；manifest 标明未完成。需要完整范围时重新导出。',
      }
    } finally {
      await jsonl?.close(); jsonl = undefined
      await transcript?.close(); transcript = undefined
    }
    await writeFile(paths.manifest, JSON.stringify(manifest(), null, 2) + '\n', 'utf8')
    const files: Record<string, { path: string; uri: string; mime_type: string; bytes: number }> = {}
    for (const [key, path] of Object.entries(paths)) {
      const metadata = await stat(path).catch(() => null)
      if (metadata) files[key] = { path, uri: pathToFileURL(path).href, mime_type: key === 'jsonl' ? 'application/x-ndjson' : key === 'manifest' ? 'application/json' : 'text/plain', bytes: metadata.size }
    }
    return {
      ...latest, success: status === 'complete', error,
      data: { status, output_dir: directory, message_count: count, files, chats: names.chats, people_count: Object.keys(names.people).length },
      coverage: manifest().coverage,
    }
  } finally {
    await jsonl?.close().catch(() => undefined)
    await transcript?.close().catch(() => undefined)
    await batches.return(undefined)
  }
}
