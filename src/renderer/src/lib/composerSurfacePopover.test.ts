import { describe, expect, it } from 'vitest'
import {
  resolveComposerSurfacePopoverPosition,
  sameComposerSurfacePopoverPosition
} from './composerSurfacePopover'

describe('resolveComposerSurfacePopoverPosition', () => {
  it('tracks the composer surface width with a small inset', () => {
    const position = resolveComposerSurfacePopoverPosition({
      triggerRect: { left: 40, top: 700, width: 20 },
      surfaceRect: { left: 24, width: 720 },
      viewportWidth: 900
    })

    expect(position).toEqual({ left: 32, top: 692, width: 704 })
  })

  it('clamps to the viewport edges', () => {
    const position = resolveComposerSurfacePopoverPosition({
      triggerRect: { left: 40, top: 700, width: 20 },
      surfaceRect: { left: 760, width: 240 },
      viewportWidth: 820
    })

    expect(position.left).toBe(492)
    expect(position.width).toBe(320)
  })
})

/**
 * Popover surfaces reposition from a CAPTURING window scroll listener, so every
 * scroll inside their own body reaches it too. Without an equality gate each of
 * those events stored a fresh position object and re-rendered the whole popover:
 * measured 2026-08-05 at ~160ms of script per second of scrolling in the
 * Blackboard board, for a position that never moved a pixel.
 */
describe('sameComposerSurfacePopoverPosition', () => {
  it('treats equal measurements as unchanged', () => {
    expect(
      sameComposerSurfacePopoverPosition(
        { left: 32, top: 692, width: 704 },
        { left: 32, top: 692, width: 704 }
      )
    ).toBe(true)
  })

  it('reports a real move on any axis', () => {
    const base = { left: 32, top: 692, width: 704 }

    expect(sameComposerSurfacePopoverPosition(base, { ...base, left: 33 })).toBe(false)
    expect(sameComposerSurfacePopoverPosition(base, { ...base, top: 691 })).toBe(false)
    expect(sameComposerSurfacePopoverPosition(base, { ...base, width: 700 })).toBe(false)
  })

  it('treats a first measurement as a change', () => {
    expect(sameComposerSurfacePopoverPosition(null, { left: 32, top: 692, width: 704 })).toBe(false)
  })
})
