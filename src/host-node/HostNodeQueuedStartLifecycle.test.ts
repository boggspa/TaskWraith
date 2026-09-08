import { describe, expect, it } from 'vitest'

import {
  createHostNodeQueuedStartLifecycle,
  createInMemoryExecutionClaimStore,
  terminalOutcomeToRejectCode,
  type HostQueuedStartExecutionClaim,
  type HostQueuedStartExecutionClaimStore
} from './HostNodeQueuedStartLifecycle'
import { createHostNodeRunAdmission } from './HostNodeRunAdmission'

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

/**
 * Drains the pending microtask chain so an initiated executeStart passes its
 * `await claimReady` readiness gate and takes the dispatch token before the
 * test races a cancel/timeout against the now-pending dispatch.
 */
async function settleMicrotasks() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * The in-memory store never declares durable coverage; reopen's absence
 * classification (M2 fix L4) needs a fixture modelling the future
 * file-backed store's declaration.
 */
function durableStore() {
  return Object.assign(createInMemoryExecutionClaimStore(), { declaresDurableCoverage: true })
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

    // Unclaimed reservation settled as host_shutting_down. The claimed but
    // NEVER-DISPATCHED one settles too, releasing its capacity: no foreign
    // start code exists and executeStart refuses behind the fence, so
    // nothing would ever settle or release it later (M2 fix L3).
    expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBe('host_shutting_down')
    expect(lifecycle.getReservation('cmd-2')?.terminalOutcome).toBe('host_shutting_down')
    expect(holder.state.releases).toBe(1)

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
    expect(start).toEqual({ kind: 'skipped', reason: 'terminal:host_shutting_down' })
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
    // Absence-based resubmission requires DECLARED durable coverage (L4).
    const store = durableStore()
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
    const store = durableStore()
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
      declaresDurableCoverage: true,
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

describe('HostNodeQueuedStartLifecycle M2 repair (L1-L4)', () => {
  it('refuses a second claim synchronously while the durable write is in flight', async () => {
    const gate = deferred()
    let records = 0
    const store: HostQueuedStartExecutionClaimStore = {
      record() {
        records += 1
        return gate.promise
      },
      list() {
        return []
      }
    }
    const lifecycle = createHostNodeQueuedStartLifecycle({ executionClaimStore: store })
    lifecycle.reserve(reserveInput())
    const winner = fakeLease('cmd-1')
    const loser = fakeLease('cmd-1')
    const first = lifecycle.claim('cmd-1', winner.lease)
    // The second claim loses IMMEDIATELY: ownership was taken synchronously,
    // not at the durable write's resolution where the later assignment would
    // silently overwrite the earlier lease (L1).
    const second = await lifecycle.claim('cmd-1', loser.lease)
    expect(second).toEqual({ kind: 'refused', reason: 'already_claimed' })
    expect(records).toBe(1)
    gate.resolve()
    expect((await first).kind).toBe('claimed')
    // The refused caller keeps its lease; the lifecycle owns only the
    // winner's and releases exactly that one at terminalization.
    expect(loser.state.releases).toBe(0)
    lifecycle.cancel({ commandId: 'cmd-1' })
    expect(winner.state.releases).toBe(1)
    expect(loser.state.releases).toBe(0)
  })

  it('refuses a lease minted for another identity before any durable write', async () => {
    let records = 0
    const store: HostQueuedStartExecutionClaimStore = {
      record() {
        records += 1
      },
      list() {
        return []
      }
    }
    const lifecycle = createHostNodeQueuedStartLifecycle({ executionClaimStore: store })
    lifecycle.reserve(reserveInput())
    const wrongCommand = fakeLease('cmd-OTHER')
    expect(await lifecycle.claim('cmd-1', wrongCommand.lease)).toEqual({
      kind: 'refused',
      reason: 'lease_identity_mismatch'
    })
    const wrongThread = fakeLease('cmd-1', 'thread-OTHER')
    expect(await lifecycle.claim('cmd-1', wrongThread.lease)).toEqual({
      kind: 'refused',
      reason: 'lease_identity_mismatch'
    })
    // No durable claim was recorded on a foreign lease's authority, both
    // leases stay with their callers, and the reservation stays claimable.
    expect(records).toBe(0)
    expect(wrongCommand.state.releases).toBe(0)
    expect(wrongThread.state.releases).toBe(0)
    expect((await lifecycle.claim('cmd-1', fakeLease('cmd-1').lease)).kind).toBe('claimed')
    expect(records).toBe(1)
  })

  it('honours a cancel landing during the durable write; the caller keeps the lease', async () => {
    const gate = deferred()
    const store: HostQueuedStartExecutionClaimStore = {
      record() {
        return gate.promise
      },
      list() {
        return []
      }
    }
    const lifecycle = createHostNodeQueuedStartLifecycle({ executionClaimStore: store })
    lifecycle.reserve(reserveInput())
    const holder = fakeLease('cmd-1')
    const claim = lifecycle.claim('cmd-1', holder.lease)
    expect(lifecycle.cancel({ commandId: 'cmd-1', threadId: 'thread-a' })).toEqual({
      kind: 'settled',
      outcome: 'cancelled_before_start'
    })
    gate.resolve()
    expect(await claim).toEqual({ kind: 'refused', reason: 'already_terminal' })
    // The lease never transferred: the lifecycle must not release what it
    // refused, so no double-release can ever follow.
    expect(holder.state.releases).toBe(0)
    const start = await lifecycle.executeStart('cmd-1', () => {})
    expect(start).toEqual({ kind: 'skipped', reason: 'terminal:cancelled_before_start' })
  })

  it('executeStart waits for an in-flight claim instead of skipping as not_claimed', async () => {
    const gate = deferred()
    const store: HostQueuedStartExecutionClaimStore = {
      record() {
        return gate.promise
      },
      list() {
        return []
      }
    }
    const lifecycle = createHostNodeQueuedStartLifecycle({ executionClaimStore: store })
    lifecycle.reserve(reserveInput())
    const claim = lifecycle.claim('cmd-1', fakeLease('cmd-1').lease)
    let spawns = 0
    const start = lifecycle.executeStart('cmd-1', () => {
      spawns += 1
    })
    gate.resolve()
    expect((await claim).kind).toBe('claimed')
    // The start issued while the durable write was in flight is NOT lost.
    expect(await start).toEqual({ kind: 'started' })
    expect(spawns).toBe(1)
  })

  it('dispatches the start callback at most once across concurrent and repeated calls', async () => {
    const { lifecycle } = await claimedLifecycle()
    const gate = deferred()
    let spawns = 0
    const begin = () => {
      spawns += 1
      return gate.promise
    }
    const first = lifecycle.executeStart('cmd-1', begin)
    const second = await lifecycle.executeStart('cmd-1', begin)
    expect(second).toEqual({ kind: 'skipped', reason: 'already_dispatched' })
    gate.resolve()
    expect(await first).toEqual({ kind: 'started' })
    expect(await lifecycle.executeStart('cmd-1', begin)).toEqual({
      kind: 'skipped',
      reason: 'already_dispatched'
    })
    expect(spawns).toBe(1)
  })

  it('a cancel during a pending dispatch latches without freeing capacity mid-start', async () => {
    const { lifecycle, holder } = await claimedLifecycle()
    const gate = deferred()
    const start = lifecycle.executeStart('cmd-1', () => gate.promise)
    await settleMicrotasks()
    expect(lifecycle.getReservation('cmd-1')?.dispatched).toBe(true)
    // Dispatch has begun: settling here would free the slot while the
    // provider start is executing (L2). Only the latch may be taken.
    expect(lifecycle.cancel({ commandId: 'cmd-1' })).toEqual({ kind: 'latched' })
    expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBeNull()
    expect(holder.state.releases).toBe(0)
    gate.resolve()
    expect(await start).toEqual({ kind: 'started' })
    // The latched cancellation is delivered when the provider can hear it.
    let providerCancels = 0
    expect(
      lifecycle.providerCancelRegistered('cmd-1', () => {
        providerCancels += 1
      })
    ).toEqual({ kind: 'invoked' })
    expect(providerCancels).toBe(1)
    expect(lifecycle.settle('cmd-1', 'cancelled')).toBe(true)
    expect(holder.state.releases).toBe(1)
  })

  it('fences a start landing after the wait expired mid-dispatch and retains capacity to provider end', async () => {
    const { lifecycle, holder } = await claimedLifecycle()
    const gate = deferred()
    const start = lifecycle.executeStart('cmd-1', () => gate.promise)
    await settleMicrotasks()
    expect(lifecycle.getReservation('cmd-1')?.dispatched).toBe(true)
    expect(lifecycle.expireStartWait('cmd-1')).toBe(true)
    expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBe('start_timeout')
    // The RECEIPT terminalized but a provider child may exist: capacity is
    // not freed at the timeout (L3).
    expect(holder.state.releases).toBe(0)
    gate.resolve()
    expect(await start).toEqual({ kind: 'fenced', outcome: 'start_timeout' })
    expect(lifecycle.stats().fencedLateStarts).toBe(1)
    expect(holder.state.releases).toBe(0)
    // Provider completion/teardown releases the retained lease exactly once.
    expect(lifecycle.providerRunEnded('cmd-1')).toBe(true)
    expect(holder.state.releases).toBe(1)
    expect(lifecycle.providerRunEnded('cmd-1')).toBe(false)
    expect(holder.state.releases).toBe(1)
  })

  it('settle on an already-terminal timed-out run releases the retained lease, not the outcome', async () => {
    const { lifecycle, holder } = await claimedLifecycle()
    expect(await lifecycle.executeStart('cmd-1', () => {})).toEqual({ kind: 'started' })
    expect(lifecycle.expireStartWait('cmd-1')).toBe(true)
    expect(holder.state.releases).toBe(0)
    // The provider run ends and reports through settle: the recorded outcome
    // stays start_timeout, but the retained capacity is finally released.
    expect(lifecycle.settle('cmd-1', 'cancelled')).toBe(false)
    expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBe('start_timeout')
    expect(holder.state.releases).toBe(1)
  })

  it('a start failure after the timeout releases the retained capacity: the attempt is over', async () => {
    const { lifecycle, holder } = await claimedLifecycle()
    const gate = deferred()
    const start = lifecycle.executeStart('cmd-1', () => gate.promise)
    await settleMicrotasks()
    expect(lifecycle.getReservation('cmd-1')?.dispatched).toBe(true)
    expect(lifecycle.expireStartWait('cmd-1')).toBe(true)
    expect(holder.state.releases).toBe(0)
    gate.reject(new Error('spawn tore down'))
    expect((await start).kind).toBe('failed')
    expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBe('start_timeout')
    expect(holder.state.releases).toBe(1)
    // providerRunEnded afterwards is a no-op, never a double release.
    expect(lifecycle.providerRunEnded('cmd-1')).toBe(false)
    expect(holder.state.releases).toBe(1)
  })

  it('treats a same-command claim under a different identity as conflict, never absence', async () => {
    const store = durableStore()
    store.claims.push({
      commandId: 'cmd-1',
      threadId: 'thread-OTHER',
      fingerprint: 'fp-OTHER',
      claimedAt: 1
    })
    const lifecycle = createHostNodeQueuedStartLifecycle({ executionClaimStore: store })
    const outcomes = await lifecycle.reopen([
      { commandId: 'cmd-1', threadId: 'thread-a', fingerprint: 'fp-1' },
      { commandId: 'cmd-2', threadId: 'thread-b', fingerprint: 'fp-2' }
    ])
    expect(outcomes).toEqual([
      // A claim exists for this command id — whoever recorded it, a provider
      // may have started under it (L4).
      { commandId: 'cmd-1', outcome: 'indeterminate', resubmittable: null },
      {
        commandId: 'cmd-2',
        outcome: 'host_shutting_down',
        resubmittable: { newIdRequired: true }
      }
    ])
  })

  it('grants absence-based resubmission only under declared durable coverage', async () => {
    // A volatile store is empty because it is VOLATILE, not because the work
    // never started: absence proves nothing (L4).
    const lifecycle = createHostNodeQueuedStartLifecycle({
      executionClaimStore: createInMemoryExecutionClaimStore()
    })
    const outcomes = await lifecycle.reopen([
      { commandId: 'cmd-1', threadId: 'thread-a', fingerprint: 'fp-1' }
    ])
    expect(outcomes).toEqual([
      { commandId: 'cmd-1', outcome: 'indeterminate', resubmittable: null }
    ])
  })

  it('poisons the whole absence argument on a malformed or non-array claim listing', async () => {
    const candidates = [{ commandId: 'cmd-unmentioned', threadId: 'thread-a', fingerprint: 'fp-1' }]
    const malformedEntry = Object.assign(createInMemoryExecutionClaimStore(), {
      declaresDurableCoverage: true,
      list() {
        // One unreadable entry could be ANY candidate's claim.
        return [{ commandId: 42 }] as unknown as readonly HostQueuedStartExecutionClaim[]
      }
    })
    expect(
      await createHostNodeQueuedStartLifecycle({ executionClaimStore: malformedEntry }).reopen(
        candidates
      )
    ).toEqual([{ commandId: 'cmd-unmentioned', outcome: 'indeterminate', resubmittable: null }])

    const nonArray = Object.assign(createInMemoryExecutionClaimStore(), {
      declaresDurableCoverage: true,
      list() {
        return {} as unknown as readonly HostQueuedStartExecutionClaim[]
      }
    })
    expect(
      await createHostNodeQueuedStartLifecycle({ executionClaimStore: nonArray }).reopen(candidates)
    ).toEqual([{ commandId: 'cmd-unmentioned', outcome: 'indeterminate', resubmittable: null }])
  })

  it('returns admission occupancy to baseline through the real admission + lifecycle pair', async () => {
    const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 2 })
    const lifecycle = createHostNodeQueuedStartLifecycle()

    // Happy path: admitted → claimed → started → settled frees the slot.
    lifecycle.reserve(reserveInput())
    const first = await admission.acquire({ commandId: 'cmd-1', threadId: 'thread-a' })
    if (first.kind !== 'admitted') throw new Error('expected admission')
    expect((await lifecycle.claim('cmd-1', first.lease)).kind).toBe('claimed')
    expect(await lifecycle.executeStart('cmd-1', () => {})).toEqual({ kind: 'started' })
    lifecycle.markStarted('cmd-1')
    expect(lifecycle.settle('cmd-1', 'completed')).toBe(true)
    expect(admission.inflightCount()).toBe(0)

    // Refusal path: the lifecycle refused, so the CALLER still owns the
    // lease and must release it — doing so restores occupancy exactly (L1).
    lifecycle.reserve(
      reserveInput({ commandId: 'cmd-2', threadId: 'thread-b', fingerprint: 'fp-2' })
    )
    lifecycle.cancel({ commandId: 'cmd-2', threadId: 'thread-b' })
    const second = await admission.acquire({ commandId: 'cmd-2', threadId: 'thread-b' })
    if (second.kind !== 'admitted') throw new Error('expected admission')
    expect(await lifecycle.claim('cmd-2', second.lease)).toEqual({
      kind: 'refused',
      reason: 'already_terminal'
    })
    expect(admission.inflightCount()).toBe(1)
    second.lease.release()
    expect(admission.inflightCount()).toBe(0)
    expect(admission.hasThread('thread-b')).toBe(false)
  })
})
