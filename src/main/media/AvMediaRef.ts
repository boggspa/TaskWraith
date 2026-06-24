import type { TranscriptMediaRef } from '../store/types'

/**
 * PURE (zero-IO, Electron-free) builder for an audio/video TranscriptMediaRef — the
 * payload the S1b-3 producers (audio_extract / transcode_audio / transcode_video) put
 * on the TRUSTED media channel (McpToolExecutionResult.trustedMediaRefs). The host
 * injects these straight into run state, bypassing the image-only provider sanitizer
 * (which hard-drops kind!=='image'); this module owns the validation that keeps that
 * lane honest: only a known AV mime + a non-empty sha256 yields a ref, else null.
 *
 * The sha256 itself is NOT computed here — the content-addressed asset store owns it;
 * the caller passes the canonical digest it got back from persistOutput.
 */

// The 9 AV mimes the asset store + twmedia:// protocol can actually serve. Kept as a
// local set (twMedia's mime→ext map mixes in image mimes, so it's not a clean AV gate).
const AV_MIMES = new Set<string>([
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
  'video/mp4',
  'video/quicktime',
  'video/webm'
])

export interface BuildAvMediaRefInput {
  sha256: string
  mimeType: string
  name: string
  runId?: string
  byteLength?: number
  durationMs?: number
  codecs?: string
}

export function buildAvMediaRef(input: BuildAvMediaRefInput): TranscriptMediaRef | null {
  const sha256 = typeof input.sha256 === 'string' ? input.sha256.trim() : ''
  if (!sha256) return null
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : ''
  if (!AV_MIMES.has(mimeType)) return null

  // Derive kind from the mime prefix (already validated as an AV mime above).
  const kind: 'audio' | 'video' = mimeType.startsWith('audio/') ? 'audio' : 'video'

  // Stable, content-addressed, never-empty id (the renderer hard-drops refs with an
  // empty id). Scoped by runId so two runs producing the same bytes stay distinct.
  const id = `${input.runId ?? 'run'}:av:${sha256.slice(0, 24)}`

  const ref: TranscriptMediaRef = {
    id,
    kind,
    format: 'container',
    source: 'generated',
    name: input.name,
    mimeType,
    sha256,
    status: 'available'
  }
  if (typeof input.byteLength === 'number' && Number.isFinite(input.byteLength)) ref.byteLength = input.byteLength
  if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)) ref.durationMs = input.durationMs
  if (typeof input.codecs === 'string' && input.codecs.length > 0) ref.codecs = input.codecs
  return ref
}
