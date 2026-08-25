import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatRecord, ComposerStyle, EnsembleParticipant } from '../../../main/store/types'
import type { EnsembleUserRosterMutation } from '../../../main/EnsembleUserRosterMutation'
import { MAX_ENSEMBLE_PARTICIPANTS } from '../../../shared/ensembleLimits'
import { MAX_ENSEMBLE_CAPTAINS } from '../../../shared/ensembleAuthority'
import { MIN_LIVE_ENSEMBLE_PARTICIPANTS } from '../lib/ensembleRosterFloor'
import {
  buildParticipantPickerProviderGroups,
  type ParticipantPickerConfiguredProviderSnapshot
} from './ParticipantPickerCluster'
import {
  computeComposerPlanPopoverPosition,
  type ComposerPlanPopoverPosition
} from './ComposerPlanPopoverButton'
import {
  resolveComposerSurfacePopoverPosition,
  type ComposerSurfacePopoverPosition
} from '../lib/composerSurfacePopover'
import { ComposerEnsembleRosterPopover } from './ComposerEnsembleRosterPopover'
import {
  EnsembleAddParticipantButton,
  buildEnsembleParticipantAddMutation,
  buildEnsembleParticipantRemoveMutation,
  type EnsembleParticipantAddDraft
} from './EnsembleParticipantsAboveRow'
import { ProviderGlyph } from './icons/ProviderGlyph'

interface ComposerEnsembleToggleButtonProps {
  enabled: boolean
  visible: boolean
  onToggle: (enabled: boolean) => void
  chat?: ChatRecord | null
  selectedParticipantId?: string | null
  onSelectParticipant?: (participantId: string) => void
  onPatchParticipant?: (participantId: string, patch: Partial<EnsembleParticipant>) => void
  onLiveRosterMutation?: (mutation: EnsembleUserRosterMutation) => void
  configuredProviderSnapshot?: ParticipantPickerConfiguredProviderSnapshot
  grokAvailable?: boolean
  cursorAvailable?: boolean
  composerStyle?: string
  disabled?: boolean
  title?: string
}

type ComposerEnsemblePopoverPosition =
  | ({ kind: 'toggle' } & ComposerPlanPopoverPosition)
  | ({ kind: 'roster' } & ComposerSurfacePopoverPosition)

export function ComposerEnsembleToggleButton({
  enabled,
  visible,
  onToggle,
  chat,
  selectedParticipantId,
  onSelectParticipant,
  onPatchParticipant,
  onLiveRosterMutation,
  configuredProviderSnapshot,
  grokAvailable,
  cursorAvailable,
  composerStyle = 'default',
  disabled = false,
  title: overrideTitle
}: ComposerEnsembleToggleButtonProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<ComposerEnsemblePopoverPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  const updatePosition = useCallback((): void => {
    if (typeof window === 'undefined') return
    const trigger = triggerRef.current
    if (!trigger) {
      setPosition(null)
      return
    }
    const rect = trigger.getBoundingClientRect()
    const surface = trigger.closest('.composer-surface') as HTMLElement | null
    const surfaceRect = surface?.getBoundingClientRect()
    if (enabled && chat?.ensemble) {
      setPosition({
        kind: 'roster',
        ...resolveComposerSurfacePopoverPosition({
          triggerRect: rect,
          surfaceRect: surfaceRect || rect,
          viewportWidth: window.innerWidth,
          widthFloor: 620
        })
      })
      return
    }
    const popoverHeight = popoverRef.current?.offsetHeight || 118
    setPosition({
      kind: 'toggle',
      ...computeComposerPlanPopoverPosition(
        rect,
        { width: window.innerWidth, height: window.innerHeight },
        { width: 236, height: popoverHeight }
      )
    })
  }, [chat?.ensemble, enabled])

  const closePopover = useCallback((restoreFocus = true): void => {
    setOpen(false)
    if (restoreFocus && typeof window !== 'undefined') {
      window.setTimeout(() => triggerRef.current?.focus(), 0)
    }
  }, [])

  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    updatePosition()
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePopover()
    }
    const handlePointer = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      // Provider/model/reasoning and permission pickers are intentionally
      // portaled above the compact roster editor. Treat the nested picker as
      // part of this dialog, otherwise choosing a row in it would collapse the
      // roster beneath the user's pointer.
      if (target instanceof Element && target.closest('.composer-combined-picker-popover')) return
      closePopover(false)
    }
    const handleReposition = (): void => updatePosition()
    window.addEventListener('keydown', handleKey)
    window.addEventListener('mousedown', handlePointer)
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('mousedown', handlePointer)
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [closePopover, open, updatePosition])

  useEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])

  if (!visible) return null

  const title = overrideTitle || (enabled ? 'Ensemble on' : 'Ensemble off')
  const rosterWorkspace = enabled && Boolean(chat?.ensemble)
  const participants = [...(chat?.ensemble?.participants || [])].sort(
    (left, right) => left.order - right.order
  )
  const selectedParticipant = participants.find(
    (participant) => participant.id === selectedParticipantId
  )
  const bossmanParticipantId = chat?.ensemble?.bossmanParticipantId
  const captainParticipantIds = chat?.ensemble?.captainParticipantIds || []
  const hasLeadership = participants.some(
    (participant) => participant.stageRole !== 'background' && participant.enabled
  )
  const providerSnapshot = {
    ready: configuredProviderSnapshot?.ready ?? false,
    providerIds: [...(configuredProviderSnapshot?.providerIds || [])],
    ...(configuredProviderSnapshot?.modelsByProvider
      ? { modelsByProvider: configuredProviderSnapshot.modelsByProvider }
      : {})
  }
  const addProviderGroups = buildParticipantPickerProviderGroups(
    Boolean(grokAvailable),
    Boolean(cursorAvailable),
    providerSnapshot,
    selectedParticipant?.provider || participants[participants.length - 1]?.provider || 'codex'
  )
  const participantManagerDisabled = disabled || !onLiveRosterMutation
  const participantAddDisabled = participants.length >= MAX_ENSEMBLE_PARTICIPANTS
  const participantRemoveDisabled =
    participantManagerDisabled ||
    !selectedParticipant ||
    selectedParticipant.id === bossmanParticipantId ||
    participants.length <= MIN_LIVE_ENSEMBLE_PARTICIPANTS
  const participantRemoveTitle = !selectedParticipant
    ? 'Select a participant in the roster first.'
    : selectedParticipant.id === bossmanParticipantId
      ? 'Assign another Boss before removing this participant.'
      : participants.length <= MIN_LIVE_ENSEMBLE_PARTICIPANTS
        ? 'An Ensemble must retain two participants; switch Ensemble Off to collapse it.'
        : `Remove ${selectedParticipant.role || selectedParticipant.provider}`

  const addParticipant = (configuration: EnsembleParticipantAddDraft): void => {
    if (!onLiveRosterMutation || participantAddDisabled) return
    const result = buildEnsembleParticipantAddMutation(
      participants,
      selectedParticipantId ?? null,
      configuration
    )
    onLiveRosterMutation(result.mutation)
    onSelectParticipant?.(result.participantId)
  }

  const removeSelectedParticipant = (): void => {
    if (!onLiveRosterMutation || !selectedParticipant || participantRemoveDisabled) return
    const result = buildEnsembleParticipantRemoveMutation(participants, selectedParticipant.id)
    if (!result) return
    onLiveRosterMutation(result.mutation)
    if (result.nextSelection) onSelectParticipant?.(result.nextSelection)
  }

  const selectMode = (nextEnabled: boolean): void => {
    setOpen(false)
    if (nextEnabled !== enabled) onToggle(nextEnabled)
  }
  const segmentedModeControl = (
    <div
      className="segmented-control segmented-control--compact composer-ensemble-toggle-segmented"
      role="radiogroup"
      aria-label="Ensemble mode"
    >
      <button
        type="button"
        className={`segmented-control-segment ${enabled ? 'is-active' : ''}`}
        onClick={() => selectMode(true)}
        role="radio"
        aria-checked={enabled}
      >
        On
      </button>
      <button
        type="button"
        className={`segmented-control-segment ${enabled ? '' : 'is-active'}`}
        onClick={() => selectMode(false)}
        role="radio"
        aria-checked={!enabled}
      >
        Off
      </button>
    </div>
  )

  const popover =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className={`composer-ensemble-toggle-popover shell-${composerStyle}${
              rosterWorkspace ? ' has-roster' : ''
            }${position?.kind === 'toggle' && position.placement === 'below' ? ' is-below' : ''}`}
            role="dialog"
            aria-label="Ensemble"
            style={
              position
                ? position.kind === 'roster'
                  ? {
                      left: `${position.left}px`,
                      top: `${position.top}px`,
                      width: `${position.width}px`,
                      height: 'min(50vh, 820px)',
                      transform: 'translateY(-100%)'
                    }
                  : {
                      left: `${position.left}px`,
                      top: `${position.top}px`,
                      width: `${position.width}px`
                    }
                : { left: '0px', top: '0px', visibility: 'hidden' }
            }
          >
            <div className="composer-ensemble-toggle-popover-header">
              <span className="composer-ensemble-toggle-popover-title">
                {rosterWorkspace ? 'Ensemble roster' : 'Ensemble'}
              </span>
            </div>
            {rosterWorkspace ? (
              <div className="composer-ensemble-toggle-mode-row">
                <EnsembleAddParticipantButton
                  disabled={participantManagerDisabled}
                  addDisabled={participantAddDisabled}
                  title="Add or remove Ensemble participants"
                  composerStyle={composerStyle as ComposerStyle}
                  grokAvailable={Boolean(grokAvailable)}
                  cursorAvailable={Boolean(cursorAvailable)}
                  providerGroups={addProviderGroups}
                  participants={participants}
                  hasLeadership={hasLeadership}
                  bossmanParticipantId={bossmanParticipantId}
                  captainParticipantIds={captainParticipantIds}
                  captainAssignmentDisabled={captainParticipantIds.length >= MAX_ENSEMBLE_CAPTAINS}
                  bossmanAutoApprovals={chat?.ensemble?.bossmanAutoApprovals}
                  initialProvider={
                    selectedParticipant?.provider ||
                    participants[participants.length - 1]?.provider ||
                    'codex'
                  }
                  onAdd={addParticipant}
                  customTrigger={{
                    className: 'composer-ensemble-participant-manager-trigger',
                    content: 'Add / remove participant',
                    title: 'Add a participant or remove the selected participant',
                    ariaLabel: 'Add or remove Ensemble participant'
                  }}
                  popoverClassName="is-ensemble-roster-nested-picker"
                  managementContent={
                    <button
                      type="button"
                      className="composer-ensemble-participant-remove-action"
                      onClick={removeSelectedParticipant}
                      disabled={participantRemoveDisabled}
                      title={participantRemoveTitle}
                    >
                      Remove selected
                    </button>
                  }
                />
                {segmentedModeControl}
              </div>
            ) : (
              segmentedModeControl
            )}
            {rosterWorkspace ? (
              <ComposerEnsembleRosterPopover
                chat={chat}
                selectedParticipantId={selectedParticipantId}
                onSelectParticipant={onSelectParticipant}
                onPatchParticipant={onPatchParticipant}
                onLiveRosterMutation={onLiveRosterMutation}
                composerStyle={composerStyle as ComposerStyle}
                configuredProviderSnapshot={configuredProviderSnapshot}
                grokAvailable={grokAvailable}
                cursorAvailable={cursorAvailable}
              />
            ) : null}
          </div>,
          document.body
        )
      : null

  return (
    <span className="composer-ensemble-toggle-control-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={`composer-ensemble-toggle-button composer-hint-pill${enabled ? ' is-active' : ''}${open ? ' is-open' : ''}`}
        data-hint-label="Ensemble"
        onClick={() => setOpen((value) => !value)}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
      >
        <ProviderGlyph provider="ensemble" />
      </button>
      {popover}
    </span>
  )
}
