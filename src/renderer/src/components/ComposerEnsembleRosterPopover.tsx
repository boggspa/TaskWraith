import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'
import type { SeatChangeSeatState } from '../../../shared/seatChange'
import { resolveEnsembleParticipantSettings } from '../lib/ensembleProviderDefaults'
import { composedSeatRole } from '../lib/transcriptSeat'
import { ParticipantRoleIcon, participantRoleIconTitle } from './icons/ParticipantRoleIcon'
import { SeatStateChips, seatAccentVar } from './SeatChangeRow'

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
}

/**
 * The first browser-reviewable roster workspace for the Ensemble footer
 * popover. It intentionally only selects the active composer seat for now:
 * the established chip editor remains live while this full-height hierarchy is
 * reviewed, so the mock never removes a working edit path ahead of approval.
 */
export function ComposerEnsembleRosterPopover({
  chat,
  selectedParticipantId,
  onSelectParticipant
}: ComposerEnsembleRosterPopoverProps): React.JSX.Element {
  const participants = [...(chat?.ensemble?.participants || [])].sort(
    (left, right) => left.order - right.order
  )

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
          <p>
            Review every seat in speaking order, with its runtime posture and goal in one place.
          </p>
        </div>
        <span className="composer-ensemble-roster-count">
          {participants.length} {participants.length === 1 ? 'seat' : 'seats'}
        </span>
      </div>

      <div className="composer-ensemble-roster-list" role="region" aria-label="Ensemble seats">
        <div className="composer-ensemble-roster-list-inner">
          <div className="composer-ensemble-roster-columns" aria-hidden="true">
            <span>Order</span>
            <span>Role</span>
            <span>Runtime posture</span>
            <span>Goal</span>
          </div>
          <ol>
            {participants.map((participant, index) => {
              const seat = ensemblePopoverSeatState(chat, participant, index)
              const role = composedSeatRole(seat) || 'Untitled participant'
              const roleTitle = [participantRoleIconTitle(seat.authority, seat.stageRole), role]
                .filter(Boolean)
                .join(' · ')
              const selected = participant.id === selectedParticipantId

              return (
                <li key={participant.id}>
                  <button
                    type="button"
                    className={`composer-ensemble-roster-seat${selected ? ' is-selected' : ''}${
                      participant.enabled ? '' : ' is-disabled'
                    }`}
                    onClick={() => onSelectParticipant?.(participant.id)}
                    aria-pressed={selected}
                    title={`Select ${role}`}
                  >
                    <span
                      className="composer-ensemble-roster-seat-order"
                      aria-label={`Seat ${index + 1}`}
                    >
                      <span aria-hidden>⠿</span>
                      {index + 1}
                    </span>
                    <span
                      className="composer-ensemble-roster-seat-role"
                      style={{ color: seatAccentVar(seat) }}
                      title={roleTitle || undefined}
                    >
                      <ParticipantRoleIcon
                        authority={seat.authority}
                        stageRole={seat.stageRole}
                        className="seat-role-icon"
                      />
                      <span>{role}</span>
                      {!participant.enabled ? <small>Paused</small> : null}
                    </span>
                    <SeatStateChips seat={seat} className="composer-ensemble-roster-seat-state" />
                    <span className="composer-ensemble-roster-seat-goal">
                      {participant.instructions.trim() || 'No goal set for this seat.'}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
      </div>

      <p className="composer-ensemble-roster-footnote">
        Select a seat to keep the composer controls in context. The compact chips above still
        support drag-to-reorder while this expanded roster workspace is being reviewed.
      </p>
    </section>
  )
}
