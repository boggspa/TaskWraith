import { describe, expect, it } from 'vitest'
import {
  mapSpeechResultToStudioTranscript,
  publishStudioTranscriptForAsset,
  studioTranscriptIdForAsset
} from './StudioTranscriptAdapter'
import type { SpeechRecognitionResult, SpeechRecognitionSegment } from './StudioTranscriptAdapter'
import type { StudioTranscript } from './StudioProtocol'

function recognized(
  segments: Array<Partial<SpeechRecognitionSegment>>,
  overrides: Partial<SpeechRecognitionResult> = {}
): SpeechRecognitionResult {
  return {
    text: segments.map((segment) => segment.text ?? '').join(' '),
    localeIdentifier: 'en-GB',
    onDevice: true,
    segments: segments.map((segment, index) => ({
      text: segment.text ?? `word${index}`,
      startMs: segment.startMs ?? index * 1000,
      endMs: segment.endMs ?? index * 1000 + 500,
      confidence: segment.confidence ?? 0.9
    })),
    ...overrides
  }
}

describe('Studio transcript adapter', () => {
  it('maps whole milliseconds onto exact rationals with no rounding', () => {
    const { transcript } = mapSpeechResultToStudioTranscript(
      'assetA',
      recognized([
        { text: 'hello', startMs: 0, endMs: 1500 },
        { text: 'world', startMs: 1500, endMs: 2000 }
      ])
    )

    // 1500ms is exactly 3/2s and 2000ms exactly 2/1s once normalised. If this
    // ever reads as a decimal or a rounded tick, the mapping has started lying.
    expect(transcript.segments.map((segment) => [segment.sourceIn, segment.sourceOut])).toEqual([
      [
        { n: 0, d: 1 },
        { n: 3, d: 2 }
      ],
      [
        { n: 3, d: 2 },
        { n: 2, d: 1 }
      ]
    ])
    expect(transcript.assetId).toBe('assetA')
    expect(transcript.transcriptId).toBe(studioTranscriptIdForAsset('assetA'))
    expect(transcript.localeIdentifier).toBe('en-GB')
    expect(transcript.segments[0].confidence).toBe(0.9)
  })

  it('starts an overlapping segment at the previous end instead of losing the transcript', () => {
    const { transcript, adjustedCount, droppedCount } = mapSpeechResultToStudioTranscript(
      'assetA',
      recognized([
        { text: 'one', startMs: 0, endMs: 1000 },
        { text: 'two', startMs: 900, endMs: 1500 }
      ])
    )

    expect(adjustedCount).toBe(1)
    expect(droppedCount).toBe(0)
    // The authoritative END is untouched; only the overlapping start moves.
    expect(transcript.segments[1].sourceIn).toEqual({ n: 1, d: 1 })
    expect(transcript.segments[1].sourceOut).toEqual({ n: 3, d: 2 })
  })

  it('drops a segment an overlap swallows entirely rather than emitting an inverted range', () => {
    const { transcript, droppedCount } = mapSpeechResultToStudioTranscript(
      'assetA',
      recognized([
        { text: 'long', startMs: 0, endMs: 2000 },
        { text: 'swallowed', startMs: 500, endMs: 1500 }
      ])
    )

    expect(droppedCount).toBe(1)
    expect(transcript.segments).toHaveLength(1)
    expect(transcript.segments[0].text).toBe('long')
  })

  it('refuses a transcript that was not recognized on-device', () => {
    expect(() =>
      mapSpeechResultToStudioTranscript(
        'assetA',
        recognized([{ text: 'hello', startMs: 0, endMs: 500 }], { onDevice: false })
      )
    ).toThrow(/on-device/)
  })

  it('refuses non-integer and inverted recognizer timings instead of rounding them', () => {
    expect(() =>
      mapSpeechResultToStudioTranscript(
        'assetA',
        recognized([{ text: 'hello', startMs: 12.5, endMs: 500 }])
      )
    ).toThrow(/integer ms/)
    expect(() =>
      mapSpeechResultToStudioTranscript(
        'assetA',
        recognized([{ text: 'hello', startMs: 500, endMs: 500 }])
      )
    ).toThrow(/endMs must exceed startMs/)
  })

  it('publishes real timed segments through setTranscript', async () => {
    const published: StudioTranscript[] = []
    const sourcePaths: string[] = []

    const outcome = await publishStudioTranscriptForAsset(
      {
        transcribe: async (params) => {
          sourcePaths.push(params.sourcePath)
          return recognized([
            { text: 'hello', startMs: 0, endMs: 1500 },
            { text: 'world', startMs: 1500, endMs: 2500 }
          ])
        },
        setTranscript: async (transcript) => {
          published.push(transcript)
          return { ok: true, currentRevision: 4 }
        }
      },
      { assetId: 'assetA', path: '/isolated/transcript-media/aa/assetA.mov' }
    )

    expect(outcome).toEqual({ ok: true, segmentCount: 2, adjustedCount: 0, droppedCount: 0 })
    expect(sourcePaths).toEqual(['/isolated/transcript-media/aa/assetA.mov'])
    expect(published).toHaveLength(1)
    expect(published[0].segments.map((segment) => segment.text)).toEqual(['hello', 'world'])
    expect(published[0].segments[1].sourceOut).toEqual({ n: 5, d: 2 })
  })

  it('never fails the media open when the recognizer is unavailable or denied', async () => {
    let publishCalls = 0
    const outcome = await publishStudioTranscriptForAsset(
      {
        transcribe: async () => {
          throw new Error('enable Speech Recognition in System Settings')
        },
        setTranscript: async () => {
          publishCalls += 1
          return { ok: true }
        }
      },
      { assetId: 'assetA', path: '/isolated/assetA.mov' }
    )

    expect(outcome).toMatchObject({ ok: false, code: 'transcribe_failed' })
    expect(publishCalls).toBe(0)
  })

  it('does not publish an empty transcript for a silent clip', async () => {
    let publishCalls = 0
    const outcome = await publishStudioTranscriptForAsset(
      {
        transcribe: async () => recognized([{ text: '   ', startMs: 0, endMs: 500 }]),
        setTranscript: async () => {
          publishCalls += 1
          return { ok: true }
        }
      },
      { assetId: 'assetA', path: '/isolated/assetA.mov' }
    )

    expect(outcome).toMatchObject({ ok: false, code: 'no_usable_segments' })
    expect(publishCalls).toBe(0)
  })

  it('reports a host rejection instead of claiming the band was fed', async () => {
    const outcome = await publishStudioTranscriptForAsset(
      {
        transcribe: async () => recognized([{ text: 'hello', startMs: 0, endMs: 500 }]),
        setTranscript: async () => ({ ok: false, code: 'stale_base', currentRevision: 9 })
      },
      { assetId: 'assetA', path: '/isolated/assetA.mov' }
    )

    expect(outcome).toMatchObject({ ok: false, code: 'publish_rejected' })
    expect((outcome as { message: string }).message).toContain('stale_base')
  })
})
