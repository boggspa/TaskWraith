/**
 * The speaker line for an inter-seat note (`ensemble_send`).
 *
 * Every other assistant-level row answers "who spoke" and stops there, because
 * that is the whole question. An inter-seat note has a second half — who it was
 * sent TO — and until now the answer lived in the body as prose (`↪ Boss to
 * Capt: …`), competing with the note's own words and unscannable down a round.
 *
 * So this row's meta line carries the route instead of a provider name, drawn
 * with the vocabulary every other seat surface already uses: the authority or
 * stage glyph from `ParticipantRoleIcon`, `#N Role`, and the seat's provider
 * accent, exactly as the seat-change row and the close-out table name a seat.
 * A reader who has learned to read one has learned to read this.
 *
 * Deliberately NOT the composer chip cluster the close-out table shows. Those
 * chips state a seat's CONFIGURATION, and the route is asking a different
 * question — an inter-seat note is a line in a conversation, not a record of
 * how a seat was set up. The name is what identifies a speaker here.
 */

import type { CSSProperties, JSX } from 'react'
import type { ChatMessage, ProviderId } from '../../../main/store/types'
import type {
  EnsembleSideMessageParty,
  EnsembleSideMessageRoster
} from '../../../shared/ensembleSideMessage'
import { ensembleSideMessageRoute } from '../../../shared/ensembleSideMessage'
import { resolveProviderBrandLabel, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { getProviderLabel } from '../lib/providerLabels'
import { ParticipantRoleIcon, participantRoleIconTitle } from './icons/ParticipantRoleIcon'

/**
 * Named recipients before the overflow count.
 *
 * A fan-out note reaches eight seats, and eight accent-tinted names is not a
 * route any more — it is a second sentence above the one the reader came for.
 * Three names plus "+5" keeps the line one line at a transcript's width, and
 * the full list stays reachable in the row's title.
 */
const MAX_NAMED_RECIPIENTS = 3

/** Same local formatter every other change row in this directory carries. */
function formatSideMessageTime(timestamp: string | undefined): string {
  if (!timestamp) return ''
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** The route separator. A glyph rather than the "→" character: at the meta
 *  line's size the character sits on the text baseline and reads as part of the
 *  sender's name, where a sized SVG stays centred between the two. */
function SideMessageRouteArrow(): JSX.Element {
  return (
    <span className="ensemble-side-route-arrow" aria-hidden>
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        <path d="M4.5 12h14" />
        <path d="m13.5 6.8 5.2 5.2-5.2 5.2" />
      </svg>
    </span>
  )
}

/** The reader, as a recipient. No provider accent and no seat glyph: the user
 *  is not a seat, and tinting them like one would claim a roster row that does
 *  not exist. */
function SideMessageUserParty(): JSX.Element {
  return (
    <span className="ensemble-side-party is-user">
      <svg
        className="ensemble-side-party-icon"
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="8" r="3.6" />
        <path d="M4.8 20c0-3.6 3.2-5.6 7.2-5.6s7.2 2 7.2 5.6" />
      </svg>
      You
    </span>
  )
}

/**
 * The display name for one end of the route.
 *
 * `label` is the role composed with its seat number where shared code could
 * resolve one. It is empty for a seat that never had a role, and for a party
 * recovered from prose that turned out to be a provider label — in both cases
 * the provider name is the honest answer, and it is resolved here because
 * provider naming is renderer-owned.
 *
 * The brand label comes first for the same reason it does in `seatSideView`: a
 * local seat running Qwen is called Qwen, not Ollama, on every other surface.
 */
export function sideMessagePartyName(party: EnsembleSideMessageParty): string {
  if (party.label) return party.label
  if (!party.provider) return ''
  return (
    resolveProviderBrandLabel(party.provider, party.brandModel) ||
    getProviderLabel(party.provider as ProviderId)
  )
}

function SideMessageParty({ party }: { party: EnsembleSideMessageParty }): JSX.Element | null {
  const name = sideMessagePartyName(party)
  if (!name) return null
  const hue = party.provider ? resolveProviderHueClass(party.provider, party.brandModel || '') : ''
  return (
    <span
      className="ensemble-side-party"
      style={
        hue
          ? ({ color: `var(--provider-${hue}-color, var(--accent))` } as CSSProperties)
          : undefined
      }
      title={participantRoleIconTitle(party.authority, party.stageRole) || undefined}
    >
      <ParticipantRoleIcon
        authority={party.authority}
        stageRole={party.stageRole}
        className="ensemble-side-party-icon"
      />
      {name}
    </span>
  )
}

/**
 * The whole route, for a screen reader and for the title on an elided list.
 * Reads as the sentence the prose used to be, which is the one thing the prose
 * was good at.
 */
export function sideMessageRouteText(from: string, recipients: string[], toUser: boolean): string {
  const audience = [...(toUser ? ['You'] : []), ...recipients].filter(Boolean)
  return audience.length > 0 ? `${from} to ${audience.join(', ')}` : from
}

export function EnsembleSideMessageMeta({
  message,
  roster
}: {
  message: ChatMessage
  /** The live roster, read only for seat ordinals, authority and brand hue. */
  roster?: EnsembleSideMessageRoster | null
}): JSX.Element | null {
  const route = ensembleSideMessageRoute(message, roster)
  // No recoverable route: the caller keeps whatever speaker label it already
  // showed. Naming a sender we cannot name is worse than the wall of text.
  if (!route) return null
  const fromName = sideMessagePartyName(route.from)
  if (!fromName) return null

  const named = route.to.slice(0, MAX_NAMED_RECIPIENTS)
  const elided = route.to.length - named.length
  const allRecipientNames = route.to.map(sideMessagePartyName).filter(Boolean)
  const routeText = sideMessageRouteText(fromName, allRecipientNames, route.toUser)
  // Always shown, unlike the hover-revealed footer time: these notes are
  // coordination, and when one arrived relative to the round is part of what
  // it says. The seat-change row ends on its time for the same reason.
  const time = formatSideMessageTime(message.timestamp)

  return (
    <div className="message-meta ensemble-side-message-meta" aria-label={routeText}>
      <SideMessageParty party={route.from} />
      {(route.toUser || named.length > 0) && <SideMessageRouteArrow />}
      {/* The user leads the audience, as the orchestrator writes it into the
          prose: a note that reached the reader is about them first. */}
      {route.toUser && <SideMessageUserParty />}
      {named.map((party, index) => (
        <SideMessageParty key={party.participantId || `${party.label}:${index}`} party={party} />
      ))}
      {elided > 0 && (
        <span className="ensemble-side-route-more" title={routeText}>
          +{elided}
        </span>
      )}
      {time && <span className="ensemble-side-route-time">{time}</span>}
    </div>
  )
}
