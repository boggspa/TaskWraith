import { describe, expect, it, vi } from 'vitest'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'

// Fan-out waves share host run capacity. A fourth call must not be refused
// merely because three earlier waves still have live lanes.

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
      // Continuous-only (2026-09-01): fan-out is On/Off, so 'read_only'
      // normalises to 'all'. With an assigned Boss the opening writer pass
      // stays SERIAL ("requires the assigned Boss to call ensemble_fanout
      // with explicit writeScopes"), which is the shape these tests drive;
      // without one, the no-Boss user-preflight dispatches claim/ack lanes
      // for every writer concurrently at round start.
      bossmanParticipantId: 'codex',
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

describe('concurrent fan-outs share the host cap', () => {
  it.each(['ensemble_fanout', 'ensemble_fanout_all'] as const)(
    'allows a fourth open wave through %s while host slots are free',
    { timeout: 30_000 },
    async (tool) => {
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'workspace_write'),
        participant('grok', 'grok', 'Researcher', 3, 'workspace_write'),
        participant('kimi', 'kimi', 'Auditor', 4, 'workspace_write'),
        participant('cursor', 'cursor', 'Scribe', 5, 'workspace_write')
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead dispatches four independent fan-outs.',
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

      const second = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Researcher'],
        prompt: 'Work lane.'
      })
      expect(second.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      expect(openLaneCount(harness)).toBe(2)

      const third = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Auditor'],
        prompt: 'Audit lane.'
      })
      expect(third.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
      expect(openLaneCount(harness)).toBe(3)

      const input = {
        targets: ['Scribe'],
        prompt: 'Fourth independent wave.'
      }
      const fourth =
        tool === 'ensemble_fanout'
          ? await harness.orchestrator.fanoutForRun(boss, input)
          : await harness.orchestrator.fanoutAllForRun(boss, input)
      expect(fourth.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(5))
      expect(openLaneCount(harness)).toBe(4)
      for (let index = 1; index <= 4; index += 1) complete(harness, index)
      await vi.waitFor(() => expect(openLaneCount(harness)).toBe(0))
    }
  )

  it(
    'accepts a wide fan-out and an additional wave while lanes are still running',
    { timeout: 30_000 },
    async () => {
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

      const second = await harness.orchestrator.fanoutForRun(boss, {
        targets: ['Scribe'],
        prompt: 'Second wave.'
      })
      expect(second.ok).toBe(true)
      expect(openLaneCount(harness)).toBe(4)
    }
  )
})
