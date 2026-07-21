import React from 'react'
import type { UpdateStateSnapshot } from '../../../main/UpdateService'

interface UpdatePillProps {
  snapshot: UpdateStateSnapshot | null
  /** Opens the changelog sheet (corner affordance / fallback). */
  onOpen?: () => void
  /** One-click update action (sidebar pill). When set, click runs this instead of onOpen. */
  onQuickUpdate?: () => void
  /** 'corner' = the chat-corner icon button (default); 'sidebar' = rim-highlight
   * pill above the workspaces masthead. Hidden unless an update is actionable. */
  variant?: 'corner' | 'sidebar'
}

const ACTIONABLE_UPDATE_STATUSES = new Set<UpdateStateSnapshot['status']>([
  'available',
  'downloading',
  'downloaded',
  'error'
])

export function isUpdatePillVisible(snapshot: UpdateStateSnapshot | null | undefined): boolean {
  return Boolean(snapshot && ACTIONABLE_UPDATE_STATUSES.has(snapshot.status))
}

export function UpdatePill({
  snapshot,
  onOpen,
  onQuickUpdate,
  variant = 'corner'
}: UpdatePillProps): React.JSX.Element | null {
  if (!isUpdatePillVisible(snapshot) || !snapshot) return null

  const label = labelForSnapshot(snapshot)
  const className =
    variant === 'sidebar'
      ? `sidebar-update-pill sidebar-update-pill-${snapshot.status}`
      : `chat-corner-btn chat-corner-update-pill chat-corner-update-pill-${snapshot.status}`
  const handleClick = onQuickUpdate ?? onOpen
  return (
    <button
      className={className}
      type="button"
      onClick={handleClick}
      disabled={!handleClick}
      title={titleForSnapshot(snapshot)}
      aria-label={titleForSnapshot(snapshot)}
    >
      <span className="chat-corner-update-pill-label">{label}</span>
    </button>
  )
}

function labelForSnapshot(snapshot: UpdateStateSnapshot): string {
  switch (snapshot.status) {
    case 'available':
      return snapshot.latestVersion ? `Update ${snapshot.latestVersion}` : 'Update'
    case 'downloading':
      return typeof snapshot.downloadProgress?.percent === 'number'
        ? `${Math.round(snapshot.downloadProgress.percent)}%`
        : 'Downloading'
    case 'downloaded':
      return snapshot.restartPending ? 'Restart queued' : 'Restart'
    case 'error':
      return 'Update issue'
    default:
      return 'Update'
  }
}

function titleForSnapshot(snapshot: UpdateStateSnapshot): string {
  switch (snapshot.status) {
    case 'available':
      return snapshot.latestVersion
        ? `Download TaskWraith ${snapshot.latestVersion}`
        : 'Download the latest TaskWraith update'
    case 'downloading':
      return 'TaskWraith update is downloading'
    case 'downloaded':
      return snapshot.restartPending
        ? 'TaskWraith will restart when active work completes'
        : 'Restart TaskWraith to install the update now'
    case 'error':
      return snapshot.errorMessage || 'TaskWraith update check failed'
    default:
      return 'TaskWraith update'
  }
}
