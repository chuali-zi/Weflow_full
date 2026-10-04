import { decodeChatId, decodePersonId } from '../shared/chat/ids'
import type { NormalizedMessage } from '../shared/chat/normalize'

type Connection = { accountId: string; accountScope: string }
type Runtime = {
  call(method: string, payload?: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<any>
}
type ChatName = { display_name: string; kind: 'private' | 'group' }
type PersonName = { display_name: string; is_self: boolean }

export async function hydrateNames(
  runtime: Runtime,
  conn: Connection,
  messages: readonly NormalizedMessage[],
  chatIds?: readonly string[],
  signal?: AbortSignal
): Promise<{ chats: Record<string, ChatName>; people: Record<string, PersonName> }> {
  const chatRawById = new Map<string, string>()
  const personRawById = new Map<string, string>()
  const selfPersonIds = new Set<string>()
  const addChat = (id: string) => {
    if (!chatRawById.has(id)) chatRawById.set(id, decodeChatId(id, conn.accountScope))
  }
  const addPerson = (id: string | null | undefined) => {
    if (id && !personRawById.has(id)) personRawById.set(id, decodePersonId(id, conn.accountScope))
  }

  for (const id of chatIds || []) addChat(id)
  for (const message of messages) {
    addChat(message.chat_id)
    addPerson(message.sender_id)
    if (message.is_self === true && message.sender_id) selfPersonIds.add(message.sender_id)
    addPerson(message.quote?.sender_id)
    for (const personId of message.mentions.person_ids) addPerson(personId)
  }

  const usernames = Array.from(new Set([...chatRawById.values(), ...personRawById.values()]))
  const displayMap: Record<string, string> = {}
  if (usernames.length) {
    const response = await runtime.call('getDisplayNames', { usernames }, signal, 2000)
    if (response?.success === false) throw Object.assign(new Error(response.error || '无法读取联系人名称。'), { code: response.code || 'DISPLAY_NAMES_FAILED' })
    const map = response?.map ?? response?.data?.map
    if (map && typeof map === 'object') {
      for (const [username, display] of Object.entries(map)) {
        if (typeof display === 'string' && display.trim()) displayMap[username] = display.trim()
      }
    }
  }

  const chats: Record<string, ChatName> = {}
  for (const [id, raw] of chatRawById) {
    chats[id] = { display_name: displayMap[raw] || raw, kind: raw.endsWith('@chatroom') ? 'group' : 'private' }
  }
  const people: Record<string, PersonName> = {}
  for (const [id, raw] of personRawById) {
    people[id] = { display_name: displayMap[raw] || raw, is_self: raw === conn.accountId || selfPersonIds.has(id) }
  }
  return { chats, people }
}
