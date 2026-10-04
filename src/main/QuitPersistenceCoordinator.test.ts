import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import {
  QUIT_PERSISTENCE_DRAIN_TIMEOUT_MS,
  createQuitPersistenceCoordinator
} from './QuitPersistenceCoordinator'

function quitEvent() {
  return { preventDefault: vi.fn(() => {}) }
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
} {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settlePromiseCallbacks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('QuitPersistenceCoordinator', () => {
  it('holds repeated quit requests behind one drain and automatically retries when ready', async () => {
    const gate = deferred()
    const scheduled: Array<() => void> = []
    const requestQuit = vi.fn()
    const flush = vi.fn(() => gate.promise)
    const coordinator = createQuitPersistenceCoordinator({
      flush,
      requestQuit,
      scheduleRetry: (callback) => scheduled.push(callback)
    })

    const first = quitEvent()
    coordinator.handle(first)
    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(coordinator.beginTeardown()).toBe(false)

    const repeated = quitEvent()
    coordinator.handle(repeated)
    expect(repeated.preventDefault).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(requestQuit).not.toHaveBeenCalled()

    gate.resolve()
    await settlePromiseCallbacks()
    expect(scheduled).toHaveLength(1)
    expect(requestQuit).not.toHaveBeenCalled()

    scheduled[0]()
    expect(requestQuit).toHaveBeenCalledTimes(1)

    const committedRetry = quitEvent()
    coordinator.handle(committedRetry)
    expect(committedRetry.preventDefault).not.toHaveBeenCalled()
    expect(coordinator.beginTeardown()).toBe(true)
    expect(coordinator.beginTeardown()).toBe(false)
  })

  it('defers even an immediately completed drain to a later event-loop turn', async () => {
    const scheduled: Array<() => void> = []
    const requestQuit = vi.fn()
    const coordinator = createQuitPersistenceCoordinator({
      flush: vi.fn(async () => {}),
      requestQuit,
      scheduleRetry: (callback) => scheduled.push(callback)
    })

    coordinator.handle(quitEvent())
    await settlePromiseCallbacks()

    expect(scheduled).toHaveLength(1)
    expect(requestQuit).not.toHaveBeenCalled()
    scheduled[0]()
    expect(requestQuit).toHaveBeenCalledTimes(1)
  })

  it('reports a failed drain and still commits the bounded quit retry', async () => {
    const scheduled: Array<() => void> = []
    const error = new Error('Host persistence failed')
    const onDrainError = vi.fn()
    const requestQuit = vi.fn()
    const coordinator = createQuitPersistenceCoordinator({
      flush: vi.fn(async () => {
        throw error
      }),
      requestQuit,
      scheduleRetry: (callback) => scheduled.push(callback),
      onDrainError
    })

    coordinator.handle(quitEvent())
    await settlePromiseCallbacks()

    expect(onDrainError).toHaveBeenCalledWith(error)
    expect(scheduled).toHaveLength(1)
    scheduled[0]()
    expect(requestQuit).toHaveBeenCalledTimes(1)
  })
})

describe('quit persistence main-process wiring', () => {
  const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

  it('gates will-quit once and runs destructive teardown only after the drain', () => {
    const producers = indexSource.indexOf('const quitProducers = createMainQuitProducerBarrier({')
    const durability = indexSource.indexOf(
      'const quitDurability = createMainQuitDurabilityIntegration({',
      producers
    )
    const coordinator = indexSource.indexOf(
      'const quitPersistence = createQuitPersistenceCoordinator({',
      durability
    )
    const willQuit = indexSource.indexOf("app.on('will-quit', () => {", coordinator)
    expect(producers).toBeGreaterThanOrEqual(0)
    expect(durability).toBeGreaterThan(producers)
    expect(coordinator).toBeGreaterThan(durability)
    expect(willQuit).toBeGreaterThan(coordinator)

    // Both admission drains settle before the producer join reports, so a
    // failed one cannot leave its sibling running under the final save.
    const producerBarrier = indexSource.slice(producers, durability)
    const admissions = producerBarrier.slice(
      producerBarrier.indexOf('fenceAdmissions:'),
      producerBarrier.indexOf('fenceQueue:')
    )
    expect(admissions).toContain('return settleQuitDrains(')
    expect(admissions).toContain('shutdownAndJoinEnsembleDelegatedRuns()')
    expect(admissions).toContain('ensembleOrchestratorRef.shutdownHostAdmission()')
    const nativeJoin = producerBarrier.slice(
      producerBarrier.indexOf('joinNative:'),
      producerBarrier.indexOf('operations:')
    )
    expect(nativeJoin).toContain('settleQuitDrains(')
    expect(nativeJoin).toContain('canvasService.join()')
    // A fail-fast join would report while a sibling drain is still running.
    expect(admissions).not.toContain('Promise.all(')
    expect(nativeJoin).not.toContain('Promise.all(')

    // The integration orders join → final save → retirement; its own suite
    // proves the save still runs when the join fails.
    const durabilityGate = indexSource.slice(durability, coordinator)
    expect(durabilityGate).toContain('quiesceProducers: () => quitProducers.quiesce()')
    expect(durabilityGate).toContain('await AppStore.flushAllChatSaves()')
    expect(durabilityGate).toContain('shutdownDurability: () => AppStore.shutdownMainDurability()')
    expect(durabilityGate.indexOf('quiesceProducers:')).toBeLessThan(
      durabilityGate.indexOf('await AppStore.flushAllChatSaves()')
    )

    const persistenceGate = indexSource.slice(coordinator, willQuit)
    expect(persistenceGate).toContain('flush: () => quitDurability.flush()')
    expect(indexSource).toContain('ensembleDelegatedRunAdmission.shutdownBeforeDispatch()')
    expect(indexSource).toContain('terminateAndJoinEnsembleDelegatedRun(')
    expect(indexSource).toContain('entry.settlement.then(() => undefined)')
    expect(persistenceGate).toContain("app.on('will-quit', quitPersistence.handle)")

    const teardown = indexSource.slice(willQuit, indexSource.indexOf('\n    })', willQuit))
    expect(teardown).toContain('if (!quitPersistence.beginTeardown()) return')
    expect(teardown).not.toContain('event.preventDefault()')
    expect(teardown).not.toContain('AppStore.flushAllChatSaves()')
  })
})

describe('QuitPersistenceCoordinator drain timeout', () => {
  it('quits after the drain timeout when the flush never settles', () => {
    vi.useFakeTimers()
    try {
      const gate = deferred()
      const scheduled: Array<() => void> = []
      const onDrainError = vi.fn()
      const requestQuit = vi.fn()
      const coordinator = createQuitPersistenceCoordinator({
        flush: () => gate.promise,
        requestQuit,
        scheduleRetry: (callback) => scheduled.push(callback),
        onDrainError,
        drainTimeoutMs: 50
      })

      coordinator.handle(quitEvent())
      vi.advanceTimersByTime(49)
      expect(onDrainError).not.toHaveBeenCalled()
      expect(scheduled).toHaveLength(0)

      vi.advanceTimersByTime(1)
      expect(onDrainError).toHaveBeenCalledTimes(1)
      expect(String((onDrainError.mock.calls[0]?.[0] as Error).message)).toContain(
        'did not finish within 50ms'
      )
      expect(scheduled).toHaveLength(1)
      scheduled[0]()
      expect(requestQuit).toHaveBeenCalledTimes(1)
      expect(coordinator.beginTeardown()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not schedule a second quit when a timed-out flush settles later', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred()
      const scheduled: Array<() => void> = []
      const onDrainError = vi.fn()
      const coordinator = createQuitPersistenceCoordinator({
        flush: () => gate.promise,
        requestQuit: vi.fn(),
        scheduleRetry: (callback) => scheduled.push(callback),
        onDrainError,
        drainTimeoutMs: 10
      })

      coordinator.handle(quitEvent())
      vi.advanceTimersByTime(10)
      expect(scheduled).toHaveLength(1)

      gate.reject(new Error('late failure'))
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
      expect(scheduled).toHaveLength(1)
      expect(onDrainError).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('defaults the drain timeout to 30 seconds', () => {
    expect(QUIT_PERSISTENCE_DRAIN_TIMEOUT_MS).toBe(30_000)
  })
})
