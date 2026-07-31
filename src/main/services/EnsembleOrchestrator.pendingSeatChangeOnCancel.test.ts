import { describe, expect, it, vi } from 'vitest'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'

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
    title: 'Pending seat changes should persist',
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
    nowIso: () => `2026-05-24T00:00:0${counter}.000Z`
  })

  return {
    get chat() {
      return chat
    },
    dispatched,
    orchestrator
  }
}

describe('ensemble participant seat queue', () => {
  it('applies a queued seat change when a round is cancelled', async () => {
    const harness = makeHarness([
      participant('codex', 'codex', 'Worker', 1, 'workspace_write'),
      participant('claude', 'claude', 'Reviewer', 2, 'read_only')
    ])

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'A live round with a queued active-seat change.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'codex',
      participant: {
        provider: 'codex',
        model: 'gpt-5.5',
        permissionPresetId: 'workspace_write'
      },
      changedBy: 'user',
      reason: 'Queued model switch in a live round.'
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'queued',
      participantId: 'codex',
      pendingParticipant: {
        provider: 'codex',
        model: 'gpt-5.5',
        permissionPresetId: 'workspace_write'
      }
    })

    await expect(harness.orchestrator.cancelRound('ensemble-chat', 'cancelled')).resolves.toBe(true)

    expect(
      harness.chat.ensemble?.participants.find((current) => current.id === 'codex')
    ).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      permissionPresetId: 'workspace_write'
    })
    expect(
      harness.chat.ensemble?.activeRound?.participants.find(
        (current) => current.participantId === 'codex'
      )
    ).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      status: 'cancelled'
    })
  })

  it('applies a queued active-seat removal when a round is cancelled', async () => {
    const harness = makeHarness([
      participant('codex', 'codex', 'Worker', 1, 'workspace_write'),
      participant('claude', 'claude', 'Reviewer', 2, 'read_only')
    ])

    harness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'A live round with a queued remove.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = harness.orchestrator.requestUserRosterMutation({
      chatId: 'ensemble-chat',
      action: 'remove',
      participantId: 'codex'
    })
    expect(result).toMatchObject({
      ok: true,
      status: 'queued',
      participantId: 'codex'
    })
    expect(harness.chat.ensemble?.participants.some((current) => current.id === 'codex')).toBe(true)

    await expect(harness.orchestrator.cancelRound('ensemble-chat', 'cancelled')).resolves.toBe(true)

    expect(harness.chat.ensemble?.participants.some((current) => current.id === 'codex')).toBe(
      false
    )
  })
})
