import { describe, expect, it } from 'vitest'
import type { TranscriptMediaRef } from '../../../main/store/types'
import { mergeTranscriptMediaRefs } from './transcriptMediaRefs'

function mediaRef(
  id: string,
  overrides: Partial<TranscriptMediaRef> = {}
): TranscriptMediaRef {
  return {
    id,
    kind: 'image',
    format: 'raster',
    source: 'generated',
    name: `${id}.png`,
    mimeType: 'image/png',
    ...overrides
  }
}

describe('mergeTranscriptMediaRefs', () => {
  it('preserves existing refs before incoming refs', () => {
    expect(
      mergeTranscriptMediaRefs([mediaRef('existing')], [mediaRef('incoming')]).map((ref) => ref.id)
    ).toEqual(['existing', 'incoming'])
  })

  it('deduplicates by sha256 before assetId or id', () => {
    const merged = mergeTranscriptMediaRefs(
      [
        mediaRef('first', { sha256: 'same-content', assetId: 'asset-a' }),
        mediaRef('asset-original', { assetId: 'same-asset' })
      ],
      [
        mediaRef('second', { sha256: 'same-content', assetId: 'asset-b' }),
        mediaRef('asset-duplicate', { assetId: 'same-asset' })
      ]
    )

    expect(merged.map((ref) => ref.id)).toEqual(['first', 'asset-original'])
  })

  it('deduplicates by id when no stronger key is present', () => {
    expect(
      mergeTranscriptMediaRefs([mediaRef('image-1')], [mediaRef('image-1'), mediaRef('image-2')]).map(
        (ref) => ref.id
      )
    ).toEqual(['image-1', 'image-2'])
  })

  it('drops refs without an identity key', () => {
    const anonymousRef = mediaRef('', { sha256: undefined, assetId: undefined })

    expect(mergeTranscriptMediaRefs(undefined, [anonymousRef, mediaRef('identified')])).toEqual([
      mediaRef('identified')
    ])
  })
})
