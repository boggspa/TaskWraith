/**
 * Minimal ZIP reader/writer for OOXML containers (.docx/.xlsx/.pptx).
 *
 * Writer emits STORE-method archives with the UTF-8 name flag and a fixed
 * timestamp — deterministic output, accepted by Word/Excel/PowerPoint and
 * Google import alike (OOXML consumers never require compression).
 *
 * Reader supports STORE and DEFLATE entries via zlib, reads sizes from the
 * central directory (so data-descriptor archives work), and enforces
 * zip-bomb caps. ZIP64 is intentionally unsupported: the office IPC lane
 * caps files far below 4 GB.
 */

import { inflateRawSync } from 'zlib'

export class ZipArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipArchiveError'
  }
}

const MAX_ZIP_ENTRIES = 4_096
const MAX_ENTRY_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_UNCOMPRESSED_BYTES = 192 * 1024 * 1024

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

// Fixed DOS stamp: 2026-01-01 00:00:00 — keeps builds byte-stable.
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipEntryInput {
  name: string
  data: Buffer
}

/** Builds a STORE-method archive. Entry order is preserved. */
export function buildZip(entries: ZipEntryInput[]): Buffer {
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new ZipArchiveError('Too many entries for a ZIP archive.')
  }
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // method STORE
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    localParts.push(local, nameBytes, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)

    offset += local.length + nameBytes.length + entry.data.length
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, ...centralParts, eocd])
}

/** Parses an archive into name → content. Later duplicates win (per spec practice). */
export function parseZip(archive: Buffer): Map<string, Buffer> {
  const eocdOffset = findEndOfCentralDirectory(archive)
  const entryCount = archive.readUInt16LE(eocdOffset + 10)
  const centralOffset = archive.readUInt32LE(eocdOffset + 16)
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new ZipArchiveError('ZIP archive has too many entries.')
  }
  if (centralOffset === 0xffffffff || entryCount === 0xffff) {
    throw new ZipArchiveError('ZIP64 archives are not supported.')
  }

  const entries = new Map<string, Buffer>()
  let cursor = centralOffset
  let totalUncompressed = 0

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length) {
      throw new ZipArchiveError('Truncated ZIP central directory.')
    }
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipArchiveError('Malformed ZIP central directory.')
    }
    const method = archive.readUInt16LE(cursor + 10)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new ZipArchiveError('ZIP64 entries are not supported.')
    }
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new ZipArchiveError(`ZIP entry too large: ${name}`)
    }
    totalUncompressed += uncompressedSize
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new ZipArchiveError('ZIP archive expands beyond the allowed size.')
    }
    if (name.endsWith('/')) continue // directory entry

    if (localOffset + 30 > archive.length) {
      throw new ZipArchiveError(`Truncated ZIP entry: ${name}`)
    }
    if (archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new ZipArchiveError(`Malformed ZIP local header: ${name}`)
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > archive.length) {
      throw new ZipArchiveError(`Truncated ZIP data: ${name}`)
    }
    const compressed = archive.subarray(dataStart, dataEnd)

    let data: Buffer
    if (method === 0) {
      data = Buffer.from(compressed)
    } else if (method === 8) {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_UNCOMPRESSED_BYTES })
      } catch {
        throw new ZipArchiveError(`Corrupt DEFLATE data in ZIP entry: ${name}`)
      }
    } else {
      throw new ZipArchiveError(`Unsupported ZIP compression method ${method}: ${name}`)
    }
    if (data.length !== uncompressedSize) {
      throw new ZipArchiveError(`ZIP entry size mismatch: ${name}`)
    }
    entries.set(name, data)
  }

  return entries
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minOffset = Math.max(0, archive.length - 22 - 65_535)
  for (let cursor = archive.length - 22; cursor >= minOffset; cursor -= 1) {
    if (archive.readUInt32LE(cursor) === EOCD_SIGNATURE) return cursor
  }
  throw new ZipArchiveError('Not a ZIP archive (end-of-central-directory not found).')
}
