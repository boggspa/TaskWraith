import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { PillButton } from './PillButton'

/**
 * RemoteWorkspacesPanel — Phase C4 admin UI for the iOS remote allowlist.
 *
 * Lives inside Settings (under the "Remote Workspaces" tab) and lets the
 * desktop user explicitly opt workspaces in to iOS-side access. Without
 * an entry, every iOS-initiated turn against that workspace is denied
 * by `BridgeActionRouter`.
 *
 * Self-contained: pulls state via the preload bindings (`api.bridgeAllowlist*`)
 * so no parent prop threading. Refetches the full list after any
 * mutation — the list is small (typically < 20 entries), so the cost
 * is negligible and the code stays trivially correct.
 *
 * UX shape:
 *   - List of current entries with mode/capabilities/expiry inline
 *   - One-form "Add entry" inline at the top: a PICKER over the user's
 *     actual registered workspaces (id + path filled from the selection —
 *     free-text ids matched nothing because visibility keys on the store's
 *     workspace uuid) + mode/capability controls
 *   - Per-row "Remove" action
 *   - "Clear all" footer action with confirm
 *
 * Future polish (deferred):
 *   - Expiry as a date picker, not raw ms
 *   - Per-row inline edit
 */

interface RemoteWorkspaceEntry {
  workspaceId: string
  path: string
  mode: 'read-only' | 'read-write'
  capabilities?: RemoteWorkspaceCapability[]
  expiresAt?: number
  createdAt: number
  updatedAt: number
}

type RemoteWorkspaceCapability =
  | 'monitor'
  | 'approve'
  | 'answer'
  | 'cancel'
  | 'startTurn'
  | 'diffReview'
  | 'steer'
  | 'fileBrowse'
  | 'fileRead'
  | 'fileWrite'
  | 'externalPublish'
  | 'pin'
  | 'yolo'

const LEGACY_READ_WRITE_CAPABILITIES: RemoteWorkspaceCapability[] = [
  'monitor',
  'approve',
  'answer',
  'cancel',
  'startTurn',
  'diffReview',
  'steer'
]
const READ_ONLY_CAPABILITIES: RemoteWorkspaceCapability[] = ['monitor', 'approve']
const FILE_CAPABILITIES: RemoteWorkspaceCapability[] = ['fileBrowse', 'fileRead', 'fileWrite']
const READ_WRITE_CAPABILITIES: RemoteWorkspaceCapability[] = [
  ...LEGACY_READ_WRITE_CAPABILITIES,
  ...FILE_CAPABILITIES
]
const EXTERNAL_PUBLISH_CAPABILITY: RemoteWorkspaceCapability = 'externalPublish'

export function RemoteWorkspacesPanel(): ReactElement {
  const [entries, setEntries] = useState<RemoteWorkspaceEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      const result = (await window.api.bridgeAllowlistList()) as RemoteWorkspaceEntry[]
      setEntries(result ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  return (
    <section className="settings-group remote-workspaces-panel">
      <header className="remote-workspaces-header">
        <div>
          <label className="settings-label remote-workspaces-title">
            iOS Remote Workspace Allowlist
          </label>
          <p className="remote-workspaces-kicker">Paired-device access control</p>
        </div>
        <span className="remote-workspaces-count">{entries.length} allowed</span>
      </header>
      <div className="settings-hint remote-workspaces-hint">
        Workspaces a paired iOS device may use. A grant applies to every provider currently
        admitted by this Mac; each thread&apos;s permission preset remains separate. Empty list denies
        workspace access. Removing an entry takes effect on the next iOS request.
      </div>

      {error && <div className="settings-error remote-workspaces-error">{error}</div>}

      <AddEntryForm
        onAdded={async () => {
          await refresh()
        }}
      />

      <div className="remote-workspaces-list-section">
        {loading ? (
          <div className="settings-hint remote-workspaces-empty">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="settings-hint remote-workspaces-empty">
            <strong>No remote workspaces yet</strong>
            <span>Add a workspace to let a paired iPhone start runs against it.</span>
          </div>
        ) : (
          <ul className="remote-workspaces-entry-list">
            {entries.map((entry) => (
              <EntryRow
                key={entry.workspaceId}
                entry={entry}
                onEnableFiles={async () => {
                  await window.api.bridgeAllowlistUpsert({
                    workspaceId: entry.workspaceId,
                    path: entry.path,
                    mode: entry.mode,
                    capabilities: withFileEditingCapabilities(entry),
                    expiresAt: entry.expiresAt
                  })
                  await refresh()
                }}
                onTogglePublish={async () => {
                  await window.api.bridgeAllowlistUpsert({
                    workspaceId: entry.workspaceId,
                    path: entry.path,
                    mode: entry.mode,
                    capabilities: entryCanPublishExternally(entry)
                      ? withoutExternalPublishCapability(entry)
                      : withExternalPublishCapability(entry),
                    expiresAt: entry.expiresAt
                  })
                  await refresh()
                }}
                onRemove={async () => {
                  await window.api.bridgeAllowlistRemove(entry.workspaceId)
                  await refresh()
                }}
              />
            ))}
          </ul>
        )}
      </div>

      {entries.length > 0 && (
        <div className="remote-workspaces-footer">
          <PillButton
            size="compact"
            className="remote-workspaces-clear"
            onClick={async () => {
              if (!confirm('Remove all remote workspace allowlist entries?')) return
              await window.api.bridgeAllowlistClear()
              await refresh()
            }}
          >
            Clear all entries
          </PillButton>
        </div>
      )}
    </section>
  )
}

function EntryRow({
  entry,
  onEnableFiles,
  onTogglePublish,
  onRemove
}: {
  entry: RemoteWorkspaceEntry
  onEnableFiles: () => void | Promise<void>
  onTogglePublish: () => void | Promise<void>
  onRemove: () => void | Promise<void>
}): ReactElement {
  const expiresLabel =
    entry.expiresAt !== undefined ? new Date(entry.expiresAt).toLocaleString() : '—'
  const filesEnabled = workspaceEntryCanEditFiles(entry)
  const publishEnabled = entryCanPublishExternally(entry)
  const canEnableFiles = entry.mode === 'read-write' && !filesEnabled

  return (
    <li className="remote-workspaces-entry-card">
      <div className="remote-workspaces-entry-layout">
        <div className="remote-workspaces-entry-main">
          <div className="remote-workspaces-entry-heading">
            <span className="remote-workspaces-entry-id">{entry.workspaceId}</span>
            <span
              className={`remote-workspaces-chip remote-workspaces-mode-chip ${entry.mode === 'read-write' ? 'is-write' : ''}`}
            >
              {entry.mode === 'read-write' ? 'Read-write' : 'Read-only'}
            </span>
            <span
              className={`remote-workspaces-chip remote-workspaces-files-chip ${filesEnabled ? 'is-enabled' : 'is-off'}`}
            >
              {filesEnabled ? 'Files enabled' : 'Files off'}
            </span>
            <span
              className={`remote-workspaces-chip remote-workspaces-publish-chip ${publishEnabled ? 'is-enabled' : 'is-off'}`}
            >
              {publishEnabled ? 'Publish enabled' : 'Publish off'}
            </span>
          </div>
          <div className="remote-workspaces-path">{entry.path}</div>
          <div className="remote-workspaces-meta">
            <div className="remote-workspaces-meta-group">
              <span className="remote-workspaces-meta-label">Providers</span>
              <span className="remote-workspaces-chip">All admitted providers</span>
            </div>
            <div className="remote-workspaces-meta-group">
              <span className="remote-workspaces-meta-label">Expires</span>
              <span className="remote-workspaces-chip">{expiresLabel}</span>
            </div>
          </div>
        </div>
        <div className="remote-workspaces-entry-actions">
          {canEnableFiles ? (
            <PillButton
              size="compact"
              className="remote-workspaces-enable-files"
              onClick={() => void onEnableFiles()}
              title="Explicitly grant browse, read, and write access for iOS Files mode."
            >
              Enable files
            </PillButton>
          ) : null}
          <PillButton
            size="compact"
            className={`remote-workspaces-toggle-publish ${publishEnabled ? 'is-enabled' : ''}`}
            onClick={() => void onTogglePublish()}
            title={
              publishEnabled
                ? 'Remove paired-device permission for git push and GitHub PR creation.'
                : 'Grant paired-device permission for git push and GitHub PR creation.'
            }
          >
            {publishEnabled ? 'Disable publish' : 'Enable publish'}
          </PillButton>
          <PillButton
            size="compact"
            className="remote-workspaces-remove"
            onClick={() => void onRemove()}
          >
            Remove
          </PillButton>
        </div>
      </div>
    </li>
  )
}

function capabilitiesForEntry(entry: RemoteWorkspaceEntry): RemoteWorkspaceCapability[] {
  if (entry.capabilities) return entry.capabilities
  return entry.mode === 'read-only' ? READ_ONLY_CAPABILITIES : LEGACY_READ_WRITE_CAPABILITIES
}

function capabilitiesForMode(
  mode: RemoteWorkspaceEntry['mode'],
  publishExternally = false
): RemoteWorkspaceCapability[] {
  const base = mode === 'read-only' ? READ_ONLY_CAPABILITIES : READ_WRITE_CAPABILITIES
  return publishExternally ? [...base, EXTERNAL_PUBLISH_CAPABILITY] : base
}

function workspaceEntryCanEditFiles(entry: RemoteWorkspaceEntry): boolean {
  const capabilities = new Set(capabilitiesForEntry(entry))
  return FILE_CAPABILITIES.every((capability) => capabilities.has(capability))
}

function entryCanPublishExternally(entry: RemoteWorkspaceEntry): boolean {
  return capabilitiesForEntry(entry).includes(EXTERNAL_PUBLISH_CAPABILITY)
}

function withFileEditingCapabilities(entry: RemoteWorkspaceEntry): RemoteWorkspaceCapability[] {
  return Array.from(new Set([...capabilitiesForEntry(entry), ...FILE_CAPABILITIES]))
}

function withExternalPublishCapability(entry: RemoteWorkspaceEntry): RemoteWorkspaceCapability[] {
  return Array.from(new Set([...capabilitiesForEntry(entry), EXTERNAL_PUBLISH_CAPABILITY]))
}

function withoutExternalPublishCapability(entry: RemoteWorkspaceEntry): RemoteWorkspaceCapability[] {
  return capabilitiesForEntry(entry).filter(
    (capability) => capability !== EXTERNAL_PUBLISH_CAPABILITY
  )
}

interface WorkspacePickerOption {
  id: string
  displayName?: string
  path: string
}

function AddEntryForm({ onAdded }: { onAdded: () => void | Promise<void> }): ReactElement {
  const [workspaceOptions, setWorkspaceOptions] = useState<WorkspacePickerOption[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [path, setPath] = useState('')
  const [mode, setMode] = useState<'read-only' | 'read-write'>('read-only')
  const [publishExternally, setPublishExternally] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    window.api
      .getWorkspaces()
      .then((list) => {
        if (active) setWorkspaceOptions(list)
      })
      .catch(() => {
        // Picker stays empty; the form's disabled state explains itself.
      })
    return () => {
      active = false
    }
  }, [])

  const selectWorkspace = (id: string): void => {
    const workspace = workspaceOptions.find((option) => option.id === id)
    setWorkspaceId(id)
    setPath(workspace?.path ?? '')
  }

  const submit = async (): Promise<void> => {
    setFormError(null)
    if (!workspaceId.trim() || !path.trim()) {
      setFormError('workspaceId and path are required')
      return
    }
    setSubmitting(true)
    try {
      await window.api.bridgeAllowlistUpsert({
        workspaceId: workspaceId.trim(),
        path: path.trim(),
        mode,
        capabilities: capabilitiesForMode(mode, publishExternally)
      })
      setWorkspaceId('')
      setPath('')
      setMode('read-only')
      setPublishExternally(false)
      await onAdded()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="remote-workspaces-form">
      <div className="remote-workspaces-form-header">
        <span>Add workspace access</span>
        <small>Path and policy are validated again before every iOS action.</small>
      </div>

      <div className="remote-workspaces-form-grid">
        <label className="remote-workspaces-field remote-workspaces-path-field">
          <span>Workspace</span>
          <select
            value={workspaceId}
            onChange={(e) => selectWorkspace(e.target.value)}
            className="settings-input remote-workspaces-input"
            disabled={submitting || workspaceOptions.length === 0}
          >
            <option value="" disabled>
              {workspaceOptions.length === 0
                ? 'No workspaces registered yet'
                : 'Select a workspace…'}
            </option>
            {workspaceOptions.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.displayName || workspace.path}
              </option>
            ))}
          </select>
          {path ? (
            <small className="remote-workspaces-path-preview">{path}</small>
          ) : null}
        </label>
      </div>

      <fieldset className="remote-workspaces-fieldset">
        <legend>Mode</legend>
        <div
          className="remote-workspaces-segmented"
          role="radiogroup"
          aria-label="Workspace access mode"
        >
          <label className={`remote-workspaces-segment ${mode === 'read-only' ? 'active' : ''}`}>
            <input
              type="radio"
              name="remote-workspace-mode"
              checked={mode === 'read-only'}
              onChange={() => setMode('read-only')}
              disabled={submitting}
            />
            <span>Read-only</span>
          </label>
          <label className={`remote-workspaces-segment ${mode === 'read-write' ? 'active' : ''}`}>
            <input
              type="radio"
              name="remote-workspace-mode"
              checked={mode === 'read-write'}
              onChange={() => setMode('read-write')}
              disabled={submitting}
            />
            <span>Read-write</span>
          </label>
        </div>
      </fieldset>

      <fieldset className="remote-workspaces-fieldset">
        <legend>External publishing</legend>
        <label
          className={`remote-workspaces-toggle-chip remote-workspaces-publish-toggle ${
            publishExternally ? 'active' : ''
          }`}
        >
          <input
            type="checkbox"
            checked={publishExternally}
            onChange={() => setPublishExternally((value) => !value)}
            disabled={submitting}
          />
          <span>Allow Git push + PR creation</span>
        </label>
        <small className="remote-workspaces-field-hint">
          Separate from file editing. Leave off unless this paired device should publish outside
          the workspace.
        </small>
      </fieldset>

      <div className="settings-hint remote-workspaces-field-hint">
        This grant follows Electron&apos;s live provider projection, including conditionally admitted
        providers such as AntiGravity after their own consent and credential gates pass. Thread
        permission presets are chosen per chat.
      </div>

      {formError && <div className="settings-error remote-workspaces-error">{formError}</div>}

      <PillButton
        variant="primary"
        size="compact"
        onClick={() => void submit()}
        disabled={submitting || !workspaceId.trim() || !path.trim()}
      >
        {submitting ? 'Adding…' : 'Add to allowlist'}
      </PillButton>
    </div>
  )
}
