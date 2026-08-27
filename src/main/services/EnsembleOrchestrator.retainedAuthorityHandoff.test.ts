import { describe, expect, it, vi } from 'vitest'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'

function participant(
  id: string,
  provider: EnsembleParticipant['provider'],
  role: string,
  order: number,
  permissionPresetId: 'workspace_write' | 'read_only',
  model: string
): EnsembleParticipant {
  return {
    id,
    provider,
    enabled: true,
    role,
    instructions: `${role}.`,
    order,
    model,
    permissionPresetId
  }
}

function makeChat(): ChatRecord {
  const participants = [
    participant('boss', 'claude', 'Boss', 1, 'workspace_write', 'claude-fable-5-ultratask'),
    participant('reviewer', 'codex', 'Reviewer', 2, 'read_only', 'gpt-5.6-luna'),
    participant('worker', 'gemini', 'Worker', 3, 'workspace_write', 'gemini-3-pro')
  ]
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: 'Retained authority handoff',
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
      participants,
      bossmanParticipantId: 'boss',
      orchestrationMode: 'continuous',
      maxContinuationHops: 8,
      fanoutPolicy: 'read_only'
    }
  }
}

function makeSettings(): AppSettings {
  return {
    storeLocalChatHistory: true,
    storeRawEvents: false,
    ensembleModeEnabled: true,
    chatContextTurns: 8
  } as unknown as AppSettings
}

function makeHarness() {
  let chat = makeChat()
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
    now: () => 1_000 + counter,
    nowIso: () => `2026-08-27T14:00:0${counter}.000Z`
  })
  return {
    get chat() {
      return chat
    },
    dispatched,
    orchestrator
  }
}

function completeRun(
  harness: ReturnType<typeof makeHarness>,
  index: number,
  content?: string
): void {
  const run = harness.dispatched[index]!
  const route = { appRunId: run.appRunId, appChatId: 'ensemble-chat' }
  if (content) {
    harness.orchestrator.handleProviderOutput(run.provider, route, {
      type: 'content',
      text: content
    })
  }
  harness.orchestrator.handleProviderOutput(run.provider, route, {
    type: 'result',
    status: 'success',
    stats: { total_tokens: 5 }
  })
}

describe('retained fan-out authority handoff', () => {
  it('uses a user-queued model change for the immediate retained authority turn', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Fan out, then retain authority.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const bossRunId = harness.dispatched[0].appRunId!
    const fanout = harness.orchestrator.fanoutForRun(bossRunId, {
      targets: ['Reviewer'],
      prompt: 'Review while the Boss remains responsible.'
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    await expect(fanout).resolves.toMatchObject({ ok: true, participantIds: ['reviewer'] })

    const queued = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'boss',
      participant: { model: 'claude-opus-5' },
      changedBy: 'user',
      reason: 'Use Opus on the next retained authority turn.'
    })
    expect(queued).toMatchObject({
      ok: true,
      status: 'queued',
      pendingParticipant: { provider: 'claude', model: 'claude-opus-5' }
    })

    completeRun(harness, 0, 'The old Fable execution reached its boundary.')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))

    expect(harness.dispatched[2]).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-5',
      ensembleRun: { participantId: 'boss', role: 'Boss' }
    })
    expect(harness.chat.ensemble?.participants.find((seat) => seat.id === 'boss')).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-5'
    })

    await harness.orchestrator.cancelRound('ensemble-chat', 'Test complete.')
  })
})
