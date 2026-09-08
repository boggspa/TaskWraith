import { describe, expect, it, vi } from 'vitest'
import { createHostPerfInstrumentation } from './HostPerfSnapshot'
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
