import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  THREAD_MEDIA_CHUNK_MAX_BYTES,
  TranscriptMediaAssetStore,
  transcriptMediaAssetPath
} from '../services/TranscriptMediaAssetStore'
import {
  TranscriptMediaRangeOutOfBoundsError,
  openTranscriptMediaAsset,
  parseTwMediaUrl,
  readAssetSlice,
  readOpenedAssetSlice,
  readTranscriptMediaRangeSlice,
  resolveMediaRange,
  resolveTwMediaAsset,
  twMediaMimeForExt
} from './twMediaRange'

const VALID_SHA = 'wavHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'
const roots: string[] = []
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-twmedia-'))
  roots.push(root)
  return root
}
afterEach(() => {
  while (roots.length) {
    const root = roots.pop()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('resolveMediaRange', () => {
  const SIZE = 1000
  it('returns full 200 when no Range header is present', () => {
    expect(resolveMediaRange(null, SIZE)).toMatchObject({ status: 200, start: 0, end: 999, contentLength: 1000 })
  })
  it('returns 206 for an explicit byte range and clamps end to size-1', () => {
    expect(resolveMediaRange('bytes=0-499', SIZE)).toMatchObject({
      status: 206, start: 0, end: 499, contentLength: 500, contentRange: 'bytes 0-499/1000'
    })
    expect(resolveMediaRange('bytes=0-1023', SIZE)).toMatchObject({
      status: 206, start: 0, end: 999, contentLength: 1000, contentRange: 'bytes 0-999/1000'
    })
  })
  it('returns 206 (NOT 200) for open-ended-from-0 — Chromium media expects 206', () => {
    expect(resolveMediaRange('bytes=0-', SIZE)).toMatchObject({ status: 206, start: 0, end: 999, contentLength: 1000 })
  })
  it('handles open-ended and suffix ranges', () => {
    expect(resolveMediaRange('bytes=500-', SIZE)).toMatchObject({ status: 206, start: 500, end: 999, contentLength: 500 })
    expect(resolveMediaRange('bytes=-200', SIZE)).toMatchObject({ status: 206, start: 800, end: 999, contentLength: 200 })
    expect(resolveMediaRange('bytes=999-', SIZE)).toMatchObject({ status: 206, start: 999, end: 999, contentLength: 1 })
    // Suffix N larger than the file → clamp to the whole file (RFC 7233).
    expect(resolveMediaRange('bytes=-5000', SIZE)).toMatchObject({ status: 206, start: 0, end: 999, contentLength: 1000 })
  })
  it('returns 416 for unsatisfiable ranges', () => {
    expect(resolveMediaRange('bytes=1000-', SIZE).status).toBe(416) // start >= size
    expect(resolveMediaRange('bytes=500-499', SIZE).status).toBe(416) // start > end
    expect(resolveMediaRange('bytes=-0', SIZE).status).toBe(416) // zero-length suffix
    expect(resolveMediaRange('bytes=-', SIZE).status).toBe(416) // both empty
    expect(resolveMediaRange('bytes=0-99', 0).status).toBe(416) // empty file
    expect(resolveMediaRange('bytes=1000-', SIZE).contentRange).toBe('bytes */1000')
  })
  it('ignores an unparseable / multi-range header and serves full 200 (spec-OK)', () => {
    expect(resolveMediaRange('bytes=abc-def', SIZE).status).toBe(200)
    expect(resolveMediaRange('bytes=0-9,20-29', SIZE).status).toBe(200) // multi-range not implemented
    expect(resolveMediaRange('bytes=', SIZE).status).toBe(200) // no dash
  })
})

describe('parseTwMediaUrl', () => {
  it('parses a valid asset URL into sha/ext/mime', () => {
    expect(parseTwMediaUrl(`twmedia://asset/${VALID_SHA}.mp4`)).toEqual({
      sha256: VALID_SHA, ext: 'mp4', mime: 'video/mp4'
    })
  })
  it('rejects wrong scheme, wrong host, bad sha, unknown ext, traversal', () => {
    expect(parseTwMediaUrl(`https://asset/${VALID_SHA}.mp4`)).toBeNull()
    expect(parseTwMediaUrl(`twmedia://other/${VALID_SHA}.mp4`)).toBeNull()
    expect(parseTwMediaUrl(`twmedia://asset/short.mp4`)).toBeNull() // sha too short
    expect(parseTwMediaUrl(`twmedia://asset/${VALID_SHA}.exe`)).toBeNull() // unknown/unsupported ext
    expect(parseTwMediaUrl(`twmedia://asset/../../etc/passwd.mp4`)).toBeNull() // normalized + sha-rejected
    expect(parseTwMediaUrl('not a url')).toBeNull()
  })
})

describe('twMediaMimeForExt ↔ asset-store extension consistency', () => {
  // Lock the twmedia ext→mime map to the asset store's mime→ext map: every ext
  // the protocol serves must map to a mime the store persists with that SAME ext.
  it('round-trips every supported extension through the asset store path', () => {
    const exts = ['png', 'jpg', 'webp', 'gif', 'bmp', 'wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac', 'mp4', 'mov', 'webm']
    for (const ext of exts) {
      const mime = twMediaMimeForExt(ext)
      expect(mime, ext).toBeTruthy()
      const stored = transcriptMediaAssetPath('/base', VALID_SHA, mime as string)
      expect(stored.endsWith(`.${ext}`), `${ext} → ${mime}`).toBe(true)
    }
  })
})

describe('resolveTwMediaAsset (realpath jail)', () => {
  it('resolves a stored asset and reports mime + size', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const buffer = Buffer.from('RIFF....WAVEdata-bytes')
    expect(store.write({ sha256: VALID_SHA, mimeType: 'audio/wav', buffer })).toEqual({ ok: true })
    const resolved = resolveTwMediaAsset(root, `twmedia://asset/${VALID_SHA}.wav`)
    expect(resolved).not.toBeNull()
    expect(resolved?.mime).toBe('audio/wav')
    expect(resolved?.size).toBe(buffer.length)
    expect(resolved?.realPath).toBe(transcriptMediaAssetPath(fs.realpathSync.native(root), VALID_SHA, 'audio/wav'))
    resolved?.close()
  })
  it('returns null for a missing file, bad URL, or unsupported ext', () => {
    const root = makeRoot()
    expect(resolveTwMediaAsset(root, `twmedia://asset/${VALID_SHA}.wav`)).toBeNull() // not written
    expect(resolveTwMediaAsset(root, `twmedia://asset/short.wav`)).toBeNull()
    expect(resolveTwMediaAsset(root, `https://asset/${VALID_SHA}.wav`)).toBeNull()
  })
})

describe('openTranscriptMediaAsset (descriptor identity)', () => {
  function writeAsset(baseDir: string, buffer: Buffer): string {
    const store = new TranscriptMediaAssetStore(baseDir)
    expect(store.write({ sha256: VALID_SHA, mimeType: 'audio/wav', buffer })).toEqual({ ok: true })
    return transcriptMediaAssetPath(fs.realpathSync.native(baseDir), VALID_SHA, 'audio/wav')
  }

  it('rejects leaf symlinks, shard symlinks, and multiply-linked files', () => {
    const leafRoot = makeRoot()
    const outsideRoot = makeRoot()
    const outside = path.join(outsideRoot, 'outside.wav')
    fs.writeFileSync(outside, 'outside')
    const leaf = transcriptMediaAssetPath(leafRoot, VALID_SHA, 'audio/wav')
    fs.mkdirSync(path.dirname(leaf), { recursive: true })
    fs.symlinkSync(outside, leaf)
    expect(
      openTranscriptMediaAsset({ baseDir: leafRoot, sha256: VALID_SHA, mimeType: 'audio/wav' })
    ).toBeNull()

    const shardRoot = makeRoot()
    const shard = path.join(shardRoot, VALID_SHA.slice(0, 2))
    fs.symlinkSync(outsideRoot, shard)
    fs.writeFileSync(path.join(outsideRoot, `${VALID_SHA}.wav`), 'outside-shard')
    expect(
      openTranscriptMediaAsset({ baseDir: shardRoot, sha256: VALID_SHA, mimeType: 'audio/wav' })
    ).toBeNull()

    const hardLinkRoot = makeRoot()
    const hardLink = writeAsset(hardLinkRoot, Buffer.from('hard-linked'))
    fs.linkSync(hardLink, path.join(hardLinkRoot, 'second-link.wav'))
    expect(
      openTranscriptMediaAsset({ baseDir: hardLinkRoot, sha256: VALID_SHA, mimeType: 'audio/wav' })
    ).toBeNull()
  })

  it('keeps reads on the exact descriptor after the store path is replaced', () => {
    const root = makeRoot()
    const original = Buffer.from('ORIGINAL-DESCRIPTOR')
    const replacement = Buffer.from('REPLACEMENT-CONTENT')
    expect(replacement.length).toBe(original.length)
    const target = writeAsset(root, original)
    const asset = openTranscriptMediaAsset({
      baseDir: root,
      sha256: VALID_SHA,
      mimeType: 'audio/wav'
    })
    expect(asset).not.toBeNull()
    if (!asset) return
    try {
      fs.renameSync(target, `${target}.original`)
      fs.writeFileSync(target, replacement, { mode: 0o600 })
      expect(readOpenedAssetSlice(asset, 0, original.length - 1)).toEqual(original)
    } finally {
      asset.close()
    }
  })

  it('fails closed when the leaf is replaced between lstat and O_NOFOLLOW open', () => {
    const root = makeRoot()
    const target = writeAsset(root, Buffer.from('first-file'))
    const originalOpen = fs.openSync
    let swapped = false
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((
      filePath: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode
    ) => {
      if (!swapped && String(filePath) === target) {
        swapped = true
        fs.renameSync(target, `${target}.before-open`)
        fs.writeFileSync(target, 'replacement', { mode: 0o600 })
      }
      return originalOpen(filePath, flags, mode)
    }) as typeof fs.openSync)
    try {
      expect(
        openTranscriptMediaAsset({ baseDir: root, sha256: VALID_SHA, mimeType: 'audio/wav' })
      ).toBeNull()
    } finally {
      openSpy.mockRestore()
    }
  })

  it('fails closed when the opened inode is truncated before a read', () => {
    const root = makeRoot()
    const target = writeAsset(root, Buffer.from('0123456789'))
    const asset = openTranscriptMediaAsset({
      baseDir: root,
      sha256: VALID_SHA,
      mimeType: 'audio/wav'
    })
    expect(asset).not.toBeNull()
    if (!asset) return
    try {
      fs.truncateSync(target, 3)
      expect(() => readOpenedAssetSlice(asset, 0, 9)).toThrow(/changed before read/)
    } finally {
      asset.close()
    }
  })
})

describe('readAssetSlice', () => {
  it('reads exactly the requested inclusive byte range', () => {
    const root = makeRoot()
    const file = path.join(root, 'data.bin')
    fs.writeFileSync(file, Buffer.from('0123456789'))
    expect(readAssetSlice(file, 0, 9).toString()).toBe('0123456789')
    expect(readAssetSlice(file, 2, 4).toString()).toBe('234') // inclusive end
    expect(readAssetSlice(file, 9, 9).toString()).toBe('9')
    expect(readAssetSlice(file, 0, 9).length).toBe(10) // body length === committed Content-Length
  })

  it('throws on a short read instead of returning a truncated body', () => {
    const root = makeRoot()
    const file = path.join(root, 'short.bin')
    fs.writeFileSync(file, Buffer.from('012'))
    // Beyond EOF: returning 3 bytes under a Content-Length of 10 would wedge <video>.
    expect(() => readAssetSlice(file, 0, 9)).toThrow(/short read/)
  })
})

describe('readTranscriptMediaRangeSlice (chunked bridge mode)', () => {
  // Write a sha-sharded asset under a tmp baseDir at the store's own layout.
  function writeAsset(baseDir: string, sha256: string, mimeType: string, buffer: Buffer): void {
    const target = transcriptMediaAssetPath(baseDir, sha256, mimeType)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, buffer)
  }

  it('returns the correct slice bytes for a known buffer (+ echoes offset/totalBytes)', () => {
    const root = makeRoot()
    const body = Buffer.from('0123456789ABCDEF') // 16 bytes
    writeAsset(root, VALID_SHA, 'audio/wav', body)
    const slice = readTranscriptMediaRangeSlice({
      baseDir: root,
      sha256: VALID_SHA,
      mimeType: 'audio/wav',
      offset: 4,
      requestedLength: 5
    })
    expect(Buffer.from(slice.dataBase64, 'base64').toString()).toBe('45678') // indices 4..8 inclusive
    expect(slice.byteLength).toBe(5)
    expect(slice.offset).toBe(4)
    expect(slice.totalBytes).toBe(16)
  })

  it('reads the whole asset when requestedLength covers it (offset 0)', () => {
    const root = makeRoot()
    const body = Buffer.from('0123456789')
    writeAsset(root, VALID_SHA, 'audio/wav', body)
    const slice = readTranscriptMediaRangeSlice({
      baseDir: root,
      sha256: VALID_SHA,
      mimeType: 'audio/wav',
      offset: 0,
      requestedLength: 10
    })
    expect(Buffer.from(slice.dataBase64, 'base64').equals(body)).toBe(true)
    expect(slice.byteLength).toBe(10)
    expect(slice.totalBytes).toBe(10)
  })

  it('HARD-clamps effLength to THREAD_MEDIA_CHUNK_MAX_BYTES regardless of requestedLength', () => {
    const root = makeRoot()
    // Asset larger than the per-chunk cap so the cap (not the tail) is the binding limit.
    const total = THREAD_MEDIA_CHUNK_MAX_BYTES + 4096
    const body = Buffer.alloc(total, 7)
    writeAsset(root, VALID_SHA, 'audio/wav', body)
    const slice = readTranscriptMediaRangeSlice({
      baseDir: root,
      sha256: VALID_SHA,
      mimeType: 'audio/wav',
      offset: 0,
      requestedLength: total // client asks for the whole thing in one slice
    })
    // Server refuses to ship more than the cap in a single frame.
    expect(slice.byteLength).toBe(THREAD_MEDIA_CHUNK_MAX_BYTES)
    expect(slice.totalBytes).toBe(total)
    expect(slice.offset).toBe(0)
  })

  it('clamps effLength to (totalBytes - offset) at the tail', () => {
    const root = makeRoot()
    const body = Buffer.alloc(100, 9)
    writeAsset(root, VALID_SHA, 'audio/wav', body)
    const slice = readTranscriptMediaRangeSlice({
      baseDir: root,
      sha256: VALID_SHA,
      mimeType: 'audio/wav',
      offset: 90,
      requestedLength: THREAD_MEDIA_CHUNK_MAX_BYTES // far more than remains
    })
    expect(slice.byteLength).toBe(10) // only 10 bytes remain after offset 90
    expect(slice.offset).toBe(90)
    expect(slice.totalBytes).toBe(100)
  })

  it('throws TranscriptMediaRangeOutOfBoundsError when offset >= totalBytes', () => {
    const root = makeRoot()
    const body = Buffer.from('0123456789') // size 10
    writeAsset(root, VALID_SHA, 'audio/wav', body)
    expect(() =>
      readTranscriptMediaRangeSlice({
        baseDir: root,
        sha256: VALID_SHA,
        mimeType: 'audio/wav',
        offset: 10, // == totalBytes → out of bounds
        requestedLength: 1
      })
    ).toThrow(TranscriptMediaRangeOutOfBoundsError)
    expect(() =>
      readTranscriptMediaRangeSlice({
        baseDir: root,
        sha256: VALID_SHA,
        mimeType: 'audio/wav',
        offset: 999,
        requestedLength: 1
      })
    ).toThrow(/out of bounds/)
  })

  it('rejects a hostile sha / unsupported mime via the asset-store path jail', () => {
    const root = makeRoot()
    expect(() =>
      readTranscriptMediaRangeSlice({
        baseDir: root,
        sha256: '../../etc/passwd',
        mimeType: 'audio/wav',
        offset: 0,
        requestedLength: 1
      })
    ).toThrow() // assertSafeSha256 rejects
    expect(() =>
      readTranscriptMediaRangeSlice({
        baseDir: root,
        sha256: VALID_SHA,
        mimeType: 'application/x-evil',
        offset: 0,
        requestedLength: 1
      })
    ).toThrow() // mime→ext whitelist rejects
  })
})
