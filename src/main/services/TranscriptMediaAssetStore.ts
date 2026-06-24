import fs from 'fs'
import path from 'path'

export const TRANSCRIPT_MEDIA_ASSET_DIR = 'transcript-media'
export const TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES = 8 * 1024 * 1024
// AV assets are far larger than images. These are WRITE caps (anti-flood) and the
// READ-clamp ceiling. NOTE: the streaming `twmedia://` protocol (S0b) bypasses
// read() entirely (fs.createReadStream off disk), so these caps bound ingestion +
// the base64-over-IPC fetch path, never playback.
export const TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES = 64 * 1024 * 1024
export const TRANSCRIPT_MEDIA_MAX_VIDEO_BYTES = 512 * 1024 * 1024

/** Per-kind byte cap, keyed off the MIME top-level type. Image is the legacy
 * default. The read path MUST use this (not the image cap) or audio/video reads
 * back truncated/corrupt — the cap previously doubled as a hard 8MB read clamp. */
export function maxTranscriptMediaBytesForMime(mimeType: string): number {
  const m = mimeType.toLowerCase()
  if (m.startsWith('video/')) return TRANSCRIPT_MEDIA_MAX_VIDEO_BYTES
  if (m.startsWith('audio/')) return TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES
  return TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES
}

const SHA256_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{32,96}$/

export interface TranscriptMediaAssetWriteInput {
  sha256: string
  mimeType: string
  buffer: Buffer
}
export interface TranscriptMediaAssetReadInput {
  sha256: string
  mimeType: string
  maxBytes?: number
}

export type TranscriptMediaAssetReadResult =
  | { ok: true; buffer: Buffer; byteLength: number }
  | { ok: false; reason: 'invalid_hash' | 'missing' | 'too_large' | 'unsupported' }

function mediaExtension(mimeType: string): string | null {
  switch (mimeType.toLowerCase()) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/bmp':
      return 'bmp'
    // Audio containers (S0a — native AV pipeline).
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav'
    case 'audio/mpeg':
      return 'mp3'
    case 'audio/mp4':
      return 'm4a'
    case 'audio/aac':
      return 'aac'
    case 'audio/ogg':
      return 'ogg'
    case 'audio/flac':
    case 'audio/x-flac':
      return 'flac'
    // Video containers.
    case 'video/mp4':
      return 'mp4'
    case 'video/quicktime':
      return 'mov'
    case 'video/webm':
      return 'webm'
    default:
      return null
  }
}

function assertSafeSha256(value: string): void {
  if (!SHA256_BASE64URL_PATTERN.test(value)) {
    throw new Error('Invalid transcript media asset hash.')
  }
}

export function transcriptMediaAssetPath(
  baseDir: string,
  sha256: string,
  mimeType: string
): string {
  assertSafeSha256(sha256)
  const ext = mediaExtension(mimeType)
  if (!ext) throw new Error('Unsupported transcript media asset MIME type.')
  return path.join(baseDir, sha256.slice(0, 2), `${sha256}.${ext}`)
}

export class TranscriptMediaAssetStore {
  constructor(private readonly baseDir: string) {}

  write(input: TranscriptMediaAssetWriteInput): { ok: true } | { ok: false; reason: string } {
    try {
      if (!mediaExtension(input.mimeType)) return { ok: false, reason: 'unsupported' }
      if (
        input.buffer.length <= 0 ||
        input.buffer.length > maxTranscriptMediaBytesForMime(input.mimeType)
      ) {
        return { ok: false, reason: 'too_large' }
      }
      const target = transcriptMediaAssetPath(this.baseDir, input.sha256, input.mimeType)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      try {
        fs.writeFileSync(target, input.buffer, { flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  read(input: TranscriptMediaAssetReadInput): TranscriptMediaAssetReadResult {
    let target: string
    try {
      target = transcriptMediaAssetPath(this.baseDir, input.sha256, input.mimeType)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        reason: message.includes('MIME') ? 'unsupported' : 'invalid_hash'
      }
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(target)
    } catch {
      return { ok: false, reason: 'missing' }
    }
    if (!stat.isFile()) return { ok: false, reason: 'missing' }
    // Per-kind ceiling, NOT the fixed 8MB image cap — clamping a video to 8MB on
    // read silently truncates it to corruption.
    const cap = maxTranscriptMediaBytesForMime(input.mimeType)
    const maxBytes = Math.max(1, Math.min(cap, input.maxBytes ?? cap))
    if (stat.size <= 0 || stat.size > maxBytes) return { ok: false, reason: 'too_large' }
    const buffer = fs.readFileSync(target)
    if (buffer.length > maxBytes) return { ok: false, reason: 'too_large' }
    return { ok: true, buffer, byteLength: buffer.length }
  }
}
