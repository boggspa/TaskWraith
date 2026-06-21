/**
 * CanvasPaneLauncher — the empty-pane affordance for opening a live web Canvas in
 * a multiview pane. A URL field + button; on submit it hands the (trimmed) URL to
 * the host, which calls window.api.canvas.openEmbedded and assigns the returned
 * canvasId to this pane.
 */
import { useState } from 'react'

export interface CanvasPaneLauncherProps {
  onOpen: (url: string) => void
  defaultUrl?: string
}

export function CanvasPaneLauncher({ onOpen, defaultUrl }: CanvasPaneLauncherProps) {
  const [url, setUrl] = useState(defaultUrl ?? 'http://localhost:3000')
  const submit = (): void => {
    const trimmed = url.trim()
    if (trimmed) onOpen(trimmed)
  }
  return (
    <div className="canvas-pane-launcher" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input
        type="text"
        className="canvas-pane-launcher-url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
        placeholder="http://localhost:3000"
        aria-label="Canvas URL"
        style={{ minWidth: 0, flex: 1 }}
      />
      <button type="button" className="canvas-pane-launcher-open" onClick={submit}>
        Open web canvas
      </button>
    </div>
  )
}
