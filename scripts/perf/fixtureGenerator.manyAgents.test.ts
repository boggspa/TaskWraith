import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import { reconcileStaleChatRuns } from '../../src/main/ChatRunReconciler'
import { resolveEnsembleFanoutPolicy } from '../../src/main/services/EnsembleFanoutPolicy'
import { normalizeCatalogueChatRecord } from '../../src/main/store/ThreadCatalogueNormalize'
import type { ChatRecord } from '../../src/main/store/types'
import { MAX_ENSEMBLE_PARTICIPANTS } from '../../src/shared/ensembleLimits'
import { buildRuntimeFeatureGateSnapshot } from '../../src/shared/runtimeFeatureGates'

const require = createRequire(import.meta.url)
const generator = require('./fixtureGenerator.cjs') as {
  LIVE_ROUND_SEAT: { provider: string; model: string }
  MANY_AGENTS_DEFAULT: { threads: number; seats: number; seatMode: string }
  MANY_AGENTS_LIMITS: { maxThreads: number; maxSeats: number }
  generatePerfFixture: (options: Record<string, unknown>) => {
    workload: string
    shape: {
      chatCount: number
      seatCount: number
      liveSeats: { provider: string; model: string; chatModels: string[] }
      manyAgents: { threads: number; seats: number; seatMode: string; agents: number }
    }
    chats: Array<ChatRecord & { _perfMeta: { chatSerializedBytes: number } }>
    replaySchedule: unknown[] | null
  }
  fixtureFingerprint: (fixture: unknown) => string
}
const { WORKLOADS } = require('./schema.cjs') as { WORKLOADS: string[] }
const { buildScriptedDaemonConfig } = require('./liveRounds.cjs') as {
  buildScriptedDaemonConfig: (fixture: unknown) => { models: Array<{ name: string }> }
}
const { createScriptedOllamaDaemon } = require('./scriptedOllamaDaemon.cjs') as {
  createScriptedOllamaDaemon: (options: unknown) => { models: () => Array<{ name: string }> }
}

function fixture(options: Record<string, unknown> = {}) {
  return generator.generatePerfFixture({ workload: 'many_agents_live', seed: 42, ...options })
}
const seatsOf = (chat: ChatRecord) => chat.ensemble?.participants ?? []

describe('many_agents_live workload', () => {
  it('is a declared live workload that asks for 200 agents unless told otherwise', () => {
    expect(WORKLOADS).toContain('many_agents_live')
    expect(generator.MANY_AGENTS_DEFAULT).toEqual({ threads: 20, seats: 10, seatMode: 'serial' })
    const live = fixture()
    expect(live.shape.manyAgents).toEqual({
      threads: 20,
      seats: 10,
      seatMode: 'serial',
      agents: 200
    })
    expect(live.chats).toHaveLength(20)
    expect(live.chats.every((chat) => seatsOf(chat).length === 10)).toBe(true)
    expect(live.replaySchedule).toBeNull()
  })

  it('takes the thread count, the seat count and the seat mode', () => {
    const live = fixture({ threads: 3, seats: 2, seatMode: 'parallel' })
    expect(live.shape.manyAgents).toEqual({
      threads: 3,
      seats: 2,
      seatMode: 'parallel',
      agents: 6
    })
    expect(live.shape).toMatchObject({ chatCount: 3, seatCount: 2 })
    expect(live.chats.map((chat) => chat.appChatId)).toEqual([
      'perf-many_agents_live-chat-01',
      'perf-many_agents_live-chat-02',
      'perf-many_agents_live-chat-03'
    ])
    expect(live.chats.map((chat) => seatsOf(chat).length)).toEqual([2, 2, 2])
    // The largest shape allowed is one the generator can still build.
    const { maxThreads, maxSeats } = generator.MANY_AGENTS_LIMITS
    expect({ maxThreads, maxSeats }).toEqual({ maxThreads: 200, maxSeats: 50 })
    expect(maxSeats).toBe(MAX_ENSEMBLE_PARTICIPANTS)
    const widest = fixture({ threads: maxThreads, seats: 1, lean: true })
    expect(widest.chats).toHaveLength(200)
    expect(widest.chats[199].appChatId).toBe('perf-many_agents_live-chat-200')
    expect(fixture({ threads: 1, seats: maxSeats, lean: true }).shape.manyAgents.agents).toBe(50)
  })

  it('refuses a shape the app could not run', () => {
    const refused = (options: Record<string, unknown>) => () => fixture(options)
    for (const threads of [0, 201, 1.5, '3', null]) {
      expect(refused({ threads })).toThrow('threads must be a whole number from 1 to 200')
    }
    // A thread holds at most fifty participants.
    for (const seats of [0, 51, 2.5, '2']) {
      expect(refused({ seats })).toThrow('seats must be a whole number from 1 to 50')
    }
    expect(refused({ seatMode: 'both' })).toThrow('seatMode must be serial or parallel')
    // The app refuses fan-out on a thread with fewer than two seats.
    expect(refused({ seats: 1, seatMode: 'parallel' })).toThrow(
      'parallel seats need at least two seats in a thread'
    )
    expect(fixture({ seats: 1, seatMode: 'serial' }).shape.manyAgents.agents).toBe(20)
  })

  it('refuses the shape options on any other workload', () => {
    for (const option of [{ threads: 3 }, { seats: 2 }, { seatMode: 'parallel' }]) {
      expect(() =>
        generator.generatePerfFixture({ workload: 'dual_run', seed: 42, lean: true, ...option })
      ).toThrow('threads, seats and seatMode apply to many_agents_live only')
    }
  })

  it('gives each thread a scripted tag of its own, which the daemon serves', () => {
    const live = fixture({ threads: 3, seats: 2 })
    const tags = ['scripted-llama:t001', 'scripted-llama:t002', 'scripted-llama:t003']
    expect(live.shape.liveSeats).toEqual({ ...generator.LIVE_ROUND_SEAT, chatModels: tags })
    live.chats.forEach((chat, index) => {
      for (const seat of seatsOf(chat)) {
        expect(seat).toMatchObject({ provider: 'ollama', model: tags[index] })
      }
    })
    const config = buildScriptedDaemonConfig(live)
    expect(config.models.map((model) => model.name)).toEqual([
      generator.LIVE_ROUND_SEAT.model,
      ...tags
    ])
    // The daemon accepts every name the fixture can produce.
    const widest = fixture({ threads: 200, seats: 1, lean: true })
    const daemon = createScriptedOllamaDaemon(buildScriptedDaemonConfig(widest))
    expect(daemon.models()).toHaveLength(201)
    expect(widest.shape.liveSeats.chatModels[199]).toBe('scripted-llama:t200')
  })

  it('leaves serial seats in rotation with fan-out off', () => {
    const live = fixture({ threads: 2, seats: 3, seatMode: 'serial' })
    for (const chat of live.chats) {
      expect(chat.ensemble?.fanoutPolicy).toBe('off')
      expect(resolveEnsembleFanoutPolicy(chat.ensemble)).toBe('off')
      expect(seatsOf(chat).map((seat) => seat.stageRole)).toEqual([undefined, undefined, undefined])
    }
  })

  it('turns fan-out on for parallel seats and stages every seat as a reader', () => {
    // The orchestrator fans a round out at its start only to seats staged as
    // Scout (or whose own permissions are read-only), and only when two or
    // more of them are in the round (EnsembleOrchestrator.runRound).
    const live = fixture({ threads: 2, seats: 3, seatMode: 'parallel' })
    for (const chat of live.chats) {
      expect(chat.ensemble?.fanoutPolicy).toBe('all')
      expect(resolveEnsembleFanoutPolicy(chat.ensemble)).toBe('all')
      expect(seatsOf(chat).map((seat) => seat.stageRole)).toEqual(['scout', 'scout', 'scout'])
    }
    // Parallel lanes are not a setting: they are on unless the environment
    // turns them off, so the fixture has nothing to enable.
    expect(buildRuntimeFeatureGateSnapshot({}).concurrentLanes).toBe(true)
  })

  it('leaves every other workload’s seats and fan-out as they were', () => {
    for (const workload of ['light_beside_large_live', 'dual_run']) {
      const other = generator.generatePerfFixture({ workload, seed: 42, scaleDown: 50, lean: true })
      for (const chat of other.chats) {
        expect(chat.ensemble).not.toHaveProperty('fanoutPolicy')
        expect(seatsOf(chat).length).toBeGreaterThan(0)
        for (const seat of seatsOf(chat)) expect(seat).not.toHaveProperty('stageRole')
      }
    }
  })

  it('loads as Ensemble chats with a Boss and nothing to reconcile, mode intact', () => {
    for (const seatMode of ['serial', 'parallel']) {
      const live = fixture({ threads: 2, seats: 3, seatMode })
      expect(
        reconcileStaleChatRuns(live.chats, () => false, '2026-10-04T12:00:00.000Z').settlements
      ).toHaveLength(0)
      for (const chat of live.chats) {
        const loaded = normalizeCatalogueChatRecord(chat, () => 'ollama')
        expect(loaded.chatKind).toBe('ensemble')
        expect(loaded.ensemble?.bossmanParticipantId).toBe(seatsOf(chat)[0].id)
        expect(loaded.ensemble?.activeRound?.status).toBe('completed')
        expect(loaded.ensemble?.fanoutPolicy).toBe(chat.ensemble?.fanoutPolicy)
        expect(loaded.ensemble?.participants).toEqual(seatsOf(chat))
      }
    }
  })

  it('keeps each thread’s history light', () => {
    const live = fixture({ threads: 3, seats: 4 })
    for (const chat of live.chats) {
      // One opening prompt and two earlier turns a seat.
      expect(chat.messages).toHaveLength(1 + 4 * 2)
      expect(chat._perfMeta.chatSerializedBytes).toBeLessThan(256 * 1024)
    }
  })

  it('names a different fixture for each shape and mode', () => {
    const prints = [
      fixture({ threads: 3, seats: 2, seatMode: 'serial', lean: true }),
      fixture({ threads: 3, seats: 2, seatMode: 'parallel', lean: true }),
      fixture({ threads: 2, seats: 3, seatMode: 'serial', lean: true })
    ].map((live) => generator.fixtureFingerprint(live))
    expect(new Set(prints).size).toBe(3)
  })
})
