import type { ReactElement } from 'react'
import type { SeatChangeSeatState } from '../../../shared/seatChange'
import { composedSeatRole } from '../lib/transcriptSeat'
import { ParticipantRoleIcon, participantRoleIconTitle } from './icons/ParticipantRoleIcon'
import { SeatStateChips, seatAccentVar } from './SeatChangeRow'

/**
 * Who asked an `ask_user_question` — the seat element, shared by the live card
 * and its tombstone.
 *
 * It used to be the provider label: "Claude asked". In a round of one that is
 * merely redundant; in a round of fifty it is useless, because six seats can be
 * Claude and the one that stopped to ask is the only one the answer is FOR. The
 * seat element is how every other transcript surface answers "which participant
 * produced this" — the close-out table, the fan-out lane card, the sub-thread
 * return and the peer thread-message card — so a question answers it the same
 * way rather than inventing a sixth vocabulary.
 *
 * Role first, in the seat's own accent (`seatAccentVar`, never re-derived — the
 * hue resolves from the humanised model label, and deriving it any other way is
 * how the role and the chips beside it drift apart on exactly the Ollama and Pi
 * seats). Then the config chips. Then the verb, so the whole line reads as one
 * sentence: "#15 GrokCapt · Cursor · Grok 4.5 · High · Full WS Access asked".
 *
 * A seatless asker keeps the plain label. That is not a degraded path — solo
 * turns and chat-level runs genuinely have no seat, and 11 of the 15 questions
 * in the real chat store are exactly that.
 */
export interface AgentQuestionAskerProps {
  seat: SeatChangeSeatState | null
  /** Fallback when no seat resolves — already labelled ("Codex"). */
  providerLabel?: string
  /** Trailing verb. The tombstone reports a past decision, the live card an open
   *  one, and the tense is the only difference between them. */
  verb?: string
}

export function AgentQuestionAsker({
  seat,
  providerLabel,
  verb = 'asked'
}: AgentQuestionAskerProps): ReactElement {
  if (!seat) {
    return (
      <div className="agent-question-card-settled-kicker">{`${providerLabel || 'Agent'} ${verb}`}</div>
    )
  }
  const seatRole = composedSeatRole(seat)
  const roleTitle = [participantRoleIconTitle(seat.authority, seat.stageRole), seatRole]
    .filter(Boolean)
    .join(' · ')
  return (
    // Its own class rather than the kicker's: that rule sets `color` and
    // `text-transform: uppercase`, and the element tolerates neither. Uppercase
    // would shout model names the composer renders in their real case, and a
    // colour on the wrapper is what kills the provider hue, the permission tint
    // and the reasoning shimmer flowing into `.seat-change-chip`.
    <div className="agent-question-card-asker">
      {seatRole && (
        <strong
          className="agent-question-card-asker-role"
          style={{ color: seatAccentVar(seat) }}
          title={roleTitle || undefined}
        >
          <ParticipantRoleIcon
            authority={seat.authority}
            stageRole={seat.stageRole}
            className="seat-role-icon"
          />
          {seatRole}
        </strong>
      )}
      <SeatStateChips seat={seat} className="agent-question-card-asker-seat" />
      <span className="agent-question-card-asker-verb">{verb}</span>
    </div>
  )
}
