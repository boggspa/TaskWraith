import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceRecord } from '../../../main/store/types'
import type { RemoteWorkspaceEntry } from '../../../shared/remoteWorkspaceDefaults'
import { buildAllowlistUpsertForSegment, deriveWorkspaceRemoteSegment } from './workspaceRemoteAccess'

/**
 * Shown right after a NEW workspace is added (folder picker), so users grant
 * remote access in the same breath instead of forgetting the separate Devices
 * tab. The workspace is already persisted by the time this opens — this is
 * purely the remote-allowlist choice.
 *
 * Three options. "This Computer Only" is the default + safe choice. For a fresh
 * folder it means "no allowlist entry"; on RE-ADD of an already-allowlisted
 * folder it REVOKES the existing entry (so it never silently leaves remote
 * access on while the UI says local-only). Read / Read/Write grant access;
 * Read/Write shows an inline warning (file writes + git push). Cancel, Escape,
 * or backdrop = This Computer Only WITHOUT mutating (so dismissing is a true
 * no-op, never an accidental revoke). Selection is staged; nothing is written
 * until "Grant access" / "Turn off remote".
 */

type ModalChoice = 'local' | 'read' | 'read-write'

const OPTIONS: ReadonlyArray<{ value: ModalChoice; label: string; hint: string }> = [
  {
    value: 'local',
    label: 'This Computer Only',
    hint: 'Stays off your paired devices. You can grant access later in Settings.'
  },
  {
    value: 'read',
    label: 'Remote · Read',
    hint: 'Paired iPhone/iPad can monitor and approve — no file changes.'
  },
  {
    value: 'read-write',
    label: 'Remote · Read/Write',
    hint: 'Paired devices can edit files and run git commit/push.'
  }
]

const TITLE_ID = 'workspace-remote-access-title'
const DESC_ID = 'workspace-remote-access-desc'
const WARN_WRITE_ID = 'workspace-remote-access-warn-write'
const WARN_FIRST_ID = 'workspace-remote-access-warn-first'

export function WorkspaceRemoteAccessModal({
  workspace,
  onClose
}: {
  workspace: WorkspaceRecord
  onClose: () => void
}): ReactElement | null {
  const [entries, setEntries] = useState<RemoteWorkspaceEntry[]>([])
  const [selected, setSelected] = useState<ModalChoice>('local')
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const lastFocusedRef = useRef<HTMLElement | null>(null)
  const closedRef = useRef(false)

  // Single-shot close: Escape / backdrop / Cancel and apply()'s finally can race;
  // route them all through this so onClose (which runs the deferred navigation)
  // fires exactly once.
  const closeOnce = useCallback(() => {
    if (closedRef.current) return
    closedRef.current = true
    onClose()
  }, [onClose])

  // Load existing entry (pre-select its tier on re-add) + capture/restore focus.
  useEffect(() => {
    lastFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null
    let alive = true
    void (async () => {
      try {
        const list = (await window.api.bridgeAllowlistList()) as RemoteWorkspaceEntry[]
        if (!alive) return
        setEntries(list ?? [])
        const existing = (list ?? []).find((candidate) => candidate.workspaceId === workspace.id)
        const seg = deriveWorkspaceRemoteSegment(existing)
        setSelected(seg === 'off' ? 'local' : seg)
      } catch {
        // Leave the safe 'local' default.
      }
    })()
    // Move focus into the dialog (the safe default option) so a keyboard/AT user
    // — who arrived here via the native folder picker, not an in-page button —
    // lands inside the modal.
    const focusTimer = window.setTimeout(() => {
      const el = dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')
      el?.focus()
    }, 0)
    return () => {
      alive = false
      window.clearTimeout(focusTimer)
      const last = lastFocusedRef.current
      if (last && typeof last.focus === 'function') {
        try {
          last.focus()
        } catch {
          // element may be gone; ignore
        }
      }
    }
  }, [workspace.id])

  // Escape (when idle) + a minimal Tab trap so aria-modal is truthful.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (!busy) closeOnce()
        return
      }
      if (event.key !== 'Tab') return
      const root = dialogRef.current
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      } else if (active && !root.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, closeOnce])

  const existing = entries.find((candidate) => candidate.workspaceId === workspace.id)
  const isFirstGrant = entries.length === 0

  const apply = useCallback(async () => {
    setBusy(true)
    try {
      if (selected === 'local') {
        // Honor "local only" literally: revoke any pre-existing grant.
        if (existing) await window.api.bridgeAllowlistRemove(workspace.id)
      } else {
        const payload = buildAllowlistUpsertForSegment(
          { id: workspace.id, path: workspace.path },
          selected,
          existing
        )
        await window.api.bridgeAllowlistUpsert(payload)
      }
    } finally {
      setBusy(false)
      closeOnce()
    }
  }, [selected, workspace.id, workspace.path, existing, closeOnce])

  // Arrow-key roving for the staged radiogroup (selection has no side effect
  // until Grant, so arrow-to-select is safe + spec-correct here).
  const onRadioKeyDown = (event: React.KeyboardEvent, index: number): void => {
    let next = index
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % OPTIONS.length
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
      next = (index - 1 + OPTIONS.length) % OPTIONS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = OPTIONS.length - 1
    else return
    event.preventDefault()
    setSelected(OPTIONS[next].value)
    optionRefs.current[next]?.focus()
  }

  const describedBy = [
    DESC_ID,
    selected === 'read-write' ? WARN_WRITE_ID : null,
    isFirstGrant && selected !== 'local' ? WARN_FIRST_ID : null
  ]
    .filter(Boolean)
    .join(' ')

  const primaryLabel = selected === 'local' ? (existing ? 'Turn off remote' : 'Keep local') : 'Grant access'

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="creative-approval-backdrop"
      role="presentation"
      onClick={() => {
        if (!busy) closeOnce()
      }}
    >
      <div
        ref={dialogRef}
        className="creative-approval-modal workspace-remote-access-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={describedBy}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="creative-approval-modal-eyebrow">Workspace added</p>
        <h2 id={TITLE_ID} className="creative-approval-modal-title">
          {workspace.displayName}
        </h2>
        <p id={DESC_ID} className="creative-approval-modal-description">
          Can your paired iPhone / iPad reach this workspace? You can change this anytime in
          Settings → Workspaces or Devices.
        </p>

        <div className="workspace-remote-access-options" role="radiogroup" aria-label="Remote access">
          {OPTIONS.map((option, index) => {
            const active = option.value === selected
            return (
              <button
                key={option.value}
                ref={(el) => {
                  optionRefs.current[index] = el
                }}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                data-choice={option.value}
                data-autofocus={active ? '' : undefined}
                className={`workspace-remote-access-option ${active ? 'is-active' : ''} ${
                  option.value === 'read-write' ? 'is-write' : ''
                }`}
                onKeyDown={(event) => onRadioKeyDown(event, index)}
                onClick={() => setSelected(option.value)}
              >
                <span className="workspace-remote-access-option-label">{option.label}</span>
                <span className="workspace-remote-access-option-hint">{option.hint}</span>
              </button>
            )
          })}
        </div>

        {selected === 'read-write' && (
          <p id={WARN_WRITE_ID} role="alert" className="workspace-remote-access-warning">
            Read/Write lets the phone edit files and run git commit/push over the network.
          </p>
        )}
        {isFirstGrant && selected !== 'local' && (
          <p id={WARN_FIRST_ID} role="alert" className="workspace-remote-access-warning">
            This is your first remote workspace — it also makes workspace-less (global) chats
            viewable from your phone in plan mode.
          </p>
        )}

        <div className="workspace-remote-access-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy}
            onClick={() => {
              if (!busy) closeOnce()
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() => void apply()}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
