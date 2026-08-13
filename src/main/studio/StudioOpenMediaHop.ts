/**
 * The production "open owned media in Studio" hop.
 *
 * This exists as its own module for one reason: while it lived inline inside
 * the main-process bootstrap it could not be tested, so deleting the transcript
 * publication — the entire non-test caller of setTranscript — left the suite
 * green. A reachability claim nothing can falsify is not evidence.
 *
 * It also stops discarding the publication result. Recognition legitimately
 * fails in several distinguishable ways (daemon down, Speech permission denied,
 * recognizer not on-device, silent clip, host rejection), and previously every
 * one of them was indistinguishable to the operator: the media opened and the
 * band stayed empty with nothing said. The typed outcome is now handed to the
 * host instead of being dropped.
 */
import {
  publishStudioTranscriptForAsset,
  type SpeechRecognitionResult,
  type StudioTranscriptPublishOutcome
} from './StudioTranscriptAdapter'
import type { StudioTranscript } from './StudioProtocol'

/** The exact asset identity the revisioned store already owns. */
export interface StudioOpenMediaAsset {
  assetId: string
  path: string
}

/**
 * Structural view of StudioProductionLifecycle; keeps this module Electron-free.
 * Generic in the asset so the host's exact type — which pins mediaKind to the
 * literal 'video' — flows through instead of being widened here.
 */
export interface StudioOpenMediaLifecycle<TAsset extends StudioOpenMediaAsset> {
  openMedia: (asset: TAsset) => Promise<{ ok: boolean; message?: string }>
  setTranscript: (
    transcript: StudioTranscript
  ) => Promise<{ ok: boolean; code?: string; currentRevision?: number }>
}

export interface StudioOpenMediaHopDeps<TAsset extends StudioOpenMediaAsset> {
  /** Null while the companion is not running; the open then fails cleanly. */
  getLifecycle: () => StudioOpenMediaLifecycle<TAsset> | null
  transcribe: (params: {
    sourcePath: string
    localeIdentifier?: string
  }) => Promise<SpeechRecognitionResult>
  /**
   * Receives every publication result, success or failure. This is the seam an
   * operator-visible surface hangs off; without it a denied Speech permission
   * looks exactly like a clip with no speech in it.
   */
  onTranscriptOutcome?: (event: {
    assetId: string
    outcome: StudioTranscriptPublishOutcome
  }) => void
  /** Test seam only; production uses the real adapter. */
  publishTranscript?: typeof publishStudioTranscriptForAsset
}

export type StudioOpenMediaResult = { ok: true } | { ok: false; error: string }

export function createStudioOpenInStudioHandler<TAsset extends StudioOpenMediaAsset>(
  deps: StudioOpenMediaHopDeps<TAsset>
): (asset: TAsset) => Promise<StudioOpenMediaResult> {
  return async (asset) => {
    const lifecycle = deps.getLifecycle()
    if (!lifecycle) return { ok: false, error: 'Studio companion is unavailable.' }

    const opened = await lifecycle.openMedia(asset)
    if (!opened.ok)
      return { ok: false, error: opened.message ?? 'Studio could not open the media.' }

    // Deliberately not awaited: recognition is slow, and a denied permission or
    // a silent clip must never fail the operator's media open. The result is
    // reported rather than swallowed.
    const publish = deps.publishTranscript ?? publishStudioTranscriptForAsset
    void publish(
      {
        transcribe: deps.transcribe,
        setTranscript: (transcript) => lifecycle.setTranscript(transcript)
      },
      { assetId: asset.assetId, path: asset.path }
    )
      .then((outcome) => {
        deps.onTranscriptOutcome?.({ assetId: asset.assetId, outcome })
      })
      .catch((error: unknown) => {
        // The adapter resolves its own failures, so reaching here means the
        // publication path itself threw. Report it rather than losing it.
        deps.onTranscriptOutcome?.({
          assetId: asset.assetId,
          outcome: {
            ok: false,
            code: 'transcribe_failed',
            message: error instanceof Error ? error.message : String(error)
          }
        })
      })

    return { ok: true }
  }
}
