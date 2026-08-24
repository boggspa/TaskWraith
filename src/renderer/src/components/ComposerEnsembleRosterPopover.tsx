import { useState } from 'react'
import type { ChatRecord, ComposerStyle, EnsembleParticipant } from '../../../main/store/types'
import type { EnsembleUserRosterMutation } from '../../../main/EnsembleUserRosterMutation'
import type { SeatChangeSeatState } from '../../../shared/seatChange'
import { resolveEnsembleParticipantSettings } from '../lib/ensembleProviderDefaults'
import { composedSeatRole } from '../lib/transcriptSeat'
import {
  BOSS_AUTO_APPROVAL_CONSENT_MESSAGE,
  EnsembleParticipantAuthorityControls,
  EnsembleParticipantStageControl,
  type EnsembleParticipantAuthority
} from './EnsembleParticipantsAboveRow'
import { ParticipantPickerCluster } from './ParticipantPickerCluster'
import type { ParticipantPickerConfiguredProviderSnapshot } from './ParticipantPickerCluster'
import { ParticipantRoleIcon, participantRoleIconTitle } from './icons/ParticipantRoleIcon'
import { seatAccentVar } from './SeatChangeRow'

function stageRoleForSeat(
  value: EnsembleParticipant['stageRole']
): SeatChangeSeatState['stageRole'] {
  return value === 'scout' || value === 'worker' || value === 'reviewer' || value === 'background'
    ? value
    : undefined
}

/** Maps a live roster participant to the same static seat presentation used by
 * transcript changes and close-out cards. The visual identity stays centralised
 * in `SeatStateChips`; this is deliberately just the live-roster adapter. */
export function ensemblePopoverSeatState(
  chat: Pick<ChatRecord, 'ensemble'>,
  participant: EnsembleParticipant,
  index: number
): SeatChangeSeatState {
  const settings = resolveEnsembleParticipantSettings(participant)
  const ensemble = chat.ensemble
  const captainIds = new Set([
    ...(ensemble?.captainParticipantIds || []),
    ...(ensemble?.secondInCommandParticipantId ? [ensemble.secondInCommandParticipantId] : [])
  ])
  const authority =
    ensemble?.bossmanParticipantId === participant.id
      ? 'boss'
      : captainIds.has(participant.id)
        ? 'captain'
        : undefined

  return {
    provider: participant.provider,
    model: settings.model,
    role: participant.role,
    seatNumber: index + 1,
    reasoningEffort: settings.reasoningEffort || undefined,
    thinkingEnabled: settings.thinkingEnabled,
    permissionPresetId: settings.permissionPresetId,
    stageRole: stageRoleForSeat(participant.stageRole),
    authority
  }
}

export interface ComposerEnsembleRosterPopoverProps {
  chat: ChatRecord | null | undefined
  selectedParticipantId?: string | null
  onSelectParticipant?: (participantId: string) => void
  onPatchParticipant?: (participantId: string, patch: Partial<EnsembleParticipant>) => void
  onLiveRosterMutation?: (mutation: EnsembleUserRosterMutation) => void
  composerStyle?: ComposerStyle
  configuredProviderSnapshot?: ParticipantPickerConfiguredProviderSnapshot
  grokAvailable?: boolean
  cursorAvailable?: boolean
}

interface ComposerEnsembleRosterSeatDraft {
  enabled?: boolean
  authority?: EnsembleParticipantAuthority
  stageRole?: EnsembleParticipant['stageRole'] | null
  role?: string
  brief?: string
}

/**
 * A compact, settings-inspired roster editor for the Ensemble footer popover.
 * The shared transcript seat strip stays the source of the runtime vocabulary;
 * this component only gives that strip a compact authority + brief editing
 * surface suitable for the composer.
 */
export function ComposerEnsembleRosterPopover({
  chat,
  selectedParticipantId,
  onSelectParticipant,
  onPatchParticipant,
  onLiveRosterMutation,
  composerStyle = 'default',
  configuredProviderSnapshot,
  grokAvailable = false,
  cursorAvailable = false
}: ComposerEnsembleRosterPopoverProps): React.JSX.Element {
  const participants = [...(chat?.ensemble?.participants || [])].sort(
    (left, right) => left.order - right.order
  )
  const [drafts, setDrafts] = useState<Record<string, ComposerEnsembleRosterSeatDraft>>({})
  const [autoApprovalsEnabled, setAutoApprovalsEnabled] = useState(
    chat?.ensemble?.bossmanAutoApprovals?.enabled === true
  )
  const hasLeadership = participants.some(
    (participant) => participant.stageRole !== 'background' && participant.enabled
  )

  const updateDraft = (participantId: string, patch: ComposerEnsembleRosterSeatDraft): void => {
    setDrafts((current) => ({
      ...current,
      [participantId]: { ...current[participantId], ...patch }
    }))
  }

  const updateAuthority = (
    participantId: string,
    authority: EnsembleParticipantAuthority
  ): void => {
    updateDraft(participantId, { authority })
    onLiveRosterMutation?.({ action: 'set_authority', participantId, authority })
  }

  const updateAutoApprovals = (enabled: boolean): void => {
    if (
      enabled &&
      typeof window !== 'undefined' &&
      !window.confirm(BOSS_AUTO_APPROVAL_CONSENT_MESSAGE)
    ) {
      return
    }
    setAutoApprovalsEnabled(enabled)
    onLiveRosterMutation?.({ action: 'set_auto_approvals', enabled })
  }

  if (!chat?.ensemble || participants.length === 0) {
    return (
      <div className="composer-ensemble-roster-empty">
        Turn on Ensemble to build a roster of participants here.
      </div>
    )
  }

  return (
    <section className="composer-ensemble-roster-workspace" aria-label="Current Ensemble roster">
      <div className="composer-ensemble-roster-summary">
        <div>
          <span className="composer-ensemble-roster-eyebrow">Current roster</span>
        </div>
        <span className="composer-ensemble-roster-count">
          {participants.length} {participants.length === 1 ? 'seat' : 'seats'}
        </span>
      </div>

      <div className="composer-ensemble-roster-list" role="region" aria-label="Ensemble seats">
        <div className="composer-ensemble-roster-list-inner">
          <ol>
            {participants.map((participant, index) => {
              const draft = drafts[participant.id]
              const stageRole =
                draft?.stageRole === null ? undefined : (draft?.stageRole ?? participant.stageRole)
              const enabled = draft?.enabled ?? participant.enabled
              const roleValue = draft?.role ?? participant.role
              const editorParticipant = {
                ...participant,
                enabled,
                role: roleValue,
                stageRole
              }
              const baseSeat = ensemblePopoverSeatState(chat, editorParticipant, index)
              const authority = draft?.authority ?? baseSeat.authority ?? 'agent'
              const seat = {
                ...baseSeat,
                stageRole,
                authority: authority === 'agent' ? undefined : authority
              }
              const role = composedSeatRole(seat) || 'Untitled participant'
              const roleTitle = [participantRoleIconTitle(seat.authority, seat.stageRole), role]
                .filter(Boolean)
                .join(' · ')
              const selected = participant.id === selectedParticipantId
              const brief = draft?.brief ?? participant.instructions

              return (
                <li
                  key={participant.id}
                  className={`composer-ensemble-roster-seat${selected ? ' is-selected' : ''}${
                    enabled ? '' : ' is-disabled'
                  }`}
                >
                  <div className="composer-ensemble-roster-seat-select">
                    <button
                      type="button"
                      className="composer-ensemble-roster-seat-order"
                      onClick={() => onSelectParticipant?.(participant.id)}
                      aria-pressed={selected}
                      title={`Select ${role}`}
                    >
                      {index + 1}
                    </button>
                    <label
                      className="composer-ensemble-roster-seat-role"
                      style={{ color: seatAccentVar(seat) }}
                      title={roleTitle || undefined}
                    >
                      <ParticipantRoleIcon
                        authority={seat.authority}
                        stageRole={seat.stageRole}
                        className="seat-role-icon"
                      />
                      <span aria-hidden>{`#${index + 1}`}</span>
                      <input
                        value={roleValue}
                        onFocus={() => onSelectParticipant?.(participant.id)}
                        onChange={(event) =>
                          updateDraft(participant.id, { role: event.target.value })
                        }
                        onBlur={() => onPatchParticipant?.(participant.id, { role: roleValue })}
                        aria-label={`Role for seat ${index + 1}`}
                      />
                    </label>
                    <div
                      className="composer-ensemble-roster-seat-picker-cluster"
                      onPointerDown={() => onSelectParticipant?.(participant.id)}
                    >
                      <ParticipantPickerCluster
                        participant={editorParticipant}
                        configuredProviderSnapshot={configuredProviderSnapshot}
                        composerStyle={composerStyle}
                        grokAvailable={grokAvailable}
                        cursorAvailable={cursorAvailable}
                        onPatch={(patch) => onPatchParticipant?.(participant.id, patch)}
                        repositionOnScroll
                      />
                    </div>
                  </div>
                  <div className="composer-ensemble-roster-seat-controls">
                    <EnsembleParticipantAuthorityControls
                      participantLabel={participant.role || participant.provider}
                      enabled={enabled}
                      authority={authority}
                      backgroundRestricted={stageRole === 'background'}
                      bossDemotionDisabled={authority === 'boss'}
                      captainAssignmentDisabled={false}
                      hasLeadership={hasLeadership}
                      autoApprovalsEnabled={autoApprovalsEnabled}
                      locked={false}
                      onEnabledChange={(nextEnabled) => {
                        updateDraft(participant.id, { enabled: nextEnabled })
                        onPatchParticipant?.(participant.id, { enabled: nextEnabled })
                      }}
                      onAuthorityChange={(nextAuthority) =>
                        updateAuthority(participant.id, nextAuthority)
                      }
                      onAutoApprovalsChange={updateAutoApprovals}
                    />
                    <EnsembleParticipantStageControl
                      participantLabel={participant.role || participant.provider}
                      stageRole={stageRole}
                      backgroundDisabled={authority === 'boss'}
                      locked={false}
                      onStageRoleChange={(nextStageRole) => {
                        updateDraft(participant.id, { stageRole: nextStageRole ?? null })
                        onPatchParticipant?.(participant.id, { stageRole: nextStageRole })
                      }}
                    />
                  </div>
                  <label className="composer-ensemble-roster-seat-brief">
                    <span>Goal / brief</span>
                    <textarea
                      rows={4}
                      value={brief}
                      onChange={(event) =>
                        updateDraft(participant.id, { brief: event.target.value })
                      }
                      onBlur={() => onPatchParticipant?.(participant.id, { instructions: brief })}
                      placeholder="What should this participant focus on each turn?"
                      aria-label={`Goal / brief for ${role}`}
                    />
                  </label>
                </li>
              )
            })}
          </ol>
        </div>
      </div>

      <p className="composer-ensemble-roster-footnote">
        Select a seat to keep the composer controls in context. Scroll to refine the complete
        roster; compact chips above still support drag-to-reorder.
      </p>
    </section>
  )
}
