import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  childTerminationRecord,
  abortExitCode,
  createT2HostWindowSampler,
  DEFAULT_HOST_WINDOW_SAMPLE_INTERVAL_MS,
  verifyT2PairedLightAloneCoverage,
  declareT2RunReplayBases,
  carryT2DriverPopulationFields,
  pairedRunRecord
} = require('./runT2Baseline.cjs')
const { generatePerfFixture } = require('./fixtureGenerator.cjs')
const { deriveLightAloneFixture } = require('./interferenceMatrix.cjs')
const src = readFileSync(new URL('./runT2Baseline.cjs', import.meta.url), 'utf8')

/** Synthetic 40 MiB payload above the 16 MiB seeded-tail floor — not a measured record size. */
const ABOVE_THRESHOLD_BYTES = 40 * 1024 * 1024

describe('T2 capture hang guards (source pins)', () => {
  it('bounds in-flight heap_snapshot with the remaining capture budget', () => {
    expect(src).toContain('function remainingCaptureBudgetMs()')
    expect(src).toContain('timeoutMs: remainingCaptureBudgetMs()')
    expect(src).toContain('awaitWithTimeout(')
    expect(src).toContain('capture:profiles_stop.renderer')
  })

  it('runs SIGTERM/SIGINT through the same terminateExactChild path', () => {
    // The handler now carries which signal arrived, so it can exit with that
    // signal's code; both still route through the one stopLaunch path.
    expect(src).toContain("process.once('SIGINT', () => stopLaunch('SIGINT'))")
    expect(src).toContain("process.once('SIGTERM', () => stopLaunch('SIGTERM'))")
    expect(src).toContain('signal: launchAbort.signal')
    expect(src).toContain('options.signal.addEventListener')
    expect(src).toContain('userDataPath: userDataResolved.userDataPath')
  })

  it('does not skip heap_snapshot under --lean', () => {
    expect(src).toContain('collectRendererHeapSnapshot(renderer')
    expect(src).not.toMatch(/args\.lean[\s\S]{0,80}heap_snapshot/)
    expect(src).not.toMatch(/heap_snapshot[\s\S]{0,80}args\.lean/)
  })

  it('passes the 120s × 3 sampling contract into the paired path', () => {
    expect(src).toContain('MATRIX_SAMPLING')
    expect(src).toContain('windowMs:')
    expect(src).toContain('MATRIX_SAMPLING.windowMs')
    expect(src).toContain('MATRIX_SAMPLING.repetitions')
    expect(src).toContain('aloneReplayWindows:')
  })
})

describe('abort lane (source pins — the launch harness lives in perfHarness.test.ts)', () => {
  it('makes the abort sticky so a pre-spawn signal still refuses the launch', () => {
    expect(src).toContain('let launchAborted = false')
    expect(src).toContain('launchAborted = true')
    expect(src).toContain("throw new Error('Refusing --launch: aborted before spawn")
    // The guard has to precede the spawn, not merely exist.
    expect(src.indexOf('Refusing --launch: aborted before spawn')).toBeLessThan(
      src.indexOf('childSession = spawnExactElectronChild(')
    )
  })
})

describe('stray reap audit record', () => {
  it('keeps the force and stray-kill facts that a clean-looking shutdown hides', () => {
    expect(
      childTerminationRecord({
        pid: 1,
        terminated: true,
        usedForce: true,
        killedProcessGroup: true,
        strayKills: [{ pid: 42, reason: 'listening on owned inspector port' }],
        strayReapSupported: true
      })
    ).toEqual({
      usedForce: true,
      killedProcessGroup: true,
      strayKills: [{ pid: 42, reason: 'listening on owned inspector port' }],
      strayReapSupported: true
    })
  })

  it('records no termination at all rather than an empty one, and invents no kills', () => {
    expect(childTerminationRecord(null)).toBeNull()
    expect(childTerminationRecord(undefined)).toBeNull()
    // A truthy non-record must not become a claim about force or kills.
    expect(childTerminationRecord({ usedForce: 'yes', strayKills: 'two' })).toEqual({
      usedForce: false,
      killedProcessGroup: false,
      strayKills: [],
      strayReapSupported: null
    })
  })

  it('never upgrades a missing reap claim into a supported one', () => {
    // Absent is not "supported": on win32 the probes cannot run, so an empty
    // strayKills with no flag says nothing about whether anything was searched.
    expect(childTerminationRecord({ strayKills: [] }).strayReapSupported).toBeNull()
    expect(childTerminationRecord({ strayKills: [], strayReapSupported: false })).toMatchObject({
      strayReapSupported: false
    })
    expect(childTerminationRecord({ strayKills: [], strayReapSupported: true })).toMatchObject({
      strayReapSupported: true
    })
  })

  it('carries the record into the report, the cleanup journal and the abort path', () => {
    expect(src).toContain('report.childTermination = childTermination')
    expect(src).toContain('{ childTermination }')
    expect(src).toContain('abortTermination: record')
  })
})

describe('aborted runs leave honestly', () => {
  it("never yields 0, and carries the signal's own conventional code", () => {
    expect(abortExitCode('SIGTERM')).toBe(143)
    expect(abortExitCode('SIGINT')).toBe(130)
    // Anything else is still an abort, so it is still not a success.
    expect(abortExitCode(null)).toBe(143)
    expect(abortExitCode('SIGHUP')).toBe(143)
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP', null]) {
      expect(abortExitCode(name)).not.toBe(0)
    }
  })

  it('wires that code through the handler and both promise lanes', () => {
    expect(src).toContain('process.exitCode = abortExitCode(signalName)')
    expect(src).toContain('process.exit(abortExitCode(signalName))')
    // The success lane must refuse to print ok:true after an abort...
    expect(src).toContain('process.exit(abortExitCode(abortedBy))')
    // ...and the failure lane must not downgrade the signal to a plain 1.
    expect(src).toContain('process.exit(abortedBy ? abortExitCode(abortedBy) : 1)')
  })

  it('terminalises the progress record the moment the abort arrives', () => {
    expect(src).toContain("updateProgress({ status: 'aborted' }, { log: false })")
    // Attempt 4 left `running` in the journal for 18 minutes after its SIGTERM.
    expect(src.indexOf("status: 'aborted'")).toBeLessThan(
      src.indexOf('const session = childSession')
    )
  })
})

/**
 * T9c — the during-replay Host window sampler (A1.52's second remaining M1
 * measurement item: "sampling during each role/window"). The once-after-
 * capture read stays as the cell's run-level fold (T9b); these tests pin the
 * new sampler's behaviour and its wiring position around the windowed replay.
 */
describe('T2 host window sampler (T9c)', () => {
  const BOOT_EPOCH = 'a'.repeat(64)
  const PIN = { instanceId: 'host-abc', generation: 2, pid: 777, bootEpoch: BOOT_EPOCH }

  function probeOk(extra: Record<string, unknown> = {}) {
    return async () => ({
      ok: true,
      expectedIdentity: { ...PIN },
      welcome: { hostId: 'host-abc', generation: 2, bootEpoch: BOOT_EPOCH },
      discovery: { pid: 777, startedAt: '2026-09-18T00:00:00.000Z' },
      ...extra
    })
  }

  function fakeTimers() {
    const armed: Array<{ callback: () => unknown; ms: number }> = []
    const cleared: unknown[] = []
    return {
      armed,
      cleared,
      timers: {
        setInterval: (callback: () => unknown, ms: number) => {
          armed.push({ callback, ms })
          return armed.length
        },
        clearInterval: (handle: unknown) => {
          cleared.push(handle)
        }
      }
    }
  }

  function acceptedRead(sequence: number): Record<string, unknown> {
    return {
      sequence,
      capturedAt: new Date(sequence * 5_000).toISOString(),
      eventLoopLag: { unsupported: 'host_perf_lag_unobserved' },
      workSpans: { process: 'host', byKind: {}, byResource: {} }
    }
  }

  it('pins the Host identity once, then keeps one accepted read per sequence', async () => {
    const { armed, timers } = fakeTimers()
    const baseProbe = probeOk()
    let probeCalls = 0
    const probe = async () => {
      probeCalls += 1
      return baseProbe()
    }
    const reads: string[] = []
    const sampler = createT2HostWindowSampler({
      userDataPath: '/tmp/userData',
      hostPerfSnapshotPath: '/tmp/host-snapshot.json',
      requiredChatIds: ['chat-light'],
      probe,
      read: async (options: { expectedIdentity?: unknown }) => {
        reads.push(JSON.stringify(options.expectedIdentity))
        return acceptedRead(1)
      },
      timers
    })

    await sampler.start()
    expect(probeCalls).toBe(1)
    expect(armed).toHaveLength(1)
    expect(armed[0].ms).toBe(DEFAULT_HOST_WINDOW_SAMPLE_INTERVAL_MS)
    expect(sampler.summary().status).toBe('sampling')

    // A timer tick samples; the same sequence again is a no-op, a lower one
    // is refused — deltas are computed over strictly increasing captures.
    await armed[0].callback()
    await sampler.sampleOnce()
    const summary = sampler.stop()
    expect(summary.accepted).toBe(1)
    expect(summary.duplicateSequence).toBe(1)
    expect(summary.samples).toHaveLength(1)
    expect(summary.firstSequence).toBe(1)
    expect(summary.lastSequence).toBe(1)
    // The read pin is the probed identity, not a file-derived one.
    expect(reads).toHaveLength(2)
    expect(JSON.parse(reads[0])).toEqual(PIN)
  })

  it('counts refusals by marker and never throws a sample into the run', async () => {
    const { timers } = fakeTimers()
    const sampler = createT2HostWindowSampler({
      userDataPath: '/tmp/userData',
      probe: probeOk(),
      read: async () => ({ unsupported: 'host_perf_snapshot_stale' }),
      timers
    })
    await sampler.start()
    expect(await sampler.sampleOnce()).toBe(false)
    expect(await sampler.sampleOnce()).toBe(false)
    const summary = sampler.stop()
    expect(summary.status).toBe('stopped')
    expect(summary.accepted).toBe(0)
    expect(summary.refusals).toEqual({ host_perf_snapshot_stale: 2 })
    expect(summary.lastRefusal).toBe('host_perf_snapshot_stale')
    expect(summary.samples).toEqual([])
  })

  it('degrades on a probe failure and leaves T9b to make its own call', async () => {
    const { armed, timers } = fakeTimers()
    const sampler = createT2HostWindowSampler({
      userDataPath: '/tmp/userData',
      probe: async () => ({ ok: false, stage: 'discovery', reason: 'discovery_absent' }),
      read: async () => acceptedRead(1),
      timers
    })
    expect(await sampler.start()).toBe(false)
    expect(armed).toHaveLength(0)
    expect(await sampler.sampleOnce()).toBe(false)
    const summary = sampler.stop()
    expect(summary.status).toBe('degraded')
    expect(summary.marker).toBe('host_window_discovery_unavailable: discovery_absent')
    expect(summary.polls).toBe(0)
  })

  it('contains probe bait: only bounded identity fields reach the summary', async () => {
    const { timers } = fakeTimers()
    const sampler = createT2HostWindowSampler({
      userDataPath: '/tmp/userData',
      probe: probeOk({
        expectedIdentity: { ...PIN, token: 'TOKEN_BAIT', tokenPath: '/bait/token' },
        welcome: { hostId: 'host-abc', generation: 2, tokenPath: '/bait/token' },
        discovery: { pid: 777, socketPath: '/bait/socket' }
      }),
      read: async () => acceptedRead(1),
      timers
    })
    await sampler.start()
    await sampler.sampleOnce()
    const serialized = JSON.stringify(sampler.stop())
    expect(serialized).not.toContain('TOKEN_BAIT')
    expect(serialized).not.toContain('/bait/token')
    expect(serialized).not.toContain('/bait/socket')
    expect(serialized).not.toContain('tokenPath')
  })

  it('counts a throwing read instead of letting it reject the timer tick', async () => {
    const { timers } = fakeTimers()
    const sampler = createT2HostWindowSampler({
      userDataPath: '/tmp/userData',
      probe: probeOk(),
      read: async () => {
        throw new Error('disk on fire')
      },
      timers
    })
    await sampler.start()
    expect(await sampler.sampleOnce()).toBe(false)
    const summary = sampler.stop()
    expect(summary.refusals['host_window_sample_threw: disk on fire']).toBe(1)
  })

  it('samples during the windowed replay and stops in a finally (wiring pins)', () => {
    const code = src
    const createAt = code.indexOf('hostWindowSampler = createT2HostWindowSampler({')
    const startAt = code.indexOf('await hostWindowSampler.start()')
    const replayAt = code.indexOf('await runWindowedOrPairedReplay(api, {')
    const stopAt = code.indexOf('hostWindowSampleSummary = hostWindowSampler.stop()')
    expect(createAt).toBeGreaterThan(-1)
    expect(startAt).toBeGreaterThan(createAt)
    expect(replayAt).toBeGreaterThan(startAt)
    expect(stopAt).toBeGreaterThan(replayAt)
    // The stop rides a finally: a replay that throws cannot leave the sampler
    // reading into the capture phase its samples claim to precede.
    expect(code).toContain('} finally {')
    const finallyAt = code.lastIndexOf('} finally {', stopAt)
    expect(finallyAt).toBeGreaterThan(replayAt)
    expect(finallyAt).toBeLessThan(stopAt)
  })

  it('assembles per-role/window evidence from the driver observed windows (wiring pins)', () => {
    const code = src
    expect(code).toContain('report.hostSpanWindows = null')
    const assembleAt = code.indexOf('report.hostSpanWindows = {')
    expect(assembleAt).toBeGreaterThan(-1)
    expect(code).toContain('aggregateHostWindowSamples({')
    expect(code).toContain('result.run?.evidence?.windows')
    // The paired path feeds BOTH roles' observed windows to the bucketing.
    expect(code).toContain('collectRoleWindows(pairedReplayResult.alone)')
    expect(code).toContain('collectRoleWindows(pairedReplayResult.beside)')
    // The run-level T9b fold is untouched and still precedes the report end.
    expect(code).toContain('const hostSpanEvidence = await collectT2HostSpanEvidence({')
    expect(code).toContain('report.hostSpans = hostSpanEvidence.record')
  })
})

/**
 * Wave-3 light_alone wiring (fence-final Ruling 2): the launcher must
 * PRODUCE the derived fixture and ENFORCE the identity on a live run — a
 * guard only the suite can trip does not protect the measurement. Behaviour
 * pins for the two exported helpers plus the wiring source pins; the
 * CLI-level red-first pins live in perfHarness.test.ts.
 */
describe('T2 light_alone wiring (fence-final Ruling 2, wave 3)', () => {
  function pairedFixture() {
    return generatePerfFixture({ workload: 'light_beside_large', seed: 42, scaleDown: 40 })
  }

  function pairedResultWithLightPlan(plannedEvents: number | null) {
    const fixture = pairedFixture()
    const lightChatId = fixture.chats[0].appChatId
    return {
      fixture,
      result: {
        alone: {
          run: {
            evidence: {
              windows: [
                {
                  repetition: 0,
                  lanes: plannedEvents === null ? [] : [{ chatId: lightChatId, plannedEvents }]
                }
              ]
            }
          }
        }
      }
    }
  }

  it('verifies the paired alone leg replayed exactly the derived light half', () => {
    const { fixture, result } = pairedResultWithLightPlan(
      deriveLightAloneFixture(pairedFixture()).replaySchedule.length
    )
    const ok = verifyT2PairedLightAloneCoverage(result, fixture)
    expect(ok.ok).toBe(true)
    expect(ok.derivedLightAlone.lightAloneDerivation).toMatchObject({
      basis: 'light_half_of_paired_fixture',
      sourceWorkload: 'light_beside_large'
    })
  })

  it('refuses a pair whose alone leg replayed anything else (live element 2b)', () => {
    const derived = deriveLightAloneFixture(pairedFixture())
    const { fixture, result } = pairedResultWithLightPlan(derived.replaySchedule.length - 1)
    const wrongCount = verifyT2PairedLightAloneCoverage(result, fixture)
    expect(wrongCount.ok).toBe(false)
    expect(wrongCount.reasons[0]).toContain('setup drift')

    const missingLane = verifyT2PairedLightAloneCoverage(
      pairedResultWithLightPlan(null).result,
      fixture
    )
    expect(missingLane.ok).toBe(false)

    const noWindows = verifyT2PairedLightAloneCoverage(
      { alone: { run: { evidence: {} } } },
      fixture
    )
    expect(noWindows.ok).toBe(false)
    expect(noWindows.reasons[0]).toContain('no observed windows')
  })

  it('declares whole_schedule by default and NEVER overwrites a driver-declared basis', () => {
    // The Addition-1 pin: a blanket whole_schedule stamp would fabricate
    // over the seeded-tail driver's truthful declaration from the other
    // direction. A pre-declared basis is preserved byte-for-byte.
    const run = {
      evidence: {
        populations: [
          { role: 'light', chatId: 'light' },
          {
            role: 'heavy',
            chatId: 'heavy',
            replay: { basis: 'seeded_tail', seededRecordBytes: ABOVE_THRESHOLD_BYTES }
          }
        ]
      }
    }
    declareT2RunReplayBases(run)
    expect(run.evidence.populations[0].replay).toEqual({ basis: 'whole_schedule' })
    expect(run.evidence.populations[1].replay).toEqual({
      basis: 'seeded_tail',
      seededRecordBytes: ABOVE_THRESHOLD_BYTES
    })
  })

  it('carries a driver-declared seeded_tail across the descriptor rebuild (the drop fix)', () => {
    // RED if the carry is removed: without it the rebuild drops the driver's
    // declaration and the defaulting loop stamps whole_schedule over a real
    // seeded_tail — the fabrication this slice exists to prevent. The pin
    // fails on a DROPPED declaration, not merely an overwritten one.
    const run = {
      evidence: {
        populations: [
          { role: 'light', chatId: 'light' },
          { role: 'heavy', chatId: 'heavy' }
        ]
      }
    }
    const driverResult = {
      run: {
        evidence: {
          populations: [
            { role: 'light', chatId: 'light' },
            {
              role: 'heavy',
              chatId: 'heavy',
              replay: { basis: 'seeded_tail', seededRecordBytes: ABOVE_THRESHOLD_BYTES }
            }
          ]
        }
      }
    }
    carryT2DriverPopulationFields(run, driverResult)
    declareT2RunReplayBases(run)
    expect(run.evidence.populations[1].replay).toEqual({
      basis: 'seeded_tail',
      seededRecordBytes: ABOVE_THRESHOLD_BYTES
    })
    expect(run.evidence.populations[0].replay).toEqual({ basis: 'whole_schedule' })
    // The carried declaration is a copy, never an alias of live driver state.
    expect(run.evidence.populations[1].replay).not.toBe(
      driverResult.run.evidence.populations[1].replay
    )
  })

  it('matches driver declarations by chatId, never by index', () => {
    const run = {
      evidence: {
        populations: [
          { role: 'heavy', chatId: 'heavy' },
          { role: 'light', chatId: 'light' }
        ]
      }
    }
    const driverResult = {
      run: {
        evidence: {
          populations: [
            { role: 'light', chatId: 'light' },
            {
              role: 'heavy',
              chatId: 'heavy',
              replay: { basis: 'seeded_tail', seededRecordBytes: ABOVE_THRESHOLD_BYTES }
            }
          ]
        }
      }
    }
    carryT2DriverPopulationFields(run, driverResult)
    expect(run.evidence.populations[0].replay).toEqual({
      basis: 'seeded_tail',
      seededRecordBytes: ABOVE_THRESHOLD_BYTES
    })
    // The undeclared light lane stays undeclared until the defaulting loop.
    expect(run.evidence.populations[1].replay).toBeUndefined()
    // A null driver result carries nothing and cannot throw.
    expect(() => carryT2DriverPopulationFields(run, null)).not.toThrow()
  })

  it('carries EVERY driver-emitted population field, not an allowlist (completeness red-first)', () => {
    // The third iteration of one defect: declaration dropped, then
    // provenance dropped. RED if the carry ever goes back to naming fields —
    // this driver population emits a field nobody allowlisted, and it must
    // survive anyway. Completeness is pinned, not the three known names.
    const run = {
      evidence: {
        populations: [
          { role: 'light', chatId: 'light' },
          { role: 'heavy', chatId: 'heavy' }
        ]
      }
    }
    const driverResult = {
      run: {
        evidence: {
          populations: [
            { role: 'light', chatId: 'light' },
            {
              role: 'heavy',
              chatId: 'heavy',
              replay: { basis: 'seeded_tail', seededRecordBytes: ABOVE_THRESHOLD_BYTES },
              materializedSeed: {
                chatId: 'heavy',
                seedDepth: 27_001,
                seededRecordBytes: ABOVE_THRESHOLD_BYTES
              },
              seededTail: {
                chatId: 'heavy',
                seedDepth: 27_001,
                seededRecordBytes: ABOVE_THRESHOLD_BYTES,
                firstSeq: 26_994,
                lastSeq: 27_001,
                tailEventCount: 9
              },
              // A field nobody designed for: the allowlist trap. If the
              // carry ever names fields, this one dies silently.
              futureDriverField: { nested: [1, 2, 3] }
            }
          ]
        }
      }
    }
    carryT2DriverPopulationFields(run, driverResult)
    const heavy = run.evidence.populations[1]
    expect(heavy.replay).toEqual({ basis: 'seeded_tail', seededRecordBytes: ABOVE_THRESHOLD_BYTES })
    expect(heavy.materializedSeed).toEqual({
      chatId: 'heavy',
      seedDepth: 27_001,
      seededRecordBytes: ABOVE_THRESHOLD_BYTES
    })
    expect(heavy.seededTail).toEqual({
      chatId: 'heavy',
      seedDepth: 27_001,
      seededRecordBytes: ABOVE_THRESHOLD_BYTES,
      firstSeq: 26_994,
      lastSeq: 27_001,
      tailEventCount: 9
    })
    expect(heavy.futureDriverField).toEqual({ nested: [1, 2, 3] })
    expect(heavy.seededTail).not.toBe(driverResult.run.evidence.populations[1].seededTail)
    // A field the descriptor ALREADY holds is never touched, even when the
    // driver's value differs — neither side stamps the other.
    const held = {
      evidence: {
        populations: [{ role: 'light', chatId: 'light', replay: { basis: 'whole_schedule' } }]
      }
    }
    carryT2DriverPopulationFields(held, driverResult)
    expect(held.evidence.populations[0].replay).toEqual({ basis: 'whole_schedule' })
  })

  it('carries driver declarations BEFORE the defaulting loop (wiring pins)', () => {
    const code = src
    const buildAt = code.indexOf('report.runEvidence = buildT2RunEvidence({')
    const carryAt = code.indexOf(
      'carryT2DriverPopulationFields(report.runEvidence, windowedReplayResult)'
    )
    const declareAt = code.indexOf('declareT2RunReplayBases(report.runEvidence)')
    expect(buildAt).toBeGreaterThan(-1)
    expect(carryAt).toBeGreaterThan(buildAt)
    expect(declareAt).toBeGreaterThan(carryAt)
  })

  it('surfaces per-lane measured cost on the runner report blocks (calibration datum)', () => {
    // RED if the heavy lane's apply cost stops reaching the artifact: the
    // calibration run reads report.windowedReplay.lanes (single-role leg)
    // and the paired path's pairedRunRecord.lanes — light-only signals are
    // by design, so these blocks are where heavy cost lives.
    const driverResult = {
      pairingRole: 'light-beside',
      run: {
        role: 'light-beside',
        windowMs: 120_000,
        repetitions: 3,
        evidence: { status: 'complete', windows: [] },
        signals: { 'light.applyLatencyMs': { count: 9, p50: 1, p95: 2, p99: 3 } }
      },
      evidenceEligible: true,
      lanes: [
        {
          role: 'light',
          chatId: 'light',
          eventsApplied: 86,
          eventsTotal: 258,
          eventFailures: 0,
          censored: false,
          applyLatencyMs: { count: 258, p50: 4, p95: 9, p99: 12 }
        },
        {
          role: 'heavy',
          chatId: 'heavy',
          eventsApplied: 9,
          eventsTotal: 27,
          eventFailures: 0,
          censored: false,
          applyLatencyMs: { count: 27, p50: 1_400, p95: 2_100, p99: 2_600 }
        }
      ]
    }
    const record = pairedRunRecord(driverResult)
    expect(record.lanes).toHaveLength(2)
    expect(record.lanes[1].applyLatencyMs).toEqual({
      count: 27,
      p50: 1_400,
      p95: 2_100,
      p99: 2_600
    })
    // Deep-copied, never an alias of live driver state.
    expect(record.lanes[1]).not.toBe(driverResult.lanes[1])
    expect(record.lanes[1].applyLatencyMs).not.toBe(driverResult.lanes[1].applyLatencyMs)
    // A null lanes array degrades to empty, never a throw or a fabrication.
    expect(
      pairedRunRecord({ run: { role: 'light-beside', evidence: {} }, lanes: undefined }).lanes
    ).toEqual([])

    const code = src
    expect(code).toContain('lanes: Array.isArray(windowedReplayResult.lanes)')
  })

  it('derives the fixture before fingerprinting, on light-alone only (wiring pins)', () => {
    const code = src
    const generateAt = code.indexOf('const generatedFixture = generatePerfFixture({')
    const deriveAt = code.indexOf(
      'pairingRole === ' + "'light-alone' && generatedFixture.chats.length >= 2"
    )
    const fingerprintAt = code.indexOf('const fingerprint = fixtureFingerprint(fixture)')
    expect(generateAt).toBeGreaterThan(-1)
    expect(deriveAt).toBeGreaterThan(generateAt)
    expect(fingerprintAt).toBeGreaterThan(deriveAt)
    // The deriver is dependency-injectable so a test can make it diverge.
    expect(code).toContain('options.lightAloneFixtureDeriver')
    // --paired-runs is unaffected: the derivation is keyed on pairingRole,
    // which is null there, so the shared full-fixture fingerprint stands.
    expect(code).toContain('pairingRole is null there')
  })

  it('enforces the identity live at construction and refuses on divergence (wiring pins)', () => {
    const code = src
    expect(code).toContain('assertLightAloneFixtureIdentity(fixture, generatedFixture)')
    expect(code).toContain('T2_LIGHT_ALONE_DERIVATION_DIVERGED')
    // The assert runs only when a derivation actually happened.
    expect(code).toContain('if (fixture !== generatedFixture) {')
  })

  it('carries the derivation provenance into the artifact (wiring pins)', () => {
    const code = src
    expect(code).toContain('lightAloneDerivation: fixture.lightAloneDerivation ?? null')
    // The paired alone leg carries the same construction provenance.
    expect(code).toContain('report.pairedRuns.lightAlone.lightAloneDerivation')
  })

  it('verifies the paired coverage and excludes a drifted pair (wiring pins)', () => {
    const code = src
    expect(code).toContain('verifyT2PairedLightAloneCoverage(pairedReplayResult, fixture)')
    expect(code).toContain('pairingOk: pairing.ok === true && lightAloneReasons.length === 0')
    expect(code).toContain('pairing.ok && lightAloneReasons.length === 0 ? [pairing.pair] : []')
  })

  it('declares replay bases on the runner evidence descriptor (wiring pins)', () => {
    const code = src
    expect(code).toContain('declareT2RunReplayBases(report.runEvidence)')
    expect(code).toContain('if (population.replay === undefined) {')
  })
})
