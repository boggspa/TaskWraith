import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import {
  createEmptyEnsembleRosterPreset,
  deleteEnsembleRosterPreset,
  duplicateEnsembleRosterPreset,
  listEnsembleRosterPresets,
  renameEnsembleRosterPreset,
  subscribeEnsembleRosterPresets,
  type EnsembleRosterPreset
} from '../lib/ensembleRosterPresets'
import { getProviderLabel } from '../lib/providerLabels'

function uniqueNewName(existing: EnsembleRosterPreset[]): string {
  const base = 'New roster'
  const names = new Set(existing.map((preset) => preset.name))
  if (!names.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}`
    if (!names.has(candidate)) return candidate
  }
  return `${base} ${Date.now()}`
}

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  } catch {
    return ''
  }
}

/**
 * Settings → Roster. The expansive home for ensemble roster presets: create /
 * duplicate / rename / delete on the left, and (from slice 3) a per-participant
 * editor on the right. The composer's compact `EnsembleRosterPresetPicker`
 * stays unchanged; both read the same renderer-local store and stay in sync via
 * `subscribeEnsembleRosterPresets`.
 */
export function RosterSettingsPanel(): JSX.Element {
  const [presets, setPresets] = useState<EnsembleRosterPreset[]>(() =>
    listEnsembleRosterPresets()
  )
  const [selectedId, setSelectedId] = useState<string | null>(
    () => listEnsembleRosterPresets()[0]?.id ?? null
  )
  const [nameDraft, setNameDraft] = useState('')
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  // Live refresh from this window's writes + other windows' storage events.
  // Read-only: re-read the list; the selection is by id, so it follows.
  useEffect(() => {
    const refresh = (): void => setPresets(listEnsembleRosterPresets())
    return subscribeEnsembleRosterPresets(refresh)
  }, [])

  const selected = useMemo(
    () => presets.find((preset) => preset.id === selectedId) ?? null,
    [presets, selectedId]
  )

  // Keep a valid selection when the list changes (delete in another window, etc).
  useEffect(() => {
    if (selectedId && presets.some((preset) => preset.id === selectedId)) return
    setSelectedId(presets[0]?.id ?? null)
  }, [presets, selectedId])

  // Sync the editable name field whenever the selected preset changes.
  useEffect(() => {
    setNameDraft(selected?.name ?? '')
  }, [selected?.id, selected?.name])

  const handleCreate = useCallback((): void => {
    const created = createEmptyEnsembleRosterPreset(uniqueNewName(listEnsembleRosterPresets()))
    setPresets(listEnsembleRosterPresets())
    setSelectedId(created.id)
    // Focus the name field so the fresh preset can be renamed immediately.
    requestAnimationFrame(() => nameInputRef.current?.select())
  }, [])

  const handleDuplicate = useCallback((): void => {
    if (!selectedId) return
    const copy = duplicateEnsembleRosterPreset(selectedId)
    setPresets(listEnsembleRosterPresets())
    if (copy) setSelectedId(copy.id)
  }, [selectedId])

  const handleDelete = useCallback(
    (preset: EnsembleRosterPreset): void => {
      const ok = window.confirm(`Delete the "${preset.name}" roster preset? This can't be undone.`)
      if (!ok) return
      deleteEnsembleRosterPreset(preset.id)
      setPresets(listEnsembleRosterPresets())
    },
    []
  )

  const commitName = useCallback((): void => {
    if (!selected) return
    const trimmed = nameDraft.trim()
    if (!trimmed || trimmed === selected.name) {
      setNameDraft(selected.name)
      return
    }
    renameEnsembleRosterPreset(selected.id, trimmed)
    setPresets(listEnsembleRosterPresets())
  }, [selected, nameDraft])

  return (
    <div className="settings-roster">
      <div className="settings-roster-header">
        <div className="settings-roster-header-copy">
          <h3 className="settings-roster-title">Roster presets</h3>
          <p className="settings-roster-intro">
            Build and refine reusable ensemble line-ups. Each preset is a saved roster of
            participants — provider, model, reasoning, permissions, role and brief — that you can
            apply to any ensemble chat. The composer keeps its compact editor; this is the roomy one.
          </p>
        </div>
      </div>

      <div className="settings-roster-body">
        {/* Left: preset list ------------------------------------------------ */}
        <div className="settings-roster-list-pane">
          <div className="settings-roster-list-head">
            <span className="settings-roster-list-label">
              {presets.length} preset{presets.length === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              className="settings-roster-new"
              onClick={handleCreate}
              title="Create a new roster preset"
            >
              + New
            </button>
          </div>

          {presets.length === 0 ? (
            <div className="settings-roster-list-empty">No presets yet.</div>
          ) : (
            <ul className="settings-roster-list">
              {presets.map((preset) => (
                <li key={preset.id}>
                  <button
                    type="button"
                    className={`settings-roster-list-row${
                      preset.id === selectedId ? ' is-active' : ''
                    }`}
                    onClick={() => setSelectedId(preset.id)}
                  >
                    <span className="settings-roster-list-row-name">{preset.name}</span>
                    <span className="settings-roster-list-row-count">
                      {preset.participants.length}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Right: selected-preset detail ----------------------------------- */}
        <div className="settings-roster-detail-pane">
          {!selected ? (
            <div className="settings-roster-detail-empty">
              <p>Select a preset to configure it, or create a new one.</p>
              <button type="button" className="settings-roster-new" onClick={handleCreate}>
                + New roster preset
              </button>
            </div>
          ) : (
            <>
              <div className="settings-roster-detail-head">
                <input
                  ref={nameInputRef}
                  className="settings-roster-name-input"
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onBlur={commitName}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.currentTarget.blur()
                    } else if (event.key === 'Escape') {
                      setNameDraft(selected.name)
                      event.currentTarget.blur()
                    }
                  }}
                  aria-label="Preset name"
                  spellCheck={false}
                />
                <div className="settings-roster-detail-actions">
                  <button type="button" className="settings-roster-action" onClick={handleDuplicate}>
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="settings-roster-action is-danger"
                    onClick={() => handleDelete(selected)}
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="settings-roster-detail-meta">
                <span>
                  {selected.participants.length} participant
                  {selected.participants.length === 1 ? '' : 's'}
                </span>
                <span className="settings-roster-meta-dot" aria-hidden>
                  ·
                </span>
                <span>
                  {selected.orchestrationMode === 'continuous' ? 'Continuous' : 'Turn-based'}
                </span>
                <span className="settings-roster-meta-dot" aria-hidden>
                  ·
                </span>
                <span>Updated {formatTimestamp(selected.updatedAt)}</span>
              </div>

              {/* Slice 3 replaces this read-only summary with the editable
                  participant rows (identity / order / lifecycle) and slice 4
                  adds the per-participant config pickers. */}
              <ul className="settings-roster-summary">
                {[...selected.participants]
                  .sort((a, b) => a.order - b.order)
                  .map((participant, index) => (
                    <li
                      key={index}
                      className={`settings-roster-summary-row${
                        participant.enabled ? '' : ' is-disabled'
                      }`}
                    >
                      <span className="settings-roster-summary-order">{index + 1}</span>
                      <span className="settings-roster-summary-provider">
                        {getProviderLabel(participant.provider)}
                      </span>
                      <span className="settings-roster-summary-role">
                        {participant.role || 'Untitled'}
                      </span>
                      {!participant.enabled && (
                        <span className="settings-roster-summary-off">disabled</span>
                      )}
                    </li>
                  ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
