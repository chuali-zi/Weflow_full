import type { NormalizedMessage } from '../shared/chat/normalize'

export const COMPACT_MESSAGE_COLUMNS = ['id', 'chat_ref', 'sender_ref', 'sent_at', 'type', 'text', 'details']
export const COMPACT_MESSAGE_DEFAULTS = {
  is_self: null, text_complete: true, text_part: null, content_status: 'parsed',
  mentions: { state: 'known', person_ids: [], everyone: false }, quote: null, attachment: null, system_event: null,
}

/** Omitted detail fields have the defaults declared once for the whole response. */
export function messageDetails(message: NormalizedMessage): Record<string, unknown> {
  const details: Record<string, unknown> = {}
  if (message.is_self !== null) details.is_self = message.is_self
  if (!message.text_complete) details.text_complete = false
  if (message.text_part) details.text_part = message.text_part
  if (message.content_status !== 'parsed') details.content_status = message.content_status
  if (message.mentions.state !== 'known' || message.mentions.person_ids.length || message.mentions.everyone) details.mentions = message.mentions
  if (message.quote) details.quote = message.quote
  if (message.attachment) details.attachment = message.attachment
  if (message.system_event) details.system_event = message.system_event
  return details
}

export function compactMessage(message: NormalizedMessage, chatRef = message.chat_id, senderRef: string | null = message.sender_id): unknown[] {
  return [message.id, chatRef, senderRef, message.sent_at, message.type, message.text, messageDetails(message)]
}

export function compactMessageData(messages: NormalizedMessage[], names: {
  chats: Record<string, { display_name: string }>
  people: Record<string, { display_name: string }>
}): Record<string, unknown> {
  const chatRefs = new Map(Object.keys(names.chats).map((id, index) => [id, `C${index + 1}`]))
  const personRefs = new Map(Object.keys(names.people).map((id, index) => [id, `P${index + 1}`]))
  return {
    format: 'compact', message_columns: COMPACT_MESSAGE_COLUMNS, message_defaults: COMPACT_MESSAGE_DEFAULTS,
    chats: Object.fromEntries(Object.entries(names.chats).map(([id, name]) => [chatRefs.get(id), { id, ...name }])),
    people: Object.fromEntries(Object.entries(names.people).map(([id, name]) => [personRefs.get(id), { id, ...name }])),
    messages: messages.map(message => compactMessage(message, chatRefs.get(message.chat_id), message.sender_id ? personRefs.get(message.sender_id) || message.sender_id : null)),
  }
}

export function formatTranscriptMessage(message: NormalizedMessage, names: {
  chats: Record<string, { display_name: string }>
  people: Record<string, { display_name: string }>
}): string {
  const chat = names.chats[message.chat_id]?.display_name || message.chat_id
  const sender = message.sender_id ? names.people[message.sender_id]?.display_name || message.sender_id : '未知发送者'
  const details = messageDetails(message)
  const metadata = Object.keys(details).length ? `\n  ${JSON.stringify(details)}` : ''
  return `${message.sent_at} [${JSON.stringify(chat)} / ${JSON.stringify(sender)}] [${message.type}] [${message.id}]\n${message.text}${metadata}\n\n`
}
