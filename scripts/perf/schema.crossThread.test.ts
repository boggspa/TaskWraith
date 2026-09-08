import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createEmptyPerfMetrics, validatePerfMetrics } = require('./schema.cjs')
const {
  cellName,
  parseCellName,
  enumerateMatrixCells,
  assertPairedRunCompatibility
} = require('./interferenceMatrix.cjs')
const {
  applyCrossThreadToMetrics,
  CROSS_THREAD_SCHEMA_VERSION
} = require('./collectors/hostSpans.cjs')

const CELL = {
  history: 'small',
  chats: 2,
  path: 'warm',
  mix: 'codex_profiles_solo_ensemble_mesh',
  saturation: 'none'
}

function spanAggregate() {
  return { count: 1, totalMs: 12, p50Ms: 12, p95Ms: 12, maxMs: 12, bytes: 0, fallbackCount: 0 }
}

function validSection(process: string) {
  return {
    process,
    byKind: { admission_wait: spanAggregate() },
    byResource: { host_chain: spanAggregate() },
    recorded: 1,
    dropped: 0,
    sampledOut: 0,
    rejected: 0
  }
}

function validBlock() {
  return {
    schemaVersion: CROSS_THREAD_SCHEMA_VERSION,
    cells: {
      [cellName(CELL)]: {
        capturedAt: '2026-09-08T16:00:00.000Z',
        processes: { main: validSection('main') }
      }
    }
  }
}

describe('schema crossThread seam (M1 A1.1 — present-vs-absent)', () => {
  it('absent block stays valid (pre-M1 baseline compatibility)', () => {
    const metrics = createEmptyPerfMetrics()
    expect('crossThread' in metrics).toBe(false)
    expect(validatePerfMetrics(metrics).ok).toBe(true)
  })

  it('rejects an explicit crossThread: null', () => {
    const metrics = createEmptyPerfMetrics()
    ;(metrics as Record<string, unknown>).crossThread = null
    const check = validatePerfMetrics(metrics)
    expect(check.ok).toBe(false)
    expect(check.errors.some((e: string) => e.includes('crossThread'))).toBe(true)
  })

  it('rejects a primitive crossThread value', () => {
    for (const primitive of [0, 'x', true]) {
      const metrics = createEmptyPerfMetrics()
      ;(metrics as Record<string, unknown>).crossThread = primitive
      expect(validatePerfMetrics(metrics).ok).toBe(false)
    }
  })

  it('rejects a present-but-malformed block', () => {
    const metrics = createEmptyPerfMetrics()
    ;(metrics as Record<string, unknown>).crossThread = { schemaVersion: 999, cells: {} }
    expect(validatePerfMetrics(metrics).ok).toBe(false)
  })

  it('accepts a well-formed block, including one written by the collector', () => {
    const direct = createEmptyPerfMetrics()
    ;(direct as Record<string, unknown>).crossThread = validBlock()
    expect(validatePerfMetrics(direct).ok).toBe(true)

    const folded = createEmptyPerfMetrics()
    applyCrossThreadToMetrics(folded, CELL, { main: validSection('main') })
    expect(validatePerfMetrics(folded).ok).toBe(true)
  })
})

describe('matrix cell-name canonical strictness (M1)', () => {
  it('rejects non-canonical spellings that Number() would otherwise accept', () => {
    expect(parseCellName('small/02/warm/codex_bridge_disabled/none')).toBeNull()
    expect(parseCellName('small/2.0/warm/codex_bridge_disabled/none')).toBeNull()
    expect(parseCellName('small/2 /warm/codex_bridge_disabled/none')).toBeNull()
    expect(parseCellName('small/2/warm/codex_bridge_disabled/none/')).toBeNull()
    // The canonical spelling still parses.
    expect(parseCellName('small/2/warm/codex_bridge_disabled/none')).toEqual({
      history: 'small',
      chats: 2,
      path: 'warm',
      mix: 'codex_bridge_disabled',
      saturation: 'none'
    })
  })

  it('enumerateMatrixCells yields 480 UNIQUE names, each round-tripping canonically', () => {
    const names = enumerateMatrixCells().map((cell) => cell.name)
    expect(names.length).toBe(480)
    expect(new Set(names).size).toBe(480)
    for (const name of names) {
      const parsed = parseCellName(name)
      expect(parsed).not.toBeNull()
      expect(cellName(parsed)).toBe(name)
    }
  })
})

describe('paired-run compatibility presence checks (M1)', () => {
  function descriptor(overrides: Record<string, unknown> = {}) {
    return {
      cellName: cellName(CELL),
      role: 'light-alone',
      fixtureFingerprint: 'a'.repeat(64),
      workload: 'dual_run',
      seed: 4242,
      windowMs: 120_000,
      ...overrides
    }
  }

  it('fails when BOTH descriptors omit workload and seed (undefined must not equal undefined)', () => {
    const alone = descriptor()
    const beside = descriptor({ role: 'light-beside' })
    delete (alone as Record<string, unknown>).workload
    delete (alone as Record<string, unknown>).seed
    delete (beside as Record<string, unknown>).workload
    delete (beside as Record<string, unknown>).seed
    const check = assertPairedRunCompatibility(alone, beside)
    expect(check.ok).toBe(false)
    expect(check.reasons.some((r: string) => r.includes('workload'))).toBe(true)
    expect(check.reasons.some((r: string) => r.includes('seed'))).toBe(true)
  })

  it('still fails mismatches with both fields present', () => {
    const alone = descriptor()
    const seedMismatch = assertPairedRunCompatibility(
      alone,
      descriptor({ role: 'light-beside', seed: 9999 })
    )
    expect(seedMismatch.ok).toBe(false)
    const workloadMismatch = assertPairedRunCompatibility(
      alone,
      descriptor({ role: 'light-beside', workload: '455_soak' })
    )
    expect(workloadMismatch.ok).toBe(false)
  })

  it('rejects a pair whose cell name is not the canonical spelling', () => {
    const alone = descriptor({ cellName: 'small/02/warm/codex_profiles_solo_ensemble_mesh/none' })
    const beside = descriptor({
      role: 'light-beside',
      cellName: 'small/02/warm/codex_profiles_solo_ensemble_mesh/none'
    })
    const check = assertPairedRunCompatibility(alone, beside)
    expect(check.ok).toBe(false)
    expect(check.reasons.some((r: string) => r.includes('canonical'))).toBe(true)
  })

  it('accepts a complete, matching, canonical pair', () => {
    expect(
      assertPairedRunCompatibility(descriptor(), descriptor({ role: 'light-beside' }))
    ).toEqual({ ok: true })
  })
})
