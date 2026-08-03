/**
 * Display-only App Drive agent cursor overlay.
 *
 * Renders a decorative pointer hint over a dock preview. It never warps the
 * host cursor, never posts CGEvents, and always uses pointer-events: none.
 */
import type { CSSProperties, ReactNode } from 'react'
import {
  normalizeVirtualCursorPoint,
  type AppDriveVirtualCursorPoint
} from '../lib/appDriveDockState'
import './AppDriveVirtualCursor.css'

export interface AppDriveVirtualCursorProps {
  readonly point: AppDriveVirtualCursorPoint | null | undefined
  /** When false, the overlay is omitted even if a point is supplied. */
  readonly visible?: boolean
}

export function AppDriveVirtualCursor({
  point,
  visible = true
}: AppDriveVirtualCursorProps): ReactNode {
  const normalized = normalizeVirtualCursorPoint(point)
  if (!visible || !normalized) return null

  const style = {
    ['--appdrive-cursor-x' as string]: `${normalized.x * 100}%`,
    ['--appdrive-cursor-y' as string]: `${normalized.y * 100}%`
  } as CSSProperties

  return (
    <div
      className="appdrive-virtual-cursor"
      style={style}
      aria-hidden="true"
      data-testid="appdrive-virtual-cursor"
      data-cursor-role="display-only"
      title={
        normalized.label
          ? `${normalized.label} · display only — does not move the Mac pointer`
          : 'Agent cursor (display only — does not move the Mac pointer)'
      }
    >
      <span className="appdrive-virtual-cursor-glyph" />
      {normalized.label ? (
        <span className="appdrive-virtual-cursor-label">{normalized.label}</span>
      ) : null}
    </div>
  )
}
