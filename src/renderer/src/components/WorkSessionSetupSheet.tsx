import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  EnsembleParticipant,
  EnsembleRoundMode,
  PermissionPresetId,
  ProviderId,
  WorkSessionConfig
} from '../../../main/store/types'
import { ENSEMBLE_PRESETS, findEnsemblePreset } from '../lib/ensemblePresets'

/**
 * 1.0.4-AK2 — Work Session setup sheet.
 *
 * Modal overlay opened from the composer's "Work Session" toggle.
 * The user defines an objective + acceptance criteria + budget +
 * safety knobs, and the ensemble proceeds through rounds
 * autonomously until acceptance is reported or a hard-stop trips.
 *
 * Visual pattern matches `BugReportSheet` / `FirstLaunchSheet` —
 * fixed-inset backdrop dim + blur, opaque `var(--surface-1)`
 * panel. Form fields are deliberately spartan; the goal is for
 * the user to define the work clearly, NOT to expose every knob
 * the orchestrator has.
 *
 * Submit calls `onConfirm(config, initialPrompt)`. The parent is
 * responsible for:
 *   - persisting `config` into `chat.ensemble.workSession`
 *   - dispatching the round with `initialPrompt`
 *   - mounting the session strip + Stop control
 */

const DURATION_PRESETS: { label: string; ms: number }[] = [
  { label: '30m', ms: 30 * 60 * 1000 },
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '2h', ms: 2 * 60 * 60 * 1000 },
  { label: '6h', ms: 6 * 60 * 60 * 1000 }
]

const PERMISSION_PRESET_OPTIONS: { value: PermissionPresetId; label: string; hint: string }[] = [
  { value: 'read_only', label: 'Read-only', hint: 'No writes, no shell, no MCP mutation.' },
  { value: 'default', label: 'Default', hint: 'Per-provider default approval modes.' },
  {
    value: 'workspace_write',
    label: 'Workspace write',
    hint: 'Auto-allow in-workspace shell/file edits. External publish and elevated tools still prompt.'
  }
]

function workSessionPermissionPreset(value: PermissionPresetId | undefined): PermissionPresetId {
  return value === 'read_only' || value === 'plan' || value === 'default' || value === 'workspace_write'
    ? value
    : 'workspace_write'
}

const DEFAULT_MAX_ROUNDS = 38
const DEFAULT_MAX_DURATION_MS = 6 * 60 * 60 * 1000

const ROUND_MODE_OPTIONS: {
  value: Exclude<EnsembleRoundMode, 'targeted'>
  label: string
  hint: string
}[] = [
  {
    value: 'roundtable',
    label: 'Roundtable',
    hint: 'Every allowed participant speaks in order.'
  },
  {
    value: 'chair-summary',
    label: 'Chair summary',
    hint: 'A synthesizer speaks last and writes the round summary.'
  },
  {
    value: 'rebuttal',
    label: 'Rebuttal',
    hint: 'Participants respond to the previous speaker.'
  }
]

export interface WorkSessionSetupConfirmInput {
  config: WorkSessionConfig
  initialPrompt: string
  roundMode: Exclude<EnsembleRoundMode, 'targeted'>
  synthesizerParticipantId?: string
}

interface WorkSessionSetupSheetProps {
  isOpen: boolean
  /** Participants currently configured on the chat's ensemble. The
   * sheet shows enabled ones in the allowed-participants
   * multi-select; disabled ones are filtered out. */
  participants: EnsembleParticipant[]
  /** Provider helper for human-readable chip labels. */
  providerLabel: (provider: ProviderId) => string
  /** Optional preset to pre-populate. Useful when re-opening an
   * existing session config to edit. */
  initial?: Partial<WorkSessionConfig> & { initialPrompt?: string }
  initialRoundMode?: EnsembleRoundMode
  initialSynthesizerParticipantId?: string
  onConfirm: (input: WorkSessionSetupConfirmInput) => void
  onCancel: () => void
}

export function WorkSessionSetupSheet({
  isOpen,
  participants,
  providerLabel,
  initial,
  initialRoundMode,
  initialSynthesizerParticipantId,
  onConfirm,
  onCancel
}: WorkSessionSetupSheetProps): React.JSX.Element | null {
  const enabledParticipants = useMemo(() => participants.filter((p) => p.enabled), [participants])

  // When the session passed in has already reached a terminal state,
  // re-opening it should behave as a fresh "Restart" rather than an
  // "Edit" that silently dispatches a new round against stale fields.
  // We reset to defaults and relabel the action button. Derived from
  // the status the component already receives — no App.tsx change.
  const isRestartMode =
    initial?.status === 'completed' ||
    initial?.status === 'cancelled' ||
    initial?.status === 'limit_reached'

  const initialAllowed = useMemo(() => {
    if (
      !isRestartMode &&
      initial?.allowedParticipantIds &&
      initial.allowedParticipantIds.length > 0
    ) {
      return new Set(initial.allowedParticipantIds)
    }
    return new Set(enabledParticipants.map((p) => p.id))
  }, [enabledParticipants, initial, isRestartMode])

  const [objective, setObjective] = useState(isRestartMode ? '' : initial?.objective || '')
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(
    isRestartMode ? '' : initial?.acceptanceCriteria || ''
  )
  const [initialPrompt, setInitialPrompt] = useState(
    isRestartMode ? '' : initial?.initialPrompt || ''
  )
  const [allowed, setAllowed] = useState<Set<string>>(initialAllowed)
  const [leadId, setLeadId] = useState<string | undefined>(
    (isRestartMode ? undefined : initial?.leadParticipantId) || enabledParticipants[0]?.id
  )
  const [permissionPresetId, setPermissionPresetId] = useState<PermissionPresetId>(
    workSessionPermissionPreset(isRestartMode ? undefined : initial?.permissionPresetId)
  )
  const [maxRoundsPerProvider, setMaxRoundsPerProvider] = useState<number>(
    isRestartMode ? DEFAULT_MAX_ROUNDS : (initial?.maxRoundsPerProvider ?? DEFAULT_MAX_ROUNDS)
  )
  const [maxDurationMs, setMaxDurationMs] = useState<number>(
    isRestartMode ? DEFAULT_MAX_DURATION_MS : (initial?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS)
  )
  const [enableScoutPass, setEnableScoutPass] = useState<boolean>(
    isRestartMode ? false : (initial?.enableScoutPass ?? false)
  )
  // 1.0.x — track the last preset chip applied so it can render with
  // selected/active feedback (mirrors the duration buttons below).
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  const [roundMode, setRoundMode] = useState<Exclude<EnsembleRoundMode, 'targeted'>>(
    initialRoundMode === 'chair-summary' || initialRoundMode === 'rebuttal'
      ? initialRoundMode
      : 'roundtable'
  )
  const [synthesizerParticipantId, setSynthesizerParticipantId] = useState<string | undefined>(
    initialSynthesizerParticipantId || initial?.leadParticipantId || enabledParticipants[0]?.id
  )

  const [errors, setErrors] = useState<string[]>([])
  const objectiveRef = useRef<HTMLTextAreaElement | null>(null)

  // Reset when re-opened — avoids stale fields lingering across
  // open cycles. We re-derive from `initial` on each open so the
  // sheet behaves predictably whether the user is creating fresh
  // or editing an existing session.
  useEffect(() => {
    if (!isOpen) return
    const frame = window.requestAnimationFrame(() => {
      setObjective(isRestartMode ? '' : initial?.objective || '')
      setAcceptanceCriteria(isRestartMode ? '' : initial?.acceptanceCriteria || '')
      setInitialPrompt(isRestartMode ? '' : initial?.initialPrompt || '')
      setAllowed(initialAllowed)
      setLeadId(
        (isRestartMode ? undefined : initial?.leadParticipantId) || enabledParticipants[0]?.id
      )
      setPermissionPresetId(
        workSessionPermissionPreset(isRestartMode ? undefined : initial?.permissionPresetId)
      )
      setMaxRoundsPerProvider(
        isRestartMode ? DEFAULT_MAX_ROUNDS : (initial?.maxRoundsPerProvider ?? DEFAULT_MAX_ROUNDS)
      )
      setMaxDurationMs(
        isRestartMode
          ? DEFAULT_MAX_DURATION_MS
          : (initial?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS)
      )
      setEnableScoutPass(isRestartMode ? false : (initial?.enableScoutPass ?? false))
      setActivePresetId(null)
      setRoundMode(
        isRestartMode
          ? 'roundtable'
          : initialRoundMode === 'chair-summary' || initialRoundMode === 'rebuttal'
            ? initialRoundMode
            : 'roundtable'
      )
      setSynthesizerParticipantId(
        (isRestartMode
          ? undefined
          : initialSynthesizerParticipantId || initial?.leadParticipantId) ||
          enabledParticipants[0]?.id
      )
      setErrors([])
    })
    // Focus objective on open so the user can type immediately.
    const focusTimer = window.setTimeout(() => objectiveRef.current?.focus(), 50)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(focusTimer)
    }
  }, [
    isOpen,
    initial,
    initialAllowed,
    enabledParticipants,
    initialRoundMode,
    initialSynthesizerParticipantId,
    isRestartMode
  ])

  // Esc dismisses the sheet — matches BugReportSheet behaviour.
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isOpen, onCancel])

  const handleToggleAllowed = useCallback((participantId: string) => {
    setAllowed((prev) => {
      const next = new Set(prev)
      if (next.has(participantId)) {
        next.delete(participantId)
        // Only clear the lead when the participant being DESELECTED is
        // itself the lead — deselecting a non-lead must never wipe the
        // chosen lead.
        setLeadId((currentLead) => (currentLead === participantId ? undefined : currentLead))
      } else {
        next.add(participantId)
      }
      return next
    })
  }, [])

  const handleSubmit = useCallback(() => {
    const trimmedObjective = objective.trim()
    const trimmedCriteria = acceptanceCriteria.trim()
    const trimmedPrompt = initialPrompt.trim()
    const allowedIds = Array.from(allowed)
    const validationErrors: string[] = []
    if (!trimmedObjective) validationErrors.push('Objective is required.')
    if (!trimmedCriteria) validationErrors.push('Acceptance criteria is required.')
    if (!trimmedPrompt) validationErrors.push('First-round prompt is required.')
    if (allowedIds.length === 0)
      validationErrors.push('At least one participant must be allowed to act in the session.')
    if (maxRoundsPerProvider < 1 || !Number.isFinite(maxRoundsPerProvider)) {
      validationErrors.push('Rounds-per-provider must be at least 1.')
    }
    if (roundMode === 'chair-summary' && !synthesizerParticipantId) {
      validationErrors.push('Choose a synthesizer for chair-summary mode.')
    }

    if (validationErrors.length > 0) {
      setErrors(validationErrors)
      return
    }

    const resolvedLead = leadId && allowedIds.includes(leadId) ? leadId : undefined
    const config: WorkSessionConfig = {
      enabled: true,
      status: 'active',
      objective: trimmedObjective,
      acceptanceCriteria: trimmedCriteria,
      allowedParticipantIds: allowedIds.length === enabledParticipants.length ? null : allowedIds,
      leadParticipantId: resolvedLead,
      permissionPresetId,
      maxRoundsPerProvider,
      maxDurationMs,
      enableScoutPass,
      startedAt: new Date().toISOString(),
      roundsUsed: { codex: 0, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0 },
      totalRoundsUsed: 0
    }
    onConfirm({
      config,
      initialPrompt: trimmedPrompt,
      roundMode,
      ...(synthesizerParticipantId ? { synthesizerParticipantId } : {})
    })
  }, [
    objective,
    acceptanceCriteria,
    initialPrompt,
    allowed,
    leadId,
    permissionPresetId,
    maxRoundsPerProvider,
    maxDurationMs,
    enableScoutPass,
    roundMode,
    synthesizerParticipantId,
    enabledParticipants.length,
    onConfirm
  ])

  if (!isOpen) return null

  const sheetTitle = isRestartMode
    ? 'Restart Work Session'
    : initial?.objective
      ? 'Edit Work Session'
      : 'Start Work Session'
  const submitLabel = isRestartMode
    ? 'Restart'
    : initial?.objective
      ? 'Update session'
      : 'Start session'

  return (
    <div
      className="work-session-setup-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        className="work-session-setup-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="work-session-setup-title"
      >
        <header className="work-session-setup-header">
          <h2 id="work-session-setup-title">{sheetTitle}</h2>
          <p className="work-session-setup-subhead">
            Define an objective + acceptance criteria. The ensemble continues through rounds via{' '}
            <code>ensemble_continue</code> until acceptance is reported or a hard-stop trips.
            Existing approval gates still fire for each mutation.
          </p>
        </header>
        <div className="work-session-setup-body">
          {/*
            1.0.4-AT9 — preset picker. Five named shapes the panel
            review identified as the most useful starting points
            (One-shot review, Architecture panel, Parallel fan-out,
            Implementation review, Long-running). Selecting one
            patches permission preset + round/duration budgets +
            fan-out toggle + acceptance-criteria seed. The user
            can still tweak each field afterwards; presets are a
            fast path, not a lock-in.
          */}
          <label className="work-session-field">
            <span className="work-session-field-label">Preset</span>
            <div className="work-session-preset-row">
              {ENSEMBLE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`work-session-preset-chip${
                    activePresetId === preset.id ? ' is-active' : ''
                  }`}
                  title={preset.description}
                  onClick={() => {
                    const found = findEnsemblePreset(preset.id)
                    if (!found) return
                    const o = found.overrides
                    if (o.permissionPresetId !== undefined) {
                      setPermissionPresetId(workSessionPermissionPreset(o.permissionPresetId))
                    }
                    if (o.maxRoundsPerProvider !== undefined) {
                      setMaxRoundsPerProvider(o.maxRoundsPerProvider)
                    }
                    if (o.maxDurationMs !== undefined) {
                      setMaxDurationMs(o.maxDurationMs)
                    }
                    if (o.enableScoutPass !== undefined) {
                      setEnableScoutPass(o.enableScoutPass)
                    }
                    if (o.synthesizerRequirement === 'required') {
                      setRoundMode('chair-summary')
                      setSynthesizerParticipantId(leadId || enabledParticipants[0]?.id)
                    }
                    if (o.acceptanceCriteriaHint && !acceptanceCriteria.trim()) {
                      setAcceptanceCriteria(o.acceptanceCriteriaHint)
                    }
                    setActivePresetId(preset.id)
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </label>
          <label className="work-session-field">
            <span className="work-session-field-label">Objective</span>
            <textarea
              ref={objectiveRef}
              className="work-session-field-textarea"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="What should the ensemble accomplish?"
              rows={2}
            />
          </label>
          <label className="work-session-field">
            <span className="work-session-field-label">Acceptance criteria</span>
            <textarea
              className="work-session-field-textarea"
              value={acceptanceCriteria}
              onChange={(e) => setAcceptanceCriteria(e.target.value)}
              placeholder="How will the panel know the work is done?"
              rows={2}
            />
          </label>
          <label className="work-session-field">
            <span className="work-session-field-label">First-round prompt</span>
            <textarea
              className="work-session-field-textarea"
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
              placeholder="What should the first participant tackle?"
              rows={2}
            />
          </label>
          <div className="work-session-field">
            <span className="work-session-field-label">Allowed participants</span>
            <div className="work-session-participants-grid">
              {enabledParticipants.map((participant) => {
                const isAllowed = allowed.has(participant.id)
                const isLead = leadId === participant.id
                return (
                  <div key={participant.id} className="work-session-participant-row">
                    <label className="work-session-participant-toggle">
                      <input
                        type="checkbox"
                        checked={isAllowed}
                        onChange={() => handleToggleAllowed(participant.id)}
                      />
                      <span className="work-session-participant-label">
                        {providerLabel(participant.provider)} / {participant.role || 'Participant'}
                      </span>
                    </label>
                    <button
                      type="button"
                      className={`work-session-lead-toggle${isLead ? ' is-lead' : ''}`}
                      disabled={!isAllowed}
                      onClick={() => setLeadId(isLead ? undefined : participant.id)}
                      title="Lead — opens every round"
                    >
                      {isLead ? '★ Lead' : 'Set lead'}
                    </button>
                  </div>
                )
              })}
              {enabledParticipants.length === 0 && (
                <div className="work-session-participants-empty">
                  No enabled participants. Enable at least one to start a session.
                </div>
              )}
            </div>
          </div>
          <div className="work-session-row">
            <label className="work-session-field">
              <span className="work-session-field-label">Round mode</span>
              <select
                className="work-session-field-select"
                value={roundMode}
                onChange={(e) =>
                  setRoundMode(e.target.value as Exclude<EnsembleRoundMode, 'targeted'>)
                }
              >
                {ROUND_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="work-session-field-hint">
                {ROUND_MODE_OPTIONS.find((option) => option.value === roundMode)?.hint}
              </span>
            </label>
            <label className="work-session-field">
              <span className="work-session-field-label">Synthesizer</span>
              <select
                className="work-session-field-select"
                value={synthesizerParticipantId || ''}
                onChange={(e) => setSynthesizerParticipantId(e.target.value || undefined)}
                disabled={roundMode !== 'chair-summary'}
              >
                {enabledParticipants.map((participant) => (
                  <option key={participant.id} value={participant.id}>
                    {providerLabel(participant.provider)} / {participant.role || 'Participant'}
                  </option>
                ))}
              </select>
              <span className="work-session-field-hint">Used only for chair-summary rounds.</span>
            </label>
          </div>
          <div className="work-session-row">
            <label className="work-session-field">
              <span className="work-session-field-label">Permission preset</span>
              <select
                className="work-session-field-select"
                value={permissionPresetId}
                onChange={(e) => setPermissionPresetId(e.target.value as PermissionPresetId)}
              >
                {PERMISSION_PRESET_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="work-session-field-hint">
                {
                  PERMISSION_PRESET_OPTIONS.find((option) => option.value === permissionPresetId)
                    ?.hint
                }
              </span>
            </label>
            <label className="work-session-field">
              <span className="work-session-field-label">Rounds / provider</span>
              <input
                type="number"
                className="work-session-field-input"
                min={1}
                max={500}
                value={maxRoundsPerProvider}
                onChange={(e) =>
                  setMaxRoundsPerProvider(
                    Math.min(500, Math.max(1, Math.floor(Number(e.target.value) || 0)))
                  )
                }
              />
              <span className="work-session-field-hint">Hard cap per provider. Default 38.</span>
            </label>
          </div>
          <div className="work-session-field">
            <span className="work-session-field-label">Duration cap</span>
            <div className="work-session-duration-row">
              {DURATION_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className={`work-session-duration-button${
                    preset.ms === maxDurationMs ? ' is-active' : ''
                  }`}
                  onClick={() => setMaxDurationMs(preset.ms)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          <label className="work-session-field work-session-scout-toggle">
            <input
              type="checkbox"
              checked={enableScoutPass}
              onChange={(e) => setEnableScoutPass(e.target.checked)}
            />
            <span>
              <strong>Enable Parallel fan-out</strong> — read-only participants can run
              concurrently within a round before writer-capable participants continue.
            </span>
          </label>
          {errors.length > 0 && (
            <div className="work-session-errors" role="alert">
              {errors.map((error) => (
                <div key={error} className="work-session-error-row">
                  {error}
                </div>
              ))}
            </div>
          )}
        </div>
        <footer className="work-session-setup-footer">
          <button
            type="button"
            className="work-session-button work-session-button-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="work-session-button work-session-button-confirm"
            onClick={handleSubmit}
            disabled={enabledParticipants.length === 0}
          >
            {submitLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
