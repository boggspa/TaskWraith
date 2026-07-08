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
 * Per-workspace remote-access control for the Settings → Workspaces card. Reads
 * + writes the iOS remote allowlist directly via window.api, so it adds no state
 * to the App.tsx god-component. Sits left of Pin/Remove.
 *
 * Off → remove the allowlist entry. Read → read-only grant. Read/Write →
 * read-write grant WITH file editing (gated behind a confirm). External
 * publishing (git push / PR creation) is an explicit admin capability managed
 * separately in the Devices remote-workspace panel. Flipping is read-modify-
 * write (buildAllowlistUpsertForSegment) so it never widens providers/approval/
 * expiry a user narrowed in the Devices tab.
 *
 * Selecting a segment APPLIES immediately, so this is an honest segmented button
 * group (role="group" + aria-pressed), not an ARIA radiogroup (whose arrow-key
 * contract would mean firing an IPC/confirm on every arrow press).
 *
 * Controlled vs uncontrolled: when `entries` is provided (SettingsPanel hoists a
 * single fetch and passes it to every card), the control derives from that prop
 * and reports changes via `onChanged`. When absent, it self-fetches on mount.
 */

const SEGMENTS: ReadonlyArray<{
  value: WorkspaceRemoteSegment
  label: string
  aria: string
  title: string
}> = [
  { value: 'off', label: 'Off', aria: 'Remote access off', title: 'Not shared with paired devices' },
  {
    value: 'read',
    label: 'Read',
    aria: 'Remote read only',
    title: 'Phone can monitor and approve, no file changes'
  },
  {
    value: 'read-write',
    label: 'Read/Write',
    aria: 'Remote read and write',
    title: 'Phone can read/edit files and commit locally; publishing is granted separately'
  }
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
  /** When provided, the control is CONTROLLED — it derives from this list and
   * reports mutations via onChanged (parent owns the single fetch). When absent
   * it self-fetches on mount (uncontrolled). */
  entries?: RemoteWorkspaceEntry[]
  onChanged?: () => void
}): ReactElement {
  const controlled = seededEntries !== undefined
  const [fetched, setFetched] = useState<RemoteWorkspaceEntry[] | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const list = (await window.api.bridgeAllowlistList()) as RemoteWorkspaceEntry[]
      setFetched(list ?? [])
    } catch {
      // Leave the last-known list; deriveWorkspaceRemoteSegment treats unknown as Off.
    }
  }, [])

  useEffect(() => {
    if (controlled) return
    void refresh()
  }, [controlled, refresh])

  const list = controlled ? (seededEntries ?? []) : (fetched ?? [])
  const entry = list.find((candidate) => candidate.workspaceId === workspace.id)
  const segment = deriveWorkspaceRemoteSegment(entry)
  const filesOff = entry !== undefined && segment === 'read-write' && !entryHasFileCapabilities(entry)

  const handleSelect = useCallback(
    async (target: WorkspaceRemoteSegment) => {
      // Idempotent: re-selecting the active segment is a no-op. This also stops a
      // legacy files-off read-write entry from silently gaining file caps on a
      // stray re-click — escalation happens only on a real Read→Read/Write move.
      // The busy guard blocks keyboard re-activation while a change is in flight
      // (the buttons stay focusable; see the no-disabled note below).
      if (busy || target === segment) return

      if (target === 'off') {
        setBusy(true)
        try {
          await window.api.bridgeAllowlistRemove(workspace.id)
          onChanged?.()
        } finally {
          setBusy(false)
          if (!controlled) void refresh()
        }
        return
      }

      setBusy(true)
      try {
        // Read the LIVE allowlist right before writing: a stale or still-loading
        // `entries` prop (seeded []) must never make a Devices-narrowed entry look
        // absent and get widened to first-grant defaults. read-modify-write only
        // holds if `existing` reflects truth at write time, not at render time.
        const fresh = ((await window.api.bridgeAllowlistList()) ?? []) as RemoteWorkspaceEntry[]
        const freshEntry = fresh.find((candidate) => candidate.workspaceId === workspace.id)
        const isFirstGrant = fresh.length === 0
        const warnings: string[] = []
        if (target === 'read-write') {
          warnings.push(
            `Allow your paired iPhone to read AND write files in "${workspace.displayName}"? ` +
              'It can also stage and commit local git changes. Git push and PR creation are granted separately in Settings → Devices.'
          )
        }
        if (isFirstGrant) {
          warnings.push(
            'This is your first remote workspace — it also makes your workspace-less (global) ' +
              'chats viewable from your phone in plan mode.'
          )
        }
        if (warnings.length > 0 && canConfirm() && !window.confirm(warnings.join('\n\n'))) return
        const payload = buildAllowlistUpsertForSegment(
          { id: workspace.id, path: workspace.path },
          target,
          freshEntry
        )
        await window.api.bridgeAllowlistUpsert(payload)
        onChanged?.()
      } finally {
        setBusy(false)
        if (!controlled) void refresh()
      }
    },
    [busy, segment, workspace.id, workspace.path, workspace.displayName, controlled, onChanged, refresh]
  )

  return (
    <div
      className="segmented-control segmented-control--compact settings-workspace-remote"
      role="group"
      aria-label={`Remote access for ${workspace.displayName}`}
      aria-busy={busy ? 'true' : undefined}
      aria-disabled={busy ? 'true' : undefined}
    >
      {SEGMENTS.map((seg) => {
        const active = seg.value === segment
        const isWrite = seg.value === 'read-write'
        return (
          <button
            key={seg.value}
            type="button"
            // Honest segmented control: one button is "pressed" (the active tier).
            // Not role="radio" — selection applies immediately, so the radio
            // arrow-key contract would fire IPC/confirms on every arrow press.
            aria-pressed={active}
            aria-label={seg.aria}
            data-segment={seg.value}
            title={seg.title}
            // No `disabled={busy}`: disabling the focused button mid-change drops
            // keyboard focus to <body>. The handleSelect busy-guard blocks
            // re-activation; aria-disabled + CSS pointer-events block the mouse.
            className={`segmented-control-segment settings-workspace-remote-segment ${
              active ? 'is-active' : ''
            } ${isWrite ? 'is-write' : ''} ${
              active && isWrite && filesOff ? 'is-files-off' : ''
            }`}
            onClick={() => void handleSelect(seg.value)}
          >
            {seg.label}
            {active && isWrite && filesOff ? ' · files off' : ''}
          </button>
        )
      })}
    </div>
  )
}
