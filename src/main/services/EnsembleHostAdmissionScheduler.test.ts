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

  it('defaults to eight active runs, six foreground roots, two reserved lane slots and 256 waiters', async () => {
    const tasks = createTaskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({ schedule: tasks.schedule })
    const active: EnsembleHostAdmissionLease[] = []

    for (let index = 0; index < 6; index += 1) {
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

    for (let index = 0; index < 2; index += 1) {
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
      reservedLaneSlots: 2,
      maxQueued: DEFAULT_ENSEMBLE_HOST_MAX_QUEUED_RUNS,
      active: 8,
      activeForeground: 6,
      activeLanes: 2,
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
})

describe('EnsembleHostAdmissionScheduler fairness', () => {
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
