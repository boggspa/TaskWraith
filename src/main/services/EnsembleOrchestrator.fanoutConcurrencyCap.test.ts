import { describe, expect, it, vi } from 'vitest'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'

/*
 * At most two fan-outs may be in flight at once.
 *
 * Exercised through the real `fanoutForRun` rather than the pure module, because
 * what the cap is worth depends entirely on the join being right: the count comes
 * from the DURABLE lane records crossed with the wave identity on the live runs,
 * and a wrong join fails silently in exactly the direction nobody notices —
 * counting zero waves and capping nothing at all.
 */

const FLUSH_MS = 320

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function participant(
  id: string,
  provider: EnsembleParticipant['provider'],
  role: string,
  order: number,
  permissionPresetId: 'workspace_write' | 'read_only'
): EnsembleParticipant {
  return {
    id,
    provider,
    enabled: true,
    role,
    instructions: `${role}.`,
    order,
    model: `${provider}-model`,
    permissionPresetId
  }
}

function makeChat(participants: EnsembleParticipant[]): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: 'Fan-out concurrency cap',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: participants.length,
      fanoutPolicy: 'read_only',
      participants
    }
  } as unknown as ChatRecord
}

function makeSettings(): AppSettings {
  return {
    storeLocalChatHistory: true,
    storeRawEvents: false,
    ensembleModeEnabled: true,
    chatContextTurns: 8
  } as unknown as AppSettings
}

function makeHarness(participants: EnsembleParticipant[]) {
  let chat = makeChat(participants)
  let counter = 0
  const dispatched: AgentRunPayload[] = []
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat: (next) => {
      chat = next
    },
    getSettings: makeSettings,
    dispatch: vi.fn(async (payload: AgentRunPayload) => {
      dispatched.push(payload)
      return { dispatched: true, appRunId: payload.appRunId || '' }
    }),
    cancelRun: vi.fn(async () => true),
    createRunId: (provider) => `${provider}-run-${++counter}`,
    now: () => counter,
    nowIso: () => `2026-08-06T00:00:0${counter}.000Z`
  } as unknown as ConstructorParameters<typeof EnsembleOrchestrator>[0])
  return {
    get chat() {
      return chat
    },
    dispatched,
    orchestrator
  }
}

type Harness = ReturnType<typeof makeHarness>

function complete(harness: Harness, index: number): void {
  const payload = harness.dispatched[index]
  harness.orchestrator.handleProviderOutput(
    payload.provider,
    { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
    { type: 'result', status: 'success' }
  )
}

function openLaneCount(harness: Harness): number {
  const lanes = harness.chat.ensemble?.activeRound?.lanes || {}
  return Object.values(lanes).filter(
    (lane) => !['completed', 'failed', 'cancelled'].includes(lane.status)
  ).length
}

describe('concurrent fan-out cap', () => {
  it(
    'allows two waves, refuses the third, and frees a slot when one settles',
    { timeout: 30_000 },
    async () => {
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'workspace_write'),
        participant('grok', 'grok', 'Researcher', 3, 'workspace_write'),
        participant('kimi', 'kimi', 'Auditor', 4, 'workspace_write')
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead dispatches more fan-outs than it is allowed to.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const boss = harness.dispatched[0].appRunId

      const first = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Reviewer'],
        prompt: 'Review lane.'
      })
      expect(first.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

      // A second wave beside the first is exactly what the cap permits — a
      // review lane and a work lane running together is the designed shape.
      const second = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Researcher'],
        prompt: 'Work lane.'
      })
      expect(second.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      expect(openLaneCount(harness)).toBe(2)

      const third = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Auditor'],
        prompt: 'One wave too many.'
      })
      expect(third.ok).toBe(false)
      expect(third.error).toBe('too_many_concurrent_fanouts')
      // The caller has to be told what to do next, or it retries the same call.
      expect(third.message).toContain('ensemble_await')
      expect(third.message).toMatch(/not on participants/i)
      // Refused means NOT SENT: a fourth provider run would be the accumulation
      // this whole change exists to stop.
      await sleep(FLUSH_MS)
      expect(harness.dispatched).toHaveLength(3)

      // The user watching the transcript should see why a dispatch vanished.
      expect(
        harness.chat.messages.some(
          (message) =>
            typeof message.content === 'string' && message.content.includes('ensemble_await')
        )
      ).toBe(true)

      // Settle the review lane; its wave is gone and the slot comes back.
      complete(harness, 1)
      await vi.waitFor(() => expect(openLaneCount(harness)).toBe(1))

      const fourth = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Auditor'],
        prompt: 'Now there is room.'
      })
      expect(fourth.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    }
  )

  it(
    'counts one many-seat fan-out as ONE wave, never one per participant',
    { timeout: 30_000 },
    async () => {
      // The cap must never read as a roster limit. Three seats in a single
      // dispatch is one wave, so a second dispatch still has to be accepted.
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'workspace_write'),
        participant('grok', 'grok', 'Researcher', 3, 'workspace_write'),
        participant('kimi', 'kimi', 'Auditor', 4, 'workspace_write'),
        participant('cursor', 'cursor', 'Scribe', 5, 'workspace_write')
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead dispatches one wide wave, then a second.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const boss = harness.dispatched[0].appRunId

      const wide = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Reviewer', 'Researcher', 'Auditor'],
        prompt: 'Three seats, one call.'
      })
      expect(wide.ok).toBe(true)
      expect(wide.laneIds).toHaveLength(3)
      await vi.waitFor(() => expect(openLaneCount(harness)).toBe(3))

      // Three open lanes, but only ONE open wave — so this must be allowed.
      const second = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Scribe'],
        prompt: 'Second wave.'
      })
      expect(second.ok).toBe(true)
      expect(openLaneCount(harness)).toBe(4)
    }
  )
})
