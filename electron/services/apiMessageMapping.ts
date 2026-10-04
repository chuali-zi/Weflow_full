import type { Message } from './chatService'
import { mapRowsToMessagesLite as decodeRows } from '../../shared/chat/decode'

/** Backwards-compatible GUI/API entry point; decoding lives in the shared pure module. */
export function mapRowsToMessagesLite(rows: Record<string, any>[], myAccountIdRaw: string): Message[] {
  return decodeRows(rows, myAccountIdRaw) as Message[]
}
