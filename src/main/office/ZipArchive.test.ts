import { deflateRawSync } from 'zlib'
import { describe, expect, it } from 'vitest'
import { buildZip, crc32, parseZip, ZipArchiveError } from './ZipArchive'

/** Hand-builds a single-entry DEFLATE zip to exercise the inflate path. */
function buildDeflateZip(name: string, content: Buffer): Buffer {
  const compressed = deflateRawSync(content)
  const nameBytes = Buffer.from(name, 'utf8')
  const checksum = crc32(content)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt16LE(8, 8) // DEFLATE
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(checksum, 16)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt32LE(0, 42) // local offset

  const centralStart = local.length + nameBytes.length + compressed.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + nameBytes.length, 12)
  eocd.writeUInt32LE(centralStart, 16)

  return Buffer.concat([local, nameBytes, compressed, central, nameBytes, eocd])
}

describe('buildZip / parseZip', () => {
  it('round-trips STORE entries and preserves binary content', () => {
    const binary = Buffer.from([0, 1, 2, 255, 254, 253, 10, 13])
    const archive = buildZip([
      { name: 'word/document.xml', data: Buffer.from('<doc>héllo</doc>', 'utf8') },
      { name: 'bin/data', data: binary }
    ])
    const entries = parseZip(archive)
    expect([...entries.keys()]).toEqual(['word/document.xml', 'bin/data'])
    expect(entries.get('word/document.xml')?.toString('utf8')).toBe('<doc>héllo</doc>')
    expect(entries.get('bin/data')).toEqual(binary)
  })

  it('is byte-deterministic for identical input', () => {
    const entries = [{ name: 'a.xml', data: Buffer.from('x') }]
    expect(buildZip(entries).equals(buildZip(entries))).toBe(true)
  })

  it('reads DEFLATE-compressed entries', () => {
    const content = Buffer.from('deflate me '.repeat(100), 'utf8')
    const archive = buildDeflateZip('data.xml', content)
    const entries = parseZip(archive)
    expect(entries.get('data.xml')).toEqual(content)
  })

  it('rejects non-zip data with a clear error', () => {
    expect(() => parseZip(Buffer.from('not a zip at all'))).toThrow(ZipArchiveError)
  })

  it('rejects unsupported compression methods', () => {
    const archive = buildDeflateZip('x', Buffer.from('y'))
    // Patch method to 99 (both central and local records).
    archive.writeUInt16LE(99, 8)
    const centralStart = archive.readUInt32LE(archive.length - 22 + 16)
    archive.writeUInt16LE(99, centralStart + 10)
    expect(() => parseZip(archive)).toThrow(/Unsupported ZIP compression/)
  })

  it('rejects entries whose declared size mismatches the data', () => {
    const content = Buffer.from('abc')
    const archive = buildDeflateZip('x', content)
    const centralStart = archive.readUInt32LE(archive.length - 22 + 16)
    archive.writeUInt32LE(999, centralStart + 24) // lie about uncompressed size
    expect(() => parseZip(archive)).toThrow(/size mismatch/)
  })

  it('skips directory entries', () => {
    const archive = buildZip([
      { name: 'dir/', data: Buffer.alloc(0) },
      { name: 'dir/file.txt', data: Buffer.from('v') }
    ])
    const entries = parseZip(archive)
    expect(entries.has('dir/')).toBe(false)
    expect(entries.get('dir/file.txt')?.toString()).toBe('v')
  })
})

describe('crc32', () => {
  it('matches the known vector for "123456789"', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })
})
