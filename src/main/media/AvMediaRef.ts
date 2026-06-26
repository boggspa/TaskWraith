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
 * The result of the best-effort poster/waveform pass: a small JPEG `thumbnail`
 * (the graceful fallback) AND, for AUDIO, a compact `peaks` envelope harvested from
 * the SAME offscreen analysis decode (no second decode). Both fields are optional and
 * independent — a video gives a thumbnail and no peaks; a big audio file skipped for
 * heap may give neither.
 */
export interface AvPosterResult {
  thumbnail?: TranscriptMediaThumbnail
  /** Compact waveform envelope (N≤512 ints 0–255) for audio refs; absent otherwise. */
  peaks?: number[]
}

/**
 * Best-effort poster/waveform generator for an already-written AV staging file.
 * INJECTED into the producers (the real impl lives in index.ts: VideoToolbox frame
 * decode for video, the offscreen audio engine's waveform + harvested peaks for audio,
 * the JPEG downscaled to a small size-capped poster). MUST be fail-tolerant — it never
 * throws and resolves to `undefined` (or an empty `{}`) on any error/timeout/empty
 * result, so a producer always returns its ref (just with no poster/peaks). Called
 * BEFORE the staging file is removed.
 */
export type GeneratePoster = (
  outputPath: string,
  kind: 'audio' | 'video',
  mimeType: string,
  byteLength: number
) => Promise<AvPosterResult | undefined>

export interface BuildAvMediaRefInput {
  sha256: string
  mimeType: string
  name: string
  runId?: string
  byteLength?: number
  durationMs?: number
  codecs?: string
  /**
   * Optional human caption (e.g. inspect_audio_segment's `<m:ss>–<m:ss>` window range)
   * surfaced under the card. PURE passthrough — only set when a non-empty string.
   */
  caption?: string
  /**
   * Optional small poster/waveform preview (JPEG, ~320px, size-capped) so the
   * card isn't blank before playback. PURE passthrough — this builder does zero
   * IO; the caller (the producer) generates it via the injected `generatePoster`
   * dep and hands it in, or omits it on any failure (fail-tolerant).
   */
  thumbnail?: TranscriptMediaThumbnail
  /**
   * Optional compact waveform envelope for AUDIO refs — N integer buckets (≤512,
   * each 0–255). Harvested by the producer from the same analysis pass as the
   * poster. PURE, fail-tolerant passthrough (mirrors `thumbnail`): only put on the
   * ref when it is a non-empty array of finite numbers; never throws on malformed
   * input. The renderer draws a DAW waveform from it (normalize /255).
   */
  peaks?: number[]
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
  if (typeof input.caption === 'string' && input.caption.trim().length > 0) ref.caption = input.caption
  if (input.thumbnail && typeof input.thumbnail.dataBase64 === 'string' && input.thumbnail.dataBase64.length > 0) {
    ref.thumbnail = input.thumbnail
  }
  // Fail-tolerant peaks passthrough (mirrors thumbnail): only attach a non-empty
  // array of finite numbers, hard-capped at 512 buckets, each coerced to an int
  // 0..255. A malformed/oversized value is silently dropped (poster fallback) —
  // never thrown. This is the last main-side guard before the field hits a ref.
  if (Array.isArray(input.peaks) && input.peaks.length > 0) {
    const capped = input.peaks.length > 512 ? input.peaks.slice(0, 512) : input.peaks
    const cleaned: number[] = []
    for (const value of capped) {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) continue
      const q = Math.round(n)
      cleaned.push(q < 0 ? 0 : q > 255 ? 255 : q)
    }
    if (cleaned.length > 0) ref.peaks = cleaned
  }
  return ref
}
