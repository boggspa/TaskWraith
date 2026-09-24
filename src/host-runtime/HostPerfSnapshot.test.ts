import { describe, expect, it, vi } from 'vitest'
import { createHostPerfInstrumentation, HOST_WORK_SPAN_MAX_RETAINED } from './HostPerfSnapshot'
import type { EventLoopLagMeter, EventLoopLagSnapshot } from '../host-shared/perf/EventLoopLagMeter'
import { createWorkSpanRecorder } from '../host-shared/perf/WorkSpanRecorder'

function fakeMeter(): {
  meter: EventLoopLagMeter
  resets: number[]
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
} {
  const resets: number[] = []
  const start = vi.fn()
  const stop = vi.fn()
  const lag: EventLoopLagSnapshot = {
    observedForMs: 1_000,
    p50Ms: 1,
    p95Ms: 5,
    p99Ms: 9,
    maxMs: 42,
    meanMs: 2,
    sampling: true
  }
  return {
    resets,
    start,
    stop,
    meter: {
      start,
      stop,
      snapshot: (options) => {
        resets.push(options?.reset ? 1 : 0)
        return lag
      }
    }
  }
}

function tickingClock(start = 1_000, stepMs = 10): () => number {
  let at = start - stepMs
  return () => (at += stepMs)
}

describe('createHostPerfInstrumentation', () => {
  it('bundles the Host lag snapshot with the workSpans section', () => {
    const { meter } = fakeMeter()
    const spans = createWorkSpanRecorder({ process: 'host', maxRetained: 8, now: tickingClock() })
    spans.begin({
      chatId: 'chat-a',
      runId: 'run-1',
      kind: 'host_queue_wait',
      resource: 'host_chain'
    })()

    const instrumentation = createHostPerfInstrumentation({
      meter,
      spans,
      now: () => new Date('2026-09-08T15:00:00.000Z')
    })
    const snapshot = instrumentation.snapshot()

    expect(snapshot.capturedAt).toBe('2026-09-08T15:00:00.000Z')
    expect(snapshot.eventLoopLag.maxMs).toBe(42)
    const workSpans = snapshot.sections.workSpans as {
      process: string
      recorded: number
      byKind: Record<string, { count: number }>
    }
    expect(workSpans.process).toBe('host')
    expect(workSpans.recorded).toBe(1)
    expect(workSpans.byKind.host_queue_wait.count).toBe(1)
    expect(workSpans).not.toHaveProperty('spans')
  })

  it('degrades a throwing section to an error marker without failing the snapshot', () => {
    const { meter } = fakeMeter()
    const instrumentation = createHostPerfInstrumentation({
      meter,
      sections: {
        broken: () => {
          throw new Error('record store detached')
        },
        healthy: () => ({ queued: 2 }),
        empty: () => undefined
      }
    })
    const snapshot = instrumentation.snapshot()

    expect(snapshot.sections.broken).toEqual({ error: 'record store detached' })
    expect(snapshot.sections.healthy).toEqual({ queued: 2 })
    expect(snapshot.sections.empty).toBeNull()
    expect(snapshot.sections.workSpans).toMatchObject({ process: 'host', recorded: 0 })
  })

  it('drives the lag meter through start, stop and window reset', () => {
    const { meter, resets, start, stop } = fakeMeter()
    const instrumentation = createHostPerfInstrumentation({ meter })

    instrumentation.start()
    instrumentation.snapshot()
    instrumentation.snapshot({ resetLagWindow: true })
    instrumentation.stop()

    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(resets).toEqual([0, 1])
  })

  it('constructs a Host-process recorder by default and exposes it for wiring', () => {
    const { meter } = fakeMeter()
    const instrumentation = createHostPerfInstrumentation({ meter })

    const end = instrumentation.spans.begin({ chatId: 'chat-z', kind: 'durable_commit' })
    end({ bytes: 64 })
    const snapshot = instrumentation.snapshot()

    const workSpans = snapshot.sections.workSpans as { process: string; recorded: number }
    expect(workSpans.process).toBe('host')
    expect(workSpans.recorded).toBe(1)
  })

  it('retains a whole observed window, and costs nothing until spans arrive', () => {
    // The bound was set before anyone had seen real span volume. The first run
    // to produce production Host spans recorded 4,512 in one window and dropped
    // 4,000 — retained exactly the old bound of 512 — so every percentile in
    // that snapshot described the most recent 11% of the window.
    const OBSERVED_HOST_SPANS_PER_WINDOW = 4512
    expect(HOST_WORK_SPAN_MAX_RETAINED).toBeGreaterThan(OBSERVED_HOST_SPANS_PER_WINDOW)

    // THE PRODUCT-COST CONDITION. The ring must grow by push from empty, never
    // preallocate to the bound: this constant is resident in every install, and
    // most installs record nothing. Asserted behaviourally rather than by
    // reading the implementation, so a future switch to `new Array(n)` reds
    // here instead of quietly costing every user megabytes.
    const idle = createWorkSpanRecorder({ process: 'host', maxRetained: 1_000_000 })
    expect(idle.snapshot().spans).toHaveLength(0)
    for (let i = 0; i < 3; i++) {
      idle.record({
        chatId: 'c',
        runId: 'r',
        kind: 'host_queue_wait',
        resource: 'host_chain',
        startedAt: 0,
        durationMs: i
      })
    }
    expect(idle.snapshot().spans).toHaveLength(3)
  })

  it('raises the keep-everything sampling threshold with the bound, not independently', () => {
    // Coupled, and deliberately recorded: the default sampler keeps every span
    // until a window has been offered max(256, maxRetained * 8), then keeps
    // 1-in-N. Raising retention therefore also raises the threshold at which
    // sampling begins — the fidelity-improving direction, but a second
    // behavioural change riding the same constant.
    const recorder = createWorkSpanRecorder({ process: 'host', maxRetained: 32 })
    for (let i = 0; i < 32 * 8; i++) {
      recorder.record({
        chatId: 'c',
        runId: 'r',
        kind: 'host_queue_wait',
        resource: 'host_chain',
        startedAt: 0,
        durationMs: 1
      })
    }
    // Everything offered below the threshold is accepted, never sampled out.
    expect(recorder.snapshot().sampledOut).toBe(0)
    expect(recorder.snapshot().recorded).toBe(32 * 8)
  })

  it('keeps the recorder behind the workSpans section even when a caller supplies one', () => {
    const { meter } = fakeMeter()
    const instrumentation = createHostPerfInstrumentation({
      meter,
      sections: { workSpans: () => ({ impostor: true }) }
    })
    const snapshot = instrumentation.snapshot()

    expect(snapshot.sections.workSpans).toMatchObject({ process: 'host' })
    expect(snapshot.sections.workSpans).not.toMatchObject({ impostor: true })
  })
})
