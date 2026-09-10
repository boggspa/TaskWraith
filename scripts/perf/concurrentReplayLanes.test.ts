import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { runConcurrentReplayLanes, percentileSummary } = require('./concurrentReplayLanes.cjs')
const {
  pairRuns,
  createInterferenceReport,
  environmentRecord,
  assertPairedRunCompatibility
} = require('./interferenceMatrix.cjs')
const {
  resolveWorkloadShape,
  generatePerfFixture,
  fixtureFingerprint
} = require('./fixtureGenerator.cjs')

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
  it('resolves the measured-worst-case shape additively', () => {
    const shape = resolveWorkloadShape({ workload: 'large_history' })
    expect(shape.chatCount).toBe(1)
    expect(shape.messageTarget).toBe(27000)
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
