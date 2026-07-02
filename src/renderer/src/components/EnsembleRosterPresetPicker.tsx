import { type FormEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ComposerStyle, EnsembleConfig } from '../../../main/store/types'
import {
  buildEnsembleRosterPresetFromConfig,
  deleteEnsembleRosterPreset,
  listEnsembleRosterPresets,
  renameEnsembleRosterPreset,
  saveEnsembleRosterPreset,
  subscribeEnsembleRosterPresets,
  upsertEnsembleRosterPreset,
  type EnsembleRosterParticipantSnapshot,
  type EnsembleRosterPreset
} from '../lib/ensembleRosterPresets'

export interface EnsembleRosterPresetPickerProps {
  ensemble: EnsembleConfig | null | undefined
  disabled?: boolean
  onApplyPreset: (preset: EnsembleRosterPreset) => void
  variant?: 'welcome' | 'compact'
  composerStyle?: ComposerStyle
  /** Optional full-width second row rendered below the preset chips —
   * the composer passes the ensemble orchestration controls here (see
   * EnsembleOrchestrationRow) so mode / fan-out / history-budget /
   * turn-budget live inside the same roster-presets section on every
   * shell (the root is flex-wrap, so a 100%-basis child wraps cleanly). */
  secondRow?: React.ReactNode
}

type PresetNameDialogState =
  | {
      mode: 'save'
      name: string
      error: string | null
    }
  | {
      mode: 'rename'
      preset: EnsembleRosterPreset
      name: string
      error: string | null
    }

const ROSTER_TRIGGER_FALLBACK_LABEL = 'Roster Presets'
const ROSTER_TRIGGER_NAME_MAX_CHARS = 15

function currentRosterPresetName(presets: readonly EnsembleRosterPreset[]): string {
  return presets[0]?.name || 'Ensemble roster'
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entry = value as Record<string, unknown>
    return `{${Object.keys(entry)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(entry[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function rosterParticipantComparable(participant: EnsembleRosterParticipantSnapshot): unknown {
  return {
    enabled: participant.enabled,
    fastModeEnabled:
      typeof participant.fastModeEnabled === 'boolean' ? participant.fastModeEnabled : null,
    geminiAuthProfileId: participant.geminiAuthProfileId ?? null,
    instructions: participant.instructions,
    isBossman: participant.isBossman === true,
    isSecondInCommand: participant.isSecondInCommand === true,
    model: participant.model ?? null,
    order: participant.order,
    permissionOverrides: participant.permissionOverrides ?? null,
    permissionPresetId: participant.permissionPresetId ?? null,
    pooledAgentId: participant.pooledAgentId ?? null,
    pooledAgentIdentity: participant.pooledAgentIdentity ?? null,
    provider: participant.provider,
    reasoningEffort: participant.reasoningEffort ?? null,
    role: participant.role,
    runtimeProfileId: participant.runtimeProfileId ?? null,
    serviceTier: participant.serviceTier ?? null,
    thinkingEnabled:
      typeof participant.thinkingEnabled === 'boolean' ? participant.thinkingEnabled : null
  }
}

function rosterPresetComparableKey(preset: EnsembleRosterPreset): string {
  return stableJson({
    concurrentModeEnabled:
      typeof preset.concurrentModeEnabled === 'boolean' ? preset.concurrentModeEnabled : null,
    ensembleContextChars:
      typeof preset.ensembleContextChars === 'number' ? preset.ensembleContextChars : null,
    fanoutPolicy: preset.fanoutPolicy ?? (preset.concurrentModeEnabled ? 'read_only' : 'off'),
    maxContinuationHops:
      typeof preset.maxContinuationHops === 'number' ? preset.maxContinuationHops : null,
    maxParticipants: preset.maxParticipants,
    orchestrationMode: preset.orchestrationMode,
    participants: [...preset.participants]
      .sort((a, b) => a.order - b.order)
      .map(rosterParticipantComparable)
  })
}

export function savedRosterPresetForEnsemble(
  ensemble: EnsembleConfig | null | undefined,
  presets: readonly EnsembleRosterPreset[]
): EnsembleRosterPreset | null {
  if (!ensemble || presets.length === 0) return null
  const current = buildEnsembleRosterPresetFromConfig('__current_roster__', ensemble, 0)
  const currentKey = rosterPresetComparableKey(current)
  return presets.find((preset) => rosterPresetComparableKey(preset) === currentKey) ?? null
}

export function rosterPresetTriggerLabel(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? ''
  if (!trimmed) return ROSTER_TRIGGER_FALLBACK_LABEL
  if (trimmed.length <= ROSTER_TRIGGER_NAME_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, ROSTER_TRIGGER_NAME_MAX_CHARS)}…`
}

export function rosterPresetMenuMeta(preset: EnsembleRosterPreset): string {
  const count = preset.participants.length
  const participantLabel = count === 1 ? 'participant' : 'participants'
  return `${count} ${participantLabel} · ${
    preset.orchestrationMode === 'continuous' ? 'Continuous' : 'Turn'
  }`
}

export function EnsembleRosterPresetPicker({
  ensemble,
  disabled = false,
  onApplyPreset,
  variant = 'welcome',
  composerStyle = 'default',
  secondRow
}: EnsembleRosterPresetPickerProps): React.JSX.Element | null {
  const [presets, setPresets] = useState<EnsembleRosterPreset[]>(() => listEnsembleRosterPresets())
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [popoverPosition, setPopoverPosition] = useState<{ left: number; top: number } | null>(null)
  const [presetNameDialog, setPresetNameDialog] = useState<PresetNameDialogState | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const presetNameInputRef = useRef<HTMLInputElement | null>(null)
  const presetNameInputId = useId()
  const presetNameTitleId = useId()

  const refreshPresets = (): void => {
    setPresets(listEnsembleRosterPresets())
  }

  // Stay in sync with the Settings → Roster editor (and other windows): any
  // create / edit / delete / rename there fans out through the shared store's
  // pub/sub so this compact picker reflects the change without a remount.
  useEffect(() => {
    return subscribeEnsembleRosterPresets(() => {
      setPresets(listEnsembleRosterPresets())
    })
  }, [])

  useEffect(() => {
    if (!popoverOpen) return
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (
        popoverRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return
      }
      setPopoverOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPopoverOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [popoverOpen])

  useLayoutEffect(() => {
    if (!popoverOpen || !triggerRef.current) {
      setPopoverPosition(null)
      return
    }
    const updatePosition = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setPopoverPosition({
        left: Math.max(12, rect.left),
        top: rect.top - 8
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [popoverOpen])

  // Focus + select the suggested name when the dialog OPENS — keyed on the
  // open/closed transition ONLY. Depending on `presetNameDialog` itself re-ran
  // this on every keystroke (onChange rebuilds the object), so the rAF kept
  // re-selecting all text and the next character overwrote the previous one —
  // the field could only ever hold ONE typed character (paste worked because
  // it's a single event that lands before the re-select).
  const presetDialogOpen = presetNameDialog !== null
  useEffect(() => {
    if (!presetDialogOpen) return
    const frame = window.requestAnimationFrame(() => {
      presetNameInputRef.current?.focus()
      presetNameInputRef.current?.select()
    })
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPresetNameDialog(null)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [presetDialogOpen])

  const canSave = Boolean(ensemble) && !disabled
  const activePreset = savedRosterPresetForEnsemble(ensemble, presets)
  const defaultOverwritePreset = activePreset || presets[0]
  const triggerLabel = rosterPresetTriggerLabel(activePreset?.name)

  const handleSaveAsCurrent = (): void => {
    if (!ensemble || disabled) return
    setPopoverOpen(false)
    setPresetNameDialog({ mode: 'save', name: currentRosterPresetName(presets), error: null })
  }

  const handleOverwritePreset = (preset?: EnsembleRosterPreset): void => {
    if (!ensemble || disabled) return
    const target = preset || activePreset || presets[0]
    if (!target) {
      handleSaveAsCurrent()
      return
    }
    const next = {
      ...buildEnsembleRosterPresetFromConfig(target.name, ensemble, Date.now()),
      id: target.id,
      createdAt: target.createdAt,
      name: target.name
    }
    upsertEnsembleRosterPreset(next)
    refreshPresets()
    setPopoverOpen(false)
  }

  const requestApplyPreset = (preset: EnsembleRosterPreset): void => {
    if (disabled) return
    setPopoverOpen(false)
    onApplyPreset(preset)
  }

  const handleRename = (preset: EnsembleRosterPreset): void => {
    setPopoverOpen(false)
    setPresetNameDialog({ mode: 'rename', preset, name: preset.name, error: null })
  }

  const handleDelete = (preset: EnsembleRosterPreset): void => {
    const confirmed = window.confirm(`Delete preset "${preset.name}"?`)
    if (!confirmed) return
    deleteEnsembleRosterPreset(preset.id)
    refreshPresets()
  }

  const handlePresetNameSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!presetNameDialog) return
    const trimmed = presetNameDialog.name.trim()
    if (!trimmed) {
      setPresetNameDialog({ ...presetNameDialog, error: 'Enter a preset name.' })
      return
    }
    try {
      if (presetNameDialog.mode === 'save') {
        if (!ensemble) return
        saveEnsembleRosterPreset(trimmed, ensemble)
      } else {
        if (trimmed === presetNameDialog.preset.name.trim()) {
          setPresetNameDialog(null)
          return
        }
        renameEnsembleRosterPreset(presetNameDialog.preset.id, trimmed)
      }
      refreshPresets()
      setPresetNameDialog(null)
    } catch (error) {
      console.error('[EnsembleRosterPresetPicker] failed to save preset', error)
      setPresetNameDialog({
        ...presetNameDialog,
        error: error instanceof Error ? error.message : 'Could not save this preset.'
      })
    }
  }

  const updatePresetName = (name: string): void => {
    setPresetNameDialog((current) => (current ? { ...current, name, error: null } : current))
  }

  const rootClassName =
    variant === 'compact'
      ? 'ensemble-roster-preset-picker is-compact'
      : 'ensemble-roster-preset-picker'

  return (
    <div className={rootClassName}>
      <div className="ensemble-roster-preset-picker-chips">
        <button
          ref={triggerRef}
          type="button"
          className={`ensemble-roster-preset-picker-browse${popoverOpen ? ' is-open' : ''}`}
          onClick={() => setPopoverOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={popoverOpen}
          title={
            activePreset
              ? activePreset.name
              : presets.length
              ? `${presets.length} saved roster${presets.length === 1 ? '' : 's'}`
              : 'No saved rosters yet'
          }
        >
          <span className="composer-combined-picker-trigger-primary">{triggerLabel}</span>
        </button>
      </div>
      {secondRow ? (
        <div className="ensemble-roster-preset-picker-second-row">{secondRow}</div>
      ) : null}
      {popoverOpen &&
        popoverPosition &&
        createPortal(
          <div
            ref={popoverRef}
            className={`ensemble-roster-preset-popover composer-combined-picker-popover composer-plus-picker-popover shell-${composerStyle}`}
            role="menu"
            style={{
              left: popoverPosition.left,
              top: popoverPosition.top,
              transform: 'translateY(-100%)'
            }}
          >
            <div className="ensemble-roster-preset-popover-section">
              <div className="ensemble-roster-preset-popover-actions">
                <button
                  type="button"
                  className="composer-combined-picker-row ensemble-roster-preset-popover-action-row"
                  disabled={!canSave}
                  onClick={() => handleOverwritePreset()}
                  title={
                    defaultOverwritePreset
                      ? `Overwrite "${defaultOverwritePreset.name}" with the current roster`
                      : 'No saved roster yet; use Save As'
                  }
                >
                  <span className="composer-combined-picker-row-label">Save</span>
                </button>
                <button
                  type="button"
                  className="composer-combined-picker-row ensemble-roster-preset-popover-action-row"
                  disabled={!canSave}
                  onClick={handleSaveAsCurrent}
                  title="Save the current roster as a new named preset"
                >
                  <span className="composer-combined-picker-row-label">Save As</span>
                </button>
              </div>
              <div className="ensemble-roster-preset-popover-header">Saved rosters</div>
              {presets.length === 0 ? (
                <div className="ensemble-roster-preset-popover-empty">
                  No saved rosters yet. Use Save As to store this lineup.
                </div>
              ) : (
                presets.map((preset) => (
                  <div key={preset.id} className="ensemble-roster-preset-popover-row">
                    <button
                      type="button"
                      className="ensemble-roster-preset-popover-row-main-action"
                      disabled={disabled}
                      onClick={() => {
                        requestApplyPreset(preset)
                      }}
                    >
                      <span className="ensemble-roster-preset-popover-row-name">{preset.name}</span>
                      <span className="ensemble-roster-preset-popover-row-meta">
                        {rosterPresetMenuMeta(preset)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ensemble-roster-preset-popover-row-action"
                      disabled={!canSave}
                      onClick={() => handleOverwritePreset(preset)}
                      title={`Overwrite "${preset.name}" with the current roster`}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="ensemble-roster-preset-popover-row-action"
                      onClick={() => handleRename(preset)}
                      title="Rename preset"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="ensemble-roster-preset-popover-row-action is-danger"
                      onClick={() => handleDelete(preset)}
                      title="Delete preset"
                    >
                      Delete
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>,
          document.body
        )}
      {presetNameDialog &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="ensemble-roster-preset-dialog-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setPresetNameDialog(null)
            }}
          >
            <form
              className="ensemble-roster-preset-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby={presetNameTitleId}
              onSubmit={handlePresetNameSubmit}
            >
              <div className="ensemble-roster-preset-dialog-header">
                <h2 id={presetNameTitleId}>
                  {presetNameDialog.mode === 'save' ? 'Save roster preset' : 'Rename roster preset'}
                </h2>
                <button
                  type="button"
                  className="ensemble-roster-preset-dialog-close"
                  onClick={() => setPresetNameDialog(null)}
                  aria-label="Close roster preset dialog"
                >
                  ×
                </button>
              </div>
              <label className="ensemble-roster-preset-dialog-label" htmlFor={presetNameInputId}>
                Preset name
              </label>
              <input
                ref={presetNameInputRef}
                id={presetNameInputId}
                className="ensemble-roster-preset-dialog-input"
                value={presetNameDialog.name}
                onChange={(event) => updatePresetName(event.target.value)}
                maxLength={80}
              />
              {presetNameDialog.error && (
                <div className="ensemble-roster-preset-dialog-error" role="alert">
                  {presetNameDialog.error}
                </div>
              )}
              <div className="ensemble-roster-preset-dialog-actions">
                <button
                  type="button"
                  className="ensemble-roster-preset-dialog-button"
                  onClick={() => setPresetNameDialog(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="ensemble-roster-preset-dialog-button ensemble-roster-preset-dialog-button-primary"
                >
                  {presetNameDialog.mode === 'save' ? 'Save preset' : 'Rename'}
                </button>
              </div>
            </form>
          </div>,
          document.body
        )}
    </div>
  )
}
