import { describe, expect, it } from 'vitest'
import {
  MAX_SUBTHREAD_MAILBOX_PAYLOAD_CHARS,
  acknowledgeSubThreadMailboxDelivery,
  claimPendingSubThreadMailboxEvents,
  createSubThreadMailboxDeliveryRunId,
  createSubThreadMailboxEventId,
  enqueueSubThreadMailboxEvent,
  normalizeSubThreadMailbox,
  normalizeSubThreadMailboxLedger,
  pendingSubThreadMailboxEvents,
  releaseSubThreadMailboxDelivery
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

  it('derives a stable delivery run id from the ordered mailbox batch', () => {
    expect(createSubThreadMailboxDeliveryRunId(parentChatId, ['event-1', 'event-2'])).toBe(
      createSubThreadMailboxDeliveryRunId(parentChatId, ['event-1', 'event-2'])
    )
    expect(createSubThreadMailboxDeliveryRunId(parentChatId, ['event-1', 'event-2'])).toMatch(
      /^subthread-mailbox-[0-9a-f]{32}$/
    )
    expect(createSubThreadMailboxDeliveryRunId(parentChatId, ['event-1'])).not.toBe(
      createSubThreadMailboxDeliveryRunId(parentChatId, ['event-2'])
    )
  })

  it('enqueues ordered pending events with processedAt=null and deduplicates by id', () => {
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
    expect(first.event).toMatchObject({ sequence: 1, processedAt: null })
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

  it('caps durable payload size while retaining the original length', () => {
    const content = 'x'.repeat(MAX_SUBTHREAD_MAILBOX_PAYLOAD_CHARS + 73)
    const result = enqueueSubThreadMailboxEvent(undefined, eventInput({ content }))

    expect(result.event.payload.content.length).toBe(MAX_SUBTHREAD_MAILBOX_PAYLOAD_CHARS)
    expect(result.event.payload).toMatchObject({ truncated: true, originalChars: content.length })
  })

  it('claims pending events once in sequence order under a stable delivery run id', () => {
    const first = enqueueSubThreadMailboxEvent(undefined, eventInput()).mailbox
    const mailbox = enqueueSubThreadMailboxEvent(
      first,
      eventInput({ sourceAssistantMessageId: 'assistant-2' })
    ).mailbox
    const claimed = claimPendingSubThreadMailboxEvents(mailbox, {
      deliveryRunId: 'mailbox-run-1',
      claimedAt: '2026-07-11T12:03:00.000Z'
    })
    const competing = claimPendingSubThreadMailboxEvents(claimed.mailbox, {
      deliveryRunId: 'mailbox-run-2',
      claimedAt: '2026-07-11T12:04:00.000Z'
    })

    expect(claimed.events.map((event) => event.sequence)).toEqual([1, 2])
    expect(claimed.events.every((event) => event.deliveryRunId === 'mailbox-run-1')).toBe(true)
    expect(claimed.events.every((event) => event.deliveryAttempts === 1)).toBe(true)
    expect(competing.events).toHaveLength(0)
  })

  it('acknowledges only events claimed by the matching delivery run', () => {
    const mailbox = enqueueSubThreadMailboxEvent(undefined, eventInput()).mailbox
    const claimed = claimPendingSubThreadMailboxEvents(mailbox, {
      deliveryRunId: 'mailbox-run-1',
      claimedAt: '2026-07-11T12:03:00.000Z'
    }).mailbox
    const wrong = acknowledgeSubThreadMailboxDelivery(claimed, 'other-run', {
      processedAt: '2026-07-11T12:04:00.000Z'
    })
    const acknowledged = acknowledgeSubThreadMailboxDelivery(wrong.mailbox, 'mailbox-run-1', {
      processedAt: '2026-07-11T12:05:00.000Z'
    })

    expect(wrong.acknowledgedEventIds).toEqual([])
    expect(acknowledged.acknowledgedEventIds).toEqual([claimed.events[0].id])
    expect(acknowledged.mailbox.events[0]).toMatchObject({
      deliveryRunId: 'mailbox-run-1',
      processedAt: '2026-07-11T12:05:00.000Z'
    })
    expect(pendingSubThreadMailboxEvents(acknowledged.mailbox)).toHaveLength(0)
  })

  it('releases a failed claim for retry without losing delivery-attempt history', () => {
    const mailbox = enqueueSubThreadMailboxEvent(undefined, eventInput()).mailbox
    const claimed = claimPendingSubThreadMailboxEvents(mailbox, {
      deliveryRunId: 'mailbox-run-1',
      claimedAt: '2026-07-11T12:03:00.000Z'
    }).mailbox
    const released = releaseSubThreadMailboxDelivery(claimed, 'mailbox-run-1', {
      failedAt: '2026-07-11T12:04:00.000Z',
      error: 'preflight declined'
    })
    const retried = claimPendingSubThreadMailboxEvents(released.mailbox, {
      deliveryRunId: 'mailbox-run-2',
      claimedAt: '2026-07-11T12:05:00.000Z'
    })

    expect(released.releasedEventIds).toHaveLength(1)
    expect(released.mailbox.events[0]).toMatchObject({
      deliveryAttempts: 1,
      lastDeliveryError: {
        at: '2026-07-11T12:04:00.000Z',
        message: 'preflight declined'
      }
    })
    expect(released.mailbox.events[0].deliveryRunId).toBeUndefined()
    expect(retried.events[0].deliveryAttempts).toBe(2)
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
  })

  it('normalizes ledger keys without allowing prototype mutation', () => {
    const ledger = normalizeSubThreadMailboxLedger({
      mailboxes: JSON.parse('{"__proto__":{"events":[]}}')
    })

    expect(Object.getPrototypeOf(ledger.mailboxes)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(ledger.mailboxes, '__proto__')).toBe(true)
  })
})
