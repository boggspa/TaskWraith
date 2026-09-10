import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  enumerateMatrixCells,
  cellName,
  MISSING_DRIVER_CAPABILITIES,
  pairRuns,
  environmentRecord,
  createInterferenceReport,
  validateInterferenceReport
} = require('./interferenceMatrix.cjs')
const { sampleHostSpans, normalizeHostSpanSnapshot } = require('./collectors/hostSpans.cjs')

function environment() {
  const collect = vi.fn(() => ({
    gitSha: 'b'.repeat(40),
    dirty: false,
    dirtyPaths: [],
    dirtyTreeFingerprint: 'a'.repeat(64),
    isolatedWorktree: false,
    authoritativeBaseline: false
  }))
  return {
    collect,
    value: environmentRecord({
      env: {
        OLLAMA_MAX_LOADED_MODELS: '2',
        TASKWRAITH_CHAT_STORE_V2: '1',
        TASKWRAITH_MCP_TOKEN: 'test-credential',
        TASKWRAITH_RUN_ID: 'test-run-context',
        UNRELATED_FLAG: '1'
      },
      now: () => new Date('2026-09-08T12:00:00.000Z'),
      collectRepoProvenance: collect
    })
  }
}

function evidence(role: string) {
  const populations = [
    { chatId: 'light', role: 'light' },
    ...(role === 'light-beside' ? [{ chatId: 'heavy', role: 'heavy' }] : [])
  ]
  return {
    schemaVersion: 1,
    status: 'complete',
    diagnosticOnly: false,
    lightChatId: 'light',
    populations,
    windows: Array.from({ length: 3 }, (_, repetition) => ({
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
        overlappedLightSamples: population.role === 'light' && role === 'light-beside' ? 1 : 0
      }))
    }))
  }
}

function run(role: string, overrides: Record<string, unknown> = {}) {
  return {
    cellName: cellName(enumerateMatrixCells()[0]),
    role,
    fixtureFingerprint: 'f'.repeat(64),
    fixtureVersions: { fixture: 1, schedule: 2 },
    workload: 'dual_run',
    seed: 42,
    buildId: 'test-build',
    windowMs: 120_000,
    repetitions: 3,
    signals: { roundStartMs: { count: 3, p50: 10, p95: 20, p99: 30 } },
    evidence: evidence(role),
    ...overrides
  }
}

function spans() {
  return {
    process: 'main',
    byKind: {},
    byResource: {},
    recorded: 0,
    dropped: 0,
    sampledOut: 0,
    rejected: 0
  }
}

describe('interference matrix reachability', () => {
  it('names all 480 Appendix A cells and discloses missing drivers on every cell', () => {
    const cells = enumerateMatrixCells()
    expect(cells).toHaveLength(480)
    expect(new Set(cells.map((cell: { name: string }) => cell.name)).size).toBe(480)
    for (const cell of cells) {
      expect(cell.name).toBe(cellName(cell))
      expect(cell.name.split('/')).toHaveLength(5)
      expect(cell.reachable).toBe(true)
      expect(cell.missingCapability).toEqual([])
      // The deterministic-provider capability LANDED with
      // scripts/perf/deterministicReplayProvider.cjs (M1 P1): the matrix no
      // longer claims it missing.
      expect(cell.missingCapability.includes('deterministic_replay_provider')).toBe(false)
      // The control-action capability LANDED with scripts/perf/controlActionReplay.cjs
      // (M1 Wall 1): the matrix no longer claims it missing.
      expect(cell.missingCapability.includes('control_action_replay_events')).toBe(false)
      // The per-chat lanes capability LANDED with scripts/perf/concurrentReplayLanes.cjs
      // (M1 A1.2): the matrix no longer claims it missing.
      expect(cell.missingCapability.includes('concurrent_per_chat_replay_lanes')).toBe(false)
      // The ensemble-pool saturation capability LANDED with
      // scripts/perf/ensemblePoolSaturation.cjs (M1 Wall 1): the matrix no
      // longer claims it missing.
      expect(cell.missingCapability.includes('ensemble_pool_saturation_driver')).toBe(false)
      // The host-native saturation capability LANDED with
      // scripts/perf/hostNativeSaturation.cjs (M1 Wall 1): the matrix no
      // longer claims it missing.
      expect(cell.missingCapability.includes('host_native_saturation_driver')).toBe(false)
    }
    // The declared list and what the cells actually claim must agree in BOTH
    // directions. A per-cell subset check is vacuous while every list is
    // empty; this one still fails if a capability is declared missing that no
    // cell claims, or claimed by a cell without being declared.
    const claimed = [
      ...new Set(cells.flatMap((cell: { missingCapability: string[] }) => cell.missingCapability))
    ].sort()
    expect(claimed).toEqual([...MISSING_DRIVER_CAPABILITIES].sort())
    // The ensemble-saturation landing flips the last third: all 480 cells
    // read reachable. Reachable means every capability driver exists, not
    // that a runner can execute.
    const reachable = cells.filter((cell: { reachable: boolean }) => cell.reachable)
    expect(reachable).toHaveLength(480)
  })

  it('keeps returned descriptors independent across enumerations', () => {
    const cells = enumerateMatrixCells()
    cells[0].missingCapability.push('mutation-probe')
    expect(enumerateMatrixCells()[0].missingCapability).not.toContain('mutation-probe')
    expect(enumerateMatrixCells()[0].missingCapability).toEqual(
      cells[0].missingCapability.filter((entry: string) => entry !== 'mutation-probe')
    )
  })
})

describe('paired interference evidence', () => {
  it('accepts identical fixture versions, window and repetitions and computes all quantile deltas', () => {
    const alone = run('light-alone')
    const beside = run('light-beside', {
      fixtureVersions: { schedule: 2, fixture: 1 },
      signals: { roundStartMs: { count: 3, p50: 5, p95: 35, p99: 55 } }
    })
    const result = pairRuns(alone, beside)
    expect(result.ok).toBe(true)
    expect(result.pair.deltas).toEqual({ roundStartMs: { p50: -5, p95: 15, p99: 25 } })
    alone.signals.roundStartMs.p50 = 99
    expect(result.pair.lightAlone.signals.roundStartMs.p50).toBe(10)
  })

  it.each([
    { fixtureVersions: { fixture: 2, schedule: 2 } },
    { fixtureVersions: {} },
    { fixtureFingerprint: 'different' },
    { windowMs: 60_000 },
    { repetitions: 2 },
    { buildId: 'different-build' },
    { seed: 43 }
  ])('refuses mismatched evidence %j', (change) => {
    expect(pairRuns(run('light-alone'), run('light-beside', change)).ok).toBe(false)
  })

  it('rejects two equally invalid windows or repetition counts', () => {
    for (const change of [{ windowMs: 60_000 }, { repetitions: 2 }]) {
      expect(pairRuns(run('light-alone', change), run('light-beside', change)).ok).toBe(false)
    }
  })

  it.each([
    {},
    { roundStartMs: { p50: 1, p95: 2 } },
    { roundStartMs: { p50: 1, p95: NaN, p99: 3 } },
    { roundStartMs: { p50: 3, p95: 2, p99: 1 } },
    { differentSignal: { p50: 1, p95: 2, p99: 3 } }
  ])('refuses absent, malformed or mismatched signal summaries %j', (signals) => {
    expect(pairRuns(run('light-alone'), run('light-beside', { signals })).ok).toBe(false)
  })
})

describe('standalone interferenceReport', () => {
  it('validates its own environment, cells and recomputable pairs', () => {
    const cells = enumerateMatrixCells()
    const pairing = pairRuns(run('light-alone'), run('light-beside'))
    const report = createInterferenceReport({
      environment: environment().value,
      cells,
      pairs: [pairing.pair]
    })
    expect(Object.keys(report)).toEqual(['schemaVersion', 'environment', 'cells', 'pairs'])
    expect(validateInterferenceReport(report)).toEqual({ ok: true, errors: [] })
    const liveIdx = cells.findIndex((cell: { reachable: boolean }) => cell.reachable)
    cells[liveIdx].reachable = false
    expect(report.cells[liveIdx].reachable).toBe(true)
    report.pairs[0].deltas.roundStartMs.p95 = 1
    expect(validateInterferenceReport(report).ok).toBe(false)
  })

  it('rejects missing environment data, duplicate cells and false driver claims', () => {
    const valid = () => createInterferenceReport({ environment: environment().value })
    const noEnvironment = valid()
    noEnvironment.environment = {}
    expect(validateInterferenceReport(noEnvironment).ok).toBe(false)
    const duplicate = valid()
    duplicate.cells.push(duplicate.cells[0])
    expect(validateInterferenceReport(duplicate).ok).toBe(false)
    const unsupported = valid()
    // Every cell is genuinely reachable with no missing drivers, so the
    // false claim now runs the other way: a fabricated missing driver plus a
    // false unreachable flag must still be rejected.
    const saturatedIdx = unsupported.cells.findIndex(
      (cell: { saturation: string }) => cell.saturation !== 'none'
    )
    unsupported.cells[saturatedIdx].reachable = false
    unsupported.cells[saturatedIdx].missingCapability = ['fabricated_driver']
    expect(validateInterferenceReport(unsupported).ok).toBe(false)
    expect(validateInterferenceReport(unsupported).errors).toContain(
      `cell ${unsupported.cells[saturatedIdx].name} must disclose current missing drivers`
    )
    const absent = valid()
    delete absent.cells[0].reachable
    expect(validateInterferenceReport(absent).ok).toBe(false)
    expect(() => createInterferenceReport({ environment: {} })).toThrow(
      'invalid interferenceReport'
    )
  })

  it('records resolved runtime, machine, repository and safe flag evidence', () => {
    const { collect, value } = environment()
    expect(collect).toHaveBeenCalledExactlyOnceWith({ repoRoot: process.cwd() })
    expect(value.nodeVersion).toBe(process.version)
    expect(value.electronVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(value.machine).toMatchObject({ platform: process.platform, arch: process.arch })
    expect(value.machine.totalMemoryBytes).toBeGreaterThan(0)
    expect(value.ollamaMaxLoadedModels).toBe(2)
    expect(value.taskwraithFlags).toEqual({
      TASKWRAITH_CHAT_STORE_V2: '1',
      TASKWRAITH_MCP_TOKEN: '<redacted>',
      TASKWRAITH_RUN_ID: '<present>'
    })
    expect(value.repoProvenance.authoritativeBaseline).toBe(false)
    expect(value.capturedAt).toBe('2026-09-08T12:00:00.000Z')
    expect(
      environmentRecord({ env: { OLLAMA_MAX_LOADED_MODELS: '0' }, collectRepoProvenance: collect })
        .ollamaMaxLoadedModels
    ).toBeNull()
  })
})

describe('main work spans and unsupported Host perf polling', () => {
  it('uses the existing preload IPC through the injected Runtime.evaluate seam', async () => {
    const workSpans = spans()
    const getMainPerfSnapshot = vi.fn(async () => ({
      capturedAt: '2026-09-08T12:00:00.000Z',
      sections: { workSpans },
      host: { cpu: 0 },
      hostPerf: { eventLoopLag: { p95: 1 } }
    }))
    const post = vi.fn(async (_method: string, params: { expression: string }) => ({
      result: {
        value: await runInNewContext(params.expression, { api: { getMainPerfSnapshot } })
      }
    }))
    const sampled = await sampleHostSpans({ post })
    expect(post).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: expect.any(String),
      returnByValue: true,
      awaitPromise: true
    })
    expect(getMainPerfSnapshot).toHaveBeenCalledExactlyOnceWith({ resetLagWindow: false })
    expect(sampled).toEqual({
      workSpans,
      hostPerf: { unsupported: 'host_perf_transport_unspecified' }
    })
    expect(sampled.workSpans).not.toBe(workSpans)
  })

  it('preserves unsupported reasons without filling unobservable values with zero', async () => {
    expect(await sampleHostSpans(null)).toEqual({
      workSpans: { unsupported: 'renderer_runtime_session_required' },
      hostPerf: { unsupported: 'host_perf_transport_unspecified' }
    })
    expect(
      await sampleHostSpans({
        post: async (_method: string, params: { expression: string }) => ({
          result: { value: await runInNewContext(params.expression, {}) }
        })
      })
    ).toEqual({
      workSpans: { unsupported: 'main_perf_snapshot_unavailable' },
      hostPerf: { unsupported: 'host_perf_transport_unspecified' }
    })
    expect(normalizeHostSpanSnapshot({ sections: {} }).workSpans).toEqual({
      unsupported: 'main_work_spans_section_unavailable'
    })
  })

  it('rejects malformed sections, wrong processes and evaluation failures', async () => {
    for (const section of [
      { error: 'failed' },
      { ...spans(), process: 'host' },
      { ...spans(), recorded: NaN }
    ]) {
      expect(
        normalizeHostSpanSnapshot({ sections: { workSpans: section } }).workSpans.unsupported
      ).toContain('main_work_spans_invalid')
    }
    expect(
      (
        await sampleHostSpans({
          post: async () => {
            throw new Error('disconnected')
          }
        })
      ).workSpans.unsupported
    ).toContain('disconnected')
    expect(
      (await sampleHostSpans({ post: async () => ({ exceptionDetails: {} }) })).workSpans
        .unsupported
    ).toBe('main_perf_snapshot_evaluation_exception')
  })

  it('is exported by the collector barrel without launching or attaching', () => {
    expect(require('./collectors/index.cjs').sampleHostSpans).toBe(sampleHostSpans)
  })
})
