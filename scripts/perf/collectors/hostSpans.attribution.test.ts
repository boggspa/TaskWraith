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
  applyCrossThreadToMetrics
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
