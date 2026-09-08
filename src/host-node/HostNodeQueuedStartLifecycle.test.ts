import { describe, expect, it } from 'vitest'

import {
  createHostNodeQueuedStartLifecycle,
  createInMemoryExecutionClaimStore,
  terminalOutcomeToRejectCode,
  type HostQueuedStartExecutionClaim,
  type HostQueuedStartExecutionClaimStore,
  type HostQueuedStartClaimResult
} from './HostNodeQueuedStartLifecycle'
import { createHostNodeRunAdmission, type HostNodeRunAdmissionLease } from './HostNodeRunAdmission'

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

type Lifecycle = ReturnType<typeof createHostNodeQueuedStartLifecycle>

function releaseCallerLease(result: HostQueuedStartClaimResult, lease: HostNodeRunAdmissionLease) {
  if (result.leaseCustody === 'caller') lease.release()
}

async function admittedLifecycle(
  options: NonNullable<Parameters<typeof createHostNodeQueuedStartLifecycle>[0]> = {}
) {
  const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 0 })
  const lifecycle = createHostNodeQueuedStartLifecycle(options)
  lifecycle.reserve(reserveInput())
  const admitted = await admission.acquire({ commandId: 'cmd-1', threadId: 'thread-a' })
  if (admitted.kind !== 'admitted') throw new Error('expected real admission')
  return { admission, lifecycle, lease: admitted.lease }
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
    expect(claim).toEqual({ kind: 'refused', reason: 'already_terminal', leaseCustody: 'caller' })
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
    expect(holder.state.releases).toBe(0)
    // The owner separately confirms this failed callback created no work.
    expect(lifecycle.providerRunEnded('cmd-1', { kind: 'no_effects' })).toBe(true)
    expect(holder.state.releases).toBe(1)

    lifecycle.reserve(
      reserveInput({ commandId: 'cmd-2', threadId: 'thread-b', fingerprint: 'fp-2' })
    )
    const holder2 = fakeLease('cmd-2', 'thread-b')
    await lifecycle.claim('cmd-2', holder2.lease)
    const asyncFail = await lifecycle.executeStart('cmd-2', () => Promise.reject(new Error('nope')))
    expect(asyncFail.kind).toBe('failed')
    expect(lifecycle.getReservation('cmd-2')?.terminalOutcome).toBe('failed')
    expect(holder2.state.releases).toBe(0)
    expect(lifecycle.providerRunEnded('cmd-2', { kind: 'no_effects' })).toBe(true)
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
    expect(holder.state.releases).toBe(0)
    expect(lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })).toBe(true)
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
    expect(done.state.releases).toBe(0)
    lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })
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
    expect(claim).toEqual({
      kind: 'refused',
      reason: 'claim_record_failed',
      leaseCustody: 'released'
    })
    expect(lifecycle.stats().claimRecordFailures).toBe(1)
    // No claim recorded → no spawn: the start guard refuses too.
    const start = await lifecycle.executeStart('cmd-1', () => {})
    expect(start.kind).toBe('skipped')
    expect(holder.state.releases).toBe(1)
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

describe('M2 physical custody and end authority (R1-R3)', () => {
  it.each(['before_timeout', 'after_timeout', 'unreported'] as const)(
    'retains real capacity through %s liveness and a rejected start',
    async (signal) => {
      const outcomes: string[] = []
      const { admission, lifecycle, lease } = await admittedLifecycle({
        onTerminal: (_view, outcome) => outcomes.push(outcome)
      })
      await lifecycle.claim('cmd-1', lease)
      const gate = deferred()
      let providerLive = false
      const start = lifecycle.executeStart('cmd-1', () => gate.promise)
      await settleMicrotasks()
      if (signal === 'before_timeout') {
        providerLive = true
        lifecycle.providerRunStarted('cmd-1')
      }
      expect(lifecycle.expireStartWait('cmd-1')).toBe(true)
      providerLive = true
      if (signal === 'after_timeout') lifecycle.providerRunStarted('cmd-1')
      const error = new Error('post-spawn setup failure')
      gate.reject(error)
      expect(await start).toEqual({ kind: 'failed', error })
      expect(lifecycle.getReservation('cmd-1')).toMatchObject({
        terminalOutcome: 'start_timeout',
        phase: 'starting',
        startedEvidence: false,
        providerRunBegan: signal !== 'unreported',
        providerWorkEnded: false,
        cancelLatched: true
      })
      let cancels = 0
      lifecycle.providerCancelRegistered('cmd-1', () => {
        cancels += 1
      })
      lifecycle.beginShutdown()
      lifecycle.cancel({ commandId: 'cmd-1', threadId: 'thread-a' })
      expect(cancels).toBe(1)
      expect(lifecycle.settle('cmd-1', 'completed')).toBe(false)
      expect(lifecycle.settle('cmd-1', 'cancelled')).toBe(false)
      expect(providerLive).toBe(true)
      expect(admission.inflightCount()).toBe(1)
      expect((await admission.acquire({ commandId: 'next', threadId: 'next-thread' })).kind).toBe(
        'rejected'
      )
      // Positive external liveness evidence changes before the explicit signal.
      providerLive = false
      expect(admission.inflightCount()).toBe(1)
      expect(lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })).toBe(true)
      expect(providerLive).toBe(false)
      expect(admission.inflightCount()).toBe(0)
      expect(lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })).toBe(false)
      expect(outcomes).toEqual(['start_timeout'])
      const next = await admission.acquire({ commandId: 'next', threadId: 'next-thread' })
      if (next.kind !== 'admitted') throw new Error('expected slot after proven end')
      next.lease.release()
    }
  )

  it.each(['early', 'late'] as const)(
    'cancels terminal-but-live failure with %s registration through shutdown',
    async (registration) => {
      const { admission, lifecycle, lease } = await admittedLifecycle()
      await lifecycle.claim('cmd-1', lease)
      const gate = deferred()
      const start = lifecycle.executeStart('cmd-1', () => gate.promise)
      await settleMicrotasks()
      let providerLive = true
      lifecycle.providerRunStarted('cmd-1')
      let cancels = 0
      const cancel = () => {
        cancels += 1
      }
      if (registration === 'early') lifecycle.providerCancelRegistered('cmd-1', cancel)
      const error = new Error('failed before timeout')
      gate.reject(error)
      expect(await start).toEqual({ kind: 'failed', error })
      expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBe('failed')
      lifecycle.beginShutdown()
      expect(lifecycle.cancel({ commandId: 'cmd-1', threadId: 'wrong' })).toEqual({
        kind: 'rejected',
        reason: 'identity_mismatch'
      })
      expect(lifecycle.cancel({ commandId: 'cmd-1', threadId: 'thread-a' })).toEqual({
        kind: 'already_terminal',
        outcome: 'failed'
      })
      if (registration === 'late') lifecycle.providerCancelRegistered('cmd-1', cancel)
      expect(
        lifecycle.providerCancelRegistered('cmd-1', () => {
          cancels += 100
        })
      ).toEqual({ kind: 'ignored' })
      lifecycle.beginShutdown()
      lifecycle.cancel({ commandId: 'cmd-1' })
      expect(cancels).toBe(1)
      expect(providerLive).toBe(true)
      expect(admission.inflightCount()).toBe(1)
      expect((await admission.acquire({ commandId: 'next', threadId: 'next' })).kind).toBe(
        'rejected'
      )
      expect(lifecycle.providerRunEnded('cmd-1', { kind: 'no_effects' })).toBe(false)
      providerLive = false
      expect(lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })).toBe(true)
      expect(providerLive).toBe(false)
      expect(admission.inflightCount()).toBe(0)
      expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBe('failed')
    }
  )

  it('requires explicit no-effects evidence rather than a rejection or receipt event', async () => {
    const { admission, lifecycle, lease } = await admittedLifecycle()
    await lifecycle.claim('cmd-1', lease)
    const refusal = new Error('spawn tore down')
    expect(
      await lifecycle.executeStart('cmd-1', () => {
        throw refusal
      })
    ).toEqual({ kind: 'failed', error: refusal })
    expect(lifecycle.getReservation('cmd-1')?.providerRunBegan).toBe(false)
    expect(admission.inflightCount()).toBe(1)
    expect(lifecycle.settle('cmd-1', 'failed')).toBe(false)
    expect(lifecycle.settle('cmd-1', 'completed')).toBe(false)
    for (const invalid of [undefined, null, {}, { kind: 'receipt_completed' }]) {
      expect(Reflect.apply(lifecycle.providerRunEnded, lifecycle, ['cmd-1', invalid])).toBe(false)
    }
    expect(admission.inflightCount()).toBe(1)
    // This test's callback was synchronous and is now known to have created no work.
    expect(lifecycle.providerRunEnded('cmd-1', { kind: 'no_effects' })).toBe(true)
    expect(admission.inflightCount()).toBe(0)
    let lateCancels = 0
    lifecycle.providerRunStarted('cmd-1')
    expect(
      lifecycle.providerCancelRegistered('cmd-1', () => {
        lateCancels += 1
      })
    ).toEqual({ kind: 'ignored' })
    lifecycle.cancel({ commandId: 'cmd-1' })
    lifecycle.beginShutdown()
    expect(lateCancels).toBe(0)
    expect(lifecycle.getReservation('cmd-1')).toMatchObject({
      terminalOutcome: 'failed',
      providerRunBegan: false,
      providerWorkEnded: true
    })
  })

  it('can record positive end before receipt settlement without reviving or double releasing', async () => {
    const outcomes: string[] = []
    const { admission, lifecycle, lease } = await admittedLifecycle({
      onTerminal: (_view, outcome) => outcomes.push(outcome)
    })
    await lifecycle.claim('cmd-1', lease)
    await lifecycle.executeStart('cmd-1', () => lifecycle.providerRunStarted('cmd-1'))
    lifecycle.markStarted('cmd-1')
    expect(lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })).toBe(true)
    expect(admission.inflightCount()).toBe(0)
    lifecycle.beginShutdown()
    // Ended provider work may still owe publication; shutdown must not label
    // it provably unstarted or settle its receipt as host_shutting_down.
    expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBeNull()
    expect(lifecycle.settle('cmd-1', 'completed')).toBe(true)
    expect(lifecycle.settle('cmd-1', 'failed')).toBe(false)
    expect(lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })).toBe(false)
    expect(outcomes).toEqual(['completed'])
    expect(lifecycle.getReservation('cmd-1')?.startedEvidence).toBe(true)
  })

  it.each(['pending', 'transferred', 'retained', 'released'] as const)(
    'never gives the same real lease alias caller custody in the %s state',
    async (state) => {
      const gate = deferred()
      let records = 0
      const { admission, lifecycle, lease } = await admittedLifecycle({
        executionClaimStore: {
          record() {
            records += 1
            return gate.promise
          },
          list: () => []
        }
      })
      const first = lifecycle.claim('cmd-1', lease)
      if (state !== 'pending') {
        gate.resolve()
        expect((await first).leaseCustody).toBe('lifecycle')
        await lifecycle.executeStart('cmd-1', () => lifecycle.providerRunStarted('cmd-1'))
        if (state !== 'transferred') lifecycle.expireStartWait('cmd-1')
        if (state === 'released') lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })
      }
      const alias = await lifecycle.claim('cmd-1', lease)
      // Exercise caller cleanup BEFORE checking the result shape: an unsafe
      // custody result must fail on REAL occupancy, not just a string assertion.
      releaseCallerLease(alias, lease)
      expect(admission.inflightCount()).toBe(state === 'released' ? 0 : 1)
      expect(alias).toMatchObject({
        kind: 'refused',
        leaseCustody: state === 'released' ? 'released' : 'lifecycle'
      })
      lifecycle.reserve(reserveInput({ commandId: 'other', threadId: 'other-thread' }))
      for (const wrongId of ['other', 'unknown']) {
        const wrongTarget = await lifecycle.claim(wrongId, lease)
        expect(wrongTarget).toMatchObject({
          kind: 'refused',
          reason: 'lease_identity_mismatch',
          leaseCustody: state === 'released' ? 'released' : 'lifecycle'
        })
        releaseCallerLease(wrongTarget, lease)
      }
      expect(records).toBe(1)
      const competing = await admission.acquire({ commandId: 'competing', threadId: 'competing' })
      if (state === 'released') {
        if (competing.kind !== 'admitted') throw new Error('expected released slot')
        releaseCallerLease(await lifecycle.claim('cmd-1', lease), lease)
        expect(admission.inflightCount()).toBe(1)
        competing.lease.release()
      } else {
        expect(competing.kind).toBe('rejected')
        expect(admission.inflightCount()).toBe(1)
        if (state === 'pending') {
          gate.resolve()
          expect((await first).kind).toBe('claimed')
          lifecycle.cancel({ commandId: 'cmd-1' })
        } else {
          lifecycle.settle('cmd-1', 'completed')
          lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })
        }
      }
      expect(admission.inflightCount()).toBe(0)
    }
  )

  it('releases an undispatched real claim even when cancellation was registered early', async () => {
    const { admission, lifecycle, lease } = await admittedLifecycle()
    await lifecycle.claim('cmd-1', lease)
    let cancels = 0
    lifecycle.providerCancelRegistered('cmd-1', () => {
      cancels += 1
    })
    lifecycle.cancel({ commandId: 'cmd-1', threadId: 'thread-a' })
    expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBe('cancelled_before_start')
    expect(admission.inflightCount()).toBe(0)
    expect(cancels).toBe(1)
    let spawns = 0
    expect(
      (
        await lifecycle.executeStart('cmd-1', () => {
          spawns += 1
        })
      ).kind
    ).toBe('skipped')
    expect(spawns).toBe(0)
    const next = await admission.acquire({ commandId: 'next', threadId: 'next' })
    if (next.kind !== 'admitted') throw new Error('early cancellation stranded capacity')
    next.lease.release()
  })

  it('leaves an independent rejected real lease with its caller', async () => {
    const { admission, lifecycle, lease } = await admittedLifecycle()
    await lifecycle.claim('cmd-1', lease)
    const otherAdmission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 0 })
    const other = await otherAdmission.acquire({ commandId: 'cmd-1', threadId: 'thread-a' })
    if (other.kind !== 'admitted') throw new Error('expected independent admission')
    const loser = await lifecycle.claim('cmd-1', other.lease)
    expect(loser).toEqual({ kind: 'refused', reason: 'already_claimed', leaseCustody: 'caller' })
    releaseCallerLease(loser, other.lease)
    expect(otherAdmission.inflightCount()).toBe(0)
    expect(admission.inflightCount()).toBe(1)
    lifecycle.cancel({ commandId: 'cmd-1' })
    expect(admission.inflightCount()).toBe(0)
  })

  it.each(['reject', 'cancel', 'shutdown'] as const)(
    'releases temporary custody on %s without letting stale aliases touch the next owner',
    async (action) => {
      const gate = deferred()
      const { admission, lifecycle, lease } = await admittedLifecycle({
        executionClaimStore: { record: () => gate.promise, list: () => [] }
      })
      const first = lifecycle.claim('cmd-1', lease)
      const alias = await lifecycle.claim('cmd-1', lease)
      expect(alias.leaseCustody).toBe('lifecycle')
      releaseCallerLease(alias, lease)
      if (action === 'cancel') lifecycle.cancel({ commandId: 'cmd-1' })
      if (action === 'shutdown') lifecycle.beginShutdown()
      if (action === 'reject') gate.reject(new Error('claim write failed'))
      else gate.resolve()
      const refused = await first
      expect(refused).toMatchObject({ kind: 'refused', leaseCustody: 'released' })
      releaseCallerLease(refused, lease)
      expect(admission.inflightCount()).toBe(0)
      const next = await admission.acquire({ commandId: 'next', threadId: 'next' })
      if (next.kind !== 'admitted') throw new Error('expected next admission')
      const lateAlias = await lifecycle.claim('cmd-1', lease)
      expect(lateAlias.leaseCustody).toBe('released')
      releaseCallerLease(lateAlias, lease)
      let spawns = 0
      expect(
        (
          await lifecycle.executeStart('cmd-1', () => {
            spawns += 1
          })
        ).kind
      ).toBe('skipped')
      expect(spawns).toBe(0)
      expect(admission.inflightCount()).toBe(1)
      next.lease.release()
    }
  )

  it.each(['resolve', 'reject'] as const)(
    'installs custody and readiness before reentrant store.record (%s)',
    async (outcome) => {
      const gate = deferred()
      const aliases: Promise<HostQueuedStartClaimResult>[] = []
      let reentrantStart: ReturnType<Lifecycle['executeStart']> | undefined
      let spawns = 0
      let records = 0
      const fixture = await admittedLifecycle({
        executionClaimStore: {
          record() {
            records += 1
            aliases.push(fixture.lifecycle.claim('cmd-1', fixture.lease))
            reentrantStart = fixture.lifecycle.executeStart('cmd-1', () => {
              spawns += 1
            })
            return gate.promise
          },
          list: () => []
        }
      })
      const first = fixture.lifecycle.claim('cmd-1', fixture.lease)
      const alias = await aliases[0]
      expect(alias).toEqual({
        kind: 'refused',
        reason: 'already_claimed',
        leaseCustody: 'lifecycle'
      })
      releaseCallerLease(alias, fixture.lease)
      expect(spawns).toBe(0)
      expect(fixture.admission.inflightCount()).toBe(1)
      if (outcome === 'reject') gate.reject(new Error('record failure after reentry'))
      else gate.resolve()
      const result = await first
      releaseCallerLease(result, fixture.lease)
      expect(records).toBe(1)
      expect(reentrantStart).toBeDefined()
      expect((await reentrantStart)?.kind).toBe(outcome === 'resolve' ? 'started' : 'skipped')
      expect(spawns).toBe(outcome === 'resolve' ? 1 : 0)
      if (outcome === 'resolve') {
        fixture.lifecycle.settle('cmd-1', 'completed')
        fixture.lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })
      }
      expect(fixture.admission.inflightCount()).toBe(0)
    }
  )

  it.each(['cancel', 'shutdown', 'throw'] as const)(
    'fences synchronous store reentry through %s and cleans custody once',
    async (action) => {
      const aliases: Promise<HostQueuedStartClaimResult>[] = []
      let nested: ReturnType<Lifecycle['executeStart']> | undefined
      let spawns = 0
      const fixture = await admittedLifecycle({
        executionClaimStore: {
          record() {
            aliases.push(fixture.lifecycle.claim('cmd-1', fixture.lease))
            nested = fixture.lifecycle.executeStart('cmd-1', () => {
              spawns += 1
            })
            if (action === 'cancel') fixture.lifecycle.cancel({ commandId: 'cmd-1' })
            if (action === 'shutdown') fixture.lifecycle.beginShutdown()
            if (action === 'throw') throw new Error('synchronous store failure')
          },
          list: () => []
        }
      })
      const result = await fixture.lifecycle.claim('cmd-1', fixture.lease)
      releaseCallerLease(await aliases[0], fixture.lease)
      releaseCallerLease(result, fixture.lease)
      expect(result).toMatchObject({ kind: 'refused', leaseCustody: 'released' })
      expect((await nested)?.kind).toBe('skipped')
      expect(spawns).toBe(0)
      expect(fixture.admission.inflightCount()).toBe(0)
    }
  )

  it('follows the real admission onClaim hook readiness and cancellation contract', async () => {
    const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 0 })
    const gate = deferred()
    const lifecycle = createHostNodeQueuedStartLifecycle({
      executionClaimStore: { record: () => gate.promise, list: () => [] }
    })
    lifecycle.reserve(reserveInput())
    let claimAttempt: Promise<HostQueuedStartClaimResult> | undefined
    const admitted = await admission.acquire({
      commandId: 'cmd-1',
      threadId: 'thread-a',
      onClaim: (lease) => {
        claimAttempt = lifecycle.claim('cmd-1', lease)
      }
    })
    if (admitted.kind !== 'admitted' || !claimAttempt) throw new Error('expected claim hook')
    let spawns = 0
    const start = lifecycle.executeStart('cmd-1', () => {
      spawns += 1
    })
    lifecycle.cancel({ commandId: 'cmd-1', threadId: 'thread-a' })
    expect(admission.inflightCount()).toBe(0)
    gate.resolve()
    const result = await claimAttempt
    expect(result.leaseCustody).toBe('released')
    releaseCallerLease(result, admitted.lease)
    expect((await start).kind).toBe('skipped')
    expect(spawns).toBe(0)
  })

  it.each(['cancel', 'shutdown'] as const)(
    'keeps receipt-only outcomes distinct from end evidence during %s',
    async (action) => {
      const { admission, lifecycle, lease } = await admittedLifecycle()
      await lifecycle.claim('cmd-1', lease)
      await lifecycle.executeStart('cmd-1', () => lifecycle.providerRunStarted('cmd-1'))
      let cancels = 0
      lifecycle.providerCancelRegistered('cmd-1', () => {
        cancels += 1
      })
      expect(lifecycle.settle('cmd-1', 'completed')).toBe(true)
      // A mismatched duplicate receipt must neither free nor cancel successful work.
      expect(lifecycle.settle('cmd-1', 'failed')).toBe(false)
      expect(cancels).toBe(0)
      expect(admission.inflightCount()).toBe(1)
      if (action === 'cancel') lifecycle.cancel({ commandId: 'cmd-1' })
      else lifecycle.beginShutdown()
      expect(cancels).toBe(1)
      lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })
      expect(admission.inflightCount()).toBe(0)

      const failed = await admittedLifecycle()
      await failed.lifecycle.claim('cmd-1', failed.lease)
      await failed.lifecycle.executeStart('cmd-1', () => {})
      let failureCancels = 0
      failed.lifecycle.providerCancelRegistered('cmd-1', () => {
        failureCancels += 1
      })
      failed.lifecycle.settle('cmd-1', 'failed')
      expect(failureCancels).toBe(1)
      expect(failed.admission.inflightCount()).toBe(1)
      failed.lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })
      expect(failed.admission.inflightCount()).toBe(0)
    }
  )

  it('treats unreadable coverage metadata as unknown without consulting the listing', async () => {
    let lists = 0
    const lifecycle = createHostNodeQueuedStartLifecycle({
      executionClaimStore: {
        get declaresDurableCoverage(): boolean {
          throw new Error('coverage unreadable')
        },
        record() {
          // Recovery-only fixture: this test reads evidence without writing a claim.
        },
        list() {
          lists += 1
          return []
        }
      }
    })
    expect(await lifecycle.reopen([reserveInput()])).toEqual([
      { commandId: 'cmd-1', outcome: 'indeterminate', resubmittable: null }
    ])
    expect(lists).toBe(0)
  })

  const validClaim = { commandId: 'other', threadId: 'thread-z', fingerprint: 'fp-z', claimedAt: 0 }
  const malformed: [string, unknown][] = [
    ['blank command', { ...validClaim, commandId: '  \t\n' }],
    ['blank thread', { ...validClaim, threadId: '\t ' }],
    ['blank fingerprint', { ...validClaim, fingerprint: '\n  ' }],
    ['missing command', { threadId: 'thread-z', fingerprint: 'fp-z', claimedAt: 0 }],
    ['missing thread', { commandId: 'other', fingerprint: 'fp-z', claimedAt: 0 }],
    ['missing fingerprint', { commandId: 'other', threadId: 'thread-z', claimedAt: 0 }],
    ['missing time', { commandId: 'other', threadId: 'thread-z', fingerprint: 'fp-z' }],
    ['negative time', { ...validClaim, claimedAt: -1 }],
    ['NaN time', { ...validClaim, claimedAt: NaN }],
    ['infinite time', { ...validClaim, claimedAt: Infinity }],
    ['string time', { ...validClaim, claimedAt: '0' }],
    ['null', null],
    ['array with fields', Object.assign([], validClaim)],
    ['inherited fields', Object.create(validClaim)],
    [
      'throwing field',
      {
        ...validClaim,
        get claimedAt() {
          throw new Error('unreadable')
        }
      }
    ]
  ]
  it.each(malformed)(
    'poisons absence for an unmentioned candidate with %s',
    async (_label, bad) => {
      const lifecycle = createHostNodeQueuedStartLifecycle({
        executionClaimStore: {
          declaresDurableCoverage: true,
          record() {
            // Recovery-only fixture: this test reads evidence without writing a claim.
          },
          list: () => [validClaim, bad] as readonly HostQueuedStartExecutionClaim[]
        }
      })
      expect(await lifecycle.reopen([reserveInput()])).toEqual([
        { commandId: 'cmd-1', outcome: 'indeterminate', resubmittable: null }
      ])
    }
  )

  it('accepts covered zero/fractional timestamps and preserves exact opaque identities', async () => {
    const store = durableStore()
    store.claims.push(validClaim, { ...validClaim, commandId: ' cmd-1 ', claimedAt: 0.5 })
    const lifecycle = createHostNodeQueuedStartLifecycle({ executionClaimStore: store })
    expect(
      await lifecycle.reopen([reserveInput(), reserveInput({ commandId: ' cmd-1 ' })])
    ).toEqual([
      { commandId: 'cmd-1', outcome: 'host_shutting_down', resubmittable: { newIdRequired: true } },
      { commandId: ' cmd-1 ', outcome: 'indeterminate', resubmittable: null }
    ])
  })

  it.each([NaN, Infinity, -1])(
    'refuses to write an invalid claim clock %s and returns released custody',
    async (now) => {
      let writes = 0
      const { admission, lifecycle, lease } = await admittedLifecycle({
        now: () => now,
        executionClaimStore: {
          record() {
            writes += 1
          },
          list: () => []
        }
      })
      const result = await lifecycle.claim('cmd-1', lease)
      expect(result).toEqual({
        kind: 'refused',
        reason: 'claim_record_failed',
        leaseCustody: 'released'
      })
      releaseCallerLease(result, lease)
      expect(writes).toBe(0)
      expect(admission.inflightCount()).toBe(0)
    }
  )
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
    expect(second).toEqual({ kind: 'refused', reason: 'already_claimed', leaseCustody: 'caller' })
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
      reason: 'lease_identity_mismatch',
      leaseCustody: 'caller'
    })
    const wrongThread = fakeLease('cmd-1', 'thread-OTHER')
    expect(await lifecycle.claim('cmd-1', wrongThread.lease)).toEqual({
      kind: 'refused',
      reason: 'lease_identity_mismatch',
      leaseCustody: 'caller'
    })
    // No durable claim was recorded on a foreign lease's authority, both
    // leases stay with their callers, and the reservation stays claimable.
    expect(records).toBe(0)
    expect(wrongCommand.state.releases).toBe(0)
    expect(wrongThread.state.releases).toBe(0)
    expect((await lifecycle.claim('cmd-1', fakeLease('cmd-1').lease)).kind).toBe('claimed')
    expect(records).toBe(1)
  })

  it('honours a cancel during the durable write and releases temporary custody', async () => {
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
    expect(await claim).toEqual({
      kind: 'refused',
      reason: 'already_terminal',
      leaseCustody: 'released'
    })
    // Temporary custody transferred before durability; cancellation released it.
    // The caller has no cleanup obligation or permission to release an alias.
    expect(holder.state.releases).toBe(1)
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
    expect(holder.state.releases).toBe(0)
    expect(lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })).toBe(true)
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
    expect(lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })).toBe(true)
    expect(holder.state.releases).toBe(1)
    expect(lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })).toBe(false)
    expect(holder.state.releases).toBe(1)
  })

  it('duplicate settlement cannot release timed-out work without positive end evidence', async () => {
    const { lifecycle, holder } = await claimedLifecycle()
    expect(await lifecycle.executeStart('cmd-1', () => {})).toEqual({ kind: 'started' })
    expect(lifecycle.expireStartWait('cmd-1')).toBe(true)
    expect(holder.state.releases).toBe(0)
    // Repeated receipt events are NOT provider-end evidence.
    expect(lifecycle.settle('cmd-1', 'cancelled')).toBe(false)
    expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBe('start_timeout')
    expect(holder.state.releases).toBe(0)
    expect(lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })).toBe(true)
    expect(holder.state.releases).toBe(1)
  })

  it('a start failure after timeout retains capacity until separate no-effects proof', async () => {
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
    expect(holder.state.releases).toBe(0)
    // Error text never establishes teardown. The owner supplies separate proof.
    expect(lifecycle.providerRunEnded('cmd-1', { kind: 'no_effects' })).toBe(true)
    expect(holder.state.releases).toBe(1)
    // providerRunEnded afterwards is a no-op, never a double release.
    expect(lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })).toBe(false)
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

    // Happy path: admitted → claimed → started → receipt + proven end frees the slot.
    lifecycle.reserve(reserveInput())
    const first = await admission.acquire({ commandId: 'cmd-1', threadId: 'thread-a' })
    if (first.kind !== 'admitted') throw new Error('expected admission')
    expect((await lifecycle.claim('cmd-1', first.lease)).kind).toBe('claimed')
    expect(await lifecycle.executeStart('cmd-1', () => {})).toEqual({ kind: 'started' })
    lifecycle.markStarted('cmd-1')
    expect(lifecycle.settle('cmd-1', 'completed')).toBe(true)
    expect(admission.inflightCount()).toBe(1)
    lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })
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
      reason: 'already_terminal',
      leaseCustody: 'caller'
    })
    expect(admission.inflightCount()).toBe(1)
    second.lease.release()
    expect(admission.inflightCount()).toBe(0)
    expect(admission.hasThread('thread-b')).toBe(false)
  })

  describe('R1–R3 regression probes', () => {
    // R1: start callback rejection must NOT release retained lease if
    // providerRunBegan is true (the provider may still be running).
    it('R1: start callback rejection retains lease when providerRunBegan, releasing only on providerRunEnded', async () => {
      const { lifecycle, holder } = await claimedLifecycle()
      const gate = deferred()
      const start = lifecycle.executeStart('cmd-1', () => {
        // Simulate providerRunBegan being signalled before the callback rejects
        lifecycle.providerRunStarted('cmd-1')
        return gate.promise
      })
      await settleMicrotasks()
      expect(lifecycle.getReservation('cmd-1')?.providerRunBegan).toBe(true)
      expect(lifecycle.getReservation('cmd-1')?.dispatched).toBe(true)

      // Reject the start callback
      gate.reject(new Error('post-spawn setup failure'))
      expect(await start).toEqual({ kind: 'failed', error: expect.any(Error) })
      // Lease MUST be retained (R1 fix): provider may still be live
      expect(holder.state.releases).toBe(0)
      expect(lifecycle.getReservation('cmd-1')?.terminalOutcome).toBe('failed')

      // providerRunEnded releases the retained lease
      expect(lifecycle.providerRunEnded('cmd-1', { kind: 'provider_ended' })).toBe(true)
      expect(holder.state.releases).toBe(1)
    })

    // R2: same lease object offered twice must not allow the loser to release
    // the winner's lease (they share the same object).
    it('R2: same lease object offered to concurrent claims - loser refusal does not release winner', async () => {
      const lifecycle = createHostNodeQueuedStartLifecycle()
      lifecycle.reserve(reserveInput())
      // Same lease object offered to both calls
      const holder = fakeLease('cmd-1')
      const sharedLease = holder.lease
      const first = lifecycle.claim('cmd-1', sharedLease)
      const second = await lifecycle.claim('cmd-1', sharedLease)
      // Second must be refused
      expect(second).toEqual({
        kind: 'refused',
        reason: 'already_claimed',
        leaseCustody: 'lifecycle'
      })
      // Caller cleanup follows the explicit custody result, not refusal alone.
      releaseCallerLease(second, sharedLease)
      // The physical lease registry preserves the winner's ownership.
      expect((await first).kind).toBe('claimed')
      // Only one release should happen when we cancel
      lifecycle.cancel({ commandId: 'cmd-1' })
      // The shared lease's release was called exactly once
      expect(holder.state.releases).toBe(1)
    })

    // R3: reopen must reject malformed/incomplete claim records
    it('R3: reopen rejects malformed claim records - empty commandId', async () => {
      const store: HostQueuedStartExecutionClaimStore = {
        declaresDurableCoverage: true,
        record() {
          // Recovery-only fixture: this test reads evidence without writing a claim.
        },
        list() {
          return [
            {
              commandId: '',
              threadId: 't',
              fingerprint: 'f',
              claimedAt: 1
            } as unknown as HostQueuedStartExecutionClaim
          ]
        }
      }
      const lifecycle = createHostNodeQueuedStartLifecycle({ executionClaimStore: store })
      const outcomes = await lifecycle.reopen([
        { commandId: 'cmd-1', threadId: 'thread-a', fingerprint: 'fp-1' }
      ])
      // Malformed record poisons the absence argument → everything indeterminate
      expect(outcomes).toEqual([
        { commandId: 'cmd-1', outcome: 'indeterminate', resubmittable: null }
      ])
    })

    it('R3: reopen rejects incomplete claim records - missing threadId', async () => {
      const store: HostQueuedStartExecutionClaimStore = {
        declaresDurableCoverage: true,
        record() {
          // Recovery-only fixture: this test reads evidence without writing a claim.
        },
        list() {
          return [
            {
              commandId: 'cmd-1',
              fingerprint: 'f',
              claimedAt: 1
            } as unknown as HostQueuedStartExecutionClaim
          ]
        }
      }
      const lifecycle = createHostNodeQueuedStartLifecycle({ executionClaimStore: store })
      const outcomes = await lifecycle.reopen([
        { commandId: 'cmd-1', threadId: 'thread-a', fingerprint: 'fp-1' }
      ])
      expect(outcomes).toEqual([
        { commandId: 'cmd-1', outcome: 'indeterminate', resubmittable: null }
      ])
    })

    it('R3: reopen rejects claim records with non-finite claimedAt', async () => {
      const store: HostQueuedStartExecutionClaimStore = {
        declaresDurableCoverage: true,
        record() {
          // Recovery-only fixture: this test reads evidence without writing a claim.
        },
        list() {
          return [
            {
              commandId: 'cmd-1',
              threadId: 't',
              fingerprint: 'f',
              claimedAt: NaN
            } as unknown as HostQueuedStartExecutionClaim
          ]
        }
      }
      const lifecycle = createHostNodeQueuedStartLifecycle({ executionClaimStore: store })
      const outcomes = await lifecycle.reopen([
        { commandId: 'cmd-1', threadId: 'thread-a', fingerprint: 'fp-1' }
      ])
      expect(outcomes).toEqual([
        { commandId: 'cmd-1', outcome: 'indeterminate', resubmittable: null }
      ])
    })
  })
})
