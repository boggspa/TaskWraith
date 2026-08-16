import { describe, expect, it } from 'vitest'
import {
  isTemporalFrameGroupKind,
  isTranscriptFrameSetGroupKind,
  isTranscriptMediaGroupKind,
  transcriptMediaRefDedupKey
} from './transcriptMediaGrouping'

describe('transcript media grouping', () => {
  it.each(['video_frames', 'audio_segment', 'appshots', 'appwatch_frames'])(
    'allows the known %s group kind',
    (groupKind) => {
      expect(isTranscriptMediaGroupKind(groupKind)).toBe(true)
    }
  )

  it('keeps Frame Set presentation narrower than all temporal media', () => {
    expect(isTemporalFrameGroupKind('video_frames')).toBe(true)
    expect(isTranscriptFrameSetGroupKind('video_frames')).toBe(false)
    expect(isTranscriptFrameSetGroupKind('appshots')).toBe(true)
    expect(isTranscriptFrameSetGroupKind('appwatch_frames')).toBe(true)
    expect(isTranscriptMediaGroupKind('arbitrary-provider-layout')).toBe(false)
  })

  it('deduplicates ordinary media by content but temporal frames by occurrence', () => {
    expect(transcriptMediaRefDedupKey({ id: 'one', sha256: 'same-content' })).toBe('same-content')
    expect(
      transcriptMediaRefDedupKey({
        id: 'frame-one',
        sha256: 'same-content',
        groupKind: 'appshots'
      })
    ).toBe('frame-one')
    expect(
      transcriptMediaRefDedupKey({
        id: 'frame-two',
        sha256: 'same-content',
        groupKind: 'appshots'
      })
    ).toBe('frame-two')
  })
})
