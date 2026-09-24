import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  ComposerTimecode,
  ComposerThreadTimecodeBar,
  computeComposerTimecodePopoverPosition,
  getComposerTimecodePresentation
} from './ComposerTimecodes'

describe('ComposerTimecode presentation', () => {
  it('shows the turn / round time while a turn is active', () => {
    const nowMs = Date.parse('2026-07-05T12:00:05.000Z')
    const presentation = getComposerTimecodePresentation({
      running: true,
      startedAt: '2026-07-05T12:00:00.000Z',
      cumulativeBaseMs: 120_000,
      nowMs
    })

    expect(presentation.turnLabel).toBe('00:00:00:05')
    expect(presentation.totalLabel).toBe('00:00:02:05')
    expect(presentation.visibleMode).toBe('turn')
    expect(presentation.visibleLabel).toBe('00:00:00:05')
  })

  it('shows total thread wall time when no turn is active', () => {
    const presentation = getComposerTimecodePresentation({
      running: false,
      startedAt: null,
      cumulativeBaseMs: 125_000,
      nowMs: Date.parse('2026-07-05T12:00:05.000Z')
    })

    expect(presentation.turnLabel).toBe('00:00:00:00')
    expect(presentation.totalLabel).toBe('00:00:02:05')
    expect(presentation.visibleMode).toBe('total')
    expect(presentation.visibleLabel).toBe('00:00:02:05')
  })

  it('adds live whole-round progress to completed-round thread time', () => {
    const presentation = getComposerTimecodePresentation({
      running: true,
      startedAt: '2026-09-12T10:02:00.000Z',
      cumulativeBaseMs: 30_000,
      nowMs: Date.parse('2026-09-12T10:02:12.000Z')
    })

    expect(presentation.turnLabel).toBe('00:00:00:12')
    expect(presentation.totalLabel).toBe('00:00:00:42')
  })

  it('keeps a round clock live across a between-seat running-flag gap', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-12T10:02:12.000Z'))
    try {
      const html = renderToStaticMarkup(
        <ComposerThreadTimecodeBar
          running={false}
          startedAt="2026-09-12T10:02:00.000Z"
          cumulativeBaseMs={30_000}
        />
      )

      expect(html).toContain('data-running="true"')
      expect(html).toContain('Current turn elapsed time 00:00:00:12')
      expect(html).toContain('Total thread wall time 00:00:00:42')
    } finally {
      now.mockRestore()
    }
  })

  it('renders only the visible idle readout when the popover is closed', () => {
    const html = renderToStaticMarkup(
      <ComposerTimecode running={false} startedAt={null} cumulativeBaseMs={125_000} />
    )

    expect(html).toContain('data-mode="total"')
    expect(html).toContain('composer-timecode-value')
    expect(html).toContain('00:00:02:05')
    expect(html).not.toContain('00:00:00:00')
    expect(html).not.toContain('Thread timecodes')
  })

  it('exposes the readout as a click target with dialog semantics', () => {
    const html = renderToStaticMarkup(
      <ComposerTimecode running={false} startedAt={null} cumulativeBaseMs={0} />
    )

    expect(html).toMatch(/<button[^>]*class="composer-run-timecode composer-timecode-control/)
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
  })
})

describe('computeComposerTimecodePopoverPosition', () => {
  it('anchors the popover above the composer surface', () => {
    const position = computeComposerTimecodePopoverPosition({
      triggerRect: { left: 760, top: 920, width: 116 },
      surfaceRect: { left: 256, width: 840 },
      viewportWidth: 1280
    })

    expect(position.left).toBe(264)
    expect(position.top).toBe(912)
    expect(position.width).toBe(824)
  })

  it('keeps the popover inside viewport edges', () => {
    const leftEdge = computeComposerTimecodePopoverPosition({
      triggerRect: { left: 2, top: 920, width: 116 },
      surfaceRect: { left: 2, width: 260 },
      viewportWidth: 1280
    })
    const rightEdge = computeComposerTimecodePopoverPosition({
      triggerRect: { left: 1264, top: 920, width: 34 },
      surfaceRect: { left: 1160, width: 260 },
      viewportWidth: 1280
    })

    expect(leftEdge.left).toBe(10)
    expect(leftEdge.width).toBe(320)
    expect(rightEdge.left).toBe(952)
    expect(rightEdge.width).toBe(320)
  })
})
