// Composer telemetry-row button that opens a web Canvas in a standalone floating
// window (the one-click entry point — vs. the multiview empty-pane launcher, or
// asking an agent to canvas_open). It mirrors the other footer icons (Multiview /
// Screen Watch / Goal): a bare icon-only trigger (composer-canvas-trigger) with a
// hover/focus hint pill (composer-hint-pill + data-hint-label), and a portaled URL
// popover (so the composer-surface's overflow:hidden can't clip it). On submit the
// host opens the canvas as a movable/closable window (window.api.canvas.openWindow)
// — self-contained, with no in-pane DOM-overlay positioning to get wrong.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CanvasPaneLauncher } from './CanvasPaneLauncher'

export interface CanvasComposerButtonProps {
  disabled?: boolean
}

/** A user-facing hint for the common embed failures (no server / bad url). */
function friendlyCanvasError(raw: string | undefined): string {
  const msg = raw || 'Could not open the canvas.'
  if (/CONNECTION_REFUSED|ERR_|NAME_NOT_RESOLVED|timed out/i.test(msg)) {
    return "Couldn't load that URL — is a dev server running there?"
  }
  return msg
}

function CanvasGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.5 5.5h13" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

export function CanvasComposerButton({ disabled }: CanvasComposerButtonProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Clear any stale error when the popover closes, so reopening starts fresh.
  useEffect(() => {
    if (!open) setError(null)
  }, [open])

  const handleOpen = async (url: string): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      // A standalone floating window (movable / closable) — not embedded over a
      // pane, so there's no DOM-overlay positioning to get wrong.
      const result = await window.api.canvas?.openWindow({ url })
      if (result?.ok) {
        setOpen(false)
      } else {
        setError(friendlyCanvasError(result?.error))
      }
    } catch (err) {
      setError(friendlyCanvasError(err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }

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
            <CanvasPaneLauncher onOpen={(url) => void handleOpen(url)} />
            {error ? (
              <div
                role="alert"
                style={{
                  marginTop: 6,
                  font: '11px/1.35 system-ui, sans-serif',
                  color: 'var(--status-failed, #e5484d)'
                }}
              >
                {error}
              </div>
            ) : busy ? (
              <div style={{ marginTop: 6, font: '11px/1.35 system-ui, sans-serif', opacity: 0.6 }}>
                Opening…
              </div>
            ) : null}
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
