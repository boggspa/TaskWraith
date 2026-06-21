import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AgenticServicesSettings,
  ComposerStyle,
  EnsembleParticipant,
  PermissionPresetId,
  ProviderId
} from '../../../main/store/types'
import { isRetiredProvider } from '../../../shared/retiredProviders'
import {
  clonePermissionOverrides,
  createEmptyEnsembleRosterPreset,
  defaultParticipantForProvider,
  deleteEnsembleRosterPreset,
  duplicateEnsembleRosterPreset,
  getEnsembleRosterPreset,
  listEnsembleRosterPresets,
  materializeParticipantsFromPreset,
  snapshotParticipantsForPreset,
  subscribeEnsembleRosterPresets,
  upsertEnsembleRosterPreset,
  MAX_ROSTER_PRESET_PARTICIPANTS,
  MIN_ROSTER_PRESET_PARTICIPANTS,
  type EnsembleRosterPreset
} from '../lib/ensembleRosterPresets'
import {
  buildProviderChangeParticipantPatch,
  getEnsembleModelDefaults,
  resolveEnsembleParticipantSettings
} from '../lib/ensembleProviderDefaults'
import {
  buildParticipantToolGrantPatch,
  getParticipantToolGrantIds
} from '../lib/ensembleParticipantToolGrants'
import { WORKSPACE_POLICY_SERVICES } from '../lib/workspacePolicyServices'
import {
  ENSEMBLE_ROLE_PRESETS,
  resolveRolePresetId,
  roleLabelForPresetId
} from '../lib/ensembleRolePresets'
import { getProviderLabel } from '../lib/providerLabels'
import { CombinedModelPicker, type CombinedModelPickerModelOption } from './CombinedModelPicker'
import { CombinedPermissionsPicker, type PermissionOption } from './CombinedPermissionsPicker'
import { ComposerProviderPicker } from './ComposerProviderPicker'
import { ProviderBadgeIcon } from './Sidebar'

/** The right-pane working copy: preset metadata + a live participant list
 * (materialized once on selection so the rows carry stable ids for React keys
 * and feed the per-participant pickers). Persisted back as snapshots on
 * change. */
type RosterEditing = {
  meta: Omit<EnsembleRosterPreset, 'participants'>
  participants: EnsembleParticipant[]
}

interface RosterSettingsPanelProps {
  composerStyle?: ComposerStyle
  agenticServices?: AgenticServicesSettings
  grokAvailable?: boolean
  cursorAvailable?: boolean
}

// Lossless permission options: the values ARE the PermissionPresetId, so
// full_access + custom survive a round-trip (unlike the composer's 3-mode
// collapse, which is fine for ephemeral live edits but not persisted data).
const PERMISSION_PRESET_OPTIONS: PermissionOption[] = [
  { value: 'read_only', label: 'Plan / Read-only' },
  { value: 'default', label: 'Default approval' },
  { value: 'workspace_write', label: 'Full workspace access' },
  { value: 'full_access', label: 'Full access' }
]

function uniqueNewName(existing: EnsembleRosterPreset[]): string {
  const base = 'New roster'
  const names = new Set(existing.map((preset) => preset.name))
  if (!names.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}`
    if (!names.has(candidate)) return candidate
  }
  return `${base} ${names.size + 1}`
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

function freshWorkingId(existing: EnsembleParticipant[]): string {
  const ids = new Set(existing.map((participant) => participant.id))
  let candidate = `ensemble-participant-${existing.length + 1}`
  while (ids.has(candidate)) {
    candidate = `ensemble-participant-${Math.random().toString(36).slice(2, 9)}`
  }
  return candidate
}

// ── Per-participant row ─────────────────────────────────────────────────────
interface RosterParticipantRowProps {
  participant: EnsembleParticipant
  index: number
  total: number
  canRemove: boolean
  composerStyle: ComposerStyle
  agenticServices?: AgenticServicesSettings
  grokAvailable: boolean
  cursorAvailable: boolean
  showApplyToAll: boolean
  onMove: (id: string, direction: -1 | 1) => void
  onRemove: (id: string) => void
  onPatch: (id: string, patch: Partial<EnsembleParticipant>, persist?: boolean) => void
  onFlush: () => void
  onApplyPermissionsToAll: (source: EnsembleParticipant) => void
}

function RosterParticipantRow({
  participant,
  index,
  total,
  canRemove,
  composerStyle,
  agenticServices,
  grokAvailable,
  cursorAvailable,
  showApplyToAll,
  onMove,
  onRemove,
  onPatch,
  onFlush,
  onApplyPermissionsToAll
}: RosterParticipantRowProps): JSX.Element {
  const retired = isRetiredProvider(participant.provider)
  const rolePresetId = resolveRolePresetId(participant.role)

  const rail = (
    <div className="settings-roster-participant-rail">
      <button
        type="button"
        className="settings-roster-chevron"
        onClick={() => onMove(participant.id, -1)}
        disabled={index === 0}
        aria-label="Move up"
        title="Move up"
      >
        ▲
      </button>
      <span className="settings-roster-participant-order">{index + 1}</span>
      <button
        type="button"
        className="settings-roster-chevron"
        onClick={() => onMove(participant.id, 1)}
        disabled={index === total - 1}
        aria-label="Move down"
        title="Move down"
      >
        ▼
      </button>
    </div>
  )

  if (retired) {
    return (
      <li className="settings-roster-participant is-retired">
        {rail}
        <div className="settings-roster-participant-body">
          <div className="settings-roster-participant-top">
            <span className="settings-roster-participant-provider">
              {getProviderLabel(participant.provider)}
            </span>
            <span
              className="settings-roster-retired-badge"
              title="This provider is retired. Remove this participant to replace it."
            >
              retired
            </span>
            <button
              type="button"
              className="settings-roster-remove"
              onClick={() => onRemove(participant.id)}
              disabled={!canRemove}
              title={canRemove ? 'Remove participant' : `Keep at least ${MIN_ROSTER_PRESET_PARTICIPANTS}`}
              aria-label="Remove participant"
              style={{ marginLeft: 'auto' }}
            >
              ✕
            </button>
          </div>
          <p className="settings-roster-retired-note">
            {participant.role || 'Untitled'} — retired providers can&apos;t run. Remove this row to
            replace it with a live provider.
          </p>
        </div>
      </li>
    )
  }

  const resolved = resolveEnsembleParticipantSettings(participant)
  const defaults = getEnsembleModelDefaults(participant.provider)

  const modelOptions: CombinedModelPickerModelOption[] = defaults.modelOptions
  // Display the participant's model, mapping the agnostic 'cli-default' seed to
  // the provider's preferred id so the chip reads cleanly. The stored value is
  // untouched until the user actually picks a model.
  const selectedModelId =
    participant.model && participant.model !== 'cli-default'
      ? participant.model
      : defaults.defaultModelId

  const onSelectModel = (nextModel: string): void => {
    const patch: Partial<EnsembleParticipant> = { model: nextModel }
    // Drop fast mode when the new model can't support it (mirrors composer).
    if (
      (participant.provider === 'codex' || participant.provider === 'claude') &&
      !defaults.fastModeCapableModelIds.has(nextModel)
    ) {
      patch.fastModeEnabled = false
      if (participant.provider === 'codex') patch.serviceTier = ''
    }
    onPatch(participant.id, patch)
  }

  const selectedReasoning =
    participant.provider === 'kimi'
      ? resolved.thinkingEnabled
        ? 'on'
        : 'off'
      : resolved.reasoningEffort
  const onSelectReasoning = (value: string): void => {
    if (participant.provider === 'kimi') {
      onPatch(participant.id, { thinkingEnabled: value !== 'off' })
    } else {
      onPatch(participant.id, { reasoningEffort: value })
    }
  }

  const fastModeEnabled =
    participant.provider === 'codex'
      ? resolved.serviceTier === 'fast'
      : participant.provider === 'claude'
        ? resolved.fastModeEnabled
        : false
  const onToggleFastMode =
    participant.provider === 'codex'
      ? (): void => {
          const nextTier = resolved.serviceTier === 'fast' ? '' : 'fast'
          onPatch(participant.id, { serviceTier: nextTier, fastModeEnabled: nextTier === 'fast' })
        }
      : participant.provider === 'claude'
        ? (): void => onPatch(participant.id, { fastModeEnabled: !resolved.fastModeEnabled })
        : undefined

  const permissionOptions: PermissionOption[] = [
    ...PERMISSION_PRESET_OPTIONS,
    ...(resolved.permissionPresetId === 'custom' ? [{ value: 'custom', label: 'Custom' }] : [])
  ]
  const enabledGrantIds = getParticipantToolGrantIds(participant)

  return (
    <li className={`settings-roster-participant${participant.enabled ? '' : ' is-disabled'}`}>
      {rail}
      <div className="settings-roster-participant-body">
        <div className="settings-roster-participant-top">
          <ComposerProviderPicker
            provider={participant.provider}
            composerStyle={composerStyle}
            grokAvailable={grokAvailable}
            cursorAvailable={cursorAvailable}
            onSelect={(next: ProviderId) =>
              onPatch(participant.id, buildProviderChangeParticipantPatch(next))
            }
            triggerIcon={<ProviderBadgeIcon provider={participant.provider} />}
            title="Participant provider"
            repositionOnScroll
          />
          <CombinedModelPicker
            provider={participant.provider}
            composerStyle={composerStyle}
            modelOptions={modelOptions}
            selectedModelId={selectedModelId}
            onSelectModel={onSelectModel}
            reasoningOptions={defaults.reasoningOptions}
            selectedReasoning={selectedReasoning}
            onSelectReasoning={onSelectReasoning}
            codexReasoningEffort={
              participant.provider === 'codex' ? resolved.reasoningEffort : undefined
            }
            claudeReasoningEffort={
              participant.provider === 'claude' ? resolved.reasoningEffort : undefined
            }
            kimiThinkingEnabled={
              participant.provider === 'kimi' ? resolved.thinkingEnabled : undefined
            }
            fastModeCapableModelIds={defaults.fastModeCapableModelIds}
            fastModeEnabled={fastModeEnabled}
            onToggleFastMode={onToggleFastMode}
            repositionOnScroll
          />
          <CombinedPermissionsPicker
            provider={participant.provider}
            composerStyle={composerStyle}
            permissionOptions={permissionOptions}
            selectedPermission={resolved.permissionPresetId}
            onSelectPermission={(value) =>
              onPatch(participant.id, { permissionPresetId: value as PermissionPresetId })
            }
            grantServices={WORKSPACE_POLICY_SERVICES}
            enabledGrantIds={enabledGrantIds}
            agenticServices={agenticServices as AgenticServicesSettings}
            onToggleGrant={(service, enabled) =>
              onPatch(participant.id, buildParticipantToolGrantPatch(participant, service, enabled))
            }
            grantScopeLabel="participant"
            onApplyToAllParticipants={
              showApplyToAll ? () => onApplyPermissionsToAll(participant) : undefined
            }
            repositionOnScroll
          />
          <label className="settings-roster-enable">
            <input
              type="checkbox"
              checked={participant.enabled}
              onChange={(event) => onPatch(participant.id, { enabled: event.target.checked })}
            />
            <span>Enabled</span>
          </label>
          <button
            type="button"
            className="settings-roster-remove"
            onClick={() => onRemove(participant.id)}
            disabled={!canRemove}
            title={canRemove ? 'Remove participant' : `Keep at least ${MIN_ROSTER_PRESET_PARTICIPANTS}`}
            aria-label="Remove participant"
          >
            ✕
          </button>
        </div>

        <div className="settings-roster-field settings-roster-field-role">
          <span className="settings-roster-field-label">Role / nickname</span>
          <div className="settings-roster-role-controls">
            <input
              type="text"
              className="settings-roster-input"
              value={participant.role}
              placeholder="Role / nickname"
              onChange={(event) => onPatch(participant.id, { role: event.target.value }, false)}
              onBlur={onFlush}
            />
            <select
              className="settings-roster-select settings-roster-role-preset"
              value={rolePresetId === 'custom' ? '' : rolePresetId}
              aria-label="Fill role from a preset"
              onChange={(event) => {
                const label = roleLabelForPresetId(event.target.value)
                if (label) onPatch(participant.id, { role: label })
              }}
            >
              <option value="">Preset…</option>
              {ENSEMBLE_ROLE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id} title={preset.description}>
                  {preset.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="settings-roster-field">
          <span className="settings-roster-field-label">Brief / goal</span>
          <textarea
            className="settings-roster-textarea"
            rows={2}
            value={participant.instructions}
            placeholder="What should this participant focus on each turn?"
            onChange={(event) =>
              onPatch(participant.id, { instructions: event.target.value }, false)
            }
            onBlur={onFlush}
          />
        </div>
      </div>
    </li>
  )
}

/**
 * Settings → Roster. The expansive home for ensemble roster presets: create /
 * duplicate / rename / delete on the left, and a per-participant editor on the
 * right. The composer's compact `EnsembleRosterPresetPicker` stays unchanged;
 * both read the same renderer-local store and stay in sync via
 * `subscribeEnsembleRosterPresets`.
 */
export function RosterSettingsPanel({
  composerStyle = 'default',
  agenticServices,
  grokAvailable = false,
  cursorAvailable = false
}: RosterSettingsPanelProps): JSX.Element {
  const [presets, setPresets] = useState<EnsembleRosterPreset[]>(() => listEnsembleRosterPresets())
  const [selectedId, setSelectedId] = useState<string | null>(
    () => listEnsembleRosterPresets()[0]?.id ?? null
  )
  const [editing, setEditing] = useState<RosterEditing | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  // Always-latest editing snapshot for the flush-on-switch safety net below.
  const editingRef = useRef<RosterEditing | null>(null)
  editingRef.current = editing

  const writePreset = useCallback((next: RosterEditing): void => {
    try {
      upsertEnsembleRosterPreset({
        ...next.meta,
        participants: snapshotParticipantsForPreset(next.participants)
      })
    } catch {
      // floor/name guards keep this valid; defensive
    }
  }, [])

  const commit = useCallback(
    (next: RosterEditing): void => {
      const stamped: RosterEditing = { ...next, meta: { ...next.meta, updatedAt: Date.now() } }
      setEditing(stamped)
      writePreset(stamped)
    },
    [writePreset]
  )

  // Live refresh of the LIST only — never re-materializes the open editor.
  useEffect(() => {
    const refresh = (): void => setPresets(listEnsembleRosterPresets())
    return subscribeEnsembleRosterPresets(refresh)
  }, [])

  useEffect(() => {
    if (selectedId && presets.some((preset) => preset.id === selectedId)) return
    setSelectedId(presets[0]?.id ?? null)
  }, [presets, selectedId])

  // Materialize the selected preset into the working copy ONCE per selection;
  // flush unblurred text edits of the outgoing preset on switch.
  useEffect(() => {
    if (!selectedId) {
      setEditing(null)
      return
    }
    const preset = getEnsembleRosterPreset(selectedId)
    if (!preset) {
      setEditing(null)
      return
    }
    const { participants, ...meta } = preset
    setEditing({ meta, participants: materializeParticipantsFromPreset(participants) })
    setNameDraft(meta.name)
    return () => {
      const pending = editingRef.current
      if (pending && pending.meta.id === preset.id) writePreset(pending)
    }
  }, [selectedId, writePreset])

  const selected = useMemo(
    () => presets.find((preset) => preset.id === selectedId) ?? null,
    [presets, selectedId]
  )

  const handleCreate = useCallback((): void => {
    const created = createEmptyEnsembleRosterPreset(uniqueNewName(listEnsembleRosterPresets()))
    setPresets(listEnsembleRosterPresets())
    setSelectedId(created.id)
    requestAnimationFrame(() => nameInputRef.current?.select())
  }, [])

  const handleDuplicate = useCallback((): void => {
    if (!selectedId) return
    const copy = duplicateEnsembleRosterPreset(selectedId)
    setPresets(listEnsembleRosterPresets())
    if (copy) setSelectedId(copy.id)
  }, [selectedId])

  const handleDelete = useCallback((preset: EnsembleRosterPreset): void => {
    const ok = window.confirm(`Delete the "${preset.name}" roster preset? This can't be undone.`)
    if (!ok) return
    deleteEnsembleRosterPreset(preset.id)
    setPresets(listEnsembleRosterPresets())
  }, [])

  const commitName = useCallback((): void => {
    if (!editing) return
    const trimmed = nameDraft.trim()
    if (!trimmed || trimmed === editing.meta.name) {
      setNameDraft(editing.meta.name)
      return
    }
    commit({ ...editing, meta: { ...editing.meta, name: trimmed } })
  }, [editing, nameDraft, commit])

  // ── participant mutators (read latest via editingRef to avoid stale closures)
  const patchParticipant = useCallback(
    (id: string, patch: Partial<EnsembleParticipant>, doPersist = true): void => {
      const current = editingRef.current
      if (!current) return
      const participants = current.participants.map((participant) =>
        participant.id === id ? { ...participant, ...patch } : participant
      )
      const next = { ...current, participants }
      if (doPersist) commit(next)
      else setEditing(next)
    },
    [commit]
  )

  const flushText = useCallback((): void => {
    if (editingRef.current) commit(editingRef.current)
  }, [commit])

  const moveParticipant = useCallback(
    (id: string, direction: -1 | 1): void => {
      const current = editingRef.current
      if (!current) return
      const ordered = [...current.participants].sort((a, b) => a.order - b.order)
      const idx = ordered.findIndex((participant) => participant.id === id)
      const target = idx + direction
      if (idx < 0 || target < 0 || target >= ordered.length) return
      ;[ordered[idx], ordered[target]] = [ordered[target], ordered[idx]]
      commit({
        ...current,
        participants: ordered.map((participant, i) => ({ ...participant, order: i + 1 }))
      })
    },
    [commit]
  )

  const addParticipant = useCallback((): void => {
    const current = editingRef.current
    if (!current || current.participants.length >= MAX_ROSTER_PRESET_PARTICIPANTS) return
    const id = freshWorkingId(current.participants)
    const participant = defaultParticipantForProvider('claude', id, current.participants.length + 1)
    commit({ ...current, participants: [...current.participants, participant] })
  }, [commit])

  const removeParticipant = useCallback(
    (id: string): void => {
      const current = editingRef.current
      if (!current || current.participants.length <= MIN_ROSTER_PRESET_PARTICIPANTS) return
      const participants = current.participants
        .filter((participant) => participant.id !== id)
        .map((participant, i) => ({ ...participant, order: i + 1 }))
      commit({ ...current, participants })
    },
    [commit]
  )

  const applyPermissionsToAll = useCallback(
    (source: EnsembleParticipant): void => {
      const current = editingRef.current
      if (!current) return
      const participants = current.participants.map((participant) =>
        // Don't mutate retired participants; otherwise mirror the source's
        // permission preset + grants (deep-cloned so nothing aliases).
        isRetiredProvider(participant.provider)
          ? participant
          : {
              ...participant,
              permissionPresetId: source.permissionPresetId,
              permissionOverrides: clonePermissionOverrides(source.permissionOverrides)
            }
      )
      commit({ ...current, participants })
    },
    [commit]
  )

  const orderedParticipants = useMemo(
    () => (editing ? [...editing.participants].sort((a, b) => a.order - b.order) : []),
    [editing]
  )
  const canRemove = orderedParticipants.length > MIN_ROSTER_PRESET_PARTICIPANTS

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

        {/* Right: selected-preset editor ----------------------------------- */}
        <div className="settings-roster-detail-pane">
          {!editing ? (
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
                      setNameDraft(editing.meta.name)
                      event.currentTarget.blur()
                    }
                  }}
                  aria-label="Preset name"
                  spellCheck={false}
                />
                <div className="settings-roster-detail-actions">
                  {selected && (
                    <button
                      type="button"
                      className="settings-roster-action"
                      onClick={handleDuplicate}
                    >
                      Duplicate
                    </button>
                  )}
                  {selected && (
                    <button
                      type="button"
                      className="settings-roster-action is-danger"
                      onClick={() => handleDelete(selected)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              <div className="settings-roster-detail-meta">
                <span>
                  {editing.participants.length} participant
                  {editing.participants.length === 1 ? '' : 's'}
                </span>
                <span className="settings-roster-meta-dot" aria-hidden>
                  ·
                </span>
                <span>
                  {editing.meta.orchestrationMode === 'continuous' ? 'Continuous' : 'Turn-based'}
                </span>
                <span className="settings-roster-meta-dot" aria-hidden>
                  ·
                </span>
                <span>Updated {formatTimestamp(editing.meta.updatedAt)}</span>
              </div>

              <ul className="settings-roster-participants">
                {orderedParticipants.map((participant, index) => (
                  <RosterParticipantRow
                    key={participant.id}
                    participant={participant}
                    index={index}
                    total={orderedParticipants.length}
                    canRemove={canRemove}
                    composerStyle={composerStyle}
                    agenticServices={agenticServices}
                    grokAvailable={grokAvailable}
                    cursorAvailable={cursorAvailable}
                    showApplyToAll={orderedParticipants.length > 1}
                    onMove={moveParticipant}
                    onRemove={removeParticipant}
                    onPatch={patchParticipant}
                    onFlush={flushText}
                    onApplyPermissionsToAll={applyPermissionsToAll}
                  />
                ))}
              </ul>

              <div className="settings-roster-add-row">
                <button
                  type="button"
                  className="settings-roster-add"
                  onClick={addParticipant}
                  disabled={editing.participants.length >= MAX_ROSTER_PRESET_PARTICIPANTS}
                  title={
                    editing.participants.length >= MAX_ROSTER_PRESET_PARTICIPANTS
                      ? `Up to ${MAX_ROSTER_PRESET_PARTICIPANTS} participants`
                      : 'Add a participant'
                  }
                >
                  + Add participant
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
