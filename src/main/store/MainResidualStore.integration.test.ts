import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ChatPreparationLane } from './ChatPreparationLane'
import type { ResidualObserver } from './MainDurabilityResiduals'

// This file proves the residual counters enrolled for the pre-barrier path
// (baseline verifies, the checkpoint worker's preparation lane): the path the
// store takes with barrier durability off. Barrier durability is on by default
// and the store reads its switch once, at load, so it is pinned off here with
// the exact token `0` before the store is imported.
vi.hoisted(() => {
  vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '0')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

const captured = vi.hoisted(() => ({
  observer: undefined as ResidualObserver | undefined,
  lane: undefined as ChatPreparationLane | undefined
}))
const profile = vi.hoisted(() => `/tmp/taskwraith-residual-store-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => profile } }))
vi.mock('./CheckpointPreparationWorker', () => ({
  isCheckpointPreparationWorkerEnabled: () => true,
  CheckpointPreparationWorker: class {
    start() {
      return null
    }
  }
}))
vi.mock('./JournalHostReferenceConnector', async (original) => {
  const actual = await original<typeof import('./JournalHostReferenceConnector')>()
  return {
    ...actual,
    JournalHostReferenceConnector: class extends actual.JournalHostReferenceConnector {
      constructor(ports: ConstructorParameters<typeof actual.JournalHostReferenceConnector>[0]) {
        super(ports)
        captured.lane = this.lane
      }
    }
  }
})
vi.mock('./MainDurabilityRuntime', async (original) => {
  const actual = await original<typeof import('./MainDurabilityRuntime')>()
  return {
    ...actual,
    createMainDurabilityRuntime: (
      options: import('./MainDurabilityRuntime').MainDurabilityRuntimeOptions
    ) => {
      captured.observer = options.residualObserver
      return actual.createMainDurabilityRuntime({ ...options, env: {} })
    }
  }
})
import { AppStore } from '../store'

describe('Store real residual enrollment', () => {
  it('counts baseline verification through a live chat second save in the actual Store path', async () => {
    const chatId = '77777777-7777-4777-8777-777777777777'
    const first = AppStore.saveChat({
      appChatId: chatId,
      scope: 'global',
      chatKind: 'single',
      provider: 'codex',
      title: 'Live residual baseline',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [
        {
          id: 'stream-message',
          role: 'assistant',
          content: 'first',
          timestamp: '2026-10-02T00:00:00Z',
          runId: 'live-baseline-run'
        }
      ],
      runs: [{ runId: 'live-baseline-run', status: 'running', startedAt: '2026-10-02T00:00:00Z' }]
    } as import('./types').ChatRecord)
    await AppStore.flushAllChatSaves()
    // A cold coordinator must verify the persisted live chat's baseline on
    // its next save, unlike a newly seeded chat whose parity is already known.
    AppStore.resetTransientDeletionGuardsForTests()
    const windows = AppStore.getMainResidualWindowPort()
    windows.begin('store_baseline')
    const second = AppStore.saveChat({
      ...first,
      runs: first.runs.map((run) => ({
        ...run,
        status: 'completed',
        completedAt: '2026-10-02T00:01:00Z'
      })),
      messages: first.messages.map((message) => ({
        ...message,
        content: 'first plus streamed output'
      }))
    })
    const delta = windows.end('store_baseline')
    expect(delta.counters.baselineVerifies).toBe(1)
    expect(delta.counters.d2d3Durability).toBeGreaterThan(0)
    expect(delta.complete).toBe(false)
    expect(delta.counters.orphanReclaims).toBeNull()
    expect(delta.counters.conflictRecoveryReads).toBeNull()
    expect(JSON.stringify(second)).not.toContain('residualObserver')
    expect(JSON.stringify(second)).not.toContain('store_baseline')
    await AppStore.flushAllChatSaves()
    const persisted = fs.readFileSync(AppStore.getChatRecordPath(chatId)!, 'utf8')
    expect(persisted).not.toContain('residualObserver')
    expect(persisted).not.toContain('store_baseline')
  })

  it('counts actual legacy strict attempts and lane refusals with only five sources enrolled', () => {
    const windows = AppStore.getMainResidualWindowPort()
    windows.begin('actual_store')
    AppStore.appendRunEvent(
      {
        runId: 'residual-run',
        kind: 'provider_raw',
        phase: 'raw',
        source: 'provider',
        payload: { data: 'durable' }
      },
      { durability: 'strict' }
    )
    const lane = captured.lane!
    expect(lane).toBeInstanceOf(ChatPreparationLane)
    lane.enqueue({ chatId: 'expired', revision: 1, generation: 0, purpose: 'publication' }, 0)
    lane.advance(301)
    const delta = windows.end('actual_store')
    expect(delta.counters.strictRunEventFsyncs).toBe(1)
    expect(delta.counters.preparationRefusals).toBe(1)
    expect(delta.complete).toBe(false)
    expect(
      Object.entries(delta.counters)
        .filter(([, value]) => value !== null)
        .map(([key]) => key)
        .sort()
    ).toEqual(
      [
        'baselineVerifies',
        'preparationRefusals',
        'strictRunEventFsyncs',
        'd2d3Durability',
        'forcedSynchronousCheckpoints'
      ].sort()
    )
    const bytes = fs.readFileSync(path.join(profile, 'run-events', 'residual-run.jsonl'), 'utf8')
    expect(bytes).not.toContain('residualObserver')
    expect(bytes).not.toContain('actual_store')
  })

  it('does not let a throwing diagnostic observer change real ledger durability', async () => {
    const { RunEventLedgerWriter } = await import('./RunEventLedgerWriter')
    const writer = new RunEventLedgerWriter({
      runEventsDir: path.join(profile, 'throw-events'),
      runArtifactsDir: path.join(profile, 'throw-artifacts'),
      residualObserver: () => {
        throw new Error('diagnostic')
      }
    })
    expect(() =>
      writer.append(
        {
          runId: 'throw-run',
          kind: 'provider_raw',
          phase: 'raw',
          source: 'provider',
          payload: { data: 'durable' }
        },
        { durability: 'strict' }
      )
    ).not.toThrow()
    expect(
      fs.readFileSync(path.join(profile, 'throw-events', 'throw-run.jsonl'), 'utf8')
    ).toContain('durable')
  })
})
