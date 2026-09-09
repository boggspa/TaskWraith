import type { ChatMessage, ConcurrentLaneIntent, EnsembleStageRole } from '../main/store/types'
import type { EnsembleAuthorityRole } from './ensembleAuthority'
import { resolveSeatAuthority } from './seatChange'

/** Persisted discriminator for a participant-authored `ensemble_send` note. */
export const ENSEMBLE_SIDE_MESSAGE_KIND = 'ensembleSideMessage' as const

/**
 * Inter-seat notes use a system carrier because they are emitted mid-turn and
 * must not become completed assistant turns in provider-history logic. They
 * are nevertheless participant-authored conversation, so transcript surfaces
 * promote this metadata kind to the same hierarchy as an assistant message.
 *
 * Accepting an assistant carrier as well keeps the presentation compatible
 * with imported/future records without ever promoting a tool row solely from
 * attacker-controlled metadata.
 */
export function isEnsembleSideMessage(message: ChatMessage | null | undefined): boolean {
  return (
    (message?.role === 'system' || message?.role === 'assistant') &&
    message.metadata?.kind === ENSEMBLE_SIDE_MESSAGE_KIND
  )
}

/** Narrow user-addressed side messages without trusting metadata on other carriers. */
export function isEnsembleSideMessageToUser(message: ChatMessage | null | undefined): boolean {
  return isEnsembleSideMessage(message) && message?.metadata?.toUser === true
}

export interface EnsembleSideMessageLaneMetadata {
  ensembleLaneId?: string
  ensembleSourceLaneId?: string
  ensembleLaneIntent?: ConcurrentLaneIntent
  ensembleFanoutWaveId?: string
  ensembleFanoutLabel?: string
  ensembleFanoutCategory?: 'user' | 'orchestrated'
}

/**
 * A lane-authored note to the User is deliberately a top-level conversation
 * row. Preserve its exact origin without leaving the live lane-grouping key on
 * the message. Ordinary inter-seat notes retain the existing lane metadata.
 */
export function sideMessageLaneMetadataForAudience(
  metadata: EnsembleSideMessageLaneMetadata,
  toUser: boolean
): EnsembleSideMessageLaneMetadata {
  if (!toUser || !metadata.ensembleLaneId) return metadata
  const { ensembleLaneId, ...rest } = metadata
  return { ...rest, ensembleSourceLaneId: ensembleLaneId }
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Routing header
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `EnsembleOrchestrator.sendSideMessageForRun` writes the route into the
 * message BODY as prose — `↪ Boss to Capt: …` — so the transcript's first
 * question ("who said this to whom") is answered in the same run of text as
 * its last ("what did they say"). It reads as a wall, and it cannot be
 * scanned: a reader looking for the note that reached them has to read every
 * body in the round.
 *
 * The route does not have to be parsed. The same call stamps `fromRole`,
 * `fromProvider`, `toRoles`, `toProviders`, `toParticipantIds`, `toUser` and
 * `reason` into `metadata` alongside the prose, so the structured answer is
 * already on the row. Parsing is the FALLBACK, for rows persisted before that
 * metadata existed — and, in both paths, the way the duplicate prefix is
 * removed from the body so it is not shown twice.
 */

/** One end of a route. `label` is the display name resolved as far as shared
 *  code can take it; an empty one means only the renderer's provider naming can
 *  finish it, which is deliberate — provider labels live in the renderer. */
export interface EnsembleSideMessageParty {
  label: string
  role: string
  seatNumber?: number
  provider?: string
  /**
   * Read ONLY to resolve the provider hue, never displayed. An Ollama or Pi
   * seat wears its upstream brand's colour, and that override needs a model to
   * resolve; without one those two providers silently fall back to the walnut
   * and slate base hues while every other seat surface shows the brand. The
   * sender's comes off the row, a recipient's off the live roster — a stale
   * model picks a colour, never a claim.
   */
  brandModel?: string
  authority?: EnsembleAuthorityRole
  stageRole?: EnsembleStageRole
  participantId?: string
}

export interface EnsembleSideMessageRoute {
  from: EnsembleSideMessageParty
  /** Participant recipients only; the user is `toUser`, never a party here. */
  to: EnsembleSideMessageParty[]
  toUser: boolean
  /**
   * The route was recovered from the content prefix because the row carried no
   * `fromRole`/`toRoles`. Such a party has a label and nothing else — no seat
   * number, no glyph — because a label is genuinely all the prose records.
   */
  fromPrefix: boolean
}

/**
 * The roster fields the route decoder reads — a structural subset of
 * `EnsembleConfig`, so a fixture does not have to satisfy the rest of it.
 *
 * Seat ORDINALS and authority are the only things read from live config, and
 * only ever by participant id: the id match is what makes `#3` true. Role,
 * provider and the message text itself stay on the snapshot the row was
 * written with, so a seat renamed since the note was sent still shows the name
 * it sent under.
 */
export interface EnsembleSideMessageRoster {
  participants?: readonly { id: string; order?: number; stageRole?: string; model?: string }[]
  bossmanParticipantId?: string | null
  captainParticipantIds?: readonly string[] | null
}

/** The recipient label the orchestrator writes for a user-addressed note. */
const SIDE_MESSAGE_USER_LABEL = 'User'

function sideMessageText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sideMessageStageRole(value: unknown): EnsembleStageRole | undefined {
  const stage = sideMessageText(value)
  return stage === 'scout' || stage === 'worker' || stage === 'reviewer' || stage === 'background'
    ? stage
    : undefined
}

function sideMessageStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => sideMessageText(entry)) : []
}

function positiveSeatNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined
}

/** `#3 Reviewer` — the same composition every other seat surface uses. */
function sideMessagePartyLabel(role: string, seatNumber?: number): string {
  if (!role) return ''
  return seatNumber ? `#${seatNumber} ${role}` : role
}

function sideMessageParty(input: {
  role: string
  provider: string
  participantId: string
  brandModel?: string
  stageRole?: EnsembleStageRole
  roster?: EnsembleSideMessageRoster | null
}): EnsembleSideMessageParty {
  const participant = input.participantId
    ? (input.roster?.participants || []).find(
        (candidate) => sideMessageText(candidate.id) === input.participantId
      )
    : undefined
  const seatNumber = positiveSeatNumber(participant?.order)
  const brandModel = input.brandModel || sideMessageText(participant?.model)
  const stageRole = input.stageRole ?? sideMessageStageRole(participant?.stageRole)
  // Chat-level, so it can never come off the participant record — the same
  // resolver the fan-out lane card and the approval modal use, so a Boss wears
  // its crown here exactly as it does there.
  const authority = input.participantId
    ? resolveSeatAuthority({
        participantId: input.participantId,
        stageRole: stageRole ?? null,
        bossmanParticipantId: input.roster?.bossmanParticipantId,
        captainParticipantIds: input.roster?.captainParticipantIds
      })
    : undefined
  return {
    label: sideMessagePartyLabel(input.role, seatNumber),
    role: input.role,
    ...(seatNumber ? { seatNumber } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(brandModel ? { brandModel } : {}),
    ...(authority ? { authority } : {}),
    ...(stageRole ? { stageRole } : {}),
    ...(input.participantId ? { participantId: input.participantId } : {})
  }
}

/**
 * The prose prefix, as a match over the FIRST LINE only.
 *
 * Both captures are lazy and newline-free, so the sender ends at the first
 * ` to ` and the recipients at the first `: ` — which is exactly the producer's
 * shape. Where `fromRole` is known the caller pins the sender half against it
 * before trusting the match, so a role containing either separator degrades to
 * "leave the body alone" rather than to a truncated body.
 */
const SIDE_MESSAGE_PREFIX = /^↪ ([^\n]+?) to ([^\n]+?): /

/**
 * Who sent this note and who it reached.
 *
 * Returns null for a row that is not an inter-seat note, and for one whose
 * route cannot be recovered from either metadata or prose — the caller then
 * keeps the plain provider label it has always shown, which is honest about
 * knowing less rather than inventing a sender.
 */
export function ensembleSideMessageRoute(
  message: ChatMessage | null | undefined,
  roster?: EnsembleSideMessageRoster | null
): EnsembleSideMessageRoute | null {
  if (!isEnsembleSideMessage(message) || !message) return null
  const metadata = message.metadata || {}
  const toUser = metadata.toUser === true
  // `from*` is what the send call stamps; `ensemble*` is the row's own seat
  // identity, carried by every ensemble row and the only sender a note written
  // before the routing fields has. Same seat either way — the orchestrator
  // writes both from one participant — so the fallback recovers a name rather
  // than guessing one.
  const fromRole = sideMessageText(metadata.fromRole) || sideMessageText(metadata.ensembleRole)
  const fromProvider =
    sideMessageText(metadata.fromProvider) || sideMessageText(metadata.ensembleProvider)
  const fromParticipantId =
    sideMessageText(metadata.fromParticipantId) || sideMessageText(metadata.ensembleParticipantId)
  const toRoles = sideMessageStrings(metadata.toRoles)
  const toProviders = sideMessageStrings(metadata.toProviders)
  const toParticipantIds = sideMessageStrings(metadata.toParticipantIds)

  if (fromRole || fromProvider) {
    const from = sideMessageParty({
      role: fromRole,
      provider: fromProvider,
      participantId: fromParticipantId,
      brandModel: sideMessageText(metadata.ensembleModel),
      stageRole: sideMessageStageRole(metadata.ensembleStageRole),
      roster
    })
    // Recipient count comes from whichever list the row actually carries:
    // `toRoles` holds an empty string for a seat with no role, and a row
    // written before roles were stamped carries only providers.
    const recipientCount = Math.max(toRoles.length, toProviders.length, toParticipantIds.length)
    const to = Array.from({ length: recipientCount }, (_unused, index) =>
      sideMessageParty({
        role: toRoles[index] || '',
        provider: toProviders[index] || '',
        participantId: toParticipantIds[index] || '',
        roster
      })
    )
    return { from, to, toUser, fromPrefix: false }
  }

  // Fallback: a row persisted before the routing metadata existed. The prose
  // is all there is, so every party is a bare label.
  const match = SIDE_MESSAGE_PREFIX.exec(sideMessageText(message.content))
  if (!match) return null
  const parsedRecipients = match[2]
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  const parsedToUser = parsedRecipients.some((entry) => entry === SIDE_MESSAGE_USER_LABEL)
  return {
    from: { label: match[1].trim(), role: '' },
    to: parsedRecipients
      .filter((entry) => entry !== SIDE_MESSAGE_USER_LABEL)
      .map((entry) => ({ label: entry, role: '' })),
    toUser: toUser || parsedToUser,
    fromPrefix: true
  }
}

/**
 * The note's own words, with the routing prefix and the trailing reason line
 * lifted out of them.
 *
 * The prefix is only removed when its sender half agrees with `fromRole`, or
 * when there is no `fromRole` to disagree with. That is what keeps a role
 * containing `: ` or ` to ` from costing the reader the front of the body: an
 * unrecognised prefix stays in the text, where it is merely redundant.
 *
 * The reason is matched against `metadata.reason` rather than against the word
 * "Reason:", so a body that happens to end on a line beginning that way is left
 * exactly as its author wrote it.
 */
export function ensembleSideMessageBody(message: ChatMessage | null | undefined): {
  body: string
  reason: string
} {
  const content = typeof message?.content === 'string' ? message.content : ''
  const reason = sideMessageText(message?.metadata?.reason)
  let body = content
  const match = SIDE_MESSAGE_PREFIX.exec(body)
  const fromRole = sideMessageText(message?.metadata?.fromRole)
  if (match && (!fromRole || match[1].trim() === fromRole)) {
    body = body.slice(match[0].length)
  }
  if (reason) {
    const suffix = `\nReason: ${reason}`
    if (body.endsWith(suffix)) body = body.slice(0, body.length - suffix.length)
  }
  return { body: body.trim(), reason }
}
