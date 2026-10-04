import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { accountScope, decodeMessageId, messageId } from '../shared/chat/ids'
import { decryptDatV3, decryptDatV4 } from '../shared/chat/imageDecrypt'
import { normalizeMessage } from '../shared/chat/normalize'
import { readMedia } from '../mcp/media'

const owner = 'wxid_synthetic_owner'
const scope = accountScope(owner)
const context = { accountId: owner, accountScope: scope, sessionId: 'wxid_synthetic_chat' }

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server_id: '900719925474099312345',
    local_id: '7',
    create_time: 1_700_000_000,
    local_type: 1,
    is_send: 0,
    sender_username: 'wxid_synthetic_sender',
    message_content: 'hello',
    _relative_db: 'message/message_0.db',
    table_name: 'MSG_123',
    ...overrides
  }
}

test('message IDs preserve an unsafe server ID across restart-like decoding', () => {
  const id = messageId(scope, context.sessionId, row())
  const restartedScope = accountScope(` ${owner} `)
  const decoded = decodeMessageId(id, restartedScope)
  assert.equal(decoded.sessionId, context.sessionId)
  assert.equal(decoded.locator.serverId, '900719925474099312345')
  assert.equal(decoded.locator.relativeDb, undefined)
  assert.throws(() => decodeMessageId(id, accountScope('another-owner')))
})

test('server-ID message identity ignores live/snapshot source metadata', () => {
  const serverOnly = { server_id: '900719925474099312345' }
  const liveRow = { ...serverOnly, _relative_db: 'message/message_0.db', _table_name: 'MSG_0', local_id: '7', create_time: 1_700_000_000 }
  const snapshotRow = { ...serverOnly, _relative_db: 'snapshot/messages/message_99.db', _table_name: 'MSG_99', local_id: '800', create_time: 1_700_100_000 }
  assert.equal(messageId(scope, context.sessionId, liveRow), messageId(scope, context.sessionId, snapshotRow))
})

test('local-only message locator round-trips exact source and IDs without a fabricated fallback', () => {
  const sourceRow = {
    local_id: '900719925474099312347',
    create_time: 1_700_000_123,
    _relative_db: 'message/message_17.db',
    _table_name: 'MSG_1700000000'
  }
  const decoded = decodeMessageId(messageId(scope, context.sessionId, sourceRow), scope)
  assert.equal(decoded.locator.serverId, undefined)
  assert.equal(decoded.locator.relativeDb, 'message/message_17.db')
  assert.equal(decoded.locator.table, 'MSG_1700000000')
  assert.equal(decoded.locator.localId, '900719925474099312347')
  assert.equal(decoded.locator.createTime, 1_700_000_123)

  assert.throws(() => normalizeMessage(row({
    server_id: undefined,
    _relative_db: undefined,
    _table_name: undefined,
    local_id: undefined
  }), context), /reliable locator/)
})

test('normalization keeps text, quote snapshots, and file metadata', () => {
  const text = normalizeMessage(row({ message_content: 'Keep the original wording.' }), context)
  assert.equal(text.type, 'text')
  assert.equal(text.text, 'Keep the original wording.')
  assert.equal(text.text_complete, true)

  const quote = normalizeMessage(row({
    local_type: 49,
    message_content: '<appmsg><title><![CDATA[My reply]]></title><type>57</type><refermsg><chatusr><![CDATA[wxid_quoted]]></chatusr><content><![CDATA[Original &amp; exact words]]></content><svrid>900719925474099398765</svrid></refermsg></appmsg>'
  }), context)
  assert.equal(quote.type, 'quote')
  assert.equal(quote.quote?.state, 'unresolved')
  assert.equal(quote.quote?.text, 'Original &amp; exact words')
  assert.equal(quote.quote?.sender_id, normalizeMessage(row({ sender_username: 'wxid_quoted' }), context).sender_id)
  const target = decodeMessageId(quote.quote!.target_id!, scope)
  assert.equal(target.locator.serverId, '900719925474099398765')
  const referencedMessageId = messageId(scope, context.sessionId, row({ server_id: '900719925474099398765', _relative_db: 'message/other.db', local_id: '999', create_time: 1_700_100_000 }))
  assert.equal(quote.quote?.target_id, referencedMessageId)

  const file = normalizeMessage(row({
    local_type: '18446744073709551665', // 2^64 + local app-message type 49
    message_content: '<appmsg><title><![CDATA[budget.xlsx]]></title><type>6</type><appattach><fileext>xlsx</fileext></appattach></appmsg>'
  }), context)
  assert.equal(file.type, 'file')
  assert.equal(file.attachment?.title, 'budget.xlsx')
})

test('@ text without parsed metadata remains unknown; parsed IDs become stable people', () => {
  const unknown = normalizeMessage(row({ message_content: 'Alice @Alice please review' }), context)
  assert.equal(unknown.mentions.state, 'unknown')
  assert.deepEqual(unknown.mentions.person_ids, [])

  const known = normalizeMessage(row({ message_content: '<msg><atuserlist>wxid_alice,notify@all</atuserlist>@Alice</msg>' }), context)
  assert.equal(known.mentions.state, 'known')
  assert.equal(known.mentions.everyone, true)
  assert.equal(known.mentions.person_ids.length, 1)

  const sourceOnly = normalizeMessage(row({ message_content: 'Hello', source: '<msgsource><![CDATA[<atuserlist>wxid_bob</atuserlist>]]></msgsource>' }), context)
  assert.equal(sourceOnly.mentions.state, 'known')
  assert.deepEqual(sourceOnly.mentions.person_ids, [normalizeMessage(row({ sender_username: 'wxid_bob' }), context).sender_id])
})

test('merged records keep child text and mark missing children partial; unknown XML is retained', () => {
  const forwarded = normalizeMessage(row({
    local_type: 49,
    message_content: '<appmsg><title><![CDATA[Chat history]]></title><type>19</type><recorditem><![CDATA[<recordinfo><datalist><dataitem><sourcename>Alice</sourcename><datadesc>First child text</datadesc></dataitem><dataitem><datadesc>Second &#x1F642;</datadesc></dataitem></datalist></recordinfo>]]></recorditem></appmsg>'
  }), context)
  assert.equal(forwarded.type, 'forwarded')
  assert.equal(forwarded.content_status, 'parsed')
  assert.match(forwarded.text, /Alice: First child text/)
  assert.match(forwarded.text, /Second 🙂/)

  const incomplete = normalizeMessage(row({ local_type: 49, message_content: '<appmsg><title>Chat history</title><type>19</type></appmsg>' }), context)
  assert.equal(incomplete.content_status, 'partial')
  assert.equal(incomplete.text, 'Chat history')

  const unknown = normalizeMessage(row({ local_type: 999, message_content: '<odd><payload><![CDATA[original payload]]></payload></odd>' }), context)
  assert.equal(unknown.type, 'other')
  assert.equal(unknown.content_status, 'partial')
  assert.match(unknown.text, /original payload/)
})

test('media reads a synthetic DAT image and enforces output budget and missing status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weflow-mcp-media-'))
  try {
    const image = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#336699' } }).jpeg().toBuffer()
    const xorKey = 0x6d
    const encryptedPath = join(directory, 'synthetic.dat')
    const encrypted = Buffer.alloc(image.length)
    for (let index = 0; index < image.length; index += 1) encrypted[index] = image[index] ^ xorKey
    await writeFile(encryptedPath, encrypted)
    const md5 = '0123456789abcdef0123456789abcdef'
    const mediaRow = row({ local_type: 3, message_content: `<msg><img md5="${md5}"/></msg>` })
    const id = messageId(scope, context.sessionId, mediaRow)
    const runtime = {
      resourcesPath: directory,
      ensureConnected: async () => ({ accountId: owner, accountScope: scope, dataDir: directory, mode: 'live' }),
      call: async (method: string) => {
        if (method === 'getMessageByLocator') return { success: true, message: mediaRow }
        if (method === 'resolveImageHardlink') return { success: true, data: { file_name: 'synthetic.dat', full_path: encryptedPath, type: 1 } }
        if (method === 'getCachedImageKeys') return { success: true, aesKey: '0123456789abcdef', xorKey, verified: true }
        throw new Error(`unexpected backend method ${method}`)
      }
    }
    const decoded = decryptDatV3(await readFile(encryptedPath), xorKey)
    assert.deepEqual(decoded, image)
    const aesKey = Buffer.from('0123456789abcdef', 'ascii')
    const cipher = createCipheriv('aes-128-ecb', aesKey, null)
    const aesPayload = Buffer.concat([cipher.update(image), cipher.final()])
    const header = Buffer.alloc(15)
    Buffer.from([7, 8, 0x56, 0x32, 8, 7]).copy(header)
    header.writeUInt32LE(image.length, 6)
    header.writeUInt32LE(0, 10)
    assert.deepEqual(decryptDatV4(Buffer.concat([header, aesPayload]), xorKey, aesKey), image)
    const result = await readMedia(runtime, id, { representation: 'image', quality: 'original' })
    assert.equal(result.data.availability, 'available')
    assert.equal(result.content?.[0].mimeType, 'image/jpeg')
    assert.ok(Buffer.from(result.content![0].data, 'base64').equals(image))

    const largePngPath = join(directory, 'large.png')
    const largeRaw = Buffer.alloc(2000 * 2000 * 3)
    let randomState = 0x12345678
    for (let index = 0; index < largeRaw.length; index += 1) {
      randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5
      largeRaw[index] = randomState & 0xff
    }
    const largePng = await sharp(largeRaw, { raw: { width: 2000, height: 2000, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
    assert.ok(largePng.length > 10 * 1024 * 1024, 'synthetic PNG must exceed the original-image output budget')
    await writeFile(largePngPath, largePng)
    const largeRuntime = {
      ensureConnected: runtime.ensureConnected,
      call: async (method: string) => method === 'getMessageByLocator' ? { success: true, message: mediaRow }
        : { success: true, data: { file_name: 'large.png', full_path: largePngPath } }
    }
    const tooLarge = await readMedia(largeRuntime, id, { representation: 'image', quality: 'original' })
    assert.equal(tooLarge.data.availability, 'too_large')

    const missingRuntime = {
      ensureConnected: runtime.ensureConnected,
      call: async (method: string) => method === 'getMessageByLocator' ? { success: true, message: mediaRow } : { success: false, error: 'not found' }
    }
    const missing = await readMedia(missingRuntime, id, { representation: 'image' })
    assert.equal(missing.data.availability, 'not_downloaded')

    const keyMissingRuntime = {
      ensureConnected: runtime.ensureConnected,
      call: async (method: string) => {
        if (method === 'getMessageByLocator') return { success: true, message: mediaRow }
        if (method === 'resolveImageHardlink') return { success: true, data: { full_path: encryptedPath } }
        throw Object.assign(new Error('cache empty'), { code: 'IMAGE_KEY_REQUIRED' })
      }
    }
    const keyMissing = await readMedia(keyMissingRuntime, id, { representation: 'image' })
    assert.equal(keyMissing.data.availability, 'key_required')

    const textRow = row({ message_content: 'plain text message' })
    const textId = messageId(scope, context.sessionId, textRow)
    const textRuntime = {
      ensureConnected: runtime.ensureConnected,
      call: async (method: string) => method === 'getMessageByLocator' ? { success: true, message: textRow } : assert.fail(`unexpected ${method}`)
    }
    const textMetadata = await readMedia(textRuntime, textId)
    assert.equal(textMetadata.data.kind, 'text')
    assert.equal(textMetadata.data.availability, 'unsupported')
    assert.equal(textMetadata.data.reason, 'unsupported_format')

    const heicPath = join(directory, 'synthetic.heic')
    const fakeHeic = Buffer.alloc(24)
    fakeHeic.writeUInt32BE(fakeHeic.length, 0)
    fakeHeic.write('ftyp', 4, 'ascii')
    fakeHeic.write('heic', 8, 'ascii')
    await writeFile(heicPath, fakeHeic)
    const heicRow = row({ local_type: 3, message_content: `<img md5="${md5}"/>` })
    const heicId = messageId(scope, context.sessionId, heicRow)
    const cancelledRuntime = {
      ensureConnected: runtime.ensureConnected,
      call: async (method: string) => method === 'getMessageByLocator' ? { success: true, message: heicRow } : { success: true, data: { full_path: heicPath } }
    }
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(readMedia(cancelledRuntime, heicId, { representation: 'image' }, abort.signal))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
