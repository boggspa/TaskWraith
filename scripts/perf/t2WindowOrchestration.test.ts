import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildT2LaneSpecs,
  runT2WindowedReplay,
  splitFixtureScheduleByChat
} = require('./t2WindowOrchestration.cjs')
const { cellName, validateRunEvidence } = require('./interferenceMatrix.cjs')
const { FIXTURE_GENERATOR_VERSION } = require('./fixtureGenerator.cjs')

const CELL = {
  history: 'small',
  chats: 2,
  path: 'warm',
  mix: 'codex_profiles_solo_ensemble_mesh',
  saturation: 'none'
}

function chat(appChatId: string) {
  return { appChatId, updatedAt: 1, persistenceRevision: 0, messages: [] }
}

function seedEvent(appChatId: string, seq: number) {
  return { kind: 'seed_chat', appChatId, seq }
}

function fixture() {
  return {
    chats: [chat('perf-chat-01'), chat('perf-chat-02')],
    replaySchedule: [
      seedEvent('perf-chat-01', 1),
      seedEvent('perf-chat-02', 2),
      seedEvent('perf-chat-01', 3),
      seedEvent('perf-chat-02', 4),
      { kind: 'schedule_complete', seq: 5 }
    ]
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

function orchestrate(options: Record<string, unknown> = {}) {
  return runT2WindowedReplay({
    fixture: fixture(),
    api: api(),
    cellName: cellName(CELL),
    workload: 'windowed-replay-test',
    seed: 4242,
    fixtureFingerprint: 'a'.repeat(64),
    buildId: 'synthetic-test-build',
    nowMs: () => Date.now(),
    ...options
  })
}

async function measured(options: Record<string, unknown> = {}) {
  vi.useFakeTimers()
  const pending = orchestrate(options)
  await vi.runAllTimersAsync()
  return await pending
}

afterEach(() => {
  vi.useRealTimers()
})

describe('splitFixtureScheduleByChat', () => {
  it('splits the interleaved schedule per chat preserving per-chat order', () => {
    const split = splitFixtureScheduleByChat(fixture())
    expect(Object.keys(split).sort()).toEqual(['perf-chat-01', 'perf-chat-02'])
    expect(split['perf-chat-01'].map((event) => event.seq)).toEqual([1, 3, 5])
    expect(split['perf-chat-02'].map((event) => event.seq)).toEqual([2, 4, 5])
  })

  it('replicates the terminal schedule_complete sentinel to every lane', () => {
    const split = splitFixtureScheduleByChat(fixture())
    for (const chatId of ['perf-chat-01', 'perf-chat-02']) {
      const last = split[chatId][split[chatId].length - 1]
      expect(last.kind).toBe('schedule_complete')
      expect(last.appChatId).toBeUndefined()
    }
  })

  it('refuses events targeting chats absent from the fixture', () => {
    const bad = fixture()
    bad.replaySchedule = [...bad.replaySchedule, seedEvent('perf-chat-99', 6)]
    expect(() => splitFixtureScheduleByChat(bad)).toThrow(/unknown chat/)
  })

  it('refuses fixtures with no chats or no schedule', () => {
    expect(() => splitFixtureScheduleByChat({ chats: [], replaySchedule: [] })).toThrow(
      /at least one chat/
    )
    expect(() => splitFixtureScheduleByChat({ chats: [chat('a')] })).toThrow(/replaySchedule/)
  })
})

describe('buildT2LaneSpecs', () => {
  it('maps the first chat to light and the rest to heavy with own-chat state', () => {
    const lanes = buildT2LaneSpecs(fixture())
    expect(lanes.map((lane) => [lane.chatId, lane.role])).toEqual([
      ['perf-chat-01', 'light'],
      ['perf-chat-02', 'heavy']
    ])
    expect(lanes[0].chats.map((entry) => entry.appChatId)).toEqual(['perf-chat-01'])
    expect(lanes[1].chats.map((entry) => entry.appChatId)).toEqual(['perf-chat-02'])
  })

  it('refuses a chat with zero schedulable events instead of building a doomed lane', () => {
    const bad = fixture()
    bad.replaySchedule = bad.replaySchedule.filter(
      (event) => event.appChatId !== 'perf-chat-02' || event.kind === 'schedule_complete'
    )
    expect(() => buildT2LaneSpecs(bad)).toThrow(/zero schedulable events/)
  })
})

describe('runT2WindowedReplay', () => {
  it('observes three full windows with matching signals through fake timers', async () => {
    const result = await measured()
    expect(result.evidenceEligible).toBe(true)
    expect(validateRunEvidence(result.run)).toEqual([])
    expect(result.run.evidence.windows).toHaveLength(3)
    expect(result.pairingRole).toBe('light-beside')
    const lightSamples = result.run.evidence.windows.reduce(
      (total, window) => total + window.lanes.find((lane) => lane.role === 'light').measuredSamples,
      0
    )
    expect(result.run.signals['light.applyLatencyMs'].count).toBe(lightSamples)
    expect(result.run.fixtureVersions).toEqual({
      fixtureGenerator: FIXTURE_GENERATOR_VERSION
    })
  })

  it('reads a single-chat fixture as light-alone', async () => {
    const solo = fixture()
    solo.chats = [chat('perf-chat-01')]
    solo.replaySchedule = [seedEvent('perf-chat-01', 1), { kind: 'schedule_complete', seq: 2 }]
    const result = await measured({ fixture: solo })
    expect(result.pairingRole).toBe('light-alone')
    expect(result.evidenceEligible).toBe(true)
  })

  it('refuses to qualify short windows as 120-second samples', async () => {
    const result = await measured({ windowMs: 1000 })
    expect(result.evidenceEligible).toBe(false)
    expect(validateRunEvidence(result.run)).toContain(
      'qualified evidence requires the 120-second, three-repetition sampling contract'
    )
  })

  it('surfaces driver failures instead of reshaping them', async () => {
    const failing = api()
    failing.saveChat.mockRejectedValueOnce(new Error('synthetic save failure'))
    const result = await measured({ api: failing, seed: 7 })
    expect(result.evidenceEligible).toBe(false)
    const failedLanes = result.run.evidence.windows.flatMap((window) =>
      window.lanes.filter((lane) => lane.failedEvents > 0)
    )
    expect(failedLanes.length).toBeGreaterThan(0)
    expect(result.evidenceErrors.length).toBeGreaterThan(0)
  })

  it('replays deterministically under a fixed seed', async () => {
    const counters = (result) =>
      result.run.evidence.windows.map((window) =>
        window.lanes.map((lane) => [lane.completedEvents, lane.measuredSamples])
      )
    const first = await measured({ seed: 99 })
    const second = await measured({ seed: 99 })
    expect(counters(first)).toEqual(counters(second))
  })
})
