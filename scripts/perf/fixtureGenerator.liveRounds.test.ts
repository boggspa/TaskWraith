import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { reconcileStaleChatRuns } from '../../src/main/ChatRunReconciler'
import { normalizeCatalogueChatRecord } from '../../src/main/store/ThreadCatalogueNormalize'
import type { ChatRecord } from '../../src/main/store/types'

const require = createRequire(import.meta.url)
const generator = require('./fixtureGenerator.cjs') as {
  LIVE_ROUND_SEAT: { provider: string; model: string }
  LIVE_LANE_MODELS: string[]
  generatePerfFixture: (options: Record<string, unknown>) => {
    workload: string
    shape: { liveSeats?: { provider: string; model: string; chatModels?: string[] } }
    chats: Array<ChatRecord & { ensemble: { activeRound: { status: string } } }>
    replaySchedule: unknown[] | null
  }
}
const { materializePerfUserData } = require('./materializeUserData.cjs') as {
  materializePerfUserData: (options: Record<string, unknown>) => {
    replayPath: string | null
    manifest: Record<string, unknown>
  }
}
const { WORKLOADS } = require('./schema.cjs') as { WORKLOADS: string[] }
const { runBaselineCli } = require('./runBaseline.cjs') as {
  runBaselineCli: (argv: string[], options: Record<string, unknown>) => unknown
}
const { DEFAULT_MODEL } = require('./scriptedOllamaDaemon.cjs') as {
  DEFAULT_MODEL: { name: string }
}

const SCALE_DOWN = 50
const temporaryPaths: string[] = []

afterEach(() => {
  while (temporaryPaths.length > 0) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

function userDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'perf-live-rounds-'))
  temporaryPaths.push(dir)
  return join(dir, 'TaskWraith Dev perf-live')
}

function fixture(workload: string) {
  return generator.generatePerfFixture({ workload, seed: 42, scaleDown: SCALE_DOWN })
}

function settledAtBoot(chats: readonly ChatRecord[]): number {
  // Boot reconciliation with nothing live, as the app runs it at startup.
  return reconcileStaleChatRuns(chats, () => false, '2026-09-24T12:00:00.000Z').settlements.length
}

describe('light_beside_large_live workload', () => {
  it('is a declared workload whose chats each run their own scripted Ollama tag', () => {
    expect(WORKLOADS).toContain('light_beside_large_live')
    // The daemon serves this tag unless the runner configures another.
    expect(generator.LIVE_ROUND_SEAT).toEqual({ provider: 'ollama', model: DEFAULT_MODEL.name })
    // The light chat keeps the smoke's tag; the heavy chat's turns are told apart.
    expect(generator.LIVE_LANE_MODELS).toEqual([DEFAULT_MODEL.name, 'scripted-llama:heavy'])
    const live = fixture('light_beside_large_live')
    expect(live.shape.liveSeats).toEqual({
      ...generator.LIVE_ROUND_SEAT,
      chatModels: generator.LIVE_LANE_MODELS
    })
    expect(live.chats).toHaveLength(2)
    live.chats.forEach((chat, index) => {
      const seats = chat.ensemble.participants ?? []
      expect(seats.length).toBeGreaterThan(0)
      for (const seat of seats) {
        expect(seat).toMatchObject({ provider: 'ollama', model: generator.LIVE_LANE_MODELS[index] })
      }
    })
    expect(live.replaySchedule).toBeNull()
  })

  it('is refused by the replay-only T1 runner before it reads a schedule', () => {
    expect(() =>
      runBaselineCli(['--workload=light_beside_large_live', '--dry-run'], {
        provenance: { gitSha: 'test', dirty: false }
      })
    ).toThrow(
      expect.objectContaining({
        code: 'PERF_LIVE_ROUNDS_WORKLOAD',
        message: expect.stringMatching(/runs only under runT2Baseline --live-rounds/)
      })
    )
  })

  it('loads as Ensemble chats with a Boss, as a user’s Ensemble chats do', () => {
    const load = (chat: ChatRecord) => normalizeCatalogueChatRecord(chat, () => 'ollama')
    const live = fixture('light_beside_large_live')
    expect(live.chats.map((chat) => chat.chatKind)).toEqual(['ensemble', 'ensemble'])
    for (const chat of live.chats) {
      const loaded = load(chat)
      expect(loaded.chatKind).toBe('ensemble')
      expect(loaded.ensemble?.participants).toEqual(chat.ensemble.participants)
      expect(loaded.ensemble?.bossmanParticipantId).toBe(chat.ensemble.participants?.[0]?.id)
      expect(loaded.ensemble?.activeRound?.status).toBe('completed')
    }
    // Control: the replay workload keeps its recorded shape, which loads as
    // a solo chat whose block is never normalised.
    const replay = fixture('light_beside_large')
    expect(replay.chats.map((chat) => chat.chatKind)).toEqual([undefined, undefined])
    const loadedReplay = load(replay.chats[0])
    expect(loadedReplay.chatKind).toBe('single')
    expect(loadedReplay.ensemble?.bossmanParticipantId).toBeUndefined()
  })

  it('boots with nothing to reconcile, unlike the replay workload it mirrors', () => {
    const replay = fixture('light_beside_large')
    const live = fixture('light_beside_large_live')
    // Control: the replay fixture's live runs are settled at boot, which is
    // why its replayed saves can never reach the deferred D1 path.
    expect(settledAtBoot(replay.chats)).toBeGreaterThan(0)
    expect(settledAtBoot(live.chats)).toBe(0)
    expect(live.chats.map((chat) => chat.ensemble.activeRound.status)).toEqual([
      'completed',
      'completed'
    ])
    // Same chat shapes: only seats and run liveness differ.
    expect(live.chats.map((chat) => chat.messages.length)).toEqual(
      replay.chats.map((chat) => chat.messages.length)
    )
    expect(live.chats.map((chat) => chat.runs?.length)).toEqual(
      replay.chats.map((chat) => chat.runs?.length)
    )
  })
})

describe('materializing a live-round profile', () => {
  it('points Ollama at the loopback daemon and writes no replay schedule', () => {
    const dir = userDataDir()
    const result = materializePerfUserData({
      userDataDir: dir,
      workload: 'light_beside_large_live',
      seed: 42,
      scaleDown: SCALE_DOWN,
      ollamaBaseUrl: 'http://127.0.0.1:43123'
    })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({
      ollamaBaseUrl: 'http://127.0.0.1:43123',
      ollamaDefaultModel: DEFAULT_MODEL.name
    })
    expect(result.replayPath).toBeNull()
    expect(existsSync(join(dir, 'perf-replay-schedule.json'))).toBe(false)
    expect(result.manifest).toMatchObject({
      replayScheduleFile: null,
      live: {
        seat: generator.LIVE_ROUND_SEAT,
        settings: { ollamaBaseUrl: 'http://127.0.0.1:43123' }
      }
    })
  })

  it.each([
    [undefined],
    ['http://localhost:43123'],
    ['http://0.0.0.0:43123'],
    ['https://127.0.0.1:43123'],
    ['http://127.0.0.1'],
    ['http://127.0.0.1:0'],
    ['http://127.0.0.1:43123/v1'],
    ['http://user:pass@127.0.0.1:43123']
  ])('refuses %s before writing anything', (ollamaBaseUrl) => {
    const dir = userDataDir()
    expect(() =>
      materializePerfUserData({
        userDataDir: dir,
        workload: 'light_beside_large_live',
        seed: 42,
        scaleDown: SCALE_DOWN,
        ollamaBaseUrl
      })
    ).toThrow(/^a live-round workload requires ollamaBaseUrl http:\/\/127\.0\.0\.1:<port>$/)
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  })

  it('refuses an Ollama URL for a replay workload and keeps its replay schedule', () => {
    expect(() =>
      materializePerfUserData({
        userDataDir: userDataDir(),
        workload: 'light_beside_large',
        seed: 42,
        scaleDown: SCALE_DOWN,
        ollamaBaseUrl: 'http://127.0.0.1:43123'
      })
    ).toThrow(/live-round workloads only/)
    const dir = userDataDir()
    const result = materializePerfUserData({
      userDataDir: dir,
      workload: 'light_beside_large',
      seed: 42,
      scaleDown: SCALE_DOWN
    })
    expect(result.replayPath).toBe(join(dir, 'perf-replay-schedule.json'))
    expect(existsSync(join(dir, 'settings.json'))).toBe(false)
  })
})
