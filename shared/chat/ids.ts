import { createHash } from 'crypto'

export type MessageLocator = {
  serverId?: string
  relativeDb?: string
  table?: string
  localId?: string
  createTime?: number
}

type IdPayload = { v: 1; scope: string; kind: 'chat' | 'person' | 'message'; raw?: string; session?: string; locator?: MessageLocator }

function pack(payload: IdPayload): string {
  return `wf1_${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
}

function unpack(id: string, scope: string, kind: IdPayload['kind']): IdPayload {
  try {
    const prefix = 'wf1_'
    if (!id.startsWith(prefix)) throw new Error()
    const value = JSON.parse(Buffer.from(id.slice(prefix.length), 'base64url').toString('utf8')) as IdPayload
    if (value.v !== 1 || value.scope !== scope || value.kind !== kind) throw new Error()
    return value
  } catch {
    throw new Error(`Invalid ${kind} ID for this account`)
  }
}

export function accountScope(owner: string): string {
  return createHash('sha256').update(String(owner).trim(), 'utf8').digest('hex').slice(0, 24)
}

export function chatId(scope: string, rawUsername: string): string {
  return pack({ v: 1, scope, kind: 'chat', raw: String(rawUsername) })
}

export function personId(scope: string, rawUsername: string): string {
  return pack({ v: 1, scope, kind: 'person', raw: String(rawUsername) })
}

export function decodeChatId(id: string, scope: string): string {
  const raw = unpack(id, scope, 'chat').raw
  if (typeof raw !== 'string') throw new Error('Invalid chat ID payload')
  return raw
}

export function decodePersonId(id: string, scope: string): string {
  const raw = unpack(id, scope, 'person').raw
  if (typeof raw !== 'string') throw new Error('Invalid person ID payload')
  return raw
}

export function messageId(scope: string, rawSession: string, row: Record<string, unknown>): string {
  const serverId = String(row.server_id ?? row.serverId ?? '').trim()
  const reliableServerId = serverId && !/^0+$/.test(serverId) ? serverId : undefined
  const relativeDb = String(row._relative_db ?? row.relative_db ?? '').trim() || undefined
  const table = String(row._table_name ?? row.table_name ?? row.table ?? '').trim() || undefined
  const localId = String(row.local_id ?? row.localId ?? '').trim()
  const rawTime = row.create_time ?? row.createTime
  const createTime = typeof rawTime === 'number' && Number.isFinite(rawTime)
    ? rawTime
    : typeof rawTime === 'string' && /^\d+$/.test(rawTime) ? Number(rawTime) : undefined
  const locator: MessageLocator = reliableServerId
    ? { serverId: reliableServerId }
    : { ...(relativeDb && { relativeDb }), ...(table && { table }), ...(localId && { localId }), ...(createTime !== undefined && { createTime }) }
  if (!reliableServerId && (!relativeDb || !table || !localId || createTime === undefined)) {
    throw new Error('Message row has no reliable locator')
  }
  return pack({ v: 1, scope, kind: 'message', session: String(rawSession), locator })
}

export function decodeMessageId(id: string, scope: string): { sessionId: string; locator: MessageLocator } {
  const value = unpack(id, scope, 'message')
  if (typeof value.session !== 'string' || !value.locator || typeof value.locator !== 'object') {
    throw new Error('Invalid message ID payload')
  }
  return { sessionId: value.session, locator: value.locator }
}
