import { describe, expect, it } from 'vitest'
import { isCanvasDockPresentationEvent, selectUnownedDockPresentations } from './canvasPresentation'

describe('isCanvasDockPresentationEvent', () => {
  it('accepts only an opened dock presentation for the active chat', () => {
    expect(
      isCanvasDockPresentationEvent(
        {
          kind: 'session.opened',
          chatId: 'chat-a',
          detail: { presentation: 'dock', driver: 'web' }
        },
        'chat-a'
      )
    ).toBe(true)
    expect(
      isCanvasDockPresentationEvent(
        { kind: 'session.opened', chatId: 'chat-b', detail: { presentation: 'dock' } },
        'chat-a'
      )
    ).toBe(false)
    expect(
      isCanvasDockPresentationEvent(
        { kind: 'session.opened', chatId: 'chat-a', detail: { presentation: 'window' } },
        'chat-a'
      )
    ).toBe(false)
    expect(
      isCanvasDockPresentationEvent(
        { kind: 'navigation', chatId: 'chat-a', detail: { presentation: 'dock' } },
        'chat-a'
      )
    ).toBe(false)
  })

  it('rejects malformed events and missing chat authority', () => {
    expect(isCanvasDockPresentationEvent(null, 'chat-a')).toBe(false)
    expect(isCanvasDockPresentationEvent('session.opened', 'chat-a')).toBe(false)
    expect(isCanvasDockPresentationEvent({}, '')).toBe(false)
  })
})

describe('selectUnownedDockPresentations', () => {
  it('selects active web/sketch/chart/emulator dock surfaces that this renderer has not adopted', () => {
    const summaries = [
      { canvasId: 'owned', driver: 'web', status: 'active', presentation: 'dock' },
      { canvasId: 'web', driver: 'web', status: 'active', presentation: 'dock' },
      { canvasId: 'sketch', driver: 'sketch', status: 'active', presentation: 'dock' },
      { canvasId: 'chart', driver: 'chart', status: 'active', presentation: 'dock' },
      { canvasId: 'emulator', driver: 'emulator', status: 'active', presentation: 'dock' },
      { canvasId: 'window', driver: 'web', status: 'active' },
      { canvasId: 'render', driver: 'html', status: 'active', presentation: 'dock' },
      { canvasId: 'closed', driver: 'web', status: 'closed', presentation: 'dock' }
    ]

    expect(
      selectUnownedDockPresentations(summaries, new Set(['owned'])).map(
        (summary) => summary.canvasId
      )
    ).toEqual(['web', 'sketch', 'chart', 'emulator'])
  })
})
