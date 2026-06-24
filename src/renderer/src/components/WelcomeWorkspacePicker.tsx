import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceRecord } from '../../../main/store/types'
import {
  hideWelcomeWorkspaceId,
  readWelcomeWorkspaceHiddenIds
} from '../lib/welcomeWorkspaceHidden'

/**
 * Welcome-screen workspace picker (1.0.3). Surfaces below the welcome
 * hero on a fresh chat so users can switch workspace without first
 * hunting through the sidebar. Two rows of affordances:
 *
 *   - "Recent": the 4 most-recently-touched workspaces as chips. Click
 *     to swap to that workspace. Current workspace is suppressed from
 *     the list (no point picking the one you're already on).
 *   - "Browse…": opens the system folder picker via the existing
 *     `selectWorkspace` IPC → main calls `dialog.showOpenDialog`. On
 *     success the parent's `handleSelectWorkspace` then refreshes the
 *     workspace list and switches over.
 *
 * Shown on both workspace and global welcome surfaces. "Global Chat" is
 * always the first chip, followed by recent workspaces, so users can choose
 * the final scope before the first message is sent.
 */
export interface WelcomeWorkspacePickerProps {
  workspaces: WorkspaceRecord[]
  currentWorkspace: WorkspaceRecord | null
  isGlobalChat: boolean
  /** Switch to (or rebind the empty welcome chat to) an existing
   * workspace. Same handler the chips use. */
  onPickExisting: (ws: WorkspaceRecord) => void
  /** Open the system folder dialog and add the picked folder as a
   * new workspace. Replaces the "Browse…" chip's previous direct-
   * to-dialog action — now lives inside the "More workspaces"
   * popover so the welcome surface stays compact. */
  onAddNewWorkspace: () => void
  /** Switch to a workspace-less (global / system) chat. Handy escape
   * hatch when the user opened the welcome view by accident or for
   * Ensembles that don't need a workspace anchor. */
  onSelectNoWorkspace: () => void
}

/**
 * Number of most-recent workspaces to surface as inline chips before
 * the rest spill into the popover. Four chips comfortably cover the
 * typical active projects without crowding the welcome hero. Reduced to 3
 * once Global Chat became a permanent leading chip in 1.0.6.
 */
export const WELCOME_WORKSPACE_INLINE_LIMIT = 3

/**
 * Max height (px) for the "More workspaces" popover. At open time it is clamped
 * down to the trigger's space-to-viewport-bottom, so the list scrolls
 * internally and the popover never trails off-screen. A little taller than the
 * in-composer switcher (360px) since welcome-surface workspace lists run long.
 */
export const WELCOME_WORKSPACE_POPOVER_MAX_HEIGHT = 420

export function WelcomeWorkspacePicker({
  workspaces,
  currentWorkspace,
  isGlobalChat,
  onPickExisting,
  onAddNewWorkspace,
  onSelectNoWorkspace
}: WelcomeWorkspacePickerProps): React.JSX.Element | null {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [hiddenWorkspaceIds, setHiddenWorkspaceIds] = useState<Set<string>>(() =>
    readWelcomeWorkspaceHiddenIds()
  )
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  // 1.0.5-W1 — Position state for the portaled popover. The pre-1.0.5
  // version rendered the popover as an absolutely-positioned child of
  // the welcome-workspace-picker, which got trapped beneath the
  // composer-area's z-index: 4 stacking context (the composer above-
  // row + chip strip sit above the welcome). Portalling through
  // document.body fully escapes the welcome's stacking context;
  // we just need to compute fixed-position coordinates from the
  // trigger's bounding rect on open + window resize.
  const [popoverPosition, setPopoverPosition] = useState<{
    left: number
    top: number
    maxHeight: number
  } | null>(null)

  // Close on outside click + Escape, so the popover behaves like every
  // other dropdown in the app (slash menu, mention picker, etc.).
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

  // 1.0.5-W1 — Compute popover position from the trigger's bounding
  // rect on open + on window resize. The popover sits below the
  // trigger, centered horizontally on it, clamped to the viewport
  // edges so it stays on-screen on narrow windows.
  useLayoutEffect(() => {
    if (!popoverOpen) {
      const frame = window.requestAnimationFrame(() => setPopoverPosition(null))
      return () => window.cancelAnimationFrame(frame)
    }
    const computePosition = (): void => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const popoverWidth = 420 // approx; matches the popover's max-width hint
      const margin = 8
      const idealLeft = rect.left + rect.width / 2 - popoverWidth / 2
      const clampedLeft = Math.max(
        margin,
        Math.min(window.innerWidth - popoverWidth - margin, idealLeft)
      )
      const top = rect.bottom + 6
      // Bound the popover so a long workspace list scrolls internally instead
      // of trailing off-screen: a compact fixed cap, clamped down to the gap
      // between the trigger and the viewport bottom. The list scrolls; the
      // actions stay pinned (CSS).
      const maxHeight = Math.max(
        0,
        Math.min(WELCOME_WORKSPACE_POPOVER_MAX_HEIGHT, window.innerHeight - top - margin)
      )
      setPopoverPosition({ left: clampedLeft, top, maxHeight })
    }
    computePosition()
    window.addEventListener('resize', computePosition)
    window.addEventListener('scroll', computePosition, true)
    return () => {
      window.removeEventListener('resize', computePosition)
      window.removeEventListener('scroll', computePosition, true)
    }
  }, [popoverOpen])

  const handleHideWorkspace = (workspaceId: string): void => {
    hideWelcomeWorkspaceId(workspaceId)
    setHiddenWorkspaceIds((current) => new Set([...current, workspaceId]))
  }

  const others = workspaces
    .filter((ws) => ws.id !== currentWorkspace?.id)
    .filter((ws) => !hiddenWorkspaceIds.has(ws.id))
    .sort((a, b) => (b.lastOpenedAt || b.createdAt || 0) - (a.lastOpenedAt || a.createdAt || 0))
  const inline = others.slice(0, WELCOME_WORKSPACE_INLINE_LIMIT)
  const overflow = others.slice(WELCOME_WORKSPACE_INLINE_LIMIT)

  const handleSelectFromPopover = (callback: () => void): void => {
    setPopoverOpen(false)
    // defer so the popover-close render finishes before the parent
    // navigates / fires its dialog — keeps focus + state transitions
    // visually clean.
    setTimeout(callback, 0)
  }

  return (
    <div className="welcome-workspace-picker">
      <span className="welcome-workspace-picker-label">Work in folder:</span>
      <div className="welcome-workspace-picker-chips">
        <button
          type="button"
          className={`welcome-workspace-picker-chip welcome-workspace-picker-global ${isGlobalChat ? 'is-active' : ''}`}
          onClick={onSelectNoWorkspace}
          disabled={isGlobalChat}
          aria-current={isGlobalChat ? 'page' : undefined}
          title="A general chat that isn't tied to any folder"
        >
          <span className="welcome-workspace-picker-chip-name">General Chat</span>
        </button>
        {inline.map((ws) => (
          <span key={ws.id} className="welcome-workspace-picker-chip-wrap">
            <button
              type="button"
              className="welcome-workspace-picker-chip"
              onClick={() => onPickExisting(ws)}
              title={ws.path}
            >
              <span className="welcome-workspace-picker-chip-name">
                {ws.displayName || ws.path.split('/').pop() || 'Workspace'}
              </span>
            </button>
            <button
              type="button"
              className="welcome-workspace-picker-chip-dismiss"
              onClick={() => handleHideWorkspace(ws.id)}
              title="Remove from this row"
              aria-label={`Remove ${ws.displayName || ws.path.split('/').pop() || 'workspace'} from this row`}
            >
              ×
            </button>
          </span>
        ))}
        <button
          ref={triggerRef}
          type="button"
          className={`welcome-workspace-picker-chip welcome-workspace-picker-browse ${popoverOpen ? 'is-open' : ''}`}
          onClick={() => setPopoverOpen((open) => !open)}
          aria-expanded={popoverOpen}
          aria-haspopup="menu"
          title="Browse all workspaces"
        >
          Browse…
        </button>
      </div>
      {popoverOpen &&
        popoverPosition &&
        createPortal(
          // 1.0.5-W1 — Render through document.body so the popover
          // escapes the welcome screen's stacking context (the
          // composer above-row + chip strip sit at z-index 4 from the
          // welcome's perspective and would otherwise paint over this).
          // Fixed positioning + computed coords keep the popover
          // anchored to the trigger; computePosition re-fires on
          // window resize / scroll.
          <div
            ref={popoverRef}
            className="welcome-workspace-popover welcome-workspace-popover--portaled"
            role="menu"
            style={{
              position: 'fixed',
              left: `${popoverPosition.left}px`,
              top: `${popoverPosition.top}px`,
              maxHeight: `${popoverPosition.maxHeight}px`,
              transform: 'none'
            }}
          >
            {overflow.length > 0 && (
              <div className="welcome-workspace-popover-section">
                <div className="welcome-workspace-popover-header">More workspaces</div>
                {overflow.map((ws) => (
                  <div key={ws.id} className="welcome-workspace-popover-row welcome-workspace-popover-row-with-dismiss">
                    <button
                      type="button"
                      role="menuitem"
                      className="welcome-workspace-popover-row-main-action"
                      onClick={() => handleSelectFromPopover(() => onPickExisting(ws))}
                      title={ws.path}
                    >
                      <span className="welcome-workspace-popover-row-name">
                        {ws.displayName || ws.path.split('/').pop() || 'Workspace'}
                      </span>
                      {ws.path && (
                        <span className="welcome-workspace-popover-row-path">{ws.path}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="welcome-workspace-picker-chip-dismiss"
                      onClick={() => handleHideWorkspace(ws.id)}
                      title="Remove from this row"
                      aria-label={`Remove ${ws.displayName || ws.path.split('/').pop() || 'workspace'} from this row`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="welcome-workspace-popover-section welcome-workspace-popover-actions">
              <button
                type="button"
                role="menuitem"
                className="welcome-workspace-popover-row welcome-workspace-popover-row-action"
                onClick={() => handleSelectFromPopover(onAddNewWorkspace)}
              >
                <span className="welcome-workspace-popover-row-glyph" aria-hidden>
                  +
                </span>
                <span className="welcome-workspace-popover-row-name">Add new workspace…</span>
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
                  No workspace (system chat)
                </span>
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
