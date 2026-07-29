import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { describeExternalPath } from '../lib/ExternalPathRepoDetect'
import type { ExternalPathGitMetadata } from '../lib/ExternalPathRepoDetect'
import { resolveComposerSurfacePopoverPosition } from '../lib/composerSurfacePopover'
import type { AppSettings, ExternalPathGrant, WorkspaceRecord } from '../../../main/store/types'
import { FolderSymbolIcon, XSymbolIcon } from './AppChromeSymbols'
import { WorkspaceRemoteAccessToggle } from './WorkspaceRemoteAccessToggle'
import type { RemoteWorkspaceEntry } from '../../../shared/remoteWorkspaceDefaults'

/**
 * 1.0.5-AR12b — Composer-position workspace switcher.
 *
 * Pre-AR12b the composer's workspace button (`data-composer-
 * control="workspace"`) opened the workspace files popout — the
 * label said "Switch workspace · <name>" but the action just
 * surfaced the current workspace's files. That mismatch surprised
 * users (clicking "Switch workspace" doesn't switch the workspace).
 *
 * This component preserves the 9-shell CSS targeting (same outer
 * button class + `data-composer-control="workspace"` hook + same
 * order tokens via the existing per-shell overrides in main.css)
 * but the click action is now a real portal-popover with:
 *
 *   - All workspaces (recent-first, current omitted) as menu rows
 *   - Add new workspace… (opens system folder dialog)
 *   - No workspace (rebinds to a system / global chat)
 *
 * The popover render shape mirrors `WelcomeWorkspacePicker` (1.0.5-
 * W1 portal positioning, outside-click + Escape dismiss, fixed-
 * position coords clamped to the viewport) but the trigger is the
 * composer button itself, sized and themed by the composer-shell
 * CSS rather than the welcome-screen chip layout. The popover
 * styling reuses the `welcome-workspace-popover*` class family
 * since the visual surface is intentionally identical to the
 * welcome-screen surface — no need to fork the CSS.
 */
export interface ComposerWorkspaceSwitcherProps {
  workspaces: WorkspaceRecord[]
  currentWorkspace: WorkspaceRecord | null
  /** Canonical target queued until the current chat releases its workspace. */
  pendingWorkspace?: WorkspaceRecord | null
  /** Switch to (or rebind the chat to) an existing workspace. */
  onPickExisting: (ws: WorkspaceRecord) => void
  /** Open the system folder dialog and add the picked folder. */
  onAddNewWorkspace: () => void
  /** Switch to a workspace-less (global / system) chat. */
  onSelectNoWorkspace: () => void
  /** Remove a registered workspace/environment from TaskWraith. */
  onRemoveWorkspace?: (id: string, event: React.MouseEvent<HTMLButtonElement>) => void
  /**
   * 1.0.6-EW66 — The chat's *additional*-workspace grants (one
   * `ExternalPathGrant` per chat-provider per path). The picker
   * de-dupes by path for its "Current workspaces" list, so an
   * ensemble's N per-provider grants for one folder show as a
   * single removable + drag-reorderable row.
   */
  additionalGrants?: ExternalPathGrant[]
  /**
   * 1.0.6-EW66 — Per-grant git metadata keyed by grant id (from
   * `useExternalPathRepoMetadata`). Drives the branch label on
   * each additional-workspace row.
   */
  repoMetadata?: Record<string, ExternalPathGitMetadata | null>
  /**
   * 1.0.6-EW66 — Persist a new top-to-bottom order of additional-
   * workspace paths after a drag. Optional — welcome-state chats
   * (no saved record) don't get the reorder affordance.
   */
  onReorderWorkspaces?: (orderedPaths: string[]) => void
  /**
   * 1.0.6-EW66 — Remove every grant for a path (the whole
   * additional workspace). Optional for the same welcome-state
   * reason as the reorder handler.
   */
  onRemoveWorkspacePath?: (path: string) => void
  /**
   * 1.0.6-EW66 — Open the OS folder picker and attach the chosen
   * folder as an *additional* workspace. Additional workspaces are
   * explicit chat attachments, so the picker now requests write
   * grants by default while per-agent policy still governs whether
   * a participant may write.
   */
  onAddFolder?: (access: ExternalPathGrant['access']) => void
  /**
   * 1.0.6-EW69 — Attach an existing KNOWN workspace as an additional
   * (secondary) workspace without the OS folder dialog. Lets the
   * "Add a workspace" section offer one-click adds for every
   * registered workspace. Gated together with `onAddFolder`
   * (both need a saved chat record).
   */
  onAddKnownWorkspace?: (path: string, access: ExternalPathGrant['access']) => void
  /**
   * 1.0.6-EW67 — Active composer shell, mirrored onto the portal
   * root as `shell-${composerStyle}` so the theme-immune Obsidian /
   * Alabaster popover CSS reaches this body-portaled popover.
   */
  composerStyle?: AppSettings['composerStyle']
}

/**
 * 1.0.6-EW66 — One row in the picker's "Current workspaces" list,
 * collapsed to a single entry per PATH (an ensemble stores one
 * grant per enabled participant-provider for the same folder).
 */
interface AdditionalWorkspaceEntry {
  path: string
  basename: string
  branch?: string
  isRepo: boolean
  order: number
}

const SECONDARY_WORKSPACE_ACCESS: ExternalPathGrant['access'] = 'write'

function WorkspaceRevealButton({
  path,
  label
}: {
  path: string
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="composer-workspace-row-reveal"
      onClick={(event) => {
        event.stopPropagation()
        if (typeof window.api?.revealPathInFinder === 'function') {
          void window.api.revealPathInFinder(path)
        }
      }}
      title={`Reveal ${label} in Finder`}
      aria-label={`Reveal ${label} in Finder`}
    >
      Finder
    </button>
  )
}

export interface ComposerWorkspaceKnownRowProps {
  workspace: WorkspaceRecord
  isPrimary: boolean
  isPending?: boolean
  canCancelPending?: boolean
  isAttached: boolean
  remoteEntries: RemoteWorkspaceEntry[]
  onMakePrimary: () => void
  onAddSecondary?: () => void
  onRemoteChanged: () => void
  onDetach?: () => void
  onRemove?: (event: React.MouseEvent<HTMLButtonElement>) => void
}

/**
 * One registered-workspace row in the composer picker. Switching primary is
 * deliberately the large, default name-button action; adding the folder as a
 * secondary workspace stays behind the explicit trailing `+` action.
 */
export function ComposerWorkspaceKnownRow({
  workspace,
  isPrimary,
  isPending = false,
  canCancelPending = false,
  isAttached,
  remoteEntries,
  onMakePrimary,
  onAddSecondary,
  onRemoteChanged,
  onDetach,
  onRemove
}: ComposerWorkspaceKnownRowProps): React.JSX.Element {
  const label = workspace.displayName || workspace.path.split('/').pop() || 'Workspace'
  const canAdd = Boolean(onAddSecondary && workspace.path && !isPrimary && !isAttached)

  return (
    <div
      className={`composer-workspace-known-row${isPrimary ? ' is-primary' : ''}${
        isPending ? ' is-pending' : ''
      }${
        isAttached ? ' is-attached' : ''
      }`}
      title={workspace.path}
    >
      <button
        type="button"
        className="composer-workspace-known-main"
        onClick={onMakePrimary}
        disabled={(isPrimary && !canCancelPending) || isPending}
        title={
          isPrimary && canCancelPending
            ? `Keep ${label} primary and cancel the pending workspace change`
            : isPrimary
            ? 'Already the primary workspace'
            : isPending
              ? 'Pending primary workspace'
              : `Make ${label} primary`
        }
        aria-label={
          isPrimary && canCancelPending
            ? `Keep ${label} as primary workspace`
            : isPrimary
            ? `${label}, primary workspace`
            : isPending
              ? `${label}, pending primary workspace`
              : `Switch primary workspace to ${label}`
        }
        aria-current={isPrimary ? 'true' : undefined}
      >
        <span className="composer-workspace-known-name">{label}</span>
        {isPrimary && (
          <span className="composer-workspace-badge composer-workspace-badge-primary">primary</span>
        )}
        {isPending && (
          <span className="composer-workspace-badge composer-workspace-badge-attached">
            pending
          </span>
        )}
        {!isPrimary && isAttached && (
          <span className="composer-workspace-badge composer-workspace-badge-attached">
            attached
          </span>
        )}
      </button>
      {isAttached && onDetach ? (
        <button
          type="button"
          className="segmented-control-action segmented-control-action--compact composer-workspace-known-detach"
          onClick={onDetach}
          title={`Detach ${label} from this chat`}
        >
          Detach
        </button>
      ) : null}
      <button
        type="button"
        className="segmented-control-action segmented-control-action--compact composer-workspace-known-add"
        onClick={onAddSecondary}
        disabled={!canAdd}
        title={
          isPrimary
            ? 'This is already the primary workspace'
            : isAttached
              ? 'Already attached to this chat'
              : onAddSecondary
                ? `Attach ${label} as an additional workspace`
                : 'Open a saved chat to attach secondary workspaces'
        }
        aria-label={`Add ${label} as secondary workspace`}
      >
        +
      </button>
      <span className="composer-workspace-known-remote">
        <span className="composer-workspace-known-remote-label">Remote:</span>
        <WorkspaceRemoteAccessToggle
          workspace={workspace}
          entries={remoteEntries}
          onChanged={onRemoteChanged}
        />
      </span>
      {onRemove && (
        <button
          type="button"
          className="composer-workspace-known-remove"
          onClick={(event) => {
            event.stopPropagation()
            onRemove(event)
          }}
          title={`Remove ${label} from TaskWraith`}
          aria-label={`Remove ${label} from TaskWraith`}
        >
          <XSymbolIcon />
        </button>
      )}
    </div>
  )
}

export function ComposerWorkspaceSwitcher({
  workspaces,
  currentWorkspace,
  pendingWorkspace = null,
  onPickExisting,
  onAddNewWorkspace,
  onSelectNoWorkspace,
  onRemoveWorkspace,
  additionalGrants,
  repoMetadata,
  onReorderWorkspaces,
  onRemoveWorkspacePath,
  onAddFolder,
  onAddKnownWorkspace,
  composerStyle
}: ComposerWorkspaceSwitcherProps): React.JSX.Element {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [popoverPosition, setPopoverPosition] = useState<{
    left: number
    top: number
    width: number
  } | null>(null)
  // 1.0.6-EW66 — pointer-drag reorder state for the additional-
  // workspace list (same pattern as QueuedMessagesAboveRow).
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)
  // Remote (iOS) access for every registered workspace row. One allowlist fetch
  // (on open) feeds each per-row WorkspaceRemoteAccessToggle.
  const [remoteAllowlist, setRemoteAllowlist] = useState<RemoteWorkspaceEntry[]>([])
  const refreshRemoteAllowlist = (): void => {
    void window.api
      .bridgeAllowlistList()
      .then((list) => setRemoteAllowlist((list ?? []) as RemoteWorkspaceEntry[]))
      .catch(() => undefined)
  }
  useEffect(() => {
    if (!popoverOpen) return
    void window.api
      .bridgeAllowlistList()
      .then((list) => setRemoteAllowlist((list ?? []) as RemoteWorkspaceEntry[]))
      .catch(() => undefined)
  }, [popoverOpen])

  // Same outside-click + Escape dismiss pattern as WelcomeWorkspacePicker.
  useEffect(() => {
    if (!popoverOpen) return
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setPopoverOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setPopoverOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [popoverOpen])

  // Position computation: anchor to the full composer surface, matching the
  // bottom-row popovers that were already converted to composer-width sheets.
  useLayoutEffect(() => {
    if (!popoverOpen) {
      const frame = window.requestAnimationFrame(() => setPopoverPosition(null))
      return () => window.cancelAnimationFrame(frame)
    }
    const computePosition = (): void => {
      const trigger = triggerRef.current
      if (!trigger) return
      const triggerRect = trigger.getBoundingClientRect()
      const surface = trigger.closest('.composer-surface') as HTMLElement | null
      const surfaceRect = surface?.getBoundingClientRect() ?? triggerRect
      setPopoverPosition(
        resolveComposerSurfacePopoverPosition({
          triggerRect,
          surfaceRect,
          viewportWidth: window.innerWidth,
          widthFloor: 420
        })
      )
    }
    computePosition()
    window.addEventListener('resize', computePosition)
    window.addEventListener('scroll', computePosition, true)
    return () => {
      window.removeEventListener('resize', computePosition)
      window.removeEventListener('scroll', computePosition, true)
    }
  }, [popoverOpen])

  const registeredWorkspaces = useMemo(() => {
    const byId = new Map<string, WorkspaceRecord>()
    for (const ws of workspaces) byId.set(ws.id, ws)
    if (currentWorkspace && !byId.has(currentWorkspace.id)) byId.set(currentWorkspace.id, currentWorkspace)
    if (pendingWorkspace && !byId.has(pendingWorkspace.id)) {
      byId.set(pendingWorkspace.id, pendingWorkspace)
    }
    return [...byId.values()].sort((a, b) => {
      if (a.id === currentWorkspace?.id) return -1
      if (b.id === currentWorkspace?.id) return 1
      if (a.id === pendingWorkspace?.id) return -1
      if (b.id === pendingWorkspace?.id) return 1
      return (b.lastOpenedAt || b.createdAt || 0) - (a.lastOpenedAt || a.createdAt || 0)
    })
  }, [currentWorkspace, pendingWorkspace, workspaces])

  // 1.0.6-EW66 — collapse the per-provider grants into one entry
  // per PATH for the "Current workspaces" list. Order comes from
  // the shared per-path `order` (assigned by the store). Branch/
  // basename derive from whichever grant for the path has resolved
  // git metadata.
  const additionalEntries = useMemo<AdditionalWorkspaceEntry[]>(() => {
    const grants = additionalGrants || []
    const byPath = new Map<string, AdditionalWorkspaceEntry>()
    for (const grant of grants) {
      const meta = repoMetadata?.[grant.id] || null
      const descriptor = describeExternalPath(grant.path, { gitMetadata: meta })
      const existing = byPath.get(grant.path)
      if (!existing) {
        byPath.set(grant.path, {
          path: grant.path,
          basename: descriptor.basename,
          branch: descriptor.isRepo ? descriptor.branch : undefined,
          isRepo: descriptor.isRepo,
          order: typeof grant.order === 'number' ? grant.order : Number.MAX_SAFE_INTEGER
        })
        continue
      }
      // Fill in repo metadata if a later grant resolved it.
      if (!existing.isRepo && descriptor.isRepo) {
        existing.isRepo = true
        existing.basename = descriptor.basename
        existing.branch = descriptor.branch
      }
      if (typeof grant.order === 'number') {
        existing.order = Math.min(existing.order, grant.order)
      }
    }
    return [...byPath.values()].sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    })
  }, [additionalGrants, repoMetadata])

  const attachedPaths = new Set(additionalEntries.map((entry) => entry.path))
  const registeredPaths = new Set(registeredWorkspaces.map((ws) => ws.path).filter(Boolean))
  const externalOnlyAdditionalEntries = additionalEntries.filter(
    (entry) => !registeredPaths.has(entry.path)
  )

  const handleSelectFromPopover = (callback: () => void): void => {
    setPopoverOpen(false)
    setTimeout(callback, 0)
  }

  // Add a known workspace as a secondary folder. Remote access is now controlled
  // per workspace row via WorkspaceRemoteAccessToggle.
  const handleAddKnown = (ws: WorkspaceRecord): void => {
    handleSelectFromPopover(() => {
      onAddKnownWorkspace?.(ws.path, SECONDARY_WORKSPACE_ACCESS)
    })
  }

  // 1.0.6-EW66 — commit a drag: splice the source path to the
  // target's slot and hand the new top-to-bottom path order back
  // to the parent (which rewrites grant `order` + persists).
  const commitReorder = (sourcePath: string, targetPath: string | null): void => {
    setDragPath(null)
    setDragOverPath(null)
    if (!targetPath || sourcePath === targetPath || !onReorderWorkspaces) return
    const paths = additionalEntries.map((entry) => entry.path)
    const fromIdx = paths.indexOf(sourcePath)
    const toIdx = paths.indexOf(targetPath)
    if (fromIdx === -1 || toIdx === -1) return
    const next = [...paths]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    onReorderWorkspaces(next)
  }

  const handleRowPointerDown =
    (sourcePath: string) =>
    (event: React.PointerEvent): void => {
      if (event.button !== 0 || !onReorderWorkspaces) return
      const target = event.target as HTMLElement
      // Don't start a drag from row controls.
      if (target.closest('button') || target.closest('.settings-workspace-remote')) return
      const startX = event.clientX
      const startY = event.clientY
      let dragged = false
      let lastHover: string | null = null
      const findPathUnderPointer = (x: number, y: number): string | null => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        const row = el?.closest(
          '.composer-workspace-row[data-workspace-path]'
        ) as HTMLElement | null
        return row?.getAttribute('data-workspace-path') || null
      }
      const handleMove = (moveEvent: PointerEvent): void => {
        const dx = Math.abs(moveEvent.clientX - startX)
        const dy = Math.abs(moveEvent.clientY - startY)
        if (!dragged && (dx > 6 || dy > 6)) {
          dragged = true
          setDragPath(sourcePath)
        }
        if (dragged) {
          const overPath = findPathUnderPointer(moveEvent.clientX, moveEvent.clientY)
          if (overPath !== lastHover) {
            lastHover = overPath
            setDragOverPath(overPath)
          }
        }
      }
      const handleUp = (upEvent: PointerEvent): void => {
        document.removeEventListener('pointermove', handleMove)
        document.removeEventListener('pointerup', handleUp)
        document.removeEventListener('pointercancel', handleUp)
        if (dragged) {
          const dropPath = findPathUnderPointer(upEvent.clientX, upEvent.clientY)
          commitReorder(sourcePath, dropPath && dropPath !== sourcePath ? dropPath : null)
        }
      }
      document.addEventListener('pointermove', handleMove)
      document.addEventListener('pointerup', handleUp)
      document.addEventListener('pointercancel', handleUp)
    }

  const primaryLabel = currentWorkspace
    ? currentWorkspace.displayName || currentWorkspace.path.split('/').pop() || 'Workspace'
    : 'Pick workspace'
  const pendingLabel = pendingWorkspace
    ? pendingWorkspace.displayName || pendingWorkspace.path.split('/').pop() || 'Workspace'
    : null

  const additionalCount = additionalEntries.length
  const displayedPrimaryLabel = pendingLabel ? `Pending: ${pendingLabel}` : primaryLabel
  const triggerLabel =
    additionalCount > 0 ? `${displayedPrimaryLabel} +${additionalCount}` : displayedPrimaryLabel

  const titleText = pendingWorkspace
    ? `Pending workspace change · ${pendingLabel} (currently ${primaryLabel})`
    : currentWorkspace
      ? `Workspaces · ${currentWorkspace.displayName || currentWorkspace.path}${
          additionalCount > 0 ? ` (+${additionalCount} attached)` : ''
        }`
      : 'Manage workspaces'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-picker-label composer-workspace-button ${
          popoverOpen ? 'is-open' : ''
        }`}
        data-composer-control="workspace"
        data-pending-workspace={pendingWorkspace ? 'true' : 'false'}
        aria-expanded={popoverOpen}
        aria-haspopup="dialog"
        onClick={() => setPopoverOpen((open) => !open)}
        title={titleText}
        aria-label={titleText}
      >
        <FolderSymbolIcon />
        <span className="composer-workspace-button-label">{triggerLabel}</span>
      </button>
      {popoverOpen &&
        popoverPosition &&
        createPortal(
          <div
            ref={popoverRef}
            className={`welcome-workspace-popover welcome-workspace-popover--portaled composer-workspace-popover shell-${
              composerStyle || 'default'
            }`}
            role="dialog"
            style={{
              position: 'fixed',
              left: `${popoverPosition.left}px`,
              top: `${popoverPosition.top}px`,
              width: `${popoverPosition.width}px`,
              maxWidth: 'calc(100vw - 16px)',
              transform: 'translateY(-100%)'
            }}
            aria-label="Workspaces"
          >
            <div className="welcome-workspace-popover-section composer-workspace-known">
              <div className="welcome-workspace-popover-header">Workspaces</div>
              {registeredWorkspaces.map((ws) => {
                const isPrimary = ws.id === currentWorkspace?.id
                const isPending = ws.id === pendingWorkspace?.id
                const isAttached = Boolean(ws.path && attachedPaths.has(ws.path))
                return (
                  <ComposerWorkspaceKnownRow
                    key={ws.id}
                    workspace={ws}
                    isPrimary={isPrimary}
                    isPending={isPending}
                    canCancelPending={isPrimary && Boolean(pendingWorkspace)}
                    isAttached={isAttached}
                    remoteEntries={remoteAllowlist}
                    onMakePrimary={() => handleSelectFromPopover(() => onPickExisting(ws))}
                    onAddSecondary={
                      onAddKnownWorkspace && ws.path ? () => handleAddKnown(ws) : undefined
                    }
                    onRemoteChanged={refreshRemoteAllowlist}
                    onDetach={
                      isAttached && onRemoveWorkspacePath
                        ? () => onRemoveWorkspacePath(ws.path)
                        : undefined
                    }
                    onRemove={onRemoveWorkspace ? (event) => onRemoveWorkspace(ws.id, event) : undefined}
                  />
                )
              })}
              {registeredWorkspaces.length === 0 && (
                <div className="composer-workspace-row composer-workspace-row-empty">
                  <span className="composer-workspace-row-name">No saved workspaces</span>
                </div>
              )}
            </div>
            {externalOnlyAdditionalEntries.length > 0 && (
              <div className="welcome-workspace-popover-section composer-workspace-current">
                <div className="welcome-workspace-popover-header">Attached folders</div>
                {externalOnlyAdditionalEntries.map((entry) => (
                <div
                  key={entry.path}
                  data-workspace-path={entry.path}
                  className={`composer-workspace-row composer-workspace-row-additional ${
                    dragPath === entry.path ? 'is-dragging' : ''
                  } ${
                    dragOverPath === entry.path && dragPath !== entry.path ? 'is-drag-over' : ''
                  }`}
                  title={entry.path}
                  onPointerDown={handleRowPointerDown(entry.path)}
                >
                  {onReorderWorkspaces && (
                    <span
                      className="composer-workspace-drag-handle"
                      aria-hidden
                      title="Drag to reorder"
                    >
                      ⠿
                    </span>
                  )}
                  <span className="composer-workspace-row-main">
                    <span className="composer-workspace-row-name">
                      {entry.basename}
                      {entry.isRepo && entry.branch ? (
                        <em className="composer-workspace-row-branch"> · {entry.branch}</em>
                      ) : null}
                    </span>
                    <span className="composer-workspace-row-path">{entry.path}</span>
                  </span>
                  <WorkspaceRevealButton path={entry.path} label={entry.basename} />
                  {onRemoveWorkspacePath && (
                    <button
                      type="button"
                      className="composer-workspace-row-remove"
                      onClick={(event) => {
                        event.stopPropagation()
                        onRemoveWorkspacePath(entry.path)
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                      title={`Remove ${entry.basename} from this chat`}
                      aria-label={`Remove workspace ${entry.basename}`}
                    >
                      ×
                    </button>
                  )}
                </div>
                ))}
              </div>
            )}
            <div className="welcome-workspace-popover-section welcome-workspace-popover-actions">
              {onAddFolder && (
                <button
                  type="button"
                  role="menuitem"
                  className="welcome-workspace-popover-row welcome-workspace-popover-row-action"
                  onClick={() =>
                    handleSelectFromPopover(() => onAddFolder(SECONDARY_WORKSPACE_ACCESS))
                  }
                  title="Attach a folder as an additional workspace"
                >
                  <span className="welcome-workspace-popover-row-glyph" aria-hidden>
                    +
                  </span>
                  <span className="welcome-workspace-popover-row-name">Add another folder…</span>
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="welcome-workspace-popover-row welcome-workspace-popover-row-action"
                onClick={() => handleSelectFromPopover(onAddNewWorkspace)}
              >
                <span className="welcome-workspace-popover-row-glyph" aria-hidden>
                  +
                </span>
                <span className="welcome-workspace-popover-row-name">
                  Open new folder as workspace…
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="welcome-workspace-popover-row welcome-workspace-popover-row-action"
                onClick={() => handleSelectFromPopover(onSelectNoWorkspace)}
              >
                <span className="welcome-workspace-popover-row-glyph" aria-hidden>
                  ∅
                </span>
                <span className="welcome-workspace-popover-row-name">
                  General chat (no folder)
                </span>
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
