/**
 * CanvasPaneLauncher — the empty-pane affordance for opening the Canvas
 * Browser in a multiview pane or the dock. A URL field + button; on submit it
 * normalizes address-bar input (scheme-less "example.com" / "localhost:3000"
 * included) and hands the absolute URL to the host, which calls
 * window.api.canvas.openEmbedded and assigns the returned canvasId to this pane.
 */
import { useState } from 'react'
import { PillButton } from './PillButton'
import { normalizeBrowserUrlInput } from '../lib/canvasBrowserUrl'

export interface CanvasPaneLauncherProps {
  onOpen: (url: string) => void
  defaultUrl?: string
}

export function CanvasPaneLauncher({ onOpen, defaultUrl }: CanvasPaneLauncherProps) {
  const [url, setUrl] = useState(defaultUrl ?? '')
  const normalized = normalizeBrowserUrlInput(url)
  const submit = (): void => {
    if (normalized) onOpen(normalized)
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
        placeholder="https://example.com or localhost:3000"
        aria-label="Browser URL"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
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
        // Submit already no-ops on a non-navigable address — disabling just
        // makes that visible, using the shared disabled treatment.
        disabled={!normalized}
      >
        Open browser
      </PillButton>
    </div>
  )
}
