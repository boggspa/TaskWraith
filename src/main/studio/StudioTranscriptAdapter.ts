/**
 * Publishes the host's real on-device speech transcript into the Studio document.
 *
 * The producer already exists: the TaskWraith bridge daemon's `audio.transcribe`
 * RPC runs SFSpeechRecognizer with `requiresOnDeviceRecognition = true` and
 * returns per-segment millisecond timings. This module is the narrow adapter
 * between that producer and `StudioProductionLifecycle.setTranscript` — it does
 * NOT recognize speech itself and must never grow a second recognizer.
 *
 * TIME MAPPING. The recognizer reports whole milliseconds; the Studio document
 * stores exact rationals. A millisecond boundary is therefore `{ n: ms, d: 1000 }`,
 * which is lossless — no rounding, no drift. It is deliberately NOT frame-aligned:
 * a StudioTranscriptSegment carries a *selection* range, not edit timing, and the
 * host validates rational shape, ordering and non-overlap rather than frame
 * boundaries (see StudioRevisionStore.applySetTranscript). Every boundary still
 * goes through studioTimeFromWire so a value outside the safe-integer range fails
 * loudly as `unrepresentable_time` instead of silently corrupting a selection.
 *
 * NAMING TRAP. `transcript-media` is the content-addressed store for media
 * ATTACHED TO A CHAT TRANSCRIPT. It holds no speech data and is not a source of
 * segments. The only segment producer in this repository is AudioTranscriber.swift.
 */
import { STUDIO_TRANSCRIPT_SCHEMA_VERSION } from './StudioProtocol'
import type { StudioTranscript, StudioTranscriptSegment } from './StudioProtocol'
import { StudioTimeError, studioTimeFromWire } from './StudioRationalTime'

/** Exactly the daemon `audio.transcribe` reply shape. */
export interface SpeechRecognitionSegment {
  text: string
  startMs: number
  endMs: number
  confidence: number
}

export interface SpeechRecognitionResult {
  text: string
  segments: SpeechRecognitionSegment[]
  localeIdentifier: string
  onDevice: boolean
}

export type StudioTranscriptAdapterErrorCode =
  | 'not_on_device'
  | 'no_usable_segments'
  | 'invalid_segment'
  | 'unrepresentable_time'
  | 'transcribe_failed'
  | 'publish_rejected'
  | 'studio_unavailable'

export interface StudioTranscriptMapping {
  transcript: StudioTranscript
  /** Segments whose start was moved forward to remove a recognizer overlap. */
  adjustedCount: number
  /** Segments dropped because an overlap fully swallowed them. */
  droppedCount: number
}

export type StudioTranscriptPublishOutcome =
  | { ok: true; segmentCount: number; adjustedCount: number; droppedCount: number }
  | { ok: false; code: StudioTranscriptAdapterErrorCode; message: string }

/** Stable per-asset id so reopening an asset REPLACES its transcript revision. */
export function studioTranscriptIdForAsset(assetId: string): string {
  return `transcript:${assetId}`
}

function millisecondsToStudioTime(ms: number, context: string) {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new StudioTimeError('invalid_rational', `${context}: expected a non-negative integer ms`)
  }
  return studioTimeFromWire({ n: ms, d: 1000 }, context)
}

/**
 * Map a real recognizer result onto the Studio transcript contract.
 *
 * Overlap policy: consecutive recognizer segments can touch or overlap by a
 * millisecond once float timestamps are rounded, and the host rejects overlapping
 * selections outright. Rather than lose the whole transcript, a segment whose
 * start falls before the previous end is started at that previous end — its
 * authoritative END is untouched and time is never invented. A segment an overlap
 * swallows entirely is dropped. Both are counted and reported, never hidden.
 */
export function mapSpeechResultToStudioTranscript(
  assetId: string,
  result: SpeechRecognitionResult
): StudioTranscriptMapping {
  if (!assetId) throw new Error('assetId is required to map a Studio transcript')
  if (result.onDevice !== true) {
    // The privacy invariant is load-bearing: never persist a transcript that a
    // network recognizer may have produced.
    throw new StudioTimeError('invalid_rational', 'refusing a transcript not recognized on-device')
  }

  const segments: StudioTranscriptSegment[] = []
  let adjustedCount = 0
  let droppedCount = 0
  let previousEndMs = 0

  const incoming = [...(result.segments ?? [])].sort((a, b) => a.startMs - b.startMs)
  for (const [index, candidate] of incoming.entries()) {
    const context = `transcript segment ${index}`
    const text = typeof candidate.text === 'string' ? candidate.text.trim() : ''
    if (!text) {
      droppedCount += 1
      continue
    }
    if (!Number.isSafeInteger(candidate.startMs) || !Number.isSafeInteger(candidate.endMs)) {
      throw new StudioTimeError('invalid_rational', `${context}: timings must be integer ms`)
    }
    if (candidate.endMs <= candidate.startMs) {
      throw new StudioTimeError('invalid_rational', `${context}: endMs must exceed startMs`)
    }

    const startMs = Math.max(candidate.startMs, previousEndMs)
    if (startMs !== candidate.startMs) adjustedCount += 1
    if (candidate.endMs <= startMs) {
      droppedCount += 1
      continue
    }

    segments.push({
      segmentId: `${studioTranscriptIdForAsset(assetId)}#${String(index).padStart(6, '0')}`,
      text,
      sourceIn: millisecondsToStudioTime(startMs, `${context} sourceIn`),
      sourceOut: millisecondsToStudioTime(candidate.endMs, `${context} sourceOut`),
      ...(Number.isFinite(candidate.confidence) &&
      candidate.confidence >= 0 &&
      candidate.confidence <= 1
        ? { confidence: candidate.confidence }
        : {})
    })
    previousEndMs = candidate.endMs
  }

  const localeIdentifier =
    typeof result.localeIdentifier === 'string' && result.localeIdentifier.trim()
      ? result.localeIdentifier.trim()
      : undefined

  return {
    transcript: {
      schemaVersion: STUDIO_TRANSCRIPT_SCHEMA_VERSION,
      transcriptId: studioTranscriptIdForAsset(assetId),
      assetId,
      ...(localeIdentifier ? { localeIdentifier } : {}),
      segments
    },
    adjustedCount,
    droppedCount
  }
}

export interface StudioTranscriptPublishDeps {
  transcribe: (params: {
    sourcePath: string
    localeIdentifier?: string
  }) => Promise<SpeechRecognitionResult>
  setTranscript: (
    transcript: StudioTranscript
  ) => Promise<{ ok: boolean; code?: string; currentRevision?: number }>
  onEvent?: (event: { kind: string; detail: string }) => void
}

/**
 * Recognize the just-opened asset and publish its timed segments to the Studio
 * document. This is the production (non-test) caller of setTranscript.
 *
 * It resolves an outcome instead of throwing: the caller opens media for the
 * operator, and a recognizer that is unavailable, denied by TCC, or given a
 * silent clip must never fail that open.
 */
export async function publishStudioTranscriptForAsset(
  deps: StudioTranscriptPublishDeps,
  asset: { assetId: string; path: string; localeIdentifier?: string }
): Promise<StudioTranscriptPublishOutcome> {
  let recognized: SpeechRecognitionResult
  try {
    recognized = await deps.transcribe({
      sourcePath: asset.path,
      ...(asset.localeIdentifier ? { localeIdentifier: asset.localeIdentifier } : {})
    })
  } catch (error) {
    return {
      ok: false,
      code: 'transcribe_failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }

  let mapped: StudioTranscriptMapping
  try {
    mapped = mapSpeechResultToStudioTranscript(asset.assetId, recognized)
  } catch (error) {
    const code: StudioTranscriptAdapterErrorCode =
      error instanceof StudioTimeError && error.code === 'unrepresentable_time'
        ? 'unrepresentable_time'
        : recognized.onDevice !== true
          ? 'not_on_device'
          : 'invalid_segment'
    return { ok: false, code, message: error instanceof Error ? error.message : String(error) }
  }

  if (mapped.transcript.segments.length === 0) {
    return { ok: false, code: 'no_usable_segments', message: 'recognizer returned no speech' }
  }

  const published = await deps.setTranscript(mapped.transcript)
  if (!published.ok) {
    return {
      ok: false,
      code: 'publish_rejected',
      message: `host rejected the transcript: ${published.code || 'unknown'}`
    }
  }

  deps.onEvent?.({
    kind: 'studio_transcript_published',
    detail: `${mapped.transcript.segments.length} segments for ${asset.assetId}`
  })
  return {
    ok: true,
    segmentCount: mapped.transcript.segments.length,
    adjustedCount: mapped.adjustedCount,
    droppedCount: mapped.droppedCount
  }
}
