import { createHash } from 'crypto'

/**
 * ExecutionResultMailbox.ts
 *
 * Durable, exactly-once delivery of a durable execution graph's terminal result
 * back to the thread that owns it.
 *
 * A graph's `output` stage records its result into the execution's own event
 * ledger and stops there. That ledger is the graph's private bookkeeping, not a
 * delivery: a graph could therefore succeed while its answer reached nobody,
 * which is indistinguishable from never having run.
 *
 * This is a deliberate SIBLING of SubThreadMailbox rather than an extension of
 * it. That store's event is sub-thread-shaped by type — `kind:
 * 'subthread_result'` as a literal, a required `source.subThreadId`, a
 * `LinkedChildRelation` — and widening those to admit graph stages would make
 * closeout harvesting, attribution and grouping describe an execution as
 * something it is not. The GUARANTEES are copied; the vocabulary is not.
 *
 * The durable record IS the delivery. Nothing claims or drains events, so an
 * event is processed the moment it is durably recorded, and there is no pending
 * state for a crash to strand.
 */

export const EXECUTION_RESULT_MAILBOX_SCHEMA_VERSION = 1 as const
export const MAX_EXECUTION_RESULT_MAILBOX_PAYLOAD_CHARS = 12_000
export const MAX_RETAINED_EXECUTION_RESULT_MAILBOX_EVENTS = 256

/** Terminal states a graph can deliver from. `requires_action` is included: a
 * paused graph owes its owner an explanation just as much as a finished one. */
export type ExecutionResultOutcome = 'succeeded' | 'failed' | 'cancelled' | 'requires_action'

export interface ExecutionResultMailboxEvent {
  schemaVersion: typeof EXECUTION_RESULT_MAILBOX_SCHEMA_VERSION
  id: string
  sequence: number
  /** The owning thread. Mirrors ExecutionOwnerRef.threadId. */
  threadId: string
  kind: 'execution_result'
  createdAt: string
  /** Stamped at enqueue — see the file header on why there is no pending leg. */
  processedAt: string
  executionId: string
  /** The exact output-stage attempt this result came from. Part of identity: a
   * genuine retry is a new result, a replay of the same attempt is not. */
  outputAttemptId: string
  outcome: ExecutionResultOutcome
  /** Graph output is model-authored text, not system authority. */
  trust: 'untrusted-graph-output'
  title?: string
  /** Seat that owned the execution, for attribution on the delivered card. */
  seatId?: string
  payload: {
    content: string
    truncated?: boolean
    originalChars?: number
  }
}

export interface ExecutionResultMailbox {
  schemaVersion: typeof EXECUTION_RESULT_MAILBOX_SCHEMA_VERSION
  threadId: string
  nextSequence: number
  events: ExecutionResultMailboxEvent[]
}

export interface ExecutionResultMailboxEventInput {
  id?: string
  threadId: string
  executionId: string
  outputAttemptId: string
  outcome: ExecutionResultOutcome
  title?: string
  seatId?: string
  createdAt?: string
  payload: { content: string }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function emptyExecutionResultMailbox(threadId: string): ExecutionResultMailbox {
  return {
    schemaVersion: EXECUTION_RESULT_MAILBOX_SCHEMA_VERSION,
    threadId,
    nextSequence: 1,
    events: []
  }
}

/**
 * Deterministic identity: the same logical result always hashes to the same id,
 * so a re-entered output stage finds its own record instead of appending a
 * duplicate. Content is deliberately NOT part of the key — a replay that
 * produces slightly different text is still the same delivery.
 */
export function createExecutionResultMailboxEventId(
  threadId: string,
  executionId: string,
  outputAttemptId: string
): string {
  const digest = createHash('sha256')
    .update(`${threadId}\0${executionId}\0${outputAttemptId}`)
    .digest('hex')
    .slice(0, 32)
  return `execution-result-${digest}`
}

function normalizeEvent(value: unknown): ExecutionResultMailboxEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = nonEmptyString(raw.id)
  const threadId = nonEmptyString(raw.threadId)
  if (!id || !threadId || raw.kind !== 'execution_result') return null
  const createdAt = nonEmptyString(raw.createdAt) || new Date(0).toISOString()
  const payload =
    raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : {}
  return {
    schemaVersion: EXECUTION_RESULT_MAILBOX_SCHEMA_VERSION,
    id,
    sequence: typeof raw.sequence === 'number' && raw.sequence > 0 ? raw.sequence : 1,
    threadId,
    kind: 'execution_result',
    createdAt,
    processedAt: nonEmptyString(raw.processedAt) || createdAt,
    executionId: nonEmptyString(raw.executionId) || '',
    outputAttemptId: nonEmptyString(raw.outputAttemptId) || '',
    outcome: (nonEmptyString(raw.outcome) as ExecutionResultOutcome) || 'succeeded',
    trust: 'untrusted-graph-output',
    ...(nonEmptyString(raw.title) ? { title: raw.title as string } : {}),
    ...(nonEmptyString(raw.seatId) ? { seatId: raw.seatId as string } : {}),
    payload: {
      content: typeof payload.content === 'string' ? payload.content : '',
      ...(payload.truncated === true ? { truncated: true } : {}),
      ...(typeof payload.originalChars === 'number' ? { originalChars: payload.originalChars } : {})
    }
  }
}

export function normalizeExecutionResultMailbox(
  value: unknown,
  threadId: string
): ExecutionResultMailbox {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyExecutionResultMailbox(threadId)
  }
  const raw = value as Record<string, unknown>
  const seen = new Set<string>()
  const events: ExecutionResultMailboxEvent[] = []
  for (const candidate of Array.isArray(raw.events) ? raw.events : []) {
    const event = normalizeEvent(candidate)
    if (!event || seen.has(event.id)) continue
    seen.add(event.id)
    events.push(event)
  }
  const highest = events.reduce((max, event) => Math.max(max, event.sequence), 0)
  const declared = typeof raw.nextSequence === 'number' ? raw.nextSequence : 0
  return {
    schemaVersion: EXECUTION_RESULT_MAILBOX_SCHEMA_VERSION,
    threadId: nonEmptyString(raw.threadId) || threadId,
    nextSequence: Math.max(declared, highest + 1, 1),
    events
  }
}

function capEvents(events: ExecutionResultMailboxEvent[]): ExecutionResultMailboxEvent[] {
  return events.length <= MAX_RETAINED_EXECUTION_RESULT_MAILBOX_EVENTS
    ? events
    : events.slice(events.length - MAX_RETAINED_EXECUTION_RESULT_MAILBOX_EVENTS)
}

/**
 * Find-or-insert. A duplicate returns the existing record with
 * `inserted: false` and mutates nothing, so the caller can skip its disk write
 * entirely — the same shape `enqueueSubThreadMailboxEvent` settled on.
 */
export function enqueueExecutionResultMailboxEvent(
  current: ExecutionResultMailbox | undefined,
  input: ExecutionResultMailboxEventInput,
  options: { now?: string } = {}
): { mailbox: ExecutionResultMailbox; event: ExecutionResultMailboxEvent; inserted: boolean } {
  const mailbox = normalizeExecutionResultMailbox(current, input.threadId)
  const id =
    nonEmptyString(input.id) ||
    createExecutionResultMailboxEventId(input.threadId, input.executionId, input.outputAttemptId)
  const existing = mailbox.events.find((event) => event.id === id)
  if (existing) return { mailbox, event: existing, inserted: false }

  const originalContent = String(input.payload?.content || '')
  const content = originalContent.slice(0, MAX_EXECUTION_RESULT_MAILBOX_PAYLOAD_CHARS)
  const createdAt = input.createdAt || options.now || new Date().toISOString()
  const event: ExecutionResultMailboxEvent = {
    schemaVersion: EXECUTION_RESULT_MAILBOX_SCHEMA_VERSION,
    id,
    sequence: mailbox.nextSequence,
    threadId: input.threadId,
    kind: 'execution_result',
    createdAt,
    processedAt: createdAt,
    executionId: input.executionId,
    outputAttemptId: input.outputAttemptId,
    outcome: input.outcome,
    trust: 'untrusted-graph-output',
    ...(input.title ? { title: input.title } : {}),
    ...(input.seatId ? { seatId: input.seatId } : {}),
    payload: {
      content,
      ...(content.length < originalContent.length
        ? { truncated: true, originalChars: originalContent.length }
        : {})
    }
  }
  return {
    mailbox: {
      ...mailbox,
      nextSequence: mailbox.nextSequence + 1,
      events: capEvents([...mailbox.events, event])
    },
    event,
    inserted: true
  }
}

/** The most recently recorded outcome for one execution, if it has delivered. */
export function latestExecutionResultOutcome(
  mailbox: ExecutionResultMailbox | undefined,
  executionId: string
): ExecutionResultOutcome | undefined {
  if (!mailbox) return undefined
  let latest: ExecutionResultMailboxEvent | undefined
  for (const event of mailbox.events) {
    if (event.executionId !== executionId) continue
    if (!latest || event.sequence > latest.sequence) latest = event
  }
  return latest?.outcome
}

export interface ExecutionResultMailboxLedger {
  schemaVersion: typeof EXECUTION_RESULT_MAILBOX_SCHEMA_VERSION
  /** Keyed by owning thread id. */
  mailboxes: Record<string, ExecutionResultMailbox>
}

export function normalizeExecutionResultMailboxLedger(
  value: unknown
): ExecutionResultMailboxLedger {
  const input =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  const raw =
    input?.mailboxes && typeof input.mailboxes === 'object' && !Array.isArray(input.mailboxes)
      ? (input.mailboxes as Record<string, unknown>)
      : {}
  const mailboxes: Record<string, ExecutionResultMailbox> = Object.create(null)
  for (const [threadId, mailbox] of Object.entries(raw)) {
    if (!threadId.trim()) continue
    mailboxes[threadId] = normalizeExecutionResultMailbox(mailbox, threadId)
  }
  return { schemaVersion: EXECUTION_RESULT_MAILBOX_SCHEMA_VERSION, mailboxes }
}
