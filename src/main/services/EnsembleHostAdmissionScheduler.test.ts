import { describe, expect, it } from 'vitest'
import type { ProviderId } from '../store/types'
import {
  DEFAULT_ENSEMBLE_HOST_MAX_ACTIVE_FOREGROUND_RUNS,
  DEFAULT_ENSEMBLE_HOST_MAX_ACTIVE_RUNS,
  DEFAULT_ENSEMBLE_HOST_MAX_QUEUED_RUNS,
  EnsembleHostAdmissionScheduler,
  type EnsembleHostAdmissionLease,
  type EnsembleHostAdmissionRequest,
  type EnsembleHostAdmissionReservation,
  type EnsembleHostAdmissionReservationResult
} from './EnsembleHostAdmissionScheduler'

function request(
  runId: string,
  options: {
    chatId?: string
    provider?: ProviderId
    kind?: EnsembleHostAdmissionRequest['kind']
  } = {}
): EnsembleHostAdmissionRequest {
  return {
    runId,
    chatId: options.chatId ?? 'chat-a',
    roundId: `round-${options.chatId ?? 'chat-a'}`,
    participantId: `participant-${runId}`,
    provider: options.provider ?? 'codex',
    kind: options.kind ?? 'lane'
  }
}

function reservation(
  result: EnsembleHostAdmissionReservationResult
): EnsembleHostAdmissionReservation {
  if (result.kind !== 'reserved') {
    throw new Error(`Expected reservation, received ${result.code}`)
  }
  return result
}

async function admittedLease(
  result: EnsembleHostAdmissionReservationResult
): Promise<EnsembleHostAdmissionLease> {
  const outcome = await reservation(result).admission
  if (outcome.kind !== 'admitted') {
    throw new Error(`Expected admission, received cancellation: ${outcome.reason}`)
  }
  if (!outcome.lease.claim()) throw new Error('Admission was cancelled before it could be claimed.')
  return outcome.lease
}

function createTaskQueue(): {
  readonly schedule: (task: () => void) => void
  readonly size: () => number
  readonly runOne: () => void
} {
  const tasks: Array<() => void> = []
  return {
    schedule: (task) => tasks.push(task),
    size: () => tasks.length,
    runOne: () => {
      const task = tasks.shift()
      if (!task) throw new Error('No scheduled admission drain is available.')
      task()
    }
  }
}

describe('EnsembleHostAdmissionScheduler capacity', () => {
  it('rejects a zero foreground cap instead of accepting work that can never run', () => {
    expect(
      () =>
        new EnsembleHostAdmissionScheduler({
          maxActive: 8,
          maxForeground: 0
        })
    ).toThrow(/foreground-run capacity must be a positive safe integer/i)
  })

  it('refuses descendant ownership when custom limits reserve no leaf capacity', async () => {
    for (const options of [
      { maxActive: 1, maxForeground: 1 },
      { maxActive: 2, maxForeground: 2 }
    ]) {
      const scheduler = new EnsembleHostAdmissionScheduler(options)
      const root = await admittedLease(
        scheduler.reserve(request(`root-${options.maxActive}`, { kind: 'foreground' }))
      )
      expect(scheduler.promoteToForeground(root.identity.runId)).toMatchObject({
        ok: false,
        code: 'foreground_capacity',
        retryable: true
      })
      root.release()
      await scheduler.whenIdle()
    }
  })

  it('defaults to 30 active runs, 24 foreground owners, six leaf slots and 256 waiters', async () => {
    const tasks = createTaskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({ schedule: tasks.schedule })
    const active: EnsembleHostAdmissionLease[] = []

    for (let index = 0; index < 24; index += 1) {
      const result = scheduler.reserve(
        request(`foreground-${index}`, {
          chatId: `foreground-chat-${index}`,
          kind: 'foreground'
        })
      )
      expect(result).toMatchObject({ kind: 'reserved', initialState: 'admitted' })
      active.push(await admittedLease(result))
    }

    const blockedForeground = scheduler.reserve(
      request('foreground-blocked', { chatId: 'foreground-blocked', kind: 'foreground' })
    )
    expect(blockedForeground).toMatchObject({ kind: 'reserved', initialState: 'queued' })

    for (let index = 0; index < 6; index += 1) {
      const result = scheduler.reserve(
        request(`lane-${index}`, { chatId: `lane-chat-${index}`, provider: 'claude' })
      )
      expect(result).toMatchObject({ kind: 'reserved', initialState: 'admitted' })
      active.push(await admittedLease(result))
    }
    const blockedLane = scheduler.reserve(
      request('lane-blocked', { chatId: 'lane-blocked', provider: 'claude' })
    )

    expect(blockedLane).toMatchObject({ kind: 'reserved', initialState: 'queued' })
    expect(scheduler.snapshot().occupancy).toEqual({
      maxActive: DEFAULT_ENSEMBLE_HOST_MAX_ACTIVE_RUNS,
      maxForeground: DEFAULT_ENSEMBLE_HOST_MAX_ACTIVE_FOREGROUND_RUNS,
      reservedLaneSlots: 6,
      maxQueued: DEFAULT_ENSEMBLE_HOST_MAX_QUEUED_RUNS,
      active: 30,
      activeForeground: 24,
      activeLanes: 6,
      queued: 2,
      queuedForeground: 1,
      queuedLanes: 1,
      shuttingDown: false
    })

    expect(scheduler.cancelQueued('foreground-blocked')).toBe(true)
    expect(scheduler.cancelQueued('lane-blocked')).toBe(true)
    for (const lease of active) expect(lease.release()).toBe(true)
    await scheduler.whenIdle()
  })

  it('keeps the bounded queue intact and rejects only the explicit overflow request', async () => {
    const tasks = createTaskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      maxQueued: 2,
      schedule: tasks.schedule
    })
    const holder = await admittedLease(scheduler.reserve(request('holder')))
    const first = reservation(scheduler.reserve(request('first', { chatId: 'chat-first' })))
    const second = reservation(scheduler.reserve(request('second', { chatId: 'chat-second' })))
    const overflow = scheduler.reserve(request('overflow', { chatId: 'chat-overflow' }))

    expect(first.initialState).toBe('queued')
    expect(second.initialState).toBe('queued')
    expect(overflow).toMatchObject({
      kind: 'rejected',
      code: 'queue_full',
      occupancy: { active: 1, queued: 2 }
    })
    expect(overflow.kind === 'rejected' ? overflow.message : '').toMatch(
      /providers and seats remain available/i
    )
    expect(scheduler.stateForRun('first')).toBe('queued')
    expect(scheduler.stateForRun('second')).toBe('queued')
    expect(scheduler.stateForRun('overflow')).toBeUndefined()

    holder.release()
    tasks.runOne()
    const firstLease = await admittedLease(first)
    expect(scheduler.stateForRun('first')).toBe('active')
    firstLease.release()
    tasks.runOne()
    const secondLease = await admittedLease(second)
    expect(scheduler.stateForRun('second')).toBe('active')
    secondLease.release()
    await scheduler.whenIdle()

    expect(scheduler.snapshot().metrics).toMatchObject({
      requests: 4,
      reservations: 3,
      admitted: 3,
      released: 3,
      overflowRejected: 1,
      peakActive: 1,
      peakQueued: 2
    })
  })

  it('lets an eligible lane use reserved capacity even when an older foreground run is waiting', async () => {
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 2,
      maxForeground: 1,
      maxQueued: 8,
      schedule: () => {}
    })
    const foreground = await admittedLease(
      scheduler.reserve(request('foreground-active', { kind: 'foreground' }))
    )
    const waitingForeground = scheduler.reserve(
      request('foreground-waiting', { kind: 'foreground' })
    )
    const lane = scheduler.reserve(request('lane-can-run'))

    expect(waitingForeground).toMatchObject({ kind: 'reserved', initialState: 'queued' })
    expect(lane).toMatchObject({ kind: 'reserved', initialState: 'admitted' })
    const laneLease = await admittedLease(lane)
    expect(scheduler.snapshot().occupancy).toMatchObject({
      active: 2,
      activeForeground: 1,
      activeLanes: 1,
      queuedForeground: 1
    })

    scheduler.cancelQueued('foreground-waiting')
    foreground.release()
    laneLease.release()
    await scheduler.whenIdle()
  })

  it('promotes only six claimed lane owners and preserves two slots for leaf descendants', async () => {
    const tasks = createTaskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 8,
      maxForeground: 6,
      maxQueued: 16,
      schedule: tasks.schedule
    })
    const owners: EnsembleHostAdmissionLease[] = []
    for (let index = 0; index < 8; index += 1) {
      owners.push(await admittedLease(scheduler.reserve(request(`owner-${index}`))))
    }

    for (let index = 0; index < 6; index += 1) {
      expect(scheduler.promoteToForeground(`owner-${index}`)).toMatchObject({
        ok: true,
        promoted: true
      })
    }
    for (let index = 6; index < 8; index += 1) {
      expect(scheduler.promoteToForeground(`owner-${index}`)).toMatchObject({
        ok: false,
        code: 'foreground_capacity',
        retryable: true
      })
    }
    expect(scheduler.snapshot().occupancy).toMatchObject({
      active: 8,
      activeForeground: 6,
      activeLanes: 2
    })

    const approvalLeaf = scheduler.reserve(request('approval-leaf'))
    expect(approvalLeaf).toMatchObject({ kind: 'reserved', initialState: 'queued' })
    owners[6].release()
    tasks.runOne()
    const approvalLease = await admittedLease(approvalLeaf)
    expect(scheduler.snapshot().occupancy).toMatchObject({
      active: 8,
      activeForeground: 6,
      activeLanes: 2,
      queued: 0
    })

    approvalLease.release()
    for (const lease of owners) lease.release()
    await scheduler.whenIdle()
    expect(scheduler.snapshot().metrics).toMatchObject({
      promotedToForeground: 6,
      promotionRejected: 2
    })
  })

  it('allows one chat to own descendants up to the global owner bound', async () => {
    const tasks = createTaskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({ schedule: tasks.schedule })
    const root = await admittedLease(scheduler.reserve(request('root', { kind: 'foreground' })))
    const owners: EnsembleHostAdmissionLease[] = []
    for (let index = 0; index < 23; index += 1) {
      const owner = await admittedLease(scheduler.reserve(request(`owner-${index}`)))
      owners.push(owner)
      expect(scheduler.promoteToForeground(owner.identity.runId)).toMatchObject({
        ok: true,
        promoted: true
      })
    }
    const child = scheduler.reserve(request('nested-child'))
    expect(child).toMatchObject({ kind: 'reserved', initialState: 'admitted' })
    const childLease = await admittedLease(child)
    expect(scheduler.promoteToForeground(childLease.identity.runId)).toMatchObject({
      ok: false,
      code: 'foreground_capacity',
      retryable: true
    })
    expect(scheduler.snapshot().occupancy).toMatchObject({
      active: 25,
      activeForeground: 24,
      activeLanes: 1,
      queued: 0
    })

    childLease.release()
    for (const owner of owners) owner.release()
    root.release()
    await scheduler.whenIdle()
  })
})

describe('EnsembleHostAdmissionScheduler fairness', () => {
  it('admits every free host slot immediately and queues only the excess', async () => {
    const tasks = createTaskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({ schedule: tasks.schedule })
    const reservations: EnsembleHostAdmissionReservation[] = []

    for (const chatId of ['chat-a', 'chat-b', 'chat-c']) {
      for (let index = 0; index < 20; index += 1) {
        reservations.push(reservation(scheduler.reserve(request(`${chatId}-${index}`, { chatId }))))
      }
    }

    expect(reservations.slice(0, 30).every((entry) => entry.initialState === 'admitted')).toBe(true)
    expect(reservations.slice(30).every((entry) => entry.initialState === 'queued')).toBe(true)
    expect(tasks.size()).toBe(0)
    const snapshot = scheduler.snapshot()
    expect(snapshot.occupancy).toMatchObject({ active: 30, queued: 30 })
    expect(snapshot.byChat).toEqual([
      { chatId: 'chat-a', active: 20, queued: 0 },
      { chatId: 'chat-b', active: 10, queued: 10 },
      { chatId: 'chat-c', active: 0, queued: 20 }
    ])

    const activeLeases: EnsembleHostAdmissionLease[] = []
    for (const held of reservations) {
      if (scheduler.stateForRun(held.identity.runId) === 'queued') {
        expect(held.cancel('Fairness test cleanup.')).toBe(true)
        continue
      }
      const outcome = await held.admission
      if (outcome.kind !== 'admitted') throw new Error('Expected initial admission.')
      expect(outcome.lease.claim()).toBe(true)
      activeLeases.push(outcome.lease)
    }
    for (const lease of activeLeases) expect(lease.release()).toBe(true)
    await scheduler.whenIdle()
  })

  it.each([4, 6, 12, 30])(
    'admits all %i lanes in one chat without an initial-share limit',
    async (count) => {
      const tasks = createTaskQueue()
      const scheduler = new EnsembleHostAdmissionScheduler({ schedule: tasks.schedule })
      for (let index = 0; index < count; index += 1) {
        expect(scheduler.reserve(request(`solo-${index}`))).toMatchObject({
          initialState: 'admitted'
        })
      }
      expect(scheduler.snapshot().occupancy).toMatchObject({ active: count, queued: 0 })
      expect(tasks.size()).toBe(0)
      scheduler.shutdown()
      await scheduler.whenIdle()
    }
  )

  it('rotates queued chats as slots free without preempting the active pool', async () => {
    const tasks = createTaskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({ schedule: tasks.schedule })
    const leases: EnsembleHostAdmissionLease[] = []
    for (let index = 0; index < 30; index += 1) {
      leases.push(await admittedLease(scheduler.reserve(request(`holder-${index}`))))
    }
    const pending = new Map<string, EnsembleHostAdmissionReservation>()
    for (const chatId of ['chat-a', 'chat-b']) {
      for (let index = 1; index <= 2; index += 1) {
        const runId = `${chatId}-${index}`
        pending.set(runId, reservation(scheduler.reserve(request(runId, { chatId }))))
      }
    }
    expect(scheduler.snapshot().occupancy).toMatchObject({ active: 30, queued: 4 })
    expect(leases.every((lease) => scheduler.stateForRun(lease.identity.runId) === 'active')).toBe(
      true
    )
    const order = ['chat-a-1', 'chat-b-1', 'chat-a-2', 'chat-b-2']
    for (let index = 0; index < order.length; index += 1) {
      leases[index].release()
      tasks.runOne()
      expect(scheduler.stateForRun(order[index])).toBe('active')
      leases.push(await admittedLease(pending.get(order[index])!))
      expect(scheduler.snapshot().occupancy.active).toBe(30)
    }
    for (const lease of leases) lease.release()
    await scheduler.whenIdle()
  })

  it('fills free capacity for a new fan-out even while a release drain is pending', async () => {
    const tasks = createTaskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({ schedule: tasks.schedule })
    const leases: EnsembleHostAdmissionLease[] = []
    for (let index = 0; index < 30; index += 1) {
      leases.push(await admittedLease(scheduler.reserve(request(`holder-${index}`))))
    }
    const older = reservation(scheduler.reserve(request('older-waiter')))
    leases[0].release()
    leases[1].release()
    expect(tasks.size()).toBe(1)
    const incoming = reservation(scheduler.reserve(request('new-wave')))
    expect(incoming.initialState).toBe('admitted')
    leases.push(await admittedLease(older), await admittedLease(incoming))
    expect(scheduler.snapshot().occupancy).toMatchObject({ active: 30, queued: 0 })
    tasks.runOne()
    for (const lease of leases) lease.release()
    await scheduler.whenIdle()
  })

  it('rotates chats first and providers within each chat while preserving provider FIFO', async () => {
    const tasks = createTaskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      maxQueued: 16,
      schedule: tasks.schedule
    })
    const holder = await admittedLease(
      scheduler.reserve(request('holder', { chatId: 'holder-chat', provider: 'grok' }))
    )
    const queued = [
      ['a-codex-1', 'chat-a', 'codex'],
      ['a-codex-2', 'chat-a', 'codex'],
      ['a-claude-1', 'chat-a', 'claude'],
      ['a-claude-2', 'chat-a', 'claude'],
      ['b-codex-1', 'chat-b', 'codex'],
      ['b-codex-2', 'chat-b', 'codex']
    ] as const
    const order: string[] = []
    const leases = new Map<string, EnsembleHostAdmissionLease>()

    for (const [runId, chatId, provider] of queued) {
      const pending = reservation(
        scheduler.reserve(request(runId, { chatId, provider: provider as ProviderId }))
      )
      expect(pending.initialState).toBe('queued')
      void pending.admission.then((outcome) => {
        if (outcome.kind !== 'admitted') return
        if (!outcome.lease.claim()) return
        order.push(runId)
        leases.set(runId, outcome.lease)
      })
    }

    expect(scheduler.snapshot().byChat).toEqual([
      { chatId: 'chat-a', active: 0, queued: 4 },
      { chatId: 'chat-b', active: 0, queued: 2 },
      { chatId: 'holder-chat', active: 1, queued: 0 }
    ])
    expect(scheduler.snapshot().byProvider).toEqual([
      { provider: 'claude', active: 0, queued: 2 },
      { provider: 'codex', active: 0, queued: 4 },
      { provider: 'grok', active: 1, queued: 0 }
    ])

    holder.release()
    const expected = [
      'a-codex-1',
      'b-codex-1',
      'a-claude-1',
      'b-codex-2',
      'a-codex-2',
      'a-claude-2'
    ]
    for (const runId of expected) {
      expect(tasks.size()).toBe(1)
      tasks.runOne()
      await Promise.resolve()
      expect(order).toEqual(expected.slice(0, order.length))
      expect(order.at(-1)).toBe(runId)
      expect(leases.get(runId)?.release()).toBe(true)
    }
    await scheduler.whenIdle()
  })
})

describe('EnsembleHostAdmissionScheduler ownership and cancellation', () => {
  it('rejects live duplicate identities and retains only a frozen lightweight identity copy', async () => {
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      maxQueued: 2,
      schedule: () => {}
    })
    const raw = {
      ...request('same-run'),
      payload: 'x'.repeat(50_000),
      chatRecord: { messages: ['must not be retained'] }
    }
    const first = scheduler.reserve(raw)
    const duplicateActive = scheduler.reserve(request('same-run'))
    const queued = scheduler.reserve(request('queued-run'))
    const duplicateQueued = scheduler.reserve(request('queued-run'))

    expect(duplicateActive).toMatchObject({ kind: 'rejected', code: 'duplicate_run' })
    expect(queued).toMatchObject({ kind: 'reserved', initialState: 'queued' })
    expect(duplicateQueued).toMatchObject({ kind: 'rejected', code: 'duplicate_run' })
    const firstLease = await admittedLease(first)
    ;(raw as { chatId: string }).chatId = 'mutated-after-reservation'
    expect(firstLease.identity.chatId).toBe('chat-a')
    expect(firstLease.identity).not.toBe(raw)
    expect(firstLease.identity).not.toHaveProperty('payload')
    expect(firstLease.identity).not.toHaveProperty('chatRecord')
    expect(Object.isFrozen(firstLease.identity)).toBe(true)

    scheduler.cancelQueued('queued-run')
    firstLease.release()
    await scheduler.whenIdle()
    expect(scheduler.snapshot().metrics.duplicateRejected).toBe(2)
  })

  it('cancels a queued run before a scheduled grant without touching active ownership', async () => {
    const tasks = createTaskQueue()
    let now = 1_000
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      maxQueued: 4,
      now: () => now,
      schedule: tasks.schedule
    })
    const holder = await admittedLease(scheduler.reserve(request('holder')))
    const survivor = reservation(scheduler.reserve(request('survivor')))
    const cancelled = reservation(scheduler.reserve(request('cancelled')))

    now += 250
    expect(scheduler.queuedForMs('cancelled')).toBe(250)
    expect(scheduler.effectiveDeadline(5_000, ['cancelled', 'survivor'])).toBe(5_250)
    holder.release()
    expect(tasks.size()).toBe(1)
    expect(cancelled.cancel('Skipped by user.')).toBe(true)
    await expect(cancelled.admission).resolves.toMatchObject({
      kind: 'cancelled',
      reason: 'Skipped by user.',
      queuedForMs: 250
    })
    expect(scheduler.cancelQueued('holder')).toBe(false)

    tasks.runOne()
    const survivorLease = await admittedLease(survivor)
    expect(scheduler.stateForRun('cancelled')).toBeUndefined()
    expect(scheduler.stateForRun('survivor')).toBe('active')
    survivorLease.release()
    await scheduler.whenIdle()
  })

  it('lets reservation cancellation win after grant but before the consumer claims the lease', async () => {
    const tasks = createTaskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      maxQueued: 4,
      schedule: tasks.schedule
    })
    const holder = await admittedLease(scheduler.reserve(request('holder')))
    const pending = reservation(scheduler.reserve(request('handoff-race')))

    holder.release()
    tasks.runOne()
    // The grant has resolved, but its promise continuation has not run in this
    // synchronous stack. Stop/history cancellation must still be able to win.
    expect(scheduler.stateForRun('handoff-race')).toBe('active')
    expect(pending.cancel('Stopped during admission handoff.')).toBe(true)

    const outcome = await pending.admission
    expect(outcome.kind).toBe('admitted')
    if (outcome.kind !== 'admitted') throw new Error('Expected the raced grant outcome.')
    expect(outcome.lease.claim()).toBe(false)
    expect(outcome.lease.release()).toBe(false)
    expect(scheduler.stateForRun('handoff-race')).toBeUndefined()
    expect(scheduler.snapshot().metrics.cancelledUnclaimed).toBe(1)

    const next = scheduler.reserve(request('next-run'))
    expect(next).toMatchObject({ kind: 'reserved', initialState: 'admitted' })
    const nextLease = await admittedLease(next)
    nextLease.release()
    await scheduler.whenIdle()
  })

  it('makes lease release idempotent and paces queued grants one scheduled turn at a time', async () => {
    const tasks = createTaskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 2,
      maxForeground: 2,
      maxQueued: 8,
      schedule: tasks.schedule
    })
    const first = await admittedLease(scheduler.reserve(request('active-1')))
    const second = await admittedLease(scheduler.reserve(request('active-2')))
    const queued = ['queued-1', 'queued-2', 'queued-3'].map((runId) =>
      reservation(scheduler.reserve(request(runId)))
    )

    expect(first.release()).toBe(true)
    expect(first.release()).toBe(false)
    expect(second.release()).toBe(true)
    expect(tasks.size()).toBe(1)

    tasks.runOne()
    expect(scheduler.snapshot().occupancy).toMatchObject({ active: 1, queued: 2 })
    expect(tasks.size()).toBe(1)
    tasks.runOne()
    expect(scheduler.snapshot().occupancy).toMatchObject({ active: 2, queued: 1 })
    expect(tasks.size()).toBe(0)

    const firstQueued = await admittedLease(queued[0])
    const secondQueued = await admittedLease(queued[1])
    firstQueued.release()
    tasks.runOne()
    const thirdQueued = await admittedLease(queued[2])
    secondQueued.release()
    thirdQueued.release()
    await scheduler.whenIdle()
    expect(scheduler.snapshot().metrics).toMatchObject({
      admitted: 5,
      released: 5,
      peakActive: 2,
      peakQueued: 3
    })
  })

  it('settles queued reservations on shutdown, rejects new work and waits for active leases', async () => {
    const tasks = createTaskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 2,
      maxForeground: 2,
      maxQueued: 4,
      schedule: tasks.schedule
    })
    const active = await admittedLease(scheduler.reserve(request('active')))
    const unclaimed = reservation(scheduler.reserve(request('unclaimed')))
    const first = reservation(scheduler.reserve(request('queued-1')))
    const second = reservation(scheduler.reserve(request('queued-2')))
    let idle = false
    const idlePromise = scheduler.whenIdle().then(() => {
      idle = true
    })

    expect(scheduler.shutdown()).toMatchObject({
      cancelledQueued: 2,
      cancelledUnclaimed: 1,
      occupancy: { active: 1, queued: 0, shuttingDown: true }
    })
    const unclaimedOutcome = await unclaimed.admission
    expect(unclaimedOutcome.kind).toBe('admitted')
    if (unclaimedOutcome.kind !== 'admitted') throw new Error('Expected an unclaimed grant.')
    expect(unclaimedOutcome.lease.claim()).toBe(false)
    await expect(first.admission).resolves.toMatchObject({ kind: 'cancelled' })
    await expect(second.admission).resolves.toMatchObject({ kind: 'cancelled' })
    expect(idle).toBe(false)
    expect(scheduler.reserve(request('too-late'))).toMatchObject({
      kind: 'rejected',
      code: 'shutting_down'
    })
    expect(scheduler.shutdown().cancelledQueued).toBe(0)

    active.release()
    await idlePromise
    expect(idle).toBe(true)
    expect(tasks.size()).toBe(0)
    expect(scheduler.snapshot().metrics).toMatchObject({
      shutdownCancelledQueued: 2,
      cancelledUnclaimed: 1,
      shutdownRejected: 1,
      released: 1
    })
  })
})

/**
 * M1 A1.1 measurement seam: one `admission_wait` span per settled waiter.
 * Every pre-existing test above runs without the `spans` option and is the
 * byte-unchanged proof that the seam's absence changes nothing.
 */
describe('EnsembleHostAdmissionScheduler admission_wait span seam', () => {
  function spanSink() {
    const spans: unknown[] = []
    return { spans, record: (span: unknown) => spans.push(span) }
  }

  it('emits one admitted span per waiter with exact identity, wait and reason', async () => {
    const tasks = createTaskQueue()
    let at = 1_000
    const sink = spanSink()
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      now: () => at,
      schedule: tasks.schedule,
      spans: sink
    })

    const first = await admittedLease(scheduler.reserve(request('run-1', { chatId: 'chat-light' })))
    const second = reservation(scheduler.reserve(request('run-2', { chatId: 'chat-heavy' })))
    expect(second.initialState).toBe('queued')
    expect(sink.spans).toEqual([
      {
        chatId: 'chat-light',
        runId: 'run-1',
        participantId: 'participant-run-1',
        laneId: 'run-1',
        kind: 'admission_wait',
        resource: 'ensemble_pool',
        reason: 'admitted',
        startedAt: 1_000,
        durationMs: 0
      }
    ])

    at = 1_450
    first.release()
    tasks.runOne()
    await second.admission
    expect(sink.spans).toHaveLength(2)
    expect(sink.spans[1]).toEqual({
      chatId: 'chat-heavy',
      runId: 'run-2',
      participantId: 'participant-run-2',
      laneId: 'run-2',
      kind: 'admission_wait',
      resource: 'ensemble_pool',
      reason: 'admitted',
      startedAt: 1_000,
      durationMs: 450
    })
  })

  it('omits laneId and participantId when the waiter genuinely has neither', async () => {
    const sink = spanSink()
    const scheduler = new EnsembleHostAdmissionScheduler({
      now: () => 5,
      schedule: () => {},
      spans: sink
    })
    await admittedLease(
      scheduler.reserve({ runId: 'fg-1', chatId: 'chat-a', provider: 'codex', kind: 'foreground' })
    )
    expect(sink.spans).toEqual([
      {
        chatId: 'chat-a',
        runId: 'fg-1',
        kind: 'admission_wait',
        resource: 'ensemble_pool',
        reason: 'admitted',
        startedAt: 5,
        durationMs: 0
      }
    ])
  })

  it('distinguishes cancelled, shutdown and rejected waiter outcomes by reason', async () => {
    // Cancelled while queued.
    let at = 100
    const cancelSink = spanSink()
    const cancelScheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      now: () => at,
      schedule: () => {},
      spans: cancelSink
    })
    await admittedLease(cancelScheduler.reserve(request('run-1')))
    const queued = reservation(cancelScheduler.reserve(request('run-2')))
    at = 175
    expect(queued.cancel('caller changed its mind')).toBe(true)
    expect(cancelSink.spans).toHaveLength(2)
    expect(cancelSink.spans[1]).toMatchObject({
      runId: 'run-2',
      reason: 'cancelled',
      startedAt: 100,
      durationMs: 75
    })

    // Settled by shutdown.
    const shutdownSink = spanSink()
    const shutdownScheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      now: () => 10,
      schedule: () => {},
      spans: shutdownSink
    })
    await admittedLease(shutdownScheduler.reserve(request('run-1')))
    reservation(shutdownScheduler.reserve(request('run-2')))
    shutdownScheduler.shutdown()
    expect(shutdownSink.spans).toHaveLength(2)
    expect(shutdownSink.spans[1]).toMatchObject({ runId: 'run-2', reason: 'shutdown' })

    // Refused by queue overflow.
    const overflowSink = spanSink()
    const overflowScheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      maxQueued: 0,
      now: () => 20,
      schedule: () => {},
      spans: overflowSink
    })
    await admittedLease(overflowScheduler.reserve(request('run-1')))
    const refused = overflowScheduler.reserve(request('run-2'))
    expect(refused.kind).toBe('rejected')
    expect(overflowSink.spans).toHaveLength(2)
    expect(overflowSink.spans[1]).toMatchObject({ runId: 'run-2', reason: 'rejected' })
  })

  it('never emits a second span for an admitted-then-cancelled-unclaimed run', async () => {
    const sink = spanSink()
    const scheduler = new EnsembleHostAdmissionScheduler({
      now: () => 50,
      schedule: () => {},
      spans: sink
    })
    const reserved = reservation(scheduler.reserve(request('run-1')))
    const outcome = await reserved.admission
    expect(outcome.kind).toBe('admitted')
    // Cancel after grant but before claim: the wait already ended at admit.
    expect(reserved.cancel('no longer needed')).toBe(true)
    expect(sink.spans).toHaveLength(1)
    expect(sink.spans[0]).toMatchObject({ reason: 'admitted' })
  })

  it('aggregates through a real recorder under admission_wait / ensemble_pool with per-chat attribution', async () => {
    const { createWorkSpanRecorder } = await import('../perf/WorkSpanRecorder')
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 64 })
    let at = 0
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      now: () => at,
      schedule: () => {},
      spans: recorder,
      maxQueued: 8
    })
    await admittedLease(scheduler.reserve(request('run-1', { chatId: 'chat-light' })))
    const queued = reservation(scheduler.reserve(request('run-2', { chatId: 'chat-heavy' })))
    at = 300
    queued.cancel('measured cancellation')

    const snapshot = recorder.snapshot()
    expect(snapshot.byKind.admission_wait?.count).toBe(2)
    expect(snapshot.byResource.ensemble_pool?.count).toBe(2)
    expect(snapshot.rejected).toBe(0)
    // The attribution the aggregate-only shape cannot make: which chat waited.
    expect(snapshot.byChat['chat-heavy']?.admission_wait?.totalMs).toBe(300)
    expect(snapshot.byChat['chat-light']?.admission_wait?.totalMs).toBe(0)
  })

  it('contains a throwing recorder: admission, cancellation and metrics are untouched', async () => {
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      now: () => 7,
      schedule: () => {},
      spans: {
        record: () => {
          throw new Error('recorder exploded')
        }
      }
    })
    const lease = await admittedLease(scheduler.reserve(request('run-1')))
    const queued = reservation(scheduler.reserve(request('run-2')))
    expect(queued.cancel()).toBe(true)
    expect(lease.release()).toBe(true)
    expect(scheduler.snapshot().metrics).toMatchObject({
      admitted: 1,
      cancelledQueued: 1,
      released: 1
    })
  })
})
