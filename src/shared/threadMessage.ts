/**
 * Peer thread-to-thread messages — pure model (S1).
 *
 * TaskWraith already moves information between chats in three shapes, and none of
 * them is peer-to-peer: `SubThreadMailbox` delivers a CHILD's result to its
 * PARENT, cross-thread recall READS another thread, and `ensemble_lane_result`
 * reads a lane. This adds the missing direction — one top-level chat handing a
 * message to another — modelled on the sub-thread mailbox because that lifecycle
 * (durable enqueue, claim, acknowledge, bounded ledger) is already proven.
 *
 * Deliberately node-free and side-effect-free: main owns persistence, the gate
 * owns permission, the runtime owns delivery. This module only decides what a
 * message IS and how a queue evolves, so it can be exercised without Electron.
 *
 * TRUST: an inbound message is UNTRUSTED CONTENT, never an instruction. It is
 * authored by another agent or by the user in another thread, and the receiving
 * seat must treat it the way it treats tool output — hence `trust` is a fixed
 * literal that callers cannot override, and the origin title is sanitized for
 * display only. Rendering must not present it as a system or operator message;
 * that would turn this into a cross-thread injection channel.
 *
 * WAKE: `requestedDelivery: 'wake'` is a REQUEST, not a decision. Nothing here
 * may cause a turn to run — S3's gate and S6's runner own that, and waking is
 * always approval-gated even inside one workspace. Keeping the request and the
 * decision in different modules is what stops a sender from granting itself an
 * unattended run.
 */

import type { SeatChangeSeatState } from './seatChange'

/**
 * NOT bumped when the sender's seat was added, and it must not be bumped
 * casually: `normalizeThreadMessageInbox` treats any other value as an
 * unreadable ledger and returns an EMPTY inbox, which would discard both the
 * undelivered queue and `deliveredIds` — the exactly-once guard. New fields
 * belong here as OPTIONAL ones, so an older record keeps loading and simply
 * renders without them.
 */
export const THREAD_MESSAGE_SCHEMA_VERSION = 1 as const

/** Cap on any single captured seat string; long values are cut, never rejected. */
export const MAX_THREAD_MESSAGE_SEAT_FIELD_CHARS = 120

/** Synthetic transcript-row discriminator; delivery still lives in the ledger. */
export const THREAD_MESSAGE_TRANSCRIPT_KIND = 'threadMessage' as const

/** Matches MAX_SUBTHREAD_MAILBOX_PAYLOAD_CHARS so both inbound paths clamp alike. */
export const MAX_THREAD_MESSAGE_CHARS = 12_000

/** Bounded so a long-lived chat's ledger cannot grow without limit. */
export const MAX_RETAINED_THREAD_MESSAGE_LEDGER_IDS = 256

/**
 * Cap on undelivered messages per inbox. Two reasons, both load-bearing once the
 * inbox is durable: an unbounded queue is an unbounded synchronous write on the
 * main process, and a full inbox must REFUSE new messages rather than evict old
 * ones — dropping the oldest would let a chatty sender flush a queue it does not
 * own before the target ever reads it.
 */
export const MAX_PENDING_THREAD_MESSAGES = 64

/** Display-only origin label cap; long titles are truncated, never rejected. */
export const MAX_THREAD_MESSAGE_TITLE_CHARS = 120

export const THREAD_MESSAGE_TRUNCATION_NOTICE = '\n\n[truncated by TaskWraith]'

/** Who composed the message. Agent sends are approval-gated; user sends are not. */
export type ThreadMessageOrigin = 'user' | 'agent'

/**
 * What the sender ASKED for. 'queue' lands the message for the target's next
 * turn; 'wake' additionally requests an immediate run, which the gate may refuse.
 */
export type ThreadMessageDelivery = 'queue' | 'wake'

/** Fixed marker so a receiving seat can always tell relayed content apart. */
export type ThreadMessageTrust = 'untrusted-thread-message'

/**
 * Why an enqueue did or did not land. A refusal must be reportable to the sender:
 * a silent drop looks identical to a successful send, which is how a queue
 * quietly stops delivering.
 */
export type ThreadMessageEnqueueOutcome =
  | 'accepted'
  | 'duplicate'
  | 'already-delivered'
  | 'wrong-destination'
  | 'inbox-full'

export interface ThreadMessageEvent {
  readonly id: string
  readonly schemaVersion: typeof THREAD_MESSAGE_SCHEMA_VERSION
  readonly fromChatId: string
  /** Display only, sanitized, never used for routing or authority. */
  readonly fromChatTitle: string
  readonly toChatId: string
  readonly origin: ThreadMessageOrigin
  readonly body: string
  readonly requestedDelivery: ThreadMessageDelivery
  readonly createdAt: number
  readonly trust: ThreadMessageTrust
  /**
   * The sending seat AS CONFIGURED WHEN IT SENT — provider, model, reasoning,
   * permission tier, role. Captured here rather than resolved from `fromChatId`
   * at render time on purpose: a later reconfiguration of the peer thread would
   * otherwise silently rewrite history in the reader's transcript, and a solo
   * peer chat has no participant to resolve at all.
   *
   * Optional in both directions. Records written before capture existed have no
   * seat, and a send whose provider/model cannot both be resolved deliberately
   * stores none — an absent seat renders an honest fallback line, whereas an
   * empty model would collide with the close-out's use of that state to mean
   * "we never saw one".
   */
  readonly seat?: SeatChangeSeatState
  /** Set once the body has entered the target's provider context. */
  readonly deliveredAt?: number
  /** True when `body` was clamped to MAX_THREAD_MESSAGE_CHARS. */
  readonly truncated?: boolean
}

export interface ThreadMessageInbox {
  readonly toChatId: string
  readonly schemaVersion: typeof THREAD_MESSAGE_SCHEMA_VERSION
  readonly pending: readonly ThreadMessageEvent[]
  /** Ids already delivered, newest last. Bounded; the exactly-once guard. */
  readonly deliveredIds: readonly string[]
}

export interface ThreadMessageInput {
  readonly id: string
  readonly fromChatId: string
  readonly fromChatTitle?: string | null
  readonly toChatId: string
  readonly origin: ThreadMessageOrigin
  readonly body: string
  readonly requestedDelivery?: ThreadMessageDelivery | null
  readonly createdAt: number
  /** Untrusted: sanitized by `sanitizeSeat`, never stored as given. */
  readonly seat?: unknown
}

export interface ThreadMessageInboxSummary {
  readonly toChatId: string
  readonly pendingCount: number
  readonly hasWakeRequest: boolean
  readonly oldestPendingAt: number | null
  readonly senders: readonly string[]
}

/**
 * Code-point filtering rather than a regex character class, for two reasons: a
 * control-character class trips eslint's `no-control-regex` (correctly — it is
 * almost always a mistake), and expressing the range as source escapes is exactly
 * the construct that gets mangled into literal control BYTES by some editors.
 * There is no class here to mangle.
 */
function isControlCodePoint(codePoint: number): boolean {
  return codePoint < 0x20 || codePoint === 0x7f
}

function stripControlCharacters(value: string, keepNewlines: boolean): string {
  let out = ''
  for (const character of value) {
    if (keepNewlines && character === '\n') {
      out += character
      continue
    }
    if (isControlCodePoint(character.codePointAt(0) ?? 0)) continue
    out += character
  }
  return out
}

/**
 * Display title: newlines and tabs are semantically whitespace, so they collapse
 * to a single space; every other control character is junk and is deleted rather
 * than becoming a space, which would invent a word break inside a word.
 */
function sanitizeSingleLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const spaced = value.replace(/[\n\r\t]/g, ' ')
  const stripped = stripControlCharacters(spaced, false).replace(/\s+/g, ' ').trim()
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped
}

function normalizedId(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/**
 * Body keeps its newlines (it is prose an agent wrote) but loses other control
 * characters, which have no legitimate use here and are an invisible-instruction
 * vector — the same class `guard:doctrine-integrity` blocks in doctrine files.
 */
function sanitizeBody(value: unknown): { body: string; truncated: boolean } {
  if (typeof value !== 'string') return { body: '', truncated: false }
  const cleaned = stripControlCharacters(value, true).trim()
  if (cleaned.length <= MAX_THREAD_MESSAGE_CHARS) return { body: cleaned, truncated: false }
  const keep = MAX_THREAD_MESSAGE_CHARS - THREAD_MESSAGE_TRUNCATION_NOTICE.length
  return { body: `${cleaned.slice(0, keep)}${THREAD_MESSAGE_TRUNCATION_NOTICE}`, truncated: true }
}

function normalizedOrigin(value: unknown): ThreadMessageOrigin {
  // Defaults to 'agent', the gated case: a malformed record must not be able to
  // claim the ungated user path.
  return value === 'user' ? 'user' : 'agent'
}

function normalizedDelivery(value: unknown): ThreadMessageDelivery {
  // Defaults to 'queue', the safe case: a malformed record must not request a run.
  return value === 'wake' ? 'wake' : 'queue'
}

/**
 * Rebuild a sender's seat from untrusted input, field by field.
 *
 * An allowlist rather than a filter, for the usual reason: this value is
 * rendered as the identity of whoever sent a relayed message, so anything the
 * strip does not draw has no business surviving into storage.
 *
 * Two fields the seat element supports are deliberately NOT captured here.
 * `grantsCount` describes the sending workspace rather than the sender, and
 * `seatNumber` is `participant.order` — 1-based within ONE roster, so a peer
 * sender's "#3" would be a number the reader cannot interpret. (The same token
 * is meaningful for a fan-out lane, which is in the reader's own roster; do not
 * unify the two cases.)
 *
 * Returns null unless BOTH provider and model survive, which is what keeps this
 * host from ever producing the empty-model seat the close-out uses to mean
 * something else.
 */
function sanitizeSeat(value: unknown): SeatChangeSeatState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const field = (key: string): string =>
    sanitizeSingleLine(record[key], MAX_THREAD_MESSAGE_SEAT_FIELD_CHARS)
  const provider = field('provider')
  const model = field('model')
  if (!provider || !model) return null
  const role = field('role')
  const reasoningEffort = field('reasoningEffort')
  const permissionPresetId = field('permissionPresetId')
  // Closed unions, validated here: these drive an icon component that switches
  // on them, so an unknown value must never survive the allowlist.
  const stage = field('stageRole')
  const stageRole =
    stage === 'scout' || stage === 'worker' || stage === 'reviewer' || stage === 'background'
      ? stage
      : ''
  const auth = field('authority')
  const authority = auth === 'boss' || auth === 'captain' ? auth : ''
  return {
    provider,
    model,
    ...(role ? { role } : {}),
    ...(stageRole ? { stageRole } : {}),
    ...(authority ? { authority } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    // Strictly boolean: `thinkingEnabled` is a SEPARATE input from
    // `reasoningEffort` that produces the same chip suffix, and `false` is a
    // meaningful value, so this can be neither truthiness-tested nor coerced.
    ...(typeof record.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: record.thinkingEnabled }
      : {}),
    ...(permissionPresetId ? { permissionPresetId } : {})
  }
}

function normalizedTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function emptyThreadMessageInbox(toChatId: string): ThreadMessageInbox {
  return {
    toChatId,
    schemaVersion: THREAD_MESSAGE_SCHEMA_VERSION,
    pending: [],
    deliveredIds: []
  }
}

/** Build a stored event from untrusted input. Returns null if unroutable. */
export function createThreadMessageEvent(input: ThreadMessageInput): ThreadMessageEvent | null {
  const id = normalizedId(input.id)
  const fromChatId = normalizedId(input.fromChatId)
  const toChatId = normalizedId(input.toChatId)
  // A message with no destination, no origin chat, or no content is not a
  // message. Self-messaging is refused: it would let a seat inject into its own
  // context through a path the user cannot see as self-authored.
  if (!id || !fromChatId || !toChatId || fromChatId === toChatId) return null
  const { body, truncated } = sanitizeBody(input.body)
  if (!body) return null
  // An unusable seat drops the SEAT, never the message: who sent it is worth
  // less than what they said, and a refused capture must not silently swallow
  // a delivery.
  const seat = sanitizeSeat(input.seat)
  return {
    id,
    schemaVersion: THREAD_MESSAGE_SCHEMA_VERSION,
    fromChatId,
    fromChatTitle: sanitizeSingleLine(input.fromChatTitle, MAX_THREAD_MESSAGE_TITLE_CHARS),
    toChatId,
    origin: normalizedOrigin(input.origin),
    body,
    requestedDelivery: normalizedDelivery(input.requestedDelivery),
    createdAt: normalizedTimestamp(input.createdAt),
    // Never taken from input — a sender cannot relabel its own message as trusted.
    trust: 'untrusted-thread-message',
    ...(seat ? { seat } : {}),
    ...(truncated ? { truncated: true } : {})
  }
}

/** Decode a persisted record defensively; unusable entries are dropped. */
export function normalizeThreadMessageInbox(value: unknown, toChatId: string): ThreadMessageInbox {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyThreadMessageInbox(toChatId)
  }
  const record = value as Partial<ThreadMessageInbox>
  if (record.schemaVersion !== THREAD_MESSAGE_SCHEMA_VERSION) {
    return emptyThreadMessageInbox(toChatId)
  }
  const deliveredIds = Array.isArray(record.deliveredIds)
    ? record.deliveredIds.map(normalizedId).filter(Boolean)
    : []
  const seen = new Set<string>()
  const pending: ThreadMessageEvent[] = []
  const rawPending = Array.isArray(record.pending) ? record.pending : []
  for (const entry of rawPending) {
    if (!entry || typeof entry !== 'object') continue
    const source = entry as Partial<ThreadMessageEvent>
    const event = createThreadMessageEvent({
      id: normalizedId(source.id),
      fromChatId: normalizedId(source.fromChatId),
      fromChatTitle: source.fromChatTitle ?? null,
      toChatId,
      origin: normalizedOrigin(source.origin),
      body: typeof source.body === 'string' ? source.body : '',
      requestedDelivery: normalizedDelivery(source.requestedDelivery),
      createdAt: normalizedTimestamp(source.createdAt),
      // Re-sanitized rather than spread: this function REBUILDS each event from
      // a field allowlist, so anything omitted here is dropped on every load —
      // it would look persisted right up until the app restarts.
      seat: source.seat
    })
    if (!event || seen.has(event.id)) continue
    seen.add(event.id)
    pending.push(
      normalizedTimestamp(source.deliveredAt)
        ? { ...event, deliveredAt: normalizedTimestamp(source.deliveredAt) }
        : event
    )
  }
  return {
    toChatId,
    schemaVersion: THREAD_MESSAGE_SCHEMA_VERSION,
    // Oldest-wins on overflow, matching the live refusal: a stored queue that is
    // over budget must not be able to displace messages that arrived first.
    pending: pending.slice(0, MAX_PENDING_THREAD_MESSAGES),
    deliveredIds: deliveredIds.slice(-MAX_RETAINED_THREAD_MESSAGE_LEDGER_IDS)
  }
}

/**
 * Decide whether a message may join the queue. Idempotent on id against BOTH the
 * pending queue and the delivered ledger, so a retried send cannot re-deliver
 * something the target has already consumed.
 */
export function classifyThreadMessageEnqueue(
  inbox: ThreadMessageInbox,
  event: ThreadMessageEvent
): ThreadMessageEnqueueOutcome {
  if (event.toChatId !== inbox.toChatId) return 'wrong-destination'
  if (inbox.deliveredIds.includes(event.id)) return 'already-delivered'
  if (inbox.pending.some((pending) => pending.id === event.id)) return 'duplicate'
  if (inbox.pending.length >= MAX_PENDING_THREAD_MESSAGES) return 'inbox-full'
  return 'accepted'
}

/**
 * Append a message, or return the inbox untouched. Defined in terms of
 * `classifyThreadMessageEnqueue` so the reason reported to a sender can never
 * disagree with what the queue actually did.
 */
export function enqueueThreadMessage(
  inbox: ThreadMessageInbox,
  event: ThreadMessageEvent
): ThreadMessageInbox {
  if (classifyThreadMessageEnqueue(inbox, event) !== 'accepted') return inbox
  return { ...inbox, pending: [...inbox.pending, event] }
}

/** Undelivered messages, oldest first. */
export function pendingThreadMessages(inbox: ThreadMessageInbox): readonly ThreadMessageEvent[] {
  return inbox.pending.filter((event) => !event.deliveredAt)
}

/**
 * Mark messages delivered and record them in the ledger. Called AFTER the bodies
 * have entered provider context, so a crash mid-turn re-delivers rather than
 * silently dropping.
 */
export function acknowledgeThreadMessages(
  inbox: ThreadMessageInbox,
  ids: readonly string[]
): ThreadMessageInbox {
  const acknowledged = new Set(ids.map(normalizedId).filter(Boolean))
  if (acknowledged.size === 0) return inbox
  const remaining = inbox.pending.filter((event) => !acknowledged.has(event.id))
  const newlyDelivered = inbox.pending
    .filter((event) => acknowledged.has(event.id))
    .map((event) => event.id)
  if (newlyDelivered.length === 0) return inbox
  return {
    ...inbox,
    pending: remaining,
    deliveredIds: [...inbox.deliveredIds, ...newlyDelivered].slice(
      -MAX_RETAINED_THREAD_MESSAGE_LEDGER_IDS
    )
  }
}

/** Nonsecret shape for the sidebar indicator and the iOS projection. */
export function summarizeThreadMessageInbox(inbox: ThreadMessageInbox): ThreadMessageInboxSummary {
  const pending = pendingThreadMessages(inbox)
  const senders: string[] = []
  for (const event of pending) {
    const label = event.fromChatTitle || event.fromChatId
    if (!senders.includes(label)) senders.push(label)
  }
  return {
    toChatId: inbox.toChatId,
    pendingCount: pending.length,
    hasWakeRequest: pending.some((event) => event.requestedDelivery === 'wake'),
    oldestPendingAt: pending.length > 0 ? pending[0].createdAt : null,
    senders
  }
}
