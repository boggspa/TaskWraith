const POPOVER_WIDTH = 384
const POPOVER_MAX_HEIGHT = 400
const VIEWPORT_MARGIN = 8
const POPOVER_GAP = 8
const MIN_FAVOURABLE_ABOVE_SPACE = 176

export type WorkspaceLockPopoverPlacement = 'above' | 'below'

export interface WorkspaceLockPopoverPosition {
  left: number
  top: number
  width: number
  maxHeight: number
  placement: WorkspaceLockPopoverPlacement
}

/**
 * Keep the edit-coordination panel attached to its composer-footer trigger,
 * but place it in whichever viewport direction has enough room to show it.
 */
export function resolveWorkspaceLockPopoverPosition({
  triggerRect,
  viewportWidth,
  viewportHeight
}: {
  triggerRect: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'>
  viewportWidth: number
  viewportHeight: number
}): WorkspaceLockPopoverPosition {
  const availableWidth = Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2)
  const width = Math.min(POPOVER_WIDTH, availableWidth)
  const preferredLeft = triggerRect.left + triggerRect.width / 2 - width / 2
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN)
  const availableAbove = Math.max(0, triggerRect.top - POPOVER_GAP - VIEWPORT_MARGIN)
  const availableBelow = Math.max(
    0,
    viewportHeight - triggerRect.bottom - POPOVER_GAP - VIEWPORT_MARGIN
  )
  const placement: WorkspaceLockPopoverPlacement =
    availableAbove >= MIN_FAVOURABLE_ABOVE_SPACE || availableAbove >= availableBelow
      ? 'above'
      : 'below'
  const availableHeight = placement === 'above' ? availableAbove : availableBelow

  return {
    left: Math.round(Math.min(Math.max(preferredLeft, VIEWPORT_MARGIN), maxLeft)),
    top: Math.round(
      placement === 'above' ? triggerRect.top - POPOVER_GAP : triggerRect.bottom + POPOVER_GAP
    ),
    width: Math.round(width),
    maxHeight: Math.round(Math.min(POPOVER_MAX_HEIGHT, availableHeight)),
    placement
  }
}
