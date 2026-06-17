import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { WorkspaceRecord } from '../../../main/store/types'
import type { RemoteWorkspaceEntry } from '../../../shared/remoteWorkspaceDefaults'
import {
  buildAllowlistUpsertForSegment,
  deriveWorkspaceRemoteSegment,
  entryHasFileCapabilities,
  type WorkspaceRemoteSegment
} from './workspaceRemoteAccess'

/**
 * Per-workspace remote-access control for the Settings → Workspaces card. A
 * self-contained leaf (like RemoteWorkspacesPanel) that reads + writes the iOS
 * remote allowlist directly via window.api, so it adds no state to the App.tsx
 * god-component. Sits left of Pin/Remove.
 *
 * Off → remove the allowlist entry. Read → read-only grant. Read/Write →
 * read-write grant WITH file editing (gated behind a confirm, since fileWrite
 * also authorizes git commit/push over the network). Flipping between Read and
 * Read/Write is read-modify-write (see buildAllowlistUpsertForSegment) so it
 * never widens providers/approval/expiry a user narrowed in the Devices tab.
 */

const SEGMENTS: ReadonlyArray<{
  value: WorkspaceRemoteSegment
  label: string
  aria: string
}> = [
  { value: 'off', label: 'Off', aria: 'Remote access off' },
  { value: 'read', label: 'Read', aria: 'Remote read only' },
  { value: 'read-write', label: 'Read/Write', aria: 'Remote read and write' }
]

function canConfirm(): boolean {
  return typeof window !== 'undefined' && typeof window.confirm === 'function'
}

export function WorkspaceRemoteAccessToggle({
  workspace,
  entries: seededEntries,
  onChanged
}: {
  workspace: WorkspaceRecord
  /** Optional preloaded allowlist (test seam / parent-provided). When absent
   * the component self-fetches on mount. */
  entries?: RemoteWorkspaceEntry[]
  onChanged?: () => void
}): ReactElement {
  const [entries, setEntries] = useState<RemoteWorkspaceEntry[] | null>(seededEntries ?? null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const list = (await window.api.bridgeAllowlistList()) as RemoteWorkspaceEntry[]
      setEntries(list ?? [])
    } catch {
      // Leave the last-known list; a transient bridge error shouldn't blank the
      // control (deriveWorkspaceRemoteSegment treats unknown as Off anyway).
    }
  }, [])

  useEffect(() => {
    if (seededEntries) return
    void refresh()
  }, [seededEntries, refresh])

  const list = entries ?? []
  const entry = list.find((candidate) => candidate.workspaceId === workspace.id)
  const segment = deriveWorkspaceRemoteSegment(entry)
  const filesOff = entry !== undefined && segment === 'read-write' && !entryHasFileCapabilities(entry)

  const handleSelect = useCallback(
    async (target: WorkspaceRemoteSegment) => {
      // Idempotent: re-selecting the active segment is a no-op. This also stops a
      // legacy files-off read-write entry from silently gaining file caps on a
      // stray re-click — escalation happens only on a real Read→Read/Write move.
      if (busy || target === segment) return

      const isFirstGrant = list.length === 0
      if (target !== 'off') {
        const warnings: string[] = []
        if (target === 'read-write') {
          warnings.push(
            `Allow your paired iPhone to read AND write files in "${workspace.displayName}"? ` +
              'It can also commit and push over the network. Change this anytime in Settings → Devices.'
          )
        }
        if (isFirstGrant) {
          warnings.push(
            'This is your first remote workspace — it also makes your workspace-less (global) ' +
              'chats viewable from your phone in plan mode.'
          )
        }
        if (warnings.length > 0 && canConfirm() && !window.confirm(warnings.join('\n\n'))) return
      }

      setBusy(true)
      try {
        if (target === 'off') {
          await window.api.bridgeAllowlistRemove(workspace.id)
          setEntries(list.filter((candidate) => candidate.workspaceId !== workspace.id))
        } else {
          const payload = buildAllowlistUpsertForSegment(
            { id: workspace.id, path: workspace.path },
            target,
            entry
          )
          const saved = (await window.api.bridgeAllowlistUpsert(payload)) as RemoteWorkspaceEntry
          setEntries([
            ...list.filter((candidate) => candidate.workspaceId !== workspace.id),
            saved
          ])
        }
        onChanged?.()
      } finally {
        setBusy(false)
        void refresh()
      }
    },
    [busy, segment, list, entry, workspace.id, workspace.path, workspace.displayName, onChanged, refresh]
  )

  return (
    <div
      className="settings-workspace-remote"
      role="radiogroup"
      aria-label={`Remote access for ${workspace.displayName}`}
      aria-disabled={busy ? 'true' : undefined}
    >
      {SEGMENTS.map((seg) => {
        const active = seg.value === segment
        const isWrite = seg.value === 'read-write'
        return (
          <button
            key={seg.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-segment={seg.value}
            title={
              isWrite
                ? 'Phone can read and edit files (and git commit/push)'
                : seg.value === 'read'
                  ? 'Phone can monitor and approve, no file changes'
                  : 'Not shared with paired devices'
            }
            className={`settings-workspace-remote-segment ${active ? 'is-active' : ''} ${
              isWrite ? 'is-write' : ''
            } ${active && isWrite && filesOff ? 'is-files-off' : ''}`}
            disabled={busy}
            onClick={() => void handleSelect(seg.value)}
          >
            {seg.label}
            {active && isWrite && filesOff ? ' · files off' : ''}
          </button>
        )
      })}
    </div>
  )
}
