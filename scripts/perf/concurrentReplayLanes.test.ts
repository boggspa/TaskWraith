import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  runConcurrentReplayLanes,
  percentileSummary,
  planLaneReplay,
  measureSeededRecordBytes,
  SEEDED_TAIL_MESSAGE_COUNT
} = require('./concurrentReplayLanes.cjs')
const {
  pairRuns,
  createInterferenceReport,
  environmentRecord,
  assertPairedRunCompatibility,
  SEEDED_TAIL_MIN_SEEDED_RECORD_BYTES
} = require('./interferenceMatrix.cjs')
const {
  resolveWorkloadShape,
  generatePerfFixture,
  fixtureFingerprint
} = require('./fixtureGenerator.cjs')
const { toPersistedChatRecord } = require('./materializeUserData.cjs')

const here = dirname(fileURLToPath(import.meta.url))

/** In-memory page adapter that records the exact cross-chat call order. */
function fakeApi(callLog: string[] = []) {
  const store = new Map<string, Record<string, unknown>>()
  const revisions = new Map<string, number>()
  return {
    callLog,
    async getChat(chatId: string) {
      callLog.push(`get:${chatId}`)
      return store.get(chatId) || null
    },
    async saveChat(record: Record<string, unknown>) {
      const chatId = record.appChatId as string
      callLog.push(`save:${chatId}`)
      // The real store always answers with a HIGHER revision than sent;
      // replayDriver treats a non-advancing ack as a rejected save.
      const sent = typeof record.persistenceRevision === 'number' ? record.persistenceRevision : 0
      const next = Math.max((revisions.get(chatId) || 0) + 1, sent + 1)
      revisions.set(chatId, next)
      store.set(chatId, record)
      return { persistenceRevision: next }
    }
  }
}

function laneChat(chatId: string, messageCount: number) {
  return {
    appChatId: chatId,
    updatedAt: 1,
    persistenceRevision: 0,
    messages: Array.from({ length: messageCount }, (_, index) => ({
      id: `${chatId}-m${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: '2026-09-08T00:00:00.000Z'
    }))
  }
}

function laneSchedule(chatId: string, appends: number) {
  return [
    { seq: 1, kind: 'seed_chat', appChatId: chatId },
    ...Array.from({ length: appends }, (_, index) => ({
      seq: index + 2,
      kind: 'append_assistant',
      appChatId: chatId,
      messageIndex: index + 1
    }))
  ]
}

function lane(role: string, chatId: string, appends: number) {
  return {
    role,
    chatId,
    schedule: laneSchedule(chatId, appends),
    chats: [laneChat(chatId, appends + 1)]
  }
}

const CELL = {
  history: 'small' as const,
  chats: 2 as const,
  path: 'warm' as const,
  mix: 'codex_profiles_solo_ensemble_mesh' as const,
  saturation: 'none' as const
}

function runMetadata() {
  return {
    cell: CELL,
    workload: 'dual_run',
    fixtureFingerprint: 'a'.repeat(64),
    fixtureVersions: { fixtureGenerator: 1 },
    buildId: 'test-build'
  }
}

describe('concurrentReplayLanes (M1 A1.2 — first B2 driver)', () => {
  it('runs two lanes CONCURRENTLY with a seeded, reproducible cross-lane interleave', async () => {
    const logA: string[] = []
    const first = await runConcurrentReplayLanes({
      lanes: [lane('light', 'light-chat', 5), lane('heavy', 'heavy-chat', 5)],
      api: fakeApi(logA),
      seed: 4242,
      windowMs: 60_000,
      diagnosticOnly: true,
      repetitions: 1,
      ...runMetadata()
    })
    expect(first.ok).toBe(true)
    expect(first.censored).toBe(false)
    expect(first.lanes).toHaveLength(2)
    expect(first.lanes.map((l: { eventsApplied: number }) => l.eventsApplied)).toEqual([6, 6])

    // Real interleaving: the second lane STARTS before the first lane ends.
    const firstHeavy = logA.findIndex((entry) => entry.includes('heavy-chat'))
    const lastLight = logA.map((e) => e.includes('light-chat')).lastIndexOf(true)
    expect(firstHeavy).toBeGreaterThan(-1)
    expect(firstHeavy).toBeLessThan(lastLight)

    // Per-lane order is never reordered (per-thread ordering invariant).
    for (const chatId of ['light-chat', 'heavy-chat']) {
      const saves = logA.filter((entry) => entry === `save:${chatId}`)
      expect(saves.length).toBe(6)
    }

    // Determinism pin: the same seed reproduces the exact same call order.
    const logB: string[] = []
    await runConcurrentReplayLanes({
      lanes: [lane('light', 'light-chat', 5), lane('heavy', 'heavy-chat', 5)],
      api: fakeApi(logB),
      seed: 4242,
      windowMs: 60_000,
      diagnosticOnly: true,
      repetitions: 1,
      ...runMetadata()
    })
    expect(logB).toEqual(logA)
    // And the seed genuinely steers the schedule (pinned for seed 4242:
    // mulberry32's first pick lands on the heavy lane).
    expect(logA.slice(0, 3)).toEqual(['save:heavy-chat', 'save:light-chat', 'save:heavy-chat'])
  })

  it('emits light-alone vs light-beside pairing metadata with light-only compared signals', async () => {
    const alone = await runConcurrentReplayLanes({
      lanes: [lane('light', 'light-chat', 3)],
      api: fakeApi(),
      seed: 4242,
      windowMs: 60_000,
      diagnosticOnly: true,
      repetitions: 3,
      ...runMetadata()
    })
    expect(alone.pairingRole).toBe('light-alone')

    const beside = await runConcurrentReplayLanes({
      lanes: [lane('light', 'light-chat', 3), lane('heavy', 'heavy-chat', 3)],
      api: fakeApi(),
      seed: 4242,
      windowMs: 60_000,
      diagnosticOnly: true,
      repetitions: 3,
      ...runMetadata()
    })
    expect(beside.pairingRole).toBe('light-beside')

    expect(Object.keys(alone.signals)).toEqual(['light.applyLatencyMs'])
    expect(Object.keys(beside.signals)).toEqual(['light.applyLatencyMs'])
    expect(alone.run.role).toBe('light-alone')
    expect(beside.run.role).toBe('light-beside')
    expect(alone.run.repetitions).toBe(3)
    expect(alone.run.windowMs).toBe(60_000)
    expect(beside.lanes.find((l: { role: string }) => l.role === 'heavy')).toBeTruthy()
  })

  it('still records all three repetitions when a long schedule censors window 1', async () => {
    // Attempt 3 shape: dual_run's schedule outlives one 120 s fence, so window
    // 1 is censored. Breaking there left replayWindows:1 against 120 s × 3.
    let tick = 0
    const nowMs = () => (tick += 10)
    const result = await runConcurrentReplayLanes({
      lanes: [lane('light', 'light-chat', 40), lane('heavy', 'heavy-chat', 40)],
      api: fakeApi(),
      seed: 4242,
      windowMs: 25,
      repetitions: 3,
      nowMs,
      ...runMetadata()
    })
    expect(result.repetitions).toBe(3)
    expect(result.run.evidence.windows).toHaveLength(3)
    expect(
      result.run.evidence.windows.map((window: { repetition: number }) => window.repetition)
    ).toEqual([0, 1, 2])
    expect(result.censored).toBe(true)
    // Every window censored, none incomplete: an incomplete window still ends
    // the run, so three of them is only reachable through the censored lane.
    expect(
      result.run.evidence.windows.map((window: { outcome: string }) => window.outcome)
    ).toEqual(['censored', 'censored', 'censored'])
  })

  it('censors a lane whose schedule outlives the sampling window', async () => {
    // A clock that advances on every read: the 25 ms window ends long before
    // 40 events per lane can be applied.
    let tick = 0
    const nowMs = () => (tick += 10)
    const result = await runConcurrentReplayLanes({
      lanes: [lane('light', 'light-chat', 40), lane('heavy', 'heavy-chat', 40)],
      api: fakeApi(),
      seed: 4242,
      windowMs: 25,
      repetitions: 1,
      nowMs
    })
    expect(result.censored).toBe(true)
    for (const summary of result.lanes) {
      expect(summary.censored).toBe(true)
      expect(summary.eventsApplied).toBeLessThan(summary.eventsTotal)
    }
  })

  it('produces summaries that validate through pairRuns and validateInterferenceReport', async () => {
    // Observe the full windows with fake time; an instantaneous diagnostic
    // replay is deliberately ineligible, even if its metadata says 120 s.
    async function measured(lanes) {
      vi.useFakeTimers()
      try {
        const pending = runConcurrentReplayLanes({
          api: fakeApi(),
          lanes,
          seed: 4242,
          repetitions: 3,
          nowMs: () => Date.now(),
          ...runMetadata()
        })
        await vi.runAllTimersAsync()
        return await pending
      } finally {
        vi.useRealTimers()
      }
    }
    const alone = await measured([lane('light', 'light-chat', 3)])
    const beside = await measured([lane('light', 'light-chat', 3), lane('heavy', 'heavy-chat', 3)])
    expect(alone.evidenceEligible).toBe(true)
    expect(beside.evidenceEligible).toBe(true)
    expect(assertPairedRunCompatibility(alone.run, beside.run)).toEqual({ ok: true })
    const paired = pairRuns(alone.run, beside.run)
    if (!paired.ok) throw new Error(`pairRuns refused: ${paired.reasons}`)
    expect(paired.pair.deltas['light.applyLatencyMs']).toBeTruthy()

    const environment = environmentRecord({
      env: { OLLAMA_MAX_LOADED_MODELS: '2' },
      now: () => new Date('2026-09-08T16:00:00.000Z'),
      collectRepoProvenance: vi.fn(() => ({
        gitSha: 'b'.repeat(40),
        dirty: false,
        dirtyPaths: [],
        dirtyTreeFingerprint: 'a'.repeat(64),
        isolatedWorktree: false,
        authoritativeBaseline: false
      }))
    })
    const report = createInterferenceReport({
      environment,
      cells: [
        {
          ...CELL,
          name: 'small/2/warm/codex_profiles_solo_ensemble_mesh/none',
          reachable: true,
          missingCapability: []
        }
      ],
      pairs: [paired.pair]
    })
    expect(report.pairs).toHaveLength(1)
  })

  it('records unsupported event kinds honestly instead of inventing outcomes', async () => {
    const chatId = 'light-chat'
    const result = await runConcurrentReplayLanes({
      lanes: [
        {
          role: 'light',
          chatId,
          schedule: [
            { seq: 1, kind: 'seed_chat', appChatId: chatId },
            { seq: 2, kind: 'invented_future_kind', appChatId: chatId }
          ],
          chats: [laneChat(chatId, 2)]
        }
      ],
      api: fakeApi(),
      seed: 4242,
      windowMs: 60_000,
      diagnosticOnly: true,
      repetitions: 1
    })
    expect(result.ok).toBe(false)
    expect(result.evidenceEligible).toBe(false)
    expect(
      result.unsupported.some((u: { event: string }) => u.event === 'invented_future_kind')
    ).toBe(true)
  })

  it('validates lane specs and adapter instead of failing deep inside a run', async () => {
    await expect(runConcurrentReplayLanes({ lanes: [], api: fakeApi(), seed: 1 })).rejects.toThrow(
      'at least one lane'
    )
    await expect(
      runConcurrentReplayLanes({
        lanes: [lane('light', 'light-chat', 1)],
        api: fakeApi(),
        seed: 1.5
      })
    ).rejects.toThrow('seed')
    await expect(
      runConcurrentReplayLanes({
        lanes: [{ role: 'light', chatId: 'x', schedule: [], pairingRole: 'light-beside' }],
        api: fakeApi(),
        seed: 1,
        windowMs: 1000,
        repetitions: 1
      })
    ).rejects.toThrow('pairingRole')
  })

  it('percentileSummary is nearest-rank and empty-safe', () => {
    expect(percentileSummary([])).toEqual({ count: 0, p50: null, p95: null, p99: null, max: null })
    const summary = percentileSummary([10, 1, 5, 100])
    expect(summary).toEqual({ count: 4, p50: 5, p95: 100, p99: 100, max: 100 })
  })
})

describe('large_history fixture profile (M1 A1.2 Appendix A pin)', () => {
  it('resolves the measured-worst-case shape (budgets are targets, not summands)', () => {
    const shape = resolveWorkloadShape({ workload: 'large_history' })
    expect(shape.chatCount).toBe(1)
    expect(shape.messageTarget).toBe(27000)
    // The 45/20 MB budgets still sum to 65 MiB as generator inputs — but tool
    // bytes are a SUBSET of chat bytes (reconciled pin), so this sum is not a
    // disk footprint. Measured seed 42: 44.14 MiB chat incl. 35.06 MiB tools.
    expect(shape.chatSerializedTargetBytes + shape.toolSerializedTargetBytes).toBe(
      Math.round(65 * 1024 * 1024)
    )
    // Existing workload shapes are untouched.
    expect(resolveWorkloadShape({ workload: '30seat' }).messageTarget).toBe(6800)
  })

  it('generates deterministically (same seed → identical fingerprint) at reduced scale', () => {
    const first = generatePerfFixture({ workload: 'large_history', seed: 4242, scaleDown: 200 })
    const second = generatePerfFixture({ workload: 'large_history', seed: 4242, scaleDown: 200 })
    expect(fixtureFingerprint(first)).toBe(fixtureFingerprint(second))
    const other = generatePerfFixture({ workload: 'large_history', seed: 9999, scaleDown: 200 })
    expect(fixtureFingerprint(other)).not.toBe(fixtureFingerprint(first))
  })
})

function depthLane(role: string, chatId: string, depth: number) {
  return {
    role,
    chatId,
    schedule: laneSchedule(chatId, depth),
    chats: [laneChat(chatId, depth)]
  }
}

function recordingApi() {
  const saves: Array<{ chatId: string; messageCount: number }> = []
  const inner = fakeApi()
  return {
    saves,
    async getChat(chatId: string) {
      return inner.getChat(chatId)
    },
    async saveChat(record: Record<string, unknown>) {
      saves.push({
        chatId: record.appChatId as string,
        messageCount: Array.isArray(record.messages) ? record.messages.length : 0
      })
      return inner.saveChat(record)
    }
  }
}

describe('seeded-tail replay driver (A1.52 item 1 producer)', () => {
  it('pins the seeded-tail length as an independent published floor, not a batching constant', () => {
    expect(SEEDED_TAIL_MESSAGE_COUNT).toBe(8)
    expect(SEEDED_TAIL_MIN_SEEDED_RECORD_BYTES).toBe(16 * 1024 * 1024)
    const src = readFileSync(join(here, 'concurrentReplayLanes.cjs'), 'utf8')
    expect(src).toMatch(/SEEDED_TAIL_MESSAGE_COUNT\s*=\s*8\b/)
    expect(src).not.toMatch(/SEEDED_TAIL_MESSAGE_COUNT\s*=\s*DEFAULT_BATCH_SIZE/)
    expect(src).toContain('SEEDED_TAIL_MIN_SEEDED_RECORD_BYTES')
    expect(src).toContain("basis: 'seeded_tail'")
    expect(src).toContain('planLaneReplay')
    // Production default is the imported matrix constant, not a test-only floor.
    expect(src).toMatch(
      /options\.seededTailMinSeededRecordBytes === undefined\s*\n\s*\? SEEDED_TAIL_MIN_SEEDED_RECORD_BYTES/
    )
  })

  it('measures the materialized seed as toPersistedChatRecord compact JSON, not a constant', () => {
    const first = laneChat('heavy-chat', 20)
    const second = { ...first, title: 'different-title-for-bytes' }
    const firstBytes = measureSeededRecordBytes(first)
    const secondBytes = measureSeededRecordBytes(second)
    expect(firstBytes).toBe(
      Buffer.byteLength(JSON.stringify(toPersistedChatRecord(first)), 'utf8')
    )
    expect(secondBytes).not.toBe(firstBytes)
    const withMeta = { ...first, _perfMeta: { toolActivityCount: 99, pad: 'x'.repeat(50) } }
    expect(measureSeededRecordBytes(withMeta)).toBe(firstBytes)
  })

  it('never declares seeded_tail on the light lane, even when the record would admit it', () => {
    const planned = planLaneReplay(depthLane('light', 'light-chat', 20), {
      seededTailMinSeededRecordBytes: 1
    })
    expect(planned.basis).toBe('whole_schedule')
    expect(planned.seededTail).toBeNull()
    expect(planned.schedule).toHaveLength(21)
    expect(planned.rewindMessageCount).toBe(0)
  })

  it('does not declare seeded_tail below the 16 MiB threshold (Ruling 1(c))', () => {
    const planned = planLaneReplay(depthLane('heavy', 'heavy-chat', 20))
    expect(planned.seededRecordBytes).toBeLessThan(SEEDED_TAIL_MIN_SEEDED_RECORD_BYTES)
    expect(planned.basis).toBe('whole_schedule')
    expect(planned.seededTail).toBeNull()
    expect(planned.schedule).toHaveLength(21)
  })

  it('rewinds heavy to depth-minus-tail and records checkable seededTail provenance', () => {
    const lane = depthLane('heavy', 'heavy-chat', 20)
    const planned = planLaneReplay(lane, { seededTailMinSeededRecordBytes: 1 })
    const bytes = measureSeededRecordBytes(lane.chats[0])
    expect(planned.basis).toBe('seeded_tail')
    expect(planned.seedDepth).toBe(20)
    expect(planned.rewindMessageCount).toBe(12)
    expect(planned.seededRecordBytes).toBe(bytes)
    expect(planned.seededTail).toEqual({
      chatId: 'heavy-chat',
      seedDepth: 20,
      seededRecordBytes: bytes,
      firstSeq: 1,
      lastSeq: 21,
      tailEventCount: planned.schedule.length
    })
    expect(planned.seededTail.tailEventCount).toBe(1 + 8)
    const prefixes = planned.schedule
      .filter((event: { kind: string }) => event.kind !== 'seed_chat')
      .map((event: { messageIndex: number }) => event.messageIndex)
    expect(prefixes).toEqual([13, 14, 15, 16, 17, 18, 19, 20])
  })

  it('emits the producer declaration on populations and rewinds the first tail save, not to message 1', async () => {
    const api = recordingApi()
    const light = depthLane('light', 'light-chat', 20)
    const heavy = depthLane('heavy', 'heavy-chat', 20)
    const result = await runConcurrentReplayLanes({
      lanes: [light, heavy],
      api,
      seed: 4242,
      windowMs: 60_000,
      diagnosticOnly: true,
      repetitions: 1,
      seededTailMinSeededRecordBytes: 1,
      ...runMetadata()
    })
    const populations = result.run.evidence.populations
    const heavyBytes = measureSeededRecordBytes(heavy.chats[0])
    const heavyTail = {
      chatId: 'heavy-chat',
      seedDepth: 20,
      seededRecordBytes: heavyBytes,
      firstSeq: 1,
      lastSeq: 21,
      tailEventCount: 9
    }
    // Exact shape, not toMatchObject: light has no replay field (defaults to
    // whole_schedule); heavy carries the producer declaration. That asymmetry
    // is the ruling. Out-of-scope t2PairedRuns/t2RunEvidence pins stay {role,
    // chatId} on under-threshold fixtures because those never take this branch.
    expect(populations).toEqual([
      { role: 'light', chatId: 'light-chat' },
      {
        role: 'heavy',
        chatId: 'heavy-chat',
        replay: { basis: 'seeded_tail', seededRecordBytes: heavyBytes },
        materializedSeed: {
          chatId: 'heavy-chat',
          seedDepth: 20,
          seededRecordBytes: heavyBytes
        },
        seededTail: heavyTail
      }
    ])

    const heavyWindow = result.run.evidence.windows[0].lanes.find(
      (item: { role: string }) => item.role === 'heavy'
    )
    expect(heavyWindow.plannedEvents).toBe(heavyTail.tailEventCount)
    expect(heavyWindow.completedEvents).toBe(heavyTail.tailEventCount)
    expect(heavyWindow.plannedEvents).toBeLessThan(21)

    const heavySaves = api.saves.filter((entry) => entry.chatId === 'heavy-chat')
    expect(heavySaves[0].messageCount).toBe(20)
    expect(heavySaves[1].messageCount).toBe(13)
    expect(heavySaves[1].messageCount).not.toBe(1)
    expect(heavySaves.map((entry) => entry.messageCount)).toEqual([20, 13, 14, 15, 16, 17, 18, 19, 20])
  })
})

describe('light_beside_large fixture profile (M1 G-X pairing shape)', () => {
  it('resolves the asymmetric two-chat shape exactly', () => {
    const shape = resolveWorkloadShape({ workload: 'light_beside_large' })
    expect(shape.chatCount).toBe(2)
    expect(shape.dualConcurrentRuns).toBe(true)
    expect(shape.messageTarget).toBe(27040)
    expect(shape.toolActivityTarget).toBe(20280)
    expect(shape.chatShapes).toHaveLength(2)
    const [light, heavy] = shape.chatShapes
    // Light chat first: 4 seats × 10 turns, one tool per assistant.
    expect(light.seatCount).toBe(4)
    expect(light.turnsPerSeat).toBe(10)
    expect(light.toolsPerAssistant).toBe(1)
    expect(light.expectedTools).toBe(40)
    expect(light.toolSerializedTargetBytes).toBe(Math.round(0.5 * 1024 * 1024))
    // Heavy chat carries the reconciled large pin: 30 seats × 900 turns.
    expect(heavy.seatCount).toBe(30)
    expect(heavy.turnsPerSeat).toBe(900)
    expect(heavy.toolsPerAssistant).toBe(1)
    expect(heavy.expectedTools).toBe(27000)
    expect(heavy.toolSerializedTargetBytes).toBe(Math.round(20 * 1024 * 1024))
    // Deleting the chatShapes branch (or the whole case) turns this red.
    expect(shape.chatShapes === undefined).toBe(false)
  })

  it('scaleDown divides per-chat turn targets instead of generating full-scale', () => {
    const fixture = generatePerfFixture({
      workload: 'light_beside_large',
      seed: 42,
      lean: true,
      scaleDown: 100
    })
    expect(fixture.chats).toHaveLength(2)
    // 1 opening user + ceil(turns/100) × seats assistants per chat.
    expect(fixture.chats[0].messages).toHaveLength(1 + 1 * 4)
    expect(fixture.chats[1].messages).toHaveLength(1 + 9 * 30)
    expect(fixture.chats[0]._perfMeta.toolActivityCount).toBe(4)
    expect(fixture.chats[1]._perfMeta.toolActivityCount).toBe(270)
    expect(fixture.totals.messageCount).toBe(5 + 271)
    // The unscaled shape keeps the full-size entries for pairing records.
    expect(fixture.unscaledShape.chatShapes.map((s) => s.turnsPerSeat)).toEqual([10, 900])
    expect(fixture.unscaledShape.chatShapes.map((s) => s.expectedTools)).toEqual([40, 27000])
  })

  it('non-lean metadata stays finite and tool bytes stay inside chat bytes', () => {
    const fixture = generatePerfFixture({
      workload: 'light_beside_large',
      seed: 42,
      scaleDown: 100
    })
    for (const chat of fixture.chats) {
      expect(Number.isFinite(chat._perfMeta.paramBytes)).toBe(true)
      expect(Number.isFinite(chat._perfMeta.rawBytes)).toBe(true)
      // Reconciled pin: tool bytes are a subset of chat bytes, never additive.
      expect(chat._perfMeta.toolSerializedBytes).toBeGreaterThan(0)
      expect(chat._perfMeta.toolSerializedBytes).toBeLessThanOrEqual(
        chat._perfMeta.chatSerializedBytes
      )
    }
  })

  it('generates deterministically (same seed → identical fingerprint) at reduced scale', () => {
    const first = generatePerfFixture({
      workload: 'light_beside_large',
      seed: 4242,
      scaleDown: 200
    })
    const second = generatePerfFixture({
      workload: 'light_beside_large',
      seed: 4242,
      scaleDown: 200
    })
    expect(fixtureFingerprint(first)).toBe(fixtureFingerprint(second))
    const other = generatePerfFixture({
      workload: 'light_beside_large',
      seed: 9999,
      scaleDown: 200
    })
    expect(fixtureFingerprint(other)).not.toBe(fixtureFingerprint(first))
  })
})
