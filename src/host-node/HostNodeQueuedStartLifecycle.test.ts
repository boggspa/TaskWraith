import { describe, expect, it } from 'vitest'

import {
  createHostNodeQueuedStartLifecycle,
  createInMemoryExecutionClaimStore,
  terminalOutcomeToRejectCode,
  type HostQueuedStartExecutionClaimStore
} from './HostNodeQueuedStartLifecycle'

function fakeLease(commandId: string, threadId = 'thread-a') {
  const state = { releases: 0 }
  return {
    state,
    lease: {
      commandId,
      threadId,
      release() {
        state.releases += 1
      }
    }
  }
}

function reserveInput(overrides: Record<string, string> = {}) {
  return { commandId: 'cmd-1', threadId: 'thread-a', fingerprint: 'fp-1', ...overrides }
}

async function claimedLifecycle() {
  const lifecycle = createHostNodeQueuedStartLifecycle()
  lifecycle.reserve(reserveInput())
  const holder = fakeLease('cmd-1')
  const claim = await lifecycle.claim('cmd-1', holder.lease)
  if (claim.kind !== 'claimed') throw new Error('expected claim')
  return { lifecycle, holder }
}

describe('HostNodeQueuedStartLifecycle (M2 prep, A1.3)', () => {
  it('cancel_before_claim_no_spawn', async () => {
    const lifecycle = createHostNodeQueuedStartLifecycle()
    lifecycle.reserve(reserveInput())

    const cancel = lifecycle.cancel({ commandId: 'cmd-1', threadId: 'thread-a' })
    expect(cancel).toEqual({ kind: 'settled', outcome: 'cancelled_before_start' })

    // The claim is refused and the spawn guard never runs the callback.
    const claim = await lifecycle.claim('cmd-1', fakeLease('cmd-1').lease)
    expect(claim).toEqual({ kind: 'refused', reason: 'already_terminal' })
    let spawns = 0
    const start = await lifecycle.executeStart('cmd-1', () => {
      spawns += 1
    })
    expect(start.kind).toBe('skipped')
    expect(spawns).toBe(0)
  })

  it('cancel_after_claim_before_run_latched', async () => {
    const { lifecycle, holder } = await claimedLifecycle()

    const cancel = lifecycle.cancel({ commandId: 'cmd-1' })
    expect(cancel).toEqual({ kind: 'latched' })
    // Claimed-but-never-ran settles as cancelled_before_start; the admission
    // lease is released exactly once.
    expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBe('cancelled_before_start')
    expect(holder.state.releases).toBe(1)

    // The latch survives the gap: a late cancel registration still receives
    // the cancellation, exactly once.
    let providerCancels = 0
    const registration = lifecycle.providerCancelRegistered('cmd-1', () => {
      providerCancels += 1
    })
    expect(registration).toEqual({ kind: 'invoked' })
    expect(providerCancels).toBe(1)
    expect(lifecycle.cancel({ commandId: 'cmd-1' })).toEqual({
      kind: 'already_terminal',
      outcome: 'cancelled_before_start'
    })
    expect(providerCancels).toBe(1)
    expect(holder.state.releases).toBe(1)
  })

  it('cancel_after_begin_before_register_latched', async () => {
    const { lifecycle } = await claimedLifecycle()
    const start = await lifecycle.executeStart('cmd-1', () => {})
    expect(start).toEqual({ kind: 'started' })

    expect(lifecycle.cancel({ commandId: 'cmd-1' })).toEqual({ kind: 'latched' })
    // The run DID begin, so the reservation stays open waiting for the
    // provider cancel registration rather than settling as never-started.
    expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBeNull()

    let providerCancels = 0
    expect(
      lifecycle.providerCancelRegistered('cmd-1', () => {
        providerCancels += 1
      })
    ).toEqual({ kind: 'invoked' })
    expect(providerCancels).toBe(1)

    expect(lifecycle.settle('cmd-1', 'cancelled')).toBe(true)
    expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBe('cancelled')
  })

  it('fast_finish_retains_started', async () => {
    const { lifecycle } = await claimedLifecycle()
    await lifecycle.executeStart('cmd-1', () => {})
    expect(lifecycle.markStarted('cmd-1')).toEqual({ kind: 'recorded' })
    // Finish faster than any poll could observe: the started evidence is
    // monotonic and survives completion.
    expect(lifecycle.settle('cmd-1', 'completed')).toBe(true)
    const view = lifecycle.getReservation('cmd-1')
    expect(view?.startedEvidence).toBe(true)
    expect(view?.terminalOutcome).toBe('completed')

    // A late duplicate witness after terminalization is fenced and counted.
    expect(lifecycle.markStarted('cmd-1')).toEqual({ kind: 'fenced' })
    expect(lifecycle.stats().fencedLateStarts).toBe(1)
  })

  it('shutdown_no_late_spawn', async () => {
    const lifecycle = createHostNodeQueuedStartLifecycle()
    lifecycle.reserve(reserveInput())
    lifecycle.reserve(
      reserveInput({ commandId: 'cmd-2', threadId: 'thread-b', fingerprint: 'fp-2' })
    )
    const holder = fakeLease('cmd-2', 'thread-b')
    await lifecycle.claim('cmd-2', holder.lease)

    lifecycle.beginShutdown()

    // Unclaimed reservation settled as host_shutting_down; claimed one is
    // drained via the latch, not force-settled.
    expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBe('host_shutting_down')
    expect(lifecycle.getReservation('cmd-2')?.cancelLatched).toBe(true)
    expect(lifecycle.getReservation('cmd-2')?.terminalOutcome).toBeNull()

    // No late reservations, claims or spawns after the fence.
    expect(
      lifecycle.reserve(
        reserveInput({ commandId: 'cmd-3', threadId: 'thread-c', fingerprint: 'fp-3' })
      )
    ).toEqual({
      kind: 'refused',
      reason: 'host_shutting_down'
    })
    let spawns = 0
    const start = await lifecycle.executeStart('cmd-2', () => {
      spawns += 1
    })
    expect(start).toEqual({ kind: 'skipped', reason: 'cancel_latched' })
    expect(spawns).toBe(0)
  })

  it('duplicate_id_one_waiter', () => {
    const lifecycle = createHostNodeQueuedStartLifecycle()
    const first = lifecycle.reserve(reserveInput())
    const second = lifecycle.reserve(reserveInput())
    if (first.kind !== 'reserved' || second.kind !== 'duplicate') {
      throw new Error('expected reserved then duplicate')
    }
    // Same reservation identity — never a second waiter.
    expect(second.reservation).toBe(first.reservation)
    expect(lifecycle.stats().reservations).toBe(1)

    // Same id with a different payload is a conflict, not a waiter either.
    const conflict = lifecycle.reserve(reserveInput({ fingerprint: 'fp-other' }))
    expect(conflict.kind).toBe('conflict')
    expect(lifecycle.stats().reservations).toBe(1)
  })

  it('hard_restart_claimed_indeterminate', async () => {
    const store = createInMemoryExecutionClaimStore()
    const first = createHostNodeQueuedStartLifecycle({ executionClaimStore: store })
    first.reserve(reserveInput())
    first.reserve(reserveInput({ commandId: 'cmd-2', threadId: 'thread-b', fingerprint: 'fp-2' }))
    await first.claim('cmd-1', fakeLease('cmd-1').lease)
    // cmd-2 was reserved but PROVABLY never claimed: no durable claim record.

    // Hard restart: a fresh lifecycle over the same durable store.
    const reopened = createHostNodeQueuedStartLifecycle({ executionClaimStore: store })
    const outcomes = await reopened.reopen([
      { commandId: 'cmd-1', threadId: 'thread-a', fingerprint: 'fp-1' },
      { commandId: 'cmd-2', threadId: 'thread-b', fingerprint: 'fp-2' }
    ])
    expect(outcomes).toEqual([
      { commandId: 'cmd-1', outcome: 'indeterminate', resubmittable: null },
      {
        commandId: 'cmd-2',
        outcome: 'host_shutting_down',
        resubmittable: { newIdRequired: true }
      }
    ])
  })

  it('rejects a cross-identity cancel without touching the reservation', async () => {
    const { lifecycle } = await claimedLifecycle()
    const cancel = lifecycle.cancel({ commandId: 'cmd-1', threadId: 'thread-other' })
    expect(cancel).toEqual({ kind: 'rejected', reason: 'identity_mismatch' })
    const view = lifecycle.getReservation('cmd-1')
    expect(view?.cancelLatched).toBe(false)
    expect(view?.terminalOutcome).toBeNull()
  })

  it('settles sync throw and async reject in the start callback as failed, once', async () => {
    const lifecycle = createHostNodeQueuedStartLifecycle()
    lifecycle.reserve(reserveInput())
    const holder = fakeLease('cmd-1')
    await lifecycle.claim('cmd-1', holder.lease)
    const syncFail = await lifecycle.executeStart('cmd-1', () => {
      throw new Error('spawn exploded')
    })
    expect(syncFail.kind).toBe('failed')
    expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBe('failed')
    expect(holder.state.releases).toBe(1)

    lifecycle.reserve(
      reserveInput({ commandId: 'cmd-2', threadId: 'thread-b', fingerprint: 'fp-2' })
    )
    const holder2 = fakeLease('cmd-2', 'thread-b')
    await lifecycle.claim('cmd-2', holder2.lease)
    const asyncFail = await lifecycle.executeStart('cmd-2', () => Promise.reject(new Error('nope')))
    expect(asyncFail.kind).toBe('failed')
    expect(lifecycle.getReservation('cmd-2')?.terminalOutcome).toBe('failed')
    expect(holder2.state.releases).toBe(1)
  })

  it('fences a late markStarted after the start wait timed out', async () => {
    const { lifecycle } = await claimedLifecycle()
    await lifecycle.executeStart('cmd-1', () => {})
    expect(lifecycle.expireStartWait('cmd-1')).toBe(true)
    expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBe('start_timeout')

    expect(lifecycle.markStarted('cmd-1')).toEqual({ kind: 'fenced' })
    expect(lifecycle.getReservation('cmd-1')?.startedEvidence).toBe(false)
    expect(lifecycle.stats().fencedLateStarts).toBe(1)
  })

  it('distinguishes graceful shutdown (drain in-process) from hard restart (reopen)', async () => {
    // Graceful: claimed run is cancelled through the latch and settles.
    const store = createInMemoryExecutionClaimStore()
    const lifecycle = createHostNodeQueuedStartLifecycle({ executionClaimStore: store })
    lifecycle.reserve(reserveInput())
    const holder = fakeLease('cmd-1')
    await lifecycle.claim('cmd-1', holder.lease)
    await lifecycle.executeStart('cmd-1', () => {})
    let providerCancels = 0
    lifecycle.providerCancelRegistered('cmd-1', () => {
      providerCancels += 1
    })
    lifecycle.beginShutdown()
    expect(providerCancels).toBe(1)
    expect(lifecycle.settle('cmd-1', 'cancelled')).toBe(true)
    expect(holder.state.releases).toBe(1)

    // Hard: same store, fresh instance — the claim is evidence the provider
    // may have started, so reopen reports indeterminate, never a replay.
    const reopened = createHostNodeQueuedStartLifecycle({ executionClaimStore: store })
    const outcomes = await reopened.reopen([
      { commandId: 'cmd-1', threadId: 'thread-a', fingerprint: 'fp-1' }
    ])
    expect(outcomes).toEqual([
      { commandId: 'cmd-1', outcome: 'indeterminate', resubmittable: null }
    ])
  })

  it('settles exactly one terminal outcome per reservation', async () => {
    const terminalOutcomes: string[] = []
    const lifecycle = createHostNodeQueuedStartLifecycle({
      onTerminal: (view, outcome) => terminalOutcomes.push(`${view.commandId}:${outcome}`)
    })
    lifecycle.reserve(reserveInput())
    await lifecycle.claim('cmd-1', fakeLease('cmd-1').lease)
    lifecycle.cancel({ commandId: 'cmd-1' })
    // Later settles are no-ops: exactly one terminal transition, one callback.
    expect(lifecycle.settle('cmd-1', 'completed')).toBe(false)
    expect(lifecycle.cancel({ commandId: 'cmd-1' })).toEqual({
      kind: 'already_terminal',
      outcome: 'cancelled_before_start'
    })
    expect(terminalOutcomes).toEqual(['cmd-1:cancelled_before_start'])
  })

  it('never leaks the admission lease across every terminal path', async () => {
    const lifecycle = createHostNodeQueuedStartLifecycle()
    // Path 1: claimed then completed.
    lifecycle.reserve(reserveInput())
    const done = fakeLease('cmd-1')
    await lifecycle.claim('cmd-1', done.lease)
    await lifecycle.executeStart('cmd-1', () => {})
    lifecycle.markStarted('cmd-1')
    lifecycle.settle('cmd-1', 'completed')
    expect(done.state.releases).toBe(1)

    // Path 2: claimed then cancelled pre-run.
    lifecycle.reserve(
      reserveInput({ commandId: 'cmd-2', threadId: 'thread-b', fingerprint: 'fp-2' })
    )
    const cancelled = fakeLease('cmd-2', 'thread-b')
    await lifecycle.claim('cmd-2', cancelled.lease)
    lifecycle.cancel({ commandId: 'cmd-2' })
    expect(cancelled.state.releases).toBe(1)

    // Path 3: claimed, timed out waiting for persisted start.
    lifecycle.reserve(
      reserveInput({ commandId: 'cmd-3', threadId: 'thread-c', fingerprint: 'fp-3' })
    )
    const timedOut = fakeLease('cmd-3', 'thread-c')
    await lifecycle.claim('cmd-3', timedOut.lease)
    lifecycle.expireStartWait('cmd-3')
    expect(timedOut.state.releases).toBe(1)

    // Path 4: claimed then shutdown drains it, settled by the provider cancel.
    lifecycle.reserve(
      reserveInput({ commandId: 'cmd-4', threadId: 'thread-d', fingerprint: 'fp-4' })
    )
    const drained = fakeLease('cmd-4', 'thread-d')
    await lifecycle.claim('cmd-4', drained.lease)
    lifecycle.beginShutdown()
    lifecycle.settle('cmd-4', 'cancelled')
    expect(drained.state.releases).toBe(1)
  })

  it('refuses the claim when the durable execution claim cannot be recorded', async () => {
    const failingStore: HostQueuedStartExecutionClaimStore = {
      record() {
        throw new Error('disk full')
      },
      list() {
        return []
      }
    }
    const lifecycle = createHostNodeQueuedStartLifecycle({ executionClaimStore: failingStore })
    lifecycle.reserve(reserveInput())
    const holder = fakeLease('cmd-1')
    const claim = await lifecycle.claim('cmd-1', holder.lease)
    expect(claim).toEqual({ kind: 'refused', reason: 'claim_record_failed' })
    expect(lifecycle.stats().claimRecordFailures).toBe(1)
    // No claim recorded → no spawn: the start guard refuses too.
    const start = await lifecycle.executeStart('cmd-1', () => {})
    expect(start.kind).toBe('skipped')
    expect(holder.state.releases).toBe(0)
  })

  it('treats an unreadable claim store on reopen as unknown → indeterminate', async () => {
    const brokenStore: HostQueuedStartExecutionClaimStore = {
      record() {
        // Record succeeds; only list() is unreadable.
      },
      list() {
        throw new Error('corrupt')
      }
    }
    const lifecycle = createHostNodeQueuedStartLifecycle({ executionClaimStore: brokenStore })
    const outcomes = await lifecycle.reopen([
      { commandId: 'cmd-1', threadId: 'thread-a', fingerprint: 'fp-1' }
    ])
    expect(outcomes).toEqual([
      { commandId: 'cmd-1', outcome: 'indeterminate', resubmittable: null }
    ])
  })

  it('maps admission-level terminal outcomes onto existing typed codes only', () => {
    expect(terminalOutcomeToRejectCode('cancelled_before_start')).toBe('run_start_cancelled')
    expect(terminalOutcomeToRejectCode('host_shutting_down')).toBe('host_shutting_down')
    expect(terminalOutcomeToRejectCode('rejected')).toBe('thread_busy')
    // Receipt-level outcomes never become new transport codes.
    expect(terminalOutcomeToRejectCode('completed')).toBeNull()
    expect(terminalOutcomeToRejectCode('start_timeout')).toBeNull()
    expect(terminalOutcomeToRejectCode('indeterminate')).toBeNull()
  })
})
