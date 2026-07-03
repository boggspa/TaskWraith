import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { projectRows } from './TranscriptVirtualWindow'
import {
  buildTranscriptUserGutterMarkers,
  findActiveGutterMarkerKey,
  gutterBulgeRadiusPx,
  layoutTranscriptUserGutterMarkers,
  userGutterPreview,
  userGutterTitle
} from './TranscriptUserMessageGutter'

function message(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: '2026-01-01T00:00:00.000Z'
  }
}

describe('TranscriptUserMessageGutter model', () => {
  it('builds markers only for user rows and keeps duplicate ids row-key addressable', () => {
    const messages = [
      message('same', 'user', 'First prompt'),
      message('assistant-1', 'assistant', 'Assistant answer'),
      message('same', 'user', 'Second prompt')
    ]
    const rows = projectRows(messages)

    const markers = buildTranscriptUserGutterMarkers(messages, rows)

    expect(markers).toHaveLength(2)
    expect(markers[0]).toMatchObject({
      messageId: 'same',
      rowKey: 'same#0',
      ordinal: 1,
      title: 'First prompt'
    })
    expect(markers[1]).toMatchObject({
      messageId: 'same',
      rowKey: 'same#2',
      ordinal: 2,
      title: 'Second prompt'
    })
    expect(markers[1].topPercent).toBeGreaterThan(markers[0].topPercent)
  })

  it('uses measured row heights when supplied', () => {
    const messages = [
      message('first', 'user', 'First prompt'),
      message('long-assistant', 'assistant', 'Assistant answer'),
      message('second', 'user', 'Second prompt')
    ]
    const rows = projectRows(messages)

    const estimatedMarkers = buildTranscriptUserGutterMarkers(messages, rows)
    const measuredMarkers = buildTranscriptUserGutterMarkers(messages, rows, [40, 800, 40])

    expect(measuredMarkers[0].topPercent).toBeLessThan(estimatedMarkers[0].topPercent)
    expect(measuredMarkers[0].topPercent).toBeCloseTo((20 / 880) * 100, 5)
    expect(measuredMarkers[1].topPercent).toBeGreaterThan(estimatedMarkers[1].topPercent)
    expect(measuredMarkers[1].topPercent).toBeCloseTo((860 / 880) * 100, 5)
  })

  it('creates compact titles and previews for blank and long prompts', () => {
    expect(userGutterTitle('')).toBe('User message')
    expect(userGutterPreview('')).toBe('')

    const longPrompt = [
      'Please review the release checklist and focus on the risky edge cases.',
      'One',
      'Two',
      'Three',
      'Four',
      'Five'
    ].join('\n')

    expect(userGutterTitle(longPrompt)).toBe(
      'Please review the release checklist and focus on the risky edge cases.'
    )
    expect(userGutterPreview(longPrompt).split('\n')).toHaveLength(4)
  })

  it('compacts dense marker stacks without changing their order', () => {
    const messages = Array.from({ length: 24 }, (_, index) =>
      message(`user-${index}`, 'user', `Prompt ${index}`)
    )
    const markers = buildTranscriptUserGutterMarkers(messages, projectRows(messages))

    const layout = layoutTranscriptUserGutterMarkers(markers, 900)
    const tops = layout.map((marker) => marker.topPx)
    const span = Math.max(...tops) - Math.min(...tops)

    expect(layout.map((marker) => marker.key)).toEqual(markers.map((marker) => marker.key))
    expect(span).toBeLessThanOrEqual(23 * 8)
    expect(Math.max(...tops)).toBeCloseTo(892, 1)
    for (let index = 1; index < tops.length; index += 1) {
      expect(tops[index]).toBeGreaterThan(tops[index - 1])
    }
  })

  it('bottom-aligns sparse marker stacks beside the composer gutter', () => {
    const messages = [
      message('first', 'user', 'First prompt'),
      message('assistant-1', 'assistant', 'Assistant answer'),
      message('second', 'user', 'Second prompt')
    ]
    const markers = buildTranscriptUserGutterMarkers(messages, projectRows(messages))

    const layout = layoutTranscriptUserGutterMarkers(markers, 900)

    expect(layout[1].topPx).toBeCloseTo(892, 1)
    expect(layout[1].topPx - layout[0].topPx).toBeCloseTo(10, 1)
  })

  it('carries each marker rowIndex in the virtual-row index space', () => {
    const messages = [
      message('u0', 'user', 'First prompt'),
      message('a1', 'assistant', 'Answer'),
      message('u2', 'user', 'Second prompt')
    ]
    const markers = buildTranscriptUserGutterMarkers(messages, projectRows(messages))

    expect(markers.map((marker) => marker.rowIndex)).toEqual([0, 2])
  })

  it('keeps rowIndex POSITIONAL (findScrollAnchor space) when projectRows skips a malformed row', () => {
    // A message with a non-string id is dropped by projectRows, so the emitted
    // rows array is shorter than `messages` and row.index (source position) no
    // longer equals the row's array position. marker.rowIndex must track the
    // ARRAY position (what findScrollAnchor returns), not row.index.
    const messages = [
      message('u0', 'user', 'Turn zero'),
      { ...message('bad', 'assistant', 'malformed'), id: undefined as unknown as string },
      message('u1', 'user', 'Turn one')
    ]
    const rows = projectRows(messages)
    expect(rows).toHaveLength(2)

    const markers = buildTranscriptUserGutterMarkers(messages, rows)
    // Positional: 0 and 1 — NOT 0 and 2 (the source-message positions).
    expect(markers.map((marker) => marker.rowIndex)).toEqual([0, 1])
    expect(markers[1].messageId).toBe('u1')
    // The scroll-spy join resolves the 2nd marker at positional anchor 1.
    expect(findActiveGutterMarkerKey(markers, 1)).toBe(markers[1].key)
  })
})

describe('findActiveGutterMarkerKey (scroll-spy join)', () => {
  const messages = [
    message('u0', 'user', 'Turn zero'),
    message('a1', 'assistant', 'Answer one'),
    message('u2', 'user', 'Turn two'),
    message('a3', 'assistant', 'Answer three'),
    message('u4', 'user', 'Turn four')
  ]
  const markers = buildTranscriptUserGutterMarkers(messages, projectRows(messages))

  it('maps an anchor row to the nearest user marker at or above it', () => {
    expect(findActiveGutterMarkerKey(markers, 0)).toBe('u0#0')
    // Anchored on the assistant row between turns 0 and 2 → still inside turn 0.
    expect(findActiveGutterMarkerKey(markers, 1)).toBe('u0#0')
    expect(findActiveGutterMarkerKey(markers, 2)).toBe('u2#2')
    expect(findActiveGutterMarkerKey(markers, 3)).toBe('u2#2')
    expect(findActiveGutterMarkerKey(markers, 4)).toBe('u4#4')
  })

  it('clamps below the first and beyond the last marker', () => {
    expect(findActiveGutterMarkerKey(markers, -1)).toBeNull()
    expect(findActiveGutterMarkerKey(markers, 999)).toBe('u4#4')
  })

  it('is defensive against empty markers and non-finite anchors', () => {
    expect(findActiveGutterMarkerKey([], 3)).toBeNull()
    expect(findActiveGutterMarkerKey(markers, Number.NaN)).toBeNull()
  })
})

describe('gutterBulgeRadiusPx (dock influence radius)', () => {
  it('shrinks the influence radius as markers compact, clamped legible', () => {
    // Sparse rails reach further; dense rails (5px steps at 36+) tighten so the
    // whole cluster doesn't bulge as one blob. Monotonic non-increasing in count.
    expect(gutterBulgeRadiusPx(3)).toBe(40)
    expect(gutterBulgeRadiusPx(18)).toBe(32)
    expect(gutterBulgeRadiusPx(28)).toBe(24)
    expect(gutterBulgeRadiusPx(48)).toBe(20)
    for (const n of [1, 5, 12, 20, 40, 200]) {
      const r = gutterBulgeRadiusPx(n)
      expect(r).toBeGreaterThanOrEqual(20)
      expect(r).toBeLessThanOrEqual(44)
    }
  })
})
