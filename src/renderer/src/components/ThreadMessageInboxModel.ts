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
  /** Short prose for the card header, e.g. 'Sent by someone in “Byte pin fix”'. */
  headerText: string
  body: string
  /** True when the sender asked this thread to start a turn. */
  requestsWake: boolean
  /** True when the stored body was clamped, so the reader knows it is partial. */
  truncated: boolean
  createdAt: number
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
  return {
    id: input.id,
    senderLabel,
    attribution,
    headerText,
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
