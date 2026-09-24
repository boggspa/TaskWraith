import { describe, expect, it } from 'vitest'
import {
  MAX_SUBTHREAD_MAILBOX_PAYLOAD_CHARS,
  createSubThreadMailboxEventId,
  enqueueSubThreadMailboxEvent,
  normalizeSubThreadMailbox,
  normalizeSubThreadMailboxLedger,
  summarizeSubThreadMailbox
} from './SubThreadMailbox'

const parentChatId = 'parent-1'

function eventInput(overrides: Record<string, unknown> = {}) {
  return {
    parentChatId,
    subThreadId: 'child-1',
    subThreadProvider: 'codex' as const,
    subThreadTitle: 'Codex worker',
    sourceAssistantMessageId: 'assistant-1',
    sourceRunId: 'run-child-1',
    outcome: 'done' as const,
    required: true,
    priority: 'normal' as const,
    content: 'Tests passed.',
    ...overrides
  }
}

const joinPolicy = {
  schemaVersion: 1 as const,
  groupId: 'parent-run-1',
  required: true,
  quorum: 2,
  debounceMs: 350,
  armedAt: '2026-07-11T12:00:00.000Z',
  deadlineAt: '2026-07-11T12:05:00.000Z',
  workerRunId: 'run-child-1'
}

describe('SubThreadMailbox', () => {
  it('derives a stable event id from the parent, child, and source assistant message', () => {
    const first = createSubThreadMailboxEventId(parentChatId, 'child-1', 'assistant-1')
    const same = createSubThreadMailboxEventId(parentChatId, 'child-1', 'assistant-1')
    const different = createSubThreadMailboxEventId(parentChatId, 'child-1', 'assistant-2')

    expect(first).toBe(same)
    expect(first).toMatch(/^subthread-result-[0-9a-f]{32}$/)
    expect(different).not.toBe(first)
  })

  it('stamps events processed at enqueue — the ledger has no delivery leg', () => {
    const { mailbox, event, inserted } = enqueueSubThreadMailboxEvent(undefined, {
      parentChatId: 'parent-1',
      subThreadId: 'child-1',
      subThreadTitle: 'Ledger check',
      sourceAssistantMessageId: 'assistant-1',
      outcome: 'done',
      required: true,
      priority: 'normal',
      content: 'Ledgered result.'
    })
    expect(inserted).toBe(true)
    expect(event.processedAt).toBe(event.createdAt)
    expect(event.deliveryRunId).toBeUndefined()
    const summary = summarizeSubThreadMailbox(mailbox)
    expect(summary.pending).toBe(0)
    expect(summary.claimed).toBe(0)
    expect(summary.blocked).toBe(0)
    expect(summary.processed).toBe(1)
  })

  it('enqueues ordered ledger events and deduplicates by id', () => {
    const first = enqueueSubThreadMailboxEvent(undefined, eventInput(), {
      now: '2026-07-11T12:00:00.000Z'
    })
    const duplicate = enqueueSubThreadMailboxEvent(first.mailbox, eventInput(), {
      now: '2026-07-11T12:01:00.000Z'
    })
    const second = enqueueSubThreadMailboxEvent(
      duplicate.mailbox,
      eventInput({ sourceAssistantMessageId: 'assistant-2', content: 'Second result.' }),
      { now: '2026-07-11T12:02:00.000Z' }
    )

    expect(first.inserted).toBe(true)
    expect(first.event).toMatchObject({ sequence: 1, processedAt: '2026-07-11T12:00:00.000Z' })
    expect(duplicate.inserted).toBe(false)
    expect(duplicate.mailbox.events).toHaveLength(1)
    expect(second.event.sequence).toBe(2)
    expect(second.mailbox.events.map((event) => event.payload.content)).toEqual([
      'Tests passed.',
      'Second result.'
    ])
  })

  it('persists the bounded join identity with the terminal event', () => {
    const result = enqueueSubThreadMailboxEvent(
      undefined,
      eventInput({ joinPolicy })
    )

    expect(result.event.join).toEqual(joinPolicy)
    expect(normalizeSubThreadMailbox(result.mailbox, parentChatId).events[0].join).toEqual(
      joinPolicy
    )
  })

  it('persists side-chat source attribution while normalizing legacy events as sub-threads', () => {
    const sideChat = enqueueSubThreadMailboxEvent(
      undefined,
      eventInput({ sourceRelation: 'sideChat' })
    )

    expect(sideChat.event.source.relation).toBe('sideChat')
    const legacy = structuredClone(sideChat.mailbox) as unknown as {
      events: Array<{ source: { relation?: string } }>
    }
    delete legacy.events[0].source.relation
    expect(normalizeSubThreadMailbox(legacy, parentChatId).events[0].source.relation).toBe(
      'subThread'
    )
  })

  it.each(['antigravity', 'muse'] as const)(
    'preserves the returned %s seat through enqueue and durable decode',
    (provider) => {
      const subThreadSeat = {
        provider,
        model: provider === 'antigravity' ? 'gemini-3-pro-high' : 'muse-spark-1.2',
        reasoningEffort: 'high'
      }
      const result = enqueueSubThreadMailboxEvent(
        undefined,
        eventInput({ subThreadProvider: provider, subThreadSeat })
      )

      expect(result.event.source).toMatchObject({ subThreadProvider: provider, subThreadSeat })
      expect(
        normalizeSubThreadMailbox(JSON.parse(JSON.stringify(result.mailbox)), parentChatId)
          .events[0].source
      ).toMatchObject({ subThreadProvider: provider, subThreadSeat })
    }
  )

  it('caps durable payload size while retaining the original length', () => {
    const content = 'x'.repeat(MAX_SUBTHREAD_MAILBOX_PAYLOAD_CHARS + 73)
    const result = enqueueSubThreadMailboxEvent(undefined, eventInput({ content }))

    expect(result.event.payload.content.length).toBe(MAX_SUBTHREAD_MAILBOX_PAYLOAD_CHARS)
    expect(result.event.payload).toMatchObject({ truncated: true, originalChars: content.length })
  })

  it('summarizes the processed ledger without payload content', () => {
    const first = enqueueSubThreadMailboxEvent(
      undefined,
      eventInput({ content: 'Sensitive first result' }),
      { now: '2026-07-11T12:01:00.000Z' }
    ).mailbox
    const second = enqueueSubThreadMailboxEvent(
      first,
      eventInput({
        subThreadId: 'child-2',
        sourceAssistantMessageId: 'assistant-2',
        outcome: 'failed',
        content: 'Sensitive second result'
      }),
      { now: '2026-07-11T12:02:00.000Z' }
    ).mailbox
    const third = enqueueSubThreadMailboxEvent(
      second,
      eventInput({
        sourceAssistantMessageId: 'assistant-3',
        outcome: 'requires_action',
        content: 'Sensitive blocked result'
      }),
      { now: '2026-07-11T12:03:00.000Z' }
    ).mailbox

    const parentSummary = summarizeSubThreadMailbox(third)
    const childSummary = summarizeSubThreadMailbox(third, { subThreadId: 'child-1' })
    expect(parentSummary).toEqual({
      retainedEvents: 3,
      pending: 0,
      claimed: 0,
      processed: 3,
      blocked: 0,
      outcomes: { done: 1, requires_action: 1, failed: 1, cancelled: 0 },
      delivery: {
        processedEvents: 3,
        batches: 3,
        coalescedBatches: 0,
        coalescedWakeupsAvoided: 0,
        lastProcessedAt: '2026-07-11T12:03:00.000Z'
      }
    })
    expect(childSummary).toMatchObject({
      retainedEvents: 2,
      pending: 0,
      processed: 2,
      blocked: 0
    })
    expect(JSON.stringify(parentSummary)).not.toContain('Sensitive')
    expect(JSON.stringify(childSummary)).not.toContain('Sensitive')
  })

  it('normalizes malformed durable state and preserves only valid ordered events', () => {
    const normalized = normalizeSubThreadMailbox(
      {
        schemaVersion: 99,
        parentChatId: 'wrong-parent',
        nextSequence: -1,
        events: [
          null,
          { id: '', sequence: 1 },
          {
            schemaVersion: 1,
            id: 'event-2',
            sequence: 2,
            parentChatId,
            kind: 'subthread_result',
            createdAt: '2026-07-11T12:02:00.000Z',
            processedAt: null,
            outcome: 'done',
            required: true,
            priority: 'normal',
            trust: 'untrusted-child-output',
            source: {
              subThreadId: 'child-2',
              subThreadTitle: 'Worker 2',
              sourceAssistantMessageId: 'assistant-2'
            },
            payload: { content: 'second' }
          },
          {
            schemaVersion: 1,
            id: 'event-1',
            sequence: 1,
            parentChatId,
            kind: 'subthread_result',
            createdAt: '2026-07-11T12:01:00.000Z',
            processedAt: null,
            outcome: 'done',
            required: true,
            priority: 'normal',
            trust: 'untrusted-child-output',
            source: {
              subThreadId: 'child-1',
              subThreadTitle: 'Worker 1',
              sourceAssistantMessageId: 'assistant-1'
            },
            payload: { content: 'first' }
          }
        ]
      },
      parentChatId
    )

    expect(normalized.schemaVersion).toBe(1)
    expect(normalized.parentChatId).toBe(parentChatId)
    expect(normalized.events.map((event) => event.id)).toEqual(['event-1', 'event-2'])
    expect(normalized.nextSequence).toBe(3)
    // Legacy pre-removal pending rows are stamped processed at read.
    expect(normalized.events.every((event) => event.processedAt === event.createdAt)).toBe(true)
  })

  it('normalizes ledger keys without allowing prototype mutation', () => {
    const ledger = normalizeSubThreadMailboxLedger({
      mailboxes: JSON.parse('{"__proto__":{"events":[]}}')
    })

    expect(Object.getPrototypeOf(ledger.mailboxes)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(ledger.mailboxes, '__proto__')).toBe(true)
  })
})
