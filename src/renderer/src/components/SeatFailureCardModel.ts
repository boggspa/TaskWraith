/**
 * SeatFailureCardModel — pure classification, copy, and run-event extraction
 * for the participant-failure transcript card.
 *
 * WHAT THIS REPLACES. When an ensemble seat finishes `failed`, the
 * orchestrator appends a coda line like "Review 1 failed." and nothing else.
 * The person watching the round learns THAT the seat died but never why —
 * the stderr is captured in the run events, just never surfaced. This model
 * turns the coda into the same calm card shape as the run-error card
 * (kicker, plain title, honest body, disclosure) and names where the
 * captured output comes from.
 *
 * DATA PATH. The card's "Technical details" disclosure reads
 * `provider_error` / `provider_exit` run events for the message's own
 * `runId` — the same events the Raw Events view already renders — through
 * the shared `rawLogFromRunEvent` mapping, so redaction and bucketing stay
 * identical to what that view shows. Nothing is re-captured for the card.
 *
 * Pure throughout: every decision a human reads is derivable without a DOM.
 */

import type { ChatMessage, ProviderId, RunEventRecord } from '../../../main/store/types'
import { getProviderLabel } from '../lib/providerLabels'
import { rawLogFromRunEvent } from '../lib/rawLogEntry'
import {
  classifyFailureRemedy,
  describeFailureRemedyCopy,
  type FailureRemedyKind
} from '../lib/runFailureRemedy'
import type { RunErrorDescription } from './RunExecutionErrorCardModel'

/** The orchestrator's participant coda kinds this card handles. */
export function isFailedParticipantStatusMessage(
  msg: Pick<ChatMessage, 'role' | 'metadata'>
): boolean {
  return (
    msg.role === 'system' &&
    msg.metadata?.kind === 'ensembleParticipantStatus' &&
    msg.metadata?.ensembleStatus === 'failed'
  )
}

/** The seat's display name — role first, provider as fallback, never empty. */
export function seatFailureSeatLabel(msg: Pick<ChatMessage, 'metadata'>): string {
  const role = msg.metadata?.ensembleRole
  if (typeof role === 'string' && role.trim()) return role.trim()
  const provider = msg.metadata?.ensembleProvider as ProviderId | undefined
  if (provider) return getProviderLabel(provider)
  return 'A participant'
}

/** The roster id the coda names, when it names one — the Retry target. */
export function seatFailureParticipantId(msg: Pick<ChatMessage, 'metadata'>): string | undefined {
  const id = msg.metadata?.ensembleParticipantId
  return typeof id === 'string' && id.trim() ? id : undefined
}

/** The seat's provider, when the coda carries one — the remedy target. */
export function seatFailureProvider(msg: Pick<ChatMessage, 'metadata'>): ProviderId | undefined {
  return msg.metadata?.ensembleProvider as ProviderId | undefined
}

/**
 * Classify the seat's failure cause from whichever text is available — the
 * coda's own reason suffix first, then the captured stderr once it loads.
 * The card upgrades its remedy row when this flips from null to a family.
 */
export function classifySeatFailureRemedy(
  ...texts: ReadonlyArray<string | undefined>
): FailureRemedyKind | null {
  for (const text of texts) {
    const remedy = classifyFailureRemedy(text ?? '')
    if (remedy) return remedy
  }
  return null
}

/** The left-slot note for a classified seat remedy. Delegates to the shared
 * template pool so note and headline never disagree. */
export function seatFailureRemedyNote(
  remedy: FailureRemedyKind,
  provider: ProviderId | undefined
): string {
  const label = provider ? getProviderLabel(provider) : 'This provider'
  return (
    describeFailureRemedyCopy(remedy, {
      subject: label,
      providerLabel: label,
      surface: 'seat'
    }).note ?? ''
  )
}

export function describeSeatFailure(
  msg: Pick<ChatMessage, 'content' | 'metadata'>,
  remedy?: FailureRemedyKind | null
): RunErrorDescription {
  const seat = seatFailureSeatLabel(msg)
  if (remedy) {
    // Deterministic template pool — the headline names the cause ("Codex hit
    // a usage limit") instead of every failure wearing the same generic
    // "couldn't finish" title.
    const provider = seatFailureProvider(msg)
    const copy = describeFailureRemedyCopy(remedy, {
      subject: seat,
      ...(provider ? { providerLabel: getProviderLabel(provider) } : {}),
      surface: 'seat'
    })
    return {
      kind: 'seat-failed',
      kicker: 'Participant error',
      title: copy.title,
      body: copy.body,
      raw: (msg.content || '').trim(),
      ...(copy.note ? { note: copy.note } : {})
    }
  }
  return {
    kind: 'seat-failed',
    kicker: 'Participant error',
    title: `${seat} couldn't finish this turn`,
    body: 'This seat stopped before completing its reply. The rest of the transcript is intact — the captured error output from the run events is below if you need it.',
    raw: (msg.content || '').trim()
  }
}

/**
 * Disclosure text when no run events were captured for the seat. The status
 * line itself is always shown underneath it, so the disclosure never opens
 * to a void.
 */
export const SEAT_FAILURE_EMPTY_DETAIL_NOTE =
  'No captured error output was found for this seat in the run events.'

/** Bounds so a pathological stderr flood cannot out-grow the disclosure. */
export const SEAT_FAILURE_DETAIL_MAX_CHARS = 24_000

export interface SeatFailureDetail {
  readonly text: string
  /** True when stderr existed but the tail had to be cut to the bound. */
  readonly truncated: boolean
}

/**
 * Extract the verbose stderr for the seat's run from its persisted events.
 * `provider_error` events are the stderr bucket (per `rawLogFromRunEvent`);
 * when none exist, `provider_exit` info lines are the next most honest thing
 * (a non-zero exit usually explains the failure when stderr stayed silent).
 * Returns null when neither produced any text — the caller shows the
 * empty-note + status-line fallback instead of an empty box.
 */
export function seatFailureDetailFromRunEvents(
  events: readonly RunEventRecord[]
): SeatFailureDetail | null {
  const entries = events
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((event) => rawLogFromRunEvent(event))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  const stderr = entries.filter((entry) => entry.type === 'stderr')
  const chosen = stderr.length > 0 ? stderr : entries.filter((entry) => entry.type === 'info')
  const text = chosen
    .map((entry) => entry.content.trim())
    .filter(Boolean)
    .join('\n')
  if (!text) return null
  if (text.length <= SEAT_FAILURE_DETAIL_MAX_CHARS) return { text, truncated: false }
  return { text: text.slice(text.length - SEAT_FAILURE_DETAIL_MAX_CHARS), truncated: true }
}
