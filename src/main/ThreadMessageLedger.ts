/**
 * Durable storage shape for peer thread-to-thread messages (S2).
 *
 * Kept OUT of `ChatRecord` deliberately. Two reasons:
 *
 *  1. Main-owned chat fields have to join `saveChat`'s strip-and-remerge, and any
 *     field that forgets to is silently erased the next time the renderer saves
 *     that chat. An inbox that loses messages without an error is worse than one
 *     that does not exist.
 *  2. Message bodies would inflate chat-list projections and transcript files for
 *     every consumer that only wanted a title.
 *
 * `SubThreadMailbox` already made this call for the child→parent direction and
 * stores its mailboxes in a separate ledger keyed by chat id; this is the same
 * shape for the peer direction, so the two inbound paths stay recognisable.
 *
 * Pure and node-free apart from the id hash: the store owns the file, S3 owns
 * permission, S4 owns delivery. Everything here is a value transformation, so
 * the erasure and overflow rules can be tested without Electron.
 */

import { createHash } from 'crypto'
import {
  classifyThreadMessageEnqueue,
  emptyThreadMessageInbox,
  enqueueThreadMessage,
  normalizeThreadMessageInbox,
  pendingThreadMessages,
  type ThreadMessageEnqueueOutcome,
  type ThreadMessageEvent,
  type ThreadMessageInbox
} from '../shared/threadMessage'

export const THREAD_MESSAGE_LEDGER_SCHEMA_VERSION = 1 as const

/**
 * What a send attempt actually did, as reported back to the sender. Extends the
 * pure model's queue outcomes with the one refusal only main can decide: the
 * shared model knows nothing about which chats exist.
 */
export type ThreadMessageDeliveryOutcome = ThreadMessageEnqueueOutcome | 'unknown-target'

export interface ThreadMessageLedger {
  schemaVersion: typeof THREAD_MESSAGE_LEDGER_SCHEMA_VERSION
  /** Keyed by RECEIVING chat id. */
  inboxes: Record<string, ThreadMessageInbox>
}

export interface ThreadMessageLedgerEnqueueResult {
  ledger: ThreadMessageLedger
  outcome: ThreadMessageEnqueueOutcome
  inbox: ThreadMessageInbox
}

export interface ThreadMessageLedgerAcknowledgeResult {
  ledger: ThreadMessageLedger
  acknowledgedIds: string[]
  inbox: ThreadMessageInbox
}

export interface ThreadMessageLedgerPurgeResult {
  ledger: ThreadMessageLedger
  changed: boolean
}

function inboxMap(): Record<string, ThreadMessageInbox> {
  // Null prototype: keys come from disk, so `__proto__` and friends must be inert
  // rather than reachable assignment targets.
  return Object.create(null) as Record<string, ThreadMessageInbox>
}

export function emptyThreadMessageLedger(): ThreadMessageLedger {
  return { schemaVersion: THREAD_MESSAGE_LEDGER_SCHEMA_VERSION, inboxes: inboxMap() }
}

/**
 * An inbox with nothing pending and an empty ledger carries no information, so it
 * is dropped rather than accumulating one entry per chat that ever received a
 * message. An inbox with delivered ids is retained even when empty — those ids
 * are the exactly-once guard.
 */
function inboxCarriesState(inbox: ThreadMessageInbox): boolean {
  return inbox.pending.length > 0 || inbox.deliveredIds.length > 0
}

export function normalizeThreadMessageLedger(value: unknown): ThreadMessageLedger {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<ThreadMessageLedger>)
      : null
  if (!record || record.schemaVersion !== THREAD_MESSAGE_LEDGER_SCHEMA_VERSION) {
    return emptyThreadMessageLedger()
  }
  const rawInboxes =
    record.inboxes && typeof record.inboxes === 'object' && !Array.isArray(record.inboxes)
      ? (record.inboxes as Record<string, unknown>)
      : {}
  const inboxes = inboxMap()
  for (const [chatId, storedInbox] of Object.entries(rawInboxes)) {
    if (!chatId.trim()) continue
    const inbox = normalizeThreadMessageInbox(storedInbox, chatId)
    if (inboxCarriesState(inbox)) inboxes[chatId] = inbox
  }
  return { schemaVersion: THREAD_MESSAGE_LEDGER_SCHEMA_VERSION, inboxes }
}

export function threadMessageInboxFor(
  ledger: ThreadMessageLedger,
  chatId: string
): ThreadMessageInbox {
  return ledger.inboxes[chatId] || emptyThreadMessageInbox(chatId)
}

/** Inboxes holding undelivered messages, ordered for a stable projection. */
export function pendingThreadMessageInboxes(ledger: ThreadMessageLedger): ThreadMessageInbox[] {
  return Object.values(ledger.inboxes)
    .filter((inbox) => pendingThreadMessages(inbox).length > 0)
    .sort((a, b) => a.toChatId.localeCompare(b.toChatId))
}

export function enqueueThreadMessageInLedger(
  ledger: ThreadMessageLedger,
  event: ThreadMessageEvent
): ThreadMessageLedgerEnqueueResult {
  const current = threadMessageInboxFor(ledger, event.toChatId)
  const outcome = classifyThreadMessageEnqueue(current, event)
  if (outcome !== 'accepted') return { ledger, outcome, inbox: current }
  const inbox = enqueueThreadMessage(current, event)
  return {
    ledger: {
      ...ledger,
      inboxes: { ...ledger.inboxes, [event.toChatId]: inbox }
    },
    outcome,
    inbox
  }
}

export function acknowledgeThreadMessagesInLedger(
  ledger: ThreadMessageLedger,
  toChatId: string,
  ids: readonly string[]
): ThreadMessageLedgerAcknowledgeResult {
  const current = threadMessageInboxFor(ledger, toChatId)
  const requested = new Set(ids.filter((id) => typeof id === 'string' && id.trim()))
  const acknowledgedIds = current.pending
    .filter((event) => requested.has(event.id))
    .map((event) => event.id)
  if (acknowledgedIds.length === 0) return { ledger, acknowledgedIds: [], inbox: current }
  const inbox = normalizeThreadMessageInbox(
    {
      ...current,
      pending: current.pending.filter((event) => !requested.has(event.id)),
      deliveredIds: [...current.deliveredIds, ...acknowledgedIds]
    },
    toChatId
  )
  return {
    ledger: { ...ledger, inboxes: { ...ledger.inboxes, [toChatId]: inbox } },
    acknowledgedIds,
    inbox
  }
}

/**
 * Erasure primitive. Removes the inboxes OF the named chats and any pending
 * message FROM them, because a queued message names its sender and would
 * otherwise survive that sender's deletion — and, worse, would still be delivered
 * into a live thread's context afterwards.
 *
 * Retained delivered ids are opaque hashes (see `createThreadMessageId`) that
 * contain neither chat id nor body, so the exactly-once guard can outlive the
 * chats it refers to without holding their history.
 */
export function purgeThreadMessageChats(
  ledger: ThreadMessageLedger,
  chatIds: readonly string[]
): ThreadMessageLedgerPurgeResult {
  const targets = new Set(chatIds.filter((chatId) => typeof chatId === 'string' && chatId.trim()))
  if (targets.size === 0) return { ledger, changed: false }
  const inboxes = inboxMap()
  let changed = false
  for (const [chatId, inbox] of Object.entries(ledger.inboxes)) {
    if (targets.has(chatId)) {
      changed = true
      continue
    }
    const retained = inbox.pending.filter((event) => !targets.has(event.fromChatId))
    if (retained.length === inbox.pending.length) {
      inboxes[chatId] = inbox
      continue
    }
    changed = true
    const next: ThreadMessageInbox = { ...inbox, pending: retained }
    if (inboxCarriesState(next)) inboxes[chatId] = next
  }
  if (!changed) return { ledger, changed: false }
  return { ledger: { schemaVersion: THREAD_MESSAGE_LEDGER_SCHEMA_VERSION, inboxes }, changed: true }
}

/**
 * Chat ids that a purge should have removed but did not. The deletion transaction
 * verifies its own work by re-reading the file, so this exists to make that check
 * specific about what survived instead of asserting a bare boolean.
 */
export function residualThreadMessageChats(
  ledger: ThreadMessageLedger,
  chatIds: readonly string[]
): string[] {
  const targets = new Set(chatIds.filter((chatId) => typeof chatId === 'string' && chatId.trim()))
  const residual = new Set<string>()
  for (const [chatId, inbox] of Object.entries(ledger.inboxes)) {
    if (targets.has(chatId)) residual.add(chatId)
    for (const event of inbox.pending) {
      if (targets.has(event.fromChatId)) residual.add(event.fromChatId)
    }
  }
  return [...residual].sort()
}

/**
 * Deterministic message id from a caller-supplied nonce, so a retried send is
 * idempotent while two deliberate messages with the same body are not confused
 * for one. The output is a hash, not a composition: an id retained in a delivered
 * ledger must not carry the sender's or recipient's identity forward.
 *
 * Parts are length-prefixed rather than delimiter-joined so a nonce containing the
 * delimiter cannot collide with a different (from, to, nonce) triple — and so the
 * separator need not be a control character.
 */
export function createThreadMessageId(fromChatId: string, toChatId: string, nonce: string): string {
  const hash = createHash('sha256')
    .update([fromChatId, toChatId, nonce].map((part) => `${part.length}:${part}`).join('|'))
    .digest('hex')
    .slice(0, 32)
  return `thread-msg-${hash}`
}
