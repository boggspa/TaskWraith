import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TranscriptMediaAssetStore,
  transcriptMediaAssetPath
} from '../services/TranscriptMediaAssetStore'
import {
  parseTwMediaUrl,
  readAssetSlice,
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
  })
  it('returns null for a missing file, bad URL, or unsupported ext', () => {
    const root = makeRoot()
    expect(resolveTwMediaAsset(root, `twmedia://asset/${VALID_SHA}.wav`)).toBeNull() // not written
    expect(resolveTwMediaAsset(root, `twmedia://asset/short.wav`)).toBeNull()
    expect(resolveTwMediaAsset(root, `https://asset/${VALID_SHA}.wav`)).toBeNull()
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
