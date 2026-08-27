/**
 * CanvasPane — hosts a live-embedded Canvas (web preview / sketch board) in a
 * multiview cell or the right-dock Canvas panel.
 *
 * The actual page is a WebContentsView managed in the main process; it paints
 * ABOVE the DOM, so this component's job is to (a) report its host region's rect
 * to main (window.api.canvas.setBounds) on mount + every resize/scroll, and (b)
 * hide the floating view (setVisible) when the cell scrolls out of view — or,
 * with `overlayGuard`, when other DOM (a popover / modal / palette) paints over
 * the host region — so the preview never covers unrelated UI. The visible DOM
 * here is just a thin toolbar + an empty host div the view is positioned over.
 */
import { useEffect, useRef, type ReactNode } from 'react'

export interface CanvasEmbedRect {
  x: number
  y: number
  width: number
  height: number
}

/** Pure: the floating-view rect (rounded/clamped) from an element's viewport rect. */
export function canvasPaneRect(domRect: {
  left: number
  top: number
  width: number
  height: number
}): CanvasEmbedRect {
  return {
    x: Math.round(domRect.left),
    y: Math.round(domRect.top),
    width: Math.max(0, Math.round(domRect.width)),
    height: Math.max(0, Math.round(domRect.height))
  }
}

/**
 * Pure: is the host region covered by DOM that isn't the host (or inside it)?
 * Samples the center + four inset corners with a hit-tester (elementFromPoint in
 * the real DOM). A WebContentsView is not DOM, so hit-testing sees exactly what
 * would paint UNDER the view — if anything else wins a sampled point, an overlay
 * (popover, modal, ⌘K palette) is over the region and the view must hide.
 */
export function isHostOccluded(
  host: {
    getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number }
    contains(node: Node | null): boolean
  },
  topElementAt: (x: number, y: number) => Element | null
): boolean {
  const rect = host.getBoundingClientRect()
  if (rect.width < 8 || rect.height < 8) return false
  const inset = 4
  const midX = rect.left + rect.width / 2
  const midY = rect.top + rect.height / 2
  // Center + corners + edge-midpoints. Corners alone miss overlays inset from
  // the host edges (the dock switcher popover sits ~4px inside both sides), and
  // the center misses anything anchored to one edge — together they cover both.
  const points: Array<[number, number]> = [
    [midX, midY],
    [rect.left + inset, rect.top + inset],
    [rect.right - inset, rect.top + inset],
    [rect.left + inset, rect.bottom - inset],
    [rect.right - inset, rect.bottom - inset],
    [midX, rect.top + inset],
    [midX, rect.bottom - inset],
    [rect.left + inset, midY],
    [rect.right - inset, midY]
  ]
  for (const [x, y] of points) {
    const element = topElementAt(x, y)
    if (element && element !== host && !host.contains(element)) return true
  }
  return false
}

const OVERLAY_GUARD_INTERVAL_MS = 600

export interface CanvasPaneProps {
  canvasId: string
  title?: string
  url?: string
  /** User closed the pane — the host should remove the record AND canvas.close(id). */
  onClose?: () => void
  /** Extra toolbar affordances (e.g. the dock panel's pop-out button). */
  actions?: ReactNode
  /**
   * Full browser chrome (CanvasBrowserChrome) rendered in place of the plain
   * title readout — the web-canvas "single-page browser" treatment. Actions
   * and close still render to its right.
   */
  chrome?: ReactNode
  /**
   * Hide the floating view whenever other DOM paints over the host region.
   * The dock panel needs this: its surface switcher popover and app modals
   * would otherwise render UNDER the always-on-top WebContentsView.
   */
  overlayGuard?: boolean
}

export function CanvasPane({
  canvasId,
  title,
  url,
  onClose,
  actions,
  chrome,
  overlayGuard
}: CanvasPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    const api = window.api?.canvas
    if (!host || !api) return
    // Visibility = "host is on-screen" AND "nothing overlays it". Both signals
    // are tracked here so IO scroll-out and the overlay guard can't fight.
    let intersecting = true
    let occluded = false
    const applyVisibility = (): void => {
      void api.setVisible(canvasId, intersecting && !occluded).catch(() => undefined)
    }
    const report = (): void => {
      const r = host.getBoundingClientRect()
      void api.setBounds(canvasId, canvasPaneRect(r)).catch(() => undefined)
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(host)
    // capture:true so ancestor scrolls (the pane grid scrolling) also re-report.
    window.addEventListener('resize', report)
    window.addEventListener('scroll', report, true)
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) intersecting = e.isIntersecting
        applyVisibility()
      },
      { threshold: 0 }
    )
    io.observe(host)

    let bodyObserver: MutationObserver | null = null
    let dockObserver: MutationObserver | null = null
    let guardTimer: number | null = null
    if (overlayGuard) {
      const check = (): void => {
        const next = isHostOccluded(host, (x, y) => document.elementFromPoint(x, y))
        if (next !== occluded) {
          occluded = next
          applyVisibility()
        }
      }
      // Portaled overlays (pickers, modals, ⌘K) mount as body children; in-dock
      // popovers (the surface switcher) mutate the dock subtree. The interval is
      // the fallback for anything neither observer sees (pure style reflows).
      bodyObserver = new MutationObserver(check)
      bodyObserver.observe(document.body, { childList: true })
      const dockRoot = host.closest('.right-dock')
      if (dockRoot) {
        dockObserver = new MutationObserver(check)
        dockObserver.observe(dockRoot, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden']
        })
      }
      guardTimer = window.setInterval(check, OVERLAY_GUARD_INTERVAL_MS)
      check()
    }

    return () => {
      ro.disconnect()
      io.disconnect()
      bodyObserver?.disconnect()
      dockObserver?.disconnect()
      if (guardTimer !== null) window.clearInterval(guardTimer)
      window.removeEventListener('resize', report)
      window.removeEventListener('scroll', report, true)
      // Hide on unmount (layout change); the host calls canvas.close on removal.
      void api.setVisible(canvasId, false).catch(() => undefined)
    }
  }, [canvasId, overlayGuard])

  return (
    <div
      className="canvas-pane"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div
        className="canvas-pane-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
          padding: '4px 8px',
          font: '12px/1.4 system-ui, sans-serif'
        }}
      >
        {chrome ? (
          <div style={{ flex: 1, minWidth: 0 }}>{chrome}</div>
        ) : (
          <span
            className="canvas-pane-title"
            title={url}
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
          >
            {title || url || 'Canvas'}
          </span>
        )}
        {actions}
        {onClose ? (
          <button
            type="button"
            className="canvas-pane-close"
            onClick={onClose}
            aria-label="Close canvas pane"
          >
            ×
          </button>
        ) : null}
      </div>
      {/* The WebContentsView floats over this host region (positioned in main). */}
      <div ref={hostRef} className="canvas-pane-host" style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}
