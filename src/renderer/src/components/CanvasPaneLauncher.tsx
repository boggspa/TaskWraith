/**
 * CanvasPaneLauncher — the empty-pane affordance for opening a live web Canvas in
 * a multiview pane. A URL field + button; on submit it hands the (trimmed) URL to
 * the host, which calls window.api.canvas.openEmbedded and assigns the returned
 * canvasId to this pane.
 */
import { useState } from 'react'
import { PillButton } from './PillButton'

export interface CanvasPaneLauncherProps {
  onOpen: (url: string) => void
  defaultUrl?: string
}

export function CanvasPaneLauncher({ onOpen, defaultUrl }: CanvasPaneLauncherProps) {
  const [url, setUrl] = useState(defaultUrl ?? 'http://localhost:3000')
  const trimmed = url.trim()
  const submit = (): void => {
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
      {/* Shared rim pill (PillButton → .segmented-control-action), not a bare
        native button: this launcher renders in three places (multiview empty
        pane, composer Canvas popover, Canvas dock) and each was showing the
        browser default. `compact` matches the launcher's inline row height; the
        popover additionally widens it to line up with its other Canvas actions
        (see `.canvas-composer-popover .segmented-control-action`, shard 03). */}
      <PillButton
        size="compact"
        className="canvas-pane-launcher-open"
        onClick={submit}
        // Submit already no-ops on an empty URL — disabling just makes that
        // visible, using the shared disabled treatment.
        disabled={!trimmed}
      >
        Open web canvas
      </PillButton>
    </div>
  )
}
