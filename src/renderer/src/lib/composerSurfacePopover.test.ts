import { describe, expect, it } from 'vitest'
import { resolveComposerSurfacePopoverPosition } from './composerSurfacePopover'

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
