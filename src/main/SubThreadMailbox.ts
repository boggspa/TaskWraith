import { createHash } from 'crypto'
import type { LinkedChildRelation } from './LinkedChildReturn'
import type { ProviderId, SubThreadJoinPolicy } from './store/types'
import type { SeatChangeSeatState } from '../shared/seatChange'

export const SUBTHREAD_MAILBOX_SCHEMA_VERSION = 1 as const
export const MAX_SUBTHREAD_MAILBOX_PAYLOAD_CHARS = 12_000
export const MAX_RETAINED_PROCESSED_SUBTHREAD_MAILBOX_EVENTS = 256

export type SubThreadMailboxOutcome = 'done' | 'requires_action' | 'failed' | 'cancelled'
export type SubThreadMailboxPriority = 'normal' | 'interrupt'

export interface SubThreadMailboxEvent {
  schemaVersion: typeof SUBTHREAD_MAILBOX_SCHEMA_VERSION
  id: string
  sequence: number
  parentChatId: string
  kind: 'subthread_result'
  createdAt: string
  /** Ledger stamp. New events are processed at enqueue (the transcript
   * projection is the only delivery), and normalize stamps legacy pre-removal
   * rows at read — so this is never null after decode; the type stays
   * nullable only for the raw persisted shape. */
  processedAt: string | null
  outcome: SubThreadMailboxOutcome
  required: boolean
  priority: SubThreadMailboxPriority
  trust: 'untrusted-child-output'
  source: {
    relation: LinkedChildRelation
    subThreadId: string
    subThreadProvider?: ProviderId
    /**
     * The child's seat as configured when it RETURNED, so the parent's return
     * card can say which participant produced the result rather than only which
     * provider. Optional: absent for records written before capture existed and
     * for a child whose provider/model could not both be resolved, both of
     * which render the seatless heading.
     */
    subThreadSeat?: SeatChangeSeatState
    subThreadTitle: string
    sourceAssistantMessageId: string
    sourceRunId?: string
  }
  join?: SubThreadJoinPolicy
  payload: {
    content: string
    truncated?: boolean
    originalChars?: number
  }
  /** Legacy delivery-leg fields: retained so pre-removal persisted events
   * still parse. Never written for new events. */
  deliveryRunId?: string
  claimedAt?: string
  deliveryAttempts: number
  lastDeliveryError?: {
    at: string
    message: string
  }
}

export interface SubThreadMailbox {
  schemaVersion: typeof SUBTHREAD_MAILBOX_SCHEMA_VERSION
  parentChatId: string
  nextSequence: number
  events: SubThreadMailboxEvent[]
}

export interface SubThreadMailboxEventInput {
  id?: string
  parentChatId: string
  subThreadId: string
  subThreadProvider?: ProviderId
  /** Resolved by the store at enqueue time; never supplied by a caller. */
  subThreadSeat?: SeatChangeSeatState
  subThreadTitle: string
  sourceRelation?: LinkedChildRelation
  sourceAssistantMessageId: string
  sourceRunId?: string
  joinPolicy?: SubThreadJoinPolicy
  outcome: SubThreadMailboxOutcome
  required?: boolean
  priority?: SubThreadMailboxPriority
  content: string
  createdAt?: string
}

export interface SubThreadMailboxLedger {
  schemaVersion: typeof SUBTHREAD_MAILBOX_SCHEMA_VERSION
  mailboxes: Record<string, SubThreadMailbox>
}

/** Payload-free projection over the retained mailbox window. Delivery metrics
 * are derived from durable deliveryRunId ownership, so they survive restart
 * without introducing a second analytics ledger. */
export interface SubThreadMailboxSummary {
  retainedEvents: number
  pending: number
  claimed: number
  processed: number
  blocked: number
  outcomes: Record<SubThreadMailboxOutcome, number>
  delivery: {
    processedEvents: number
    batches: number
    coalescedBatches: number
    coalescedWakeupsAvoided: number
    lastProcessedAt?: string
  }
}

const PROVIDERS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'pi',
  'mistral'
])
const OUTCOMES = new Set<SubThreadMailboxOutcome>([
  'done',
  'requires_action',
  'failed',
  'cancelled'
])

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback
}

function normalizeJoinPolicy(value: unknown): SubThreadJoinPolicy | undefined {
  const join = recordOrNull(value)
  const groupId = nonEmptyString(join?.groupId)
  const armedAt = nonEmptyString(join?.armedAt)
  const deadlineAt = nonEmptyString(join?.deadlineAt)
  if (!join || !groupId || !armedAt || !deadlineAt) return undefined
  return {
    schemaVersion: 1,
    groupId,
    required: join.required !== false,
    ...(typeof join.quorum === 'number' && Number.isFinite(join.quorum) && join.quorum > 0
      ? { quorum: Math.floor(join.quorum) }
      : {}),
    debounceMs: nonNegativeInteger(join.debounceMs, 0),
    armedAt,
    deadlineAt,
    ...(nonEmptyString(join.workerRunId)
      ? { workerRunId: nonEmptyString(join.workerRunId) }
      : {})
  }
}

function normalizeEvent(value: unknown, parentChatId: string): SubThreadMailboxEvent | null {
  const event = recordOrNull(value)
  if (!event) return null
  const id = nonEmptyString(event.id)
  const source = recordOrNull(event.source)
  const payload = recordOrNull(event.payload)
  const subThreadId = nonEmptyString(source?.subThreadId)
  const subThreadTitle = nonEmptyString(source?.subThreadTitle)
  const sourceAssistantMessageId = nonEmptyString(source?.sourceAssistantMessageId)
  const content = typeof payload?.content === 'string' ? payload.content : undefined
  if (!id || !source || !payload || !subThreadId || !subThreadTitle || !sourceAssistantMessageId) {
    return null
  }
  if (content === undefined) return null
  const outcome = OUTCOMES.has(event.outcome as SubThreadMailboxOutcome)
    ? (event.outcome as SubThreadMailboxOutcome)
    : 'done'
  const createdAt = nonEmptyString(event.createdAt) || new Date(0).toISOString()
  // Legacy migration (2026-08-19): the delivery legs are gone, so a null
  // stamp can never be serviced. Pre-removal pending rows are stamped at
  // creation time on read, keeping summaries quiet and retention caps live.
  const processedAt = nonEmptyString(event.processedAt) || createdAt
  const provider = PROVIDERS.has(source.subThreadProvider as ProviderId)
    ? (source.subThreadProvider as ProviderId)
    : undefined
  // Re-validated on decode: this is persisted JSON by the time it is read back,
  // and it is rendered as the identity of whoever produced an UNTRUSTED child
  // result. Provider and model are both required — the seat element draws an
  // empty span for a missing model, which reads as a seat with no model rather
  // than as the absence of a seat.
  const seatSource = recordOrNull(source.subThreadSeat)
  const seatProvider = nonEmptyString(seatSource?.provider)
  const seatModel = nonEmptyString(seatSource?.model)
  const subThreadSeat: SeatChangeSeatState | undefined =
    seatProvider && seatModel
      ? {
          provider: seatProvider,
          model: seatModel,
          ...(nonEmptyString(seatSource?.role) ? { role: nonEmptyString(seatSource?.role)! } : {}),
          ...(nonEmptyString(seatSource?.reasoningEffort)
            ? { reasoningEffort: nonEmptyString(seatSource?.reasoningEffort)! }
            : {}),
          ...(typeof seatSource?.thinkingEnabled === 'boolean'
            ? { thinkingEnabled: seatSource.thinkingEnabled }
            : {}),
          ...(nonEmptyString(seatSource?.permissionPresetId)
            ? { permissionPresetId: nonEmptyString(seatSource?.permissionPresetId)! }
            : {}),
          ...(['scout', 'worker', 'reviewer', 'background'].includes(
            String(seatSource?.stageRole)
          )
            ? { stageRole: seatSource?.stageRole as SeatChangeSeatState['stageRole'] }
            : {}),
          ...(['boss', 'captain'].includes(String(seatSource?.authority))
            ? { authority: seatSource?.authority as SeatChangeSeatState['authority'] }
            : {})
        }
      : undefined
  const lastError = recordOrNull(event.lastDeliveryError)
  const lastErrorAt = nonEmptyString(lastError?.at)
  const lastErrorMessage = nonEmptyString(lastError?.message)
  const deliveryRunId = nonEmptyString(event.deliveryRunId)
  const claimedAt = deliveryRunId ? nonEmptyString(event.claimedAt) : undefined
  const originalChars = positiveInteger(payload.originalChars, content.length)
  const join = normalizeJoinPolicy(event.join)
  const relation: LinkedChildRelation = source.relation === 'sideChat' ? 'sideChat' : 'subThread'

  return {
    schemaVersion: SUBTHREAD_MAILBOX_SCHEMA_VERSION,
    id,
    sequence: positiveInteger(event.sequence, 1),
    parentChatId,
    kind: 'subthread_result',
    createdAt,
    processedAt,
    outcome,
    required: event.required !== false,
    priority: event.priority === 'interrupt' ? 'interrupt' : 'normal',
    trust: 'untrusted-child-output',
    source: {
      relation,
      subThreadId,
      ...(provider ? { subThreadProvider: provider } : {}),
      ...(subThreadSeat ? { subThreadSeat } : {}),
      subThreadTitle,
      sourceAssistantMessageId,
      ...(nonEmptyString(source.sourceRunId)
        ? { sourceRunId: nonEmptyString(source.sourceRunId) }
        : {})
    },
    ...(join ? { join } : {}),
    payload: {
      content: content.slice(0, MAX_SUBTHREAD_MAILBOX_PAYLOAD_CHARS),
      ...(payload.truncated === true || content.length > MAX_SUBTHREAD_MAILBOX_PAYLOAD_CHARS
        ? { truncated: true, originalChars }
        : {})
    },
    ...(deliveryRunId ? { deliveryRunId } : {}),
    ...(claimedAt ? { claimedAt } : {}),
    deliveryAttempts: Math.max(0, positiveInteger(event.deliveryAttempts, 0)),
    ...(lastErrorAt && lastErrorMessage
      ? { lastDeliveryError: { at: lastErrorAt, message: lastErrorMessage } }
      : {})
  }
}

function capMailboxEvents(events: SubThreadMailboxEvent[]): SubThreadMailboxEvent[] {
  const pending = events.filter((event) => event.processedAt === null)
  const processed = events
    .filter((event) => event.processedAt !== null)
    .slice(-MAX_RETAINED_PROCESSED_SUBTHREAD_MAILBOX_EVENTS)
  return [...pending, ...processed].sort((a, b) => a.sequence - b.sequence)
}

export function emptySubThreadMailbox(parentChatId: string): SubThreadMailbox {
  return {
    schemaVersion: SUBTHREAD_MAILBOX_SCHEMA_VERSION,
    parentChatId,
    nextSequence: 1,
    events: []
  }
}

export function normalizeSubThreadMailbox(
  value: unknown,
  parentChatId: string
): SubThreadMailbox {
  const input = recordOrNull(value)
  const seen = new Set<string>()
  const events = (Array.isArray(input?.events) ? input.events : [])
    .map((event) => normalizeEvent(event, parentChatId))
    .filter((event): event is SubThreadMailboxEvent => Boolean(event))
    .sort((a, b) => a.sequence - b.sequence)
    .filter((event) => {
      if (seen.has(event.id)) return false
      seen.add(event.id)
      return true
    })
  const maxSequence = events.reduce((max, event) => Math.max(max, event.sequence), 0)
  return {
    schemaVersion: SUBTHREAD_MAILBOX_SCHEMA_VERSION,
    parentChatId,
    nextSequence: Math.max(maxSequence + 1, positiveInteger(input?.nextSequence, 1)),
    events: capMailboxEvents(events)
  }
}

export function normalizeSubThreadMailboxLedger(value: unknown): SubThreadMailboxLedger {
  const input = recordOrNull(value)
  const rawMailboxes = recordOrNull(input?.mailboxes) || {}
  const normalizedMailboxes: Record<string, SubThreadMailbox> = Object.create(null)
  const mailboxes = Object.entries(rawMailboxes).reduce<Record<string, SubThreadMailbox>>(
    (result, [parentChatId, mailbox]) => {
      if (!parentChatId.trim()) return result
      result[parentChatId] = normalizeSubThreadMailbox(mailbox, parentChatId)
      return result
    },
    normalizedMailboxes
  )
  return { schemaVersion: SUBTHREAD_MAILBOX_SCHEMA_VERSION, mailboxes }
}

export function createSubThreadMailboxEventId(
  parentChatId: string,
  subThreadId: string,
  sourceAssistantMessageId: string
): string {
  const hash = createHash('sha256')
    .update(`${parentChatId}\0${subThreadId}\0${sourceAssistantMessageId}`)
    .digest('hex')
    .slice(0, 32)
  return `subthread-result-${hash}`
}

export function enqueueSubThreadMailboxEvent(
  current: SubThreadMailbox | undefined,
  input: SubThreadMailboxEventInput,
  options: { now?: string } = {}
): { mailbox: SubThreadMailbox; event: SubThreadMailboxEvent; inserted: boolean } {
  const mailbox = normalizeSubThreadMailbox(current, input.parentChatId)
  const id =
    nonEmptyString(input.id) ||
    createSubThreadMailboxEventId(
      input.parentChatId,
      input.subThreadId,
      input.sourceAssistantMessageId
    )
  const existing = mailbox.events.find((event) => event.id === id)
  if (existing) return { mailbox, event: existing, inserted: false }

  const originalContent = String(input.content || '')
  const content = originalContent.slice(0, MAX_SUBTHREAD_MAILBOX_PAYLOAD_CHARS)
  const createdAt = input.createdAt || options.now || new Date().toISOString()
  const event: SubThreadMailboxEvent = {
    schemaVersion: SUBTHREAD_MAILBOX_SCHEMA_VERSION,
    id,
    sequence: mailbox.nextSequence,
    parentChatId: input.parentChatId,
    kind: 'subthread_result',
    createdAt,
    // Ledger semantics: the transcript projection is the delivery. Nothing
    // claims or drains events any more, so an event is processed the moment
    // it is durably recorded (2026-08-19 auto-dispatch removal).
    processedAt: createdAt,
    outcome: input.outcome,
    required: input.required !== false,
    priority: input.priority === 'interrupt' ? 'interrupt' : 'normal',
    trust: 'untrusted-child-output',
    source: {
      relation: input.sourceRelation === 'sideChat' ? 'sideChat' : 'subThread',
      subThreadId: input.subThreadId,
      ...(input.subThreadProvider ? { subThreadProvider: input.subThreadProvider } : {}),
      subThreadTitle: input.subThreadTitle,
      sourceAssistantMessageId: input.sourceAssistantMessageId,
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {})
    },
    ...(input.joinPolicy ? { join: { ...input.joinPolicy } } : {}),
    payload: {
      content,
      ...(content.length < originalContent.length
        ? { truncated: true, originalChars: originalContent.length }
        : {})
    },
    deliveryAttempts: 0
  }
  return {
    mailbox: {
      ...mailbox,
      nextSequence: event.sequence + 1,
      events: capMailboxEvents([...mailbox.events, event])
    },
    event,
    inserted: true
  }
}

function processedMailboxBatchKey(event: SubThreadMailboxEvent): string {
  return event.deliveryRunId || `legacy-event:${event.id}`
}

export function summarizeSubThreadMailbox(
  current: SubThreadMailbox | undefined,
  options: { subThreadId?: string } = {}
): SubThreadMailboxSummary {
  const mailbox = current
    ? normalizeSubThreadMailbox(current, current.parentChatId)
    : undefined
  const allEvents = mailbox?.events || []
  const events = options.subThreadId
    ? allEvents.filter((event) => event.source.subThreadId === options.subThreadId)
    : allEvents
  const processed = events.filter((event) => event.processedAt !== null)
  const processedBatchKeys = new Set(processed.map(processedMailboxBatchKey))
  const allProcessedBatchSizes = allEvents
    .filter((event) => event.processedAt !== null)
    .reduce<Map<string, number>>((sizes, event) => {
      const key = processedMailboxBatchKey(event)
      sizes.set(key, (sizes.get(key) || 0) + 1)
      return sizes
    }, new Map())
  const coalescedBatches = [...processedBatchKeys].filter(
    (key) => (allProcessedBatchSizes.get(key) || 0) > 1
  ).length
  const lastProcessedAt = processed
    .map((event) => event.processedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1)
  const outcomes: Record<SubThreadMailboxOutcome, number> = {
    done: 0,
    requires_action: 0,
    failed: 0,
    cancelled: 0
  }
  for (const event of events) outcomes[event.outcome] += 1
  return {
    retainedEvents: events.length,
    pending: events.filter((event) => event.processedAt === null).length,
    claimed: events.filter(
      (event) => event.processedAt === null && Boolean(event.deliveryRunId)
    ).length,
    processed: processed.length,
    blocked: events.filter(
      (event) => event.processedAt === null && Boolean(event.lastDeliveryError)
    ).length,
    outcomes,
    delivery: {
      processedEvents: processed.length,
      batches: processedBatchKeys.size,
      coalescedBatches,
      coalescedWakeupsAvoided: Math.max(0, processed.length - processedBatchKeys.size),
      ...(lastProcessedAt ? { lastProcessedAt } : {})
    }
  }
}
