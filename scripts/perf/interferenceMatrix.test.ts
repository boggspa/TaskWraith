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
  validateInterferenceReport,
  REPLAY_BASES,
  SEEDED_TAIL_MIN_SEEDED_RECORD_BYTES,
  normalizeReplayDeclaration,
  replayBasisForChat,
  lightAloneCellFor,
  deriveLightAloneFixture,
  assertLightAloneFixtureIdentity,
  checkFixtureSatisfiesHistory
} = require('./interferenceMatrix.cjs')
const { sampleHostSpans, normalizeHostSpanSnapshot } = require('./collectors/hostSpans.cjs')
const { generatePerfFixture } = require('./fixtureGenerator.cjs')
const { splitFixtureScheduleByChat } = require('./t2WindowOrchestration.cjs')

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
    // Third argument is the transport bound, and it is asserted rather than
    // waved through: awaitPromise:true parks this call on the renderer's own
    // promise, and the websocket transport settles a pending request only on
    // reply or socket close.
    expect(post).toHaveBeenCalledWith(
      'Runtime.evaluate',
      {
        expression: expect.any(String),
        returnByValue: true,
        awaitPromise: true
      },
      { timeoutMs: expect.any(Number) }
    )
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

/**
 * Fence-final replay bases (A1.53 Ruling 1, the lifted A1.49 fence): the
 * completeness rule judges each lane against its DECLARED plan — tail-vs-
 * tail for a seeded lane, plan-vs-plan for a whole one — and the paired-
 * coverage rule requires the paired LIGHT lanes to share one basis while
 * the beside run's heavy lane legitimately differs. Seeded-tail is
 * admissible only at or above the 16 MiB snapshot threshold; below it the
 * regimes measurably differ, so the declaration is refused.
 */
describe('fence-final replay bases (tail-vs-tail, asymmetric)', () => {
  /** Work3's measured seeded-record size at production 27k depth. */
  const SEEDED_RECORD_BYTES = 40_011_706

  function evidenceWithReplay(role: string, replayByChat: Record<string, unknown>) {
    const base = evidence(role)
    base.populations = base.populations.map((population: Record<string, unknown>) =>
      replayByChat[population.chatId as string] !== undefined
        ? { ...population, replay: replayByChat[population.chatId as string] }
        : population
    )
    return base
  }

  it('defaults an absent declaration to whole_schedule so legacy evidence keeps validating', () => {
    expect(normalizeReplayDeclaration(undefined)).toEqual({
      ok: true,
      replay: { basis: 'whole_schedule', seededRecordBytes: null }
    })
    expect(pairRuns(run('light-alone'), run('light-beside')).ok).toBe(true)
  })

  it('refuses malformed declarations and unknown bases', () => {
    expect(normalizeReplayDeclaration('seeded_tail').ok).toBe(false)
    expect(normalizeReplayDeclaration({ basis: 'partial' }).ok).toBe(false)
    expect(normalizeReplayDeclaration({ basis: 'seeded_tail' }).ok).toBe(false)
    expect(
      normalizeReplayDeclaration({ basis: 'whole_schedule', seededRecordBytes: 'big' }).ok
    ).toBe(false)
  })

  it('admits seeded-tail only at or above the 16 MiB snapshot threshold', () => {
    expect(SEEDED_TAIL_MIN_SEEDED_RECORD_BYTES).toBe(16 * 1024 * 1024)
    expect(
      normalizeReplayDeclaration({
        basis: 'seeded_tail',
        seededRecordBytes: SEEDED_TAIL_MIN_SEEDED_RECORD_BYTES
      }).ok
    ).toBe(true)
    const below = normalizeReplayDeclaration({
      basis: 'seeded_tail',
      seededRecordBytes: SEEDED_TAIL_MIN_SEEDED_RECORD_BYTES - 1
    })
    expect(below.ok).toBe(false)
    expect(below.reason).toContain('inadmissible')
    // The measured production case: 40,011,706 seeded record bytes at 27k depth.
    expect(
      normalizeReplayDeclaration({ basis: 'seeded_tail', seededRecordBytes: SEEDED_RECORD_BYTES })
        .ok
    ).toBe(true)
  })

  it('accepts the asymmetric pairing: light whole, heavy seeded-tail', () => {
    // The fence-final pairing exactly: the light lane's events fit whole in
    // both runs; the beside run's heavy lane takes the seeded tail. The
    // paired-coverage rule must not call that incomplete.
    const result = pairRuns(
      run('light-alone'),
      run('light-beside', {
        signals: { roundStartMs: { count: 3, p50: 5, p95: 35, p99: 55 } },
        evidence: evidenceWithReplay('light-beside', {
          heavy: { basis: 'seeded_tail', seededRecordBytes: SEEDED_RECORD_BYTES }
        })
      })
    )
    expect(result.ok).toBe(true)
    expect(result.pair.deltas).toEqual({ roundStartMs: { p50: -5, p95: 15, p99: 25 } })
  })

  it('refuses a seeded-tail heavy lane declared below the threshold', () => {
    const result = pairRuns(
      run('light-alone'),
      run('light-beside', {
        evidence: evidenceWithReplay('light-beside', {
          heavy: { basis: 'seeded_tail', seededRecordBytes: 5_497_079 }
        })
      })
    )
    expect(result.ok).toBe(false)
    expect(result.reasons.join(' ')).toContain('inadmissible')
  })

  it('refuses paired light lanes whose bases differ', () => {
    const result = pairRuns(
      run('light-alone', {
        evidence: evidenceWithReplay('light-alone', {
          light: { basis: 'seeded_tail', seededRecordBytes: SEEDED_RECORD_BYTES }
        })
      }),
      run('light-beside')
    )
    expect(result.ok).toBe(false)
    expect(result.reasons.join(' ')).toContain('paired light replay bases differ')
  })

  it('compares tail-vs-tail when both light lanes are seeded, never mixed', () => {
    const result = pairRuns(
      run('light-alone', {
        evidence: evidenceWithReplay('light-alone', {
          light: { basis: 'seeded_tail', seededRecordBytes: SEEDED_RECORD_BYTES }
        })
      }),
      run('light-beside', {
        evidence: evidenceWithReplay('light-beside', {
          light: { basis: 'seeded_tail', seededRecordBytes: SEEDED_RECORD_BYTES },
          heavy: { basis: 'seeded_tail', seededRecordBytes: SEEDED_RECORD_BYTES }
        })
      })
    )
    expect(result.ok).toBe(true)
  })

  it('resolves a population basis by chat id and nothing else', () => {
    expect(REPLAY_BASES).toEqual(['whole_schedule', 'seeded_tail'])
    expect(replayBasisForChat([{ chatId: 'c', role: 'light' }], 'c')).toEqual({
      basis: 'whole_schedule',
      seededRecordBytes: null
    })
    expect(
      replayBasisForChat(
        [
          {
            chatId: 'c',
            role: 'heavy',
            replay: { basis: 'seeded_tail', seededRecordBytes: SEEDED_RECORD_BYTES }
          }
        ],
        'c'
      )
    ).toEqual({ basis: 'seeded_tail', seededRecordBytes: SEEDED_RECORD_BYTES })
    expect(replayBasisForChat([{ chatId: 'c' }], 'other')).toBeNull()
    expect(replayBasisForChat(null, 'c')).toBeNull()
    expect(replayBasisForChat([{ chatId: 'c', replay: { basis: 'bogus' } }], 'c')).toBeNull()
  })
})

/**
 * The `light_alone` cell (fence-final Ruling 2): the full-scale light-alone
 * baseline G-X never legally had. Its fixture is the light half of
 * light_beside_large BY CONSTRUCTION — the same generation restricted to
 * its first chat, never a separately-tuned workload — and the identity
 * assertion reds when the two diverge. Legality falls out of the measured
 * shape: small-shaped (tens of messages, well under the hard 1 MiB bound),
 * so the answering cell is small/1/<same path, mix, saturation>. Relaxing
 * a guard bound to keep it legal is refused outright.
 */
describe('light_alone cell (fence-final Ruling 2)', () => {
  const BESIDE_CELL = {
    history: 'large',
    chats: 2,
    path: 'warm',
    mix: 'codex_profiles_solo_ensemble_mesh',
    saturation: 'none'
  }

  function pairedFixture(scaleDown: number) {
    return generatePerfFixture({ workload: 'light_beside_large', seed: 42, scaleDown })
  }

  it('answers a light-beside cell with small/1 on the same path, mix and saturation', () => {
    const alone = lightAloneCellFor(BESIDE_CELL)
    expect(alone.name).toBe('small/1/warm/codex_profiles_solo_ensemble_mesh/none')
    expect(alone.reachable).toBe(true)
    expect(alone.missingCapability).toEqual([])
    expect(() => lightAloneCellFor({ ...BESIDE_CELL, history: 'huge' })).toThrow(
      /invalid matrix cell/
    )
  })

  it('derives the light half exactly the way the lanes driver splits it', () => {
    const fixture = pairedFixture(40)
    const derived = deriveLightAloneFixture(fixture)
    const lightId = fixture.chats[0].appChatId

    expect(derived.chats).toEqual([fixture.chats[0]])
    // Mirror-equivalence with the lanes driver's own split (terminal sentinel
    // replicated verbatim): the schedule the cell replays is byte-identical
    // to the schedule the beside run's light lane replays.
    expect(derived.replaySchedule).toEqual(splitFixtureScheduleByChat(fixture)[lightId])

    // Totals are recomputed only from the exact per-chat sources; generator
    // accounting that has none stays null rather than being fabricated.
    const lightRunHistory = fixture.totals.runHistoryByChat.find(
      (entry: { appChatId: string }) => entry.appChatId === lightId
    )
    expect(derived.totals.chatCount).toBe(1)
    expect(derived.totals.messageCount).toBe(fixture.chats[0].messages.length)
    expect(derived.totals.runHistoryByChat).toEqual([lightRunHistory])
    expect(derived.totals.runCount).toBe(lightRunHistory.runCount)
    expect(derived.totals.toolActivityCount).toBeNull()
    expect(derived.shape).toBeNull()
    expect(derived.unscaledShape).toBeNull()
    expect(derived.lightAloneDerivation).toMatchObject({
      basis: 'light_half_of_paired_fixture',
      sourceWorkload: 'light_beside_large',
      sourceChatCount: 2,
      lightChatId: lightId
    })
  })

  it('passes identity on the true derivation and reds on any divergence', () => {
    const fixture = pairedFixture(40)
    expect(assertLightAloneFixtureIdentity(deriveLightAloneFixture(fixture), fixture)).toEqual({
      ok: true
    })

    // A same-count mutation must not alias: flip one message id.
    const tamperedChat = deriveLightAloneFixture(fixture)
    tamperedChat.chats = [
      { ...tamperedChat.chats[0], messages: tamperedChat.chats[0].messages.slice() }
    ]
    tamperedChat.chats[0].messages[0] = {
      ...tamperedChat.chats[0].messages[0],
      id: 'tampered-message-id'
    }
    const chatDrift = assertLightAloneFixtureIdentity(tamperedChat, fixture)
    expect(chatDrift.ok).toBe(false)
    expect(chatDrift.reasons[0]).toContain('diverges')

    // A dropped schedule event is drift too — identical fixtures AND windows.
    const tamperedSchedule = deriveLightAloneFixture(fixture)
    tamperedSchedule.replaySchedule = tamperedSchedule.replaySchedule.slice(1)
    expect(assertLightAloneFixtureIdentity(tamperedSchedule, fixture).ok).toBe(false)

    // A single-chat "beside" fixture cannot define a pairing at all.
    const singleChat = { ...fixture, chats: [fixture.chats[0]] }
    expect(assertLightAloneFixtureIdentity(singleChat, singleChat).ok).toBe(false)
    expect(assertLightAloneFixtureIdentity(null, fixture).ok).toBe(false)
  })

  it('keeps the generated light half small-legal at full scale, non-lean (the launch gate)', () => {
    // Boss's gate, measured on the real generator at the evidentiary flags:
    // non-lean, seed 42, scale-down 1. If this ever reds, the cell/pin tier
    // decision re-opens — small's maxBytes is never relaxed to fit.
    const fixture = generatePerfFixture({
      workload: 'light_beside_large',
      seed: 42,
      lean: false,
      scaleDown: 1
    })
    const lightChat = fixture.chats[0]
    const lightShape = {
      messages: lightChat.messages.length,
      bytes: Buffer.byteLength(JSON.stringify([lightChat]))
    }
    expect(lightShape.messages).toBe(41)
    expect(lightShape.bytes).toBeLessThan(1024 * 1024)
    expect(checkFixtureSatisfiesHistory('small', lightShape).ok).toBe(true)
    expect(checkFixtureSatisfiesHistory('large', lightShape).ok).toBe(false)
    // A1.49's observed light lane: 85 chat events plus the terminal sentinel.
    expect(
      fixture.replaySchedule.filter((event) => event.appChatId === lightChat.appChatId)
    ).toHaveLength(85)
    expect(deriveLightAloneFixture(fixture).replaySchedule).toHaveLength(86)
  })
})
