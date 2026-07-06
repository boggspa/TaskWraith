export interface ComposerSurfacePopoverPosition {
  left: number
  top: number
  width: number
}

export interface ComposerSurfacePopoverInput {
  triggerRect: Pick<DOMRect, 'left' | 'top' | 'width'>
  surfaceRect: Pick<DOMRect, 'left' | 'width'>
  viewportWidth: number
  gap?: number
  horizontalInset?: number
  margin?: number
  widthFloor?: number
}

export function resolveComposerSurfacePopoverPosition({
  triggerRect,
  surfaceRect,
  viewportWidth,
  gap = 8,
  horizontalInset = 16,
  margin = 8,
  widthFloor = 320
}: ComposerSurfacePopoverInput): ComposerSurfacePopoverPosition {
  const availableWidth = Math.max(0, viewportWidth - margin * 2)
  const desiredWidth = Math.max(0, surfaceRect.width - horizontalInset)
  const minimumWidth = Math.min(widthFloor, availableWidth)
  const width = Math.min(Math.max(desiredWidth, minimumWidth), availableWidth)
  const preferredLeft = surfaceRect.left + horizontalInset / 2
  const maxLeft = Math.max(margin, viewportWidth - width - margin)
  return {
    left: Math.round(Math.min(Math.max(preferredLeft, margin), maxLeft)),
    top: Math.round(triggerRect.top - gap),
    width: Math.round(width)
  }
}
