import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { runConcurrentReplayLanes } = require('./concurrentReplayLanes.cjs')
const {
  assertPairedRunCompatibility,
  pairRuns,
  validateRunEvidence,
  createInterferenceReport,
  validateInterferenceReport,
  cellName,
  cellReachability
} = require('./interferenceMatrix.cjs')

const CELL = {
  history: 'small',
  chats: 2,
  path: 'warm',
  mix: 'codex_profiles_solo_ensemble_mesh',
  saturation: 'none'
}
const metadata = {
  cell: CELL,
  workload: 'replay-evidence-test',
  seed: 4242,
  fixtureFingerprint: 'a'.repeat(64),
  fixtureVersions: { fixtureGenerator: 1 },
  buildId: 'synthetic-test-build'
}
const environment = {
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

function lane(role = 'light', chatId = role) {
  return {
    role,
    chatId,
    schedule: [{ kind: 'seed_chat', appChatId: chatId }],
    chats: [{ appChatId: chatId, updatedAt: 1, persistenceRevision: 0, messages: [] }]
  }
}
function api() {
  return {
    getChat: vi.fn(async () => null),
    saveChat: vi.fn(async (record: { persistenceRevision?: number }) => ({
      persistenceRevision: (record.persistenceRevision || 0) + 1
    }))
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function start(options: Record<string, unknown> = {}) {
  return runConcurrentReplayLanes({
    ...metadata,
    api: api(),
    lanes: [lane()],
    nowMs: () => Date.now(),
    ...options
  })
}
async function measured(options: Record<string, unknown> = {}) {
  vi.useFakeTimers()
  const pending = start(options)
  await vi.runAllTimersAsync()
  return await pending
}
async function validPair() {
  const alone = await measured()
  const beside = await measured({ lanes: [lane(), lane('heavy')] })
  expect(alone.evidenceEligible).toBe(true)
  expect(beside.evidenceEligible).toBe(true)
  const paired = pairRuns(alone.run, beside.run)
  expect(paired.ok).toBe(true)
  return { alone, beside, pair: paired.pair }
}
function report(pair) {
  return createInterferenceReport({
    environment,
    cells: [{ ...CELL, name: cellName(CELL), ...cellReachability(CELL) }],
    pairs: [pair]
  })
}
function assertIneligible(alone, beside) {
  expect(pairRuns(alone, beside).ok).toBe(false)
  // Independently validate the serialized boundary, without relying on the
  // caller to inspect a top-level driver flag or the pair builder's return.
  const document = {
    schemaVersion: 2,
    environment,
    cells: [{ ...CELL, name: cellName(CELL), ...cellReachability(CELL) }],
    pairs: [
      {
        cellName: cellName(CELL),
        lightAlone: alone,
        lightBeside: beside,
        deltas: { 'light.applyLatencyMs': { p50: 0, p95: 0, p99: 0 } }
      }
    ]
  }
  expect(validateInterferenceReport(document).ok).toBe(false)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('qualified replay evidence', () => {
  it('observes all three full windows even when the finite schedules finish immediately', async () => {
    vi.useFakeTimers()
    const adapter = api()
    let returned = false
    const pending = start({ api: adapter }).then((result) => {
      returned = true
      return result
    })
    await vi.advanceTimersByTimeAsync(119_999)
    expect(returned).toBe(false)
    expect(adapter.saveChat).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(returned).toBe(false)
    expect(adapter.saveChat).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(240_000)
    const result = await pending
    expect(result.evidenceEligible).toBe(true)
    expect(result.run.evidence.windows.map((window) => window.elapsedMs)).toEqual([
      120_000, 120_000, 120_000
    ])
    expect(result.run.evidence.windows.map((window) => window.lanes[0].measuredSamples)).toEqual([
      1, 1, 1
    ])
    expect(result.signals['light.applyLatencyMs'].count).toBe(3)
    for (let index = 1; index < 3; index += 1) {
      expect(result.run.evidence.windows[index].startedAtMs).toBeGreaterThanOrEqual(
        result.run.evidence.windows[index - 1].endedAtMs
      )
    }
  })

  it('retains short diagnostic durations and refuses to qualify them as 120-second samples', async () => {
    const { beside } = await validPair()
    const result = await measured({ diagnosticOnly: true })
    expect(result.ok).toBe(true)
    expect(result.run.diagnosticOnly).toBe(true)
    expect(result.run.windowMs).toBe(120_000)
    expect(result.run.evidence.windows.map((window) => window.elapsedMs)).toEqual([0, 0, 0])
    expect(result.evidenceEligible).toBe(false)
    assertIneligible(result.run, beside.run)
  })

  it('rejects empty light data at both pair boundaries and preserves missing percentiles', async () => {
    const { beside } = await validPair()
    const empty = lane()
    empty.schedule = []
    const result = await measured({ lanes: [empty] })
    expect(result.ok).toBe(false)
    expect(result.run.incomplete).toBe(true)
    expect(result.signals['light.applyLatencyMs']).toEqual({
      count: 0,
      p50: null,
      p95: null,
      p99: null,
      max: null
    })
    assertIneligible(result.run, beside.run)
  })

  it('rejects failing saves including a falsy rejection, rather than producing successful zero data', async () => {
    const { beside } = await validPair()
    const adapter = api()
    adapter.saveChat.mockRejectedValue(undefined)
    const result = await measured({ api: adapter })
    expect(result.ok).toBe(false)
    expect(result.run.failed).toBe(true)
    expect(result.run.evidence.windows[0].lanes[0].failedEvents).toBe(1)
    expect(result.signals['light.applyLatencyMs'].count).toBe(0)
    assertIneligible(result.run, beside.run)
  })

  it('distinguishes unsupported events and no-op events from measured latency', async () => {
    const { beside } = await validPair()
    const unsupported = lane()
    unsupported.schedule[0].kind = 'unknown-event'
    const result = await measured({ lanes: [unsupported] })
    expect(result.ok).toBe(false)
    expect(result.run.unsupported).toBe(true)
    expect(result.run.evidence.windows[0].lanes[0].unsupportedEvents).toBe(1)
    assertIneligible(result.run, beside.run)

    const noop = lane()
    noop.schedule[0].kind = 'schedule_complete'
    const noSamples = await measured({ lanes: [noop] })
    expect(noSamples.signals['light.applyLatencyMs'].count).toBe(0)
    expect(noSamples.evidenceEligible).toBe(false)
    assertIneligible(noSamples.run, beside.run)
  })

  it('requires observed light/heavy overlap in every beside repetition', async () => {
    const { alone } = await validPair()
    const sequential = await measured({ lanes: [lane(), lane('heavy')], maxInFlight: 1 })
    expect(sequential.ok).toBe(true)
    expect(
      sequential.run.evidence.windows.map((window) => window.lanes[0].overlappedLightSamples)
    ).toEqual([0, 0, 0])
    expect(sequential.evidenceEligible).toBe(false)
    assertIneligible(alone.run, sequential.run)
  })

  it('keeps short windows and missing provenance ineligible even with complete effects', async () => {
    const short = await measured({ windowMs: 5, repetitions: 1 })
    expect(short.ok).toBe(true)
    expect(short.run.evidence.windows[0].elapsedMs).toBe(5)
    expect(short.evidenceEligible).toBe(false)
    const missing = await measured({ buildId: undefined })
    expect(missing.ok).toBe(true)
    expect(missing.evidenceEligible).toBe(false)
    const { beside } = await validPair()
    assertIneligible(missing.run, beside.run)
  })

  it('pairs only the same light identity and comparable light coverage', async () => {
    const { alone, beside } = await validPair()
    const otherLight = await measured({ lanes: [lane('light', 'other-light'), lane('heavy')] })
    expect(otherLight.evidenceEligible).toBe(true)
    assertIneligible(alone.run, otherLight.run)
    const fewerSamples = structuredClone(beside.run)
    for (const window of fewerSamples.evidence.windows) {
      const light = window.lanes[0]
      light.plannedEvents = 2
      light.startedEvents = 2
      light.completedEvents = 2
      light.measuredSamples = 2
    }
    fewerSamples.signals['light.applyLatencyMs'].count = 6
    expect(validateRunEvidence(fewerSamples)).toEqual([])
    assertIneligible(alone.run, fewerSamples)
  })

  it('versions eligibility separately from legacy metadata compatibility', async () => {
    const { alone, beside, pair } = await validPair()
    const document = report(pair)
    expect(document.schemaVersion).toBe(2)
    expect(validateInterferenceReport(document)).toEqual({ ok: true, errors: [] })
    expect(validateInterferenceReport({ ...document, schemaVersion: 1 }).ok).toBe(false)
    const legacy = { ...alone.run }
    delete legacy.evidence
    expect(assertPairedRunCompatibility(legacy, beside.run)).toEqual({ ok: true })
    assertIneligible(legacy, beside.run)
  })

  it('rechecks failure and coverage claims in serialized report pairs', async () => {
    const { alone, beside, pair } = await validPair()
    const mutations = [
      (run) => {
        run.censored = true
      },
      (run) => {
        run.failed = true
      },
      (run) => {
        run.unsupported = true
      },
      (run) => {
        run.incomplete = true
      },
      (run) => {
        run.evidence.schemaVersion = 99
      },
      (run) => {
        run.evidence.windows.pop()
      },
      (run) => {
        run.evidence.windows[0].elapsedMs = 0
      },
      (run) => {
        run.evidence.windows[0].reason = 'diagnostic_complete'
      },
      (run) => {
        run.evidence.windows[0].failed = true
      },
      (run) => {
        run.evidence.windows[1].startedAtMs = run.evidence.windows[0].startedAtMs
      },
      (run) => {
        run.evidence.windows[0].lanes[0].pendingEvents = 1
      },
      (run) => {
        run.evidence.windows[0].lanes[0].lateEvents = 1
      },
      (run) => {
        run.evidence.windows[0].lanes[0].failedEvents = 1
      },
      (run) => {
        run.evidence.windows[0].lanes[0].unsupportedEvents = 1
      },
      (run) => {
        run.evidence.windows[0].lanes[0].measuredSamples = 0
      },
      (run) => {
        run.evidence.populations.push({ ...run.evidence.populations[0] })
      },
      (run) => {
        run.evidence.lightChatId = 'unmeasured'
      },
      (run) => {
        run.signals['light.applyLatencyMs'].count = 0
      }
    ]
    for (const mutate of mutations) {
      const changed = structuredClone(alone.run)
      mutate(changed)
      expect(validateRunEvidence(changed).length).toBeGreaterThan(0)
      assertIneligible(changed, beside.run)
      const document = report(pair)
      document.pairs[0].lightAlone = changed
      expect(validateInterferenceReport(document).ok).toBe(false)
    }
  })
})

describe('deadlines retain unresolved effect ownership', () => {
  it('returns at a real short deadline even when an adapter never resolves', async () => {
    const adapter = api()
    adapter.saveChat.mockImplementationOnce(() => new Promise(() => {}))
    const result = await start({ api: adapter, windowMs: 5 })
    expect(result.run.censored).toBe(true)
    expect(result.run.incomplete).toBe(true)
    expect(result.run.evidence.windows).toHaveLength(1)
    expect(result.run.evidence.windows[0].lanes[0].pendingEvents).toBe(1)
    expect(adapter.saveChat).toHaveBeenCalledTimes(1)
  })

  it('does not start a second repetition or reuse a chat until late effects settle', async () => {
    vi.useFakeTimers()
    const adapter = api()
    const late = deferred<{ persistenceRevision: number }>()
    adapter.saveChat.mockImplementationOnce(() => late.promise)
    const pending = start({ api: adapter })
    await vi.advanceTimersByTimeAsync(120_000)
    const result = await pending
    expect(result.run.censored).toBe(true)
    expect(result.run.incomplete).toBe(true)
    expect(result.run.evidence.windows).toHaveLength(1)
    expect(adapter.saveChat).toHaveBeenCalledTimes(1)
    const snapshot = JSON.stringify(result.run)
    await expect(start({ api: adapter })).rejects.toThrow('still owned')
    // Ownership is per chat: unrelated work on the same attached instance is fine.
    const unrelated = await measured({ api: adapter, lanes: [lane('light', 'unrelated')] })
    expect(unrelated.ok).toBe(true)
    late.resolve({ persistenceRevision: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.stringify(result.run)).toBe(snapshot)
    expect((await measured({ api: adapter })).evidenceEligible).toBe(true)
  })

  it('keeps raw effects owned after a per-event timeout and observes late rejection safely', async () => {
    vi.useFakeTimers()
    const adapter = api()
    const late = deferred<{ persistenceRevision: number }>()
    adapter.saveChat.mockImplementationOnce(() => late.promise)
    const pending = start({ api: adapter, eventTimeoutMs: 5 })
    await vi.advanceTimersByTimeAsync(5)
    const result = await pending
    expect(result.run.evidence.windows[0].reason).toBe('event_timeout')
    expect(result.run.evidence.windows).toHaveLength(1)
    expect(result.evidenceEligible).toBe(false)
    await expect(start({ api: adapter })).rejects.toThrow('still owned')
    late.reject(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect((await measured({ api: adapter })).evidenceEligible).toBe(true)
  })

  it('only releases unresolved ownership on an explicit positive drain acknowledgement', async () => {
    vi.useFakeTimers()
    const adapter = api()
    const late = deferred<{ persistenceRevision: number }>()
    adapter.saveChat.mockImplementationOnce(() => late.promise)
    const cancelPending = vi.fn(async () => {
      late.reject(new Error('owned adapter cancelled and drained'))
      return { effectsSettled: true }
    })
    const pending = start({ api: adapter, windowMs: 5, cancelPending })
    await vi.advanceTimersByTimeAsync(5)
    const result = await pending
    expect(cancelPending).toHaveBeenCalledExactlyOnceWith({
      reason: 'deadline',
      pending: [{ chatId: 'light', eventIndex: 0, kind: 'seed_chat' }]
    })
    expect(result.cleanup.status).toBe('confirmed_drained')
    expect(result.evidenceEligible).toBe(false)
    expect(result.run.evidence.windows).toHaveLength(1)
    expect((await measured({ api: adapter })).evidenceEligible).toBe(true)
  })

  it.each(['unconfirmed', 'failed', 'timed_out'])(
    'bounds cleanup and retains ownership after %s cleanup',
    async (status) => {
      vi.useFakeTimers()
      const adapter = api()
      const late = deferred<{ persistenceRevision: number }>()
      adapter.saveChat.mockImplementationOnce(() => late.promise)
      const cancelPending = vi.fn(() => {
        if (status === 'failed') throw new Error('cannot cancel')
        if (status === 'timed_out') return new Promise(() => {})
        return { effectsSettled: false }
      })
      const pending = start({ api: adapter, windowMs: 5, cleanupTimeoutMs: 7, cancelPending })
      await vi.advanceTimersByTimeAsync(12)
      const result = await pending
      expect(result.cleanup.status).toBe(status)
      expect(result.run.evidence.windows).toHaveLength(1)
      await expect(start({ api: adapter })).rejects.toThrow('still owned')
      late.resolve({ persistenceRevision: 1 })
      await vi.advanceTimersByTimeAsync(0)
    }
  )

  it('captures latency at settlement before later polling clock reads', async () => {
    let calls = 0
    let postLaunchReads = 0
    const adapter = api()
    adapter.saveChat.mockImplementation(async (record) => {
      calls += 1
      return { persistenceRevision: (record.persistenceRevision || 0) + 1 }
    })
    const result = await start({
      api: adapter,
      lanes: [lane(), lane('heavy')],
      repetitions: 1,
      windowMs: 1000,
      diagnosticOnly: true,
      nowMs: () => (calls < 2 ? 0 : ++postLaunchReads <= 2 ? postLaunchReads * 10 : 100)
    })
    expect(result.lanes.map((item) => item.applyLatencyMs.p50).sort((a, b) => a - b)).toEqual([
      10, 20
    ])
  })
})

describe('replay input boundaries', () => {
  it('does not strand phantom ownership when an event timer cannot be armed', async () => {
    vi.useFakeTimers()
    const adapter = api()
    let timerCalls = 0
    await expect(
      start({
        api: adapter,
        eventTimeoutMs: 10,
        timers: {
          setTimeout: (...args) => {
            if (++timerCalls === 2) throw new Error('cannot arm event timer')
            return setTimeout(...args)
          },
          clearTimeout
        }
      })
    ).rejects.toThrow('cannot arm')
    expect(adapter.saveChat).not.toHaveBeenCalled()
    expect((await measured({ api: adapter })).evidenceEligible).toBe(true)
  })

  it('contains timer cleanup errors without losing completed effect ownership', async () => {
    const adapter = api()
    const result = await measured({
      api: adapter,
      eventTimeoutMs: 10,
      timers: {
        setTimeout: (...args) => setTimeout(...args),
        clearTimeout: (timer) => {
          clearTimeout(timer)
          throw new Error('cleanup failed')
        }
      }
    })
    expect(result.evidenceEligible).toBe(true)
    expect((await measured({ api: adapter })).evidenceEligible).toBe(true)
  })

  it.each([0, -1, 1.5, NaN, Infinity, '2', null])(
    'refuses maxInFlight %s before any effect',
    async (maxInFlight) => {
      const adapter = api()
      await expect(start({ api: adapter, maxInFlight })).rejects.toThrow('maxInFlight')
      expect(adapter.saveChat).not.toHaveBeenCalled()
    }
  )

  it.each([NaN, Infinity, -1, '0'])(
    'refuses invalid initial clock %s before any effect',
    async (reading) => {
      const adapter = api()
      await expect(start({ api: adapter, nowMs: () => reading })).rejects.toThrow('nowMs')
      expect(adapter.saveChat).not.toHaveBeenCalled()
    }
  )

  it('refuses a noncallable clock and catches later clock failure or regression', async () => {
    await expect(start({ nowMs: 1 })).rejects.toThrow('nowMs')
    for (const mode of ['throw', 'regress']) {
      vi.useFakeTimers()
      let reads = 0
      const adapter = api()
      const result = await measured({
        api: adapter,
        nowMs: () => {
          if (++reads < 3) return 100
          if (mode === 'throw') throw new Error('clock failed')
          return 99
        }
      })
      expect(result.ok).toBe(false)
      expect(result.run.failed).toBe(true)
      expect(result.evidenceEligible).toBe(false)
      expect(adapter.saveChat).not.toHaveBeenCalled()
    }
  })

  it('does not invent elapsed coverage from a constant clock when the timer fences the run', async () => {
    const result = await measured({ nowMs: () => 0 })
    expect(result.run.evidence.windows[0].elapsedMs).toBe(0)
    expect(result.evidenceEligible).toBe(false)
    expect(result.run.evidence.windows).toHaveLength(1)
  })

  it('rejects duplicate chat ownership, ambiguous light identity and contradictory pairing roles', async () => {
    const cases = [
      { lanes: [lane(), lane('heavy', 'light')] },
      { lanes: [lane(), lane('light', 'second-light')] },
      { lanes: [lane('heavy')] },
      { lanes: [lane()], pairingRole: 'light-beside' },
      { lanes: [lane(), lane('heavy')], pairingRole: 'light-alone' }
    ]
    for (const options of cases) {
      const adapter = api()
      await expect(start({ ...options, api: adapter })).rejects.toThrow('invalid lane specs')
      expect(adapter.saveChat).not.toHaveBeenCalled()
    }
  })

  it('rejects events and fixture records targeting a different chat before mutation', async () => {
    const wrongEvent = lane()
    wrongEvent.schedule[0].appChatId = 'someone-else'
    const wrongFixture = lane()
    wrongFixture.chats[0].appChatId = 'someone-else'
    const duplicateFixture = lane()
    duplicateFixture.chats.push({ ...duplicateFixture.chats[0] })
    for (const invalid of [wrongEvent, wrongFixture, duplicateFixture]) {
      const adapter = api()
      await expect(start({ api: adapter, lanes: [invalid] })).rejects.toThrow('invalid lane specs')
      expect(adapter.saveChat).not.toHaveBeenCalled()
    }
  })
})
