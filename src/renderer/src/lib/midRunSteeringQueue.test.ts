import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import {
  appendMidRunQueuedMessage,
  buildMidRunQueuedMessage,
  findMidRunQueuedMessage,
  midRunQueuedMessageId,
  pendingMidRunQueuedMessageIds,
  shouldAppendDueScheduledRun
} from './midRunSteeringQueue'

const NOW = '2026-07-29T03:00:00.000Z'

describe('mid-run queued transcript messages', () => {
  it('uses a deterministic id derived from the durable run id', () => {
    expect(midRunQueuedMessageId('run-1')).toBe('midrun-queued-user-run-1')
  })

  it('builds a timestamped user row with durable queue provenance', () => {
    expect(
      buildMidRunQueuedMessage({
        runId: 'run-1',
        content: 'Please also check the retry path.',
        timestampIso: NOW,
        source: 'soloSteer'
      })
    ).toEqual({
      id: 'midrun-queued-user-run-1',
      role: 'user',
      content: 'Please also check the retry path.',
      timestamp: NOW,
      metadata: {
        kind: 'midRunSteering',
        midRunQueueRunId: 'run-1',
        midRunQueueSource: 'soloSteer'
      }
    })
  })

  it('appends once and recovers the same row after a restart', () => {
    const first = appendMidRunQueuedMessage([], {
      runId: 'run-1',
      content: 'Steer text',
      timestampIso: NOW,
      source: 'soloSteer'
    })
    const second = appendMidRunQueuedMessage(first.messages, {
      runId: 'run-1',
      content: 'Steer text',
      timestampIso: NOW,
      source: 'soloSteer'
    })

    expect(first.appended).toBe(true)
    expect(second.appended).toBe(false)
    expect(second.messages).toBe(first.messages)
    expect(findMidRunQueuedMessage(second.messages, 'run-1')).toBe(first.message)
  })

  it('does not mistake a non-user row with the deterministic id for the prompt', () => {
    const messages: ChatMessage[] = [
      {
        id: midRunQueuedMessageId('run-1'),
        role: 'system',
        content: 'not the prompt',
        timestamp: NOW
      }
    ]
    expect(findMidRunQueuedMessage(messages, 'run-1')).toBeNull()
  })

  it('dedupes pending exclusion ids while preserving order', () => {
    expect(pendingMidRunQueuedMessageIds(['run-1', 'run-2', 'run-1'])).toEqual([
      'midrun-queued-user-run-1',
      'midrun-queued-user-run-2'
    ])
  })
})

describe('shouldAppendDueScheduledRun', () => {
  it('appends only once the countdown has fired into a busy chat', () => {
    const dueAt = '2026-07-29T03:00:00.000Z'
    expect(
      shouldAppendDueScheduledRun({
        scheduledRunAt: dueAt,
        nowMs: Date.parse(dueAt),
        chatBusy: true
      })
    ).toBe(true)
    expect(
      shouldAppendDueScheduledRun({
        scheduledRunAt: dueAt,
        nowMs: Date.parse(dueAt) - 1,
        chatBusy: true
      })
    ).toBe(false)
    expect(
      shouldAppendDueScheduledRun({
        scheduledRunAt: dueAt,
        nowMs: Date.parse(dueAt),
        chatBusy: false
      })
    ).toBe(false)
  })

  it('rejects missing or malformed countdowns', () => {
    expect(
      shouldAppendDueScheduledRun({
        scheduledRunAt: undefined,
        nowMs: Date.parse(NOW),
        chatBusy: true
      })
    ).toBe(false)
    expect(
      shouldAppendDueScheduledRun({
        scheduledRunAt: 'not-a-date',
        nowMs: Date.parse(NOW),
        chatBusy: true
      })
    ).toBe(false)
  })
})
