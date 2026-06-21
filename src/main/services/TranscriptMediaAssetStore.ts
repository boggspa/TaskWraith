import fs from 'fs'
import path from 'path'

export const TRANSCRIPT_MEDIA_ASSET_DIR = 'transcript-media'
export const TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES = 8 * 1024 * 1024

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
      if (input.buffer.length <= 0 || input.buffer.length > TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES) {
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
    const maxBytes = Math.max(
      1,
      Math.min(TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES, input.maxBytes ?? TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES)
    )
    if (stat.size <= 0 || stat.size > maxBytes) return { ok: false, reason: 'too_large' }
    const buffer = fs.readFileSync(target)
    if (buffer.length > maxBytes) return { ok: false, reason: 'too_large' }
    return { ok: true, buffer, byteLength: buffer.length }
  }
}
