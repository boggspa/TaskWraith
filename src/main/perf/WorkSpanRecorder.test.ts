import { describe, expect, it } from 'vitest'
import {
  createWorkSpanRecorder,
  DEFAULT_KEEP_ALL_MIN_WINDOW,
  DEFAULT_SAMPLE_KEEP_EVERY,
  WORK_SPAN_KINDS,
  WORK_SPAN_RESOURCES,
  type WorkSpanAttrs,
  type WorkSpanKind
} from './WorkSpanRecorder'

/** Deterministic clock: first call returns `start`, then +`stepMs` per call. */
function tickingClock(start = 1_000, stepMs = 10): () => number {
  let at = start - stepMs
  return () => (at += stepMs)
}

const attrs = (overrides: Partial<WorkSpanAttrs> = {}): WorkSpanAttrs => ({
  chatId: 'chat-a',
  runId: 'run-1',
  participantId: 'seat-3',
  laneId: 'lane-7',
  kind: 'admission_wait',
  resource: 'ensemble_pool',
  ...overrides
})

describe('createWorkSpanRecorder', () => {
  it('attributes a begun span to its chat, run, participant and lane exactly', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 8,
      now: tickingClock(5_000, 25)
    })
    const end = recorder.begin(attrs())
    end({ bytes: 2_048, fallback: true })

    expect(recorder.snapshot().spans).toEqual([
      {
        process: 'main',
        chatId: 'chat-a',
        runId: 'run-1',
        participantId: 'seat-3',
        laneId: 'lane-7',
        kind: 'admission_wait',
        startedAt: 5_000,
        durationMs: 25,
        resource: 'ensemble_pool',
        bytes: 2_048,
        fallback: true
      }
    ])
  })

  it('defaults optional identity fields and resource without rejecting', () => {
    const recorder = createWorkSpanRecorder({
      process: 'host',
      maxRetained: 4,
      now: tickingClock()
    })
    recorder.begin({ chatId: 'chat-b', kind: 'durable_commit' })()

    const snapshot = recorder.snapshot()
    expect(snapshot.rejected).toBe(0)
    expect(snapshot.spans[0]).toMatchObject({
      process: 'host',
      chatId: 'chat-b',
      runId: '',
      participantId: '',
      laneId: '',
      resource: 'none',
      bytes: 0,
      fallback: false
    })
  })

  it('bounds retention to maxRetained, dropping oldest while totals stay exact', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 3,
      now: tickingClock()
    })
    for (const runId of ['r1', 'r2', 'r3', 'r4']) {
      recorder.record({ ...attrs({ runId }), startedAt: 0, durationMs: 5 })
    }

    const snapshot = recorder.snapshot()
    expect(snapshot.spans.map((span) => span.runId)).toEqual(['r2', 'r3', 'r4'])
    expect(snapshot.dropped).toBe(1)
    expect(snapshot.recorded).toBe(4)
    expect(snapshot.byKind.admission_wait?.count).toBe(4)
    expect(snapshot.byKind.admission_wait?.totalMs).toBe(20)
  })

  it('skips spans the sampler declines and counts them as sampledOut', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 8,
      now: tickingClock(),
      sampler: (spanAttrs) => spanAttrs.runId !== 'skip-me'
    })
    recorder.begin(attrs({ runId: 'keep-me' }))()
    recorder.begin(attrs({ runId: 'skip-me' }))()

    const snapshot = recorder.snapshot()
    expect(snapshot.spans.map((span) => span.runId)).toEqual(['keep-me'])
    expect(snapshot.sampledOut).toBe(1)
    expect(snapshot.recorded).toBe(1)
    expect(snapshot.byKind.admission_wait?.count).toBe(1)
  })

  it('keeps everything below the default load threshold, then samples deterministically', () => {
    const below = createWorkSpanRecorder({ process: 'main', maxRetained: 4, now: tickingClock() })
    for (let i = 0; i < DEFAULT_KEEP_ALL_MIN_WINDOW; i += 1) {
      below.record({ ...attrs(), startedAt: i, durationMs: 1 })
    }
    expect(below.snapshot().sampledOut).toBe(0)

    const above = createWorkSpanRecorder({ process: 'main', maxRetained: 4, now: tickingClock() })
    const offered = DEFAULT_KEEP_ALL_MIN_WINDOW + DEFAULT_SAMPLE_KEEP_EVERY * 2
    for (let i = 0; i < offered; i += 1) {
      above.record({ ...attrs(), startedAt: i, durationMs: 1 })
    }
    const snapshot = above.snapshot()
    expect(snapshot.sampledOut).toBeGreaterThan(0)
    expect(snapshot.recorded).toBeGreaterThanOrEqual(DEFAULT_KEEP_ALL_MIN_WINDOW)
    expect(snapshot.recorded + snapshot.sampledOut).toBe(offered)
  })

  it('rejects malformed input without throwing and without recording', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: tickingClock()
    })
    const endHandles = [
      recorder.begin({ chatId: '', kind: 'admission_wait' }),
      recorder.begin({ chatId: 'chat-a', kind: 'not_a_kind' as WorkSpanKind }),
      recorder.begin({ ...attrs(), resource: 'not_a_resource' as never }),
      recorder.begin(null as unknown as WorkSpanAttrs)
    ]
    for (const end of endHandles) {
      expect(() => end()).not.toThrow()
    }
    recorder.record({ ...attrs(), startedAt: Number.NaN, durationMs: 5 })
    recorder.record({ ...attrs(), startedAt: 0, durationMs: -1 })
    recorder.record({ ...attrs(), startedAt: 0, durationMs: 1, bytes: Number.POSITIVE_INFINITY })

    const snapshot = recorder.snapshot()
    expect(snapshot.rejected).toBe(7)
    expect(snapshot.recorded).toBe(0)
    expect(snapshot.spans).toEqual([])
  })

  it('aggregates count, totals, percentiles and fallback per kind and per resource', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 32,
      now: tickingClock()
    })
    for (let duration = 10; duration <= 100; duration += 10) {
      recorder.record({
        ...attrs({ kind: 'prompt_build', resource: 'none' }),
        startedAt: duration,
        durationMs: duration,
        bytes: 100,
        fallback: duration === 100
      })
    }
    recorder.record({
      ...attrs({ kind: 'host_queue_wait', resource: 'host_chain' }),
      startedAt: 0,
      durationMs: 7
    })

    const { byKind, byResource } = recorder.snapshot()
    expect(byKind.prompt_build).toEqual({
      count: 10,
      totalMs: 550,
      p50Ms: 50,
      p95Ms: 100,
      p99Ms: 100,
      maxMs: 100,
      bytes: 1_000,
      fallbackCount: 1
    })
    expect(byKind.host_queue_wait).toEqual({
      count: 1,
      totalMs: 7,
      p50Ms: 7,
      p95Ms: 7,
      p99Ms: 7,
      maxMs: 7,
      bytes: 0,
      fallbackCount: 0
    })
    expect(byKind.admission_wait).toBeUndefined()
    expect(byResource.host_chain?.count).toBe(1)
    expect(byResource.none?.totalMs).toBe(550)
  })

  it('exposes a detachable non-resetting section provider without raw spans', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: tickingClock()
    })
    recorder.begin(attrs())()

    // Detached exactly as a composition root registers it:
    // createMainPerfInstrumentation({ sections: { workSpans: recorder.section } })
    const { section } = recorder
    const provided = section()
    expect(provided.process).toBe('main')
    expect(provided.recorded).toBe(1)
    expect(provided.byKind.admission_wait?.count).toBe(1)
    expect(provided).not.toHaveProperty('spans')

    // Reading the section twice must not window anything away.
    expect(section().recorded).toBe(1)
    expect(recorder.snapshot().spans).toHaveLength(1)
  })

  it('windows spans, aggregates and counters when a snapshot resets', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 2,
      now: tickingClock(),
      sampler: (spanAttrs) => spanAttrs.runId !== 'skip'
    })
    recorder.record({ ...attrs({ runId: 'skip' }), startedAt: 0, durationMs: 1 })
    recorder.begin({ chatId: '', kind: 'admission_wait' })
    for (const runId of ['a', 'b', 'c']) {
      recorder.record({ ...attrs({ runId }), startedAt: 0, durationMs: 2 })
    }

    const first = recorder.snapshot({ reset: true })
    expect(first.recorded).toBe(3)
    expect(first.dropped).toBe(1)
    expect(first.sampledOut).toBe(1)
    expect(first.rejected).toBe(1)
    expect(first.spans).toHaveLength(2)

    expect(recorder.snapshot()).toEqual({
      process: 'main',
      spans: [],
      byKind: {},
      byResource: {},
      recorded: 0,
      dropped: 0,
      sampledOut: 0,
      rejected: 0,
      degraded: 0,
      exact: {
        offeredCount: 0,
        offeredFallbackCount: 0,
        offeredBytes: 0,
        byKind: {},
        byResource: {}
      },
      byChat: {},
      attributionOverflow: 0
    })
  })

  it('records a begun span once even when its end handle is called twice', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: tickingClock()
    })
    const end = recorder.begin(attrs())
    end()
    end({ bytes: 999 })

    const snapshot = recorder.snapshot()
    expect(snapshot.recorded).toBe(1)
    expect(snapshot.spans[0]?.bytes).toBe(0)
  })

  it('coerces malformed end-handle decorations instead of rejecting the measured span', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: tickingClock()
    })
    recorder.begin(attrs())({ bytes: Number.NaN, fallback: 'yes' as unknown as boolean })

    const snapshot = recorder.snapshot()
    expect(snapshot.recorded).toBe(1)
    expect(snapshot.rejected).toBe(0)
    expect(snapshot.spans[0]).toMatchObject({ bytes: 0, fallback: false })
  })

  it('keeps the span when a sampler throws instead of losing it', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: tickingClock(),
      sampler: () => {
        throw new Error('sampler crashed')
      }
    })
    expect(() => recorder.begin(attrs())()).not.toThrow()

    const snapshot = recorder.snapshot()
    expect(snapshot.recorded).toBe(1)
    expect(snapshot.sampledOut).toBe(0)
  })

  it('pins the exact default sampling ratio above the keep-all threshold', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: tickingClock()
    })
    // Literals on purpose: 272 offers = 256 kept below the keep-all threshold
    // plus 16 offered at the 1-in-8 cadence (2 kept, 14 sampled out). Deriving
    // these from the exported constants would let the constants drift without
    // reddening this pin.
    for (let i = 0; i < 272; i += 1) {
      recorder.record({ ...attrs(), startedAt: i, durationMs: 1 })
    }

    const snapshot = recorder.snapshot()
    expect(snapshot.recorded).toBe(258)
    expect(snapshot.sampledOut).toBe(14)
  })

  it('accepts every declared kind and resource and pins the enum sizes', () => {
    expect(WORK_SPAN_KINDS).toHaveLength(8)
    expect(WORK_SPAN_RESOURCES).toHaveLength(7)

    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 64,
      now: tickingClock()
    })
    for (const [index, kind] of WORK_SPAN_KINDS.entries()) {
      recorder.record({
        ...attrs({ kind, resource: WORK_SPAN_RESOURCES[index % WORK_SPAN_RESOURCES.length] }),
        startedAt: index,
        durationMs: 1
      })
    }

    const { byKind, byResource, rejected } = recorder.snapshot()
    expect(rejected).toBe(0)
    for (const kind of WORK_SPAN_KINDS) {
      expect(byKind[kind]?.count).toBe(1)
    }
    // 8 kinds cycled over 7 resources: the first resource is used twice.
    expect(byResource[WORK_SPAN_RESOURCES[0]]?.count).toBe(2)
    for (const resource of WORK_SPAN_RESOURCES.slice(1)) {
      expect(byResource[resource]?.count).toBe(1)
    }
  })

  it('returns snapshot copies so caller mutation cannot corrupt the ring', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: tickingClock()
    })
    recorder.record({ ...attrs(), startedAt: 0, durationMs: 10 })

    const first = recorder.snapshot()
    first.spans.push({ ...first.spans[0], runId: 'forged' })
    first.spans[0].durationMs = 9_999
    const forgedAggregate = first.byKind.admission_wait
    expect(forgedAggregate).toBeDefined()
    if (forgedAggregate) forgedAggregate.count = 42

    const second = recorder.snapshot()
    expect(second.spans).toHaveLength(1)
    expect(second.spans[0]).toMatchObject({ runId: 'run-1', durationMs: 10 })
    expect(second.byKind.admission_wait?.count).toBe(1)
    expect(second.byKind.admission_wait?.p95Ms).toBe(10)
  })

  it('contains a clock that throws at begin time and keeps application work running', () => {
    let calls = 0
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: () => {
        calls += 1
        throw new Error('clock_probe')
      }
    })

    let applicationWorkCompleted = false
    expect(() => {
      const end = recorder.begin(attrs())
      applicationWorkCompleted = true
      end({ bytes: 16, fallback: true })
    }).not.toThrow()

    expect(applicationWorkCompleted).toBe(true)
    expect(calls).toBe(1)
    const snapshot = recorder.snapshot()
    expect(snapshot.degraded).toBe(1)
    expect(snapshot.recorded).toBe(0)
    expect(snapshot.spans).toEqual([])
  })

  it('contains a clock that throws at end time without recording a poisoned span', () => {
    let calls = 0
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: () => {
        calls += 1
        if (calls === 1) return 1_000
        throw new Error('clock_probe_end')
      }
    })

    const end = recorder.begin(attrs())
    expect(() => end()).not.toThrow()

    const snapshot = recorder.snapshot()
    expect(snapshot.degraded).toBe(1)
    expect(snapshot.recorded).toBe(0)
    expect(snapshot.byKind.admission_wait).toBeUndefined()
  })

  it('treats a non-finite clock reading as degraded at begin and at end', () => {
    const beginNaN = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: () => Number.NaN
    })
    expect(() => beginNaN.begin(attrs())()).not.toThrow()
    expect(beginNaN.snapshot()).toMatchObject({ degraded: 1, recorded: 0 })

    let calls = 0
    const endInfinite = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: () => {
        calls += 1
        return calls === 1 ? 1_000 : Number.POSITIVE_INFINITY
      }
    })
    expect(() => endInfinite.begin(attrs())()).not.toThrow()
    const snapshot = endInfinite.snapshot()
    expect(snapshot.degraded).toBe(1)
    expect(snapshot.recorded).toBe(0)
    // A poisoned duration must never reach the aggregates.
    expect(snapshot.byKind.admission_wait).toBeUndefined()
  })

  it('keeps measuring after a transient clock failure', () => {
    let calls = 0
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: () => {
        calls += 1
        if (calls === 1) throw new Error('transient')
        return calls * 10
      }
    })

    recorder.begin(attrs())()
    recorder.begin(attrs())()

    const snapshot = recorder.snapshot()
    expect(snapshot.degraded).toBe(1)
    expect(snapshot.recorded).toBe(1)
    expect(snapshot.spans).toHaveLength(1)
  })

  it('pins retained-window percentiles beside exact totals across eviction', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 2,
      now: tickingClock()
    })
    for (const durationMs of [40, 10, 20]) {
      recorder.record({ ...attrs({ kind: 'checkpoint_prepare' }), startedAt: 0, durationMs })
    }

    // 40 was evicted: totals stay exact while percentiles cover the retained
    // [10, 20] window — so p95 (20) and maxMs (40) legitimately disagree.
    expect(recorder.snapshot().byKind.checkpoint_prepare).toEqual({
      count: 3,
      totalMs: 70,
      p50Ms: 10,
      p95Ms: 20,
      p99Ms: 20,
      maxMs: 40,
      bytes: 0,
      fallbackCount: 0
    })
  })

  it('counts every offered fallback exactly, including sampled-out record() spans', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: tickingClock()
    })
    // Review2's probe: 257 ordinary offers, then the ONLY true fallback lands
    // on offer 258 — which the default sampler declines.
    for (let i = 0; i < 257; i += 1) {
      recorder.record({ ...attrs(), startedAt: i, durationMs: 1 })
    }
    recorder.record({ ...attrs(), startedAt: 257, durationMs: 1, bytes: 64, fallback: true })

    const snapshot = recorder.snapshot()
    expect(snapshot.sampledOut).toBe(1)
    // Sampled aggregates legitimately miss it...
    expect(snapshot.byKind.admission_wait?.fallbackCount).toBe(0)
    // ...but the exact counters never can.
    expect(snapshot.exact.offeredCount).toBe(258)
    expect(snapshot.exact.offeredFallbackCount).toBe(1)
    expect(snapshot.exact.offeredBytes).toBe(64)
    expect(snapshot.exact.byKind.admission_wait?.offeredFallbackCount).toBe(1)
    expect(snapshot.exact.byResource.ensemble_pool?.offeredFallbackCount).toBe(1)
  })

  it('counts a fallback decorated at end even when the span was sampled out', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: tickingClock()
    })
    for (let i = 0; i < 257; i += 1) {
      recorder.record({ ...attrs(), startedAt: i, durationMs: 1 })
    }
    // begin() is sampled out here, so its handle is the no-op path — the late
    // fallback/bytes decoration must still reach the exact counters.
    const end = recorder.begin(attrs())
    end({ bytes: 32, fallback: true })
    end({ bytes: 32, fallback: true })

    const snapshot = recorder.snapshot()
    expect(snapshot.sampledOut).toBe(1)
    expect(snapshot.byKind.admission_wait?.fallbackCount).toBe(0)
    expect(snapshot.exact.offeredCount).toBe(258)
    expect(snapshot.exact.offeredFallbackCount).toBe(1)
    expect(snapshot.exact.offeredBytes).toBe(32)
  })

  it('attributes durations per chat so a light thread is distinguishable from a heavy one', () => {
    const measure = (lightMs: number, heavyMs: number) => {
      const recorder = createWorkSpanRecorder({
        process: 'main',
        maxRetained: 32,
        now: tickingClock()
      })
      for (const [chatId, durationMs] of [
        ['chat-light', lightMs],
        ['chat-heavy', heavyMs]
      ] as const) {
        recorder.record({
          ...attrs({ chatId, kind: 'host_queue_wait', resource: 'host_chain' }),
          startedAt: 0,
          durationMs
        })
      }
      return recorder.snapshot()
    }

    // Review2's experiment: same kind, same resource, swapped durations.
    const a = measure(10, 1_000)
    const b = measure(1_000, 10)

    // The process-wide aggregate genuinely cannot tell these apart...
    expect(a.byKind.host_queue_wait).toEqual(b.byKind.host_queue_wait)
    // ...and byChat must.
    expect(a.byChat).not.toEqual(b.byChat)
    expect(a.byChat['chat-light'].host_queue_wait).toMatchObject({
      count: 1,
      totalMs: 10,
      p95Ms: 10,
      p99Ms: 10,
      maxMs: 10
    })
    expect(b.byChat['chat-light'].host_queue_wait).toMatchObject({ maxMs: 1_000, p99Ms: 1_000 })
    expect(a.attributionOverflow).toBe(0)
  })

  it('bounds byChat and counts the overflow instead of growing without limit', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 64,
      now: tickingClock(),
      maxAttributedChats: 2
    })
    for (const chatId of ['chat-a', 'chat-b', 'chat-c', 'chat-d', 'chat-a']) {
      recorder.record({ ...attrs({ chatId }), startedAt: 0, durationMs: 5 })
    }

    const snapshot = recorder.snapshot()
    expect(Object.keys(snapshot.byChat).sort()).toEqual(['chat-a', 'chat-b'])
    // First-come admission never evicts, so the early (light) thread keeps
    // accumulating while late arrivals only raise the overflow counter.
    expect(snapshot.byChat['chat-a'].admission_wait?.count).toBe(2)
    expect(snapshot.attributionOverflow).toBe(2)
    expect(snapshot.recorded).toBe(5)
  })
})
