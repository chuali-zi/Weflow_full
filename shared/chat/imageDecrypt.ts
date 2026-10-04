import { createDecipheriv } from 'crypto'

export function datVersion(data: Buffer): number {
  if (data.length < 6) return 0
  if (data.subarray(0, 6).equals(Buffer.from([7, 8, 0x56, 0x31, 8, 7]))) return 1
  if (data.subarray(0, 6).equals(Buffer.from([7, 8, 0x56, 0x32, 8, 7]))) return 2
  return 0
}

export function decryptDatV3(data: Buffer, xorKey: number): Buffer {
  const result = Buffer.allocUnsafe(data.length)
  for (let index = 0; index < data.length; index += 1) result[index] = data[index] ^ xorKey
  return result
}

function int32le(data: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) throw new Error('invalid int32 offset')
  return data.readInt32LE(offset)
}

function removePadding(data: Buffer): Buffer {
  if (!data.length) throw new Error('empty decrypted data')
  const padding = data[data.length - 1]
  if (padding < 1 || padding > 16 || padding > data.length) throw new Error('invalid pkcs7 padding')
  for (let index = data.length - padding; index < data.length; index += 1) {
    if (data[index] !== padding) throw new Error('invalid pkcs7 padding')
  }
  return data.subarray(0, data.length - padding)
}

export function decryptDatV4(data: Buffer, xorKey: number, aesKey: Buffer): Buffer {
  if (data.length < 0x0f) throw new Error('dat file too small')
  const header = data.subarray(0, 0x0f)
  const payload = data.subarray(0x0f)
  const aesSize = int32le(header, 6)
  const xorSize = int32le(header, 10)
  if (aesSize < 0) throw new Error('invalid aes size')
  const alignedAesSize = aesSize + (16 - ((aesSize % 16 + 16) % 16))
  if (alignedAesSize > payload.length) throw new Error('invalid aes size')
  const aesData = payload.subarray(0, alignedAesSize)
  let plainAes: Buffer = Buffer.alloc(0)
  if (aesData.length) {
    const decipher = createDecipheriv('aes-128-ecb', aesKey, Buffer.alloc(0))
    decipher.setAutoPadding(false)
    plainAes = removePadding(Buffer.concat([decipher.update(aesData), decipher.final()]))
    if (plainAes.length !== aesSize) throw new Error('invalid aes plaintext size')
  }
  const remaining = payload.subarray(alignedAesSize)
  if (xorSize < 0 || xorSize > remaining.length) throw new Error('invalid xor size')
  if (!xorSize) return Buffer.concat([plainAes, remaining])
  const split = remaining.length - xorSize
  const decodedXor = Buffer.allocUnsafe(xorSize)
  for (let index = 0; index < xorSize; index += 1) decodedXor[index] = remaining[split + index] ^ xorKey
  return Buffer.concat([plainAes, remaining.subarray(0, split), decodedXor])
}
