import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  SCHEMA_VERSION,
  WORKLOADS,
  FX_POSTURES,
  validatePerfEnvironment,
  validatePerfMetrics,
  createEmptyPerfMetrics,
  createPerfReport,
  evaluatePerfGates,
  profilesEvidenceComplete,
  CAPABILITY_BOOL_KEYS
} = require('./schema.cjs')
const {
  generatePerfFixture,
  fixtureFingerprint,
  resolveWorkloadShape,
  OBSERVED_30SEAT,
  OBSERVED_50SEAT
} = require('./fixtureGenerator.cjs')
const {
  materializePerfUserData,
  assertIsolatedUserDataDir,
  LEGACY_CHECKPOINT_TOTAL,
  LEGACY_CHECKPOINT_SUPERSEDED
} = require('./materializeUserData.cjs')
const { buildIsolatedLaunchPlan } = require('./isolatedLaunch.cjs')
const { runBaselineCli } = require('./runBaseline.cjs')
const { dirtyTreeFingerprint, collectRepoProvenance } = require('./repoProvenance.cjs')

function baseEnv(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    gitSha: 'abc',
    appVersion: '1.9.2',
    instanceId: 'perf-test',
    userDataDir: '/tmp/taskwraith-perf-test',
    remoteDebuggingPort: 9411,
    iosRemote: false,
    fxPosture: 'cinematic_default',
    workload: '30seat',
    seed: 42,
    startedAt: '2026-08-03T12:00:00.000Z',
    authoritativeBaseline: false,
    repoProvenance: {
      gitSha: 'abc',
      dirty: true,
      dirtyTreeFingerprint: dirtyTreeFingerprint(['scripts/perf/schema.cjs']),
      dirtyPaths: ['scripts/perf/schema.cjs'],
      isolatedWorktree: false
    },
    ...overrides
  }
}

describe('perf schema (ADR §7 hardened)', () => {
  it('exports workloads, reduce_motion posture, and schema version', () => {
    expect(SCHEMA_VERSION).toBe(1)
    expect(WORKLOADS).toEqual(
      expect.arrayContaining(['30seat', '50seat', 'dual_run', '455_soak', '50_chat_switch'])
    )
    expect(FX_POSTURES).toContain('reduce_motion')
  })

  it('accepts a complete empty metrics report with G-correct / G-cap fields', () => {
    const env = baseEnv()
    expect(validatePerfEnvironment(env).ok).toBe(true)
    const metrics = createEmptyPerfMetrics()
    expect(validatePerfMetrics(metrics).ok).toBe(true)
    expect(metrics.correctness.approvalsLedgerOk).toBe(false)
    expect(metrics.correctness.historyDeletionOk).toBe(false)
    expect(metrics.correctness.crashBarrierRecoveredOk).toBe(false)
    expect(metrics.correctness.durableAckClassMismatchCount).toBe(0)
    for (const key of CAPABILITY_BOOL_KEYS) {
      expect(metrics.capabilities[key]).toBe(false)
    }
    const report = createPerfReport(env)
    expect(report.metrics.renderer.hydratedFullChatCount).toBe(0)
  })

  it('rejects iosRemote true and missing repoProvenance', () => {
    const badRemote = validatePerfEnvironment(baseEnv({ iosRemote: true }))
    expect(badRemote.ok).toBe(false)
    expect(badRemote.errors.some((e) => e.includes('iosRemote'))).toBe(true)

    const { repoProvenance, ...rest } = baseEnv()
    void repoProvenance
    const badProv = validatePerfEnvironment(rest)
    expect(badProv.ok).toBe(false)
  })

  it('refuses gate / metricsCollected claims without profiles + matching fingerprints', () => {
    const env = baseEnv()
    const report = createPerfReport(env)
    report.fixture = { fingerprint: 'a'.repeat(64) }
    expect(profilesEvidenceComplete(report.metrics.profiles)).toBe(false)

    const refused = evaluatePerfGates({ report, claimMetricsCollected: true })
    expect(refused.ok).toBe(false)
    expect(refused.gates.metricsCollectedAllowed).toBe(false)
    expect(refused.errors.some((e) => /profile/i.test(e))).toBe(true)

    report.metrics.profiles = {
      mainCpuProfilePath: '/tmp/main.cpuprofile',
      rendererCpuProfilePath: '/tmp/renderer.cpuprofile',
      heapSnapshotPaths: ['/tmp/heap.heapsnapshot']
    }
    const baseline = JSON.parse(JSON.stringify(report))
    baseline.fixture = { fingerprint: 'b'.repeat(64) }
    const mismatch = evaluatePerfGates({ report, baselineReport: baseline })
    expect(mismatch.ok).toBe(false)
    expect(mismatch.errors.some((e) => /fingerprint/i.test(e))).toBe(true)

    baseline.fixture.fingerprint = report.fixture.fingerprint
    const ok = evaluatePerfGates({ report, baselineReport: baseline, claimMetricsCollected: true })
    expect(ok.ok).toBe(true)
    expect(ok.gates.evaluated).toBe(true)
    expect(ok.gates.gCorrect).toBe(false)
    expect(ok.gates.gCap).toBe(false)
  })
})

describe('perf fixture generator (scaled)', () => {
  it('shapes 30seat / 50seat toward mission targets', () => {
    const s30 = resolveWorkloadShape({ workload: '30seat' })
    expect(s30.seatCount).toBe(30)
    expect(s30.dualConcurrentRuns).toBe(true)
    expect(1 + s30.turnsPerSeat * s30.seatCount).toBeGreaterThanOrEqual(
      OBSERVED_30SEAT.messageTarget
    )
    expect(s30.turnsPerSeat * s30.seatCount * s30.toolsPerAssistant).toBeGreaterThanOrEqual(
      OBSERVED_30SEAT.toolActivityTarget
    )

    const s50 = resolveWorkloadShape({ workload: '50seat' })
    expect(s50.seatCount).toBe(50)
    expect(1 + s50.turnsPerSeat * s50.seatCount).toBeGreaterThanOrEqual(
      OBSERVED_50SEAT.messageTarget
    )
    expect(s50.turnsPerSeat * s50.seatCount * s50.toolsPerAssistant).toBeGreaterThanOrEqual(
      OBSERVED_50SEAT.toolActivityTarget
    )
  })

  it('is deterministic for the same seed/workload', () => {
    const a = generatePerfFixture({
      workload: 'dual_run',
      seed: 42,
      baseTimestamp: 1_700_000_000_000,
      lean: true,
      scaleDown: 4
    })
    const b = generatePerfFixture({
      workload: 'dual_run',
      seed: 42,
      baseTimestamp: 1_700_000_000_000,
      lean: true,
      scaleDown: 4
    })
    expect(fixtureFingerprint(a)).toBe(fixtureFingerprint(b))
    expect(a.totals).toEqual(b.totals)
    expect(a.replaySchedule.length).toBe(b.replaySchedule.length)
  })

  it('455_soak is a literal soak-turn schedule (not system hop markers)', () => {
    const soak = generatePerfFixture({
      workload: '455_soak',
      seed: 1,
      baseTimestamp: 1_700_000_000_000,
      lean: true
    })
    expect(soak.shape.soakTurns).toBe(455)
    expect(soak.totals.messageCount).toBe(1 + 455)
    expect(soak.totals.toolActivityCount).toBe(455 * soak.shape.toolsPerAssistant)
    expect(soak.chats[0].runs.filter((r) => r.status === 'running')).toHaveLength(2)
    const soakMsgs = soak.chats[0].messages.filter(
      (m) => m.metadata && m.metadata.kind === 'perfSoakTurn'
    )
    expect(soakMsgs).toHaveLength(455)
    expect(soakMsgs.every((m) => m.role === 'assistant')).toBe(true)
    expect(
      soak.chats[0].messages.some((m) => m.metadata && m.metadata.kind === 'perfSoakHop')
    ).toBe(false)
    expect(
      soak.replaySchedule.some((e) => e.kind === 'append_assistant' && e.soakTurn === 455)
    ).toBe(true)
  })

  it('dual_run preserves two simultaneous running tasks', () => {
    const dual = generatePerfFixture({
      workload: 'dual_run',
      seed: 7,
      baseTimestamp: 1_700_000_000_000,
      lean: true,
      scaleDown: 5
    })
    expect(dual.chats).toHaveLength(2)
    for (const chat of dual.chats) {
      expect(chat.runs.filter((r) => r.status === 'running').length).toBeGreaterThanOrEqual(2)
    }
  })

  it('full-scale 30seat meets count + approximate serialized-size targets', () => {
    const fixture = generatePerfFixture({
      workload: '30seat',
      seed: 42,
      baseTimestamp: 1_700_000_000_000,
      lean: false
    })
    expect(fixture.totals.messageCount).toBeGreaterThanOrEqual(OBSERVED_30SEAT.messageTarget)
    expect(fixture.totals.toolActivityCount).toBeGreaterThanOrEqual(
      OBSERVED_30SEAT.toolActivityTarget
    )
    expect(fixture.chats[0].runs.filter((r) => r.status === 'running')).toHaveLength(2)
    // Allow ±35% band around observed tool mass — derivation is approximate.
    const toolTarget = OBSERVED_30SEAT.toolSerializedTargetBytes
    expect(fixture.totals.toolSerializedBytes).toBeGreaterThan(toolTarget * 0.65)
    expect(fixture.totals.toolSerializedBytes).toBeLessThan(toolTarget * 1.55)
    expect(fixture.totals.chatSerializedBytes).toBeGreaterThan(
      OBSERVED_30SEAT.chatSerializedTargetBytes * 0.55
    )
    expect(fixture.replaySchedule.length).toBeGreaterThan(fixture.totals.messageCount)
  }, 120_000)

  it('full-scale 50seat meets row/tool count floors', () => {
    const fixture = generatePerfFixture({
      workload: '50seat',
      seed: 42,
      baseTimestamp: 1_700_000_000_000,
      lean: true // counts only; size band covered by 30seat
    })
    expect(fixture.totals.messageCount).toBeGreaterThanOrEqual(OBSERVED_50SEAT.messageTarget)
    expect(fixture.totals.toolActivityCount).toBeGreaterThanOrEqual(
      OBSERVED_50SEAT.toolActivityTarget
    )
    expect(fixture.chats[0].runs.filter((r) => r.status === 'running')).toHaveLength(2)
  }, 120_000)
})

describe('perf userData materializer', () => {
  it('refuses live TaskWraith userData roots', () => {
    const live = path.join(
      process.env.HOME || tmpdir(),
      'Library',
      'Application Support',
      'TaskWraith'
    )
    expect(() => assertIsolatedUserDataDir(live)).toThrow(/live userData/i)
  })

  it('legacy_v1 writes fat index + 508/493 checkpoints + replay schedule', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tw-perf-mat-'))
    try {
      const result = materializePerfUserData({
        workload: 'dual_run',
        seed: 42,
        userDataDir: dir,
        mode: 'legacy_v1',
        lean: true,
        scaleDown: 8
      })
      expect(existsSync(path.join(dir, 'chats', 'perf-dual_run-chat-01.json'))).toBe(true)
      expect(existsSync(result.checkpointPath)).toBe(true)
      expect(existsSync(result.replayPath)).toBe(true)
      const index = JSON.parse(readFileSync(result.indexPath, 'utf8'))
      expect(index[0].summaryOnly).toBe(false)
      expect(Array.isArray(index[0].messages)).toBe(true)
      expect(index[0].messages.length).toBeGreaterThan(0)
      const ckpt = JSON.parse(readFileSync(result.checkpointPath, 'utf8'))
      expect(ckpt.total).toBe(LEGACY_CHECKPOINT_TOTAL)
      expect(ckpt.supersededCount).toBe(LEGACY_CHECKPOINT_SUPERSEDED)
      const replay = JSON.parse(readFileSync(result.replayPath, 'utf8'))
      expect(replay.eventCount).toBeGreaterThan(10)
      expect(result.manifest.mode).toBe('legacy_v1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('future_v2 writes minimal index + hot checkpoint stubs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tw-perf-v2-'))
    try {
      const result = materializePerfUserData({
        workload: '30seat',
        seed: 3,
        userDataDir: dir,
        mode: 'future_v2',
        lean: true,
        scaleDown: 50
      })
      const index = JSON.parse(readFileSync(result.indexPath, 'utf8'))
      expect(index[0].summaryOnly).toBe(true)
      expect(index[0].messages).toEqual([])
      const ckpt = JSON.parse(readFileSync(result.checkpointPath, 'utf8'))
      expect(ckpt.kind).toBe('taskwraith-perf-future-v2-checkpoints')
      expect(ckpt.hotRecords.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('isolated launch plan', () => {
  it('forces IOS remote off, accepts reduce_motion, refuses verify id', () => {
    expect(() => buildIsolatedLaunchPlan({ instanceId: 'verify' })).toThrow(/verify/)
    const plan = buildIsolatedLaunchPlan({
      instanceId: 'perf-30seat-baseline',
      workload: '30seat',
      fxPosture: 'reduce_motion'
    })
    expect(plan.env.IOS_REMOTE_TRUE).toBe('0')
    expect(plan.fxPosture).toBe('reduce_motion')
    expect(plan.safety.electronLaunchDisabledUntilT2).toBe(true)
  })
})

describe('runBaseline CLI dry-run', () => {
  it('produces a report skeleton with provenance and gates refuse', () => {
    const result = runBaselineCli(
      [
        '--workload=30seat',
        '--dry-run',
        '--seed=42',
        '--instance-id=perf-cli-dry',
        '--lean',
        '--scale-down=40',
        '--fx-posture=reduce_motion'
      ],
      {
        repoRoot: path.resolve(__dirname, '..', '..'),
        forceIsolated: false
      }
    )
    expect(result.ok).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(existsSync(result.reportPath)).toBe(true)
    const report = JSON.parse(readFileSync(result.reportPath, 'utf8'))
    expect(report.environment.iosRemote).toBe(false)
    expect(report.environment.authoritativeBaseline).toBe(false)
    expect(report.environment.repoProvenance.dirtyTreeFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(report.status.metricsCollected).toBe(false)
    expect(report.gates.evaluated).toBe(false)
    expect(report.environment.fxPosture).toBe('reduce_motion')
  })

  it('refuses --launch until T2 unlock', () => {
    expect(() =>
      runBaselineCli(['--workload=30seat', '--dry-run', '--launch', '--lean', '--scale-down=40'], {
        repoRoot: path.resolve(__dirname, '..', '..')
      })
    ).toThrow(/T2/)
  })
})

describe('repo provenance', () => {
  it('fingerprints dirty path sets stably', () => {
    expect(dirtyTreeFingerprint(['a', 'b'])).toBe(dirtyTreeFingerprint(['a', 'b']))
    expect(dirtyTreeFingerprint(['a'])).not.toBe(dirtyTreeFingerprint(['b']))
    const prov = collectRepoProvenance({
      repoRoot: path.resolve(__dirname, '..', '..'),
      forceIsolated: false
    })
    expect(prov.gitSha).toMatch(/^[a-f0-9]+$/)
    expect(typeof prov.dirty).toBe('boolean')
    expect(prov.authoritativeBaseline).toBe(false)
  })
})
