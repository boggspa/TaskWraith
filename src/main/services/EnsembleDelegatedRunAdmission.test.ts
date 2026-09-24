import { describe, expect, it, vi } from 'vitest'

import {
  EnsembleDelegatedRunAdmission,
  resolveEnsembleDelegatedRunOrigin,
  type EnsembleDelegatedRunOrigin
} from './EnsembleDelegatedRunAdmission'
import { EnsembleHostAdmissionRuntime } from './EnsembleHostAdmissionRuntime'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function origin(overrides: Partial<EnsembleDelegatedRunOrigin> = {}) {
  return {
    parentRunId: 'parent-run',
    parentChatId: 'parent-chat',
    roundId: 'round-1',
    participantId: 'boss',
    ...overrides
  }
}

function dispatchResult(runId: string) {
  return { dispatched: true, appRunId: runId }
}

describe('EnsembleDelegatedRunAdmission', () => {
  it('recovers durable Ensemble origin without enrolling the child payload in the round', () => {
    expect(
      resolveEnsembleDelegatedRunOrigin({
        parentRunId: 'parent-run',
        parentChatId: 'parent-chat',
        persistedParentRun: {
          runId: 'parent-run',
          startedAt: '2026-09-04T00:00:00.000Z',
          ensembleRoundId: 'round-1',
          ensembleParticipantId: 'reviewer',
          ensembleLaneId: 'lane-1'
        }
      })
    ).toEqual({
      parentRunId: 'parent-run',
      parentChatId: 'parent-chat',
      roundId: 'round-1',
      participantId: 'reviewer',
      laneId: 'lane-1'
    })
    expect(
      resolveEnsembleDelegatedRunOrigin({
        parentRunId: 'solo-run',
        parentChatId: 'solo-chat',
        persistedParentRun: { runId: 'solo-run', startedAt: '2026-09-04T00:00:00.000Z' }
      })
    ).toBeUndefined()
  })

  it('charges one child lane beside an already-admitted parent, never the parent twice', async () => {
    const runtime = new EnsembleHostAdmissionRuntime({
      schedulerOptions: { maxActive: 3, maxForeground: 2, maxQueued: 4 },
      scheduleBuildTurn: (task) => task()
    })
    runtime.reserve({
      runId: 'parent-run',
      chatId: 'parent-chat',
      roundId: 'round-1',
      participantId: 'boss',
      provider: 'claude',
      kind: 'foreground'
    })
    await runtime.claim('parent-run')

    const dispatch = deferred<ReturnType<typeof dispatchResult>>()
    const admission = new EnsembleDelegatedRunAdmission(runtime)
    const started = admission.start({
      origin: origin(),
      childRunId: 'child-run',
      childChatId: 'child-chat',
      provider: 'codex',
      parentRunActive: true,
      mayStart: () => true,
      dispatch: () => dispatch.promise
    })
    expect(started.ok).toBe(true)
    await flushMicrotasks()
    expect(runtime.snapshot().occupancy).toMatchObject({ active: 2, activeForeground: 1 })

    dispatch.resolve(dispatchResult('child-run'))
    if (started.ok) {
      await expect(started.completion).resolves.toMatchObject({ kind: 'dispatch' })
      started.completeConsumer()
    }
    expect(runtime.snapshot().occupancy.active).toBe(1)
    runtime.release('parent-run')
  })

  it('cancels a queued child without entering provider dispatch', async () => {
    const runtime = new EnsembleHostAdmissionRuntime({
      schedulerOptions: { maxActive: 1, maxForeground: 1, maxQueued: 4 },
      scheduleBuildTurn: (task) => task()
    })
    runtime.reserve({
      runId: 'parent-run',
      chatId: 'parent-chat',
      roundId: 'round-1',
      participantId: 'boss',
      provider: 'claude',
      kind: 'foreground'
    })
    await runtime.claim('parent-run')

    const dispatch = vi.fn(async () => dispatchResult('child-run'))
    const admission = new EnsembleDelegatedRunAdmission(runtime)
    const started = admission.start({
      origin: origin(),
      childRunId: 'child-run',
      childChatId: 'child-chat',
      provider: 'codex',
      parentRunActive: true,
      mayStart: () => true,
      dispatch
    })
    expect(started).toMatchObject({ ok: true, initialState: 'queued' })
    expect(
      admission.cancelBeforeDispatch('child-run', 'claude', 'Wrong provider must not cancel.')
    ).toBe(false)
    expect(admission.cancelBeforeDispatch('child-run', 'codex', 'Stopped by parent.')).toBe(true)
    if (started.ok) {
      await expect(started.completion).resolves.toMatchObject({
        kind: 'cancelled',
        reason: 'Stopped by parent.'
      })
      started.completeConsumer()
    }
    expect(dispatch).not.toHaveBeenCalled()
    expect(runtime.snapshot().occupancy).toMatchObject({ active: 1, queued: 0 })
    runtime.release('parent-run')
  })

  it('queues a non-blocking child without promoting its lane parent', async () => {
    const runtime = new EnsembleHostAdmissionRuntime({
      schedulerOptions: { maxActive: 2, maxForeground: 1, maxQueued: 4 },
      scheduleBuildTurn: (task) => task()
    })
    runtime.reserve({
      runId: 'foreground-holder',
      chatId: 'other-chat',
      provider: 'claude',
      kind: 'foreground'
    })
    runtime.reserve({
      runId: 'parent-run',
      chatId: 'parent-chat',
      roundId: 'round-1',
      participantId: 'boss',
      provider: 'codex',
      kind: 'lane'
    })
    await runtime.claim('foreground-holder')
    await runtime.claim('parent-run')

    const admission = new EnsembleDelegatedRunAdmission(runtime)
    const started = admission.start({
      origin: origin({ laneId: 'lane-1' }),
      childRunId: 'child-run',
      childChatId: 'child-chat',
      provider: 'muse',
      parentRunActive: true,
      mayStart: () => true,
      dispatch: vi.fn(async () => dispatchResult('child-run'))
    })
    expect(started).toMatchObject({ ok: true, initialState: 'queued' })
    expect(runtime.snapshot().occupancy).toMatchObject({ active: 2, queued: 1 })
    if (started.ok) {
      expect(admission.cancelBeforeDispatch('child-run', 'muse', 'test cleanup')).toBe(true)
      await started.completion
      started.completeConsumer()
    }
    runtime.release('parent-run')
    runtime.release('foreground-holder')
  })

  it('releases the exact child claim when dispatch rejects', async () => {
    const runtime = new EnsembleHostAdmissionRuntime({
      schedulerOptions: { maxActive: 1, maxForeground: 1, maxQueued: 4 },
      scheduleBuildTurn: (task) => task()
    })
    const admission = new EnsembleDelegatedRunAdmission(runtime)
    const started = admission.start({
      origin: origin(),
      childRunId: 'child-run',
      childChatId: 'child-chat',
      provider: 'codex',
      parentRunActive: false,
      mayStart: () => true,
      dispatch: async () => {
        throw new Error('adapter rejected')
      }
    })

    expect(started.ok).toBe(true)
    if (started.ok) {
      await expect(started.completion).rejects.toThrow('adapter rejected')
      started.completeConsumer()
    }
    expect(runtime.snapshot().occupancy).toMatchObject({ active: 0, queued: 0 })
    expect(admission.list()).toEqual([])
  })

  it('settles a wedged dispatch only after exact transport-absence confirmation', async () => {
    const runtime = new EnsembleHostAdmissionRuntime({
      schedulerOptions: { maxActive: 1, maxForeground: 1, maxQueued: 4 },
      scheduleBuildTurn: (task) => task()
    })
    const dispatch = deferred<ReturnType<typeof dispatchResult>>()
    const admission = new EnsembleDelegatedRunAdmission(runtime)
    const started = admission.start({
      origin: origin(),
      childRunId: 'child-run',
      childChatId: 'child-chat',
      provider: 'codex',
      parentRunActive: false,
      mayStart: () => true,
      dispatch: () => dispatch.promise
    })
    expect(started.ok).toBe(true)
    await flushMicrotasks()
    expect(admission.list()).toMatchObject([{ phase: 'dispatching' }])
    expect(runtime.snapshot().occupancy.active).toBe(1)

    expect(
      admission.confirmDispatchingTransportGone('child-run', 'Exact cancellation proved closure.')
    ).toBe(true)
    expect(
      admission.start({
        origin: origin(),
        childRunId: 'child-run',
        childChatId: 'replacement-child',
        provider: 'codex',
        parentRunActive: false,
        mayStart: () => true,
        dispatch: async () => dispatchResult('child-run')
      })
    ).toMatchObject({ ok: false, code: 'duplicate_run' })
    const fullSettlement = admission.list()[0]!.settlement
    let fullySettled = false
    void fullSettlement.then(() => {
      fullySettled = true
    })
    if (started.ok) {
      await expect(started.completion).resolves.toMatchObject({
        kind: 'cancelled',
        reason: 'Exact cancellation proved closure.'
      })
      expect(fullySettled).toBe(false)
      expect(admission.list()).toMatchObject([{ phase: 'settled' }])
      started.completeConsumer()
    }
    await fullSettlement
    expect(fullySettled).toBe(true)
    expect(runtime.snapshot().occupancy.active).toBe(0)
    expect(admission.list()).toEqual([])

    // A late adapter resolution is observed by Promise.race but cannot re-open
    // the admission or produce a second completion.
    dispatch.resolve(dispatchResult('child-run'))
    await flushMicrotasks()
    expect(runtime.snapshot().occupancy.active).toBe(0)
  })

  it('shuts down every pre-dispatch child with all-settled cleanup', async () => {
    const buildTurns: Array<() => void> = []
    const runtime = new EnsembleHostAdmissionRuntime({
      schedulerOptions: { maxActive: 2, maxForeground: 1, maxQueued: 4 },
      scheduleBuildTurn: (task) => buildTurns.push(task)
    })
    const dispatch = vi.fn(async () => dispatchResult('child-run'))
    const admission = new EnsembleDelegatedRunAdmission(runtime)
    const started = admission.start({
      origin: origin(),
      childRunId: 'child-run',
      childChatId: 'child-chat',
      provider: 'codex',
      parentRunActive: false,
      mayStart: () => true,
      dispatch
    })
    expect(started.ok).toBe(true)
    if (started.ok) {
      void started.completion.then(started.completeConsumer, started.completeConsumer)
    }
    await flushMicrotasks()
    expect(buildTurns).toHaveLength(1)

    const shutdown = admission.shutdownBeforeDispatch()
    buildTurns.shift()?.()
    await shutdown
    if (started.ok) await expect(started.completion).resolves.toMatchObject({ kind: 'cancelled' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(runtime.snapshot().occupancy.active).toBe(0)
  })
})
