/**
 * View model for inbound peer thread messages (S7).
 *
 * The presentation decision this encodes, and the reason it is a tested model
 * rather than JSX: an inbound message must NOT read as a system or operator
 * message. It is prose another thread wrote, and the transcript already has a
 * visual language for "output from a peer lane" — the fan-out lane card. So every
 * row is attributed to a named thread, and `attribution` is a closed union with no
 * 'system' member, so no future edit can quietly restyle these as app-authored.
 *
 * That is not cosmetic. A seat reading its own transcript, and a user skimming it,
 * both decide how much authority to give a line by how it is presented. Styling a
 * peer's request like a system instruction is the UI half of the same
 * prompt-injection problem `ThreadMessageContext` handles for the model.
 */

import type { ThreadMessageInboxSummary } from '../../../shared/threadMessage'
import type { SeatChangeSeatState } from '../../../shared/seatChange'

/**
 * Who a row is from, as far as the UI is concerned. Deliberately has no 'system'
 * or 'operator' member: a relayed message can only ever be attributed to a peer
 * thread, whoever composed it there.
 */
export type ThreadMessageAttribution = 'peer-thread-user' | 'peer-thread-agent'

export interface ThreadMessageCardModel {
  id: string
  /** Display name of the sending thread. Never used for routing. */
  senderLabel: string
  attribution: ThreadMessageAttribution
  /**
   * The full sentence, e.g. 'Sent by the agent in “Byte pin fix”'.
   *
   * No longer drawn: the header renders `leadLabel` + 'from' + `senderLabel`
   * across two lines. It survives as the card's ACCESSIBLE NAME, because the
   * visual layout splits the same fact across several spans and a screen reader
   * should get one coherent sentence rather than fragments.
   */
  headerText: string
  /**
   * Who sent it, for the start of line 1 — the seat's role where there is one,
   * else an honest generic. Never a seat number: `seatNumber` is roster-local,
   * so a peer sender's "#3" names a position in a roster the reader is not in.
   */
  leadLabel: string
  body: string
  /** True when the sender asked this thread to start a turn. */
  requestsWake: boolean
  /** True when the stored body was clamped, so the reader knows it is partial. */
  truncated: boolean
  createdAt: number
  /**
   * The sending seat, when one was captured. Absent for user-composed sends,
   * for senders whose provider/model could not both be resolved, and for every
   * record written before capture existed — the card drops line 2 entirely
   * rather than rendering an identity-shaped strip that says nothing.
   */
  seat?: SeatChangeSeatState
}

export interface ThreadMessageIndicatorModel {
  /** Undelivered count; 0 means render nothing. */
  count: number
  /** Sidebar badge text. Capped so a runaway inbox cannot stretch the row. */
  badge: string
  /** Hover/accessible description naming the senders. */
  title: string
  /** True when any pending message asked this thread to run now. */
  urgent: boolean
}

export interface ThreadMessageCardInput {
  id: string
  fromChatId: string
  fromChatTitle: string
  origin: 'user' | 'agent'
  body: string
  requestedDelivery: 'queue' | 'wake'
  createdAt: number
  truncated?: boolean
  /**
   * The sending seat as it was configured when it sent, for the card's "who
   * sent this" heading. Absent for user-composed sends (there is no agent seat
   * to describe), for solo senders whose provider/model could not both be
   * resolved, and for every record written before capture existed — all three
   * render the seatless heading rather than an empty strip.
   */
  seat?: SeatChangeSeatState
}

/** Badge text stops counting up past this; the exact number stops mattering. */
export const MAX_THREAD_MESSAGE_BADGE_COUNT = 9

function senderLabelFor(input: { fromChatTitle: string; fromChatId: string }): string {
  const title = input.fromChatTitle.trim()
  if (title) return title
  const id = input.fromChatId.trim()
  return id || 'another thread'
}

export function threadMessageCardModel(input: ThreadMessageCardInput): ThreadMessageCardModel {
  const senderLabel = senderLabelFor(input)
  const attribution: ThreadMessageAttribution =
    input.origin === 'user' ? 'peer-thread-user' : 'peer-thread-agent'
  // Both phrasings name the sending THREAD. The user-composed case still says
  // which thread it came from rather than reading as a direct instruction from
  // the operator of this one.
  const headerText =
    input.origin === 'user'
      ? `You sent this from “${senderLabel}”`
      : `Sent by the agent in “${senderLabel}”`
  // Line 1 leads with WHO. A user-composed relay says "You" — still followed by
  // "from <thread>", so it reads as coming from elsewhere rather than as a
  // direct instruction in this thread. An agent seat leads with its role; with
  // no role (a solo sender has no roster) it falls back to a generic rather
  // than inventing an identity.
  const leadLabel =
    input.origin === 'user' ? 'You' : (input.seat?.role || '').trim() || 'An agent'
  return {
    id: input.id,
    senderLabel,
    attribution,
    headerText,
    leadLabel,
    ...(input.seat ? { seat: input.seat } : {}),
    body: input.body,
    requestsWake: input.requestedDelivery === 'wake',
    truncated: input.truncated === true,
    createdAt: input.createdAt
  }
}

export function threadMessageIndicatorModel(
  summary: ThreadMessageInboxSummary
): ThreadMessageIndicatorModel {
  const count = Math.max(0, summary.pendingCount)
  const senders = summary.senders.filter((entry) => entry.trim())
  const who = senders.length > 0 ? senders.join(', ') : 'another thread'
  const noun = count === 1 ? 'message' : 'messages'
  return {
    count,
    badge:
      count > MAX_THREAD_MESSAGE_BADGE_COUNT ? `${MAX_THREAD_MESSAGE_BADGE_COUNT}+` : String(count),
    title:
      count === 0
        ? 'No thread messages'
        : summary.hasWakeRequest
          ? `${count} thread ${noun} from ${who}; one asks this thread to start a turn`
          : `${count} thread ${noun} from ${who}`,
    urgent: count > 0 && summary.hasWakeRequest
  }
}
