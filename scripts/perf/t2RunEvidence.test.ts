import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { buildT2RunEvidence } = require('./t2RunEvidence.cjs')
const {
  validateRunEvidence,
  validateInterferenceReport,
  MATRIX_SAMPLING,
  RUN_EVIDENCE_VERSION
} = require('./interferenceMatrix.cjs')
const { FIXTURE_GENERATOR_VERSION, generatePerfFixture } = require('./fixtureGenerator.cjs')
const { runT2BaselineCli, pairedRunRecord } = require('./runT2Baseline.cjs')

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

describe('T2 windowed-replay wiring (Wall 2 window orchestration)', () => {
  function windowedArgs(extra: string[] = []) {
    return [
      '--workload=dual_run',
      '--lean',
      '--scale-down=40',
      '--windowed-replay',
      '--instance-id=perfT2Windowed01',
      `--home=${path.join(tmpdir(), 'tw-t2-home-windowed')}`,
      `--artifact-dir=${mkdtempSync(path.join(tmpdir(), 'tw-t2-windowed-'))}`,
      ...extra
    ]
  }

  // Revision-CAS store over the same deterministic fixture the CLI builds
  // internally, so every save-kind event lands and run lookups resolve.
  function revisionCasApi(fixture) {
    const canonical = new Map()
    for (const chat of fixture.chats) {
      canonical.set(chat.appChatId, { revision: chat.persistenceRevision || 1 })
    }
    return {
      async getChat(chatId: string) {
        const entry = canonical.get(chatId)
        if (!entry) return null
        const chat = fixture.chats.find((c) => c.appChatId === chatId)
        return { ...chat, persistenceRevision: entry.revision }
      },
      async saveChat(chat) {
        const entry = canonical.get(chat.appChatId)
        if (!entry) return null
        if ((chat.persistenceRevision || 1) !== entry.revision) {
          return { appChatId: chat.appChatId, persistenceRevision: entry.revision }
        }
        entry.revision += 1
        return { appChatId: chat.appChatId, persistenceRevision: entry.revision }
      }
    }
  }

  function windowedOptions() {
    const fixture = generatePerfFixture({
      workload: 'dual_run',
      seed: 42,
      lean: true,
      scaleDown: 40
    })
    return {
      repoRoot: path.resolve(__dirname, '..', '..'),
      forceIsolated: true,
      platform: 'darwin',
      replayApi: revisionCasApi(fixture),
      // Test-only seam: short windows stay validator-ineligible by design.
      replayWindowMs: 50
    }
  }

  it('feeds observed windows and signals into the descriptor without qualifying short samples', async () => {
    const result = await runT2BaselineCli(
      windowedArgs([`--cell=${CELL}`, '--build-id=test-build']),
      windowedOptions()
    )
    expect(result.ok).toBe(true)
    expect(result.report.windowedReplay).toMatchObject({ windowed: true, windows: 3 })
    expect(result.report.windowedReplay.completedEvents).toBeGreaterThan(0)
    expect(result.report.windowedReplay.evidenceEligible).toBe(false)
    const run = result.report.runEvidence
    expect(run.evidence.windows).toHaveLength(3)
    for (const window of run.evidence.windows) {
      expect(window.lanes).toHaveLength(run.evidence.populations.length)
    }
    const lightSamples = run.evidence.windows.reduce(
      (total, window) => total + window.lanes.find((lane) => lane.role === 'light').measuredSamples,
      0
    )
    expect(run.signals['light.applyLatencyMs'].count).toBe(lightSamples)
    const errors = validateRunEvidence(run)
    expect(errors).toContain('incomplete, overlapping or invalid observed window')
    expect(errors).not.toContain('coverage for every repetition required')
  })

  it('default path stays sequential and gap-declaring', async () => {
    const args = windowedArgs().filter((arg) => arg !== '--windowed-replay')
    const result = await runT2BaselineCli(args, windowedOptions())
    expect(result.ok).toBe(true)
    expect(result.report.replay.eventCount).toBeGreaterThan(0)
    expect(result.report.windowedReplay).toBeUndefined()
    expect(result.report.runEvidence.evidence.windows).toEqual([])
    expect(validateRunEvidence(result.report.runEvidence)).toContain(
      'coverage for every repetition required'
    )
  })

  it('refuses --max-replay-events with --windowed-replay', async () => {
    await expect(
      runT2BaselineCli(windowedArgs(['--max-replay-events=10']), windowedOptions())
    ).rejects.toThrow(/--max-replay-events/)
  })
})

describe('T2 paired-run wiring (Wall 2 G-X pairing)', () => {
  const interferenceEnvironment = {
    capturedAt: '2026-09-08T18:00:00.000Z',
    appVersion: 'test',
    nodeVersion: 'test',
    electronVersion: { unsupported: 'synthetic-test' },
    repoProvenance: {
      gitSha: 'b'.repeat(40),
      dirty: false,
      dirtyPaths: [],
      dirtyTreeFingerprint: 'a'.repeat(64),
      isolatedWorktree: false,
      authoritativeBaseline: false
    },
    machine: {
      platform: 'test',
      arch: 'test',
      release: 'test',
      cpuModel: 'test',
      cpuCount: 1,
      totalMemoryBytes: 1
    },
    ollamaMaxLoadedModels: null,
    taskwraithFlags: {}
  }

  function pairedArgs(extra: string[] = []) {
    return [
      '--workload=dual_run',
      '--lean',
      '--scale-down=40',
      '--paired-runs',
      `--cell=${CELL}`,
      '--build-id=test-build',
      '--instance-id=perfT2Paired01',
      `--home=${path.join(tmpdir(), 'tw-t2-home-paired')}`,
      `--artifact-dir=${mkdtempSync(path.join(tmpdir(), 'tw-t2-paired-'))}`,
      ...extra
    ]
  }

  function fixtureBackedApi(fixture) {
    const store = new Map()
    for (const chat of fixture.chats) store.set(chat.appChatId, { ...chat })
    return {
      async getChat(chatId: string) {
        return store.get(chatId) || null
      },
      async saveChat(record: { appChatId?: string; persistenceRevision?: number }) {
        const nextRev = (record.persistenceRevision || 0) + 1
        store.set(record.appChatId, { ...record, persistenceRevision: nextRev })
        return { persistenceRevision: nextRev }
      }
    }
  }

  function pairedOptions() {
    const fixture = generatePerfFixture({
      workload: 'dual_run',
      seed: 42,
      lean: true,
      scaleDown: 40
    })
    return {
      repoRoot: path.resolve(__dirname, '..', '..'),
      forceIsolated: true,
      platform: 'darwin',
      replayApi: fixtureBackedApi(fixture),
      replayWindowMs: 50,
      interferenceEnvironment
    }
  }

  it('emits report.pairs and a schema-valid interference document without qualifying short samples', async () => {
    const result = await runT2BaselineCli(pairedArgs(), pairedOptions())
    expect(result.ok).toBe(true)
    expect(result.report.windowedReplay).toMatchObject({ windowed: true, windows: 3 })
    expect(result.report.pairedRuns).toMatchObject({
      paired: true,
      pairingOk: false,
      lightAloneRole: 'light-alone',
      lightBesideRole: 'light-beside'
    })
    expect(result.report.pairs).toEqual([])
    expect(result.report.runEvidence.role).toBe('light-beside')
    expect(result.report.runEvidence.evidence.windows).toHaveLength(3)
    expect(result.report.pairedRuns.reasons.length).toBeGreaterThan(0)
    expect(result.report.interferenceReport).toMatchObject({
      schemaVersion: 2,
      pairs: []
    })
    expect(validateInterferenceReport(result.report.interferenceReport)).toEqual({
      ok: true,
      errors: []
    })
    expect(validateRunEvidence(result.report.runEvidence)).toContain(
      'incomplete, overlapping or invalid observed window'
    )
  })

  it('keeps both halves of a refused pairing so the alone/beside delta stays derivable', async () => {
    const result = await runT2BaselineCli(pairedArgs(), pairedOptions())
    expect(result.ok).toBe(true)
    // pairRuns refuses any ineligible run, so the pair receipt — the only other
    // artifact that carried the light-alone run — is absent by design.
    expect(result.report.pairs).toEqual([])
    const { lightAlone, lightBeside } = result.report.pairedRuns
    expect(lightAlone.pairingRole).toBe('light-alone')
    expect(lightBeside.pairingRole).toBe('light-beside')
    for (const half of [lightAlone, lightBeside]) {
      expect(half.evidenceEligible).toBe(false)
      expect(half.windows).toHaveLength(3)
      const names = Object.keys(half.signals || {})
      expect(names.length).toBeGreaterThan(0)
      for (const name of names) {
        expect(half.signals[name].count).toBeGreaterThan(0)
        for (const percentile of ['p50', 'p95', 'p99']) {
          expect(typeof half.signals[name][percentile]).toBe('number')
        }
      }
      for (const window of half.windows) {
        expect(window.lanes.length).toBeGreaterThan(0)
        for (const lane of window.lanes) {
          expect(typeof lane.chatId).toBe('string')
          expect(lane.measuredSamples).toBeGreaterThan(0)
        }
      }
    }
    // The delta the pairing exists to produce, derived from the artifacts alone.
    const signal = Object.keys(lightAlone.signals)[0]
    expect(Number.isFinite(lightBeside.signals[signal].p50 - lightAlone.signals[signal].p50)).toBe(
      true
    )
  })

  it('records no half at all rather than an empty one', () => {
    expect(pairedRunRecord(null)).toBeNull()
    expect(pairedRunRecord({})).toBeNull()
    expect(pairedRunRecord({ run: { role: 'light-alone' } })).toMatchObject({
      pairingRole: 'light-alone',
      censored: false,
      evidenceEligible: false,
      signals: null,
      windows: []
    })
  })

  it('implies windowed replay so sequential gap-declaring stays the default', async () => {
    const args = pairedArgs().filter((arg) => arg !== '--paired-runs')
    const result = await runT2BaselineCli(args, pairedOptions())
    expect(result.ok).toBe(true)
    expect(result.report.pairs).toBeUndefined()
    expect(result.report.pairedRuns).toBeUndefined()
    expect(result.report.interferenceReport).toBeUndefined()
    expect(result.report.windowedReplay).toBeUndefined()
    expect(validateRunEvidence(result.report.runEvidence)).toContain(
      'coverage for every repetition required'
    )
  })

  it('refuses --role, missing identity, and --max-replay-events before any I/O', async () => {
    const required = [`--cell=${CELL}`, '--build-id=test-build']
    await expect(
      runT2BaselineCli([
        '--workload=dual_run',
        '--dry-run',
        '--paired-runs',
        ...required,
        '--role=light-beside'
      ])
    ).rejects.toThrow(/--role/)
    await expect(
      runT2BaselineCli([
        '--workload=dual_run',
        '--dry-run',
        '--paired-runs',
        '--build-id=test-build'
      ])
    ).rejects.toThrow(/--cell/)
    await expect(
      runT2BaselineCli(['--workload=dual_run', '--dry-run', '--paired-runs', `--cell=${CELL}`])
    ).rejects.toThrow(/--build-id/)
    await expect(
      runT2BaselineCli([
        '--workload=dual_run',
        '--dry-run',
        '--paired-runs',
        ...required,
        '--max-replay-events=10'
      ])
    ).rejects.toThrow(/--max-replay-events/)
  })
})
