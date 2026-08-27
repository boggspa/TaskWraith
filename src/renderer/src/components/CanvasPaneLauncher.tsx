/**
 * CanvasPaneLauncher — the empty-pane affordance for opening the Canvas
 * Browser in a multiview pane, composer, or dock. Opening is deliberately
 * blank-first; navigation belongs in the Browser's own address rail.
 */
import { PillButton } from './PillButton'

export interface CanvasPaneLauncherProps {
  onOpen: () => void
}

export function CanvasPaneLauncher({ onOpen }: CanvasPaneLauncherProps) {
  return (
    <div className="canvas-pane-launcher" style={{ display: 'flex', alignItems: 'center' }}>
      {/* Shared rim pill (PillButton → .segmented-control-action), not a bare
        native button: this launcher renders in three places (multiview empty
        pane, composer Canvas popover, Canvas dock) and each was showing the
        browser default. `compact` matches the launcher's inline row height; the
        popover additionally widens it to line up with its other Canvas actions
        (see `.canvas-composer-popover .segmented-control-action`, shard 03). */}
      <PillButton size="compact" className="canvas-pane-launcher-open" onClick={onOpen}>
        Open browser
      </PillButton>
    </div>
  )
}
