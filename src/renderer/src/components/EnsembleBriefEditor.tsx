import { useEffect, useRef, useState, type JSX, type MouseEvent, type RefObject } from 'react'
import type { EnsembleParticipant } from '../../../main/store/types'
import { hasResolvedMention } from '../lib/mentionHighlight'
import {
  BUILT_IN_ENSEMBLE_BRIEF_PRESETS,
  getEnsembleBriefPreset,
  listUserEnsembleBriefPresets,
  renameUserEnsembleBriefPreset,
  saveUserEnsembleBriefPreset,
  subscribeEnsembleBriefPresets,
  type EnsembleBriefPreset
} from '../lib/ensembleBriefPresets'
import { ComposerHighlightOverlay } from './ComposerHighlightOverlay'

interface EnsembleBriefEditorProps {
  label: string
  value: string
  participants: EnsembleParticipant[]
  disabled?: boolean
  rows: number
  placeholder?: string
  editorClassName?: string
  labelClassName?: string
  textareaClassName: string
  textareaRef?: RefObject<HTMLTextAreaElement | null>
  spellCheck?: boolean
  syncEpoch?: string | number
  onChange: (value: string) => void
  onBlur?: () => void
  onContextMenu?: (event: MouseEvent<HTMLTextAreaElement>) => void
}

function suggestedPresetName(participants: EnsembleParticipant[]): string {
  const existing = new Set(
    [...BUILT_IN_ENSEMBLE_BRIEF_PRESETS, ...listUserEnsembleBriefPresets()].map((preset) =>
      preset.name.toLowerCase()
    )
  )
  const base = 'New brief'
  if (!existing.has(base.toLowerCase())) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}`
    if (!existing.has(candidate.toLowerCase())) return candidate
  }
  const firstNamedParticipant = participants.find((participant) => participant.role.trim())
  return firstNamedParticipant ? `${firstNamedParticipant.role.trim()} brief` : base
}

function promptForPresetName(defaultName: string): string | null {
  if (typeof window === 'undefined') return null
  const name = window.prompt('Brief preset name', defaultName)
  const trimmed = name?.trim() ?? ''
  return trimmed || null
}

export function EnsembleBriefEditor({
  label,
  value,
  participants,
  disabled = false,
  rows,
  placeholder,
  editorClassName,
  labelClassName,
  textareaClassName,
  textareaRef,
  spellCheck = true,
  syncEpoch = 'ensemble-brief-editor',
  onChange,
  onBlur,
  onContextMenu
}: EnsembleBriefEditorProps): JSX.Element {
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const resolvedTextareaRef = textareaRef || internalTextareaRef
  const [userPresets, setUserPresets] = useState<EnsembleBriefPreset[]>(() =>
    listUserEnsembleBriefPresets()
  )
  const [selectedPresetId, setSelectedPresetId] = useState('')

  useEffect(() => {
    return subscribeEnsembleBriefPresets(() => {
      setUserPresets(listUserEnsembleBriefPresets())
    })
  }, [])

  const selectedPreset = selectedPresetId ? getEnsembleBriefPreset(selectedPresetId) : null
  const selectedUserPreset = selectedPreset?.source === 'user' ? selectedPreset : null
  const hasMentionOverlay = hasResolvedMention(value, participants)

  const handleApplyPreset = (presetId: string): void => {
    setSelectedPresetId(presetId)
    const preset = getEnsembleBriefPreset(presetId)
    if (!preset) return
    onChange(preset.brief)
  }

  const handleSavePreset = (): void => {
    if (disabled || !value.trim()) return
    const name = promptForPresetName(suggestedPresetName(participants))
    if (!name) return
    try {
      const preset = saveUserEnsembleBriefPreset(name, value)
      setUserPresets(listUserEnsembleBriefPresets())
      setSelectedPresetId(preset.id)
    } catch {
      // Empty inputs are guarded above; localStorage failures degrade silently.
    }
  }

  const handleRenamePreset = (): void => {
    if (disabled || !selectedUserPreset) return
    const name = promptForPresetName(selectedUserPreset.name)
    if (!name) return
    const renamed = renameUserEnsembleBriefPreset(selectedUserPreset.id, name)
    if (renamed) {
      setUserPresets(listUserEnsembleBriefPresets())
      setSelectedPresetId(renamed.id)
    }
  }

  return (
    <div className={`ensemble-brief-editor${editorClassName ? ` ${editorClassName}` : ''}`}>
      <div className="ensemble-brief-editor-head">
        <span className={labelClassName || 'ensemble-brief-editor-label'}>{label}</span>
        <div className="ensemble-brief-preset-controls">
          <select
            className="ensemble-brief-preset-select"
            value={selectedPresetId}
            disabled={disabled}
            aria-label={`${label} preset`}
            onChange={(event) => handleApplyPreset(event.target.value)}
          >
            <option value="">Brief preset…</option>
            <optgroup label="Role presets">
              {BUILT_IN_ENSEMBLE_BRIEF_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id} title={preset.brief}>
                  {preset.name}
                </option>
              ))}
            </optgroup>
            {userPresets.length > 0 && (
              <optgroup label="My briefs">
                {userPresets.map((preset) => (
                  <option key={preset.id} value={preset.id} title={preset.brief}>
                    {preset.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            type="button"
            className="ensemble-brief-preset-action"
            disabled={disabled || !value.trim()}
            onClick={handleSavePreset}
            title="Save this brief for reuse"
          >
            Save
          </button>
          <button
            type="button"
            className="ensemble-brief-preset-action"
            disabled={disabled || !selectedUserPreset}
            onClick={handleRenamePreset}
            title={
              selectedUserPreset
                ? 'Rename selected saved brief'
                : 'Select a saved brief before renaming'
            }
          >
            Rename
          </button>
        </div>
      </div>
      <div className="ensemble-brief-textarea-wrap">
        <textarea
          ref={resolvedTextareaRef}
          className={`${textareaClassName} ensemble-brief-textarea${
            hasMentionOverlay ? ' has-mention-overlay' : ''
          }`}
          rows={rows}
          value={value}
          disabled={disabled}
          spellCheck={spellCheck}
          onChange={(event) => {
            setSelectedPresetId('')
            onChange(event.target.value)
          }}
          onBlur={onBlur}
          onContextMenu={onContextMenu}
          placeholder={placeholder}
        />
        {hasMentionOverlay && (
          <ComposerHighlightOverlay
            value={value}
            participants={participants}
            textareaRef={resolvedTextareaRef}
            syncEpoch={syncEpoch}
          />
        )}
      </div>
    </div>
  )
}
