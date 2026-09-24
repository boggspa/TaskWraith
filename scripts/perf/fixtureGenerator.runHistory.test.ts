import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostProfileDomainStore } from '../../src/host-runtime/HostProfileDomainStore'

const require = createRequire(import.meta.url)
const {
  FIXTURE_GENERATOR_VERSION,
  LARGE_HISTORY_RUN_CALIBRATION,
  RUN_CONCURRENCY_CALIBRATION,
  buildSyntheticRunHistory,
  fixtureFingerprint,
  generatePerfFixture,
  resolveWorkloadShape
} = require('./fixtureGenerator.cjs')
const { HISTORY_SIZE_PINS } = require('./interferenceMatrix.cjs')
const { materializePerfUserData } = require('./materializeUserData.cjs')

function participants(count = 30) {
  return Array.from({ length: count }, (_, index) => ({
    id: `participant-${index + 1}`,
    provider: index % 2 === 0 ? 'codex' : 'claude',
    model: index % 2 === 0 ? 'gpt-fixture' : 'claude-fixture',
    role: index === 0 ? 'Boss' : index === 1 ? 'Captain' : `Seat${index + 1}`,
    order: index,
    enabled: true
  }))
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))

describe('large-history run calibration', () => {
  it('constructs the full 10k source-core history before two live final rows', () => {
    const runs = buildSyntheticRunHistory({
      appChatId: 'full-scale-chat',
      participants: participants(),
      runCount: 10_000,
      linkedRoundIdCount: 1_000,
      activeRunCount: 2,
      startedAtMs: Date.UTC(2026, 7, 3, 12, 0, 0),
      endedAtMs: Date.UTC(2026, 7, 3, 15, 0, 0)
    })

    expect(runs).toHaveLength(10_000)
    expect(new Set(runs.map((run: any) => run.runId)).size).toBe(10_000)
    expect(new Set(runs.map((run: any) => run.ensembleRoundId)).size).toBe(1_000)
    expect(runs.slice(0, -2).every((run: any) => run.status === 'completed')).toBe(true)
    expect(runs.slice(0, -2).every((run: any) => typeof run.endedAt === 'string')).toBe(true)
    expect(runs.slice(-2).every((run: any) => run.status === 'running')).toBe(true)
    expect(runs.slice(-2).every((run: any) => run.endedAt === undefined)).toBe(true)
    expect(new Set(runs.slice(-2).map((run: any) => run.ensembleParticipantId)).size).toBe(2)
    expect(runs.at(-1)).toMatchObject({
      runId: 'full-scale-chat-run-10000',
      status: 'running',
      ensembleParticipantStatus: 'running',
      ensembleSeatSnapshot: {
        schemaVersion: 1,
        configuredPermissionPresetId: 'default'
      }
    })
    expect(
      runs.every(
        (run: any, index: number) =>
          index === 0 || Date.parse(run.startedAt) >= Date.parse(runs[index - 1].startedAt)
      )
    ).toBe(true)
  })

  it('emits the full-scale observed axes through the main generator', () => {
    const fixture = generatePerfFixture({
      workload: 'large_history',
      seed: 42,
      lean: true,
      scaleDown: 1
    })
    const chat = fixture.chats[0]
    expect(chat.runs).toHaveLength(10_000)
    expect(new Set(chat.runs.map((run: any) => run.ensembleRoundId)).size).toBe(1_000)
    expect(chat.runs.filter((run: any) => run.status === 'running')).toHaveLength(2)
    const runById = new Map(chat.runs.map((run: any) => [run.runId, run]))
    expect(
      chat.messages
        .filter((message: any) => message.role === 'assistant')
        .every((message: any) => {
          const run: any = runById.get(message.runId)
          return (
            run?.ensembleParticipantId === message.metadata.ensembleParticipantId &&
            run?.provider === message.metadata.ensembleProvider
          )
        })
    ).toBe(true)
    expect(fixture.totals).toMatchObject({
      runCount: 10_000,
      activeRunCount: 2,
      linkedRoundIdCount: 1_000,
      maxRunsPerChat: 10_000,
      maxLinkedRoundIdsPerChat: 1_000
    })
    expect(fixture.totals.runHistoryByChat).toEqual([
      expect.objectContaining({
        appChatId: chat.appChatId,
        runCount: 10_000,
        activeRunCount: 2,
        linkedRoundIdCount: 1_000
      })
    ])
  }, 120_000)

  it('discloses full calibration separately from scaled and observed fixture shape', () => {
    expect(resolveWorkloadShape({ workload: 'large_history' }).runHistory.generated).toEqual({
      accumulatedRuns: 10_000,
      linkedRoundIds: 1_000,
      activeRuns: 2,
      rosterParticipantFloor: 30
    })
    const single = generatePerfFixture({
      workload: 'large_history',
      seed: 42,
      lean: true,
      scaleDown: 1_000
    })
    expect(single.shape.runHistory).toMatchObject({
      source: 'programme_a1_49_user_axis',
      synthetic: true,
      recordProfile: 'chat_run_core_with_ensemble_linkage_v1',
      fullScale: { accumulatedRuns: 10_000, linkedRoundIds: 1_000, activeRuns: 2 },
      generated: {
        accumulatedRuns: 30,
        linkedRoundIds: 1,
        activeRuns: 2,
        rosterParticipantFloor: 30
      },
      optionalFieldSizeDistribution: 'unmeasured',
      historicalRoundEntities: 'not_generated'
    })
    expect(single.shape.concurrencyCalibration).toEqual(RUN_CONCURRENCY_CALIBRATION)
    expect(single.shape.concurrencyCalibration).toMatchObject({
      practicalConcurrentRuns: { min: 100, max: 200 },
      saturationConcurrentRunsFloor: 500,
      modeling: 'not_modeled_by_run_history_fixture'
    })
    expect(single.totals).toMatchObject({
      runCount: 30,
      activeRunCount: 2,
      linkedRoundIdCount: 1,
      maxRunsPerChat: 30,
      maxLinkedRoundIdsPerChat: 1
    })
    expect(single.totals.runSerializedBytes).toBeGreaterThan(0)
    expect(single.totals.runHistoryByChat).toEqual([
      expect.objectContaining({
        appChatId: 'perf-large_history-chat-01',
        runCount: 30,
        activeRunCount: 2,
        linkedRoundIdCount: 1,
        serializedBytes: expect.any(Number)
      })
    ])
    expect(single.totals.runHistoryByChat[0].serializedBytes).toBe(single.totals.runSerializedBytes)
    expect(single.totals.runSerializedBytes).toBe(
      Buffer.byteLength(JSON.stringify(single.chats[0].runs), 'utf8')
    )
    expect(single.totals.chatSerializedBytes).toBeGreaterThan(single.totals.runSerializedBytes)
    expect(LARGE_HISTORY_RUN_CALIBRATION.fullScale).toEqual({
      accumulatedRuns: 10_000,
      linkedRoundIds: 1_000,
      activeRuns: 2
    })
    expect(HISTORY_SIZE_PINS.large).toMatchObject({
      approxAccumulatedRuns: 10_000,
      approxRunLinkedRoundIds: 1_000
    })
    expect(HISTORY_SIZE_PINS.large).not.toHaveProperty('approxRuns')
  })

  it('persists four light seats and thirty heavy seats with coherent live identities', () => {
    const fixture = generatePerfFixture({
      workload: 'light_beside_large',
      seed: 42,
      lean: true,
      scaleDown: 1_000
    })
    const [light, heavy] = fixture.chats

    expect(fixture.totals.rosterByChat).toEqual([
      {
        appChatId: light.appChatId,
        participantCount: 4,
        activeRoundParticipantCount: 4,
        activeRoundRunningParticipantCount: 2
      },
      {
        appChatId: heavy.appChatId,
        participantCount: 30,
        activeRoundParticipantCount: 30,
        activeRoundRunningParticipantCount: 2
      }
    ])
    expect(light.ensemble.participants).toHaveLength(4)
    expect(heavy.ensemble.participants).toHaveLength(30)
    expect(light.ensemble.activeRound.participants).toHaveLength(4)
    expect(heavy.ensemble.activeRound.participants).toHaveLength(30)
    expect(light._perfMeta.seatCount).toBe(4)
    expect(heavy._perfMeta.seatCount).toBe(30)
    for (const chat of fixture.chats) {
      const runIds = new Set(chat.runs.map((run: any) => run.runId))
      expect(chat.runs.every((run: any) => run.id === undefined && runIds.has(run.runId))).toBe(
        true
      )
      expect(
        chat.messages
          .filter((message: any) => message.role === 'assistant')
          .every((message: any) => runIds.has(message.runId))
      ).toBe(true)
      expect(chat.ensemble.activeRound).toMatchObject({
        roundId: chat.runs.at(-1).ensembleRoundId,
        status: 'running',
        prompt: chat.messages[0].content
      })
      expect(chat.ensemble.activeRound).not.toHaveProperty('id')
      expect(
        chat.ensemble.activeRound.participants.filter(
          (participant: any) => participant.status === 'running'
        )
      ).toHaveLength(2)
      for (const participant of chat.ensemble.activeRound.participants.filter(
        (candidate: any) => candidate.status === 'running'
      )) {
        expect(
          chat.runs.find(
            (run: any) =>
              run.runId === participant.runId &&
              run.ensembleParticipantId === participant.participantId &&
              run.status === 'running'
          )
        ).toBeDefined()
      }
      for (const participant of chat.ensemble.activeRound.participants) {
        if (participant.status === 'idle') {
          expect(participant.runId).toBeUndefined()
          continue
        }
        const linkedRun = chat.runs.find((run: any) => run.runId === participant.runId)
        expect(linkedRun).toMatchObject({
          ensembleRoundId: chat.ensemble.activeRound.roundId,
          ensembleParticipantId: participant.participantId,
          status: participant.status === 'running' ? 'running' : 'completed'
        })
      }
      expect(
        chat.ensemble.activeRound.participants.every(
          (participant: any) =>
            typeof participant.participantId === 'string' && participant.id === undefined
        )
      ).toBe(true)

      const seed = fixture.replaySchedule.find(
        (event: any) => event.kind === 'seed_chat' && event.appChatId === chat.appChatId
      )
      expect(seed.runIds).toEqual(chat.runs.map((run: any) => run.runId))
      const runningEvents = fixture.replaySchedule.filter(
        (event: any) => event.kind === 'run_still_running' && event.appChatId === chat.appChatId
      )
      expect(runningEvents.map((event: any) => event.runId)).toEqual(
        chat.runs.filter((run: any) => run.status === 'running').map((run: any) => run.runId)
      )
    }
    const heavyRunById = new Map(heavy.runs.map((run: any) => [run.runId, run]))
    expect(
      heavy.messages
        .filter((message: any) => message.role === 'assistant')
        .every((message: any) => {
          const run: any = heavyRunById.get(message.runId)
          return (
            run?.ensembleParticipantId === message.metadata.ensembleParticipantId &&
            run?.provider === message.metadata.ensembleProvider
          )
        })
    ).toBe(true)
  })

  it('fingerprints independent run, roster and active-round mutations', () => {
    const fixture = generatePerfFixture({
      workload: 'light_beside_large',
      seed: 7,
      lean: true,
      scaleDown: 1_000
    })
    const baseline = fixtureFingerprint(fixture)

    const changedRun = copy(fixture)
    changedRun.chats[1].runs[0].actualModel = 'changed-model'
    expect(fixtureFingerprint(changedRun)).not.toBe(baseline)

    const changedRoster = copy(fixture)
    changedRoster.chats[0].ensemble.participants[0].role = 'Lead'
    expect(fixtureFingerprint(changedRoster)).not.toBe(baseline)

    const changedRound = copy(fixture)
    changedRound.chats[1].ensemble.activeRound.prompt = 'changed round prompt'
    expect(fixtureFingerprint(changedRound)).not.toBe(baseline)
    expect(FIXTURE_GENERATOR_VERSION).toBe(3)
  })

  it('round-trips a scaled large history through materialization and the real Host store', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'run-history-userdata-'))
    const hostProfilePath = mkdtempSync(join(tmpdir(), 'run-history-host-'))
    try {
      const fixture = generatePerfFixture({
        workload: 'large_history',
        seed: 99,
        lean: true,
        scaleDown: 1_000
      })
      materializePerfUserData({
        workload: 'large_history',
        fixture,
        userDataDir: userDataPath,
        mode: 'future_v2'
      })
      const chat = fixture.chats[0]
      const persisted = JSON.parse(
        readFileSync(join(userDataPath, 'chats', `${chat.appChatId}.json`), 'utf8')
      )
      expect(persisted).not.toHaveProperty('_perfMeta')
      expect(persisted.runs).toHaveLength(30)
      expect(persisted.runs.every((run: any) => typeof run.runId === 'string')).toBe(true)

      const store = new HostProfileDomainStore({
        profilePath: hostProfilePath,
        authority: { assertProfileAuthority: () => {} }
      })
      const saved = store.persistThreadRecord({
        threadId: persisted.appChatId,
        expectedRevision: 0,
        record: persisted
      })
      expect(saved.runs).toHaveLength(30)
      expect(saved.runs.at(-1)).toMatchObject({
        runId: persisted.runs.at(-1).runId,
        status: 'running'
      })
      const reopened = store.getThread(persisted.appChatId)
      expect(reopened?.runs.map((run) => run.runId)).toEqual(
        persisted.runs.map((run: any) => run.runId)
      )
      expect(reopened?.ensemble?.activeRound?.roundId).toBe(persisted.ensemble.activeRound.roundId)
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
      rmSync(hostProfilePath, { recursive: true, force: true })
    }
  })
})
