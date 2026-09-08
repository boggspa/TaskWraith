import { describe, expect, it } from 'vitest'
import {
  createHostProjectionSerialQueue,
  type HostProjectionQueueTaskTiming
} from './HostProjectionSerialQueue'
import {
  createWorkSpanRecorder,
  type WorkSpanRecordInput
} from '../host-shared/perf/WorkSpanRecorder'

/** Deterministic clock: first call returns `start`, then +`stepMs` per call. */
function tickingClock(start = 10, stepMs = 10): () => number {
  let at = start - stepMs
  return () => (at += stepMs)
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createHostProjectionSerialQueue', () => {
  it('runs tasks strictly in enqueue order even with instrumentation attached', async () => {
    const events: string[] = []
    const runner = createHostProjectionSerialQueue({ observer: () => {} })
    const gate = deferred()

    const first = runner(async () => {
      events.push('start-a')
      await gate.promise
      events.push('end-a')
      return 'a'
    }, 'a')
    const second = runner(async () => {
      events.push('b')
      return 'b'
    }, 'b')

    await settle()
    // b must not start while a holds the queue.
    expect(events).toEqual(['start-a'])

    gate.resolve()
    await expect(first).resolves.toBe('a')
    await expect(second).resolves.toBe('b')
    expect(events).toEqual(['start-a', 'end-a', 'b'])
  })

  it('propagates a rejection to its caller and keeps serving later tasks', async () => {
    const spansRecords: WorkSpanRecordInput[] = []
    const timings: HostProjectionQueueTaskTiming[] = []
    const runner = createHostProjectionSerialQueue({
      spans: { record: (span) => spansRecords.push(span) },
      observer: (timing) => timings.push(timing),
      now: tickingClock()
    })

    const failing = runner(async () => {
      throw new Error('publication failed')
    }, 'doomed')
    const surviving = runner(async () => 'ok', 'next')

    await expect(failing).rejects.toThrow('publication failed')
    await expect(surviving).resolves.toBe('ok')
    expect(timings.map((timing) => [timing.label, timing.ok])).toEqual([
      ['doomed', false],
      ['next', true]
    ])
    expect(spansRecords).toHaveLength(2)
  })

  it('measures enqueue-to-start wait as a host_queue_wait span and run duration via the observer', async () => {
    const spansRecords: WorkSpanRecordInput[] = []
    const timings: HostProjectionQueueTaskTiming[] = []
    const runner = createHostProjectionSerialQueue({
      spans: { record: (span) => spansRecords.push(span) },
      observer: (timing) => timings.push(timing),
      now: tickingClock(10, 10)
    })

    const first = runner(async () => 'one', 'chat-light')
    const second = runner(async () => 'two', 'chat-heavy')
    await expect(first).resolves.toBe('one')
    await expect(second).resolves.toBe('two')

    expect(spansRecords).toEqual([
      {
        chatId: 'chat-light',
        laneId: 'chat-light',
        kind: 'host_queue_wait',
        resource: 'host_chain',
        startedAt: 10,
        durationMs: 20
      },
      {
        chatId: 'chat-heavy',
        laneId: 'chat-heavy',
        kind: 'host_queue_wait',
        resource: 'host_chain',
        startedAt: 20,
        durationMs: 30
      }
    ])
    expect(timings).toEqual([
      {
        label: 'chat-light',
        queuedAt: 10,
        startedAt: 30,
        finishedAt: 40,
        waitMs: 20,
        runMs: 10,
        ok: true
      },
      {
        label: 'chat-heavy',
        queuedAt: 20,
        startedAt: 50,
        finishedAt: 60,
        waitMs: 30,
        runMs: 10,
        ok: true
      }
    ])
  })

  it('feeds a real work-span recorder so Host queue waits aggregate under host_queue_wait', async () => {
    const recorder = createWorkSpanRecorder({
      process: 'host',
      maxRetained: 8,
      now: tickingClock()
    })
    const runner = createHostProjectionSerialQueue({ spans: recorder, now: tickingClock() })

    await runner(async () => undefined, 'chat-a')
    await runner(async () => undefined)
    await runner(async () => undefined, '')

    const { byKind, byResource, spans } = recorder.snapshot()
    expect(byKind.host_queue_wait?.count).toBe(3)
    expect(byResource.host_chain?.count).toBe(3)
    expect(spans.map((span) => span.chatId)).toEqual(['chat-a', 'unlabeled', 'unlabeled'])
    expect(spans.map((span) => span.process)).toEqual(['host', 'host', 'host'])
  })

  it('takes the original untimed path when no sink is supplied', async () => {
    const runner = createHostProjectionSerialQueue({
      now: () => {
        throw new Error('the untimed path must never read the clock')
      }
    })

    await expect(runner(async () => 'plain')).resolves.toBe('plain')
    await expect(runner(async () => 'second', 'labeled-anyway')).resolves.toBe('second')
  })

  it('never lets a broken sink or observer break the queue', async () => {
    const runner = createHostProjectionSerialQueue({
      spans: {
        record: () => {
          throw new Error('sink exploded')
        }
      },
      observer: () => {
        throw new Error('observer exploded')
      },
      now: tickingClock()
    })

    await expect(runner(async () => 'still-works', 'x')).resolves.toBe('still-works')
  })
})
