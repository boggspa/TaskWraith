import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX
} from 'react'
import type {
  AgenticServicesSettings,
  ComposerStyle,
  EnsembleOrchestrationMode,
  EnsembleParticipant
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
  ENSEMBLE_ROLE_PRESETS,
  resolveRolePresetId,
  roleLabelForPresetId
} from '../lib/ensembleRolePresets'
import { getProviderLabel } from '../lib/providerLabels'
import { ParticipantPickerCluster } from './ParticipantPickerCluster'
import { PooledAgentIcon } from './icons/PooledAgentIcon'
import {
  applyPooledAgentToParticipant,
  createPooledAgentFromParticipant,
  hydrateParticipantsWithPooledAgentIdentity,
  listPooledAgents,
  pooledAgentIdentitySnapshot,
  pooledAgentToParticipantSnapshot,
  POOLED_AGENT_DRAG_MIME,
  ROSTER_PARTICIPANT_DRAG_MIME,
  subscribeEnsembleAgentPool,
  type PooledAgent
} from '../lib/ensembleAgentPool'

/** The right-pane working copy: preset metadata + a live participant list
 * (materialized once on selection so the rows carry stable ids for React keys
 * and feed the per-participant pickers). Persisted back as snapshots on
 * change. */
type RosterEditing = {
  meta: Omit<EnsembleRosterPreset, 'participants'>
  participants: EnsembleParticipant[]
  bossmanParticipantId?: string
  secondInCommandParticipantId?: string
}

interface RosterSettingsPanelProps {
  composerStyle?: ComposerStyle
  agenticServices?: AgenticServicesSettings
  grokAvailable?: boolean
  cursorAvailable?: boolean
}

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
  isSecondInCommand: boolean
  onMove: (id: string, direction: -1 | 1) => void
  onRemove: (id: string) => void
  onSetBossman: (id: string | undefined) => void
  onSetSecondInCommand: (id: string | undefined) => void
  onPatch: (id: string, patch: Partial<EnsembleParticipant>, persist?: boolean) => void
  onFlush: () => void
  onApplyPermissionsToAll: (source: EnsembleParticipant) => void
  onSaveToPool: (id: string) => void
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
  isSecondInCommand,
  onMove,
  onRemove,
  onSetBossman,
  onSetSecondInCommand,
  onPatch,
  onFlush,
  onApplyPermissionsToAll,
  onSaveToPool
}: RosterParticipantRowProps): JSX.Element {
  const retired = isRetiredProvider(participant.provider)
  const rolePresetId = resolveRolePresetId(participant.role)
  const isLinkedToPool = Boolean(participant.pooledAgentId)

  const rail = (
    <div className="settings-roster-participant-rail">
      <span
        className="settings-roster-grip"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(ROSTER_PARTICIPANT_DRAG_MIME, participant.id)
          event.dataTransfer.effectAllowed = 'copy'
        }}
        title="Drag to the agent pool to save"
        aria-hidden
      >
        ⠿
      </span>
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

  return (
    <li className={`settings-roster-participant${participant.enabled ? '' : ' is-disabled'}`}>
      {rail}
      <div className="settings-roster-participant-body">
        {/* Row 1 — row-level actions (kept off the picker row so the model name
            below has full width and never clips off the window edge). */}
        <div className="settings-roster-participant-actions">
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
            className={`settings-roster-bossman${isSecondInCommand ? ' is-active' : ''}`}
            onClick={() => onSetSecondInCommand(isSecondInCommand ? undefined : participant.id)}
            title={isSecondInCommand ? 'Clear second-in-command' : 'Set as second-in-command'}
            aria-pressed={isSecondInCommand}
            disabled={isBossman}
          >
            2nd
          </button>
          <button
            type="button"
            className={`settings-roster-save-pool${isLinkedToPool ? ' is-linked' : ''}`}
            onClick={() => onSaveToPool(participant.id)}
            title={
              isLinkedToPool
                ? 'Linked to a pool agent — save again to create a new one'
                : 'Save this participant to the agent pool for reuse'
            }
            aria-label="Save to agent pool"
          >
            {isLinkedToPool ? '★ Pooled' : '☆ Save to pool'}
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

        {/* Row 2 — provider / model / permissions pickers (full width). */}
        <div className="settings-roster-participant-top">
          <ParticipantPickerCluster
            participant={participant}
            composerStyle={composerStyle}
            agenticServices={agenticServices}
            grokAvailable={grokAvailable}
            cursorAvailable={cursorAvailable}
            showApplyToAll={showApplyToAll}
            onPatch={(patch) => onPatch(participant.id, patch)}
            onApplyPermissionsToAll={onApplyPermissionsToAll}
          />
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
        participants: snapshotParticipantsForPreset(
          next.participants,
          next.bossmanParticipantId,
          next.secondInCommandParticipantId
        )
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
    const hydratedParticipants = hydrateParticipantsWithPooledAgentIdentity(
      materialized.participants
    )
    const loaded: RosterEditing = {
      meta,
      participants: hydratedParticipants,
      bossmanParticipantId: materialized.bossmanParticipantId,
      secondInCommandParticipantId: materialized.secondInCommandParticipantId
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

  // ── Agent Pool wiring ─────────────────────────────────────────────────────
  // Live pool list for the "+ Add from pool" picker. Subscribes to the same
  // same-window fan-out the band uses so a save/edit/delete reflects instantly.
  const [poolAgents, setPoolAgents] = useState<PooledAgent[]>(() => listPooledAgents())
  const [poolPickerOpen, setPoolPickerOpen] = useState(false)
  useEffect(() => {
    const refresh = (): void => {
      setPoolAgents(listPooledAgents())
      // Reconcile the OPEN editor's linked participants with the pool, so editing
      // a pooled Agent whose linked preset is currently open updates the working
      // copy — otherwise a later commit would persist the stale config and
      // silently clobber the propagation. Non-dirty patch: never re-persists.
      const current = editingRef.current
      if (!current) return
      let changed = false
      const participants = current.participants.map((participant) => {
        const next = applyPooledAgentToParticipant(participant)
        if (next !== participant) changed = true
        return next
      })
      if (changed) {
        const updated = { ...current, participants }
        editingRef.current = updated
        setEditing(updated)
      }
    }
    refresh()
    return subscribeEnsembleAgentPool(refresh)
  }, [])

  // Save a preset participant INTO the pool as a reusable Agent, then LINK the
  // source participant to the new Agent (so future Agent edits propagate back).
  // Reads editingRef.current — never the row's captured `participant` prop — so
  // an unblurred Role/Goal edit is captured, not silently dropped.
  const saveParticipantToPool = useCallback(
    (id: string): void => {
      const current = editingRef.current
      if (!current) return
      const participant = current.participants.find((p) => p.id === id)
      if (!participant) return
      const agent = createPooledAgentFromParticipant(participant)
      // patchParticipant reads editingRef + commits (persist=true), so any other
      // unblurred edit in the working copy is flushed alongside the link.
      patchParticipant(
        id,
        {
          pooledAgentId: agent.agentId,
          pooledAgentIdentity: pooledAgentIdentitySnapshot(agent)
        },
        true
      )
    },
    [patchParticipant]
  )

  // Materialize a pooled Agent into the open preset as a fresh LINKED
  // participant. Routes through commit() (the persist=true structural path) and
  // reads editingRef so it composes with any unblurred edit.
  const addPooledAgentToPreset = useCallback(
    (agent: PooledAgent): void => {
      const current = editingRef.current
      if (!current || current.participants.length >= MAX_ROSTER_PRESET_PARTICIPANTS) return
      const snapshot = pooledAgentToParticipantSnapshot(agent, current.participants.length + 1)
      const [materialized] = materializeParticipantsFromPresetWithBossman([snapshot]).participants
      if (!materialized) return
      const participant: EnsembleParticipant = {
        ...materialized,
        id: freshWorkingId(current.participants),
        order: current.participants.length + 1
      }
      const participants = [...current.participants, participant]
      const maxParticipants = Math.max(current.meta.maxParticipants, participants.length)
      commit({ ...current, meta: { ...current.meta, maxParticipants }, participants })
      setPoolPickerOpen(false)
    },
    [commit]
  )

  // pool agent -> participant-list drop (forward direction). At MAX we withhold
  // preventDefault so the browser shows a no-drop cursor — there is no toast
  // system, mirroring how "+ Add participant" simply disables.
  const [isPoolDropTarget, setIsPoolDropTarget] = useState(false)
  const onParticipantsDragOver = useCallback(
    (event: ReactDragEvent<HTMLUListElement>): void => {
      if (!event.dataTransfer.types.includes(POOLED_AGENT_DRAG_MIME)) return
      const current = editingRef.current
      if (!current || current.participants.length >= MAX_ROSTER_PRESET_PARTICIPANTS) {
        event.dataTransfer.dropEffect = 'none'
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setIsPoolDropTarget(true)
    },
    []
  )
  const onParticipantsDrop = useCallback(
    (event: ReactDragEvent<HTMLUListElement>): void => {
      setIsPoolDropTarget(false)
      const agentId = event.dataTransfer.getData(POOLED_AGENT_DRAG_MIME)
      if (!agentId) return
      event.preventDefault()
      const agent = listPooledAgents().find((candidate) => candidate.agentId === agentId)
      if (agent) addPooledAgentToPreset(agent)
    },
    [addPooledAgentToPreset]
  )

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
          current.bossmanParticipantId === id ? undefined : current.bossmanParticipantId,
        secondInCommandParticipantId:
          current.secondInCommandParticipantId === id
            ? undefined
            : current.secondInCommandParticipantId
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
        bossmanParticipantId: id && current.participants.some((p) => p.id === id) ? id : undefined,
        secondInCommandParticipantId:
          id && current.secondInCommandParticipantId === id
            ? undefined
            : current.secondInCommandParticipantId
      })
    },
    [commit]
  )

  const setSecondInCommandParticipant = useCallback(
    (id: string | undefined): void => {
      const current = editingRef.current
      if (!current) return
      const nextId =
        id &&
        id !== current.bossmanParticipantId &&
        current.participants.some((participant) => participant.id === id)
          ? id
          : undefined
      commit({
        ...current,
        secondInCommandParticipantId: nextId
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

              <ul
                className={`settings-roster-participants${
                  isPoolDropTarget ? ' is-pool-drop-target' : ''
                }`}
                onDragOver={onParticipantsDragOver}
                onDragLeave={() => setIsPoolDropTarget(false)}
                onDrop={onParticipantsDrop}
              >
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
                    isSecondInCommand={
                      editing.secondInCommandParticipantId === participant.id &&
                      editing.bossmanParticipantId !== participant.id
                    }
                    onMove={moveParticipant}
                    onRemove={removeParticipant}
                    onSetBossman={setBossmanParticipant}
                    onSetSecondInCommand={setSecondInCommandParticipant}
                    onPatch={patchParticipant}
                    onFlush={flushText}
                    onApplyPermissionsToAll={applyPermissionsToAll}
                    onSaveToPool={saveParticipantToPool}
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
                <div className="settings-roster-pool-add">
                  <button
                    type="button"
                    className="settings-roster-add settings-roster-add-from-pool"
                    onClick={() => setPoolPickerOpen((open) => !open)}
                    disabled={
                      poolAgents.length === 0 ||
                      editing.participants.length >= MAX_ROSTER_PRESET_PARTICIPANTS
                    }
                    aria-expanded={poolPickerOpen}
                    title={
                      poolAgents.length === 0
                        ? 'Save a participant to the pool first'
                        : editing.participants.length >= MAX_ROSTER_PRESET_PARTICIPANTS
                          ? `Up to ${MAX_ROSTER_PRESET_PARTICIPANTS} participants`
                          : 'Add a reusable agent from the pool'
                    }
                  >
                    + Add from pool
                  </button>
                  {poolPickerOpen && poolAgents.length > 0 && (
                    <ul className="settings-roster-pool-picker" role="menu">
                      {poolAgents.map((agent) => {
                        return (
                          <li key={agent.agentId} role="none">
                            <button
                              type="button"
                              role="menuitem"
                              className="settings-roster-pool-picker-item"
                              onClick={() => addPooledAgentToPreset(agent)}
                            >
                              <PooledAgentIcon agent={agent} size={20} />
                              <span className="settings-roster-pool-picker-name">
                                {agent.identity.nickname}
                              </span>
                              <span className="settings-roster-pool-picker-sub">
                                {getProviderLabel(agent.config.provider)}
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <p className="settings-roster-pool-pointer">
        Reusable Agents now have their own page — <strong>Settings → Agent pool</strong>. Save a
        roster participant there with the ☆ button on its row.
      </p>
    </div>
  )
}
