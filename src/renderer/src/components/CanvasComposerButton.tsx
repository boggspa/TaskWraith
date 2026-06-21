// Composer toolbar button that opens a live-embedded web Canvas in a multiview
// pane (the one-click entry point — vs. splitting the view + the empty-pane
// launcher, or asking an agent to canvas_open). Clicking the icon opens a small
// URL popover (the shared CanvasPaneLauncher); on submit the host opens the canvas
// and places it in a new pane (App.tsx -> openEmbedded + openCanvasInNewPane).
import { useEffect, useRef, useState } from 'react'
import { CanvasPaneLauncher } from './CanvasPaneLauncher'

export interface CanvasComposerButtonProps {
  onOpenCanvas: (url: string) => void
  disabled?: boolean
}

function CanvasGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.5 5.5h13" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

export function CanvasComposerButton({ onOpenCanvas, disabled }: CanvasComposerButtonProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="canvas-composer-button" style={{ position: 'relative' }}>
      <button
        type="button"
        className="composer-hint-pill--left composer-canvas-trigger"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Open a web canvas"
        aria-label="Open a web canvas"
        aria-expanded={open}
      >
        <CanvasGlyph />
      </button>
      {open ? (
        <div
          className="canvas-composer-popover"
          role="dialog"
          aria-label="Open a web canvas"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: 6,
            zIndex: 60,
            minWidth: 300,
            padding: 10,
            borderRadius: 10,
            background: 'var(--surface-1, #1c1c20)',
            border: '1px solid var(--border, #333)',
            boxShadow: '0 8px 28px rgba(0,0,0,0.35)'
          }}
        >
          <div
            style={{
              font: '11px/1.4 system-ui, sans-serif',
              opacity: 0.7,
              marginBottom: 6
            }}
          >
            Open a running app (e.g. a dev server) in a Canvas pane
          </div>
          <CanvasPaneLauncher
            onOpen={(url) => {
              onOpenCanvas(url)
              setOpen(false)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
