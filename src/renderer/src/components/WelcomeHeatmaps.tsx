import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react'
import { visibleHeatmapSlots, type HeatmapLayout } from '../lib/welcomeHeatmapLayout'

const HEATMAP_SWIPE_MS = 320
const HEATMAP_DRAG_THRESHOLD_PX = 48
const HEATMAP_DRAG_AXIS_RATIO = 1.15

export type WelcomeHeatmapCycleDirection = 'prev' | 'next'

interface WelcomeHeatmapDragState {
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastY: number
}

export interface WelcomeHeatmapSlot {
  /** Stable identity for the heatmap (e.g. 'workspace' | 'taskwraith' | 'external'). */
  key: string
  node: ReactNode
}

interface WelcomeHeatmapsProps {
  slots: WelcomeHeatmapSlot[]
  layout: HeatmapLayout
  /** Seconds between cycles in 'single' layout. Default 90. */
  cycleSeconds?: number
}

export function welcomeHeatmapDirectionForDrag(
  deltaX: number,
  deltaY: number,
  thresholdPx = HEATMAP_DRAG_THRESHOLD_PX
): WelcomeHeatmapCycleDirection | null {
  const absX = Math.abs(deltaX)
  const absY = Math.abs(deltaY)
  if (absX < thresholdPx || absX < absY * HEATMAP_DRAG_AXIS_RATIO) return null
  return deltaX < 0 ? 'prev' : 'next'
}

function isInteractiveSwipeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(
    target.closest('button, a, input, textarea, select, [role="button"], [data-swipe-ignore="true"]')
  )
}

/**
 * Container for the welcome-screen standalone heatmaps.
 *   - 'stacked' renders every slot vertically (the long-standing layout).
 *   - 'single' renders one slot at a time, auto-cycling through the slots every
 *     `cycleSeconds` (default 90s) — mirrors the dashboard tab auto-cycle.
 *
 * The interval lives here, so it unmounts automatically when the welcome region
 * disappears. Stacked slots still render through keyed Fragments so the existing
 * vertical layout stays untouched; single mode mounts an outgoing pane only for
 * the short swipe transition.
 */
export function WelcomeHeatmaps({
  slots,
  layout,
  cycleSeconds = 90
}: WelcomeHeatmapsProps): ReactElement | null {
  const [activeIndex, setActiveIndex] = useState(0)
  const [outgoingIndex, setOutgoingIndex] = useState<number | null>(null)
  const [transitionDirection, setTransitionDirection] =
    useState<WelcomeHeatmapCycleDirection>('next')
  const [isDragging, setIsDragging] = useState(false)
  const activeIndexRef = useRef(activeIndex)
  const dragStateRef = useRef<WelcomeHeatmapDragState | null>(null)
  const cycling = layout === 'single' && slots.length > 1

  useEffect(() => {
    activeIndexRef.current = activeIndex
  }, [activeIndex])

  useEffect(() => {
    setTransitionDirection('next')
    setOutgoingIndex(null)
    setActiveIndex((index) => (slots.length > 0 ? index % slots.length : 0))
  }, [layout, slots.length])

  const advance = useCallback(
    (direction: WelcomeHeatmapCycleDirection) => {
      if (layout !== 'single' || slots.length <= 1) return
      const current = ((activeIndexRef.current % slots.length) + slots.length) % slots.length
      const next =
        direction === 'next'
          ? (current + 1) % slots.length
          : (current - 1 + slots.length) % slots.length
      if (next === current) return
      setTransitionDirection(direction)
      setOutgoingIndex(current)
      activeIndexRef.current = next
      setActiveIndex(next)
    },
    [layout, slots.length]
  )

  useEffect(() => {
    if (!cycling) return
    const ms = Math.max(5, cycleSeconds) * 1000
    const id = setInterval(() => advance('next'), ms)
    return () => clearInterval(id)
  }, [activeIndex, advance, cycling, cycleSeconds])

  useEffect(() => {
    if (outgoingIndex === null) return
    const id = window.setTimeout(() => setOutgoingIndex(null), HEATMAP_SWIPE_MS)
    return () => window.clearTimeout(id)
  }, [outgoingIndex])

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!cycling) return
      if (event.pointerType === 'mouse' && event.button !== 0) return
      if (isInteractiveSwipeTarget(event.target)) return
      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY
      }
      setIsDragging(false)
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Best-effort only: older WebViews can throw if capture is unavailable.
      }
    },
    [cycling]
  )

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.lastX = event.clientX
    drag.lastY = event.clientY
    const deltaX = drag.lastX - drag.startX
    const deltaY = drag.lastY - drag.startY
    if (!isDragging && welcomeHeatmapDirectionForDrag(deltaX, deltaY, 12)) {
      setIsDragging(true)
    }
  }, [isDragging])

  const clearPointerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current
    if (!drag || drag.pointerId !== event.pointerId) return null
    dragStateRef.current = null
    setIsDragging(false)
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // Pointer capture release is best-effort for the same reason as capture.
    }
    return drag
  }, [])

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = clearPointerDrag(event)
      if (!drag) return
      const direction = welcomeHeatmapDirectionForDrag(
        drag.lastX - drag.startX,
        drag.lastY - drag.startY
      )
      if (!direction) return
      event.preventDefault()
      advance(direction)
    },
    [advance, clearPointerDrag]
  )

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      clearPointerDrag(event)
    },
    [clearPointerDrag]
  )

  if (slots.length === 0) return null

  const visible = visibleHeatmapSlots(slots, layout, activeIndex)
  const className = [
    'welcome-standalone-heatmaps',
    `welcome-standalone-heatmaps--${layout}`,
    cycling ? 'is-swipe-enabled' : '',
    isDragging ? 'is-dragging' : ''
  ]
    .filter(Boolean)
    .join(' ')

  if (layout === 'single') {
    const slot = slots[activeIndex % slots.length]
    const outgoingSlot = outgoingIndex === null ? null : slots[outgoingIndex % slots.length]
    const transitioning = Boolean(outgoingSlot && outgoingSlot.key !== slot.key)
    const incomingDirectionClass = transitionDirection === 'next' ? 'from-left' : 'from-right'
    const outgoingDirectionClass = transitionDirection === 'next' ? 'to-right' : 'to-left'
    return (
      <div
        className={className}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        {transitioning && outgoingSlot && (
          <div
            key={`outgoing-${outgoingSlot.key}`}
            className={`welcome-standalone-heatmap-pane is-outgoing ${outgoingDirectionClass}`}
          >
            {outgoingSlot.node}
          </div>
        )}
        <div
          key={`active-${slot.key}`}
          className={`welcome-standalone-heatmap-pane${
            transitioning ? ` is-incoming ${incomingDirectionClass}` : ' is-active'
          }`}
        >
          {slot.node}
        </div>
      </div>
    )
  }

  return (
    <div className={className}>
      {visible.map((slot) => (
        <Fragment key={slot.key}>{slot.node}</Fragment>
      ))}
    </div>
  )
}
