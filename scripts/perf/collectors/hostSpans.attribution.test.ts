import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'
import { createWorkSpanRecorder } from '../../../src/host-shared/perf/WorkSpanRecorder'

/**
 * Collector-level proof of Amendment A1 / Review2 R2-M1-1 and R2-M1-2: the
 * evidence a paired G-X comparison actually reads is `metrics.crossThread`,
 * so it is not enough for the recorder to know which chat was slow — that
 * attribution has to survive the whole route (recorder → section → sample →
 * fold → schema validation) without being flattened or silently dropped.
 *
 * Lives beside the collector so vitest's default discovery runs it; the
 * .cjs collector modules are loaded through createRequire.
 */
const require = createRequire(import.meta.url)
const {
  normalizeWorkSpanSection,
  validateCrossThreadBlock,
  sampleWorkSpanSections,
  applyCrossThreadToMetrics,
  aggregateHostWindowSamples
} = require('./hostSpans.cjs')

const CELL = 'large/2/warm/codex_profiles_solo_ensemble_mesh/none'

function tickingClock(start = 1_000, stepMs = 10): () => number {
  let at = start - stepMs
  return () => (at += stepMs)
}

/** One measurement window: a light and a heavy chat on the same resource. */
function measureWindow(lightMs: number, heavyMs: number): Record<string, unknown> {
  const recorder = createWorkSpanRecorder({
    process: 'main',
    maxRetained: 64,
    now: tickingClock()
  })
  for (const [chatId, durationMs] of [
    ['chat-light', lightMs],
    ['chat-heavy', heavyMs]
  ] as const) {
    recorder.record({
      chatId,
      runId: `run-${chatId}`,
      kind: 'host_queue_wait',
      resource: 'host_chain',
      startedAt: 0,
      durationMs
    })
  }
  return recorder.section() as unknown as Record<string, unknown>
}

async function foldToMetrics(section: Record<string, unknown>): Promise<Record<string, never>> {
  const sample = await sampleWorkSpanSections({ main: () => section })
  expect(sample.ok).toBe(true)
  const metrics = {} as Record<string, never>
  applyCrossThreadToMetrics(metrics, CELL, sample.sections)
  return metrics
}

describe('hostSpans collector — cross-thread attribution (A1 / R2-M1-1)', () => {
  it('carries per-chat attribution through to metrics.crossThread', async () => {
    const metrics = await foldToMetrics(measureWindow(10, 1_000))
    const processes = (
      metrics as Record<
        string,
        { cells: Record<string, { processes: Record<string, Record<string, unknown>> }> }
      >
    ).crossThread.cells[CELL].processes
    const byChat = processes.main.byChat as Record<
      string,
      Record<string, { maxMs: number; p99Ms: number; count: number }>
    >

    expect(Object.keys(byChat).sort()).toEqual(['chat-heavy', 'chat-light'])
    expect(byChat['chat-light'].host_queue_wait).toMatchObject({ count: 1, maxMs: 10, p99Ms: 10 })
    expect(byChat['chat-heavy'].host_queue_wait).toMatchObject({ maxMs: 1_000, p99Ms: 1_000 })
    expect(validateCrossThreadBlock((metrics as Record<string, never>).crossThread)).toEqual([])
  })

  it('distinguishes A (light 10ms / heavy 1000ms) from B (swapped) at the collector output', async () => {
    const a = await foldToMetrics(measureWindow(10, 1_000))
    const b = await foldToMetrics(measureWindow(1_000, 10))

    const readCell = (metrics: Record<string, never>): Record<string, unknown> =>
      (
        metrics as unknown as {
          crossThread: {
            cells: Record<string, { processes: Record<string, Record<string, unknown>> }>
          }
        }
      ).crossThread.cells[CELL].processes.main

    const cellA = readCell(a)
    const cellB = readCell(b)

    // The exact defect Review2 demonstrated: the process-wide maps are
    // byte-identical across the swap, so they cannot carry a G-X verdict.
    expect(JSON.stringify(cellA.byKind)).toEqual(JSON.stringify(cellB.byKind))
    expect(JSON.stringify(cellA.byResource)).toEqual(JSON.stringify(cellB.byResource))

    // The attributed evidence must differ, and specifically for the light thread.
    expect(JSON.stringify(cellA.byChat)).not.toEqual(JSON.stringify(cellB.byChat))
    const lightA = (cellA.byChat as Record<string, Record<string, { maxMs: number }>>)['chat-light']
    const lightB = (cellB.byChat as Record<string, Record<string, { maxMs: number }>>)['chat-light']
    expect(lightA.host_queue_wait.maxMs).toBe(10)
    expect(lightB.host_queue_wait.maxMs).toBe(1_000)
  })

  it('carries exact offered counters so a sampled-out fallback is still visible', async () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 4,
      now: tickingClock()
    })
    for (let i = 0; i < 257; i += 1) {
      recorder.record({ chatId: 'chat-light', kind: 'durable_commit', startedAt: i, durationMs: 1 })
    }
    recorder.record({
      chatId: 'chat-light',
      kind: 'durable_commit',
      startedAt: 257,
      durationMs: 1,
      bytes: 64,
      fallback: true
    })

    const metrics = await foldToMetrics(recorder.section() as unknown as Record<string, unknown>)
    const main = (
      metrics as unknown as {
        crossThread: {
          cells: Record<string, { processes: Record<string, Record<string, unknown>> }>
        }
      }
    ).crossThread.cells[CELL].processes.main
    const exact = main.exact as {
      offeredCount: number
      offeredFallbackCount: number
      byKind: Record<string, { offeredFallbackCount: number }>
    }

    expect(
      (main.byKind as Record<string, { fallbackCount: number }>).durable_commit.fallbackCount
    ).toBe(0)
    expect(exact.offeredCount).toBe(258)
    expect(exact.offeredFallbackCount).toBe(1)
    expect(exact.byKind.durable_commit.offeredFallbackCount).toBe(1)
    expect(validateCrossThreadBlock((metrics as Record<string, never>).crossThread)).toEqual([])
  })

  it('validates the new blocks when present and refuses malformed ones', () => {
    const section = measureWindow(10, 1_000)

    expect(normalizeWorkSpanSection(section, 'main').ok).toBe(true)
    // Absent blocks stay valid: a pre-attribution recorder's report must not
    // start failing because the schema learned new fields.
    const { byChat: _byChat, exact: _exact, attributionOverflow: _o, ...legacy } = section
    expect(normalizeWorkSpanSection(legacy, 'main').ok).toBe(true)

    const unknownKind = normalizeWorkSpanSection(
      { ...section, byChat: { 'chat-light': { teleport: { count: 1 } } } },
      'main'
    )
    expect(unknownKind.ok).toBe(false)
    expect(unknownKind.reason).toContain('not a known span kind')

    const badPercentile = normalizeWorkSpanSection(
      {
        ...section,
        byChat: {
          'chat-light': {
            host_queue_wait: { count: 1, totalMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 'fast', maxMs: 1 }
          }
        }
      },
      'main'
    )
    expect(badPercentile.ok).toBe(false)
    expect(badPercentile.reason).toContain('p99Ms must be finite')

    // `percentileSampleCount` follows the rule this file already sets for
    // p99Ms: a recorder that predates it must keep validating, so absence is
    // accepted and only a PRESENT non-finite value is an error. A silently
    // unvalidated field is how attribution escapes the schema.
    const chatRow = { count: 1, totalMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1, maxMs: 1 }
    const withoutBasis = normalizeWorkSpanSection(
      { ...section, byChat: { 'chat-light': { host_queue_wait: chatRow } } },
      'main'
    )
    expect(withoutBasis.ok).toBe(true)

    const withBasis = normalizeWorkSpanSection(
      {
        ...section,
        byChat: { 'chat-light': { host_queue_wait: { ...chatRow, percentileSampleCount: 0 } } }
      },
      'main'
    )
    expect(withBasis.ok).toBe(true)

    const badBasis = normalizeWorkSpanSection(
      {
        ...section,
        byChat: {
          'chat-light': { host_queue_wait: { ...chatRow, percentileSampleCount: 'some' } }
        }
      },
      'main'
    )
    expect(badBasis.ok).toBe(false)
    expect(badBasis.reason).toContain('percentileSampleCount must be finite when present')

    const badExact = normalizeWorkSpanSection(
      { ...section, exact: { offeredCount: 1, offeredFallbackCount: 0 } },
      'main'
    )
    expect(badExact.ok).toBe(false)
    expect(badExact.reason).toContain('exact.offeredBytes must be finite')

    const badExactKind = normalizeWorkSpanSection(
      {
        ...section,
        exact: {
          offeredCount: 1,
          offeredFallbackCount: 0,
          offeredBytes: 0,
          byResource: { mars: { offeredCount: 1, offeredFallbackCount: 0, offeredBytes: 0 } }
        }
      },
      'main'
    )
    expect(badExactKind.ok).toBe(false)
    expect(badExactKind.reason).toContain('not a known span taxonomy member')
  })

  it('stores a snapshot of the section rather than aliasing the live recorder', async () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 16,
      now: tickingClock()
    })
    recorder.record({ chatId: 'chat-light', kind: 'prompt_build', startedAt: 0, durationMs: 5 })
    const metrics = await foldToMetrics(recorder.section() as unknown as Record<string, unknown>)

    // More work lands after the fold; the stored cell must not change.
    recorder.record({ chatId: 'chat-light', kind: 'prompt_build', startedAt: 1, durationMs: 900 })

    const stored = (
      metrics as unknown as {
        crossThread: {
          cells: Record<string, { processes: Record<string, Record<string, unknown>> }>
        }
      }
    ).crossThread.cells[CELL].processes.main
    const byChat = stored.byChat as Record<string, Record<string, { count: number; maxMs: number }>>
    expect(byChat['chat-light'].prompt_build).toMatchObject({ count: 1, maxMs: 5 })
  })
})

/**
 * Per-role/window Host evidence (A1.52 close-out: "sampling during each
 * role/window"). The defect these tests pin: Host snapshots were read once
 * after replay/capture, so lag covered quiet time and cumulative work spans
 * combined the paired light-alone and light-beside phases. The sampler reads
 * during replay; this aggregation buckets the accepted reads into the lanes
 * driver's OBSERVED windows and reports lag per capture (A1.51's basis) and
 * work spans only as subtractable counter deltas.
 */
describe('aggregateHostWindowSamples — per-role/window Host evidence (A1.52)', () => {
  const LAG = {
    observedForMs: 5_000,
    p50Ms: 1,
    p95Ms: 4,
    p99Ms: 8,
    maxMs: 12,
    meanMs: 2,
    sampling: true,
    windowBasis: 'since_last_reset' as const,
    configuredIntervalMs: 5_000
  }

  /** One cumulative Host recorder driving accepted-read fakes in sequence. */
  function makeReader() {
    const recorder = createWorkSpanRecorder({
      process: 'host',
      maxRetained: 256,
      now: tickingClock()
    })
    let sequence = 0
    return {
      recorder,
      read(capturedAtMs: number, lag: Record<string, unknown> = LAG): Record<string, unknown> {
        sequence += 1
        return {
          sequence,
          capturedAt: new Date(capturedAtMs).toISOString(),
          eventLoopLag: lag,
          workSpans: JSON.parse(JSON.stringify(recorder.section()))
        }
      }
    }
  }

  function spans(
    recorder: ReturnType<typeof createWorkSpanRecorder>,
    chatId: string,
    durationMs: number
  ): void {
    recorder.record({
      chatId,
      kind: 'host_queue_wait',
      resource: 'host_chain',
      startedAt: 0,
      durationMs
    })
  }

  it('attributes work spans to the single role/window they were recorded in', () => {
    const { recorder, read } = makeReader()
    // Window A [0, 10s) is light-alone; window B [10s, 20s) is light-beside.
    const s1 = read(1_000)
    spans(recorder, 'chat-light', 10)
    const s2 = read(5_000)
    spans(recorder, 'chat-light', 20)
    spans(recorder, 'chat-heavy', 500)
    const s3 = read(11_000)
    spans(recorder, 'chat-light', 30)
    spans(recorder, 'chat-heavy', 700)
    const s4 = read(19_000)

    const result = aggregateHostWindowSamples({
      samples: [s1, s2, s3, s4],
      windows: [
        {
          role: 'light-alone',
          repetition: 0,
          startedAtMs: 0,
          endedAtMs: 10_000,
          outcome: 'complete'
        },
        {
          role: 'light-beside',
          repetition: 0,
          startedAtMs: 10_000,
          endedAtMs: 20_000,
          outcome: 'complete'
        }
      ]
    })
    expect(result.ok).toBe(true)
    const [alone, beside] = result.evidence.windows

    const aloneChat = alone.workSpans.byChat as Record<
      string,
      Record<string, { count: number; totalMs: number }>
    >
    expect(aloneChat).toEqual({ 'chat-light': { host_queue_wait: { count: 1, totalMs: 10 } } })
    // The heavy chat's spans stay out of the light-alone window entirely —
    // the exact pairing defect the once-after-capture read could not see.
    expect(aloneChat['chat-heavy']).toBeUndefined()
    const besideChat = beside.workSpans.byChat as Record<
      string,
      Record<string, { count: number; totalMs: number }>
    >
    expect(besideChat['chat-heavy']).toEqual({ host_queue_wait: { count: 1, totalMs: 700 } })
    expect(besideChat['chat-light']).toEqual({ host_queue_wait: { count: 1, totalMs: 30 } })

    expect(alone.workSpans.basis).toBe('cumulative_counter_delta')
    expect(alone.workSpans.percentiles).toBe('excluded_not_subtractable')
    expect(alone.workSpans.from).toEqual({ sequence: 1, capturedAt: new Date(1_000).toISOString() })
    expect(alone.workSpans.to).toEqual({ sequence: 2, capturedAt: new Date(5_000).toISOString() })
    expect(alone.workSpans.byKind).toEqual({
      host_queue_wait: { count: 1, totalMs: 10, bytes: 0, fallbackCount: 0 }
    })
    expect(alone.workSpans.byResource).toEqual({
      host_chain: { count: 1, totalMs: 10, bytes: 0, fallbackCount: 0 }
    })
  })

  it('reports lag per capture with a named across-capture basis (A1.51)', () => {
    const { read } = makeReader()
    const lagA = { ...LAG, maxMs: 9, p95Ms: 3, observedForMs: 4_800 }
    const lagB = { ...LAG, maxMs: 21, p95Ms: 6, observedForMs: 5_100 }
    const result = aggregateHostWindowSamples({
      samples: [read(1_000, lagA), read(5_000, lagB)],
      windows: [
        {
          role: 'light-alone',
          repetition: 0,
          startedAtMs: 0,
          endedAtMs: 10_000,
          outcome: 'complete'
        }
      ]
    })
    expect(result.ok).toBe(true)
    const lag = result.evidence.windows[0].lag
    expect(lag.basis).toBe('per_capture_samples')
    expect(lag.sampleCount).toBe(2)
    expect(lag.observedForMs).toBe(9_900)
    expect(lag.windowBasis).toBe('since_last_reset')
    expect(lag.configuredIntervalMs).toBe(5_000)
    expect(lag.maxAcrossMs).toBe(21)
    expect(lag.p95AcrossMs).toBe(6)
    expect(lag.acrossBasis).toEqual({
      maxAcrossMs: 'max_of_per_capture_maxMs',
      p95AcrossMs: 'nearest_rank_p95_of_per_capture_p95Ms'
    })
    // The per-capture blocks survive verbatim; no percentile is pooled.
    expect(lag.captures).toHaveLength(2)
    expect(lag.captures[0]).toMatchObject({ observedForMs: 4_800, p95Ms: 3, maxMs: 9 })
  })

  it('keeps an unobserved lag read as a counted marker, never a zero', () => {
    const { read } = makeReader()
    const result = aggregateHostWindowSamples({
      samples: [read(1_000, { unsupported: 'host_perf_lag_unobserved' }), read(5_000)],
      windows: [
        {
          role: 'light-alone',
          repetition: 0,
          startedAtMs: 0,
          endedAtMs: 10_000,
          outcome: 'complete'
        }
      ]
    })
    expect(result.ok).toBe(true)
    const lag = result.evidence.windows[0].lag
    expect(lag.sampleCount).toBe(1)
    expect(lag.unobservedCount).toBe(1)
    expect(lag.captures).toHaveLength(1)
  })

  it('reports a zero-activity window as empty maps, distinct from unmeasured', () => {
    const { read } = makeReader()
    const result = aggregateHostWindowSamples({
      samples: [read(1_000), read(5_000)],
      windows: [
        {
          role: 'light-alone',
          repetition: 0,
          startedAtMs: 0,
          endedAtMs: 10_000,
          outcome: 'complete'
        }
      ]
    })
    expect(result.ok).toBe(true)
    const workSpans = result.evidence.windows[0].workSpans
    expect(workSpans.basis).toBe('cumulative_counter_delta')
    expect(workSpans.byKind).toEqual({})
    expect(workSpans.byResource).toEqual({})
    expect(workSpans.byChat).toEqual({})
  })

  it('marks a window with fewer than two in-window samples instead of fabricating a delta', () => {
    const { read } = makeReader()
    const result = aggregateHostWindowSamples({
      samples: [read(1_000)],
      windows: [
        {
          role: 'light-alone',
          repetition: 0,
          startedAtMs: 0,
          endedAtMs: 10_000,
          outcome: 'complete'
        },
        {
          role: 'light-alone',
          repetition: 1,
          startedAtMs: 20_000,
          endedAtMs: 30_000,
          outcome: 'complete'
        }
      ]
    })
    expect(result.ok).toBe(true)
    expect(result.evidence.windows[0].workSpans).toEqual({
      unsupported: 'window_delta_requires_two_in_window_samples',
      inWindowSampleCount: 1
    })
    expect(result.evidence.windows[1].workSpans).toEqual({
      unsupported: 'window_delta_requires_two_in_window_samples',
      inWindowSampleCount: 0
    })
    expect(result.evidence.windows[1].lag.sampleCount).toBe(0)
    expect(result.evidence.windows[1].lag.maxAcrossMs).toBeNull()
  })

  it('marks windows whose observed bounds the driver could not clock', () => {
    const { read } = makeReader()
    const result = aggregateHostWindowSamples({
      samples: [read(1_000), read(5_000)],
      windows: [
        {
          role: 'light-alone',
          repetition: 0,
          startedAtMs: null,
          endedAtMs: 10_000,
          outcome: 'incomplete'
        }
      ]
    })
    expect(result.ok).toBe(true)
    expect(result.evidence.windows[0].lag).toEqual({ unsupported: 'window_bounds_unavailable' })
    expect(result.evidence.windows[0].workSpans).toEqual({
      unsupported: 'window_bounds_unavailable'
    })
  })

  it('fails a window delta closed on a non-monotonic counter', () => {
    const { read } = makeReader()
    const earlier = read(1_000)
    const later = read(5_000)
    ;(later.workSpans as Record<string, unknown>).recorded = -1
    ;(earlier.workSpans as Record<string, unknown>).recorded = 3
    const result = aggregateHostWindowSamples({
      samples: [earlier, later],
      windows: [
        {
          role: 'light-alone',
          repetition: 0,
          startedAtMs: 0,
          endedAtMs: 10_000,
          outcome: 'complete'
        }
      ]
    })
    expect(result.ok).toBe(true)
    expect(result.evidence.windows[0].workSpans.unsupported).toContain('window_delta_non_monotonic')
  })

  it('degrades byChat attribution when either bracketing read truncated it', () => {
    const { recorder, read } = makeReader()
    const s1 = read(1_000)
    spans(recorder, 'chat-heavy', 120)
    const s2 = read(5_000)
    s2.truncated = true
    s2.truncation = { extraSections: true, byChat: true }
    const result = aggregateHostWindowSamples({
      samples: [s1, s2],
      windows: [
        {
          role: 'light-beside',
          repetition: 0,
          startedAtMs: 0,
          endedAtMs: 10_000,
          outcome: 'complete'
        }
      ]
    })
    expect(result.ok).toBe(true)
    const workSpans = result.evidence.windows[0].workSpans
    expect(workSpans.byChat).toEqual({ unsupported: 'transport_attribution_truncated' })
    // The process-level maps survive the degraded attribution.
    expect(workSpans.byKind).toEqual({
      host_queue_wait: { count: 1, totalMs: 120, bytes: 0, fallbackCount: 0 }
    })
  })

  it('refuses malformed input rather than bucketing it', () => {
    expect(aggregateHostWindowSamples({ samples: null, windows: [] })).toEqual({
      ok: false,
      reason: 'samples must be an array'
    })
    expect(aggregateHostWindowSamples({ samples: [], windows: [{}] }).ok).toBe(false)
    const { read } = makeReader()
    const s1 = read(1_000)
    const s2 = read(5_000)
    // A stateless reader cannot promise monotonic consumption; the sampler
    // enforces it, and a reversed array refuses closed.
    expect(aggregateHostWindowSamples({ samples: [s2, s1], windows: [] }).ok).toBe(false)
    expect(aggregateHostWindowSamples({ samples: [{}], windows: [] }).ok).toBe(false)
    const noSpans = read(9_000)
    delete noSpans.workSpans
    expect(aggregateHostWindowSamples({ samples: [noSpans], windows: [] }).ok).toBe(false)
  })
})
