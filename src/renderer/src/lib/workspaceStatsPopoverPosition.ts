const POPOVER_GAP = 8
const VIEWPORT_GUTTER = 16
const MOBILE_VIEWPORT_GUTTER = 10
const MOBILE_BREAKPOINT = 560
const MULTIVIEW_GUTTER = 12
const MAX_WIDTH = 527
const MULTIVIEW_MAX_WIDTH = 442

export interface WorkspaceStatsPopoverPosition {
  left: number
  top: number
  width: number
}

export function resolveWorkspaceStatsPopoverPosition({
  anchorRect,
  viewportWidth,
  multiviewBounds
}: {
  anchorRect: Pick<DOMRect, 'right' | 'bottom'>
  viewportWidth: number
  multiviewBounds?: Pick<DOMRect, 'left' | 'right'>
}): WorkspaceStatsPopoverPosition {
  const viewportGutter =
    viewportWidth <= MOBILE_BREAKPOINT ? MOBILE_VIEWPORT_GUTTER : VIEWPORT_GUTTER
  const leftBoundary = Math.max(
    viewportGutter,
    multiviewBounds ? multiviewBounds.left + MULTIVIEW_GUTTER : viewportGutter
  )
  const rightBoundary = Math.min(
    Math.max(viewportGutter, viewportWidth - viewportGutter),
    multiviewBounds ? multiviewBounds.right - MULTIVIEW_GUTTER : viewportWidth - viewportGutter
  )
  const maxWidth = multiviewBounds ? MULTIVIEW_MAX_WIDTH : MAX_WIDTH
  const width = Math.max(0, Math.min(maxWidth, rightBoundary - leftBoundary))
  const maxLeft = Math.max(leftBoundary, rightBoundary - width)

  return {
    left: Math.round(Math.min(Math.max(anchorRect.right - width, leftBoundary), maxLeft)),
    top: Math.round(anchorRect.bottom + POPOVER_GAP),
    width: Math.round(width)
  }
}
