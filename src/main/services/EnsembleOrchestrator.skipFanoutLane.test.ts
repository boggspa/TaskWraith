import { describe, expect, it, vi } from 'vitest'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'

/**
 * Per-viewport Skip: cancel one live fan-out lane without stopping the round
 * or the sibling lanes. Distinct from skipReadFanout (whole wave) and
 * skipActiveParticipant (serial speaker + owned cascade).
 */

function makeHarness(): {
  chat: ChatRecord
  dispatched: AgentRunPayload[]
  cancelRun: ReturnType<typeof vi.fn>
  orchestrator: EnsembleOrchestrator
} {
  const participants: EnsembleParticipant[] = [
    {
      id: 'claude',
      provider: 'claude',
      enabled: true,
      role: 'Reviewer',
      instructions: 'Review.',
      order: 1,
      permissionPresetId: 'read_only'
    },
    {
      id: 'gemini',
      provider: 'gemini',
      enabled: true,
      role: 'Researcher',
      instructions: 'Research.',
      order: 2,
      permissionPresetId: 'read_only'
    },
    {
      id: 'codex',
      provider: 'codex',
      enabled: true,
      role: 'Worker',
      instructions: 'Work.',
      order: 3,
      permissionPresetId: 'workspace_write'
    }
  ]
  let chat: ChatRecord = {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: 'Skip one fan-out lane',
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
  }
  let counter = 0
  const dispatched: AgentRunPayload[] = []
  const cancelRun = vi.fn(async () => true)
  const settings: AppSettings = {
    storeLocalChatHistory: true,
    storeRawEvents: false
  } as AppSettings
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat: (next) => {
      chat = next
    },
    getSettings: () => settings,
    dispatch: vi.fn(async (payload: AgentRunPayload) => {
      dispatched.push(payload)
      return { dispatched: true, appRunId: payload.appRunId || '' }
    }),
    cancelRun,
    createRunId: (provider) => `${provider}-run-${++counter}`,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString()
  })
  return {
    get chat() {
      return chat
    },
    dispatched,
    cancelRun,
    orchestrator
  }
}

describe('EnsembleOrchestrator.skipFanoutLane', () => {
  it('cancels only the targeted live lane and lets the wave continue', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_LANES
    process.env.TASKWRAITH_CONCURRENT_LANES = '1'
    try {
      const harness = makeHarness()
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Fan out then implement.',
        event: { sender: {} as Electron.WebContents },
        concurrentMode: true
      })

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
      const claudeRun = harness.dispatched.find((payload) => payload.provider === 'claude')!
      const geminiRun = harness.dispatched.find((payload) => payload.provider === 'gemini')!
      const claudeLaneId = claudeRun.ensembleRun?.laneId
      expect(claudeLaneId).toBeTruthy()

      const skipped = await harness.orchestrator.skipFanoutLane(
        'ensemble-chat',
        claudeLaneId as string
      )
      expect(skipped).toBe(true)
      expect(harness.cancelRun.mock.calls).toEqual([['claude', claudeRun.appRunId]])

      const lanes = harness.chat.ensemble?.activeRound?.lanes || {}
      expect(lanes[claudeLaneId as string]?.status).toBe('cancelled')
      expect(lanes[geminiRun.ensembleRun!.laneId!]?.status).toBe('running')
      expect(
        harness.chat.messages.some(
          (message) =>
            message.role === 'system' &&
            typeof message.content === 'string' &&
            message.content.includes('Fan-out lane skipped')
        )
      ).toBe(true)

      // Sibling lane still finishes and serial writer proceeds.
      harness.orchestrator.handleProviderOutput(
        'gemini',
        { appRunId: geminiRun.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 1000 })
      expect(harness.dispatched[2].provider).toBe('codex')
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CONCURRENT_LANES
      else process.env.TASKWRAITH_CONCURRENT_LANES = previous
    }
  })

  it('returns false for an unknown or already-terminal lane', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_LANES
    process.env.TASKWRAITH_CONCURRENT_LANES = '1'
    try {
      const harness = makeHarness()
      expect(await harness.orchestrator.skipFanoutLane('ensemble-chat', 'missing-lane')).toBe(
        false
      )

      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Fan out.',
        event: { sender: {} as Electron.WebContents },
        concurrentMode: true
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2), { timeout: 1000 })
      const claudeRun = harness.dispatched.find((payload) => payload.provider === 'claude')!
      const laneId = claudeRun.ensembleRun?.laneId as string
      harness.orchestrator.handleProviderOutput(
        'claude',
        { appRunId: claudeRun.appRunId, appChatId: 'ensemble-chat' },
        { type: 'result', status: 'success' }
      )
      await vi.waitFor(() => {
        expect(harness.chat.ensemble?.activeRound?.lanes?.[laneId]?.status).toBe('completed')
      })
      expect(await harness.orchestrator.skipFanoutLane('ensemble-chat', laneId)).toBe(false)
      expect(harness.cancelRun).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CONCURRENT_LANES
      else process.env.TASKWRAITH_CONCURRENT_LANES = previous
    }
  })
})
