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

export const THREAD_MESSAGE_SCHEMA_VERSION = 1 as const

/** Matches MAX_SUBTHREAD_MAILBOX_PAYLOAD_CHARS so both inbound paths clamp alike. */
export const MAX_THREAD_MESSAGE_CHARS = 12_000

/** Bounded so a long-lived chat's ledger cannot grow without limit. */
export const MAX_RETAINED_THREAD_MESSAGE_LEDGER_IDS = 256

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
      createdAt: normalizedTimestamp(source.createdAt)
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
    pending,
    deliveredIds: deliveredIds.slice(-MAX_RETAINED_THREAD_MESSAGE_LEDGER_IDS)
  }
}

/**
 * Append a message. Idempotent on id against BOTH the pending queue and the
 * delivered ledger, so a retried send cannot re-deliver something the target has
 * already consumed.
 */
export function enqueueThreadMessage(
  inbox: ThreadMessageInbox,
  event: ThreadMessageEvent
): ThreadMessageInbox {
  if (event.toChatId !== inbox.toChatId) return inbox
  if (inbox.deliveredIds.includes(event.id)) return inbox
  if (inbox.pending.some((pending) => pending.id === event.id)) return inbox
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
