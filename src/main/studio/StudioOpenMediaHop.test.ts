import { describe, expect, it } from 'vitest'
import { createStudioOpenInStudioHandler } from './StudioOpenMediaHop'
import type { StudioOpenMediaAsset, StudioOpenMediaLifecycle } from './StudioOpenMediaHop'
import type {
  SpeechRecognitionResult,
  StudioTranscriptPublishOutcome
} from './StudioTranscriptAdapter'
import type { StudioTranscript } from './StudioProtocol'

function recognized(): SpeechRecognitionResult {
  return {
    text: 'hello world',
    localeIdentifier: 'en-GB',
    onDevice: true,
    segments: [
      { text: 'hello', startMs: 0, endMs: 1500, confidence: 0.9 },
      { text: 'world', startMs: 1500, endMs: 2500, confidence: 0.8 }
    ]
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function lifecycle(
  overrides: Partial<StudioOpenMediaLifecycle<StudioOpenMediaAsset>> & {
    published?: StudioTranscript[]
  } = {}
): StudioOpenMediaLifecycle<StudioOpenMediaAsset> {
  return {
    openMedia: overrides.openMedia ?? (async () => ({ ok: true })),
    setTranscript:
      overrides.setTranscript ??
      (async (transcript) => {
        overrides.published?.push(transcript)
        return { ok: true, currentRevision: 3 }
      })
  }
}

describe('Studio open-media hop', () => {
  it('publishes a real transcript for the exact opened asset', async () => {
    // LOAD-BEARING. This is the only control that fails if the production
    // transcript publication is removed from the open hop. Before this test the
    // entire non-test caller of setTranscript could be deleted with the suite
    // still green. It drives the REAL adapter, not a double.
    const published: StudioTranscript[] = []
    const sourcePaths: string[] = []
    const settled = deferred<StudioTranscriptPublishOutcome>()

    const openInStudio = createStudioOpenInStudioHandler({
      getLifecycle: () => lifecycle({ published }),
      transcribe: async (params) => {
        sourcePaths.push(params.sourcePath)
        return recognized()
      },
      onTranscriptOutcome: (event) => settled.resolve(event.outcome)
    })

    await expect(
      openInStudio({ assetId: 'assetA', path: '/isolated/transcript-media/aa/assetA.mov' })
    ).resolves.toEqual({ ok: true })

    await expect(settled.promise).resolves.toMatchObject({ ok: true, segmentCount: 2 })
    expect(sourcePaths).toEqual(['/isolated/transcript-media/aa/assetA.mov'])
    expect(published).toHaveLength(1)
    expect(published[0].assetId).toBe('assetA')
    // Exact rationals reached the host, not decimals or rounded ticks.
    expect(published[0].segments[0].sourceOut).toEqual({ n: 3, d: 2 })
    expect(published[0].segments[1].sourceOut).toEqual({ n: 5, d: 2 })
  })

  it('reports why a transcript never arrived instead of discarding the reason', async () => {
    const settled = deferred<StudioTranscriptPublishOutcome>()
    const openInStudio = createStudioOpenInStudioHandler({
      getLifecycle: () => lifecycle(),
      transcribe: async () => {
        throw new Error('enable Speech Recognition in System Settings')
      },
      onTranscriptOutcome: (event) => settled.resolve(event.outcome)
    })

    // The open still succeeds — recognition must never fail the operator.
    await expect(openInStudio({ assetId: 'assetA', path: '/a.mov' })).resolves.toEqual({ ok: true })

    const outcome = await settled.promise
    expect(outcome).toMatchObject({ ok: false, code: 'transcribe_failed' })
    expect((outcome as { message: string }).message).toContain('System Settings')
  })

  it('distinguishes a silent clip from a denied recognizer', async () => {
    const settled = deferred<StudioTranscriptPublishOutcome>()
    const openInStudio = createStudioOpenInStudioHandler({
      getLifecycle: () => lifecycle(),
      transcribe: async () => ({ ...recognized(), segments: [], text: '' }),
      onTranscriptOutcome: (event) => settled.resolve(event.outcome)
    })

    await openInStudio({ assetId: 'assetA', path: '/a.mov' })
    await expect(settled.promise).resolves.toMatchObject({ ok: false, code: 'no_usable_segments' })
  })

  it('does not transcribe media the companion refused to open', async () => {
    let transcribeCalls = 0
    const openInStudio = createStudioOpenInStudioHandler({
      getLifecycle: () =>
        lifecycle({ openMedia: async () => ({ ok: false, message: 'outside the allowed root' }) }),
      transcribe: async () => {
        transcribeCalls += 1
        return recognized()
      }
    })

    await expect(openInStudio({ assetId: 'assetA', path: '/a.mov' })).resolves.toEqual({
      ok: false,
      error: 'outside the allowed root'
    })
    expect(transcribeCalls).toBe(0)
  })

  it('fails cleanly and transcribes nothing while the companion is unavailable', async () => {
    let transcribeCalls = 0
    const openInStudio = createStudioOpenInStudioHandler({
      getLifecycle: () => null,
      transcribe: async () => {
        transcribeCalls += 1
        return recognized()
      }
    })

    await expect(openInStudio({ assetId: 'assetA', path: '/a.mov' })).resolves.toEqual({
      ok: false,
      error: 'Studio companion is unavailable.'
    })
    expect(transcribeCalls).toBe(0)
  })

  it('surfaces a throwing publication path rather than losing it', async () => {
    const settled = deferred<StudioTranscriptPublishOutcome>()
    const openInStudio = createStudioOpenInStudioHandler({
      getLifecycle: () => lifecycle(),
      transcribe: async () => recognized(),
      publishTranscript: async () => {
        throw new Error('publication path exploded')
      },
      onTranscriptOutcome: (event) => settled.resolve(event.outcome)
    })

    await expect(openInStudio({ assetId: 'assetA', path: '/a.mov' })).resolves.toEqual({ ok: true })
    await expect(settled.promise).resolves.toMatchObject({
      ok: false,
      code: 'transcribe_failed',
      message: 'publication path exploded'
    })
  })
})
