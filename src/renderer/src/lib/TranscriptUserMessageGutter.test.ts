import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { projectRows } from './TranscriptVirtualWindow'
import {
  buildTranscriptUserGutterMarkers,
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
})
