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
    // Path strings alone are insufficient (T1b): no fsAdapter / digests → refuse
    const pathOnly = evaluatePerfGates({ report, claimMetricsCollected: true })
    expect(pathOnly.ok).toBe(false)
    expect(pathOnly.errors.some((e) => /digest|stat|fs adapter/i.test(e))).toBe(true)

    const digests = {
      mainCpuSha256: 'm'.repeat(64),
      mainCpuBytes: 1024,
      rendererCpuSha256: 'r'.repeat(64),
      rendererCpuBytes: 2048,
      heapSha256: ['h'.repeat(64)],
      heapBytes: [4096]
    }
    report.metrics.profiles.digests = digests
    const baseline = JSON.parse(JSON.stringify(report))
    baseline.fixture = { fingerprint: 'b'.repeat(64) }
    const mismatch = evaluatePerfGates({ report, baselineReport: baseline })
    expect(mismatch.ok).toBe(false)
    expect(mismatch.errors.some((e) => /fingerprint/i.test(e))).toBe(true)

    baseline.fixture.fingerprint = report.fixture.fingerprint
    // Non-authoritative before/after must refuse when a baseline is supplied
    const nonAuth = evaluatePerfGates({
      report,
      baselineReport: baseline,
      claimMetricsCollected: true
    })
    expect(nonAuth.ok).toBe(false)
    expect(nonAuth.errors.some((e) => /authoritativeBaseline/i.test(e))).toBe(true)

    report.environment.authoritativeBaseline = true
    baseline.environment.authoritativeBaseline = true
    const ok = evaluatePerfGates({ report, baselineReport: baseline, claimMetricsCollected: true })
    expect(ok.ok).toBe(true)
    expect(ok.gates.evaluated).toBe(true)
    expect(ok.gates.gCorrect).toBe(false)
    expect(ok.gates.gCap).toBe(false)
    expect(ok.gates.gPerf).toBe(false)
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

describe('T1b numeric gPerf + profile digests', () => {
  const {
    validateProfileEvidenceArtifacts,
    evaluateNumericPerfGates,
    PERF_GATE_THRESHOLDS,
    CAPABILITY_BOOL_KEYS: CAP_KEYS,
    CORRECTNESS_BOOL_KEYS: CORR_KEYS
  } = require('./schema.cjs')

  function fillCorrectCaps(metrics) {
    for (const k of CORR_KEYS) metrics.correctness[k] = true
    metrics.correctness.dupCount = 0
    metrics.correctness.missingCount = 0
    metrics.correctness.durableAckClassMismatchCount = 0
    for (const k of CAP_KEYS) metrics.capabilities[k] = true
  }

  function authEnv(overrides = {}) {
    return baseEnv({ authoritativeBaseline: true, ...overrides })
  }

  function profileDigests() {
    return {
      mainCpuProfilePath: '/virtual/main.cpuprofile',
      rendererCpuProfilePath: '/virtual/renderer.cpuprofile',
      heapSnapshotPaths: ['/virtual/heap.heapsnapshot'],
      digests: {
        mainCpuSha256: 'aa'.repeat(32),
        mainCpuBytes: 1024,
        rendererCpuSha256: 'bb'.repeat(32),
        rendererCpuBytes: 2048,
        heapSha256: ['cc'.repeat(32)],
        heapBytes: [4096]
      }
    }
  }

  it('stats + hashes profile artifacts via fs adapter (rejects tiny files)', () => {
    const files = new Map()
    files.set('/tmp/main.cpuprofile', Buffer.alloc(512, 1))
    files.set('/tmp/renderer.cpuprofile', Buffer.alloc(512, 2))
    files.set('/tmp/heap.heapsnapshot', Buffer.alloc(512, 3))
    files.set('/tmp/tiny.cpuprofile', Buffer.alloc(8, 9))

    const fsAdapter = {
      statSync: (p) => {
        if (!files.has(p)) throw new Error('missing')
        return { size: files.get(p).length }
      },
      readFileSync: (p) => {
        if (!files.has(p)) throw new Error('missing')
        return files.get(p)
      }
    }

    const ok = validateProfileEvidenceArtifacts(
      {
        mainCpuProfilePath: '/tmp/main.cpuprofile',
        rendererCpuProfilePath: '/tmp/renderer.cpuprofile',
        heapSnapshotPaths: ['/tmp/heap.heapsnapshot']
      },
      fsAdapter
    )
    expect(ok.ok).toBe(true)
    expect(ok.digests.mainCpuBytes).toBe(512)
    expect(ok.digests.mainCpuSha256).toMatch(/^[a-f0-9]{64}$/)

    const tiny = validateProfileEvidenceArtifacts(
      {
        mainCpuProfilePath: '/tmp/tiny.cpuprofile',
        rendererCpuProfilePath: '/tmp/renderer.cpuprofile',
        heapSnapshotPaths: ['/tmp/heap.heapsnapshot']
      },
      fsAdapter
    )
    expect(tiny.ok).toBe(false)
    expect(tiny.errors.some((e) => /too small/i.test(e))).toBe(true)
  })

  it('evaluates numeric thresholds and refuses unsupported stringify invention', () => {
    const before = createEmptyPerfMetrics()
    const after = createEmptyPerfMetrics()
    fillCorrectCaps(after)

    before.main.saveChat.writeBytes.total = 100_000_000
    before.main.checkpointWriteBytes.total = 20_000_000
    before.main.indexWriteBytes.total = 7_000_000
    before.main.cpuTimeMs = 30_000
    before.renderer.cpuTimeMs = 60_000
    before.renderer.rssBytes = { p95: 4.4 * 1024 * 1024 * 1024, max: 4.5 * 1024 * 1024 * 1024 }
    before.renderer.jsHeapUsedBytes = { p95: 2e9, max: 2.1e9 }

    after.main.saveChat.writeBytes.total = 1_000_000
    after.main.checkpointWriteBytes.total = 500_000
    after.main.indexWriteBytes.total = 100_000
    after.main.cpuTimeMs = 5_000
    after.renderer.cpuTimeMs = 10_000
    after.main.persistenceSyncOver16msCount = 0
    after.main.eventLoopLagMs = { p50: 5, p95: 20, p99: 22, max: 24 }
    after.renderer.inputToPaintMs = { p95: 80 }
    after.renderer.rssBytes = { p95: 1.2 * 1024 * 1024 * 1024, max: 1.3 * 1024 * 1024 * 1024 }
    after.renderer.jsHeapUsedBytes = { p95: 800_000_000, max: 900_000_000 }
    after.renderer.soakGrowthFraction = 0.05
    after.gpu.occludedUtilPctP95 = 15
    after.main.spawnReap.zombieOver500msCount = 0
    after.main.saveChat.stringifyMsUnsupported = true

    const beforeReport = createPerfReport(authEnv())
    beforeReport.metrics = before
    beforeReport.fixture = { fingerprint: 'f'.repeat(64) }
    const afterReport = createPerfReport(authEnv())
    afterReport.metrics = after
    afterReport.fixture = { fingerprint: 'f'.repeat(64) }

    const unsupported = evaluateNumericPerfGates(afterReport, beforeReport)
    expect(unsupported.gPerf).toBe(false)
    expect(unsupported.refuseReasons.some((r) => /stringifyMsUnsupported/i.test(r))).toBe(true)

    after.main.saveChat.stringifyMsUnsupported = false
    after.main.saveChat.stringifyMs = { p50: 2, p95: 4 }
    const pass = evaluateNumericPerfGates(afterReport, beforeReport)
    expect(pass.gPerf).toBe(true)
    expect(pass.details.hotWriteByteReduction).toBeGreaterThanOrEqual(
      PERF_GATE_THRESHOLDS.minHotWriteByteReduction
    )
    expect(pass.details.combinedCpuSpeedup).toBeGreaterThanOrEqual(
      PERF_GATE_THRESHOLDS.minCombinedCpuSpeedup
    )
  })
})

describe('T1b 60-minute hydrate/demote schedule', () => {
  const {
    buildSixtyMinuteChatSwitchSchedule,
    summarizeSixtyMinuteSchedule,
    SCHEDULE_VERSION,
    DURATION_MS,
    CHAT_COUNT
  } = require('./sixtyMinuteSchedule.cjs')
  const { fixtureFingerprint, generatePerfFixture } = require('./fixtureGenerator.cjs')

  it('emits literal 60-minute select/hydrate/dwell/tick/demote events for 50 chats', () => {
    const schedule = buildSixtyMinuteChatSwitchSchedule({ seed: 42 })
    expect(schedule.scheduleVersion).toBe(SCHEDULE_VERSION)
    expect(schedule.durationMs).toBe(DURATION_MS)
    expect(schedule.chatCount).toBe(CHAT_COUNT)
    const summary = summarizeSixtyMinuteSchedule(schedule)
    expect(summary.hasSelect).toBe(true)
    expect(summary.hasHydrate).toBe(true)
    expect(summary.hasDemote).toBe(true)
    expect(summary.hasDwell).toBe(true)
    expect(summary.hasWallClockTick).toBe(true)
    expect(summary.kindCounts.select_chat).toBe(50)
    expect(summary.kindCounts.hydrate_chat).toBe(50)
    expect(summary.kindCounts.demote_candidate).toBe(50)
    expect(
      schedule.events.some((e) => e.kind === 'demote_candidate' && e.expectDemoteNoOpOnBaseline)
    ).toBe(true)
  })

  it('does not alter T1a fixture fingerprints for existing workloads', () => {
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
    // 60m schedule is a separate module; attaching it must not be required for fingerprint
    expect(a.replaySchedule.some((e) => e.kind === 'select_chat')).toBe(false)
  })
})

describe('T1b collectors (DI adapters, no attach)', () => {
  const {
    collectRendererCpuProfile,
    collectRendererHeapSnapshot,
    collectRendererPerformanceMetrics,
    startRendererTracing,
    collectMainCpuProfile,
    collectMainHeapSnapshot,
    sampleMainMemory,
    sampleProcessCpuRss,
    sampleZombieChildren,
    sampleGpuUtil,
    sampleOsBundle,
    ingestPerfUiEvents,
    summarizeIngestedUiEvents,
    ingestPerfProbeJsonl
  } = require('./collectors/index.cjs')

  it('drives CDP renderer collectors through a fake session', async () => {
    const calls = []
    const session = {
      send: async (method, params) => {
        calls.push({ method, params })
        if (method === 'Profiler.stop') return { profile: { nodes: [{ id: 1 }] } }
        if (method === 'HeapProfiler.takeHeapSnapshot') return { snapshot: 'HEAPDATA'.repeat(40) }
        if (method === 'Performance.getMetrics') {
          return { metrics: [{ name: 'JSHeapUsedSize', value: 12345 }] }
        }
        if (method === 'Tracing.end') return { ok: true }
        return {}
      }
    }
    const started = await collectRendererCpuProfile(session)
    const stopped = await started.stop()
    expect(stopped.profile.nodes).toHaveLength(1)
    const heap = await collectRendererHeapSnapshot(session)
    expect(heap.bytes).toBeGreaterThan(0)
    const perf = await collectRendererPerformanceMetrics(session)
    expect(perf.jsHeapUsedSize).toBe(12345)
    const tracing = await startRendererTracing(session)
    await tracing.stop()
    expect(calls.some((c) => c.method === 'Profiler.start')).toBe(true)
    expect(calls.some((c) => c.method === 'Tracing.start')).toBe(true)
  })

  it('drives main inspector + v8 heap adapters', async () => {
    const posts = []
    const session = {
      connect() {},
      disconnect() {},
      post: async (method, params) => {
        posts.push({ method, params })
        if (method === 'Profiler.stop') return { profile: { timeDeltas: [1, 2] } }
        return {}
      }
    }
    const started = await collectMainCpuProfile(session)
    const stopped = await started.stop()
    expect(stopped.profile.timeDeltas).toEqual([1, 2])
    const heap = collectMainHeapSnapshot({
      v8: { writeHeapSnapshot: () => '/tmp/main.heapsnapshot' },
      fs: { readFileSync: () => Buffer.alloc(300, 7) }
    })
    expect(heap.path).toBe('/tmp/main.heapsnapshot')
    expect(heap.bytes).toBe(300)
    const mem = sampleMainMemory({
      memoryUsage: () => ({ rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 })
    })
    expect(mem.heapUsed).toBe(3)
    expect(posts.some((p) => p.method === 'Profiler.start')).toBe(true)
  })

  it('samples OS CPU/RSS/GPU/zombies via adapters', () => {
    const adapters = {
      getAppMetrics: () => [
        { pid: 1, type: 'Browser', cpu: 40, memory: { workingSetSize: 1000 } },
        { pid: 2, type: 'Tab', cpu: 80, memory: { workingSetSize: 2000 } },
        { pid: 3, type: 'GPU', cpu: 10, memory: { workingSetSize: 100 } }
      ],
      listZombies: () => [
        { pid: 9, ppid: 1, state: 'Z', elapsedMs: 800 },
        { pid: 10, ppid: 1, state: 'Z', elapsedMs: 100 }
      ],
      sampleGpuUtilPct: () => 18,
      nowMs: () => 123
    }
    const cpu = sampleProcessCpuRss(adapters)
    expect(cpu.mainCpuPct).toBe(40)
    expect(cpu.rendererCpuPct).toBe(80)
    const z = sampleZombieChildren(adapters)
    expect(z.zombieOver500msCount).toBe(1)
    expect(sampleGpuUtil(adapters).utilPct).toBe(18)
    const bundle = sampleOsBundle(adapters, { occluded: true })
    expect(bundle.occludedGpuUtilPct).toBe(18)
    expect(bundle.sampledAtMs).toBe(123)
  })

  it('ingests ACK/input/React/long-task events and probe JSONL', () => {
    const ingested = ingestPerfUiEvents([
      { kind: 'ipc_ack', lagMs: 10 },
      { kind: 'ipc_ack', lagMs: 40, rejected: true },
      { kind: 'input_to_paint', durationMs: 50 },
      { kind: 'react_commit', durationMs: 12 },
      { kind: 'long_task', durationMs: 60, name: 'self' },
      { kind: 'event_loop_lag', lagMs: 8 }
    ])
    const summary = summarizeIngestedUiEvents(ingested)
    expect(summary.ipc.rejectCount).toBe(1)
    expect(summary.renderer.inputToPaintMs.p95).toBe(50)
    expect(summary.main.eventLoopLagMs.p95).toBe(8)

    const probe = ingestPerfProbeJsonl(
      [
        JSON.stringify({ kind: 'write', bytes: 1000, durationMs: 5 }),
        JSON.stringify({ kind: 'fsync', bytes: 0, durationMs: 20 }),
        JSON.stringify({ kind: 'stringify_unsupported' })
      ].join('\n')
    )
    expect(probe.writeBytesTotal).toBe(1000)
    expect(probe.persistenceSyncOver16msCount).toBe(1)
    expect(probe.stringifyMsUnsupported).toBe(true)
  })
})

describe('T1b preload probe (disabled by default)', () => {
  const {
    isPreloadProbeEnabled,
    createPreloadProbe,
    DEFAULT_ENABLED
  } = require('./preloadProbe.cjs')

  it('stays off unless PERF_PRELOAD_PROBE is set', () => {
    expect(DEFAULT_ENABLED).toBe(false)
    expect(isPreloadProbeEnabled({})).toBe(false)
    expect(isPreloadProbeEnabled({ PERF_PRELOAD_PROBE: '1' })).toBe(true)

    const lines = []
    const off = createPreloadProbe({
      writeLine: (l) => lines.push(l),
      enabled: false,
      nowMs: () => 1
    })
    off.emit('write', { bytes: 10 })
    expect(lines).toHaveLength(0)

    const on = createPreloadProbe({
      writeLine: (l) => lines.push(l),
      enabled: true,
      nowMs: () => 10
    })
    const wrapped = on.wrapSyncFsOp((file, data) => `ok:${file}:${data.length}`, 'write')
    expect(wrapped('/tmp/x', 'hello')).toBe('ok:/tmp/x:5')
    expect(lines.length).toBe(1)
    const row = JSON.parse(lines[0])
    expect(row.kind).toBe('write')
    expect(row.bytes).toBe(5)

    const unsupported = on.wrapStringifyOrMarkUnsupported(null)
    expect(unsupported.supported).toBe(false)
    expect(lines.some((l) => l.includes('stringify_unsupported'))).toBe(true)
  })
})
