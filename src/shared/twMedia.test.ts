import { describe, expect, it } from 'vitest'
import { TW_MEDIA_SCHEME, twMediaExtForMime, twMediaMimeForExt, twMediaUrl } from './twMedia'
import { transcriptMediaAssetPath } from '../main/services/TranscriptMediaAssetStore'

const SHA = 'abcDEF1234567890_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'

describe('twMediaUrl', () => {
  it('builds twmedia://asset/<sha>.<ext> from a sha + mime', () => {
    expect(twMediaUrl(SHA, 'video/mp4')).toBe(`twmedia://asset/${SHA}.mp4`)
    expect(twMediaUrl(SHA, 'audio/wav')).toBe(`twmedia://asset/${SHA}.wav`)
    expect(twMediaUrl(SHA, 'audio/x-wav')).toBe(`twmedia://asset/${SHA}.wav`) // alias mime
  })
  it('returns null without a sha or for an unmappable mime', () => {
    expect(twMediaUrl(undefined, 'video/mp4')).toBeNull()
    expect(twMediaUrl('', 'video/mp4')).toBeNull()
    expect(twMediaUrl(SHA, 'application/zip')).toBeNull()
    expect(twMediaUrl(SHA, undefined)).toBeNull()
  })
  it('exposes the scheme', () => {
    expect(TW_MEDIA_SCHEME).toBe('twmedia')
  })
})

describe('twMedia mime↔ext consistency with the asset store', () => {
  // The renderer builds twmedia URLs as <sha>.<ext>; the store writes the file at
  // <sha>.<ext>. If these two ext mappings drift, every AV URL 404s. Lock them.
  it('maps every supported mime to the ext the asset store persists it as', () => {
    const mimes = [
      'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/bmp',
      'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg',
      'audio/flac', 'audio/x-flac', 'video/mp4', 'video/quicktime', 'video/webm'
    ]
    for (const mime of mimes) {
      const ext = twMediaExtForMime(mime)
      expect(ext, mime).toBeTruthy()
      expect(transcriptMediaAssetPath('/base', SHA, mime).endsWith(`.${ext}`), mime).toBe(true)
      // The canonical ext maps back to a servable mime (the protocol's Content-Type).
      expect(twMediaMimeForExt(ext as string), ext as string).toBeTruthy()
    }
  })
})
