import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { runT2PairedReplay } = require('./t2PairedRuns.cjs')
const {
  cellName,
  cellReachability,
  createInterferenceReport,
  validateInterferenceReport,
  validateRunEvidence
} = require('./interferenceMatrix.cjs')
const { FIXTURE_GENERATOR_VERSION } = require('./fixtureGenerator.cjs')

const CELL = {
  history: 'small',
  chats: 2,
  path: 'warm',
  mix: 'codex_profiles_solo_ensemble_mesh',
  saturation: 'none'
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

function pairOptions(overrides: Record<string, unknown> = {}) {
  return {
    fixture: fixture(),
    api: api(),
    cellName: cellName(CELL),
    workload: 'paired-replay-test',
    seed: 4242,
    fixtureFingerprint: 'a'.repeat(64),
    buildId: 'synthetic-test-build',
    nowMs: () => Date.now(),
    ...overrides
  }
}

async function measured(overrides: Record<string, unknown> = {}) {
  vi.useFakeTimers()
  const pending = runT2PairedReplay(pairOptions(overrides))
  await vi.runAllTimersAsync()
  return await pending
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runT2PairedReplay', () => {
  it('runs light-alone then light-beside against one fixture and qualifies the pair', async () => {
    const result = await measured()
    expect(result.alone.pairingRole).toBe('light-alone')
    expect(result.beside.pairingRole).toBe('light-beside')
    expect(result.alone.evidenceEligible).toBe(true)
    expect(result.beside.evidenceEligible).toBe(true)
    expect(validateRunEvidence(result.alone.run)).toEqual([])
    expect(validateRunEvidence(result.beside.run)).toEqual([])
    expect(result.alone.run.role).toBe('light-alone')
    expect(result.beside.run.role).toBe('light-beside')
    expect(result.alone.run.fixtureFingerprint).toBe(result.beside.run.fixtureFingerprint)
    expect(result.alone.run.seed).toBe(4242)
    expect(result.beside.run.seed).toBe(4242)
    expect(result.alone.run.buildId).toBe('synthetic-test-build')
    expect(result.alone.run.fixtureVersions).toEqual({
      fixtureGenerator: FIXTURE_GENERATOR_VERSION
    })
    expect(result.beside.run.evidence.populations).toEqual([
      { role: 'light', chatId: 'perf-chat-01' },
      { role: 'heavy', chatId: 'perf-chat-02' }
    ])
    expect(result.alone.run.evidence.populations).toEqual([
      { role: 'light', chatId: 'perf-chat-01' }
    ])
    expect(result.pairing.ok).toBe(true)
    expect(result.pairing.pair.cellName).toBe(cellName(CELL))
    expect(result.pairing.pair.deltas['light.applyLatencyMs']).toBeTruthy()

    const report = createInterferenceReport({
      environment,
      cells: [{ ...CELL, name: cellName(CELL), ...cellReachability(CELL) }],
      pairs: [result.pairing.pair]
    })
    expect(report.pairs).toHaveLength(1)
    expect(validateInterferenceReport(report)).toEqual({ ok: true, errors: [] })
  })

  it('keeps short windows ineligible and never manufactures a pair', async () => {
    const result = await measured({ windowMs: 1000 })
    expect(result.alone.evidenceEligible).toBe(false)
    expect(result.beside.evidenceEligible).toBe(false)
    expect(result.pairing.ok).toBe(false)
    expect(result.pairing.pair).toBeUndefined()
    expect(result.pairing.reasons.some((reason: string) => reason.includes('windowMs'))).toBe(true)
    expect(
      validateInterferenceReport({
        schemaVersion: 2,
        environment,
        cells: [{ ...CELL, name: cellName(CELL), ...cellReachability(CELL) }],
        pairs: []
      })
    ).toEqual({ ok: true, errors: [] })
  })

  it('refuses a single-chat fixture instead of emitting a one-sided pair', async () => {
    const solo = fixture()
    solo.chats = [chat('perf-chat-01')]
    solo.replaySchedule = [seedEvent('perf-chat-01', 1), { kind: 'schedule_complete', seq: 2 }]
    await expect(runT2PairedReplay(pairOptions({ fixture: solo }))).rejects.toThrow(/heavy lane/)
  })

  it('refuses an operator-declared pairingRole', async () => {
    await expect(runT2PairedReplay(pairOptions({ pairingRole: 'light-beside' }))).rejects.toThrow(
      /pairingRole/
    )
  })

  it('replays both roles deterministically under a fixed seed', async () => {
    const counters = (result) => ({
      alone: result.alone.run.evidence.windows.map((window) =>
        window.lanes.map((lane) => [lane.completedEvents, lane.measuredSamples])
      ),
      beside: result.beside.run.evidence.windows.map((window) =>
        window.lanes.map((lane) => [lane.completedEvents, lane.measuredSamples])
      )
    })
    const first = await measured({ seed: 99 })
    const second = await measured({ seed: 99 })
    expect(counters(first)).toEqual(counters(second))
  })
})
