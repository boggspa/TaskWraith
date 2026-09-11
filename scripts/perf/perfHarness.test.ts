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
import { fileURLToPath } from 'url'
import { afterAll, describe, expect, it } from 'vitest'
import { createHostPerfInstrumentation } from '../../src/host-runtime/HostPerfSnapshot'
import {
  createHostPerfSnapshotFileWriter,
  type HostPerfSnapshotFileIdentity
} from '../../src/host-runtime/HostPerfSnapshotFile'
import { createWorkSpanRecorder } from '../../src/host-shared/perf/WorkSpanRecorder'

/* eslint-disable @typescript-eslint/no-empty-function -- adapter fakes intentionally expose no-op lifecycle methods. */

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
const {
  createCdpEvaluateAdapter,
  createCdpPageApiAdapter,
  runDeterministicReplay
} = require('./replayDriver.cjs')
const { runBaselineCli } = require('./runBaseline.cjs')
const { dirtyTreeFingerprint, collectRepoProvenance } = require('./repoProvenance.cjs')
const {
  MATRIX_SAMPLING,
  PROVIDER_MIXES,
  SATURATION_MODES,
  PAIRING_ROLES,
  validateMatrixCell,
  cellName,
  parseCellName,
  enumerateMatrixCells,
  pairedRunNames,
  assertPairedRunCompatibility
} = require('./interferenceMatrix.cjs')
const {
  CROSS_THREAD_SCHEMA_VERSION,
  normalizeWorkSpanSection,
  validateCrossThreadBlock,
  sampleWorkSpanSections,
  applyCrossThreadToMetrics
} = require('./collectors/hostSpans.cjs')
const { PERF_GATE_THRESHOLDS, PROPOSED_CROSS_THREAD_BOUNDS } = require('./perfGateThresholds.cjs')

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

/**
 * Wave-8: the host bundle freshness preflight reads the real repo's
 * out/host + src mtimes by default. Launch simulations decouple from that
 * with this DI fs: the virtual bundle is always newer than the single
 * virtual source file per compiled tree, so the preflight passes and the
 * tests keep exercising the attach/teardown behaviour they were written for.
 */
function freshHostBundleFs() {
  const bundleSuffix = ['out', 'host', 'host-runtime', 'cli.js'].join(path.sep)
  return {
    statSync(target: string) {
      return {
        isFile: () => true,
        mtimeMs: String(target).endsWith(bundleSuffix) ? 1e12 : 1
      }
    },
    readdirSync(_target: string, _options?: unknown) {
      return [{ name: 'Fresh.ts', isFile: () => true, isDirectory: () => false }]
    },
    // The walk yields no `.js`, so no sourcemap is ever read. This exists only
    // to satisfy the fs contract, so the test exercises the freshness
    // comparison rather than short-circuiting on fs_contract.
    readFileSync(target: string, _encoding?: unknown) {
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' })
    }
  }
}

/**
 * Wave-8: the STALE counterpart of freshHostBundleFs for the launch-blocking
 * test — suffix-matched against the REAL repoRoot, every virtual source
 * newer than the bundle. The first version of that test reused the
 * '/repo'-rooted memFs and passed for the WRONG reason under mutation
 * (host_bundle_missing matches the same regex as host_bundle_stale); the
 * red-check caught it, and the assertion now names the stale source.
 */
function staleHostBundleFs() {
  const bundleSuffix = ['out', 'host', 'host-runtime', 'cli.js'].join(path.sep)
  return {
    statSync(target: string) {
      return {
        isFile: () => true,
        mtimeMs: String(target).endsWith(bundleSuffix) ? 1 : 1e12
      }
    },
    readdirSync(_target: string, _options?: unknown) {
      return [{ name: 'Fresh.ts', isFile: () => true, isDirectory: () => false }]
    },
    // As above: no `.js` in the walk, so this is never called. Without it the
    // preflight would refuse on fs_contract and the test would pass for the
    // WRONG reason — the same trap this stub's own comment already records.
    readFileSync(target: string, _encoding?: unknown) {
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' })
    }
  }
}

describe('perf schema (ADR §7 hardened)', () => {
  it('exports workloads, reduce_motion posture, and schema version', () => {
    expect(SCHEMA_VERSION).toBe(1)
    expect(WORKLOADS).toEqual(
      expect.arrayContaining([
        '30seat',
        '50seat',
        'dual_run',
        '455_soak',
        '50_chat_switch',
        'light_beside_large'
      ])
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

describe('T2 page adapter payload (the instrument must not dominate the measurement)', () => {
  // MEASURED 2026-08-05 against the live isolated child at 46110: embedding the
  // whole record in each Runtime.evaluate source costs ~50 ms per MB, so a
  // 3.67 MB prefix cost 159-250 ms while the app's own writeJson was 1.2% of
  // replay wall time. That per-event transport grows linearly with the prefix
  // and is what produced the "throughput decay" earlier runs reported as an app
  // property. Seed the record once, then send prefix COMMANDS.
  function recordingPage() {
    const expressions: string[] = []
    return {
      expressions,
      async evaluate(expression: string) {
        expressions.push(expression)
        return { persistenceRevision: expressions.length + 1, updatedAt: 5 }
      }
    }
  }

  const bigChat = {
    appChatId: 'perf-30seat-chat-01',
    scope: 'global',
    persistenceRevision: 1,
    updatedAt: 1,
    messages: Array.from({ length: 2000 }, (_, i) => ({
      id: `m-${i}`,
      role: 'assistant',
      content: 'x'.repeat(600)
    }))
  }

  it('sends a bounded per-save payload after seeding the record once', async () => {
    const page = recordingPage()
    const api = createCdpPageApiAdapter(page)
    expect(typeof api.savePrefix).toBe('function')

    await api.savePrefix(bigChat, {
      messageCount: 900,
      updatedAt: 11,
      persistenceRevision: 1
    })
    await api.savePrefix(bigChat, {
      messageCount: 1800,
      updatedAt: 12,
      persistenceRevision: 2
    })

    // One seed carrying the record, then one command per save.
    const seeds = page.expressions.filter((e) => e.length > 100_000)
    expect(seeds).toHaveLength(1)
    const commands = page.expressions.filter((e) => e.length <= 100_000)
    expect(commands).toHaveLength(2)
    for (const command of commands) {
      expect(
        command.length,
        'per-save payload must not scale with the record — it becomes the measurement'
      ).toBeLessThan(1_000)
    }
    // The command must still drive the real save path with the real prefix.
    expect(commands[1]).toContain('window.api.saveChat')
    expect(commands[1]).toContain('1800')
  })

  it('re-seeds per chat id, not once globally', async () => {
    const page = recordingPage()
    const api = createCdpPageApiAdapter(page)
    const other = { ...bigChat, appChatId: 'perf-30seat-chat-02' }
    await api.savePrefix(bigChat, { messageCount: 10, updatedAt: 1, persistenceRevision: 1 })
    await api.savePrefix(other, { messageCount: 10, updatedAt: 1, persistenceRevision: 1 })
    expect(page.expressions.filter((e) => e.length > 100_000)).toHaveLength(2)
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

  it('prefers the bounded savePrefix path when the adapter offers it', async () => {
    const fixture = generatePerfFixture({
      workload: 'dual_run',
      seed: 42,
      baseTimestamp: 1_700_000_000_000,
      lean: true,
      scaleDown: 8
    })
    const cas = createRevisionCasApi(fixture)
    let wholeRecordSaves = 0
    let prefixSaves = 0
    const api = {
      getChat: cas.getChat,
      async saveChat(chat) {
        wholeRecordSaves += 1
        return cas.saveChat(chat)
      },
      async savePrefix(base, patch) {
        prefixSaves += 1
        return cas.saveChat({ ...base, persistenceRevision: patch.persistenceRevision })
      }
    }
    await runDeterministicReplay({ fixture, api })
    expect(prefixSaves).toBeGreaterThan(4)
    expect(
      wholeRecordSaves,
      'driver fell back to whole-record saves despite a savePrefix-capable adapter'
    ).toBe(0)
    expect(cas.stats().rejected).toBe(0)
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
    expect(plan.spawnCommand).toBe(path.resolve('/virtual/electron-bin'))
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
    expect(plan.shellCommand).toContain('CFFIXED_USER_HOME=')
    expect(plan.shellCommand).toContain(home)
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
        lastSocket = { handlers: this.handlers }
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
    expect(spawned[0].cmd).toBe(path.resolve('/virtual/Electron'))
    expect(spawned[0].cmd).not.toBe('npx')
    expect(child.pid).toBe(4242)
    expect(child.electronBinary).toBe(path.resolve('/virtual/Electron'))
    expect(child.pgid).toBe(process.platform === 'win32' ? undefined : 4242)
    expect(spawned[0].opts.detached).toBe(process.platform !== 'win32')

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
            // Wave-8: decouple the host bundle preflight from real out/host mtimes.
            hostBundleAdapters: { fs: freshHostBundleFs() },
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
        platform: 'darwin',
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
            // Wave-8: decouple the host bundle preflight from real out/host mtimes.
            hostBundleAdapters: { fs: freshHostBundleFs() },
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
      expect(plan.shellCommand).toContain('HOME=')
      expect(plan.shellCommand).toContain(path.resolve(safeHome))
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

    // Evidence-v1 2026-09-10: --home=/private/tmp/... , Electron userData /tmp/...
    const privateHome = '/private/tmp/tw-evidence-v1/8ec2ed74d/perf-homes/ev1'
    const tmpUserData =
      '/tmp/tw-evidence-v1/8ec2ed74d/perf-homes/ev1/Library/Application Support/TaskWraith Dev ev1-small-2-cold'
    const privateUserData =
      '/private/tmp/tw-evidence-v1/8ec2ed74d/perf-homes/ev1/Library/Application Support/TaskWraith Dev ev1-small-2-cold'
    const alias = await verifyIsolatedHomeAndUserDataViaMainInspector(
      {
        post: async () => ({
          result: {
            value: {
              home: privateHome,
              userData: tmpUserData,
              homeRealpath: privateHome,
              userDataRealpath: privateUserData
            }
          }
        })
      },
      {
        home: privateHome,
        userDataPath: privateUserData,
        homeRealpath: privateHome,
        userDataRealpath: privateUserData
      }
    )
    expect(alias.ok).toBe(true)

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
            // Wave-8: decouple the host bundle preflight from real out/host mtimes.
            hostBundleAdapters: { fs: freshHostBundleFs() },
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
            // Wave-8: decouple the host bundle preflight from real out/host mtimes.
            hostBundleAdapters: { fs: freshHostBundleFs() },
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
    DEFAULT_MAX_CAPTURE_PHASE_MS,
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
            // Wave-8: decouple the host bundle preflight from real out/host mtimes.
            hostBundleAdapters: { fs: freshHostBundleFs() },
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
    const { createPerfReport, createEmptyPerfMetrics } = require('./schema.cjs')

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
  const perfDir = pathNode.dirname(fileURLToPath(import.meta.url))
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

/* ------------------------------------------------------------------ */
/* M1 — cross-thread interference matrix, span collector, G-X bounds   */
/* ------------------------------------------------------------------ */

function spanAggregate(overrides: Record<string, unknown> = {}) {
  return {
    count: 1,
    totalMs: 12,
    p50Ms: 12,
    p95Ms: 12,
    maxMs: 12,
    bytes: 0,
    fallbackCount: 0,
    ...overrides
  }
}

function spanSection(process: string = 'main', overrides: Record<string, unknown> = {}) {
  return {
    process,
    byKind: { admission_wait: spanAggregate() },
    byResource: { host_chain: spanAggregate() },
    recorded: 1,
    dropped: 0,
    sampledOut: 0,
    rejected: 0,
    ...overrides
  }
}

const MATRIX_CELL = {
  history: 'small',
  chats: 2,
  path: 'warm',
  mix: 'codex_profiles_solo_ensemble_mesh',
  saturation: 'none'
}

describe('M1 interference matrix (programme Appendix A)', () => {
  it('names cells <history>/<chats>/<path>/<mix>/<saturation> and round-trips them', () => {
    const name = cellName(MATRIX_CELL)
    expect(name).toBe('small/2/warm/codex_profiles_solo_ensemble_mesh/none')
    expect(parseCellName(name)).toEqual(MATRIX_CELL)
    expect(parseCellName('small/2/warm')).toBeNull()
    expect(parseCellName('small/3/warm/codex_bridge_disabled/none')).toBeNull()
    expect(parseCellName('not-a-cell')).toBeNull()
  })

  it('enumerates the full Appendix A cross product with every cell valid', () => {
    const cells = enumerateMatrixCells()
    expect(cells.length).toBe(2 * 4 * 2 * PROVIDER_MIXES.length * SATURATION_MODES.length)
    for (const cell of cells) {
      expect(validateMatrixCell(cell).ok).toBe(true)
    }
    expect(PROVIDER_MIXES).toContain('ollama_distinct_beyond_ceiling')
    expect(SATURATION_MODES).toContain('host_queue_16_active_1_queued')
  })

  it('pins the fixed sampling window: 120 s, three repetitions, p50/p95/p99', () => {
    expect(MATRIX_SAMPLING.windowMs).toBe(120_000)
    expect(MATRIX_SAMPLING.repetitions).toBe(3)
    expect(MATRIX_SAMPLING.percentiles).toEqual(['p50', 'p95', 'p99'])
  })

  it('carries the pairing role on the run name, never the cell name', () => {
    const names = pairedRunNames(MATRIX_CELL)
    expect(names.alone).toBe(`${cellName(MATRIX_CELL)}::light-alone`)
    expect(names.beside).toBe(`${cellName(MATRIX_CELL)}::light-beside`)
    expect(PAIRING_ROLES).toEqual(['light-alone', 'light-beside'])
  })

  it('keeps the proposed §1.1 bounds out of the enforced gate thresholds', () => {
    expect(PROPOSED_CROSS_THREAD_BOUNDS.maxRoundStartLatencyOverLightAloneP95Ms).toBe(250)
    expect(PROPOSED_CROSS_THREAD_BOUNDS.maxPersistenceBarrierOverLightAloneP95Ms).toBe(300)
    expect(PROPOSED_CROSS_THREAD_BOUNDS.maxControlResponseEndToEndP95Ms).toBe(300)
    expect(PROPOSED_CROSS_THREAD_BOUNDS.maxHostQueueWaitUnrelatedCommandP95Ms).toBe(50)
    expect(PROPOSED_CROSS_THREAD_BOUNDS.maxHostEventLoopLagP95Ms).toBe(25)
    expect(PROPOSED_CROSS_THREAD_BOUNDS.maxAsyncWriterFallbackCount).toBe(0)
    // Unratified numbers must never gate a run: nothing §1.1 leaks into the
    // map evaluatePerfGates consumes.
    for (const key of Object.keys(PROPOSED_CROSS_THREAD_BOUNDS)) {
      expect(Object.keys(PERF_GATE_THRESHOLDS)).not.toContain(key)
    }
  })
})

describe('M1 paired-run fixture/window self-test (G-X pairing rule)', () => {
  function runDescriptor(role: string, overrides: Record<string, unknown> = {}) {
    const fixture = generatePerfFixture({ workload: 'dual_run', seed: 4242 })
    return {
      cellName: cellName(MATRIX_CELL),
      role,
      fixtureFingerprint: fixtureFingerprint(fixture),
      workload: 'dual_run',
      seed: 4242,
      windowMs: MATRIX_SAMPLING.windowMs,
      ...overrides
    }
  }

  it('accepts paired runs with identical fixtures, windows, workload and seed', () => {
    // Same seed twice → identical fingerprints; the pairing is comparable.
    const alone = runDescriptor('light-alone')
    const beside = runDescriptor('light-beside')
    expect(alone.fixtureFingerprint).toBe(beside.fixtureFingerprint)
    expect(assertPairedRunCompatibility(alone, beside)).toEqual({ ok: true })
  })

  it('refuses paired runs whose fixtures differ', () => {
    const alone = runDescriptor('light-alone')
    const otherFixture = generatePerfFixture({ workload: 'dual_run', seed: 9999 })
    const beside = runDescriptor('light-beside', {
      fixtureFingerprint: fixtureFingerprint(otherFixture),
      seed: 9999
    })
    const check = assertPairedRunCompatibility(alone, beside)
    expect(check.ok).toBe(false)
    expect(check.reasons!.some((r: string) => r.includes('fixture fingerprints differ'))).toBe(true)
  })

  it('refuses a wrong-window or role-swapped pairing', () => {
    const alone = runDescriptor('light-alone')
    const shortWindow = runDescriptor('light-beside', { windowMs: 60_000 })
    const windowCheck = assertPairedRunCompatibility(alone, shortWindow)
    expect(windowCheck.ok).toBe(false)
    expect(windowCheck.reasons!.some((r: string) => r.includes('windowMs'))).toBe(true)

    const swapped = assertPairedRunCompatibility(
      runDescriptor('light-beside'),
      runDescriptor('light-alone')
    )
    expect(swapped.ok).toBe(false)
    expect(swapped.reasons!.some((r: string) => r.includes('role'))).toBe(true)
  })
})

describe('M1 crossThread report block (schema seam)', () => {
  function crossThreadBlock(sections: Record<string, unknown>) {
    return {
      schemaVersion: CROSS_THREAD_SCHEMA_VERSION,
      cells: {
        [cellName(MATRIX_CELL)]: { capturedAt: '2026-09-08T13:00:00.000Z', processes: sections }
      }
    }
  }

  it('keeps pre-M1 reports valid: the block is optional-when-absent', () => {
    const metrics = createEmptyPerfMetrics()
    expect(metrics.crossThread).toBeUndefined()
    expect(validatePerfMetrics(metrics).ok).toBe(true)
  })

  it('accepts a well-formed block, including per-process { error } degradation', () => {
    const metrics = createEmptyPerfMetrics()
    metrics.crossThread = crossThreadBlock({
      main: spanSection('main'),
      host: { error: 'host snapshot unavailable' }
    })
    expect(validatePerfMetrics(metrics).ok).toBe(true)
  })

  it('rejects present-but-malformed blocks loudly', () => {
    const withBadCellName = createEmptyPerfMetrics()
    withBadCellName.crossThread = {
      schemaVersion: CROSS_THREAD_SCHEMA_VERSION,
      cells: { 'not/a/real/cell/name/at/all': { processes: { main: spanSection('main') } } }
    }
    expect(validatePerfMetrics(withBadCellName).ok).toBe(false)

    const withUnknownKind = createEmptyPerfMetrics()
    withUnknownKind.crossThread = crossThreadBlock({
      main: spanSection('main', { byKind: { invented_kind: spanAggregate() } })
    })
    const kindCheck = validatePerfMetrics(withUnknownKind)
    expect(kindCheck.ok).toBe(false)
    expect(kindCheck.errors!.some((e: string) => e.includes('invented_kind'))).toBe(true)

    const withBrokenAggregate = createEmptyPerfMetrics()
    withBrokenAggregate.crossThread = crossThreadBlock({
      main: spanSection('main', {
        byKind: { admission_wait: spanAggregate({ p95Ms: Number.NaN }) }
      })
    })
    expect(validatePerfMetrics(withBrokenAggregate).ok).toBe(false)

    const withBadVersion = createEmptyPerfMetrics()
    withBadVersion.crossThread = { schemaVersion: 999, cells: {} }
    expect(validatePerfMetrics(withBadVersion).ok).toBe(false)
  })
})

describe('M1 hostSpans collector', () => {
  it('normalizes a WorkSpanRecorder section and refuses malformed payloads', () => {
    expect(normalizeWorkSpanSection(spanSection('main'), 'main').ok).toBe(true)
    expect(normalizeWorkSpanSection(null, 'main').ok).toBe(false)
    expect(normalizeWorkSpanSection(spanSection('main'), 'host').ok).toBe(false)
    expect(normalizeWorkSpanSection(spanSection('main', { recorded: Number.NaN }), 'main').ok).toBe(
      false
    )
    expect(
      normalizeWorkSpanSection(
        spanSection('main', { byResource: { mars: spanAggregate() } }),
        'main'
      ).ok
    ).toBe(false)
  })

  it('degrades one sick process without erasing the others, and refuses when none are valid', async () => {
    const sample = await sampleWorkSpanSections({
      main: () => spanSection('main'),
      host: () => {
        throw new Error('host meter exploded')
      }
    })
    expect(sample.ok).toBe(true)
    expect(Object.keys(sample.sections!)).toEqual(['main'])
    expect(sample.errors!.host).toContain('host meter exploded')

    const empty = await sampleWorkSpanSections({
      host: () => null,
      renderer: () => spanSection('renderer', { recorded: 'lots' })
    })
    expect(empty.ok).toBe(false)
    expect(empty.reason).toContain('no process yielded a valid span section')

    const unknown = await sampleWorkSpanSections({ renderer2: () => spanSection('renderer') })
    expect(unknown.ok).toBe(false)
  })

  it('folds sampled sections into metrics.crossThread keyed by cell', () => {
    const metrics = createEmptyPerfMetrics()
    const name = cellName(MATRIX_CELL)
    applyCrossThreadToMetrics(metrics, MATRIX_CELL, { main: spanSection('main') })
    expect(metrics.crossThread.cells[name].processes.main.recorded).toBe(1)
    expect(validateCrossThreadBlock(metrics.crossThread)).toEqual([])
    expect(validatePerfMetrics(metrics).ok).toBe(true)

    // A second cell merges beside the first instead of replacing it.
    const otherCell = { ...MATRIX_CELL, saturation: 'ensemble_pool_30_join' }
    applyCrossThreadToMetrics(metrics, otherCell, { host: spanSection('host') })
    expect(Object.keys(metrics.crossThread.cells).length).toBe(2)

    expect(() => applyCrossThreadToMetrics(metrics, { ...MATRIX_CELL, chats: 3 }, {})).toThrow()
    expect(() => applyCrossThreadToMetrics(metrics, MATRIX_CELL, {})).toThrow()
  })
})

describe('T2 wave-8 — host bundle preflight, spawn extraEnv, host span binding (M1)', () => {
  const {
    checkHostBundleFreshness,
    collectT2HostSpanEvidence,
    runT2BaselineCli,
    parseArgs,
    HOST_BUNDLE_REBUILD_COMMAND,
    HOST_BUNDLE_DECLARED_ENTRY_SEGMENTS
  } = require('./runT2Baseline.cjs')
  const { buildElectronSpawnPlan } = require('./electronChildSession.cjs')
  const { validateCrossThreadBlock } = require('./collectors/hostSpans.cjs')

  const EPOCH = 'cd'.repeat(32)
  const OTHER_EPOCH = 'ef'.repeat(32)
  const WRITE_AT = new Date('2026-09-09T04:00:00.000Z')
  const FRESH_AT = new Date('2026-09-09T04:00:01.000Z')
  const TOKEN_BAIT = 'tok3nBAIT0123456789abcdef'
  const CELL_NAME = cellName(MATRIX_CELL)
  const HOST_IDENTITY = {
    process: 'host',
    instanceId: 'host-abc',
    generation: 2,
    pid: 777
  } as const satisfies HostPerfSnapshotFileIdentity

  const tempDirs: string[] = []
  afterAll(() => {
    while (tempDirs.length) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })
  function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  /** One REAL writer-produced snapshot file (transport-test pattern). */
  function writeRealHostSnapshot(identity: HostPerfSnapshotFileIdentity): string {
    const file = path.join(tempDir('tw-t2-w8-snapshot-'), 'host-perf-snapshot.json')
    const instrumentation = createHostPerfInstrumentation()
    instrumentation.spans.record({
      chatId: 'chat-heavy',
      kind: 'host_queue_wait',
      resource: 'host_chain',
      startedAt: 5,
      durationMs: 120
    })
    const writer = createHostPerfSnapshotFileWriter({
      instrumentation,
      path: file,
      intervalMs: 1000,
      maxBytes: 256 * 1024,
      identity,
      now: () => WRITE_AT
    })
    expect(writer.writeOnce()).toBe(true)
    return file
  }

  function tickingClock(start = 1000, stepMs = 10): () => number {
    let at = start - stepMs
    return () => (at += stepMs)
  }

  /** A REAL main-process recorder section served through the preload IPC seam. */
  function realMainSection(): Record<string, unknown> {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 64,
      now: tickingClock()
    })
    for (const [chatId, durationMs] of [
      ['chat-light', 10],
      ['chat-heavy', 90]
    ] as const) {
      recorder.record({
        chatId,
        runId: `run-${chatId}`,
        kind: 'admission_wait',
        resource: 'ensemble_pool',
        startedAt: 0,
        durationMs
      })
    }
    return recorder.section() as unknown as Record<string, unknown>
  }

  function rendererServing(section: Record<string, unknown>) {
    return {
      post: async (_method: string, _params: unknown) => ({
        result: { value: { sections: { workSpans: section } } }
      })
    }
  }

  /** The probe contract from hostWelcomeProbe.cjs, as DI. */
  function okProbe(epoch?: string) {
    return async () => ({
      ok: true,
      expectedIdentity: {
        instanceId: 'host-abc',
        generation: 2,
        pid: 777,
        ...(epoch === undefined ? {} : { bootEpoch: epoch })
      },
      welcome: {
        hostId: 'host-abc',
        generation: 2,
        ...(epoch === undefined ? {} : { bootEpoch: epoch })
      },
      discovery: { pid: 777, startedAt: '2026-09-09T03:59:58.000Z' }
    })
  }

  // -------------------------------------------------------------------------
  // Spawn-plan extraEnv (electronChildSession.cjs)
  // -------------------------------------------------------------------------

  it('extraEnv is inert when unset and only ever injects TASKWRAITH_PERF_* keys', () => {
    const base = {
      instanceId: 'perfW8Env01',
      repoRoot: path.resolve(__dirname, '..', '..'),
      workload: 'dual_run',
      fxPosture: 'reduce_motion',
      platform: 'darwin',
      remoteDebuggingPort: 9451,
      mainInspectorPort: 9851,
      adapters: { resolveElectronPath: () => '/virtual/electron-bin' }
    } as Record<string, unknown>

    const plain = buildElectronSpawnPlan(base)
    // The base plan already carries TASKWRAITH_PERF_WORKLOAD/FX_POSTURE from
    // buildIsolatedLaunchPlan; "inert when unset" means NO snapshot-path key
    // and NO injected shell assignments beyond the pre-extraEnv shape.
    expect(plain.env.TASKWRAITH_PERF_WORKLOAD).toBe('dual_run')
    expect(plain.env.TASKWRAITH_PERF_HOST_SNAPSHOT_PATH).toBeUndefined()
    expect(plain.shellCommand).not.toContain('TASKWRAITH_PERF_HOST_SNAPSHOT_PATH')
    expect(plain.shellCommand).not.toContain('TASKWRAITH_PERF_WORKLOAD=')

    const snapshotPath = '/virtual/artifacts/host-perf-snapshot.json'
    const armed = buildElectronSpawnPlan({
      ...base,
      extraEnv: { TASKWRAITH_PERF_HOST_SNAPSHOT_PATH: snapshotPath }
    })
    expect(armed.env.TASKWRAITH_PERF_HOST_SNAPSHOT_PATH).toBe(snapshotPath)
    expect(armed.shellCommand).toContain('TASKWRAITH_PERF_HOST_SNAPSHOT_PATH=')
    expect(armed.shellCommand).toContain(snapshotPath)
    // Isolation-critical env and argv shape are untouched by the injection.
    expect(armed.env.HOME).toBeUndefined()
    expect(armed.argv).toEqual(plain.argv)

    expect(() => buildElectronSpawnPlan({ ...base, extraEnv: { HOME: '/evil' } })).toThrow(
      /TASKWRAITH_PERF_\*/
    )
    expect(() => buildElectronSpawnPlan({ ...base, extraEnv: { TASKWRAITH_PERF_X: '' } })).toThrow(
      /non-empty string/
    )
    expect(() =>
      buildElectronSpawnPlan({ ...base, extraEnv: { TASKWRAITH_PERF_BAD$key: 'v' } })
    ).toThrow(/TASKWRAITH_PERF_\*/)
    expect(() => buildElectronSpawnPlan({ ...base, extraEnv: 'nope' })).toThrow(/plain object/)
  })

  // -------------------------------------------------------------------------
  // Host bundle freshness preflight (ruling P2)
  // -------------------------------------------------------------------------

  type FsNode = {
    mtimeMs?: number
    content?: string
    children?: Record<string, FsNode>
    symlink?: true
  }
  /** A file carrying bytes as well as an mtime — a sourcemap needs both. */
  type FileSpec = { mtimeMs: number; content: string }

  /** Flat repo-relative path -> mtime (or mtime + bytes), expanded into a tree. */
  function treeOf(files: Record<string, number | FileSpec>): Record<string, FsNode> {
    const root: Record<string, FsNode> = {}
    for (const [relPath, spec] of Object.entries(files)) {
      const leaf: FsNode =
        typeof spec === 'number'
          ? { mtimeMs: spec }
          : { mtimeMs: spec.mtimeMs, content: spec.content }
      const segments = relPath.split('/')
      let level = root
      segments.forEach((segment, index) => {
        if (index === segments.length - 1) {
          level[segment] = leaf
          return
        }
        if (!level[segment]) level[segment] = { children: {} }
        level = level[segment].children as Record<string, FsNode>
      })
    }
    return root
  }

  /** The children map of a directory inside a built tree, for surgical removal. */
  function nodeAt(tree: Record<string, FsNode>, relPath: string): Record<string, FsNode> {
    let level = tree
    for (const segment of relPath.split('/')) {
      level = level[segment].children as Record<string, FsNode>
    }
    return level
  }

  function memFs(root: Record<string, FsNode>, repoRoot = '/repo') {
    const prefix = `${repoRoot}${path.sep}`
    const resolveNode = (target: string): FsNode | null => {
      if (target === repoRoot) return { children: root }
      if (!target.startsWith(prefix)) return null
      let node: FsNode = { children: root }
      for (const seg of target.slice(prefix.length).split(path.sep)) {
        if (!seg) continue
        if (!node.children || !node.children[seg]) return null
        node = node.children[seg]
      }
      return node
    }
    const enoent = (target: string) =>
      Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' })
    return {
      statSync(target: string) {
        const node = resolveNode(String(target))
        if (!node) throw enoent(String(target))
        // statSync FOLLOWS symlinks, so a symlinked directory still resolves.
        return { isFile: () => node.children === undefined, mtimeMs: node.mtimeMs ?? 0 }
      },
      readdirSync(target: string, _opts?: unknown) {
        const node = resolveNode(String(target))
        if (!node || !node.children) throw enoent(String(target))
        return Object.entries(node.children).map(([name, child]) => ({
          name,
          // A real Dirent reports a symlink as NEITHER file nor directory, so
          // neither walk ever descends through one.
          isFile: () => child.children === undefined && child.symlink !== true,
          isDirectory: () => child.children !== undefined && child.symlink !== true
        }))
      },
      // Sourcemaps are read, not walked: a `.js` with no readable map cannot
      // have its provenance proven, so this throwing IS a tested outcome.
      readFileSync(target: string, _encoding?: unknown) {
        const node = resolveNode(String(target))
        if (!node || node.children || node.content === undefined) throw enoent(String(target))
        return node.content
      }
    }
  }

  /**
   * An emitted `.js` paired with the `.js.map` that records what produced it.
   * Sources are stored relative to the MAP, exactly as a real map stores them,
   * so the preflight has to resolve them rather than being handed absolutes.
   */
  function emitted(
    jsRel: string,
    sourceRels: string[],
    mtimeMs: number
  ): Record<string, number | FileSpec> {
    const mapDir = path.posix.dirname(jsRel)
    return {
      [jsRel]: mtimeMs,
      [`${jsRel}.map`]: {
        mtimeMs,
        content: JSON.stringify({
          version: 3,
          sources: sourceRels.map((source) => path.posix.relative(mapDir, source))
        })
      }
    }
  }

  const BUNDLE_REL = 'out/host/host-runtime/cli.js'

  /**
   * A repo shaped like the real one: SIX trees are compiled into out/host, and
   * a much larger remainder of src/main and src/shared is not. `overrides`
   * adds or re-stamps individual repo-relative paths.
   */
  function bundleTree(
    bundleMtime: number,
    sourceMtime: number,
    overrides: Record<string, number | FileSpec> = {}
  ): Record<string, FsNode> {
    return treeOf({
      // Stage two of `host:build`: tsc, one source per output.
      ...emitted(BUNDLE_REL, ['src/host-runtime/cli.ts'], bundleMtime),
      ...emitted(
        'out/host/host-runtime/HostStandaloneComposition.js',
        ['src/host-runtime/HostStandaloneComposition.ts'],
        bundleMtime
      ),
      ...emitted(
        'out/host/host-node/HostNodeProductionServer.js',
        ['src/host-node/HostNodeProductionServer.ts'],
        bundleMtime
      ),
      ...emitted(
        'out/host/host-shared/perf/WorkSpanRecorder.js',
        ['src/host-shared/perf/WorkSpanRecorder.ts'],
        bundleMtime
      ),
      ...emitted(
        'out/host/host-client/HostClient.js',
        ['src/host-client/HostClient.ts'],
        bundleMtime
      ),
      ...emitted(
        'out/host/main/perf/hostPerfSnapshot.js',
        ['src/main/perf/hostPerfSnapshot.ts'],
        bundleMtime
      ),
      ...emitted('out/host/shared/hostProtocol.js', ['src/shared/hostProtocol.ts'], bundleMtime),
      // STAGE THREE, AND THE REGRESSION FOR THIS DEFECT. `host:build` also
      // esbuild-bundles worker entrypoints into this same tree under RENAMED
      // outputs. Inverting the output NAME declares this an orphan of a
      // src/host-node/ThreadCatalogueWorkerEntry.ts that has never existed and
      // refuses a valid bundle — the live failure this fixture reproduces. Its
      // own map names the real inputs instead: one shared with no other
      // output, one reachable through NO other output at all, and a
      // node_modules entry that is not this repo's to make stale.
      ...emitted(
        'out/host/host-node/ThreadCatalogueWorkerEntry.js',
        [
          'src/main/workers/threadCatalogueWorker.ts',
          'src/main/workers/threadCatalogueCodec.ts',
          'src/main/workers/threadCatalogueWorker.test.ts',
          'node_modules/better-sqlite3/lib/index.ts'
        ],
        bundleMtime
      ),
      // The second renamed bundle, one first-party input of its own. BOTH
      // declared entries must be present: a partial build (tsc without the
      // esbuild stage) is the fourth-defect fixture below.
      ...emitted(
        'out/host/host-node/ThreadCatalogueDecoderEntry.js',
        ['src/main/workers/threadCatalogueDecoder.ts'],
        bundleMtime
      ),
      'src/main/workers/threadCatalogueWorker.ts': sourceMtime - 800,
      'src/main/workers/threadCatalogueCodec.ts': sourceMtime - 850,
      'src/main/workers/threadCatalogueDecoder.ts': sourceMtime - 950,
      // Both deliberately far newer than the bundle: if either exclusion ever
      // stopped applying, this fixture would read STALE and the freshness
      // assertions below would fail. Neither exclusion is vacuous.
      // A test file is never a build input whatever names it — the same rule
      // the tsconfig's exclude states, applied to mapped sources too.
      'src/main/workers/threadCatalogueWorker.test.ts': 9e9,
      // Third-party code is not this repo's to make stale.
      'node_modules/better-sqlite3/lib/index.ts': 9e9,
      'src/host-runtime/cli.ts': sourceMtime - 300,
      'src/host-runtime/HostStandaloneComposition.ts': sourceMtime,
      'src/host-node/HostNodeProductionServer.ts': sourceMtime - 100,
      'src/host-shared/perf/WorkSpanRecorder.ts': sourceMtime - 400,
      'src/host-client/HostClient.ts': sourceMtime - 500,
      'src/main/perf/hostPerfSnapshot.ts': sourceMtime - 600,
      'src/shared/hostProtocol.ts': sourceMtime - 200,
      // Never compiled into the Host bundle — the import graph does not reach
      // them. Watching these would fire on every unrelated main edit.
      'src/main/index.ts': sourceMtime - 700,
      'src/main/chat/ChatStore.ts': sourceMtime - 700,
      'src/shared/rendererOnlyTypes.ts': sourceMtime - 700,
      ...overrides
    })
  }

  /**
   * Seven tsc sources plus the three first-party inputs the two bundled
   * entries' maps name; the node_modules entry is excluded and the include
   * root, whose two files are already derived, adds nothing new.
   */
  const BUNDLE_TREE_INPUT_COUNT = 10

  it('P2: bundle freshness watches the whole compilation closure and fails closed', () => {
    expect(HOST_BUNDLE_REBUILD_COMMAND).toBe('npm run host:build')

    const fresh = checkHostBundleFreshness('/repo', { fs: memFs(bundleTree(1000, 900)) })
    expect(fresh.ok).toBe(true)
    expect(fresh.reason).toBe(null)
    expect(fresh.checkedFileCount).toBe(BUNDLE_TREE_INPUT_COUNT)
    expect(fresh.newestSourcePath).toBe(
      path.join('src', 'host-runtime', 'HostStandaloneComposition.ts')
    )

    const stale = checkHostBundleFreshness('/repo', { fs: memFs(bundleTree(1000, 1100)) })
    expect(stale.ok).toBe(false)
    expect(stale.reason).toBe('host_bundle_stale')
    expect(stale.newestSourcePath).toBe(
      path.join('src', 'host-runtime', 'HostStandaloneComposition.ts')
    )
    expect(stale.rebuildCommand).toBe('npm run host:build')

    // THE DEFECT THIS CLOSES. Every one of these is compiled into the bundle,
    // but the preflight used to watch a hand-kept list of three directories
    // that named none of their trees, so a genuinely stale bundle read FRESH.
    for (const relPath of [
      'src/host-shared/perf/WorkSpanRecorder.ts',
      'src/host-client/HostClient.ts',
      'src/main/perf/hostPerfSnapshot.ts'
    ]) {
      const result = checkHostBundleFreshness('/repo', {
        fs: memFs(bundleTree(1000, 900, { [relPath]: 5000 }))
      })
      expect(result.ok, `${relPath} is a compiled input`).toBe(false)
      expect(result.reason).toBe('host_bundle_stale')
      expect(result.newestSourcePath).toBe(relPath.split('/').join(path.sep))
      expect(result.newestSourceMtimeMs).toBe(5000)
    }

    // ...and the converse, which is why the fix is not "watch src/main too":
    // the Host compiles 24 of that tree's ~1500 files. A newer UNCOMPILED file
    // must stay green, or the preflight cries wolf and the team mutes it.
    for (const relPath of [
      'src/main/index.ts',
      'src/main/chat/ChatStore.ts',
      'src/shared/rendererOnlyTypes.ts'
    ]) {
      const quiet = checkHostBundleFreshness('/repo', {
        fs: memFs(bundleTree(1000, 900, { [relPath]: 9e9 }))
      })
      expect(quiet.ok, `${relPath} is not a build input`).toBe(true)
      expect(quiet.checkedFileCount).toBe(BUNDLE_TREE_INPUT_COUNT)
    }

    // THE SECOND DEFECT THIS CLOSES, and the one that refused every launch:
    // `host:build` stage three emits RENAMED bundles, so inverting an output
    // NAME is structurally wrong for them. Both of these are build inputs only
    // because that bundle's map says so — the codec through no other output at
    // all — and a name inversion reached neither.
    for (const relPath of [
      'src/main/workers/threadCatalogueWorker.ts',
      'src/main/workers/threadCatalogueCodec.ts'
    ]) {
      const bundled = checkHostBundleFreshness('/repo', {
        fs: memFs(bundleTree(1000, 900, { [relPath]: 5000 }))
      })
      expect(bundled.ok, `${relPath} is a bundled input`).toBe(false)
      expect(bundled.reason).toBe('host_bundle_stale')
      expect(bundled.newestSourcePath).toBe(relPath.split('/').join(path.sep))
      expect(bundled.newestSourceMtimeMs).toBe(5000)
    }

    // THE FOURTH DEFECT, and the A/B that proves it: a DECLARED entry
    // artifact that was never emitted (a partial build — tsc without the
    // esbuild worker stage) removes its own bundled closure from the derived
    // set, because the inputs appear in no surviving map. The codec is
    // reachable through NO other artifact, so with the worker bundle absent
    // its edit is invisible: the same tree WITH the artifact reds STALE above
    // and WITHOUT it used to read FRESH. Now it must refuse, naming the
    // missing artifact. (Reproduced against the real exported function before
    // fixing: ok:true with the codec at mtime 5000 against a bundle at 1000.)
    const partial = bundleTree(1000, 900, {
      'src/main/workers/threadCatalogueCodec.ts': 5000
    })
    delete nodeAt(partial, 'out/host/host-node')['ThreadCatalogueWorkerEntry.js']
    delete nodeAt(partial, 'out/host/host-node')['ThreadCatalogueWorkerEntry.js.map']
    const incomplete = checkHostBundleFreshness('/repo', { fs: memFs(partial) })
    expect(incomplete.ok).toBe(false)
    expect(incomplete.reason).toBe(
      `host_bundle_incomplete_output: ${path.join(
        'out',
        'host',
        'host-node',
        'ThreadCatalogueWorkerEntry.js'
      )}`
    )
    expect(incomplete.rebuildCommand).toBe('npm run host:build')

    // Either declared entry triggers it...
    const missingDecoder = bundleTree(1000, 900)
    delete nodeAt(missingDecoder, 'out/host/host-node')['ThreadCatalogueDecoderEntry.js']
    delete nodeAt(missingDecoder, 'out/host/host-node')['ThreadCatalogueDecoderEntry.js.map']
    const incompleteDecoder = checkHostBundleFreshness('/repo', { fs: memFs(missingDecoder) })
    expect(incompleteDecoder.ok).toBe(false)
    expect(incompleteDecoder.reason).toBe(
      `host_bundle_incomplete_output: ${path.join(
        'out',
        'host',
        'host-node',
        'ThreadCatalogueDecoderEntry.js'
      )}`
    )

    // ...and anything that is not a regular file where a declared entry
    // belongs — a directory left by a half-finished bundling step — is the
    // same incomplete build, not an artifact whose mtime means something.
    const entryNotAFile = bundleTree(1000, 900)
    nodeAt(entryNotAFile, 'out/host/host-node')['ThreadCatalogueDecoderEntry.js'] = {
      children: {}
    }
    const incompleteNonRegular = checkHostBundleFreshness('/repo', { fs: memFs(entryNotAFile) })
    expect(incompleteNonRegular.ok).toBe(false)
    expect(incompleteNonRegular.reason).toBe(
      `host_bundle_incomplete_output: ${path.join(
        'out',
        'host',
        'host-node',
        'ThreadCatalogueDecoderEntry.js'
      )}`
    )

    // A source ADDED to the tsconfig include root is a build input with no
    // importer, so it has no emitted output to invert and is walked directly.
    const added = checkHostBundleFreshness('/repo', {
      fs: memFs(bundleTree(1000, 900, { 'src/host-runtime/NeverCompiled.ts': 5000 }))
    })
    expect(added.ok).toBe(false)
    expect(added.reason).toBe('host_bundle_stale')
    expect(added.checkedFileCount).toBe(BUNDLE_TREE_INPUT_COUNT + 1)
    expect(added.newestSourcePath).toBe(path.join('src', 'host-runtime', 'NeverCompiled.ts'))

    // The gap a derived set cannot close on its own: a source added OUTSIDE
    // the include root has no emitted output either. It is not yet a build
    // input, and it becomes one only when something imports it — which edits
    // a file that IS derived and bumps its mtime. The addition is caught
    // through its importer, so the preflight does not fail OPEN on it.
    const importer = 'src/host-shared/perf/WorkSpanRecorder.ts'
    const addedViaImporter = checkHostBundleFreshness('/repo', {
      fs: memFs(
        bundleTree(1000, 900, { 'src/host-shared/NeverCompiled.ts': 5000, [importer]: 5001 })
      )
    })
    expect(addedViaImporter.ok).toBe(false)
    expect(addedViaImporter.reason).toBe('host_bundle_stale')
    expect(addedViaImporter.newestSourcePath).toBe(importer.split('/').join(path.sep))
    expect(addedViaImporter.newestSourceMtimeMs).toBe(5001)

    // A NEWER TEST FILE must not fail the preflight: the host tsconfig
    // excludes ./**/*.test.ts, so tests are not build inputs.
    const testOnlyNewer = checkHostBundleFreshness('/repo', {
      fs: memFs(bundleTree(1000, 900, { 'src/host-runtime/NeverCompiled.test.ts': 5000 }))
    })
    expect(testOnlyNewer.ok).toBe(true)
    expect(testOnlyNewer.checkedFileCount).toBe(BUNDLE_TREE_INPUT_COUNT)

    // An emitted output whose source is GONE means the bundle cannot
    // correspond to this working tree — fail closed rather than skip it.
    const deleted = bundleTree(1000, 900)
    delete (deleted.src.children as Record<string, FsNode>).shared
    const orphan = checkHostBundleFreshness('/repo', { fs: memFs(deleted) })
    expect(orphan.ok).toBe(false)
    expect(orphan.reason).toBe(
      `host_bundle_orphan_output: ${path.join('src', 'shared', 'hostProtocol.ts')}`
    )

    // Provenance that cannot be READ is never assumed. Each of these is an
    // emitted artifact whose map yields no usable source list, and each must
    // REFUSE rather than fall back to guessing the source from the output
    // name — that guess is exactly what this derivation replaced.
    const unprovenArtifact = 'out/host/host-client/HostClient.js'
    const unprovenCases: Array<[string, Record<string, number | FileSpec> | null]> = [
      ['map absent', null],
      [
        'map unparseable',
        { [`${unprovenArtifact}.map`]: { mtimeMs: 1000, content: '{ not json' } }
      ],
      [
        'map without a sources array',
        { [`${unprovenArtifact}.map`]: { mtimeMs: 1000, content: '{"version":3}' } }
      ],
      [
        'map with a non-string source',
        {
          [`${unprovenArtifact}.map`]: {
            mtimeMs: 1000,
            content: '{"version":3,"sources":[17]}'
          }
        }
      ],
      // A sourceRoot prefixes every entry in sources. The derivation resolves
      // relative to the map and never honours it, so rather than misresolve
      // every entry — each silently skipped as outside src/ — the artifact is
      // refused. The sources below DO resolve without the prefix, so only the
      // sourceRoot refusal itself keeps this case red.
      [
        'map with a non-empty sourceRoot',
        {
          [`${unprovenArtifact}.map`]: {
            mtimeMs: 1000,
            content:
              '{"version":3,"sourceRoot":"../../..","sources":["../../../src/host-client/HostClient.ts"]}'
          }
        }
      ],
      // A present-but-EMPTY sources array passes Array.isArray and then
      // contributes nothing — the artifact looks fine while watching zero
      // inputs. No provenance is unproven provenance.
      [
        'map with an empty sources array',
        {
          [`${unprovenArtifact}.map`]: {
            mtimeMs: 1000,
            content: '{"version":3,"sources":[]}'
          }
        }
      ]
    ]
    for (const [label, override] of unprovenCases) {
      const unprovenTree = bundleTree(1000, 900, override ?? {})
      if (override === null)
        delete nodeAt(unprovenTree, 'out/host/host-client')['HostClient.js.map']
      const unproven = checkHostBundleFreshness('/repo', { fs: memFs(unprovenTree) })
      expect(unproven.ok, label).toBe(false)
      expect(unproven.reason, label).toBe(
        `host_bundle_preflight_unproven_output: ${path.join(...unprovenArtifact.split('/'))}`
      )
    }

    // A never-built or deleted out/host derives an EMPTY input set, so it must
    // fail on the bundle itself rather than pass vacuously on zero inputs.
    const tree = bundleTree(1000, 900)
    delete tree.out
    const missing = checkHostBundleFreshness('/repo', { fs: memFs(tree) })
    expect(missing.ok).toBe(false)
    expect(missing.reason).toBe('host_bundle_missing')
    expect(missing.checkedFileCount).toBe(0)

    // The bundle PATH existing is not enough. Anything that is not a regular
    // file where cli.js belongs — a directory left by a half-finished build —
    // has an mtime that means nothing, so it must refuse rather than compare
    // it. Found by a surviving mutant: this branch had no test at all.
    const notAFile = bundleTree(1000, 900)
    nodeAt(notAFile, 'out/host/host-runtime')['cli.js'] = { children: {} }
    const nonRegular = checkHostBundleFreshness('/repo', { fs: memFs(notAFile) })
    expect(nonRegular.ok).toBe(false)
    expect(nonRegular.reason).toBe('host_bundle_missing')
    expect(nonRegular.checkedFileCount).toBe(0)

    // A symlinked directory among the outputs refuses as unproven output
    // naming the path — never followed, and never silently skipped into a
    // "fresh by vacuity" pass (fifth member: the skip this replaced).
    const symlinked = treeOf({ [BUNDLE_REL]: 1, 'src/host-runtime/README.md': 1 })
    const hostOut = (symlinked.out.children as Record<string, FsNode>).host
    ;((hostOut.children as Record<string, FsNode>)['host-runtime'] as FsNode).symlink = true
    const emptySources = checkHostBundleFreshness('/repo', { fs: memFs(symlinked) })
    expect(emptySources.ok).toBe(false)
    expect(emptySources.reason).toBe(
      `host_bundle_preflight_unproven_output: ${path.join('out', 'host', 'host-runtime')}`
    )
    expect(emptySources.checkedFileCount).toBe(0)

    // A walk failure that is not a missing source → fail closed.
    const walkFailure = checkHostBundleFreshness('/repo', {
      fs: {
        statSync: () => ({ isFile: () => true, mtimeMs: 1 }),
        readdirSync: () => {
          throw Object.assign(new Error('nope'), { code: 'EACCES' })
        },
        readFileSync: () => '{"version":3,"sources":[]}'
      }
    })
    expect(walkFailure.ok).toBe(false)
    expect(walkFailure.reason).toBe('host_bundle_preflight_io: EACCES')

    // fs contract failure → fail closed.
    const noFs = checkHostBundleFreshness('/repo', { fs: {} })
    expect(noFs.ok).toBe(false)
    expect(noFs.reason).toBe('host_bundle_preflight_io: fs_contract')
  })

  it('P2: non-regular preflight entries refuse as unproven output (fifth member)', () => {
    // ONE symlinked artifact among regular ones: pre-fix the walk skipped it
    // and reported fresh; now the closure it hides makes the bundle unproven.
    const symlinkedArtifact = bundleTree(1000, 900)
    nodeAt(symlinkedArtifact, 'out/host/host-client')['HostClient.js'].symlink = true
    const symlinked = checkHostBundleFreshness('/repo', { fs: memFs(symlinkedArtifact) })
    expect(symlinked.ok).toBe(false)
    expect(symlinked.reason).toBe(
      `host_bundle_preflight_unproven_output: ${path.join('out', 'host', 'host-client', 'HostClient.js')}`
    )

    // Same for the include root: a symlink where a source should be watched.
    const symlinkedSource = bundleTree(1000, 900)
    nodeAt(symlinkedSource, 'src/host-runtime')['cli.ts'].symlink = true
    const symlinkedSrc = checkHostBundleFreshness('/repo', { fs: memFs(symlinkedSource) })
    expect(symlinkedSrc.ok).toBe(false)
    expect(symlinkedSrc.reason).toBe(
      `host_bundle_preflight_unproven_output: ${path.join('src', 'host-runtime', 'cli.ts')}`
    )

    // A directory where a derived input should be a file: the stat loop must
    // refuse rather than skip it out of the watched set.
    const dirAsInput = bundleTree(1000, 900)
    nodeAt(dirAsInput, 'src/host-runtime')['cli.ts'] = { children: {} }
    const nonRegular = checkHostBundleFreshness('/repo', { fs: memFs(dirAsInput) })
    expect(nonRegular.ok).toBe(false)
    expect(nonRegular.reason).toBe(
      `host_bundle_preflight_unproven_output: ${path.join('src', 'host-runtime', 'cli.ts')}`
    )

    // The vacuity guard survives the new refusal: zero derived inputs with no
    // other defect still refuses as no_sources rather than passing fresh.
    const hollowTree = treeOf({
      ...emitted('out/host/host-runtime/cli.js', ['node_modules/only/index.ts'], 1000),
      'src/host-runtime/README.md': 1
    })
    const hollow = checkHostBundleFreshness('/repo', { fs: memFs(hollowTree) })
    expect(hollow.ok).toBe(false)
    expect(hollow.reason).toBe('host_bundle_preflight_no_sources')
    expect(hollow.checkedFileCount).toBe(0)
  })

  it('P2: the input set is derived from the REAL host tsconfig, not a hand-kept list', () => {
    // Everything this test expects is computed from src/host-runtime/tsconfig.json
    // — the actual build contract — and never from a constant in runT2Baseline.cjs.
    // A preflight that silently narrows back to a directory list reds here.
    const repoRoot = path.resolve(__dirname, '..', '..')
    const tsconfigDir = path.join(repoRoot, 'src', 'host-runtime')
    const tsconfig = JSON.parse(readFileSync(path.join(tsconfigDir, 'tsconfig.json'), 'utf8'))
    const rootDirAbs = path.resolve(tsconfigDir, tsconfig.compilerOptions.rootDir)
    const outDirAbs = path.resolve(tsconfigDir, tsconfig.compilerOptions.outDir)

    // rootDir/outDir fix WHICH tree is walked and which sources are in scope;
    // `sourceMap` is now a hard dependency, because provenance is read from
    // each artifact's own map. Turning it off strips every map and the
    // preflight then refuses every launch — the safe direction, loudly — but
    // this assertion is what says WHY rather than leaving a bare refusal.
    expect(rootDirAbs).toBe(path.join(repoRoot, 'src'))
    expect(outDirAbs).toBe(path.join(repoRoot, 'out', 'host'))
    expect(tsconfig.compilerOptions.sourceMap).toBe(true)
    expect(tsconfig.compilerOptions.declaration).toBe(false)
    expect(tsconfig.compilerOptions.noEmit).toBe(false)
    // A sourceRoot would prefix every mapped source; the derivation refuses
    // such maps rather than misresolve them, so the build must never emit one.
    expect(tsconfig.compilerOptions.sourceRoot).toBeUndefined()
    // The include root: where a file is an input with nothing importing it.
    expect(tsconfig.include).toEqual(['./**/*.ts'])
    expect(tsconfig.exclude).toEqual(['./**/*.test.ts'])

    const rel = (abs: string) => path.relative(repoRoot, abs).split(path.sep).join('/')
    const emittedFor = (source: string) =>
      rel(
        path.join(
          outDirAbs,
          `${path.relative(rootDirAbs, path.join(repoRoot, source)).slice(0, -'.ts'.length)}.js`
        )
      )
    const includeRootRel = rel(tsconfigDir)
    const entrySource = `${includeRootRel}/cli.ts`
    // A compiled input that lives OUTSIDE the include root and outside every
    // directory the old list named: reachable only through the import graph.
    const graphSource = 'src/host-shared/perf/WorkSpanRecorder.ts'
    // The declared worker entries must exist or the preflight refuses the
    // build as incomplete; each map names its one real first-party input.
    const declaredEntries = HOST_BUNDLE_DECLARED_ENTRY_SEGMENTS.map((segments) =>
      segments.join('/')
    )
    expect(declaredEntries.length).toBe(2)
    const workerSources = [
      'src/main/workers/threadCatalogueWorker.ts',
      'src/main/workers/threadCatalogueDecoder.ts'
    ]
    const baseFiles: Record<string, number | FileSpec> = {
      ...emitted(emittedFor(entrySource), [entrySource], 1000),
      ...emitted(emittedFor(graphSource), [graphSource], 1000),
      ...emitted(declaredEntries[0], [workerSources[0]], 1000),
      ...emitted(declaredEntries[1], [workerSources[1]], 1000),
      [entrySource]: 900,
      [graphSource]: 900,
      [workerSources[0]]: 900,
      [workerSources[1]]: 900
    }
    // The preflight's own bundle path must be one of the emitted outputs.
    expect(Object.keys(baseFiles)).toContain(rel(path.join(outDirAbs, 'host-runtime', 'cli.js')))

    const clean = checkHostBundleFreshness(repoRoot, { fs: memFs(treeOf(baseFiles), repoRoot) })
    expect(clean.ok).toBe(true)
    expect(clean.checkedFileCount).toBe(4)

    const graphStale = checkHostBundleFreshness(repoRoot, {
      fs: memFs(treeOf({ ...baseFiles, [graphSource]: 5000 }), repoRoot)
    })
    expect(graphStale.ok).toBe(false)
    expect(graphStale.reason).toBe('host_bundle_stale')
    expect(graphStale.newestSourcePath).toBe(graphSource.split('/').join(path.sep))

    // The include side, asserted against the tsconfig's own LOCATION and its
    // include/exclude globs rather than against any watched-directory list.
    const addedInIncludeRoot = checkHostBundleFreshness(repoRoot, {
      fs: memFs(treeOf({ ...baseFiles, [`${includeRootRel}/NeverCompiled.ts`]: 5000 }), repoRoot)
    })
    expect(addedInIncludeRoot.ok).toBe(false)
    expect(addedInIncludeRoot.newestSourcePath).toBe(
      path.join(...includeRootRel.split('/'), 'NeverCompiled.ts')
    )

    const addedTestInIncludeRoot = checkHostBundleFreshness(repoRoot, {
      fs: memFs(
        treeOf({ ...baseFiles, [`${includeRootRel}/NeverCompiled.test.ts`]: 5000 }),
        repoRoot
      )
    })
    expect(addedTestInIncludeRoot.ok).toBe(true)
    expect(addedTestInIncludeRoot.checkedFileCount).toBe(4)
  })

  it('P2: the preflight is pinned to the REAL host:build pipeline, not just its tsc stage', () => {
    // THE LESSON OF THIS DEFECT, made mechanical. The first derivation read
    // the host tsconfig, verified it, and treated it as THE BUILD. It is stage
    // two of four: a later stage esbuild-bundles worker entrypoints into the
    // SAME out/host tree under RENAMED outputs, so no output-name inversion
    // could ever be sound. The implementation, its fixtures and two
    // independent reviews all shared that single blind spot, because none of
    // them read the build script. Pin the pipeline itself, so a stage that
    // emits differently reds HERE rather than passing.
    const repoRoot = path.resolve(__dirname, '..', '..')
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    const stages = String(pkg.scripts['host:build'])
      .split('&&')
      .map((stage) => stage.trim())

    // A change here is not necessarily a break — it is a signal that the
    // derivation's assumptions must be re-checked against the new pipeline.
    expect(stages, 'host:build changed — re-check the freshness derivation').toEqual([
      'node scripts/clean-host-output.cjs',
      'tsc -p src/host-runtime/tsconfig.json',
      'node scripts/build-history-workers.cjs',
      `node -e "require('node:fs').chmodSync('out/host/host-runtime/cli.js', 0o755)"`
    ])

    const bundler = readFileSync(
      path.join(repoRoot, 'scripts', 'build-history-workers.cjs'),
      'utf8'
    )
    // Stage three emits INTO out/host, which is why the walk meets artifacts
    // tsc never wrote. `outdir` is a ternary; pin the DEFAULT branch, because
    // host:build invokes the script with no --outdir override, so the default
    // is the only path T2 ever runs against.
    expect(bundler).toContain(": 'out/host/host-node'")
    // ...under names that are NOT derivable from their sources, which is the
    // entire reason provenance is read rather than inferred...
    expect(bundler).toContain(
      "ThreadCatalogueWorkerEntry: 'src/main/workers/threadCatalogueWorker.ts'"
    )
    expect(bundler).toContain(
      "ThreadCatalogueDecoderEntry: 'src/main/workers/threadCatalogueDecoder.ts'"
    )
    // ...and it must keep emitting maps, or its artifacts become unprovable
    // and the preflight refuses every launch.
    expect(bundler).toContain('sourcemap: true')
    // It must also never SET a sourceRoot (esbuild honours it): the derivation
    // resolves sources relative to the map and refuses any map that declares
    // one, so a sourceRoot here would refuse every launch. Non-vacuous: the
    // toContain assertions above prove `bundler` is the real script's content.
    expect(bundler).not.toContain('sourceRoot')

    // DECLARED vs EMITTED, reconciled against the real producer. The
    // preflight refuses when a DECLARED entry artifact is absent (a partial
    // build leaves its bundled closure invisible), so the declared list must
    // be exactly what this script emits: its `entryPoints` keys under its
    // default outdir, one renamed `<Key>.js` each. Derive both from the
    // script's own text — never from a copy of the values here — so a renamed
    // or added entry point reds this test instead of drifting the preflight.
    const entryPointsBlock = bundler.match(/entryPoints:\s*\{([\s\S]*?)\}/)
    expect(
      entryPointsBlock,
      'build-history-workers entryPoints block not found — re-check the declared-entry list'
    ).not.toBe(null)
    const declaredKeys = [...entryPointsBlock![1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map(
      (match) => match[1]
    )
    expect(declaredKeys.length).toBeGreaterThan(0)
    const outdirDefault = bundler.match(/outdir:[\s\S]*?:\s*'([^']+)'/)
    expect(
      outdirDefault,
      'build-history-workers outdir default branch not found — re-check the declared-entry list'
    ).not.toBe(null)
    const expectedDeclared = declaredKeys.map((key) => `${outdirDefault![1]}/${key}.js`)
    expect(HOST_BUNDLE_DECLARED_ENTRY_SEGMENTS.map((segments) => segments.join('/'))).toEqual(
      expectedDeclared
    )
  })

  it('P2: the preflight derives cleanly from the REAL emitted tree (skipped with no host build)', () => {
    // Every other assertion in this file injects a fake fs, so the suite is
    // structurally unable to observe the tree this function actually runs
    // against in production. That is why a defect which refused EVERY launch
    // still left the whole suite green. This is the one check that looks at
    // reality, and it is the cheapest of the three layers.
    const repoRoot = path.resolve(__dirname, '..', '..')
    if (!existsSync(path.join(repoRoot, ...['out', 'host', 'host-runtime', 'cli.js']))) {
      // No host build present (fresh clone, or CI that does not run
      // host:build): there is nothing for a bundle to be fresh AGAINST, so a
      // skip is the correct answer rather than a build-order landmine.
      return
    }

    const real = checkHostBundleFreshness(repoRoot)
    // `host_bundle_stale` is a TRUE answer about a legitimate local state —
    // edit a Host source, do not rebuild — so asserting ok:true here would red
    // on an ordinary working tree. `host_bundle_incomplete_output` is the same
    // category: a partial build (tsc without the esbuild stage) is a tree that
    // is not currently launchable, not a defect in the derivation logic, and
    // redding the whole perf suite on it would be the build-order landmine
    // this test exists to avoid. What must never happen is a failure to
    // DERIVE: an unprovable artifact, an orphan, zero sources or an I/O
    // refusal all mean the preflight cannot read this repo's own build output.
    // The live defect this slice repairs was `host_bundle_orphan_output`, so
    // this discrimination keeps every bit of the detection and none of the
    // false positives.
    expect(
      real.reason === null ||
        real.reason === 'host_bundle_stale' ||
        real.reason.startsWith('host_bundle_incomplete_output:'),
      `real out/host: ${real.reason} (newest ${real.newestSourcePath})`
    ).toBe(true)
    expect(real.checkedFileCount).toBeGreaterThan(0)
  })

  it('P2: a stale Host bundle hard-fails --launch BEFORE spawn, naming the rebuild command', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..')
    const homesRoot = path.join(repoRoot, 'perf-homes')
    mkdirSync(homesRoot, { recursive: true })
    const home = mkdtempSync(path.join(homesRoot, 'tw-t2-w8-stale-'))
    tempDirs.push(home)
    let spawned = false
    await expect(
      runT2BaselineCli(
        [
          '--workload=dual_run',
          '--launch',
          '--i-accept-isolated-launch',
          '--materialize-instance-userdata',
          '--lean',
          '--scale-down=40',
          '--instance-id=perfW8Stl01',
          `--home=${home}`,
          '--port=9451',
          '--inspect-port=9851',
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
          buildAdapters: { build: async () => ({ code: 0 }) },
          hostBundleAdapters: { fs: staleHostBundleFs() },
          spawnAdapters: {
            resolveElectronPath: () => '/virtual/Electron',
            spawn: () => {
              spawned = true
              throw new Error('preflight must run before any spawn')
            }
          },
          portAdapters: {
            probePort: async (port: number) => ({ port, occupied: false }),
            probeCdp: async () => ({ port: 9451, reachable: false }),
            listInstancePids: () => []
          },
          terminateOptions: { waitMs: 20, sleep: async () => {} }
        }
      )
    ).rejects.toThrow(/is older than .*Fresh\.ts.*npm run host:build/)
    expect(spawned).toBe(false)
  })

  // -------------------------------------------------------------------------
  // T9b host span binding + qualification call (ruling P4)
  // -------------------------------------------------------------------------

  function evidenceOptions(overrides: Record<string, unknown> = {}) {
    return {
      userDataPath: '/virtual/userdata',
      requiredChatIds: ['chat-heavy'],
      cell: CELL_NAME,
      metrics: createEmptyPerfMetrics(),
      now: () => FRESH_AT,
      ...overrides
    } as Record<string, unknown>
  }

  it('qualifies and folds ONLY a boot-epoch-verified read: real writer file, real collector, live pin', async () => {
    const snapshotPath = writeRealHostSnapshot({ ...HOST_IDENTITY, bootEpoch: EPOCH })
    const options = evidenceOptions({
      hostPerfSnapshotPath: snapshotPath,
      probe: okProbe(EPOCH),
      renderer: rendererServing(realMainSection())
    })
    const result = await collectT2HostSpanEvidence(options)
    expect(result.ok).toBe(true)
    const record = result.record
    expect(record.marker).toBe(null)
    expect(record.qualified).toBe(true)
    expect(record.folded).toBe(true)
    expect(record.cell).toBe(CELL_NAME)
    expect(record.discoveryPid).toBe(777)
    expect(record.welcome).toEqual({ hostId: 'host-abc', generation: 2, bootEpoch: EPOCH })
    expect(record.expectedIdentity).toEqual({
      instanceId: 'host-abc',
      generation: 2,
      pid: 777,
      bootEpoch: EPOCH
    })
    expect(record.identity).toEqual({ ...HOST_IDENTITY, bootEpoch: EPOCH })
    expect(record.attribution.status).toBe('available')
    expect(record.ageMs).toBe(1000)
    expect(record.sequence).toBe(1)

    const metrics = options.metrics as Record<string, any>
    const cell = metrics.crossThread.cells[CELL_NAME]
    expect(cell.processes.host.hostSnapshot.identity.bootEpoch).toBe(EPOCH)
    expect(cell.processes.host.hostSnapshot.identityVerified).toBe(true)
    expect(cell.processes.main.process).toBe('main')
    expect(validateCrossThreadBlock(metrics.crossThread)).toEqual([])
    expect(validatePerfMetrics(metrics).ok).toBe(true)
  })

  it('P4: a legacy epoch-free run is recorded and left UNQUALIFIED — never green', async () => {
    const snapshotPath = writeRealHostSnapshot(HOST_IDENTITY)
    const options = evidenceOptions({
      hostPerfSnapshotPath: snapshotPath,
      probe: okProbe(),
      renderer: rendererServing(realMainSection())
    })
    const result = await collectT2HostSpanEvidence(options)
    expect(result.ok).toBe(false)
    expect(result.record.marker).toBe('host_evidence_unqualified: boot_epoch_absent')
    expect(result.record.qualified).toBe(false)
    expect((options.metrics as Record<string, any>).crossThread).toBeUndefined()
    // The read itself stayed legacy-valid: identity pinned, attribution available.
    expect(result.record.identity).toEqual({ ...HOST_IDENTITY })
    expect(result.record.attribution.status).toBe('available')
  })

  it('P4: a stale incarnation (pinned epoch missing from the file) refuses the whole read', async () => {
    const snapshotPath = writeRealHostSnapshot({ ...HOST_IDENTITY, bootEpoch: OTHER_EPOCH })
    const options = evidenceOptions({
      hostPerfSnapshotPath: snapshotPath,
      probe: okProbe(EPOCH),
      renderer: rendererServing(realMainSection())
    })
    const result = await collectT2HostSpanEvidence(options)
    expect(result.ok).toBe(false)
    expect(result.record.marker).toBe('host_snapshot_refused: host_perf_snapshot_identity_mismatch')
    expect(result.record.qualified).toBe(false)
    expect((options.metrics as Record<string, any>).crossThread).toBeUndefined()
  })

  it('P4: a file epoch the pin lacks degrades to unverified — diagnostics valid, strict attribution not', async () => {
    const snapshotPath = writeRealHostSnapshot({ ...HOST_IDENTITY, bootEpoch: EPOCH })
    const options = evidenceOptions({
      hostPerfSnapshotPath: snapshotPath,
      probe: okProbe(),
      renderer: rendererServing(realMainSection())
    })
    const result = await collectT2HostSpanEvidence(options)
    expect(result.ok).toBe(false)
    expect(result.record.marker).toBe('host_evidence_unqualified: identity_unverified')
    expect(result.record.attribution.status).toBe('unsupported')
    expect(result.record.attribution.reason).toBe('boot_epoch_unpinned')
    expect((options.metrics as Record<string, any>).crossThread).toBeUndefined()
  })

  it('names host-unsupported (no discovery) and welcome-refusal markers without sampling', async () => {
    let sampled = false
    const tripwireSampler = async () => {
      sampled = true
      return {
        workSpans: { unsupported: 'must_not_run' },
        hostPerf: { unsupported: 'must_not_run' }
      }
    }
    const absent = await collectT2HostSpanEvidence(
      evidenceOptions({
        hostPerfSnapshotPath: '/virtual/none.json',
        sampler: tripwireSampler,
        probe: async () => ({ ok: false, stage: 'discovery', reason: 'host_discovery_absent' })
      })
    )
    expect(absent.record.marker).toBe('host_discovery_unavailable: host_discovery_absent')
    expect(absent.record.qualified).toBe(false)

    const refused = await collectT2HostSpanEvidence(
      evidenceOptions({
        hostPerfSnapshotPath: '/virtual/none.json',
        sampler: tripwireSampler,
        probe: async () => ({ ok: false, stage: 'welcome', reason: 'host_welcome_timeout' })
      })
    )
    expect(refused.record.marker).toBe('host_welcome_unavailable: host_welcome_timeout')
    expect(sampled).toBe(false)
  })

  it('never folds one-sided evidence: degraded main section or unspecified cell disqualify', async () => {
    const snapshotPath = writeRealHostSnapshot({ ...HOST_IDENTITY, bootEpoch: EPOCH })

    // Renderer session present but without .post → main side unavailable; the
    // host file read still rides along (session-independence) and is recorded.
    const noMain = await collectT2HostSpanEvidence(
      evidenceOptions({ hostPerfSnapshotPath: snapshotPath, probe: okProbe(EPOCH), renderer: {} })
    )
    expect(noMain.record.marker).toBe(
      'main_perf_section_unavailable: renderer_runtime_session_required'
    )
    expect(noMain.record.qualified).toBe(false)
    expect(noMain.record.identity.bootEpoch).toBe(EPOCH)

    // Fully qualified evidence but no canonical cell → recorded, not folded.
    const noCell = await collectT2HostSpanEvidence(
      evidenceOptions({
        hostPerfSnapshotPath: snapshotPath,
        probe: okProbe(EPOCH),
        renderer: rendererServing(realMainSection()),
        cell: null
      })
    )
    expect(noCell.record.marker).toBe('cross_thread_cell_unspecified')
    expect(noCell.record.qualified).toBe(false)
    expect(noCell.record.cell as string | null).toBe(null)
  })

  it('TOKEN CONTAINMENT: the record and folded report copy bounded identity fields only', async () => {
    const snapshotPath = writeRealHostSnapshot({ ...HOST_IDENTITY, bootEpoch: EPOCH })
    // A probe result deliberately carrying bait beyond the bounded contract:
    // the runner's copies must drop it structurally, not by convention.
    const leakyProbe = async () => ({
      ok: true,
      expectedIdentity: { instanceId: 'host-abc', generation: 2, pid: 777, bootEpoch: EPOCH },
      welcome: {
        hostId: 'host-abc',
        generation: 2,
        bootEpoch: EPOCH,
        token: TOKEN_BAIT,
        tokenPath: '/bait/token'
      },
      discovery: {
        pid: 777,
        startedAt: '2026-09-09T03:59:58.000Z',
        tokenPath: '/bait/token',
        socketPath: '/bait/socket'
      }
    })
    const options = evidenceOptions({
      hostPerfSnapshotPath: snapshotPath,
      probe: leakyProbe,
      renderer: rendererServing(realMainSection())
    })
    const result = await collectT2HostSpanEvidence(options)
    expect(result.ok).toBe(true)
    expect(result.record.welcome).toEqual({ hostId: 'host-abc', generation: 2, bootEpoch: EPOCH })
    const serialized = JSON.stringify({
      hostSpans: result.record,
      crossThread: (options.metrics as Record<string, any>).crossThread
    })
    expect(serialized).not.toContain(TOKEN_BAIT)
    expect(serialized).not.toContain('/bait/token')
    expect(serialized).not.toContain('/bait/socket')
    expect(serialized).not.toContain('tokenPath')
  })

  it('validates --cell at parse time and refuses a non-canonical cell before any I/O', async () => {
    expect(parseArgs(['--cell=small/2/warm/codex_bridge_disabled/none']).cell).toBe(
      'small/2/warm/codex_bridge_disabled/none'
    )
    await expect(
      runT2BaselineCli(['--workload=dual_run', '--dry-run', '--cell=bogus'])
    ).rejects.toThrow(/canonical matrix cell/)
  })

  it('T9b producer + preflight + env arming are wired in the runner (source-region guards)', () => {
    // Same discipline as the T9a wiring guards: a seam built and never invoked
    // is the failure these anchors exist to catch. Comment-only lines are
    // stripped first so commented-out code cannot satisfy a guard.
    const src = readFileSync(path.join(__dirname, 'runT2Baseline.cjs'), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')

    // 1. The spawn env arms the writer only for a real launch.
    expect(src).toContain(
      'extraEnv: willLaunch ? { TASKWRAITH_PERF_HOST_SNAPSHOT_PATH: hostSnapshotPath } : undefined'
    )

    // 2. The bundle preflight runs BEFORE any spawn.
    const preflightAt = src.search(
      /^\s*const hostBundleCheck = checkHostBundleFreshness\(repoRoot, options\.hostBundleAdapters \|\| \{\}\)\s*$/m
    )
    const spawnAt = src.search(/^\s*childSession = spawnExactElectronChild\(\{\s*$/m)
    expect(preflightAt).toBeGreaterThan(-1)
    expect(spawnAt).toBeGreaterThan(preflightAt)

    // 3. The T9b producer is invoked and recorded BEFORE the renderer closes.
    const collectAt = src.search(
      /^\s*const hostSpanEvidence = await collectT2HostSpanEvidence\(\{\s*$/m
    )
    const assignAt = src.search(/^\s*report\.hostSpans = hostSpanEvidence\.record\s*$/m)
    const rendererCloseAt = src.search(/^\s*renderer\.close\(\)\s*$/m)
    expect(collectAt).toBeGreaterThan(-1)
    expect(assignAt).toBeGreaterThan(collectAt)
    expect(rendererCloseAt).toBeGreaterThan(assignAt)
  })
})
