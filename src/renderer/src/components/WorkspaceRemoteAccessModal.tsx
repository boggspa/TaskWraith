import { useCallback, useEffect, useState, type ReactElement } from 'react'
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
 * Three options. "This Computer Only" is the default and safe choice (no
 * allowlist entry — Off and This-Computer-Only are mechanically identical, so
 * they're one option here). Read / Read/Write grant remote access; Read/Write
 * shows an inline warning because it permits file writes + git push. Cancel,
 * Escape, or backdrop click all mean This Computer Only (no write).
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

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = (await window.api.bridgeAllowlistList()) as RemoteWorkspaceEntry[]
        if (!alive) return
        setEntries(list ?? [])
        // Re-add of a still-allowlisted folder: pre-select its current tier.
        const existing = (list ?? []).find((candidate) => candidate.workspaceId === workspace.id)
        const seg = deriveWorkspaceRemoteSegment(existing)
        setSelected(seg === 'off' ? 'local' : seg)
      } catch {
        // Leave the safe 'local' default.
      }
    })()
    return () => {
      alive = false
    }
  }, [workspace.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const existing = entries.find((candidate) => candidate.workspaceId === workspace.id)
  const isFirstGrant = entries.length === 0

  const apply = useCallback(async () => {
    if (selected === 'local') {
      onClose()
      return
    }
    setBusy(true)
    try {
      const payload = buildAllowlistUpsertForSegment(
        { id: workspace.id, path: workspace.path },
        selected,
        existing
      )
      await window.api.bridgeAllowlistUpsert(payload)
    } finally {
      setBusy(false)
      onClose()
    }
  }, [selected, workspace.id, workspace.path, existing, onClose])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="creative-approval-backdrop" role="presentation" onClick={() => onClose()}>
      <div
        className="creative-approval-modal workspace-remote-access-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Remote access for ${workspace.displayName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="creative-approval-modal-eyebrow">Workspace added</p>
        <h2 className="creative-approval-modal-title">{workspace.displayName}</h2>
        <p className="creative-approval-modal-description">
          Can your paired iPhone / iPad reach this workspace? You can change this anytime in
          Settings → Workspaces or Devices.
        </p>

        <div className="workspace-remote-access-options" role="radiogroup" aria-label="Remote access">
          {OPTIONS.map((option) => {
            const active = option.value === selected
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                data-choice={option.value}
                className={`workspace-remote-access-option ${active ? 'is-active' : ''} ${
                  option.value === 'read-write' ? 'is-write' : ''
                }`}
                onClick={() => setSelected(option.value)}
              >
                <span className="workspace-remote-access-option-label">{option.label}</span>
                <span className="workspace-remote-access-option-hint">{option.hint}</span>
              </button>
            )
          })}
        </div>

        {selected === 'read-write' && (
          <p className="workspace-remote-access-warning">
            Read/Write lets the phone edit files and run git commit/push over the network.
          </p>
        )}
        {isFirstGrant && selected !== 'local' && (
          <p className="workspace-remote-access-warning">
            This is your first remote workspace — it also makes workspace-less (global) chats
            viewable from your phone in plan mode.
          </p>
        )}

        <div className="workspace-remote-access-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onClose()}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() => void apply()}
          >
            {selected === 'local' ? 'Keep local' : 'Grant access'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
