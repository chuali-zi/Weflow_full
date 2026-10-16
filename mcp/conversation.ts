import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { exportMessages, type ExportPresentation, type ExportProgress } from './export'
import { getMessageContext, readPresentedMessages, type Runtime } from './query'
import type { ToolData } from './contracts'
import type { NormalizedMessage } from '../shared/chat/normalize'

type Options = { mode: 'reading' | 'analysis'; timezone: string; include_source_ids?: boolean }
type Names = { chats: Record<string, { display_name: string }>; people: Record<string, { display_name: string; is_self?: boolean }> }
type CleanMessage = Record<string, any>
const TTL = 30 * 60_000
const MAX_REFERENCES = 20_000

function invalid(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, action: '重新读取原范围，或提供导出的 references.jsonl。' })
}

/** Stable short references include the account and locator through the original ID. */
export function conversationRef(id: string): string {
  const payload = JSON.parse(Buffer.from(id.slice(4), 'base64url').toString('utf8'))
  const prefix = payload.kind === 'message' ? 'm' : payload.kind === 'chat' ? 'c' : 'p'
  return `${prefix}_${createHash('sha256').update(id).digest('hex').slice(0, 20)}`
}

export function conversationOptions(args: any, defaultTimezone: string): Options {
  const timezone = args.timezone || defaultTimezone
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format() }
  catch { throw invalid('INVALID_ARGUMENT', 'timezone 必须是有效的 IANA 时区。') }
  return { mode: args.mode || 'reading', timezone, ...(args.include_source_ids && { include_source_ids: true }) }
}

const timeFormats = new Map<string, Intl.DateTimeFormat>()
function displayTime(utc: string, timezone: string): string {
  let formatter = timeFormats.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' })
    if (timeFormats.size >= 32) timeFormats.clear()
    timeFormats.set(timezone, formatter)
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utc)).map(p => [p.type, p.value]))
  const offset = parts.timeZoneName === 'GMT' ? 'Z' : parts.timeZoneName.replace('GMT', '')
  const fraction = /\.\d+Z$/.exec(utc)?.[0].slice(0, -1) || ''
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${fraction}${offset}`
}

const mediaLabels: Record<string, string> = { image: '图片', sticker: '表情', voice: '语音', video: '视频', file: '文件', link: '链接', forwarded: '合并转发', location: '位置' }

export function cleanConversationMessage(message: NormalizedMessage, names: Names, options: Options): CleanMessage {
  const person = (id: string) => options.mode === 'analysis' ? conversationRef(id) : names.people[id]?.display_name || conversationRef(id)
  const result: CleanMessage = {
    ref: conversationRef(message.id), time: displayTime(message.sent_at, options.timezone),
    chat: conversationRef(message.chat_id), sender: message.sender_id ? person(message.sender_id) : '未知发送者', text: message.text,
  }
  // Keep a distinct identity even when display names collide.
  if (options.mode === 'reading' && message.sender_id) result.sender_ref = conversationRef(message.sender_id)
  if (options.mode === 'analysis' || message.type !== 'text') result.type = message.type
  if (!message.text_complete) result.text_complete = false
  if (message.text_part) result.text_part = message.text_part
  if (message.content_status !== 'parsed') result.content_status = message.content_status
  if (message.mentions.state !== 'known' || message.mentions.everyone || message.mentions.person_ids.length) {
    result.mentions = {
      ...(message.mentions.state !== 'known' && { state: message.mentions.state }),
      ...(message.mentions.everyone && { everyone: true }),
      ...(message.mentions.person_ids.length && { people: message.mentions.person_ids.map(person), refs: message.mentions.person_ids.map(conversationRef) }),
    }
  }
  if (message.quote) result.quote = {
    ...(message.quote.target_id && { ref: conversationRef(message.quote.target_id) }),
    ...(message.quote.sender_id && { sender: person(message.quote.sender_id), sender_ref: conversationRef(message.quote.sender_id) }),
    ...(message.quote.text !== null && { text: message.quote.text }), state: message.quote.state,
  }
  if (message.attachment) result.media = {
    ...message.attachment,
    ...(options.mode === 'reading' && { note: `${mediaLabels[message.attachment.kind] || message.attachment.kind}；附件内容尚未读取` }),
  }
  if (message.system_event) result.system_event = message.system_event
  if (message.is_self !== null && !message.sender_id) result.is_self = message.is_self
  return result
}

/** Only transport metadata is rewritten; message text, quote text and URLs never pass here. */
function cleanMetadata(value: any): any {
  if (typeof value === 'string') {
    if (value.startsWith('wf1_')) {
      try { return conversationRef(value) } catch { return value }
    }
    return value
  }
  if (Array.isArray(value)) return value.map(cleanMetadata)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.startsWith('wf1_') ? conversationRef(key) : key, ['text', 'display_name', 'title', 'url', 'message', 'action'].includes(key) ? item : cleanMetadata(item)]))
  return value
}

function cleanEnvelope(source: ToolData, options: Options): ToolData {
  const coverage = cleanMetadata(source.coverage)
  if (coverage?.requested_scope?.filters) {
    const { direction, sender_ids, types } = coverage.requested_scope.filters
    coverage.requested_scope.filters = { ...(direction && { direction }), ...(sender_ids && { sender_ids }), ...(types && { types }) }
  }
  return { ...source, account: null, timezone: options.timezone,
    coverage, warnings: cleanMetadata(source.warnings), error: cleanMetadata(source.error),
    freshness: { ...source.freshness, connection_id: null, snapshot_id: null },
  }
}

export function conversationTranscript(message: CleanMessage, names: Names): string {
  const { chats, people } = names
  const name = (ref: string) => people[ref]?.display_name || ref
  const lines = [`${message.time} [${chats[message.chat]?.display_name || message.chat} / ${name(message.sender)}] · ${message.ref}`]
  if (message.quote) lines.push(`回复 ${message.quote.sender ? name(message.quote.sender) : '未知发送者'}${message.quote.ref ? ` · ${message.quote.ref}` : ''}：${message.quote.text ?? '[引用内容不可读]'}（${message.quote.state}）`)
  lines.push(message.text)
  if (message.media) lines.push(`[${mediaLabels[message.media.kind] || message.media.kind}，附件内容尚未读取；状态：${message.media.availability}]${message.media.title ? ` ${message.media.title}` : ''}${message.media.url ? ` ${message.media.url}` : ''}`)
  if (message.mentions) lines.push(`@：${message.mentions.everyone ? '所有人 ' : ''}${(message.mentions.people || []).map(name).join('、')}${message.mentions.state === 'unknown' ? '（无法确认真实 @ 对象）' : ''}`)
  if (message.content_status) lines.push(`[内容${message.content_status === 'partial' ? '未完全解析' : '未解析'}]`)
  if (message.text_complete === false) lines.push(`[正文分段：${JSON.stringify(message.text_part)}]`)
  return lines.join('\n') + '\n\n'
}

export class ConversationTools {
  private readonly references = new Map<string, { id: string; touched: number }>()
  constructor(private readonly runtime: Runtime) {}
  clear(): void { this.references.clear() }
  private remember(id: string): string {
    const ref = conversationRef(id), previous = this.references.get(ref)
    if (previous && previous.id !== id) throw invalid('REFERENCE_COLLISION', '短引用冲突，请使用原始消息 ID。')
    this.references.delete(ref)
    this.references.set(ref, { id, touched: Date.now() })
    while (this.references.size > MAX_REFERENCES) this.references.delete(this.references.keys().next().value!)
    return ref
  }
  private project = (source: ToolData, options: Options, cache?: WeakMap<NormalizedMessage, CleanMessage>): ToolData => {
    const { messages = [], chats = {}, people = {}, ...extra } = source.data as any
    if (extra.reply_search_scope?.sessions) {
      const { sessions: _sessions, ...scope } = extra.reply_search_scope
      extra.reply_search_scope = scope
    }
    for (const message of messages as NormalizedMessage[]) {
      this.remember(message.id)
      if (message.quote?.target_id) this.remember(message.quote.target_id)
    }
    return { ...cleanEnvelope(source, options), data: {
      mode: options.mode, chats: cleanMetadata(chats), people: cleanMetadata(people),
      messages: messages.map((m: NormalizedMessage) => {
        const cleaned = cache?.get(m) || cleanConversationMessage(m, { chats, people }, options)
        cache?.set(m, cleaned)
        return cleaned
      }),
      ...cleanMetadata(extra),
      ...(options.include_source_ids && { source_ids: Object.fromEntries(messages.map((m: NormalizedMessage) => [conversationRef(m.id), m.id])) }),
    } }
  }
  async read(args: any, signal?: AbortSignal): Promise<ToolData> {
    const options = args.cursor ? undefined : conversationOptions(args, this.runtime.timezone)
    let after = args.after_message
    if (after && !after.startsWith('wf1_')) [after] = await this.resolve([after], undefined, signal)
    // Fitting may rebuild the same page; fragments have new objects and are projected afresh.
    const cache = new WeakMap<NormalizedMessage, CleanMessage>()
    // Names are hydrated after scanning; the final envelope fit accounts for their actual lengths.
    return readPresentedMessages(this.runtime, args.cursor ? args : { ...args, after_message: after, presentation: options },
      (source, presentation) => this.project(source, presentation, cache), signal,
      (message, presentation) => cleanConversationMessage(message, { chats: {}, people: {} }, presentation))
  }
  async context(args: any, signal?: AbortSignal): Promise<ToolData> {
    if (args.cursor) return getMessageContext(this.runtime, args, signal, this.project)
    const options = conversationOptions(args, this.runtime.timezone)
    const message_ids = await this.resolve(args.message_refs, args.references_file, signal)
    return getMessageContext(this.runtime, { ...args, message_ids, presentation: options }, signal, this.project)
  }
  private async resolve(refs: string[], file?: string, signal?: AbortSignal): Promise<string[]> {
    if (file && !isAbsolute(file)) throw invalid('INVALID_ARGUMENT', 'references_file 必须是绝对路径。')
    const found = new Map<string, string>()
    for (const ref of refs) {
      if (ref.startsWith('wf1_')) { found.set(ref, ref); continue }
      const entry = this.references.get(ref)
      if (entry && entry.touched + TTL > Date.now()) { found.set(ref, entry.id); entry.touched = Date.now() }
      else this.references.delete(ref)
    }
    if (file && found.size < new Set(refs).size) {
      const input = createReadStream(file, { encoding: 'utf8', signal })
      const lines = createInterface({ input, crlfDelay: Infinity })
      try {
        for await (const line of lines) {
          if (signal?.aborted) throw invalid('CANCELLED', '读取定位映射已取消。')
          if (!line.trim()) continue
          const entry = JSON.parse(line)
          if (refs.includes(entry.ref) && typeof entry.message_id === 'string' && entry.message_id.startsWith('wf1_') && conversationRef(entry.message_id) === entry.ref) found.set(entry.ref, entry.message_id)
          if (found.size === new Set(refs).size) break
        }
      } finally { lines.close(); input.destroy() }
    }
    return refs.map(ref => {
      const id = found.get(ref)
      if (!id) throw invalid('REFERENCE_EXPIRED', `消息引用 ${ref} 不存在或已过期。`)
      return id
    })
  }
  async export(args: any, userData: string, signal?: AbortSignal, onProgress?: ExportProgress): Promise<ToolData> {
    const options = conversationOptions(args, this.runtime.timezone)
    const presentation: ExportPresentation = {
      filenames: { jsonl: 'conversation.jsonl', transcript: 'conversation.txt' },
      header: `WeFlow 聊天原文\n时间显示：${options.timezone}\n清洗仅整理系统字段，正文不摘要、不抽样。导出范围和完成状态见 manifest.json；定位信息见 references.jsonl。\n\n`,
      batch: (messages, names) => {
        const cleaned = messages.map(m => cleanConversationMessage(m, names, options))
        const ids = new Set(messages.flatMap(m => [m.id, ...(m.quote?.target_id ? [m.quote.target_id] : [])]))
        const displayNames = { chats: cleanMetadata(names.chats), people: cleanMetadata(names.people) }
        return {
          jsonl: cleaned.map(m => JSON.stringify(m) + '\n').join(''),
          transcript: cleaned.map(m => conversationTranscript(m, displayNames)).join(''),
          references: [...ids].map(id => JSON.stringify({ ref: conversationRef(id), message_id: id }) + '\n').join(''),
        }
      },
      manifest: value => ({ ...cleanMetadata(value), account: null, timezone: options.timezone, message_time_format: 'RFC3339 with offset',
        coverage: cleanEnvelope({ ...value, data: {}, warnings: [] }, options).coverage,
        freshness: { ...value.freshness, connection_id: null, snapshot_id: null },
        cleaning: { mode: options.mode, body_preserved: true, summarized: false, references_file: value.files.references },
      }),
    }
    const output = await exportMessages(this.runtime, args, userData, signal, onProgress, presentation)
    // Paths and file sizes are sufficient here; names live in the manifest.
    const { chats: _chats, people_count: _peopleCount, ...data } = output.data
    return { ...cleanEnvelope(output, options), data }
  }
}
