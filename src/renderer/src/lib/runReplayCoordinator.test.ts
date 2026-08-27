/**
 * The bound this suite defends: a streaming run must not produce one full
 * `getRunEventReplay` fetch per emitted run event, per card.
 *
 * `RunRepository.appendRunEvent` fires `run-events-changed` on every appended
 * event, driven by CLI socket data callbacks. RunCard's push migration removed
 * the 2s poll but kept a fetch on every event, so a fast run was strictly worse
 * than the poll it replaced and multiplied by the number of cards watching the
 * same run. These tests pin the fetch COUNT, not the listener count — bounding
 * listeners alone was the defect three reviewers independently flagged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunEventReplay } from '../../../main/store/types'
import {
  __configureRunReplayCoordinatorForTests,
  __resetRunReplayCoordinatorForTests,
  __runReplayPendingRunIdsForTests,
  requestRunReplay,
  subscribeToRunReplay
} from './runReplayCoordinator'

const DEBOUNCE_MS = 150

function replay(marker: string): RunEventReplay {
  return { marker } as unknown as RunEventReplay
}

/** Records every fetch so a burst can be measured rather than asserted about. */
function countingFetch(): {
  calls: string[]
  fetchReplay: (runId: string) => Promise<RunEventReplay>
} {
  const calls: string[] = []
  return {
    calls,
    fetchReplay: (runId: string) => {
      calls.push(runId)
      return Promise.resolve(replay(`${runId}#${calls.length}`))
    }
  }
}

describe('runReplayCoordinator fetch bounding', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetRunReplayCoordinatorForTests()
  })

  afterEach(() => {
    __resetRunReplayCoordinatorForTests()
    vi.useRealTimers()
  })

  it('collapses a burst of run events into a single replay fetch', async () => {
    const { calls, fetchReplay } = countingFetch()
    __configureRunReplayCoordinatorForTests({ fetchReplay, debounceMs: DEBOUNCE_MS })
    subscribeToRunReplay('run-1', () => undefined)

    // 10 events arriving faster than the debounce window, as a streaming
    // provider actually emits them.
    for (let i = 0; i < 10; i++) {
      requestRunReplay('run-1')
      await vi.advanceTimersByTimeAsync(5)
    }
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2)

    expect(calls).toHaveLength(1)
  })

  it('keeps one in-flight fetch and issues exactly one trailing refetch', async () => {
    const calls: string[] = []
    let release: ((value: RunEventReplay) => void) | undefined
    __configureRunReplayCoordinatorForTests({
      debounceMs: DEBOUNCE_MS,
      fetchReplay: (runId: string) => {
        calls.push(runId)
        return new Promise<RunEventReplay>((resolve) => {
          release = resolve
        })
      }
    })
    subscribeToRunReplay('run-1', () => undefined)

    requestRunReplay('run-1', { immediate: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)

    // Events landing while the first fetch is unresolved must not stack.
    for (let i = 0; i < 5; i++) requestRunReplay('run-1')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2)
    expect(calls).toHaveLength(1)

    release?.(replay('first'))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2)
    expect(calls).toHaveLength(2)
  })

  it('fans one fetch out to every card watching the same run', async () => {
    const { calls, fetchReplay } = countingFetch()
    __configureRunReplayCoordinatorForTests({ fetchReplay, debounceMs: DEBOUNCE_MS })
    const seen: string[] = []
    for (const name of ['a', 'b', 'c']) {
      subscribeToRunReplay('run-1', (value) =>
        seen.push(`${name}:${String((value as unknown as { marker: string }).marker)}`)
      )
    }

    requestRunReplay('run-1')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2)

    expect(calls).toHaveLength(1)
    expect(seen).toEqual(['a:run-1#1', 'b:run-1#1', 'c:run-1#1'])
  })

  it('debounces each run independently', async () => {
    const { calls, fetchReplay } = countingFetch()
    __configureRunReplayCoordinatorForTests({ fetchReplay, debounceMs: DEBOUNCE_MS })
    subscribeToRunReplay('run-1', () => undefined)
    subscribeToRunReplay('run-2', () => undefined)

    requestRunReplay('run-1')
    requestRunReplay('run-1')
    requestRunReplay('run-2')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2)

    expect(calls.filter((id) => id === 'run-1')).toHaveLength(1)
    expect(calls.filter((id) => id === 'run-2')).toHaveLength(1)
  })

  it('cancels a pending fetch when the last card unmounts', async () => {
    const { calls, fetchReplay } = countingFetch()
    __configureRunReplayCoordinatorForTests({ fetchReplay, debounceMs: DEBOUNCE_MS })
    const unsubscribe = subscribeToRunReplay('run-1', () => undefined)

    requestRunReplay('run-1')
    unsubscribe()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4)

    expect(calls).toHaveLength(0)
    expect(__runReplayPendingRunIdsForTests()).toEqual([])
  })

  it('serves first paint immediately rather than waiting out the debounce', async () => {
    const { calls, fetchReplay } = countingFetch()
    __configureRunReplayCoordinatorForTests({ fetchReplay, debounceMs: DEBOUNCE_MS })
    subscribeToRunReplay('run-1', () => undefined)

    requestRunReplay('run-1', { immediate: true })
    await vi.advanceTimersByTimeAsync(0)

    expect(calls).toHaveLength(1)
  })

  it('reset clears module singletons so state cannot leak between tests', async () => {
    const { calls, fetchReplay } = countingFetch()
    __configureRunReplayCoordinatorForTests({ fetchReplay, debounceMs: DEBOUNCE_MS })
    subscribeToRunReplay('run-1', () => undefined)
    requestRunReplay('run-1')

    __resetRunReplayCoordinatorForTests()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4)

    expect(calls).toHaveLength(0)
    expect(__runReplayPendingRunIdsForTests()).toEqual([])
  })
})
