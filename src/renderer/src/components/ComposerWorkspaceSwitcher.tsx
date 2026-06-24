import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { describeExternalPath } from '../lib/ExternalPathRepoDetect'
import type { ExternalPathGitMetadata } from '../lib/ExternalPathRepoDetect'
import type { AppSettings, ExternalPathGrant, WorkspaceRecord } from '../../../main/store/types'
import { FolderSymbolIcon } from './AppChromeSymbols'
import { WorkspaceRemoteAccessToggle } from './WorkspaceRemoteAccessToggle'
import { buildAllowlistUpsertForSegment } from './workspaceRemoteAccess'
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
  /** Switch to (or rebind the chat to) an existing workspace. */
  onPickExisting: (ws: WorkspaceRecord) => void
  /** Open the system folder dialog and add the picked folder. */
  onAddNewWorkspace: () => void
  /** Switch to a workspace-less (global / system) chat. */
  onSelectNoWorkspace: () => void
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
   * folder as an *additional* workspace with the given access.
   * Generalizes the old read-only "Grant read access…" row into a
   * READ-or-WRITE add. Optional because welcome-state chats have
   * no chat record to attach grants to yet; when absent, the
   * "Add a workspace" section stays hidden.
   */
  onAddFolder?: (access: ExternalPathGrant['access']) => void
  /**
   * 1.0.6-EW69 — Attach an existing KNOWN workspace as an additional
   * (secondary) workspace with the chosen access, without the OS
   * folder dialog. Lets the "Add a workspace" section offer one-click
   * adds for every registered workspace. Gated together with
   * `onAddFolder` (both need a saved chat record).
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
  access: ExternalPathGrant['access']
  order: number
}

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

export function ComposerWorkspaceSwitcher({
  workspaces,
  currentWorkspace,
  onPickExisting,
  onAddNewWorkspace,
  onSelectNoWorkspace,
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
  const [popoverPosition, setPopoverPosition] = useState<{ left: number; top: number } | null>(null)
  // 1.0.6-EW66 — READ/WRITE choice for the "Add a workspace" action.
  const [addAccess, setAddAccess] = useState<ExternalPathGrant['access']>('read')
  // 1.0.6-EW66 — pointer-drag reorder state for the additional-
  // workspace list (same pattern as QueuedMessagesAboveRow).
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)
  // Remote (iOS) access for workspaces added from the list below, and shown per
  // current workspace. 'off' (default) writes nothing — preserves the prior add
  // behavior. One allowlist fetch (on open) feeds the primary toggle (controlled)
  // and the add logic.
  const [addRemoteMode, setAddRemoteMode] = useState<'off' | 'read' | 'read-write'>('off')
  const [remoteAllowlist, setRemoteAllowlist] = useState<RemoteWorkspaceEntry[]>([])
  const refreshRemoteAllowlist = (): void => {
    void window.api
      .bridgeAllowlistList()
      .then((list) => setRemoteAllowlist((list ?? []) as RemoteWorkspaceEntry[]))
      .catch(() => undefined)
  }
  useEffect(() => {
    if (!popoverOpen) {
      // Re-arm to the safe default each session, so a previously chosen Read/Write
      // can't silently apply to a later add.
      setAddRemoteMode('off')
      return
    }
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

  // Position computation: anchor below the trigger, left-align to
  // the trigger so the popover grows toward the composer's centre
  // (the welcome variant centres on the trigger, but the composer
  // button sits at the far left of the composer row so left-anchor
  // reads more naturally). Clamped to the viewport edges on
  // narrow windows.
  useLayoutEffect(() => {
    if (!popoverOpen) {
      const frame = window.requestAnimationFrame(() => setPopoverPosition(null))
      return () => window.cancelAnimationFrame(frame)
    }
    const computePosition = (): void => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const popoverWidth = 320
      const margin = 8
      // Left-align to the trigger but keep on-screen.
      const idealLeft = rect.left
      const clampedLeft = Math.max(
        margin,
        Math.min(window.innerWidth - popoverWidth - margin, idealLeft)
      )
      // Open ABOVE the button when the composer sits at the bottom
      // of the viewport — flip if there's no room below. 360px is
      // the popover's max-height estimate; leave a 6px gap.
      const POPOVER_MAX_HEIGHT = 360
      const wouldOverflowBottom = rect.bottom + 6 + POPOVER_MAX_HEIGHT > window.innerHeight - margin
      const top = wouldOverflowBottom
        ? Math.max(margin, rect.top - 6 - POPOVER_MAX_HEIGHT)
        : rect.bottom + 6
      setPopoverPosition({ left: clampedLeft, top })
    }
    computePosition()
    window.addEventListener('resize', computePosition)
    window.addEventListener('scroll', computePosition, true)
    return () => {
      window.removeEventListener('resize', computePosition)
      window.removeEventListener('scroll', computePosition, true)
    }
  }, [popoverOpen])

  const others = workspaces
    .filter((ws) => ws.id !== currentWorkspace?.id)
    .sort((a, b) => (b.lastOpenedAt || b.createdAt || 0) - (a.lastOpenedAt || a.createdAt || 0))

  // 1.0.6-EW66 — collapse the per-provider grants into one entry
  // per PATH for the "Current workspaces" list. Order comes from
  // the shared per-path `order` (assigned by the store); a path is
  // WRITE if ANY of its grants is write. Branch/basename derive
  // from whichever grant for the path has resolved git metadata.
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
          access: grant.access,
          order: typeof grant.order === 'number' ? grant.order : Number.MAX_SAFE_INTEGER
        })
        continue
      }
      // Upgrade access to write if any grant for the path is write,
      // and fill in repo metadata if a later grant resolved it.
      if (grant.access === 'write') existing.access = 'write'
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

  // 1.0.6-EW69 — known workspaces eligible to attach as a SECONDARY:
  // everything except the primary (already in `others`) and anything
  // already attached as an additional workspace.
  const attachedPaths = new Set(additionalEntries.map((entry) => entry.path))
  const addableWorkspaces = others.filter((ws) => ws.path && !attachedPaths.has(ws.path))

  const handleSelectFromPopover = (callback: () => void): void => {
    setPopoverOpen(false)
    setTimeout(callback, 0)
  }

  // Add a known workspace as a secondary folder AND, if a remote tier is chosen,
  // write its iOS allowlist entry. Read-modify-write (buildAllowlistUpsertForSegment)
  // so it never widens a grant narrowed in Settings → Devices.
  const handleAddKnown = (ws: WorkspaceRecord): void => {
    handleSelectFromPopover(() => {
      onAddKnownWorkspace?.(ws.path, addAccess)
      if (addRemoteMode === 'off') return
      void (async () => {
        try {
          // Read the LIVE allowlist right before writing so read-modify-write is
          // based on truth, not a stale/unresolved snapshot — otherwise a fast add
          // could widen a grant the user narrowed in Settings → Devices to
          // first-grant defaults. (The popover is already closed; the on-open
          // effect re-fetches next time, so no refresh is needed here.)
          const fresh = ((await window.api.bridgeAllowlistList()) ?? []) as RemoteWorkspaceEntry[]
          const existing = fresh.find((entry) => entry.workspaceId === ws.id)
          const payload = buildAllowlistUpsertForSegment(
            { id: ws.id, path: ws.path },
            addRemoteMode,
            existing
          )
          await window.api.bridgeAllowlistUpsert(payload)
        } catch {
          // keep prior behavior on IPC failure
        }
      })()
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
      // Don't start a drag from the remove button.
      if (target.closest('.composer-workspace-row-remove')) return
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

  const additionalCount = additionalEntries.length
  const triggerLabel = additionalCount > 0 ? `${primaryLabel} +${additionalCount}` : primaryLabel

  const titleText = currentWorkspace
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
        aria-expanded={popoverOpen}
        aria-haspopup="menu"
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
            role="menu"
            style={{
              position: 'fixed',
              left: `${popoverPosition.left}px`,
              top: `${popoverPosition.top}px`,
              transform: 'none'
            }}
          >
            {/*
              1.0.6-EW66 — "Current workspaces": the chat's primary
              workspace (PRIMARY badge, not removable) plus any
              additional folders attached via grants — de-duped by
              path, sorted by the shared per-path `order`, each with
              a READ/WRITE badge, a remove (×), and a drag handle for
              reordering (pointer-drag, persisted via onReorderWorkspaces).
            */}
            <div className="welcome-workspace-popover-section composer-workspace-current">
              <div className="welcome-workspace-popover-header">Current workspaces</div>
              {currentWorkspace ? (
                <div
                  className="composer-workspace-row composer-workspace-row-primary"
                  title={currentWorkspace.path}
                >
                  <span className="composer-workspace-row-main">
                    <span className="composer-workspace-row-name">{primaryLabel}</span>
                    {currentWorkspace.path && (
                      <span className="composer-workspace-row-path">{currentWorkspace.path}</span>
                    )}
                  </span>
                  <span className="composer-workspace-badge composer-workspace-badge-primary">
                    PRIMARY
                  </span>
                  <WorkspaceRevealButton path={currentWorkspace.path} label={primaryLabel} />
                  <WorkspaceRemoteAccessToggle
                    workspace={currentWorkspace}
                    entries={remoteAllowlist}
                    onChanged={refreshRemoteAllowlist}
                  />
                </div>
              ) : (
                <div className="composer-workspace-row composer-workspace-row-empty">
                  <span className="composer-workspace-row-name">No primary workspace</span>
                </div>
              )}
              {additionalEntries.map((entry) => (
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
                  <span
                    className={`composer-workspace-access-badge access-${entry.access}`}
                    title={
                      entry.access === 'write'
                        ? 'Agents in this chat can read AND edit this folder'
                        : 'Agents in this chat can read this folder'
                    }
                  >
                    {entry.access === 'write' ? 'WRITE' : 'READ'}
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
            {/*
              1.0.6-EW69 — "Add a workspace": attach an *additional*
              (secondary) workspace with a per-add READ/WRITE choice.
              The toggle governs both the one-click adds for existing
              known workspaces AND the OS folder picker for arbitrary
              folders. WRITE grants let agents edit the folder (and
              surface a full diff + Create-PR row); READ grants are
              reference-only. Hidden for welcome-state chats (no chat
              record to attach grants to yet).
            */}
            {onAddFolder && (
              <div className="welcome-workspace-popover-section composer-workspace-add">
                <div className="welcome-workspace-popover-header">Add a workspace</div>
                <div className="composer-workspace-remote-caption">Agent access (this chat)</div>
                <div
                  className="composer-workspace-access-toggle"
                  role="radiogroup"
                  aria-label="Access for the workspace you add"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={addAccess === 'read'}
                    className={`composer-workspace-access-option ${
                      addAccess === 'read' ? 'is-active' : ''
                    }`}
                    onClick={() => setAddAccess('read')}
                    title="Read-only: agents can view files in the folder"
                  >
                    Read
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={addAccess === 'write'}
                    className={`composer-workspace-access-option ${
                      addAccess === 'write' ? 'is-active' : ''
                    }`}
                    onClick={() => setAddAccess('write')}
                    title="Read + write: agents can edit files and open PRs for the folder"
                  >
                    Write
                  </button>
                </div>
                <div className="composer-workspace-remote-caption">Phone access (remote)</div>
                <div
                  className="composer-workspace-access-toggle composer-workspace-remote-toggle"
                  role="group"
                  aria-label="Remote (iOS) access for the workspace you add"
                >
                  {(['off', 'read', 'read-write'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={addRemoteMode === mode}
                      className={`composer-workspace-access-option ${
                        addRemoteMode === mode ? 'is-active' : ''
                      } ${mode === 'read-write' ? 'is-write' : ''}`}
                      onClick={() => setAddRemoteMode(mode)}
                      title={
                        mode === 'off'
                          ? 'Remote: not shared with paired devices'
                          : mode === 'read'
                            ? 'Remote: phone can monitor + approve, no file changes'
                            : 'Remote: phone can edit files and run git commit/push'
                      }
                    >
                      {mode === 'off' ? 'Off' : mode === 'read' ? 'Read' : 'Read/Write'}
                    </button>
                  ))}
                </div>
                {addRemoteMode !== 'off' && (
                  <p className="composer-workspace-remote-hint">
                    {addRemoteMode === 'read-write'
                      ? 'Workspaces you add become writable from your phone (incl. git commit/push).'
                      : 'Workspaces you add become viewable from your phone.'}
                    {remoteAllowlist.length === 0
                      ? ' Your first remote grant also exposes general chats to your phone in plan mode.'
                      : ''}
                  </p>
                )}
                {/*
                  1.0.6-EW69 — one-click add for every KNOWN workspace
                  that isn't the primary and isn't already attached.
                  Honours the access toggle; no OS dialog needed.
                */}
                {onAddKnownWorkspace &&
                  addableWorkspaces.map((ws) => (
                    <button
                      key={ws.id}
                      type="button"
                      role="menuitem"
                      className="welcome-workspace-popover-row composer-workspace-add-known"
                      onClick={() => handleAddKnown(ws)}
                      title={`Attach ${ws.displayName || ws.path} as a ${
                        addAccess === 'write' ? 'read + write' : 'read-only'
                      } additional workspace`}
                    >
                      <span className="welcome-workspace-popover-row-glyph" aria-hidden>
                        +
                      </span>
                      <span className="welcome-workspace-popover-row-name">
                        {ws.displayName || ws.path.split('/').pop() || 'Workspace'}
                      </span>
                      <span
                        className={`composer-workspace-access-badge access-${addAccess}`}
                        aria-hidden
                      >
                        {addAccess === 'write' ? 'WRITE' : 'READ'}
                      </span>
                    </button>
                  ))}
                <button
                  type="button"
                  role="menuitem"
                  className="welcome-workspace-popover-row welcome-workspace-popover-row-action"
                  onClick={() => handleSelectFromPopover(() => onAddFolder(addAccess))}
                  title={
                    addAccess === 'write'
                      ? 'Attach a folder agents in this chat can read AND edit'
                      : 'Attach a folder agents in this chat can read'
                  }
                >
                  <span className="welcome-workspace-popover-row-glyph" aria-hidden>
                    {addAccess === 'write' ? '✎' : '👁'}
                  </span>
                  <span className="welcome-workspace-popover-row-name">
                    Add another folder ({addAccess === 'write' ? 'write' : 'read'} access)…
                  </span>
                </button>
              </div>
            )}
            {/*
              1.0.6-EW66 — "Switch primary": rebind the chat's primary
              workspace to another known folder, open a brand-new
              folder as the primary, or drop to a workspace-less
              system chat. (Distinct from "Add a workspace" above,
              which keeps the primary and attaches an additional one.)
            */}
            <div className="welcome-workspace-popover-section welcome-workspace-popover-actions">
              <div className="welcome-workspace-popover-header">Switch primary workspace</div>
              {others.map((ws) => (
                <div key={ws.id} className="welcome-workspace-popover-row composer-workspace-switch-row">
                  <button
                    type="button"
                    role="menuitem"
                    className="welcome-workspace-popover-row-main-action"
                    onClick={() => handleSelectFromPopover(() => onPickExisting(ws))}
                    title={`Make ${ws.displayName || ws.path} the primary workspace`}
                  >
                    <span className="welcome-workspace-popover-row-name">
                      {ws.displayName || ws.path.split('/').pop() || 'Workspace'}
                    </span>
                    {ws.path && (
                      <span className="welcome-workspace-popover-row-path">{ws.path}</span>
                    )}
                  </button>
                  {ws.path ? (
                    <WorkspaceRevealButton
                      path={ws.path}
                      label={ws.displayName || ws.path.split('/').pop() || 'Workspace'}
                    />
                  ) : null}
                </div>
              ))}
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
