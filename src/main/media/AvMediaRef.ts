import type { TranscriptMediaRef, TranscriptMediaThumbnail } from '../store/types'

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

/**
 * Best-effort poster/waveform generator for an already-written AV staging file.
 * INJECTED into the producers (the real impl lives in index.ts: VideoToolbox frame
 * decode for video, the offscreen audio engine's waveform for audio, both downscaled
 * to a small size-capped JPEG). MUST be fail-tolerant — it never throws and resolves
 * to `undefined` on any error/timeout/empty result, so a producer always returns its
 * ref (just with no poster). Called BEFORE the staging file is removed.
 */
export type GeneratePoster = (
  outputPath: string,
  kind: 'audio' | 'video',
  mimeType: string,
  byteLength: number
) => Promise<TranscriptMediaThumbnail | undefined>

export interface BuildAvMediaRefInput {
  sha256: string
  mimeType: string
  name: string
  runId?: string
  byteLength?: number
  durationMs?: number
  codecs?: string
  /**
   * Optional small poster/waveform preview (JPEG, ~320px, size-capped) so the
   * card isn't blank before playback. PURE passthrough — this builder does zero
   * IO; the caller (the producer) generates it via the injected `generatePoster`
   * dep and hands it in, or omits it on any failure (fail-tolerant).
   */
  thumbnail?: TranscriptMediaThumbnail
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
  if (input.thumbnail && typeof input.thumbnail.dataBase64 === 'string' && input.thumbnail.dataBase64.length > 0) {
    ref.thumbnail = input.thumbnail
  }
  return ref
}
