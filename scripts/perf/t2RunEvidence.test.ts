import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { buildT2RunEvidence } = require('./t2RunEvidence.cjs')
const {
  validateRunEvidence,
  MATRIX_SAMPLING,
  RUN_EVIDENCE_VERSION
} = require('./interferenceMatrix.cjs')
const { FIXTURE_GENERATOR_VERSION } = require('./fixtureGenerator.cjs')
const { runT2BaselineCli } = require('./runT2Baseline.cjs')

const CELL = 'small/2/warm/codex_bridge_disabled/none'

function input(overrides: Record<string, unknown> = {}) {
  return {
    cell: CELL,
    role: 'light-beside',
    workload: 'dual_run',
    seed: 42,
    fixtureFingerprint: 'f'.repeat(64),
    fixtureChatIds: ['perf-dual_run-chat-01', 'perf-dual_run-chat-02'],
    buildId: 'test-build',
    launched: true,
    ...overrides
  }
}

function completeWindows(chatIds: string[]) {
  const populations = chatIds.map((chatId, index) => ({
    chatId,
    role: index === 0 ? 'light' : 'heavy'
  }))
  return Array.from({ length: 3 }, (_, repetition) => ({
    repetition,
    outcome: 'complete',
    reason: 'deadline',
    startedAtMs: repetition * 120_000,
    endedAtMs: (repetition + 1) * 120_000,
    elapsedMs: 120_000,
    lanes: populations.map((population) => ({
      ...population,
      plannedEvents: 1,
      startedEvents: 1,
      completedEvents: 1,
      failedEvents: 0,
      unsupportedEvents: 0,
      pendingEvents: 0,
      lateEvents: 0,
      measuredSamples: 1,
      overlappedLightSamples: population.role === 'light' ? 1 : 0
    }))
  }))
}

describe('T2 run-evidence descriptor (Wall 2a)', () => {
  it('emits the fixed sampling contract with the observed run identity', () => {
    const { run } = buildT2RunEvidence(input())
    expect(run.windowMs).toBe(MATRIX_SAMPLING.windowMs)
    expect(run.repetitions).toBe(MATRIX_SAMPLING.repetitions)
    expect(run.cellName).toBe(CELL)
    expect(run.role).toBe('light-beside')
    expect(run.workload).toBe('dual_run')
    expect(run.seed).toBe(42)
    expect(run.fixtureFingerprint).toBe('f'.repeat(64))
    expect(run.fixtureVersions).toEqual({ fixtureGenerator: FIXTURE_GENERATOR_VERSION })
    expect(run.buildId).toBe('test-build')
    expect(run.evidence.schemaVersion).toBe(RUN_EVIDENCE_VERSION)
  })

  it('designates the first fixture chat light and the rest heavy', () => {
    const { run } = buildT2RunEvidence(input())
    expect(run.evidence.populations).toEqual([
      { role: 'light', chatId: 'perf-dual_run-chat-01' },
      { role: 'heavy', chatId: 'perf-dual_run-chat-02' }
    ])
    expect(run.evidence.lightChatId).toBe('perf-dual_run-chat-01')
  })

  it('claims no signals and no windows, so the validator reports exactly the coverage gaps', () => {
    const { run, evidenceErrors, evidenceEligible } = buildT2RunEvidence(input())
    expect(run.signals).toBeUndefined()
    expect(run.evidence.windows).toEqual([])
    expect(run.evidence.status).toBe('incomplete')
    expect(run.incomplete).toBe(true)
    expect(run.diagnosticOnly).toBe(false)
    expect(evidenceEligible).toBe(false)
    expect(evidenceErrors).toEqual([
      'qualified evidence requires measured percentile signals',
      'run evidence is not a completed measurement',
      'run is incomplete',
      'coverage for every repetition required'
    ])
    // The builder self-checks through the same validator the gates read.
    expect(validateRunEvidence(run)).toEqual(evidenceErrors)
  })

  it('reports the identity gap when cell, role or buildId are undeclared', () => {
    const { run, evidenceErrors } = buildT2RunEvidence(
      input({ cell: null, role: null, buildId: undefined })
    )
    expect(run.cellName).toBeUndefined()
    expect(run.role).toBeUndefined()
    expect(run.buildId).toBeUndefined()
    expect(evidenceErrors).toContain(
      'qualified evidence requires complete run identity and fixture metadata'
    )
  })

  it('surfaces the pairing-role contradiction instead of hiding it', () => {
    const { evidenceErrors } = buildT2RunEvidence(input({ role: 'light-alone' }))
    expect(evidenceErrors).toContain('pairing role contradicts measured populations')
  })

  it('carries complete observed coverage into a qualifying descriptor', () => {
    const chatIds = ['perf-dual_run-chat-01', 'perf-dual_run-chat-02']
    const { run, evidenceErrors, evidenceEligible } = buildT2RunEvidence(
      input({
        windows: completeWindows(chatIds),
        signals: { roundStartMs: { count: 3, p50: 10, p95: 20, p99: 30 } }
      })
    )
    expect(run.evidence.status).toBe('complete')
    expect(run.incomplete).toBe(false)
    expect(evidenceErrors).toEqual([])
    expect(evidenceEligible).toBe(true)
    expect(validateRunEvidence(run)).toEqual([])
  })

  it('deep-copies coverage so later caller mutation cannot rewrite the descriptor', () => {
    const windows = completeWindows(['perf-dual_run-chat-01'])
    const signals = { roundStartMs: { count: 3, p50: 10, p95: 20, p99: 30 } }
    const { run } = buildT2RunEvidence(
      input({ role: 'light-alone', fixtureChatIds: ['perf-dual_run-chat-01'], windows, signals })
    )
    windows.length = 0
    signals.roundStartMs.count = 999
    expect(run.evidence.windows).toHaveLength(3)
    expect(run.signals.roundStartMs.count).toBe(3)
  })

  it('marks a non-launched run diagnosticOnly', () => {
    const { run, evidenceErrors } = buildT2RunEvidence(input({ launched: false }))
    expect(run.diagnosticOnly).toBe(true)
    expect(run.evidence.diagnosticOnly).toBe(true)
    expect(evidenceErrors).toContain('run is diagnosticOnly')
  })

  it('refuses malformed inputs instead of emitting a misleading descriptor', () => {
    expect(() => buildT2RunEvidence(null)).toThrow(/options required/)
    expect(() => buildT2RunEvidence(input({ fixtureChatIds: [] }))).toThrow(/fixture chat/)
    expect(() => buildT2RunEvidence(input({ fixtureChatIds: ['a', 'a'] }))).toThrow(/unique/)
    expect(() => buildT2RunEvidence(input({ workload: '' }))).toThrow(/workload/)
    expect(() => buildT2RunEvidence(input({ seed: '42' }))).toThrow(/seed/)
    expect(() => buildT2RunEvidence(input({ fixtureFingerprint: '' }))).toThrow(/Fingerprint/)
    expect(() => buildT2RunEvidence(input({ role: 'boss' }))).toThrow(/role/)
    expect(() => buildT2RunEvidence(input({ cell: 'bogus' }))).toThrow(/cell/)
    expect(() => buildT2RunEvidence(input({ buildId: '' }))).toThrow(/buildId/)
    expect(() => buildT2RunEvidence(input({ windows: {} }))).toThrow(/windows/)
  })
})

describe('T2 runner run-evidence wiring (Wall 2a)', () => {
  function dryRunArgs(extra: string[] = []) {
    return [
      '--workload=dual_run',
      '--dry-run',
      '--lean',
      '--scale-down=40',
      '--instance-id=perfT2Wall2a01',
      `--home=${path.join(tmpdir(), 'tw-t2-home-wall2a')}`,
      `--artifact-dir=${mkdtempSync(path.join(tmpdir(), 'tw-t2-wall2a-'))}`,
      ...extra
    ]
  }

  const dryRunOptions = () => ({
    repoRoot: path.resolve(__dirname, '..', '..'),
    forceIsolated: true,
    platform: 'darwin'
  })

  it('attaches a run-evidence descriptor with declared identity and exact gaps', async () => {
    const dry = await runT2BaselineCli(
      dryRunArgs([`--cell=${CELL}`, '--role=light-beside', '--build-id=test-build']),
      dryRunOptions()
    )
    expect(dry.ok).toBe(true)
    const run = dry.report.runEvidence
    expect(run.cellName).toBe(CELL)
    expect(run.role).toBe('light-beside')
    expect(run.workload).toBe('dual_run')
    expect(run.seed).toBe(42)
    expect(run.buildId).toBe('test-build')
    expect(run.fixtureFingerprint).toBe(dry.fingerprint)
    expect(run.fixtureVersions).toEqual({ fixtureGenerator: FIXTURE_GENERATOR_VERSION })
    expect(run.evidence.populations.length).toBeGreaterThanOrEqual(1)
    expect(run.evidence.populations[0].role).toBe('light')
    expect(run.evidence.lightChatId).toBe(run.evidence.populations[0].chatId)
    expect(validateRunEvidence(run)).toEqual([
      'qualified evidence requires measured percentile signals',
      'run evidence is not a completed measurement',
      'run is incomplete',
      'run is diagnosticOnly',
      'coverage for every repetition required'
    ])
  })

  it('leaves identity undeclared without the flags, and the gap list says so', async () => {
    const dry = await runT2BaselineCli(dryRunArgs(), dryRunOptions())
    expect(dry.ok).toBe(true)
    const run = dry.report.runEvidence
    expect(run.cellName).toBeUndefined()
    expect(run.role).toBeUndefined()
    expect(run.buildId).toBeUndefined()
    expect(validateRunEvidence(run)).toContain(
      'qualified evidence requires complete run identity and fixture metadata'
    )
  })

  it('refuses an invalid --role and an empty --build-id before any I/O', async () => {
    await expect(
      runT2BaselineCli(['--workload=dual_run', '--dry-run', '--role=boss'])
    ).rejects.toThrow(/--role/)
    await expect(
      runT2BaselineCli(['--workload=dual_run', '--dry-run', '--build-id='])
    ).rejects.toThrow(/--build-id/)
  })
})
