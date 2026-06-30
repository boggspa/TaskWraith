import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AgenticServicesSettings,
  ComposerStyle,
  EnsembleOrchestrationMode,
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
  materializeParticipantsFromPresetWithBossman,
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
  getEnsembleReasoningOptions,
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

/** The right-pane working copy: preset metadata + a live participant list
 * (materialized once on selection so the rows carry stable ids for React keys
 * and feed the per-participant pickers). Persisted back as snapshots on
 * change. */
type RosterEditing = {
  meta: Omit<EnsembleRosterPreset, 'participants'>
  participants: EnsembleParticipant[]
  bossmanParticipantId?: string
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

/**
 * The editor's left-list order: stable creation-order (newest first) so editing
 * a preset doesn't make its row jump under the cursor. `listEnsembleRosterPresets`
 * sorts by `updatedAt` (which the composer picker wants — most-recently-used
 * first — but the editor list does not).
 */
function loadPresets(): EnsembleRosterPreset[] {
  return [...listEnsembleRosterPresets()].sort((a, b) => b.createdAt - a.createdAt)
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
  isBossman: boolean
  onMove: (id: string, direction: -1 | 1) => void
  onRemove: (id: string) => void
  onSetBossman: (id: string | undefined) => void
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
  isBossman,
  onMove,
  onRemove,
  onSetBossman,
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
  // SettingsPanel always supplies agenticServices; the empty-object fallback
  // only guards a hypothetical caller that doesn't (the grants column reads it
  // for sub-labels). Avoids a runtime crash without coupling a literal default
  // to the churning AgenticServicesSettings shape.
  const services = agenticServices ?? ({} as AgenticServicesSettings)

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
    if (participant.provider === 'claude') {
      const nextReasoningOptions = getEnsembleReasoningOptions(participant.provider, nextModel)
      const enabledReasoningOptions = nextReasoningOptions.filter((option) => !option.disabled)
      const nextReasoningValues = new Set(enabledReasoningOptions.map((option) => option.value))
      patch.reasoningEffort = nextReasoningValues.has(defaults.defaultReasoning)
        ? defaults.defaultReasoning
        : enabledReasoningOptions[0]?.value
    }
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
  const reasoningOptions = getEnsembleReasoningOptions(participant.provider, selectedModelId)
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
            activeModelId={selectedModelId}
            title="Participant provider"
            repositionOnScroll
          />
          <CombinedModelPicker
            provider={participant.provider}
            composerStyle={composerStyle}
            modelOptions={modelOptions}
            selectedModelId={selectedModelId}
            onSelectModel={onSelectModel}
            reasoningOptions={reasoningOptions}
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
            agenticServices={services}
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
            className={`settings-roster-bossman${isBossman ? ' is-active' : ''}`}
            onClick={() => onSetBossman(isBossman ? undefined : participant.id)}
            title={isBossman ? 'Clear Boss' : 'Set as Boss'}
            aria-pressed={isBossman}
          >
            Boss
          </button>
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
  const [presets, setPresets] = useState<EnsembleRosterPreset[]>(() => loadPresets())
  const [selectedId, setSelectedId] = useState<string | null>(() => loadPresets()[0]?.id ?? null)
  const [editing, setEditing] = useState<RosterEditing | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [maxDraft, setMaxDraft] = useState('')
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  // Always-latest editing snapshot for the flush-on-switch safety net below.
  // Kept in sync during render AND synchronously inside commit/patch so a
  // batched handler (or a blur→switch sequence) never reads a stale copy.
  const editingRef = useRef<RosterEditing | null>(null)
  editingRef.current = editing
  // True when there are unblurred text edits not yet persisted; the
  // switch-cleanup only flushes when this is set, avoiding double-writes.
  const dirtyRef = useRef(false)

  const writePreset = useCallback((next: RosterEditing): void => {
    try {
      upsertEnsembleRosterPreset({
        ...next.meta,
        participants: snapshotParticipantsForPreset(next.participants, next.bossmanParticipantId)
      })
    } catch {
      // floor/name guards keep this valid; defensive
    }
  }, [])

  const commit = useCallback(
    (next: RosterEditing): void => {
      const stamped: RosterEditing = { ...next, meta: { ...next.meta, updatedAt: Date.now() } }
      editingRef.current = stamped
      dirtyRef.current = false
      setEditing(stamped)
      writePreset(stamped)
    },
    [writePreset]
  )

  // Live refresh of the LIST only — never re-materializes the open editor.
  useEffect(() => {
    const refresh = (): void => setPresets(loadPresets())
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
    const materialized = materializeParticipantsFromPresetWithBossman(participants)
    const loaded: RosterEditing = {
      meta,
      participants: materialized.participants,
      bossmanParticipantId: materialized.bossmanParticipantId
    }
    editingRef.current = loaded
    dirtyRef.current = false
    setEditing(loaded)
    setNameDraft(meta.name)
    return () => {
      // Flush ONLY genuinely-unpersisted text edits, and never resurrect a
      // preset deleted while open — getEnsembleRosterPreset returning null
      // means it's gone, so skip the write (guards the delete-resurrection bug).
      const pending = editingRef.current
      if (
        dirtyRef.current &&
        pending &&
        pending.meta.id === preset.id &&
        getEnsembleRosterPreset(preset.id)
      ) {
        writePreset(pending)
      }
      dirtyRef.current = false
    }
  }, [selectedId, writePreset])

  const selected = useMemo(
    () => presets.find((preset) => preset.id === selectedId) ?? null,
    [presets, selectedId]
  )

  // Keep the Max-participants field freely typeable: sync the draft from the
  // model on preset switch + when the stored value changes (add bumps it, blur
  // clamps it), but let intermediate keystrokes stay raw until blur.
  useEffect(() => {
    if (editing) setMaxDraft(String(editing.meta.maxParticipants))
  }, [editing?.meta.id, editing?.meta.maxParticipants])

  const handleCreate = useCallback((): void => {
    const created = createEmptyEnsembleRosterPreset(uniqueNewName(loadPresets()))
    setPresets(loadPresets())
    setSelectedId(created.id)
    requestAnimationFrame(() => nameInputRef.current?.select())
  }, [])

  const handleDuplicate = useCallback((): void => {
    if (!selectedId) return
    // Flush unblurred text edits so the copy includes them (duplicate reads
    // from the persisted store).
    if (dirtyRef.current && editingRef.current) commit(editingRef.current)
    const copy = duplicateEnsembleRosterPreset(selectedId)
    setPresets(loadPresets())
    if (copy) setSelectedId(copy.id)
  }, [selectedId, commit])

  const handleDelete = useCallback((preset: EnsembleRosterPreset): void => {
    const ok = window.confirm(`Delete the "${preset.name}" roster preset? This can't be undone.`)
    if (!ok) return
    deleteEnsembleRosterPreset(preset.id)
    setPresets(loadPresets())
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
      if (doPersist) {
        commit(next)
      } else {
        editingRef.current = next
        dirtyRef.current = true
        setEditing(next)
      }
    },
    [commit]
  )

  const flushText = useCallback((): void => {
    if (dirtyRef.current && editingRef.current) commit(editingRef.current)
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
    const participants = [...current.participants, participant]
    // Keep the cap >= the roster size (mirrors applyEnsembleRosterPreset).
    const maxParticipants = Math.max(current.meta.maxParticipants, participants.length)
    commit({ ...current, meta: { ...current.meta, maxParticipants }, participants })
  }, [commit])

  const setOrchestrationMode = useCallback(
    (mode: EnsembleOrchestrationMode): void => {
      const current = editingRef.current
      if (!current) return
      commit({ ...current, meta: { ...current.meta, orchestrationMode: mode } })
    },
    [commit]
  )

  const setMaxParticipants = useCallback(
    (value: number): void => {
      const current = editingRef.current
      if (!current || !Number.isFinite(value)) return
      const floor = Math.max(MIN_ROSTER_PRESET_PARTICIPANTS, current.participants.length)
      const clamped = Math.max(floor, Math.min(MAX_ROSTER_PRESET_PARTICIPANTS, Math.round(value)))
      commit({ ...current, meta: { ...current.meta, maxParticipants: clamped } })
    },
    [commit]
  )

  const removeParticipant = useCallback(
    (id: string): void => {
      const current = editingRef.current
      if (!current || current.participants.length <= MIN_ROSTER_PRESET_PARTICIPANTS) return
      const participants = current.participants
        .filter((participant) => participant.id !== id)
        .map((participant, i) => ({ ...participant, order: i + 1 }))
      commit({
        ...current,
        participants,
        bossmanParticipantId:
          current.bossmanParticipantId === id ? undefined : current.bossmanParticipantId
      })
    },
    [commit]
  )

  const setBossmanParticipant = useCallback(
    (id: string | undefined): void => {
      const current = editingRef.current
      if (!current) return
      commit({
        ...current,
        bossmanParticipantId: id && current.participants.some((p) => p.id === id) ? id : undefined
      })
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
                <span>Updated {formatTimestamp(editing.meta.updatedAt)}</span>
              </div>

              <div className="settings-roster-options">
                <label className="settings-roster-option">
                  <span className="settings-roster-field-label">Turn order</span>
                  <select
                    className="settings-roster-select"
                    value={
                      editing.meta.orchestrationMode === 'continuous' ? 'continuous' : 'turn_bound'
                    }
                    onChange={(event) =>
                      setOrchestrationMode(event.target.value as EnsembleOrchestrationMode)
                    }
                  >
                    <option value="turn_bound">Turn-based (in order)</option>
                    <option value="continuous">Continuous (all at once)</option>
                  </select>
                </label>
                <label className="settings-roster-option">
                  <span className="settings-roster-field-label">Max participants</span>
                  <input
                    type="number"
                    className="settings-roster-input settings-roster-number"
                    min={Math.max(MIN_ROSTER_PRESET_PARTICIPANTS, editing.participants.length)}
                    max={MAX_ROSTER_PRESET_PARTICIPANTS}
                    value={maxDraft}
                    onChange={(event) => setMaxDraft(event.target.value)}
                    onBlur={() => setMaxParticipants(Number(maxDraft))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                  />
                </label>
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
                    isBossman={editing.bossmanParticipantId === participant.id}
                    onMove={moveParticipant}
                    onRemove={removeParticipant}
                    onSetBossman={setBossmanParticipant}
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
