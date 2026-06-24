import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES,
  TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES,
  TRANSCRIPT_MEDIA_MAX_VIDEO_BYTES,
  TranscriptMediaAssetStore,
  maxTranscriptMediaBytesForMime,
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

  it('stores audio + video assets by content hash with the right extension (S0a)', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const wav = {
      sha256: 'wavHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ',
      mimeType: 'audio/wav',
      buffer: Buffer.from('RIFF....WAVEdata')
    }
    expect(store.write(wav)).toEqual({ ok: true })
    expect(transcriptMediaAssetPath(root, wav.sha256, 'audio/wav')).toBe(
      path.join(root, 'wa', `${wav.sha256}.wav`)
    )
    const readWav = store.read({ sha256: wav.sha256, mimeType: 'audio/wav' })
    expect(readWav.ok && readWav.buffer.equals(wav.buffer)).toBe(true)

    const mp4 = {
      sha256: 'mp4Hash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ',
      mimeType: 'video/mp4',
      buffer: Buffer.from('ftypisomMOOV')
    }
    expect(store.write(mp4)).toEqual({ ok: true })
    expect(transcriptMediaAssetPath(root, mp4.sha256, 'video/mp4')).toBe(
      path.join(root, 'mp', `${mp4.sha256}.mp4`)
    )
  })

  it('keys byte caps off the MIME kind (audio/video far exceed the image cap)', () => {
    expect(maxTranscriptMediaBytesForMime('image/png')).toBe(TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES)
    expect(maxTranscriptMediaBytesForMime('audio/wav')).toBe(TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES)
    expect(maxTranscriptMediaBytesForMime('video/mp4')).toBe(TRANSCRIPT_MEDIA_MAX_VIDEO_BYTES)
    expect(maxTranscriptMediaBytesForMime('application/octet-stream')).toBe(
      TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES
    )
    expect(TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES).toBeGreaterThan(TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES)
    expect(TRANSCRIPT_MEDIA_MAX_VIDEO_BYTES).toBeGreaterThan(TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES)
  })

  it('reads back an audio asset larger than the 8MB image cap without truncating', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const sha256 = 'bigAudioHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'
    // 9MB > the legacy 8MB image read-clamp — must NOT be rejected or truncated for audio.
    const buffer = Buffer.alloc(TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES + 1024 * 1024, 7)
    expect(store.write({ sha256, mimeType: 'audio/wav', buffer })).toEqual({ ok: true })
    const read = store.read({ sha256, mimeType: 'audio/wav' })
    expect(read.ok && read.byteLength).toBe(buffer.length)
  })
})
