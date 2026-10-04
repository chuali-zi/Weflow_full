import { mapRowsToMessagesLite } from './decode'
import { chatId, messageId, personId } from './ids'

export type MessageType = 'text' | 'image' | 'voice' | 'video' | 'file' | 'link' | 'quote' | 'forwarded' | 'location' | 'system' | 'other'

export type NormalizedMessage = {
  id: string
  chat_id: string
  sender_id: string | null
  is_self: boolean | null
  sent_at: string
  type: MessageType
  text: string
  text_complete: boolean
  text_part: { offset: number; end: number; total: number } | null
  content_status: 'parsed' | 'partial' | 'unparsed'
  mentions: { state: 'known' | 'unknown'; person_ids: string[]; everyone: boolean }
  quote: { target_id: string | null; sender_id: string | null; text: string | null; state: 'resolved' | 'snapshot_only' | 'unresolved' } | null
  attachment: { kind: string; title?: string; url?: string; availability: string } | null
  system_event: string | null
}

export type NormalizeContext = { accountId: string; accountScope: string; sessionId: string }

const str = (value: unknown): string => value == null ? '' : String(value)
const xmlValue = (content: string, tag: string): string | null => {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(content)
  if (!match) return null
  const cdata: string[] = []
  const protectedValue = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_whole, value: string) => {
    const index = cdata.push(value) - 1
    return `\u0000CDATA${index}\u0000`
  })
  const plain = protectedValue.replace(/<[^>]+>/g, '')
  const decoded = unescapeXml(plain).replace(/\u0000CDATA(\d+)\u0000/g, (_whole, index: string) => cdata[Number(index)] ?? '')
  return decoded.trim()
}
const unescapeXml = (value: string): string => value
  .replace(/&#(\d+);/g, (_whole, digits: string) => decodeCodePoint(Number(digits)))
  .replace(/&#x([\da-f]+);/gi, (_whole, digits: string) => decodeCodePoint(parseInt(digits, 16)))
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
  .replace(/&apos;|&#39;/gi, "'").replace(/&amp;/gi, '&')
function decodeCodePoint(value: number): string {
  try { return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '\uFFFD' } catch { return '\uFFFD' }
}
const validUrl = (value: string | null): string | undefined => value && /^https?:\/\//i.test(value) ? value : undefined

function forwardRecordText(raw: string): string[] {
  const record = xmlValue(raw, 'recorditem') || xmlValue(raw, 'recordinfo')
  if (!record) return []
  const lines: string[] = []
  const items = record.match(/<dataitem\b[^>]*>[\s\S]*?<\/dataitem>/gi) || []
  for (const item of items) {
    const sender = xmlValue(item, 'sourcename') || xmlValue(item, 'fromusr')
    const text = xmlValue(item, 'datadesc') || xmlValue(item, 'content') || xmlValue(item, 'datatitle') || xmlValue(item, 'title')
    if (text) lines.push(sender ? `${sender}: ${text}` : text)
  }
  return lines
}

function classify(localType: number, raw: string): { type: MessageType; text: string; attachment: NormalizedMessage['attachment']; system: string | null; contentStatus: NormalizedMessage['content_status'] } {
  if (localType === 10000 || localType === 10002) return { type: 'system', text: xmlValue(raw, 'plain') || raw.replace(/<[^>]+>/g, '').trim(), attachment: null, system: 'system_message', contentStatus: 'parsed' }
  if (localType === 3) return { type: 'image', text: '', attachment: { kind: 'image', availability: 'unknown' }, system: null, contentStatus: 'parsed' }
  if (localType === 34) return { type: 'voice', text: '', attachment: { kind: 'voice', availability: 'unknown' }, system: null, contentStatus: 'parsed' }
  if (localType === 43 || localType === 62) return { type: 'video', text: '', attachment: { kind: 'video', availability: 'unknown' }, system: null, contentStatus: 'parsed' }
  if (localType === 47) return { type: 'image', text: '', attachment: { kind: 'sticker', availability: 'unknown' }, system: null, contentStatus: 'parsed' }
  if (localType === 49) {
    const app = /<appmsg\b[^>]*>([\s\S]*?)<\/appmsg>/i.exec(raw)?.[1] || raw
    const cleanApp = app.replace(/<refermsg[\s\S]*?<\/refermsg>/gi, '')
    const appType = xmlValue(cleanApp, 'type')
    const title = xmlValue(cleanApp, 'title')
    const url = validUrl(xmlValue(cleanApp, 'url'))
    const refer = /<refermsg\b[^>]*>([\s\S]*?)<\/refermsg>/i.exec(app)?.[1]
    if (refer) return { type: 'quote', text: title || '', attachment: null, system: null, contentStatus: 'parsed' }
    if (appType === '19') {
      const children = forwardRecordText(raw)
      const text = [title, ...children].filter(Boolean).join('\n')
      return { type: 'forwarded', text, attachment: { kind: 'forwarded', ...(title && { title }), availability: 'unknown' }, system: null, contentStatus: children.length ? 'parsed' : 'partial' }
    }
    if (appType === '6') return { type: 'file', text: title || '', attachment: { kind: 'file', ...(title && { title }), availability: 'unknown' }, system: null, contentStatus: title ? 'parsed' : 'partial' }
    if (appType === '5' || appType === '33' || appType === '36' || url) return { type: 'link', text: title || url || '', attachment: { kind: 'link', ...(title && { title }), ...(url && { url }), availability: 'available' }, system: null, contentStatus: title || url ? 'parsed' : 'partial' }
    if (/<location\b/i.test(raw)) return { type: 'location', text: title || '[位置]', attachment: { kind: 'location', ...(title && { title }), availability: 'available' }, system: null, contentStatus: title ? 'parsed' : 'partial' }
    return { type: 'other', text: title || raw.trim(), attachment: null, system: null, contentStatus: raw.trim() ? 'partial' : 'unparsed' }
  }
  if (localType === 1) return { type: 'text', text: raw, attachment: null, system: null, contentStatus: 'parsed' }
  const text = /<[^>]+>/.test(raw) ? raw.trim() : raw
  return { type: 'other', text, attachment: null, system: null, contentStatus: text ? 'partial' : 'unparsed' }
}

function normalizedLocalType(raw: unknown): number {
  const value = String(raw ?? '').trim()
  if (!/^[+-]?\d+$/.test(value)) return 1
  try { return Number(BigInt(value) & 0xffffn) } catch { return 1 }
}

export function normalizeMessage(row: Record<string, any>, context: NormalizeContext): NormalizedMessage {
  const mapped = mapRowsToMessagesLite([row], context.accountId)[0]
  const raw = str(mapped?.content ?? row.message_content ?? '')
  const localType = normalizedLocalType(row.local_type ?? row.localType ?? mapped?.localType ?? 1)
  const parsed = classify(localType, raw)
  const sender = str(mapped?.senderUsername ?? row.sender_username).trim()
  const sentSeconds = Number(mapped?.createTime ?? row.create_time ?? row.createTime ?? 0)
  const sentAt = Number.isFinite(sentSeconds) && sentSeconds > 0 ? new Date(sentSeconds * 1000).toISOString() : new Date(0).toISOString()
  const sourceMetadata = [row.source, row.msg_source, row.message_source, row.msgSource, row.source_xml].map(str).join('\n')
  const mentionSource = `${raw}\n${sourceMetadata}`
  const mentionTag = /<atuserlist\b[^>]*>([\s\S]*?)<\/atuserlist>/i.exec(mentionSource)?.[1]
  const mentionText = mentionTag ? xmlValue(`<atuserlist>${mentionTag}</atuserlist>`, 'atuserlist') || '' : ''
  const mentionTokens = mentionTag ? mentionText.split(/[,;\s]+/).map(unescapeXml).filter(Boolean) : []
  const everyone = mentionTokens.some(token => token.toLowerCase() === 'all' || token.toLowerCase() === 'everyone' || token === 'notify@all')
  const mentionIds = mentionTokens.filter(token => !['all', 'everyone', 'notify@all'].includes(token.toLowerCase())).map(token => personId(context.accountScope, token))
  const hasAt = /[@＠]/.test(parsed.text)
  const mentions = { state: (mentionTag ? 'known' : hasAt ? 'unknown' : 'known') as 'known' | 'unknown', person_ids: mentionIds, everyone }
  const quoteXml = /<refermsg\b[^>]*>([\s\S]*?)<\/refermsg>/i.exec(raw)?.[1]
  let quote: NormalizedMessage['quote'] = null
  if (quoteXml) {
    const quotedSender = xmlValue(quoteXml, 'chatusr') || xmlValue(quoteXml, 'fromusr')
    const quotedText = xmlValue(quoteXml, 'content')
    const quotedId = xmlValue(quoteXml, 'svrid') || xmlValue(quoteXml, 'msgid')
    let targetId: string | null = null
    if (quotedId && /^\d+$/.test(quotedId) && !/^0+$/.test(quotedId)) {
      try { targetId = messageId(context.accountScope, context.sessionId, { server_id: quotedId }) } catch { /* leave only the quoted snapshot */ }
    }
    quote = { target_id: targetId, sender_id: quotedSender ? personId(context.accountScope, quotedSender) : null, text: quotedText, state: targetId ? 'unresolved' : 'snapshot_only' }
  }
  const id = messageId(context.accountScope, context.sessionId, row)
  const isSelf = mapped?.isSend === null || mapped?.isSend === undefined ? null : mapped.isSend === 1
  return {
    id, chat_id: chatId(context.accountScope, context.sessionId), sender_id: sender ? personId(context.accountScope, sender) : null,
    is_self: isSelf, sent_at: sentAt, type: parsed.type, text: parsed.text, text_complete: true, text_part: null,
    content_status: parsed.contentStatus, mentions, quote,
    attachment: parsed.attachment, system_event: parsed.system
  }
}
