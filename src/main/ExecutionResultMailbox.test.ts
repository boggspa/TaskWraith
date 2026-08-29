import { describe, expect, it } from 'vitest'
import {
  createExecutionResultMailboxEventId,
  emptyExecutionResultMailbox,
  enqueueExecutionResultMailboxEvent,
  latestExecutionResultOutcome,
  MAX_EXECUTION_RESULT_MAILBOX_PAYLOAD_CHARS,
  MAX_RETAINED_EXECUTION_RESULT_MAILBOX_EVENTS,
  normalizeExecutionResultMailbox
} from './ExecutionResultMailbox'

const base = {
  threadId: 'chat-one',
  executionId: 'ultratask-1',
  outputAttemptId: 'attempt-output-1',
  outcome: 'succeeded' as const,
  title: 'UltraTask',
  payload: { content: 'The reviewed synthesis.' }
}

describe('ExecutionResultMailbox', () => {
  it('stamps a durable, sequenced, already-processed record on first enqueue', () => {
    const { mailbox, event, inserted } = enqueueExecutionResultMailboxEvent(undefined, base, {
      now: '2026-08-29T00:00:00.000Z'
    })

    expect(inserted).toBe(true)
    expect(event.sequence).toBe(1)
    expect(mailbox.nextSequence).toBe(2)
    expect(event.threadId).toBe('chat-one')
    expect(event.kind).toBe('execution_result')
    // The durable record IS the delivery, exactly as the sub-thread mailbox
    // settled on. Nothing claims or drains these, so there is no pending state
    // for a crash to strand.
    expect(event.processedAt).toBe('2026-08-29T00:00:00.000Z')
    expect(event.trust).toBe('untrusted-graph-output')
  })

  // Exactly-once. The output stage can be re-entered by a restart replay, so a
  // second enqueue of the same logical result must find the first, not append.
  it('is idempotent on re-entry and does not mutate the ledger', () => {
    const first = enqueueExecutionResultMailboxEvent(undefined, base)
    const second = enqueueExecutionResultMailboxEvent(first.mailbox, base)

    expect(second.inserted).toBe(false)
    expect(second.event.id).toBe(first.event.id)
    expect(second.mailbox.events).toHaveLength(1)
    expect(second.mailbox.nextSequence).toBe(first.mailbox.nextSequence)
  })

  it('derives the id from thread, execution, and output attempt only', () => {
    const id = createExecutionResultMailboxEventId('chat-one', 'ultratask-1', 'attempt-output-1')
    expect(createExecutionResultMailboxEventId('chat-one', 'ultratask-1', 'attempt-output-1')).toBe(
      id
    )
    expect(
      createExecutionResultMailboxEventId('chat-one', 'ultratask-1', 'attempt-output-2')
    ).not.toBe(id)
    expect(id.startsWith('execution-result-')).toBe(true)
  })

  // A retry of the output stage is a genuinely different attempt, so it is a
  // different record — but the same attempt replayed is not.
  it('treats a distinct output attempt as a distinct result', () => {
    const first = enqueueExecutionResultMailboxEvent(undefined, base)
    const retried = enqueueExecutionResultMailboxEvent(first.mailbox, {
      ...base,
      outputAttemptId: 'attempt-output-2'
    })

    expect(retried.inserted).toBe(true)
    expect(retried.mailbox.events).toHaveLength(2)
  })

  it('truncates an oversized payload and records what was dropped', () => {
    const content = 'x'.repeat(MAX_EXECUTION_RESULT_MAILBOX_PAYLOAD_CHARS + 500)
    const { event } = enqueueExecutionResultMailboxEvent(undefined, {
      ...base,
      payload: { content }
    })

    expect(event.payload.content).toHaveLength(MAX_EXECUTION_RESULT_MAILBOX_PAYLOAD_CHARS)
    expect(event.payload.truncated).toBe(true)
    expect(event.payload.originalChars).toBe(content.length)
  })

  it('caps retained records so a busy thread cannot grow the ledger without bound', () => {
    let mailbox = emptyExecutionResultMailbox('chat-one')
    for (let index = 0; index < MAX_RETAINED_EXECUTION_RESULT_MAILBOX_EVENTS + 10; index += 1) {
      mailbox = enqueueExecutionResultMailboxEvent(mailbox, {
        ...base,
        executionId: `ultratask-${index}`
      }).mailbox
    }

    expect(mailbox.events).toHaveLength(MAX_RETAINED_EXECUTION_RESULT_MAILBOX_EVENTS)
    // Oldest dropped, newest kept.
    expect(mailbox.events.at(-1)?.executionId).toBe(
      `ultratask-${MAX_RETAINED_EXECUTION_RESULT_MAILBOX_EVENTS + 9}`
    )
  })

  it('reports the latest outcome for one execution', () => {
    const first = enqueueExecutionResultMailboxEvent(undefined, base)
    const second = enqueueExecutionResultMailboxEvent(first.mailbox, {
      ...base,
      outputAttemptId: 'attempt-output-2',
      outcome: 'failed'
    })

    expect(latestExecutionResultOutcome(second.mailbox, 'ultratask-1')).toBe('failed')
    expect(latestExecutionResultOutcome(second.mailbox, 'ultratask-missing')).toBeUndefined()
  })

  it('drops malformed persisted records instead of surfacing them', () => {
    const normalized = normalizeExecutionResultMailbox(
      {
        schemaVersion: 1,
        threadId: 'chat-one',
        nextSequence: 4,
        events: [
          { id: 'keep', sequence: 1, threadId: 'chat-one', kind: 'execution_result' },
          { nonsense: true },
          null
        ]
      },
      'chat-one'
    )

    expect(normalized.events.map((event) => event.id)).toEqual(['keep'])
  })
})
