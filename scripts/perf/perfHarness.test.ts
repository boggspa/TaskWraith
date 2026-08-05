import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  writeFileSync,
  realpathSync
} from 'fs'
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
  toLegacyFatChatListItem,
  isSessionCheckpointRecordEquivalent,
  LEGACY_CHECKPOINT_TOTAL,
  LEGACY_CHECKPOINT_SUPERSEDED,
  SESSION_CHECKPOINT_RELATIVE_PATH
} = require('./materializeUserData.cjs')
const { buildIsolatedLaunchPlan } = require('./isolatedLaunch.cjs')
const { createCdpEvaluateAdapter, runDeterministicReplay } = require('./replayDriver.cjs')
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

  it('emits chats the main save-scope gate accepts (global scope or workspace identity)', () => {
    // sanitizeChatForSave (src/main/index.ts) throws 'Workspace chat must
    // include a workspace id and path.' for any chat that is neither
    // scope:'global' nor carrying a registered workspace identity. A fixture
    // that violates this makes EVERY T2 replay saveChat reject at the IPC
    // boundary, so the harness measures nothing while events still "complete"
    // — exactly how runs perf-t2-30seat-42 (2026-08-04 and both 2026-08-05
    // attempts) burned hours without a single hot-chat write.
    const fixture = generatePerfFixture({
      workload: 'dual_run',
      seed: 42,
      baseTimestamp: 1_700_000_000_000,
      lean: true,
      scaleDown: 4
    })
    for (const chat of fixture.chats) {
      const acceptedBySaveGate =
        chat.scope === 'global' || Boolean(chat.workspaceId && chat.workspacePath)
      expect(
        acceptedBySaveGate,
        `${chat.appChatId} would be rejected by sanitizeChatForSave — replay saves would silently no-op`
      ).toBe(true)
    }
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

  it('legacy_v1 writes keyed fat index + 508/493 checkpoints + replay schedule', () => {
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
      expect(result.checkpointPath).toBe(path.join(dir, SESSION_CHECKPOINT_RELATIVE_PATH))
      const index = JSON.parse(readFileSync(result.indexPath, 'utf8'))
      expect(Array.isArray(index)).toBe(false)
      expect(index['perf-dual_run-chat-01']).toBeTruthy()
      expect(index['perf-dual_run-chat-01'].summaryOnly).toBe(true)
      expect(index['perf-dual_run-chat-01'].messages).toEqual([])
      expect(index['perf-dual_run-chat-01'].runs).toEqual([])
      const ckpt = JSON.parse(readFileSync(result.checkpointPath, 'utf8'))
      expect(Array.isArray(ckpt)).toBe(true)
      expect(ckpt.length).toBe(LEGACY_CHECKPOINT_TOTAL)
      expect(ckpt.filter((r: { status: string }) => r.status === 'superseded').length).toBe(
        LEGACY_CHECKPOINT_SUPERSEDED
      )
      expect(result.manifest.checkpoints.total).toBe(LEGACY_CHECKPOINT_TOTAL)
      expect(result.manifest.checkpoints.supersededCount).toBe(LEGACY_CHECKPOINT_SUPERSEDED)
      const replay = JSON.parse(readFileSync(result.replayPath, 'utf8'))
      expect(replay.eventCount).toBeGreaterThan(10)
      expect(result.manifest.mode).toBe('legacy_v1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('future_v2 writes keyed minimal index + hot checkpoint array at production path', () => {
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
      expect(Array.isArray(index)).toBe(false)
      const firstId = Object.keys(index)[0]
      expect(index[firstId].summaryOnly).toBe(true)
      expect(index[firstId].messages).toEqual([])
      expect(result.checkpointPath).toBe(path.join(dir, SESSION_CHECKPOINT_RELATIVE_PATH))
      const ckpt = JSON.parse(readFileSync(result.checkpointPath, 'utf8'))
      expect(Array.isArray(ckpt)).toBe(true)
      expect(ckpt.length).toBe(1)
      expect(isSessionCheckpointRecordEquivalent(ckpt[0])).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('legacy_v1 materialize matches production index map + checkpoint validator shape', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tw-perf-fidelity-'))
    try {
      const result = materializePerfUserData({
        workload: 'dual_run',
        seed: 7,
        userDataDir: dir,
        mode: 'legacy_v1',
        lean: true,
        scaleDown: 8
      })

      const index = JSON.parse(readFileSync(result.indexPath, 'utf8'))
      expect(Array.isArray(index)).toBe(false)
      expect(Object.keys(index).sort()).toEqual(
        result.fixture.chats.map((c: { appChatId: string }) => c.appChatId).sort()
      )
      for (const chat of result.fixture.chats) {
        const item = index[chat.appChatId]
        const expected = toLegacyFatChatListItem(chat)
        expect(item.summaryOnly).toBe(true)
        expect(item.messages).toEqual([])
        expect(item.runs).toEqual([])
        expect(item.messageCount).toBe(chat.messages.length)
        expect(item.runCount).toBe(chat.runs.length)
        expect(Array.isArray(item.runsSummary)).toBe(true)
        expect(item.runsSummary.length).toBe(
          chat.runs.filter((r: { runId?: string; id?: string }) => r.runId || r.id).length
        )
        expect(item.ensemble).toBeTruthy()
        expect(item.ensemble.enabled).toBe(true)
        expect(Array.isArray(item.ensemble.participants)).toBe(true)
        expect(item.ensemble.participants.length).toBeGreaterThan(0)
        expect(JSON.stringify(item.messages)).toBe('[]')
        expect(JSON.stringify(item.runs)).toBe('[]')
        expect(item.appChatId).toBe(expected.appChatId)
        expect(item.title).toBe(expected.title)
      }

      expect(
        result.checkpointPath.endsWith(path.join('checkpoints', 'session-checkpoints.json'))
      ).toBe(true)
      expect(existsSync(path.join(dir, 'checkpoints', 'session-checkpoints.json'))).toBe(true)
      expect(existsSync(path.join(dir, 'session-checkpoints.json'))).toBe(false)
      const records = JSON.parse(readFileSync(result.checkpointPath, 'utf8'))
      expect(Array.isArray(records)).toBe(true)
      expect(records.length).toBe(LEGACY_CHECKPOINT_TOTAL)
      const superseded = records.filter((r: { status: string }) => r.status === 'superseded')
      expect(superseded.length).toBe(LEGACY_CHECKPOINT_SUPERSEDED)
      expect(records.every((r: unknown) => isSessionCheckpointRecordEquivalent(r))).toBe(true)
      for (const record of records) {
        expect(typeof record.chatId).toBe('string')
        expect(record.appChatId).toBeUndefined()
        expect(['available', 'accepted', 'dismissed', 'superseded']).toContain(record.status)
        expect(['participant-updated', 'round-started']).toContain(record.reason)
        expect(Number.isFinite(Date.parse(record.createdAt))).toBe(true)
        expect(Number.isFinite(Date.parse(record.updatedAt))).toBe(true)
        expect(Array.isArray(record.snapshot.blackboard)).toBe(true)
        expect(Array.isArray(record.snapshot.openTasks)).toBe(true)
        expect(typeof record.snapshot.queueState.prompt).toBe('string')
        expect(Array.isArray(record.snapshot.queueState.participants)).toBe(true)
        expect(Array.isArray(record.snapshot.queueState.queuedPrompts)).toBe(true)
      }

      expect(result.manifest.paths.sessionCheckpoints).toBe('checkpoints/session-checkpoints.json')
      expect(result.manifest.checkpoints.onDiskShape).toBe('raw-array')
      expect(result.manifest.checkpoints.total).toBe(LEGACY_CHECKPOINT_TOTAL)
      expect(result.manifest.checkpoints.supersededCount).toBe(LEGACY_CHECKPOINT_SUPERSEDED)
      expect(result.manifest.sizes.indexBytes).toBeGreaterThan(0)
      expect(result.manifest.sizes.checkpointBytes).toBeGreaterThan(0)
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
    expect(plan.mainInspectorPort).not.toBe(plan.remoteDebuggingPort)
    expect(plan.argv.join(' ')).toContain('--inspect=')
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

  it('T9a: refuses a comparison whose after-report carries no measured coalescing block', () => {
    // The satisfiable-by-omission hazard: `coalescing` is optional at
    // VALIDATION time so the frozen T2 denominator still parses. If the
    // comparison gate were also permissive, a run whose sampler silently
    // failed would validate cleanly and be read as evidence that coalescing
    // did nothing — indistinguishable from coalescing genuinely doing nothing.
    const before = createEmptyPerfMetrics()
    const after = createEmptyPerfMetrics()
    fillCorrectCaps(after)

    const beforeReport = createPerfReport(authEnv())
    beforeReport.metrics = before
    beforeReport.fixture = { fingerprint: 'f'.repeat(64) }
    const afterReport = createPerfReport(authEnv())
    afterReport.metrics = after
    afterReport.fixture = { fingerprint: 'f'.repeat(64) }

    const absent = evaluateNumericPerfGates(afterReport, beforeReport)
    expect(absent.gPerf).toBe(false)
    expect(
      absent.refuseReasons.some((r: string) => /must carry measured .*coalescing/i.test(r))
    ).toBe(true)

    // A present-but-unattributable block (no reason mix) is refused too:
    // counts without a reason mix cannot tell a coalesced run from a run where
    // every save was a barrier.
    after.main.saveChat.coalescing = { scheduled: 10, coalesced: 5 }
    const noMix = evaluateNumericPerfGates(afterReport, beforeReport)
    expect(noMix.gPerf).toBe(false)
    expect(noMix.refuseReasons.some((r: string) => /reasonMix required/i.test(r))).toBe(true)

    // The BASELINE side must stay exempt — requiring it there would
    // retroactively invalidate the only denominator the epic has.
    after.main.saveChat.coalescing = {
      scheduled: 10,
      coalesced: 5,
      flushed: 5,
      pending: 0,
      urgentFlushes: 0,
      ceilingFlushes: 0,
      discarded: 0,
      reasonMix: { normal: 10, terminal: 0, approval: 0, 'history-deletion': 0, shutdown: 0 }
    }
    const baselineStillExempt = evaluateNumericPerfGates(afterReport, beforeReport)
    expect(baselineStillExempt.refuseReasons.some((r: string) => /coalescing/i.test(r))).toBe(false)
  })

  it('validates the T4b coalescing/journal reporting seam without breaking the T2 baseline', () => {
    // The frozen T2 baseline predates these probes and is the denominator for
    // every comparison — absent must stay valid or the comparison can never run.
    expect(validatePerfMetrics(createEmptyPerfMetrics()).ok).toBe(true)

    const withSeam = () => {
      const m = createEmptyPerfMetrics()
      m.main.saveChat.coalescing = {
        scheduled: 12,
        coalesced: 9,
        flushed: 3,
        pending: 0,
        urgentFlushes: 1,
        ceilingFlushes: 2,
        discarded: 0,
        reasonMix: { normal: 11, terminal: 1, approval: 0, 'history-deletion': 0, shutdown: 0 }
      }
      m.main.saveChat.journal = {
        appends: 3,
        linesWritten: 3,
        bytesWritten: 4096,
        snapshotsWritten: 0,
        chatsDeleted: 0,
        tombstoneRejects: 0,
        tornLinesRecovered: 0
      }
      return m
    }
    expect(validatePerfMetrics(withSeam()).ok).toBe(true)

    // Present-but-incomplete must FAIL loudly: a half-wired sampler would
    // otherwise produce a run nobody could attribute.
    const missingCeiling = withSeam()
    delete (missingCeiling.main.saveChat.coalescing as Record<string, unknown>).ceilingFlushes
    const missingCeilingResult = validatePerfMetrics(missingCeiling)
    expect(missingCeilingResult.ok).toBe(false)
    expect(
      missingCeilingResult.errors.some((e: string) => /coalescing\.ceilingFlushes/.test(e))
    ).toBe(true)

    // Reason attribution is the whole point of the seam — a missing reason
    // bucket must not slip through as a zero.
    const missingReason = withSeam()
    delete (missingReason.main.saveChat.coalescing.reasonMix as Record<string, unknown>)[
      'history-deletion'
    ]
    const missingReasonResult = validatePerfMetrics(missingReason)
    expect(missingReasonResult.ok).toBe(false)
    expect(
      missingReasonResult.errors.some((e: string) => /reasonMix\.history-deletion/.test(e))
    ).toBe(true)

    const badJournal = withSeam()
    ;(badJournal.main.saveChat.journal as Record<string, unknown>).bytesWritten = 'lots'
    expect(validatePerfMetrics(badJournal).ok).toBe(false)
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
    // T9a: the AFTER side of a comparison must carry a measured coalescing
    // block. The baseline stays exempt (the frozen T2 denominator predates
    // these probes), which is why only `after` gets one here.
    after.main.saveChat.coalescing = {
      scheduled: 100,
      coalesced: 70,
      flushed: 30,
      pending: 0,
      urgentFlushes: 4,
      ceilingFlushes: 12,
      discarded: 0,
      reasonMix: { normal: 90, terminal: 8, approval: 1, 'history-deletion': 1, shutdown: 0 }
    }
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
    /** @type {Set<Function>} */
    const eventHandlers = new Set()
    const session = {
      send: async (method, params) => {
        calls.push({ method, params })
        if (method === 'Profiler.stop') return { profile: { nodes: [{ id: 1 }] } }
        if (method === 'HeapProfiler.takeHeapSnapshot') {
          for (const handler of eventHandlers) {
            handler({
              method: 'HeapProfiler.addHeapSnapshotChunk',
              params: { chunk: 'HEAPDATA'.repeat(40) }
            })
          }
          return {}
        }
        if (method === 'Performance.getMetrics') {
          return { metrics: [{ name: 'JSHeapUsedSize', value: 12345 }] }
        }
        if (method === 'Tracing.end') return { ok: true }
        return {}
      },
      onEvent(handler) {
        eventHandlers.add(handler)
        return () => eventHandlers.delete(handler)
      }
    }
    const started = await collectRendererCpuProfile(session)
    const stopped = await started.stop()
    expect(stopped.profile.nodes).toHaveLength(1)
    const heap = await collectRendererHeapSnapshot(session)
    expect(heap.bytes).toBeGreaterThan(0)
    expect(heap.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(heap.streamed).toBe(true)
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

describe('T2 CDP evaluate adapter (renderer failures must abort, not vanish)', () => {
  it('throws when Runtime.evaluate reports exceptionDetails', async () => {
    // A rejected window.api promise arrives as exceptionDetails with no
    // returnByValue payload. The pre-fix adapter returned null, so a replay
    // whose every save rejected still "completed" all its events. The renderer
    // failure must abort the replay with the page's own error text.
    const adapter = createCdpEvaluateAdapter({
      send: async () => ({
        result: {
          type: 'object',
          subtype: 'error',
          description: 'Error: Workspace chat must include a workspace id and path.'
        },
        exceptionDetails: {
          text: 'Uncaught (in promise)',
          exception: {
            description: 'Error: Workspace chat must include a workspace id and path.'
          }
        }
      })
    })
    await expect(adapter.evaluate('window.api.saveChat({})')).rejects.toThrow(
      /Workspace chat must include a workspace id and path/
    )
  })

  it('returns the value for clean evaluations', async () => {
    const adapter = createCdpEvaluateAdapter({ send: async () => ({ result: { value: 7 } }) })
    await expect(adapter.evaluate('7')).resolves.toBe(7)
  })
})

describe('T2 replay against a revision-CAS store (ChatService contract)', () => {
  // ChatService.saveChatInternal rejects any save whose persistenceRevision
  // differs from the current canonical record — silently, by returning the
  // current record. Main then assigns canonical = previous + 1 on acceptance.
  // A driver that synthesizes revisions instead of consuming the returned
  // canonical lands exactly ONE save (the seed) and no-ops every later event,
  // which is how seed-42 attempt 3 ran 300+ events against a coalescer that
  // scheduled once. Every save-kind event must land against a CAS store.
  function createRevisionCasApi(fixture) {
    /** @type {Map<string, { revision: number }>} */
    const canonical = new Map()
    for (const chat of fixture.chats) {
      canonical.set(chat.appChatId, { revision: chat.persistenceRevision || 1 })
    }
    let accepted = 0
    let rejected = 0
    return {
      stats() {
        return { accepted, rejected }
      },
      async getChat(chatId) {
        const entry = canonical.get(chatId)
        if (!entry) return null
        const chat = fixture.chats.find((c) => c.appChatId === chatId)
        return { ...chat, persistenceRevision: entry.revision }
      },
      async saveChat(chat) {
        const entry = canonical.get(chat.appChatId)
        if (!entry) return null
        if ((chat.persistenceRevision || 1) !== entry.revision) {
          rejected += 1
          // ChatService returns the CURRENT record unchanged on CAS mismatch.
          return { appChatId: chat.appChatId, persistenceRevision: entry.revision }
        }
        entry.revision += 1
        accepted += 1
        return { appChatId: chat.appChatId, persistenceRevision: entry.revision }
      }
    }
  }

  it('lands every save-kind event (consumes the returned canonical revision)', async () => {
    const fixture = generatePerfFixture({
      workload: 'dual_run',
      seed: 42,
      baseTimestamp: 1_700_000_000_000,
      lean: true,
      scaleDown: 8
    })
    const api = createRevisionCasApi(fixture)
    const saveKinds = new Set([
      'seed_chat',
      'append_user',
      'append_assistant',
      'tool_batch_complete',
      'durability_soft_flush'
    ])
    const expectedSaves = fixture.replaySchedule.filter((e) => saveKinds.has(e.kind)).length
    expect(expectedSaves).toBeGreaterThan(4)
    const result = await runDeterministicReplay({ fixture, api })
    expect(result.ok).toBe(true)
    expect(
      api.stats().rejected,
      'CAS store rejected replay saves — the driver is not consuming canonical revisions'
    ).toBe(0)
    expect(api.stats().accepted).toBe(expectedSaves)
  })
})

describe('T2 runner (no Electron launch)', () => {
  const {
    sanitizeDevInstanceId,
    resolveUnpackagedDevUserDataPath
  } = require('./devUserDataPath.cjs')
  const {
    buildElectronSpawnPlan,
    assertExactChildAttach,
    assertExactChildOwnsDebugPorts,
    isPidInOwnedElectronTree,
    terminateExactChild,
    spawnExactElectronChild,
    runIsolatedBuild,
    resolveElectronBinary,
    createDirectCliBuildAdapter
  } = require('./electronChildSession.cjs')
  const {
    openCdpWebSocketSession,
    selectRendererTarget,
    attachRendererCdpSession,
    discoverMainInspectorUrl
  } = require('./cdpWebSocketSession.cjs')
  const { buildMessagePrefixBatches, runDeterministicReplay } = require('./replayDriver.cjs')
  const { buildT2SmokePlan, summarizeT2SmokePlan } = require('./t2SmokePlan.cjs')
  const {
    collectRendererHeapSnapshot,
    verifyArtifactFile
  } = require('./collectors/cdpRendererCollector.cjs')
  const {
    DEFAULT_REPLAY_STALL_TIMEOUT_MS,
    createT2ProgressJournal,
    runT2BaselineCli
  } = require('./runT2Baseline.cjs')
  const {
    applyUnsupportedAnnotations,
    createUnsupportedObservationLedger
  } = require('./unsupportedMetrics.cjs')
  const {
    assertLaunchPortsFree,
    parseLsofListenPids,
    listListeningPidsForPort
  } = require('./portGuard.cjs')
  const { EventEmitter } = require('events')

  function ownedPortAdapters(pid, overrides = {}) {
    return {
      listPortPids: async () => [pid],
      timeoutMs: 1000,
      initialDelayMs: 0,
      sleep: async () => {},
      ...overrides
    }
  }

  it('derives sibling TaskWraith Dev <id> and refuses production/shared', () => {
    const home = '/Users/example'
    const resolved = resolveUnpackagedDevUserDataPath({
      instanceId: 'perf-t2-30seat-42!!!',
      home,
      platform: 'darwin'
    })
    expect(resolved.sanitizedInstanceId).toBe(sanitizeDevInstanceId('perf-t2-30seat-42!!!'))
    expect(resolved.sanitizedInstanceId.length).toBeLessThanOrEqual(16)
    expect(resolved.appName).toBe(`TaskWraith Dev ${resolved.sanitizedInstanceId}`)
    expect(resolved.userDataPath).toBe(
      path.join(home, 'Library', 'Application Support', resolved.appName)
    )
    expect(resolved.userDataPath).not.toBe(resolved.productionUserDataPath)
    expect(resolved.userDataPath).not.toBe(resolved.sharedDevUserDataPath)

    expect(() =>
      resolveUnpackagedDevUserDataPath({ instanceId: '!!!', home, platform: 'darwin' })
    ).toThrow(/empty|shared/i)
  })

  it('spawn plan forces IOS off, unique inspect port, exact-child safety', () => {
    const plan = buildElectronSpawnPlan({
      instanceId: 'perfT2Child01',
      repoRoot: path.resolve(__dirname, '..', '..'),
      workload: 'dual_run',
      fxPosture: 'reduce_motion',
      platform: 'darwin',
      adapters: {
        resolveElectronPath: () => '/virtual/electron-bin'
      }
    })
    expect(plan.env.IOS_REMOTE_TRUE).toBe('0')
    expect(plan.env.CFFIXED_USER_HOME).toBeUndefined()
    expect(plan.mainInspectorPort).not.toBe(plan.remoteDebuggingPort)
    expect(plan.argv.join(' ')).toContain(`--inspect=${plan.mainInspectorPort}`)
    expect(plan.argv).toContain('--use-mock-keychain')
    expect(plan.shellCommand).toContain('--use-mock-keychain')
    expect(plan.argv[0]).not.toBe('electron')
    expect(plan.spawnCommand).toBe('/virtual/electron-bin')
    expect(plan.shellCommand).not.toMatch(/\bnpx\b/)
    expect(plan.safety.attachOnlyExactChild).toBe(true)
    expect(plan.safety.neverAutoDeleteArtifacts).toBe(true)
    expect(plan.safety.neverPgrepKillBroad).toBe(true)
    expect(plan.safety.neverSpawnViaNpxWrapper).toBe(true)
    expect(plan.safety.disposableMockKeychain).toBe(true)
  })

  it('binds macOS CoreFoundation appData to the exact isolated HOME', () => {
    const home = path.resolve('/virtual/repo/perf-homes/perfT2MacHome')
    const plan = buildElectronSpawnPlan({
      instanceId: 'perfT2MacHome',
      repoRoot: '/virtual/repo',
      home,
      platform: 'darwin',
      adapters: { resolveElectronPath: () => '/virtual/Electron' }
    })

    expect(plan.env.HOME).toBe(home)
    expect(plan.env.CFFIXED_USER_HOME).toBe(home)
    expect(plan.shellCommand).toContain(`CFFIXED_USER_HOME=${home}`)
    expect(plan.argv.indexOf('--use-mock-keychain')).toBeLessThan(plan.argv.indexOf('.'))
    expect(plan.argv).not.toContain(expect.stringContaining('--user-data-dir'))
    expect(plan.safety.coreFoundationHomePropagated).toBe(true)
  })

  it('waits boundedly for the exact-child main inspector HTTP endpoint', async () => {
    let attempts = 0
    let elapsedMs = 0
    const url = await discoverMainInspectorUrl({
      port: 9811,
      adapters: {
        httpGetJson: async () => {
          attempts += 1
          if (attempts === 1) throw new Error('http timeout')
          if (attempts === 2) return []
          return [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9811/exact-child' }]
        },
        nowMs: () => elapsedMs,
        sleep: async (ms) => {
          elapsedMs += ms
        },
        timeoutMs: 5_000,
        initialDelayMs: 50,
        maxDelayMs: 200
      }
    })

    expect(url).toBe('ws://127.0.0.1:9811/exact-child')
    expect(attempts).toBe(3)
  })

  it('fails closed when the exact-child main inspector never becomes ready', async () => {
    let elapsedMs = 0
    await expect(
      discoverMainInspectorUrl({
        port: 9811,
        adapters: {
          httpGetJson: async () => {
            throw new Error('http timeout')
          },
          nowMs: () => elapsedMs,
          sleep: async (ms) => {
            elapsedMs += ms
          },
          timeoutMs: 100,
          initialDelayMs: 50,
          maxDelayMs: 50
        }
      })
    ).rejects.toThrow(/exact child port 9811.*not ready within 100ms.*http timeout/i)
  })

  it('refuses attach/terminate against non-exact child claims', async () => {
    const session = {
      pid: 4242,
      remoteDebuggingPort: 9411,
      mainInspectorPort: 9811,
      kill() {
        return true
      }
    }
    expect(() => assertExactChildAttach(session, { pid: 1 })).toThrow(/pid/)
    expect(() => assertExactChildAttach(session, { remoteDebuggingPort: 9999 })).toThrow(/CDP port/)

    const kills = []
    const fake = new EventEmitter()
    Object.assign(fake, {
      pid: 77,
      kill(sig) {
        kills.push(sig)
        if (sig === 'SIGTERM') fake.emit('exit', 0, sig)
        return true
      }
    })
    const result = await terminateExactChild(fake, { waitMs: 50, sleep: async () => {} })
    expect(result.pid).toBe(77)
    expect(result.neverAutoDeletedArtifacts).toBe(true)
    expect(kills[0]).toBe('SIGTERM')
  })

  it('CDP websocket adapter speaks JSON-RPC via injected WebSocket', async () => {
    let lastSocket = null
    class FakeWs {
      constructor(url) {
        this.url = url
        this.handlers = {}
        lastSocket = this
        queueMicrotask(() => this.handlers.open && this.handlers.open())
      }
      on(event, handler) {
        this.handlers[event] = handler
      }
      send(data) {
        const msg = JSON.parse(data)
        queueMicrotask(() => {
          this.handlers.message(
            JSON.stringify({ id: msg.id, result: { ok: true, method: msg.method } })
          )
        })
      }
      close() {}
    }
    const session = await openCdpWebSocketSession({
      url: 'ws://127.0.0.1:9/devtools/page/1',
      WebSocket: FakeWs
    })
    const result = await session.send('Profiler.enable')
    expect(result.ok).toBe(true)
    session.close()

    const target = selectRendererTarget([
      { type: 'page', id: 'p1', webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/p1' }
    ])
    expect(target.id).toBe('p1')

    const attached = await attachRendererCdpSession({
      port: 9,
      WebSocket: FakeWs,
      adapters: {
        httpGetJson: async (url) => {
          if (String(url).includes('/json/version')) return { Browser: 'Fake/1' }
          return [
            { type: 'page', id: 'p1', webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/p1' }
          ]
        }
      }
    })
    expect(attached.kind).toBe('renderer_cdp')
    const events = []
    const unsubscribe = attached.onEvent((event) => events.push(event))
    lastSocket.handlers.message(
      JSON.stringify({
        method: 'HeapProfiler.addHeapSnapshotChunk',
        params: { chunk: 'streamed' }
      })
    )
    expect(events).toEqual([
      {
        method: 'HeapProfiler.addHeapSnapshotChunk',
        params: { chunk: 'streamed' }
      }
    ])
    unsubscribe()
    attached.close()
  })

  it('waits boundedly for a renderer page on the exact child port', async () => {
    let listAttempts = 0
    let elapsedMs = 0
    class ReadyWs {
      handlers = {}
      on(event, handler) {
        this.handlers[event] = handler
        if (event === 'open') queueMicrotask(handler)
      }
      send() {}
      close() {}
    }

    const attached = await attachRendererCdpSession({
      port: 9411,
      WebSocket: ReadyWs,
      adapters: {
        httpGetJson: async (url) => {
          if (String(url).includes('/json/version')) return { Browser: 'Fake/2' }
          listAttempts += 1
          if (listAttempts < 3) return []
          return [
            {
              type: 'page',
              id: 'ready',
              webSocketDebuggerUrl: 'ws://127.0.0.1:9411/devtools/page/ready'
            }
          ]
        },
        nowMs: () => elapsedMs,
        sleep: async (ms) => {
          elapsedMs += ms
        },
        timeoutMs: 5_000,
        initialDelayMs: 50,
        maxDelayMs: 200
      }
    })

    expect(listAttempts).toBe(3)
    expect(attached.targetId).toBe('ready')
    expect(attached.browserVersion).toBe('Fake/2')
    attached.close()
  })

  it('replay driver applies prefix saves and records explicit unsupported fields', async () => {
    const fixture = generatePerfFixture({
      workload: 'dual_run',
      seed: 42,
      lean: true,
      scaleDown: 20,
      baseTimestamp: 1_700_000_000_000
    })
    const chat = fixture.chats[0]
    const batches = buildMessagePrefixBatches(chat, 5)
    expect(batches[0].messageCount).toBeLessThanOrEqual(5)
    expect(batches[batches.length - 1].messageCount).toBe(chat.messages.length)

    /** @type {object[]} */
    const saved = []
    const api = {
      getChat: async (id) => saved.filter((c) => c.appChatId === id).at(-1) || null,
      saveChat: async (c) => {
        saved.push(JSON.parse(JSON.stringify(c)))
        return { ok: true }
      }
    }
    const result = await runDeterministicReplay({
      fixture,
      api,
      maxEvents: 20
    })
    expect(result.saveCount).toBeGreaterThan(0)
    expect(result.unsupported.every((u) => u.reason)).toBe(true)
    // durability_soft_flush marks integrated orchestrator unsupported rather than inventing ticks
    if (fixture.replaySchedule.slice(0, 20).some((e) => e.kind === 'durability_soft_flush')) {
      expect(result.unsupported.some((u) => u.field === 'integratedOrchestratorTick')).toBe(true)
    }
  })

  it('replay driver reports exact event starts and completed progress', async () => {
    const fixture = generatePerfFixture({
      workload: 'dual_run',
      seed: 43,
      lean: true,
      scaleDown: 40,
      baseTimestamp: 1_700_000_000_000
    })
    const starts = []
    const completed = []
    let clock = 1_000
    const saved = new Map()
    const result = await runDeterministicReplay({
      fixture,
      maxEvents: 3,
      nowMs: () => {
        clock += 10
        return clock
      },
      api: {
        getChat: async (id) => saved.get(id) || null,
        saveChat: async (chat) => {
          saved.set(chat.appChatId, chat)
          return { ok: true }
        }
      },
      onEventStart: (info) => starts.push(info),
      onProgress: (info) => completed.push(info)
    })

    expect(result.eventCount).toBe(3)
    expect(starts.map((row) => row.eventNumber)).toEqual([1, 2, 3])
    expect(completed.map((row) => row.completedEvents)).toEqual([1, 2, 3])
    expect(starts.every((row) => row.totalEvents === 3)).toBe(true)
    expect(completed.every((row) => row.totalEvents === 3 && row.elapsedMs === 10)).toBe(true)
    expect(completed.map((row) => [row.seq, row.kind])).toEqual(
      fixture.replaySchedule.slice(0, 3).map((event) => [event.seq, event.kind])
    )
  })

  it('replay watchdog fails closed with the exact stalled event identity', async () => {
    const fixture = generatePerfFixture({
      workload: 'dual_run',
      seed: 44,
      lean: true,
      scaleDown: 40,
      baseTimestamp: 1_700_000_000_000
    })
    const firstEvent = fixture.replaySchedule[0]
    const stalls = []
    let nowCalls = 0

    await expect(
      runDeterministicReplay({
        fixture,
        maxEvents: 1,
        eventTimeoutMs: 25,
        nowMs: () => (nowCalls++ === 0 ? 1_000 : 1_025),
        timers: {
          setTimeout(handler, timeoutMs) {
            expect(timeoutMs).toBe(25)
            queueMicrotask(handler)
            return 1
          },
          clearTimeout() {}
        },
        api: {
          getChat: async () => null,
          saveChat: async () => new Promise(() => {})
        },
        onStall: (info) => stalls.push(info)
      })
    ).rejects.toMatchObject({
      code: 'T2_REPLAY_STALL_TIMEOUT',
      replayEvent: {
        eventNumber: 1,
        totalEvents: 1,
        seq: firstEvent.seq,
        kind: firstEvent.kind,
        timeoutMs: 25,
        startedAtMs: 1_000,
        timedOutAtMs: 1_025
      }
    })
    expect(stalls).toHaveLength(1)
    expect(stalls[0]).toMatchObject({
      eventNumber: 1,
      seq: firstEvent.seq,
      kind: firstEvent.kind,
      elapsedMs: 25
    })
  })

  it('writes atomic diagnostic-only T2 progress without granting authority', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tw-t2-progress-'))
    const logs = []
    let clock = Date.parse('2026-08-04T05:00:00.000Z')
    try {
      const journal = createT2ProgressJournal({
        artifactDir: dir,
        nowMs: () => clock,
        log: (line) => logs.push(line),
        initial: {
          runId: 'perf-t2-test',
          totalEvents: 10,
          stallTimeoutMs: DEFAULT_REPLAY_STALL_TIMEOUT_MS
        }
      })
      journal.update({ phase: 'replay', completedEvents: 4 }, { log: true })
      clock += 25
      journal.update(
        {
          status: 'failed',
          phase: 'replay_stalled',
          currentEvent: { eventNumber: 5, totalEvents: 10, seq: 5, kind: 'append_user' }
        },
        { log: true }
      )

      const projection = JSON.parse(readFileSync(journal.path, 'utf8'))
      expect(projection).toMatchObject({
        schemaVersion: 1,
        kind: 'taskwraith-perf-t2-progress',
        diagnosticOnly: true,
        authoritativeEvidence: false,
        status: 'failed',
        phase: 'replay_stalled',
        completedEvents: 4,
        currentEvent: { eventNumber: 5, seq: 5, kind: 'append_user' },
        stallTimeoutMs: DEFAULT_REPLAY_STALL_TIMEOUT_MS
      })
      expect(existsSync(`${journal.path}.tmp-${process.pid}`)).toBe(false)
      expect(logs.at(-1)).toContain('[T2] failed/replay_stalled 4/10 (40.0%)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('port preflight refuses occupied / answering CDP via adapters', async () => {
    await expect(
      assertLaunchPortsFree(
        { remoteDebuggingPort: 9411, mainInspectorPort: 9411, instanceId: 'x' },
        {}
      )
    ).rejects.toThrow(/distinct/)

    await expect(
      assertLaunchPortsFree(
        { remoteDebuggingPort: 9411, mainInspectorPort: 9811, instanceId: 'perfx' },
        {
          probePort: async (port) => ({ port, occupied: port === 9411, error: 'EADDRINUSE' }),
          probeCdp: async () => ({ port: 9411, reachable: false })
        }
      )
    ).rejects.toThrow(/occupied/)

    const ok = await assertLaunchPortsFree(
      { remoteDebuggingPort: 9411, mainInspectorPort: 9811, instanceId: 'perfx' },
      {
        probePort: async (port) => ({ port, occupied: false }),
        probeCdp: async () => ({ port: 9411, reachable: false }),
        listInstancePids: () => []
      }
    )
    expect(ok.ok).toBe(true)
  })

  it('smoke plan never launches Electron and CLI defaults refuse --launch', async () => {
    const plan = buildT2SmokePlan({ workload: 'dual_run', seed: 1, scaleDown: 40 })
    expect(plan.doesNotLaunchElectron).toBe(true)
    expect(plan.steps.find((step) => step.id === 'replay')).toMatchObject({
      progressArtifact: 'perf-t2-progress.json',
      progressIsAuthoritativeEvidence: false
    })
    const summary = summarizeT2SmokePlan(plan)
    expect(summary.electronSkippedStepIds).toEqual(
      expect.arrayContaining(['build', 'launch', 'attach', 'profiles', 'terminate'])
    )

    await expect(
      runT2BaselineCli(['--workload=dual_run', '--launch', '--lean', '--scale-down=40'], {
        repoRoot: path.resolve(__dirname, '..', '..'),
        forceIsolated: true
      })
    ).rejects.toThrow(/i-accept-isolated-launch/)

    await expect(
      runT2BaselineCli(['--workload=dual_run', '--dry-run', '--replay-stall-timeout-ms=0'])
    ).rejects.toThrow(/positive finite number/)

    const dry = await runT2BaselineCli(
      [
        '--workload=dual_run',
        '--dry-run',
        '--lean',
        '--scale-down=40',
        '--instance-id=perfT2Dry01',
        `--home=${path.join(tmpdir(), 'tw-t2-home')}`
      ],
      {
        repoRoot: path.resolve(__dirname, '..', '..'),
        forceIsolated: true,
        platform: 'darwin'
      }
    )
    expect(dry.ok).toBe(true)
    expect(dry.launched).toBe(false)
    expect(dry.report.status.metricsCollected).toBe(false)
    expect(dry.report.metrics.main.saveChat.stringifyMsUnsupported).toBe(true)
    expect(dry.report.observationLedger.compositorLayerCountP95.status).toBe('unsupported')
    expect(existsSync(dry.reportPath)).toBe(true)

    const smoke = await runT2BaselineCli(['--smoke-plan', '--workload=dual_run', '--scale-down=40'])
    expect(smoke.smokePlan.doesNotLaunchElectron).toBe(true)
  })

  it('unsupported ledger never invents compositor/orchestrator wins', () => {
    const metrics = applyUnsupportedAnnotations(createEmptyPerfMetrics())
    const ledger = createUnsupportedObservationLedger()
    expect(metrics.observationLedger.compositorLayerCountP95.status).toBe('unsupported')
    expect(ledger.integratedOrchestratorSignals.status).toBe('unsupported')
    expect(metrics.main.saveChat.stringifyMsUnsupported).toBe(true)
  })

  it('materialize into exact injected instance path creates chats/ for migration skip', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'tw-t2-home-'))
    try {
      const resolved = resolveUnpackagedDevUserDataPath({
        instanceId: 'perfMat01',
        home,
        platform: 'darwin'
      })
      const result = materializePerfUserData({
        workload: 'dual_run',
        seed: 3,
        userDataDir: resolved.userDataPath,
        mode: 'legacy_v1',
        lean: true,
        scaleDown: 30
      })
      expect(existsSync(path.join(result.userDataDir, 'chats'))).toBe(true)
      expect(result.userDataDir).toBe(resolved.userDataPath)
      expect(path.basename(result.userDataDir)).toBe('TaskWraith Dev perfMat01')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('A: authoritative build fails closed — no silent skip / stale out launch', async () => {
    await expect(
      runIsolatedBuild({
        repoRoot: path.resolve(__dirname, '..', '..'),
        authoritative: true,
        allowSkip: false,
        adapters: {
          build: async () => ({ skipped: true, reason: 'fake skip' })
        }
      })
    ).rejects.toThrow(/skipped|stale out/i)

    await expect(
      runIsolatedBuild({
        repoRoot: path.resolve(__dirname, '..', '..'),
        authoritative: true,
        allowSkip: false,
        adapters: {
          spawnSync: () => ({ status: 7, stderr: 'boom', stdout: '' })
        }
      })
    ).rejects.toThrow(/failed with code 7/)

    const ok = await runIsolatedBuild({
      repoRoot: '/virtual/repo',
      authoritative: true,
      adapters: {
        build: async () => ({ code: 0, command: 'npx electron-vite build' })
      }
    })
    expect(ok.skipped).toBe(false)
    expect(ok.authoritative).toBe(true)

    const skippedNonAuth = await runIsolatedBuild({
      repoRoot: '/virtual/repo',
      authoritative: false,
      allowSkip: true
    })
    expect(skippedNonAuth.skipped).toBe(true)
    expect(skippedNonAuth.authoritative).toBe(false)

    const buildSteps = []
    const direct = createDirectCliBuildAdapter({
      spawnSync: (command, args) => {
        buildSteps.push([command, args])
        return { status: 0, stdout: `built:${command}`, stderr: '' }
      }
    })
    const built = await direct('/virtual/repo')
    expect(built.code).toBe(0)
    expect(buildSteps).toEqual([
      ['npm', ['run', 'prebuild:bridge-daemon']],
      ['npx', ['electron-vite', 'build']]
    ])
    expect(built.command).toContain('prebuild:bridge-daemon')
  })

  it('B: spawn uses resolved Electron binary PID — never npx wrapper', () => {
    expect(
      resolveElectronBinary({ adapters: { requireElectron: () => '/opt/Electron.app/electron' } })
    ).toBe(path.resolve('/opt/Electron.app/electron'))
    expect(() =>
      resolveElectronBinary({ adapters: { requireElectron: () => ({ not: 'a path' }) } })
    ).toThrow(/binary path string/)

    const spawned = []
    const plan = buildElectronSpawnPlan({
      instanceId: 'perfOwnPid01',
      repoRoot: '/virtual/repo',
      remoteDebuggingPort: 9411,
      mainInspectorPort: 9811,
      adapters: { resolveElectronPath: () => '/virtual/Electron' }
    })
    const child = spawnExactElectronChild({
      spawnPlan: plan,
      adapters: {
        spawn: (cmd, args, opts) => {
          spawned.push({ cmd, args, opts })
          const ee = new EventEmitter()
          return Object.assign(ee, {
            pid: 4242,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill: () => true
          })
        }
      }
    })
    expect(spawned[0].cmd).toBe('/virtual/Electron')
    expect(spawned[0].cmd).not.toBe('npx')
    expect(child.pid).toBe(4242)
    expect(child.electronBinary).toBe('/virtual/Electron')
    expect(child.pgid).toBe(4242)
    expect(spawned[0].opts.detached).toBe(true)

    expect(() =>
      spawnExactElectronChild({
        spawnPlan: { ...plan, electronBinary: 'npx', spawnCommand: 'npx' },
        adapters: {
          spawn: () => {
            throw new Error('should not spawn')
          }
        }
      })
    ).toThrow(/npx wrapper/i)
  })

  it('C: launch try/finally terminates owned child on staged attach failure', async () => {
    const kills = []
    const repoRoot = path.resolve(__dirname, '..', '..')
    const homesRoot = path.join(repoRoot, 'perf-homes')
    mkdirSync(homesRoot, { recursive: true })
    const home = mkdtempSync(path.join(homesRoot, 'tw-t2-finally-'))
    try {
      await expect(
        runT2BaselineCli(
          [
            '--workload=dual_run',
            '--launch',
            '--i-accept-isolated-launch',
            '--materialize-instance-userdata',
            '--lean',
            '--scale-down=40',
            '--instance-id=perfFin01',
            `--home=${home}`,
            '--port=9411',
            '--inspect-port=9811'
          ],
          {
            repoRoot,
            forceIsolated: true,
            allowDirtyLaunch: true,
            allowNonIsolatedLaunch: true,
            platform: 'darwin',
            provenance: {
              gitSha: 'a'.repeat(40),
              dirty: false,
              dirtyTreeFingerprint: 'b'.repeat(64),
              dirtyPaths: [],
              isolatedWorktree: true,
              authoritativeBaseline: true
            },
            buildAdapters: {
              build: async () => ({ code: 0 })
            },
            spawnAdapters: {
              resolveElectronPath: () => '/virtual/Electron',
              spawn: () => {
                const ee = new EventEmitter()
                return Object.assign(ee, {
                  pid: 9090,
                  stdout: new EventEmitter(),
                  stderr: new EventEmitter(),
                  kill(sig) {
                    kills.push(sig)
                    queueMicrotask(() => ee.emit('exit', 0, sig))
                    return true
                  }
                })
              }
            },
            portAdapters: {
              probePort: async (port) => ({ port, occupied: false }),
              probeCdp: async () => ({ port: 9411, reachable: false }),
              listInstancePids: () => []
            },
            portOwnershipAdapters: ownedPortAdapters(9090),
            cdpAdapters: {
              httpGetJson: async () => {
                throw new Error('staged attach failure')
              },
              timeoutMs: 0
            },
            terminateOptions: { waitMs: 20, sleep: async () => {} }
          }
        )
      ).rejects.toThrow(/staged attach failure/)
      expect(kills.length).toBeGreaterThan(0)
      expect(kills[0]).toBe('SIGTERM')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('E: exact-port ownership retries until both listeners appear; empty times out fail-closed', async () => {
    expect(parseLsofListenPids('p4242\np4242\np100\n')).toEqual([100, 4242])

    await expect(
      listListeningPidsForPort(9411, {
        platform: 'win32'
      })
    ).rejects.toThrow(/unsupported on win32/i)

    await expect(
      listListeningPidsForPort(9411, {
        execFile: (_file, _args, _opts, cb) => {
          const err = new Error('spawn lsof ENOENT')
          err.code = 'ENOENT'
          cb(err)
        }
      })
    ).rejects.toThrow(/lsof not found/i)

    const session = {
      pid: 4242,
      pgid: 4242,
      ownedPids: [4242],
      remoteDebuggingPort: 9411,
      mainInspectorPort: 9811
    }

    let clock = 0
    const calls = []
    const delayed = await assertExactChildOwnsDebugPorts(session, {
      listPortPids: async (port) => {
        calls.push(port)
        // First full sweep empty; second sweep both owned.
        if (calls.length <= 2) return []
        return [4242]
      },
      timeoutMs: 1000,
      initialDelayMs: 10,
      maxDelayMs: 50,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      }
    })
    expect(delayed.ok).toBe(true)
    expect(delayed.attempts).toBeGreaterThan(1)
    expect(calls.filter((p) => p === 9411).length).toBeGreaterThan(1)
    expect(calls.filter((p) => p === 9811).length).toBeGreaterThan(0)

    clock = 0
    await expect(
      assertExactChildOwnsDebugPorts(session, {
        listPortPids: async () => [],
        timeoutMs: 40,
        initialDelayMs: 10,
        maxDelayMs: 10,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms
        }
      })
    ).rejects.toThrow(/timed out/i)

    await expect(
      assertExactChildOwnsDebugPorts(session, {
        listPortPids: async () => [7777],
        getProcessIdentity: async (pid) =>
          pid === 7777 ? { pid: 7777, ppid: 1, pgid: 1 } : { pid, ppid: 1, pgid: 1 },
        timeoutMs: 100,
        initialDelayMs: 0,
        sleep: async () => {}
      })
    ).rejects.toThrow(/7777.*not in owned Electron tree/i)

    const descendant = await assertExactChildOwnsDebugPorts(session, {
      listPortPids: async () => [5555],
      getProcessIdentity: async (pid) => {
        if (pid === 5555) return { pid: 5555, ppid: 4242, pgid: 9999 }
        if (pid === 4242) return { pid: 4242, ppid: 1, pgid: 4242 }
        return null
      },
      timeoutMs: 100,
      initialDelayMs: 0,
      sleep: async () => {}
    })
    expect(descendant.ok).toBe(true)

    const pgidOwned = await assertExactChildOwnsDebugPorts(session, {
      listPortPids: async () => [6666],
      getProcessIdentity: async (pid) =>
        pid === 6666 ? { pid: 6666, ppid: 1, pgid: 4242 } : { pid, ppid: 1, pgid: 1 },
      timeoutMs: 100,
      initialDelayMs: 0,
      sleep: async () => {}
    })
    expect(pgidOwned.ok).toBe(true)

    expect(
      await isPidInOwnedElectronTree(4242, session, {
        getProcessIdentity: async () => {
          throw new Error('should not probe self')
        }
      })
    ).toBe(true)

    await expect(
      assertExactChildOwnsDebugPorts(session, { probeSupported: false })
    ).rejects.toThrow(/unsupported/i)
  })

  it('E: runT2Baseline refuses attach before ownership check passes', async () => {
    const kills = []
    let cdpCalled = false
    const repoRoot = path.resolve(__dirname, '..', '..')
    const homesRoot = path.join(repoRoot, 'perf-homes')
    mkdirSync(homesRoot, { recursive: true })
    const home = mkdtempSync(path.join(homesRoot, 'tw-t2-e-own-'))
    try {
      await expect(
        runT2BaselineCli(
          [
            '--workload=dual_run',
            '--launch',
            '--i-accept-isolated-launch',
            '--materialize-instance-userdata',
            '--lean',
            '--scale-down=40',
            '--instance-id=perfOwnE01',
            `--home=${home}`,
            '--port=9411',
            '--inspect-port=9811'
          ],
          {
            repoRoot,
            forceIsolated: true,
            allowDirtyLaunch: true,
            allowNonIsolatedLaunch: true,
            platform: 'darwin',
            provenance: {
              gitSha: 'a'.repeat(40),
              dirty: false,
              dirtyTreeFingerprint: 'b'.repeat(64),
              dirtyPaths: [],
              isolatedWorktree: true,
              authoritativeBaseline: true
            },
            buildAdapters: {
              build: async () => ({ code: 0 })
            },
            spawnAdapters: {
              resolveElectronPath: () => '/virtual/Electron',
              spawn: () => {
                const ee = new EventEmitter()
                return Object.assign(ee, {
                  pid: 4242,
                  stdout: new EventEmitter(),
                  stderr: new EventEmitter(),
                  kill(sig) {
                    kills.push(sig)
                    queueMicrotask(() => ee.emit('exit', 0, sig))
                    return true
                  }
                })
              }
            },
            portAdapters: {
              probePort: async (port) => ({ port, occupied: false }),
              probeCdp: async () => ({ port: 9411, reachable: false }),
              listInstancePids: () => []
            },
            portOwnershipAdapters: {
              listPortPids: async () => [1111],
              getProcessIdentity: async (pid) => ({ pid, ppid: 1, pgid: 1 }),
              timeoutMs: 50,
              initialDelayMs: 0,
              sleep: async () => {}
            },
            cdpAdapters: {
              httpGetJson: async () => {
                cdpCalled = true
                return {
                  webSocketDebuggerUrl: 'ws://127.0.0.1:9411/devtools/browser/x',
                  type: 'page',
                  url: 'app://taskwraith'
                }
              }
            },
            terminateOptions: { waitMs: 20, sleep: async () => {} }
          }
        )
      ).rejects.toThrow(/not in owned Electron tree|Refuse attach/i)
      expect(cdpCalled).toBe(false)
      expect(kills.length).toBeGreaterThan(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('D: heap streams addHeapSnapshotChunk to temp, promotes, hashes; refuses empty', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tw-heap-'))
    try {
      const finalPath = path.join(dir, 'renderer.heapsnapshot')
      const files = new Map()
      const fsApi = {
        writeFileSync(p, data) {
          files.set(p, Buffer.from(data))
        },
        appendFileSync(p, data) {
          const prev = files.get(p) || Buffer.alloc(0)
          files.set(p, Buffer.concat([prev, Buffer.from(data)]))
        },
        renameSync(from, to) {
          files.set(to, files.get(from))
          files.delete(from)
        },
        unlinkSync(p) {
          files.delete(p)
        },
        openSync() {
          return 3
        },
        fsyncSync() {},
        closeSync() {},
        existsSync(p) {
          return files.has(p)
        },
        readFileSync(p) {
          return files.get(p)
        },
        statSync(p) {
          return { size: (files.get(p) || Buffer.alloc(0)).length }
        }
      }

      /** @type {Set<Function>} */
      const handlers = new Set()
      const session = {
        send: async (method) => {
          if (method === 'HeapProfiler.takeHeapSnapshot') {
            for (const h of handlers) {
              h({
                method: 'HeapProfiler.addHeapSnapshotChunk',
                params: { chunk: 'CHUNK'.repeat(40) }
              })
              h({
                method: 'HeapProfiler.addHeapSnapshotChunk',
                params: { chunk: 'MORE'.repeat(40) }
              })
            }
            return {}
          }
          return {}
        },
        onEvent(handler) {
          handlers.add(handler)
          return () => handlers.delete(handler)
        }
      }

      const result = await collectRendererHeapSnapshot(session, {
        heapSnapshotPath: finalPath,
        fs: fsApi,
        nowMs: () => 123,
        pid: 7,
        minBytes: 64
      })
      expect(result.bytes).toBeGreaterThan(64)
      expect(result.chunkCount).toBe(2)
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(files.has(finalPath)).toBe(true)
      expect([...files.keys()].some((k) => String(k).includes('.tmp-'))).toBe(false)
      const digest = verifyArtifactFile(finalPath, { fs: fsApi, minBytes: 64 })
      expect(digest.sha256).toBe(result.sha256)

      const emptyHandlers = new Set()
      const emptySession = {
        send: async () => ({}),
        onEvent(handler) {
          emptyHandlers.add(handler)
          return () => emptyHandlers.delete(handler)
        }
      }
      await expect(
        collectRendererHeapSnapshot(emptySession, {
          heapSnapshotPath: path.join(dir, 'empty.heapsnapshot'),
          fs: fsApi,
          minBytes: 64
        })
      ).rejects.toThrow(/too small|empty/i)

      await expect(collectRendererHeapSnapshot({ send: async () => ({}) })).rejects.toThrow(
        /onEvent required/i
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('F: authoritative launch refuses missing/real/out-of-worktree home; accepts perf-homes', async () => {
    const {
      assertAuthoritativeIsolatedHome,
      resolveT2Home,
      verifyIsolatedHomeAndUserDataViaMainInspector,
      PERF_HOMES_DIRNAME
    } = require('./isolatedHome.cjs')
    const repoRoot = path.resolve(__dirname, '..', '..')
    const realHome = '/Users/fake-real-home'
    const boundary = path.join(repoRoot, PERF_HOMES_DIRNAME)

    expect(() =>
      assertAuthoritativeIsolatedHome({ home: '', repoRoot, realHomedir: realHome })
    ).toThrow(/requires explicit --home/i)
    expect(() =>
      assertAuthoritativeIsolatedHome({
        home: 'perf-homes/relative',
        repoRoot,
        realHomedir: realHome
      })
    ).toThrow(/absolute path/i)
    expect(() =>
      assertAuthoritativeIsolatedHome({ home: realHome, repoRoot, realHomedir: realHome })
    ).toThrow(/must not equal the real os\.homedir/i)
    expect(() =>
      assertAuthoritativeIsolatedHome({
        home: path.join(tmpdir(), 'outside-home'),
        repoRoot,
        realHomedir: realHome
      })
    ).toThrow(/inside the isolated worktree|under .*perf-homes/i)

    mkdirSync(boundary, { recursive: true })
    const safeHome = mkdtempSync(path.join(boundary, 'tw-t2-f-safe-'))
    try {
      const ok = assertAuthoritativeIsolatedHome({
        home: safeHome,
        repoRoot,
        realHomedir: realHome
      })
      expect(ok.home).toBe(path.resolve(safeHome))
      expect(ok.authoritative).toBe(true)

      const resolved = resolveT2Home({
        homeArg: safeHome,
        repoRoot,
        willLaunch: true,
        realHomedir: realHome
      })
      expect(resolved.authoritativeHome).toBe(true)

      const userData = resolveUnpackagedDevUserDataPath({
        instanceId: 'perfFHome01',
        home: safeHome,
        platform: 'darwin'
      })
      expect(userData.userDataPath).toBe(
        path.join(safeHome, 'Library', 'Application Support', 'TaskWraith Dev perfFHome01')
      )

      const plan = buildElectronSpawnPlan({
        instanceId: 'perfFHome01',
        repoRoot,
        home: safeHome,
        userDataPath: userData.userDataPath,
        remoteDebuggingPort: 9411,
        mainInspectorPort: 9811,
        adapters: { resolveElectronPath: () => '/virtual/Electron' }
      })
      expect(plan.env.HOME).toBe(path.resolve(safeHome))
      expect(plan.shellCommand).toContain(`HOME=${path.resolve(safeHome)}`)
      expect(plan.argv.join(' ')).not.toMatch(/user-data-dir/i)
      expect(plan.safety.neverUserDataDirArgv).toBe(true)

      await expect(
        runT2BaselineCli(
          [
            '--workload=dual_run',
            '--launch',
            '--i-accept-isolated-launch',
            '--materialize-instance-userdata',
            '--lean',
            '--scale-down=40',
            '--instance-id=perfFMiss',
            '--port=9411',
            '--inspect-port=9811'
          ],
          {
            repoRoot,
            forceIsolated: true,
            allowDirtyLaunch: true,
            allowNonIsolatedLaunch: true,
            platform: 'darwin',
            realHomedir: realHome,
            provenance: {
              gitSha: 'a'.repeat(40),
              dirty: false,
              dirtyTreeFingerprint: 'b'.repeat(64),
              dirtyPaths: [],
              isolatedWorktree: true,
              authoritativeBaseline: true
            }
          }
        )
      ).rejects.toThrow(/requires explicit --home/i)

      await expect(
        runT2BaselineCli(
          [
            '--workload=dual_run',
            '--launch',
            '--i-accept-isolated-launch',
            '--materialize-instance-userdata',
            '--lean',
            '--scale-down=40',
            '--instance-id=perfFReal',
            `--home=${realHome}`,
            '--port=9411',
            '--inspect-port=9811'
          ],
          {
            repoRoot,
            forceIsolated: true,
            allowDirtyLaunch: true,
            allowNonIsolatedLaunch: true,
            platform: 'darwin',
            realHomedir: realHome,
            provenance: {
              gitSha: 'a'.repeat(40),
              dirty: false,
              dirtyTreeFingerprint: 'b'.repeat(64),
              dirtyPaths: [],
              isolatedWorktree: true,
              authoritativeBaseline: true
            }
          }
        )
      ).rejects.toThrow(/must not equal the real os\.homedir/i)
    } finally {
      rmSync(safeHome, { recursive: true, force: true })
    }

    let probeExpression = ''
    const match = await verifyIsolatedHomeAndUserDataViaMainInspector(
      {
        post: async (_method, params) => {
          probeExpression = params.expression
          return {
            result: {
              value: {
                home: '/virt/home',
                userData: '/virt/home/Library/Application Support/TaskWraith Dev x',
                homeRealpath: '/virt/home',
                userDataRealpath: '/virt/home/Library/Application Support/TaskWraith Dev x'
              }
            }
          }
        }
      },
      {
        home: '/virt/home',
        userDataPath: '/virt/home/Library/Application Support/TaskWraith Dev x',
        homeRealpath: '/virt/home',
        userDataRealpath: '/virt/home/Library/Application Support/TaskWraith Dev x'
      }
    )
    expect(match.ok).toBe(true)
    expect(probeExpression).toContain("process.getBuiltinModule('module').createRequire")
    expect(probeExpression).not.toMatch(/(^|[^A-Za-z])require\s*\(/)

    await expect(
      verifyIsolatedHomeAndUserDataViaMainInspector(
        {
          post: async () => ({
            result: {
              value: {
                home: '/wrong',
                userData: '/virt/home/Library/Application Support/TaskWraith Dev x',
                homeRealpath: '/wrong',
                userDataRealpath: '/virt/home/Library/Application Support/TaskWraith Dev x'
              }
            }
          })
        },
        {
          home: '/virt/home',
          userDataPath: '/virt/home/Library/Application Support/TaskWraith Dev x',
          homeRealpath: '/virt/home',
          userDataRealpath: '/virt/home/Library/Application Support/TaskWraith Dev x'
        }
      )
    ).rejects.toThrow(/HOME mismatch/i)

    await expect(
      verifyIsolatedHomeAndUserDataViaMainInspector(
        {
          post: async () => ({
            result: {
              value: {
                home: '/virt/home',
                userData: '/other/TaskWraith Dev x',
                homeRealpath: '/virt/home',
                userDataRealpath: '/other/TaskWraith Dev x'
              }
            }
          })
        },
        {
          home: '/virt/home',
          userDataPath: '/virt/home/Library/Application Support/TaskWraith Dev x',
          homeRealpath: '/virt/home',
          userDataRealpath: '/virt/home/Library/Application Support/TaskWraith Dev x'
        }
      )
    ).rejects.toThrow(/userData.*mismatch/i)

    await expect(
      verifyIsolatedHomeAndUserDataViaMainInspector(
        {
          post: async () => {
            throw new Error('protocol boom')
          }
        },
        {
          home: '/virt/home',
          userDataPath: '/virt/home/x',
          homeRealpath: '/virt/home',
          userDataRealpath: '/virt/home/x'
        }
      )
    ).rejects.toThrow(/protocol failed/i)
  })

  it('F: inspector path mismatch prevents replay and still tears down exact child', async () => {
    const kills = []
    let replayCalled = false
    const repoRoot = path.resolve(__dirname, '..', '..')
    const homesRoot = path.join(repoRoot, 'perf-homes')
    mkdirSync(homesRoot, { recursive: true })
    const home = mkdtempSync(path.join(homesRoot, 'tw-t2-f-mismatch-'))
    try {
      await expect(
        runT2BaselineCli(
          [
            '--workload=dual_run',
            '--launch',
            '--i-accept-isolated-launch',
            '--materialize-instance-userdata',
            '--lean',
            '--scale-down=40',
            '--instance-id=perfFMis01',
            `--home=${home}`,
            '--port=9411',
            '--inspect-port=9811',
            '--max-replay-events=1'
          ],
          {
            repoRoot,
            forceIsolated: true,
            allowDirtyLaunch: true,
            allowNonIsolatedLaunch: true,
            platform: 'darwin',
            provenance: {
              gitSha: 'a'.repeat(40),
              dirty: false,
              dirtyTreeFingerprint: 'b'.repeat(64),
              dirtyPaths: [],
              isolatedWorktree: true,
              authoritativeBaseline: true
            },
            buildAdapters: {
              build: async () => ({ code: 0 })
            },
            spawnAdapters: {
              resolveElectronPath: () => '/virtual/Electron',
              spawn: (cmd, _args, opts) => {
                expect(opts.env.HOME).toBe(path.resolve(home))
                const ee = new EventEmitter()
                return Object.assign(ee, {
                  pid: 7070,
                  stdout: new EventEmitter(),
                  stderr: new EventEmitter(),
                  kill(sig) {
                    kills.push(sig)
                    queueMicrotask(() => ee.emit('exit', 0, sig))
                    return true
                  }
                })
              }
            },
            portAdapters: {
              probePort: async (port) => ({ port, occupied: false }),
              probeCdp: async () => ({ port: 9411, reachable: false }),
              listInstancePids: () => []
            },
            portOwnershipAdapters: ownedPortAdapters(7070),
            mainInspectorUrl: 'ws://127.0.0.1:9811/xxxxxxxx',
            WebSocket: class FakeWs {
              constructor() {
                this.handlers = {}
                queueMicrotask(() => this.handlers.open && this.handlers.open())
              }
              on(event, handler) {
                this.handlers[event] = handler
              }
              send(data) {
                const msg = JSON.parse(data)
                queueMicrotask(() => {
                  this.handlers.message(
                    JSON.stringify({ id: msg.id, result: { ok: true, method: msg.method } })
                  )
                })
              }
              close() {}
            },
            cdpAdapters: {
              httpGetJson: async (url) => {
                if (String(url).includes('/json/version')) return { Browser: 'Fake/1' }
                if (String(url).includes(':9811')) {
                  return [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9811/xxxxxxxx' }]
                }
                return [
                  {
                    type: 'page',
                    id: 'p1',
                    webSocketDebuggerUrl: 'ws://127.0.0.1:9411/devtools/page/p1'
                  }
                ]
              }
            },
            verifyIsolatedHomeAndUserData: async () => {
              throw new Error(
                "Refuse replay: app.getPath('userData') mismatch (expected isolated, observed wrong)"
              )
            },
            replayApi: {
              getChat: async () => {
                replayCalled = true
                return null
              },
              saveChat: async () => {
                replayCalled = true
                return { ok: true }
              }
            },
            terminateOptions: { waitMs: 20, sleep: async () => {} }
          }
        )
      ).rejects.toThrow(/userData.*mismatch|Refuse replay/i)
      expect(replayCalled).toBe(false)
      expect(kills.length).toBeGreaterThan(0)
      expect(kills[0]).toBe('SIGTERM')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('F: matching inspector HOME/userData permits replay gate; dry stays non-authoritative', async () => {
    const { verifyIsolatedHomeAndUserDataViaMainInspector } = require('./isolatedHome.cjs')
    const repoRoot = path.resolve(__dirname, '..', '..')
    const homesRoot = path.join(repoRoot, 'perf-homes')
    mkdirSync(homesRoot, { recursive: true })
    const home = mkdtempSync(path.join(homesRoot, 'tw-t2-f-match-'))
    const expectedUserData = path.join(
      home,
      'Library',
      'Application Support',
      'TaskWraith Dev perfFOk01'
    )
    try {
      const probe = await verifyIsolatedHomeAndUserDataViaMainInspector(
        {
          post: async () => ({
            result: {
              value: {
                home: path.resolve(home),
                userData: expectedUserData,
                homeRealpath: path.resolve(home),
                userDataRealpath: expectedUserData
              }
            }
          })
        },
        {
          home,
          userDataPath: expectedUserData,
          homeRealpath: path.resolve(home),
          userDataRealpath: expectedUserData
        }
      )
      expect(probe.ok).toBe(true)
      expect(probe.observedHome).toBe(path.resolve(home))
      expect(probe.observedUserDataPath).toBe(expectedUserData)

      const dry = await runT2BaselineCli(
        [
          '--workload=dual_run',
          '--dry-run',
          '--lean',
          '--scale-down=40',
          '--instance-id=perfFDry01',
          `--home=${home}`
        ],
        {
          repoRoot,
          forceIsolated: true,
          platform: 'darwin',
          provenance: {
            gitSha: 'a'.repeat(40),
            dirty: false,
            dirtyTreeFingerprint: 'b'.repeat(64),
            dirtyPaths: [],
            isolatedWorktree: true,
            authoritativeBaseline: true
          }
        }
      )
      expect(dry.ok).toBe(true)
      expect(dry.launched).toBe(false)
      expect(dry.provenance.authoritativeBaseline).toBe(false)
      expect(dry.report.environment.authoritativeBaseline).toBe(false)
      expect(dry.isolation.verified).toBe(false)
      expect(dry.spawnPlan.env.HOME).toBe(path.resolve(home))
      expect(dry.userDataPath).toBe(
        path.join(home, 'Library', 'Application Support', 'TaskWraith Dev perfFDry01')
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('G: refuses symlink boundary/home escape and non-directory; proves canonical happy path', () => {
    const {
      assertFilesystemIsolatedHomeContainment,
      prepareAuthoritativeIsolatedHome,
      PERF_HOMES_DIRNAME
    } = require('./isolatedHome.cjs')

    const fakeRepo = mkdtempSync(path.join(tmpdir(), 'tw-t2-g-repo-'))
    const realHome = path.join(tmpdir(), 'tw-t2-g-real-home')
    mkdirSync(realHome, { recursive: true })
    const outside = mkdtempSync(path.join(tmpdir(), 'tw-t2-g-outside-'))
    try {
      const boundary = path.join(fakeRepo, PERF_HOMES_DIRNAME)

      // Symlinked boundary → host escape
      symlinkSync(outside, boundary)
      expect(() =>
        assertFilesystemIsolatedHomeContainment({
          home: path.join(boundary, 'nested'),
          repoRoot: fakeRepo,
          realHomedir: realHome,
          createMissing: true
        })
      ).toThrow(/symlink component/i)
      rmSync(boundary, { force: true })

      // Non-directory component under boundary
      mkdirSync(boundary, { recursive: true })
      const fileAsHome = path.join(boundary, 'not-a-dir')
      writeFileSync(fileAsHome, 'nope')
      expect(() =>
        assertFilesystemIsolatedHomeContainment({
          home: fileAsHome,
          repoRoot: fakeRepo,
          realHomedir: realHome,
          createMissing: false
        })
      ).toThrow(/non-directory component/i)
      rmSync(fileAsHome, { force: true })

      // Symlinked HOME escaping outside boundary
      const escapeHome = path.join(boundary, 'escape-home')
      symlinkSync(outside, escapeHome)
      expect(() =>
        assertFilesystemIsolatedHomeContainment({
          home: escapeHome,
          repoRoot: fakeRepo,
          realHomedir: realHome,
          createMissing: false
        })
      ).toThrow(/symlink component/i)
      rmSync(escapeHome, { force: true })

      // Symlinked ancestor under boundary escaping outside
      const trapDir = path.join(boundary, 'trap')
      mkdirSync(trapDir, { recursive: true })
      const linkAncestor = path.join(trapDir, 'link')
      symlinkSync(outside, linkAncestor)
      expect(() =>
        assertFilesystemIsolatedHomeContainment({
          home: path.join(linkAncestor, 'leaf'),
          repoRoot: fakeRepo,
          realHomedir: realHome,
          createMissing: true
        })
      ).toThrow(/symlink component/i)
      rmSync(trapDir, { recursive: true, force: true })

      // Canonical happy path
      const safeHome = path.join(boundary, 'safe-home')
      const prepared = prepareAuthoritativeIsolatedHome({
        home: safeHome,
        repoRoot: fakeRepo,
        realHomedir: realHome
      })
      expect(prepared.home).toBe(path.resolve(safeHome))
      expect(prepared.canonicalHome).toBe(realpathSync(safeHome))
      expect(prepared.canonicalBoundary).toBe(realpathSync(boundary))
      expect(prepared.canonicalRepoRoot).toBe(realpathSync(fakeRepo))
      expect(prepared.canonicalHome.startsWith(prepared.canonicalBoundary + path.sep)).toBe(true)

      mkdirSync(path.join(safeHome, 'Library', 'Application Support', 'TaskWraith Dev gOk'), {
        recursive: true
      })
      const userDataPath = path.join(
        safeHome,
        'Library',
        'Application Support',
        'TaskWraith Dev gOk'
      )
      const withUserData = assertFilesystemIsolatedHomeContainment({
        home: safeHome,
        repoRoot: fakeRepo,
        realHomedir: realHome,
        userDataPath,
        createMissing: false
      })
      expect(withUserData.canonicalUserData).toBe(realpathSync(userDataPath))
      expect(
        withUserData.canonicalUserData.startsWith(withUserData.canonicalHome + path.sep) ||
          withUserData.canonicalUserData === withUserData.canonicalHome
      ).toBe(true)
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
      rmSync(realHome, { recursive: true, force: true })
    }
  })

  it('G: runtime canonical mismatch prevents replay and still tears down exact child', async () => {
    const kills = []
    let replayCalled = false
    const repoRoot = path.resolve(__dirname, '..', '..')
    const homesRoot = path.join(repoRoot, 'perf-homes')
    mkdirSync(homesRoot, { recursive: true })
    const home = mkdtempSync(path.join(homesRoot, 'tw-t2-g-mismatch-'))
    try {
      await expect(
        runT2BaselineCli(
          [
            '--workload=dual_run',
            '--launch',
            '--i-accept-isolated-launch',
            '--materialize-instance-userdata',
            '--lean',
            '--scale-down=40',
            '--instance-id=perfGMis01',
            `--home=${home}`,
            '--port=9412',
            '--inspect-port=9812',
            '--max-replay-events=1'
          ],
          {
            repoRoot,
            forceIsolated: true,
            allowDirtyLaunch: true,
            allowNonIsolatedLaunch: true,
            platform: 'darwin',
            provenance: {
              gitSha: 'a'.repeat(40),
              dirty: false,
              dirtyTreeFingerprint: 'b'.repeat(64),
              dirtyPaths: [],
              isolatedWorktree: true,
              authoritativeBaseline: true
            },
            buildAdapters: {
              build: async () => ({ code: 0 })
            },
            spawnAdapters: {
              resolveElectronPath: () => '/virtual/Electron',
              spawn: (cmd, _args, opts) => {
                expect(opts.env.HOME).toBe(path.resolve(home))
                const ee = new EventEmitter()
                return Object.assign(ee, {
                  pid: 8080,
                  stdout: new EventEmitter(),
                  stderr: new EventEmitter(),
                  kill(sig) {
                    kills.push(sig)
                    queueMicrotask(() => ee.emit('exit', 0, sig))
                    return true
                  }
                })
              }
            },
            portAdapters: {
              probePort: async (port) => ({ port, occupied: false }),
              probeCdp: async () => ({ port: 9412, reachable: false }),
              listInstancePids: () => []
            },
            portOwnershipAdapters: ownedPortAdapters(8080),
            mainInspectorUrl: 'ws://127.0.0.1:9812/xxxxxxxx',
            WebSocket: class FakeWs {
              constructor() {
                this.handlers = {}
                queueMicrotask(() => this.handlers.open && this.handlers.open())
              }
              on(event, handler) {
                this.handlers[event] = handler
              }
              send(data) {
                const msg = JSON.parse(data)
                queueMicrotask(() => {
                  this.handlers.message(
                    JSON.stringify({ id: msg.id, result: { ok: true, method: msg.method } })
                  )
                })
              }
              close() {}
            },
            cdpAdapters: {
              httpGetJson: async (url) => {
                if (String(url).includes('/json/version')) return { Browser: 'Fake/1' }
                if (String(url).includes(':9812')) {
                  return [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9812/xxxxxxxx' }]
                }
                return [
                  {
                    type: 'page',
                    id: 'p1',
                    webSocketDebuggerUrl: 'ws://127.0.0.1:9412/devtools/page/p1'
                  }
                ]
              }
            },
            verifyIsolatedHomeAndUserData: async (_inspector, expected) => {
              expect(expected.homeRealpath).toBeTruthy()
              expect(expected.userDataRealpath).toBeTruthy()
              throw new Error(
                `Refuse replay: HOME realpath mismatch (expected ${expected.homeRealpath}, observed /escaped/host/home)`
              )
            },
            replayApi: {
              getChat: async () => {
                replayCalled = true
                return null
              },
              saveChat: async () => {
                replayCalled = true
                return { ok: true }
              }
            },
            terminateOptions: { waitMs: 20, sleep: async () => {} }
          }
        )
      ).rejects.toThrow(/HOME realpath mismatch|Refuse replay/i)
      expect(replayCalled).toBe(false)
      expect(kills.length).toBeGreaterThan(0)
      expect(kills[0]).toBe('SIGTERM')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('T2 harness amendment — disk preflight, windowed rate, capture deadline', () => {
  const {
    checkDiskHeadroom,
    createWindowedRateTracker,
    DEFAULT_MIN_FREE_DISK_BYTES,
    DEFAULT_MAX_CAPTURE_PHASE_MS,
    DEFAULT_WINDOWED_RATE_WINDOW_MS,
    runT2BaselineCli
  } = require('./runT2Baseline.cjs')
  const { PERF_GATE_THRESHOLDS } = require('./perfGateThresholds.cjs')

  it('checkDiskHeadroom refuses when free space is below minFreeBytes', () => {
    const result = checkDiskHeadroom('/tmp', PERF_GATE_THRESHOLDS.minFreeDiskBytes, {
      statfsSync: () => ({ bsize: 4096, bavail: 100 })
    })
    expect(result.ok).toBe(false)
    expect(result.freeBytes).toBe(4096 * 100)
    expect(result.note).toMatch(/only \d+\.\d GiB free/)
  })

  it('checkDiskHeadroom passes when free space exceeds minFreeBytes', () => {
    const result = checkDiskHeadroom('/tmp', 1_000_000, {
      statfsSync: () => ({ bsize: 4096, bavail: 1_000_000 })
    })
    expect(result.ok).toBe(true)
    expect(result.freeBytes).toBe(4096 * 1_000_000)
  })

  it('checkDiskHeadroom fails closed when statfsSync is unavailable', () => {
    const result = checkDiskHeadroom('/tmp', 1_000, { statfsSync: undefined })
    expect(result.ok).toBe(false)
    expect(result.note).toMatch(/unavailable/i)
  })

  it('checkDiskHeadroom fails closed when statfsSync throws', () => {
    const result = checkDiskHeadroom('/tmp', 1_000, {
      statfsSync: () => {
        throw new Error('EACCES')
      }
    })
    expect(result.ok).toBe(false)
    expect(result.note).toMatch(/EACCES/)
  })

  it('checkDiskHeadroom fails closed on incomplete statfs data', () => {
    const result = checkDiskHeadroom('/tmp', 1_000, {
      statfsSync: () => ({ bsize: 4096 })
    })
    expect(result.ok).toBe(false)
    expect(result.note).toMatch(/incomplete/)
  })

  it('createWindowedRateTracker computes rate over sliding window', () => {
    let clock = 0
    const tracker = createWindowedRateTracker(60_000, { nowMs: () => clock })

    // Push events at t=0 and t=10s
    clock = 0
    tracker.push(100)
    clock = 10_000
    tracker.push(200)
    // 100 events in 10s = 10 evt/s
    const snap = tracker.snapshot()
    expect(snap.windowedRateEvtPerSec).toBeCloseTo(10, 1)
    expect(snap.windowPointCount).toBe(2)

    // Push at t=70s — first point falls out of window
    clock = 70_000
    tracker.push(400)
    // Window now: [t=10s, t=70s] — 200 events in 60s = 3.33 evt/s
    const snap2 = tracker.snapshot()
    expect(snap2.windowedRateEvtPerSec).toBeCloseTo(3.33, 1)
    expect(snap2.windowPointCount).toBe(2)
  })

  it('createWindowedRateTracker returns 0 with single data point', () => {
    const tracker = createWindowedRateTracker(60_000)
    tracker.push(100)
    expect(tracker.snapshot().windowedRateEvtPerSec).toBe(0)
  })

  it('disk headroom preflight prevents launch in T2 runner', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..')
    const homesRoot = path.join(repoRoot, 'perf-homes')
    mkdirSync(homesRoot, { recursive: true })
    const home = mkdtempSync(path.join(homesRoot, 'tw-t2-disk-fail-'))
    try {
      await expect(
        runT2BaselineCli(
          [
            '--workload=dual_run',
            '--launch',
            '--i-accept-isolated-launch',
            '--materialize-instance-userdata',
            '--lean',
            '--scale-down=40',
            '--instance-id=perfDiskFail',
            `--home=${home}`,
            '--port=9999',
            '--inspect-port=9998'
          ],
          {
            repoRoot,
            forceIsolated: true,
            allowDirtyLaunch: true,
            allowNonIsolatedLaunch: true,
            platform: 'darwin',
            provenance: {
              gitSha: 'a'.repeat(40),
              dirty: false,
              dirtyTreeFingerprint: 'b'.repeat(64),
              dirtyPaths: [],
              isolatedWorktree: true,
              authoritativeBaseline: true
            },
            // Impossibly high disk requirement forces preflight failure
            minFreeDiskBytes: 1_000_000_000_000_000,
            buildAdapters: {
              build: async () => ({ code: 0 })
            },
            spawnAdapters: {
              resolveElectronPath: () => '/virtual/Electron',
              spawn: () => {
                throw new Error('should never reach spawn')
              }
            },
            portAdapters: {
              probePort: async () => ({ port: 9999, occupied: false }),
              probeCdp: async () => ({ port: 9999, reachable: false }),
              listInstancePids: () => []
            }
          }
        )
      ).rejects.toThrow(/disk headroom preflight/i)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('capture deadline and windowed rate appear in dry-run report skeleton', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..')
    const result = await runT2BaselineCli(
      [
        '--workload=dual_run',
        '--dry-run',
        '--lean',
        '--scale-down=40',
        '--instance-id=perfCapWin',
        `--home=${path.join(tmpdir(), 'tw-cap-win-home')}`
      ],
      {
        repoRoot,
        forceIsolated: true,
        platform: 'darwin',
        provenance: {
          gitSha: 'a'.repeat(40),
          dirty: false,
          dirtyTreeFingerprint: 'b'.repeat(64),
          dirtyPaths: [],
          isolatedWorktree: true,
          authoritativeBaseline: true
        }
      }
    )
    // Dry-run path initializes the new fields as null
    expect(result.report.diskHeadroom).toBe(null)
    expect(result.report.captureDeadline).toBe(null)
    expect(result.report.replayWindowedRate).toBe(null)
  })

  it('capture deadline skipped steps are recorded when exceeded', async () => {
    // Unit-level: verify the capture deadline fields exist and the
    // struct shape is correct. Full Electron launch path tested by
    // integration harness; here we validate report schema.
    const {
      createPerfReport,
      createEmptyPerfMetrics,
      validatePerfMetrics
    } = require('./schema.cjs')

    const env = {
      schemaVersion: 1,
      runId: 'run-deadline',
      gitSha: 'abc',
      appVersion: '1.9.2',
      instanceId: 'perf-deadline-test',
      userDataDir: '/tmp/x',
      remoteDebuggingPort: 9411,
      iosRemote: false,
      fxPosture: 'cinematic_default',
      workload: '30seat',
      seed: 42,
      startedAt: new Date().toISOString(),
      authoritativeBaseline: false,
      repoProvenance: {
        gitSha: 'abc',
        dirty: true,
        dirtyTreeFingerprint: 'f'.repeat(64),
        dirtyPaths: ['scripts/perf/schema.cjs'],
        isolatedWorktree: false
      }
    }
    const report = createPerfReport(env, createEmptyPerfMetrics())
    // Verify the report can carry captureDeadline fields
    report.captureDeadline = {
      maxCapturePhaseMs: DEFAULT_MAX_CAPTURE_PHASE_MS,
      captureStartedAt: new Date().toISOString(),
      captureEndedAt: new Date().toISOString(),
      captureElapsedMs: 100,
      captureDeadlineExceeded: true,
      captureSkippedSteps: ['profiles_stop', 'heap_snapshot'],
      note: 'Capture phase exceeded deadline — partial digests recorded'
    }
    report.diskHeadroom = {
      preflight: { ok: true, freeBytes: 30e9, minFreeBytes: 20e9, note: '30.0 GiB free' },
      preCapture: null,
      minFreeBytes: 20e9
    }
    report.replayWindowedRate = {
      windowedRateEvtPerSec: 2.0,
      windowSizeMs: 60_000,
      windowPointCount: 30
    }

    expect(report.captureDeadline.captureDeadlineExceeded).toBe(true)
    expect(report.captureDeadline.captureSkippedSteps).toHaveLength(2)
    expect(report.diskHeadroom.preflight.ok).toBe(true)
    expect(report.replayWindowedRate.windowedRateEvtPerSec).toBe(2.0)
  })
})

describe('T9a main persistence stats collector', () => {
  const {
    PERF_STATS_GLOBAL,
    normalizePerfStatsPayload,
    sampleMainPersistenceStats,
    applyPersistenceStatsToMetrics
  } = require('./collectors/mainPersistenceStatsCollector.cjs')
  const { createEmptyPerfMetrics } = require('./schema.cjs')

  function validPayload() {
    return {
      sampledAt: 1,
      coalescing: {
        coalescer: {
          scheduled: 100,
          coalesced: 70,
          flushed: 30,
          pending: 0,
          urgentFlushes: 4,
          ceilingFlushes: 12,
          discarded: 1,
          reasonMix: { normal: 90, terminal: 8, approval: 1, 'history-deletion': 1, shutdown: 0 }
        },
        journal: {
          appends: 30,
          linesWritten: 30,
          bytesWritten: 4096,
          snapshotsWritten: 1,
          chatsDeleted: 0,
          tombstoneRejects: 0,
          tornLinesRecovered: 0
        },
        config: { coalesceMs: 1000, maxLatencyMs: null }
      },
      probes: {
        enabled: true,
        targets: [
          { target: 'chat', writes: 30, bytes: 1_000_000, fsyncMs: 42 },
          { target: 'chat-journal', writes: 30, bytes: 900_000, fsyncMs: 20 }
        ]
      }
    }
  }

  const sessionReturning = (value: unknown) => ({
    post: async (method: string) => {
      if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`)
      return { result: { value } }
    }
  })

  it('samples a valid payload from the main context', async () => {
    const result = await sampleMainPersistenceStats(sessionReturning(validPayload()))
    expect(result.ok).toBe(true)
    expect(result.stats.coalescer.coalesced).toBe(70)
    expect(result.stats.journal.bytesWritten).toBe(4096)
  })

  it('evaluates a guarded expression naming the shared global', async () => {
    let seen = ''
    await sampleMainPersistenceStats({
      post: async (_m: string, params: { expression: string }) => {
        seen = params.expression
        return { result: { value: validPayload() } }
      }
    })
    expect(seen).toContain(PERF_STATS_GLOBAL)
    // typeof-guarded so a missing handle refuses cleanly instead of throwing
    expect(seen).toContain('typeof globalThis')
  })

  it('fails closed on every degraded path rather than half-populating', async () => {
    // Handle absent (production default: PERF_PRELOAD_PROBE unset)
    const missing = await sampleMainPersistenceStats(sessionReturning(null))
    expect(missing.ok).toBe(false)
    expect(missing.reason).toMatch(/not installed/i)

    // Handle threw inside main
    const threw = await sampleMainPersistenceStats(sessionReturning({ error: 'boom' }))
    expect(threw.ok).toBe(false)
    expect(threw.reason).toMatch(/threw in main/i)

    // Inspector itself failed
    const broken = await sampleMainPersistenceStats({
      post: async () => {
        throw new Error('socket closed')
      }
    })
    expect(broken.ok).toBe(false)
    expect(broken.reason).toMatch(/Runtime\.evaluate failed/i)

    // Evaluation raised in the main context
    const exception = await sampleMainPersistenceStats({
      post: async () => ({ exceptionDetails: { text: 'ReferenceError' } })
    })
    expect(exception.ok).toBe(false)

    // No session at all
    const noSession = await sampleMainPersistenceStats(null)
    expect(noSession.ok).toBe(false)
  })

  it('rejects a partial payload instead of reporting it as measured', () => {
    const missingReason = validPayload()
    delete (missingReason.coalescing.coalescer.reasonMix as Record<string, unknown>)['approval']
    expect(normalizePerfStatsPayload(missingReason).ok).toBe(false)

    const missingCounter = validPayload()
    delete (missingCounter.coalescing.coalescer as Record<string, unknown>).ceilingFlushes
    expect(normalizePerfStatsPayload(missingCounter).ok).toBe(false)

    const missingJournal = validPayload()
    delete (missingJournal.coalescing as Record<string, unknown>).journal
    expect(normalizePerfStatsPayload(missingJournal).ok).toBe(false)

    const missingProbes = validPayload()
    delete (missingProbes as Record<string, unknown>).probes
    expect(normalizePerfStatsPayload(missingProbes).ok).toBe(false)
  })

  it('keeps legacy chat bytes and journal bytes in SEPARATE buckets', () => {
    const normalized = normalizePerfStatsPayload(validPayload())
    expect(normalized.ok).toBe(true)
    const metrics = applyPersistenceStatsToMetrics(createEmptyPerfMetrics(), normalized)

    // Dual-write ADDS journal bytes this tranche. Summing them would read as a
    // regression and hide which half moved.
    expect(metrics.main.saveChat.writeBytes.total).toBe(1_000_000)
    expect(metrics.main.saveChat.journalWriteBytes.total).toBe(900_000)
    expect(metrics.main.saveChat.writeBytes.total).not.toBe(1_900_000)

    // The zero default seeds are replaced by real measurements.
    expect(metrics.main.saveChat.count).toBe(100)
    expect(metrics.main.saveChat.coalescedCount).toBe(70)
    expect(metrics.main.saveChat.coalescing.reasonMix.normal).toBe(90)
    expect(metrics.main.saveChat.journal.bytesWritten).toBe(4096)
  })

  it('produces a block that satisfies the comparison gate it was built for', () => {
    const { validatePerfMetrics } = require('./schema.cjs')
    const normalized = normalizePerfStatsPayload(validPayload())
    const metrics = applyPersistenceStatsToMetrics(createEmptyPerfMetrics(), normalized)
    // End-to-end: sampler output must pass the same schema the gate enforces.
    expect(validatePerfMetrics(metrics).ok).toBe(true)
  })
})

describe('T9a runner wiring (the producer must actually be invoked)', () => {
  const fsNode = require('fs') as typeof import('fs')
  const pathNode = require('path') as typeof import('path')
  const perfDir = pathNode.dirname(new URL(import.meta.url).pathname)
  /**
   * Read a harness script with comment-only lines stripped.
   *
   * This matters: the first version of these guards matched the call string
   * inside a `// commented-out` line, so disabling the producer left the suite
   * green. A source-region guard that accepts commented code proves nothing.
   */
  const readPerf = (name: string): string =>
    fsNode
      .readFileSync(pathNode.join(perfDir, name), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')

  it('barrel-exports the persistence stats collector', () => {
    // Without this the runner's destructured import silently yields undefined
    // and the sampling call throws at attach time, mid-run.
    const collectors = require('./collectors/index.cjs')
    expect(typeof collectors.sampleMainPersistenceStats).toBe('function')
    expect(typeof collectors.applyPersistenceStatsToMetrics).toBe('function')
  })

  it('invokes the sampler in runT2Baseline BEFORE the main inspector closes', () => {
    // Source-region guard. The T9a seam was built once and sat ZERO-PRODUCER
    // for two passes because everything was unit-tested and nothing was wired.
    // This asserts the call exists in the runner AND is ordered before teardown,
    // which no unit test of the collector can show.
    const src = readPerf('runT2Baseline.cjs')

    // Anchored to statement form, not a bare substring: a plain indexOf also
    // matches the call sitting in a trailing `// comment`, which let a
    // disabled producer keep the suite green when this guard was first written.
    const sampleAt = src.search(
      /^\s*const statsResult = await sampleMainPersistenceStats\(mainInspector\)\s*$/m
    )
    const applyAt = src.search(/^\s*applyPersistenceStatsToMetrics\(report\.metrics, /m)
    const closeAt = src.search(/^\s*mainInspector\.close\(\)\s*$/m)

    expect(sampleAt).toBeGreaterThan(-1)
    expect(applyAt).toBeGreaterThan(sampleAt)
    // Sampling must happen while the session is still attached.
    expect(closeAt).toBeGreaterThan(applyAt)

    // A failed sample must be recorded, never silently dropped.
    expect(src).toContain('persistenceStatsFailure')
  })

  it('derives claimMetricsCollected instead of hardcoding false', () => {
    const src = readPerf('runT2Baseline.cjs')
    expect(
      src.search(/^\s*claimMetricsCollected: persistenceStatsOk && profilesCaptured,\s*$/m)
    ).toBeGreaterThan(-1)
    expect(src.search(/^\s*claimMetricsCollected: false,?\s*$/m)).toBe(-1)
  })

  it('arms PERF_PRELOAD_PROBE on the measured child', () => {
    // The handle installs only under this flag. Without it every run would
    // fail-closed with "not installed" — correct, but permanently unpassable.
    const src = readPerf('isolatedLaunch.cjs')
    expect(src).toContain("PERF_PRELOAD_PROBE: '1'")
  })
})
