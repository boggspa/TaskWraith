import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES,
  TranscriptMediaAssetStore,
  transcriptMediaAssetPath
} from './TranscriptMediaAssetStore'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-media-assets-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
})
describe('TranscriptMediaAssetStore', () => {
  it('writes and reads original image bytes by content hash', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const sha256 = 'abcDEF1234567890_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'
    const buffer = Buffer.from('image-bytes')

    expect(store.write({ sha256, mimeType: 'image/png', buffer })).toEqual({ ok: true })
    expect(transcriptMediaAssetPath(root, sha256, 'image/png')).toBe(
      path.join(root, 'ab', `${sha256}.png`)
    )
    expect(store.read({ sha256, mimeType: 'image/png' })).toMatchObject({
      ok: true,
      byteLength: buffer.length
    })
    const read = store.read({ sha256, mimeType: 'image/png' })
    expect(read.ok && read.buffer.equals(buffer)).toBe(true)
  })

  it('treats duplicate writes as successful idempotent writes', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const sha256 = 'duplicateHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'
    const buffer = Buffer.from('same-bytes')

    expect(store.write({ sha256, mimeType: 'image/jpeg', buffer })).toEqual({ ok: true })
    expect(store.write({ sha256, mimeType: 'image/jpeg', buffer })).toEqual({ ok: true })
  })

  it('rejects invalid hashes, unsupported MIME types, and over-budget reads', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const sha256 = 'sizeHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'
    const buffer = Buffer.from('image-bytes')

    expect(store.write({ sha256: '../bad', mimeType: 'image/png', buffer }).ok).toBe(false)
    expect(store.write({ sha256, mimeType: 'image/svg+xml', buffer })).toEqual({
      ok: false,
      reason: 'unsupported'
    })
    expect(store.write({ sha256, mimeType: 'image/png', buffer })).toEqual({ ok: true })
    expect(store.read({ sha256, mimeType: 'image/png', maxBytes: 4 })).toEqual({
      ok: false,
      reason: 'too_large'
    })
    expect(
      store.write({
        sha256: 'largeHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ',
        mimeType: 'image/png',
        buffer: Buffer.alloc(TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES + 1)
      })
    ).toEqual({ ok: false, reason: 'too_large' })
  })
})
