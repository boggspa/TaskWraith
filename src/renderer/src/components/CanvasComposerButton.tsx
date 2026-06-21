// Composer telemetry-row button that opens a live-embedded web Canvas in a
// multiview pane (the one-click entry point — vs. splitting the view + the
// empty-pane launcher, or asking an agent to canvas_open). It mirrors the other
// footer icons (Multiview / Screen Watch / Goal): a bare icon-only trigger
// (composer-canvas-trigger) with a hover/focus hint pill (composer-hint-pill +
// data-hint-label), and a portaled URL popover (so the composer-surface's
// overflow:hidden can't clip it). On submit the host opens the canvas + places it
// in a new pane (window.api.canvas.openEmbedded -> multiview.openCanvasInNewPane).
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CanvasPaneLauncher } from './CanvasPaneLauncher'

export interface CanvasComposerButtonProps {
  onOpenCanvas: (url: string) => void
  disabled?: boolean
}

function CanvasGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.5 5.5h13" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

export function CanvasComposerButton({ onOpenCanvas, disabled }: CanvasComposerButtonProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // Anchor the popover above the trigger (mirrors ComposerPlusPicker), clamped
  // into the viewport so it never overflows at narrow widths / in split panes.
  useEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 332)),
      top: rect.top - 8
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (popoverRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const popover =
    open && position
      ? createPortal(
          <div
            ref={popoverRef}
            // Reuse the Model/Reasoning/Provider picker's frosted-glass popover
            // (opaque panel-elevated bg + backdrop blur, light-theme variant
            // included) so it's readable; override only its row layout — our
            // content is a vertical form, not the pickers' multi-column grid.
            className="composer-combined-picker-popover composer-plus-picker-popover canvas-composer-popover"
            role="dialog"
            aria-label="Open a web canvas"
            style={{
              position: 'fixed',
              left: `${position.left}px`,
              top: `${position.top}px`,
              transform: 'translateY(-100%)',
              flexDirection: 'column',
              gap: 8,
              minWidth: 290,
              padding: 10
            }}
          >
            <div style={{ font: '11px/1.4 system-ui, sans-serif', opacity: 0.7, marginBottom: 6 }}>
              Open a running app (e.g. a dev server) in a Canvas pane
            </div>
            <CanvasPaneLauncher
              onOpen={(url) => {
                onOpenCanvas(url)
                setOpen(false)
              }}
            />
          </div>,
          document.body
        )
      : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-canvas-trigger composer-hint-pill composer-hint-pill--left"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-label="Open a web canvas"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-hint-label="Web canvas"
        data-composer-control="canvas"
      >
        <span className="composer-control-icon" aria-hidden="true">
          <CanvasGlyph />
        </span>
      </button>
      {popover}
    </>
  )
}
