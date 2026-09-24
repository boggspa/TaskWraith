import { createRequire } from 'module'
import { describe, expect, it, vi } from 'vitest'
import {
  createHostPerfInstrumentation,
  HOST_WORK_SPAN_MAX_RETAINED,
  HOST_WORK_SPAN_RECENT_LIMIT
} from './HostPerfSnapshot'
import { createHostPerfSnapshotFileWriter } from './HostPerfSnapshotFile'
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

  it('carries the newest spans as a tail the collector accepts, naming only chats', () => {
    const { meter } = fakeMeter()
    const instrumentation = createHostPerfInstrumentation({ meter, recentSpanLimit: 2 })
    const record = (chatId: string, startedAt: number, extra: Record<string, unknown> = {}) =>
      instrumentation.spans.record({
        chatId,
        runId: 'cmd-secret-run',
        participantId: 'seat-secret',
        laneId: 'lane-secret',
        kind: 'host_queue_wait',
        resource: 'host_chain',
        startedAt,
        durationMs: 7,
        ...extra
      })
    record('chat-a', 1_000)
    record('chat-b', 1_100, { kind: 'durable_commit', bytes: 512, fallback: true })
    record('chat-a', 1_200, { kind: 'persist_barrier', reason: 'barrier' })
    const workSpans = instrumentation.snapshot().sections.workSpans as Record<string, unknown>
    expect(workSpans.recentSpans).toEqual({
      encoding: 'ring_tail_rows_v1',
      columns: [
        'seq',
        'chat',
        'kind',
        'resource',
        'startedAt',
        'durationMs',
        'bytes',
        'fallback',
        'reason'
      ],
      limit: 2,
      fromSeq: 2,
      toSeq: 3,
      omittedMaxStartedAt: 1_000,
      chats: ['chat-b', 'chat-a'],
      rows: [
        [2, 0, 'durable_commit', 'host_chain', 1_100, 7, 512, true, null],
        [3, 1, 'persist_barrier', 'host_chain', 1_200, 7, 0, false, 'barrier']
      ]
    })
    expect(JSON.stringify(workSpans.recentSpans)).not.toMatch(/secret/)
    const collector = createRequire(import.meta.url)(
      '../../scripts/perf/collectors/hostSpans.cjs'
    ) as { normalizeWorkSpanSection: (section: unknown, processName: string) => { ok: boolean } }
    expect(collector.normalizeWorkSpanSection(workSpans, 'host')).toMatchObject({ ok: true })
  })

  it('refuses a recent-span limit that is not a non-negative integer', () => {
    for (const recentSpanLimit of [-1, 1.5, Number.NaN]) {
      expect(() => createHostPerfInstrumentation({ recentSpanLimit })).toThrow(
        'Host perf recentSpanLimit must be a non-negative integer.'
      )
    }
    const { meter } = fakeMeter()
    const none = createHostPerfInstrumentation({ meter, recentSpanLimit: 0 })
    none.spans.record({ chatId: 'c', kind: 'host_queue_wait', startedAt: 5, durationMs: 1 })
    expect(
      (none.snapshot().sections.workSpans as { recentSpans: unknown }).recentSpans
    ).toMatchObject({
      limit: 0,
      rows: [],
      chats: [],
      fromSeq: null,
      toSeq: null,
      omittedMaxStartedAt: 5
    })
  })

  it('fits a full default tail and sixteen chats of attribution inside the file cap', () => {
    const { meter } = fakeMeter()
    const instrumentation = createHostPerfInstrumentation({ meter })
    for (let index = 0; index < HOST_WORK_SPAN_MAX_RETAINED; index += 1) {
      instrumentation.spans.record({
        chatId: `perf-light_beside_large_live-chat-${String(index % 16).padStart(2, '0')}`,
        kind: index % 3 === 0 ? 'durable_commit' : 'host_queue_wait',
        resource: 'host_chain',
        startedAt: 1_790_000_000_000 + index * 7,
        durationMs: index % 250
      })
    }
    const workSpans = instrumentation.snapshot().sections.workSpans as {
      recentSpans: { rows: unknown[] }
    }
    // The tail must reach back over one 5 s capture at 200 accepted spans a
    // second; the byte bound below stops it growing past the file's budget.
    expect(HOST_WORK_SPAN_RECENT_LIMIT).toBeGreaterThanOrEqual(5 * 200)
    expect(workSpans.recentSpans.rows).toHaveLength(HOST_WORK_SPAN_RECENT_LIMIT)
    const tailBytes = Buffer.byteLength(JSON.stringify(workSpans.recentSpans), 'utf8')
    expect(tailBytes).toBeLessThan(96 * 1024)
    // HOST_PERF_SNAPSHOT_FILE_MAX_BYTES: the whole file publishes untruncated.
    const files = new Map<string, string>()
    const writer = createHostPerfSnapshotFileWriter({
      instrumentation,
      path: '/perf/host.json',
      intervalMs: 5_000,
      maxBytes: 256 * 1024,
      identity: { process: 'host', instanceId: 'host-1', generation: 1, pid: 4242 },
      now: () => new Date('2026-09-24T12:00:00.000Z'),
      fs: {
        writeFileSync: (path, data) => files.set(path, data),
        renameSync: (from, to) => files.set(to, files.get(from)!)
      }
    })
    expect(writer.writeOnce()).toBe(true)
    expect(JSON.parse(files.get('/perf/host.json')!)).not.toHaveProperty('truncated')
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
