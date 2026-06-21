/**
 * CanvasPane — a multiview cell that hosts a live-embedded Canvas (web preview).
 *
 * The actual page is a WebContentsView managed in the main process; it paints
 * ABOVE the DOM, so this component's job is to (a) report its host region's rect
 * to main (window.api.canvas.setBounds) on mount + every resize/scroll, and (b)
 * hide the floating view (setVisible) when the cell scrolls out of view, so the
 * preview never paints over unrelated UI. The visible DOM here is just a thin
 * toolbar + an empty host div the view is positioned over.
 */
import { useEffect, useRef } from 'react'

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

export interface CanvasPaneProps {
  canvasId: string
  title?: string
  url?: string
  /** User closed the pane — the host should remove the record AND canvas.close(id). */
  onClose?: () => void
}

export function CanvasPane({ canvasId, title, url, onClose }: CanvasPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    const api = window.api?.canvas
    if (!host || !api) return
    const report = (): void => {
      const r = host.getBoundingClientRect()
      void api.setBounds(canvasId, canvasPaneRect(r))
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(host)
    // capture:true so ancestor scrolls (the pane grid scrolling) also re-report.
    window.addEventListener('resize', report)
    window.addEventListener('scroll', report, true)
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) void api.setVisible(canvasId, e.isIntersecting)
      },
      { threshold: 0 }
    )
    io.observe(host)
    return () => {
      ro.disconnect()
      io.disconnect()
      window.removeEventListener('resize', report)
      window.removeEventListener('scroll', report, true)
      // Hide on unmount (layout change); the host calls canvas.close on removal.
      void api.setVisible(canvasId, false)
    }
  }, [canvasId])

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
        <span
          className="canvas-pane-title"
          title={url}
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
        >
          {title || url || 'Canvas'}
        </span>
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
