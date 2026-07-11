import { describe, expect, it } from 'vitest'
import {
  MAX_SUBTHREAD_WORKER_PENDING_PROMPT_CHARS,
  bindSubThreadWorkerEventToRun,
  cancelPendingSubThreadWorkerEvents,
  claimNextSubThreadWorkerEvent,
  createSubThreadWorkerEventId,
  createSubThreadWorkerRunId,
  enqueueSubThreadWorkerEvent,
  failClaimedSubThreadWorkerEvent,
  normalizeSubThreadWorkerControl,
  pendingSubThreadWorkerEvents,
  recoverSubThreadWorkerControl,
  releaseSubThreadWorkerEventClaim,
  settleSubThreadWorkerEvent,
  summarizeSubThreadWorkerControl
} from './SubThreadWorkerControl'

const now = '2026-07-11T12:00:00.000Z'

function input(toolCallId: string, prompt = `Prompt ${toolCallId}`) {
  return {
    sourceToolCallId: toolCallId,
    parentChatId: 'parent-1',
    subThreadId: 'child-1',
    targetProvider: 'codex' as const,
    parentProvider: 'claude' as const,
    parentRunId: 'parent-run-1',
    prompt,
    returnResultToParent: true,
    approvalMode: 'plan'
  }
}

describe('SubThreadWorkerControl', () => {
  it('derives stable event ids and deduplicates a replayed tool call', () => {
    const id = createSubThreadWorkerEventId('parent-1', 'child-1', 'tool-1')
    const first = enqueueSubThreadWorkerEvent(undefined, input('tool-1'), now)
    const replay = enqueueSubThreadWorkerEvent(first.control, input('tool-1'), now)

    expect(first.event.id).toBe(id)
    expect(first.event.plannedRunId).toBe(createSubThreadWorkerRunId(id, 'codex'))
    expect(first.added).toBe(true)
    expect(replay.added).toBe(false)
    expect(replay.control.events).toHaveLength(1)
  })

  it('keeps normal events FIFO while an interrupt jumps the pending queue', () => {
    const first = enqueueSubThreadWorkerEvent(undefined, input('tool-1'), now)
    const second = enqueueSubThreadWorkerEvent(
      first.control,
      input('tool-2'),
      '2026-07-11T12:00:01.000Z'
    )
    const interrupt = enqueueSubThreadWorkerEvent(
      second.control,
      { ...input('tool-3'), priority: 'interrupt' as const },
      '2026-07-11T12:00:02.000Z'
    )

    expect(
      pendingSubThreadWorkerEvents(interrupt.control).map((event) => event.sourceToolCallId)
    ).toEqual(['tool-3', 'tool-1', 'tool-2'])
  })

  it('claims before dispatch, binds processedAt exactly once, and settles by run id', () => {
    const queued = enqueueSubThreadWorkerEvent(undefined, input('tool-1'), now)
    const claimed = claimNextSubThreadWorkerEvent(
      queued.control,
      'claim-1',
      '2026-07-11T12:00:01.000Z'
    )
    expect(claimed.event).toMatchObject({ status: 'claimed', attempts: 1, claimId: 'claim-1' })

    const dispatched = bindSubThreadWorkerEventToRun(
      claimed.control,
      claimed.event!.id,
      'claim-1',
      claimed.event!.plannedRunId,
      '2026-07-11T12:00:02.000Z'
    )
    const bound = dispatched.events[0]
    expect(bound).toMatchObject({
      status: 'dispatched',
      dispatchRunId: claimed.event!.plannedRunId,
      processedAt: '2026-07-11T12:00:02.000Z'
    })
    expect(claimNextSubThreadWorkerEvent(dispatched, 'claim-2').event).toBeUndefined()

    const settled = settleSubThreadWorkerEvent(dispatched, claimed.event!.plannedRunId, 'completed', {
      now: '2026-07-11T12:00:03.000Z'
    })
    expect(settled.event).toMatchObject({
      status: 'completed',
      processedAt: '2026-07-11T12:00:02.000Z',
      terminalAt: '2026-07-11T12:00:03.000Z'
    })
  })

  it('releases only the matching claim and preserves queue order', () => {
    const queued = enqueueSubThreadWorkerEvent(undefined, input('tool-1'), now)
    const claimed = claimNextSubThreadWorkerEvent(queued.control, 'claim-1')

    expect(
      releaseSubThreadWorkerEventClaim(claimed.control, claimed.event!.id, 'wrong').events[0].status
    ).toBe('claimed')
    expect(
      releaseSubThreadWorkerEventClaim(claimed.control, claimed.event!.id, 'claim-1').events[0]
        .status
    ).toBe('pending')
  })

  it('hard cancellation clears pending and claimed work but not an already dispatched turn', () => {
    const first = enqueueSubThreadWorkerEvent(undefined, input('tool-1'), now)
    const second = enqueueSubThreadWorkerEvent(first.control, input('tool-2'), now)
    const claimed = claimNextSubThreadWorkerEvent(second.control, 'claim-1')
    const dispatched = bindSubThreadWorkerEventToRun(
      claimed.control,
      claimed.event!.id,
      'claim-1',
      claimed.event!.plannedRunId
    )
    const cancelled = cancelPendingSubThreadWorkerEvents(dispatched, {
      now: '2026-07-11T12:00:05.000Z',
      reason: 'Hard stop.'
    })

    expect(cancelled.cancelledEventIds).toHaveLength(1)
    expect(cancelled.control.events.map((event) => event.status)).toEqual([
      'dispatched',
      'cancelled'
    ])
  })

  it('recovers an unbound claim for retry but never replays an uncertain dispatched event', () => {
    const first = enqueueSubThreadWorkerEvent(undefined, input('tool-1'), now)
    const second = enqueueSubThreadWorkerEvent(first.control, input('tool-2'), now)
    const claimed = claimNextSubThreadWorkerEvent(second.control, 'claim-1')
    const dispatched = bindSubThreadWorkerEventToRun(
      claimed.control,
      claimed.event!.id,
      'claim-1',
      claimed.event!.plannedRunId
    )
    const claimedSecond = {
      ...dispatched,
      events: dispatched.events.map((event) =>
        event.sourceToolCallId === 'tool-2'
          ? { ...event, status: 'claimed' as const, claimId: 'claim-2', claimedAt: now }
          : event
      )
    }
    const recovered = recoverSubThreadWorkerControl(claimedSecond, [], '2026-07-11T12:01:00.000Z')

    expect(recovered.events.map((event) => event.status)).toEqual(['failed', 'pending'])
    expect(recovered.events[0].error).toMatch(/did not replay it/i)
  })

  it('reconciles dispatched events from terminal run records during recovery', () => {
    const queued = enqueueSubThreadWorkerEvent(undefined, input('tool-1'), now)
    const claimed = claimNextSubThreadWorkerEvent(queued.control, 'claim-1')
    const dispatched = bindSubThreadWorkerEventToRun(
      claimed.control,
      claimed.event!.id,
      'claim-1',
      claimed.event!.plannedRunId
    )

    expect(
      recoverSubThreadWorkerControl(dispatched, [
        { runId: claimed.event!.plannedRunId, status: 'cancelled', cancelled: true }
      ]).events[0].status
    ).toBe('cancelled')
  })

  it('refuses run-id substitution and can fail a claimed event without processing it', () => {
    const queued = enqueueSubThreadWorkerEvent(undefined, input('tool-1'), now)
    const claimed = claimNextSubThreadWorkerEvent(queued.control, 'claim-1')

    expect(() =>
      bindSubThreadWorkerEventToRun(
        claimed.control,
        claimed.event!.id,
        'claim-1',
        'different-run-id'
      )
    ).toThrow(/planned run id/i)

    const failed = failClaimedSubThreadWorkerEvent(
      claimed.control,
      claimed.event!.id,
      'claim-1',
      'No resumable provider session.',
      '2026-07-11T12:00:05.000Z'
    ).events[0]
    expect(failed).toMatchObject({
      status: 'failed',
      terminalAt: '2026-07-11T12:00:05.000Z',
      error: 'No resumable provider session.'
    })
    expect(failed.processedAt).toBeUndefined()
  })

  it('enforces a strict aggregate pending prompt budget', () => {
    const first = enqueueSubThreadWorkerEvent(undefined, input('tool-1', 'a'.repeat(20_000)), now)
    const second = enqueueSubThreadWorkerEvent(
      first.control,
      input('tool-2', 'b'.repeat(20_000)),
      now
    )
    const third = enqueueSubThreadWorkerEvent(
      second.control,
      input('tool-3', 'c'.repeat(20_000)),
      now
    )

    expect(() =>
      enqueueSubThreadWorkerEvent(
        third.control,
        input('tool-4', 'd'.repeat(MAX_SUBTHREAD_WORKER_PENDING_PROMPT_CHARS - 60_000 + 1)),
        now
      )
    ).toThrow(/aggregate prompt budget/i)
  })

  it('normalizes corrupt durable state and reports an attachment summary', () => {
    const normalized = normalizeSubThreadWorkerControl({
      attachedAt: now,
      events: [null, { nope: true }]
    })
    expect(normalized.events).toEqual([])
    expect(summarizeSubThreadWorkerControl(normalized)).toEqual({
      attachedAt: now,
      pending: 0,
      active: 0,
      terminal: 0
    })
  })
})
