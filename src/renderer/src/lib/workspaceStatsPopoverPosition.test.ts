import { describe, expect, it } from 'vitest'

import { resolveWorkspaceStatsPopoverPosition } from './workspaceStatsPopoverPosition'

describe('resolveWorkspaceStatsPopoverPosition', () => {
  it('aligns the full-size popover to its action pill', () => {
    expect(
      resolveWorkspaceStatsPopoverPosition({
        anchorRect: { right: 1_200, bottom: 48 },
        viewportWidth: 1_280
      })
    ).toEqual({ left: 673, top: 56, width: 527 })
  })

  it('stays inside the owning multiview pane', () => {
    expect(
      resolveWorkspaceStatsPopoverPosition({
        anchorRect: { right: 780, bottom: 80 },
        viewportWidth: 1_280,
        multiviewBounds: { left: 400, right: 800 }
      })
    ).toEqual({ left: 412, top: 88, width: 376 })
  })

  it('preserves the compact mobile viewport gutter', () => {
    expect(
      resolveWorkspaceStatsPopoverPosition({
        anchorRect: { right: 310, bottom: 20 },
        viewportWidth: 320
      })
    ).toEqual({ left: 10, top: 28, width: 300 })
  })
})
