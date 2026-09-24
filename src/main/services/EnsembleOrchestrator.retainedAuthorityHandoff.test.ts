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

function makeChat(includeCaptain: boolean): ChatRecord {
  const participants = [
    participant('boss', 'claude', 'Boss', 1, 'workspace_write', 'claude-fable-5-ultratask'),
    ...(includeCaptain
      ? [participant('captain', 'codex', 'Captain', 2, 'workspace_write', 'gpt-5.6-terra')]
      : []),
    participant('reviewer', 'codex', 'Reviewer', 3, 'read_only', 'gpt-5.6-luna'),
    participant('worker', 'gemini', 'Worker', 4, 'workspace_write', 'gemini-3-pro')
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
      ...(includeCaptain ? { secondInCommandParticipantId: 'captain' } : {}),
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

function makeHarness(options: { includeCaptain?: boolean } = {}) {
  let chat = makeChat(options.includeCaptain !== false)
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

function failRun(harness: ReturnType<typeof makeHarness>, index: number): void {
  const run = harness.dispatched[index]!
  harness.orchestrator.handleProviderOutput(
    run.provider,
    { appRunId: run.appRunId, appChatId: 'ensemble-chat' },
    {
      type: 'result',
      status: 'failed',
      subtype: 'error',
      stats: { total_tokens: 5 }
    }
  )
}

async function startUnsettledReviewFanout(harness: ReturnType<typeof makeHarness>): Promise<void> {
  harness.orchestrator.startRound({
    chatId: 'ensemble-chat',
    prompt: 'Fan out, then retain authority.',
    event: { sender: {} as Electron.WebContents }
  })
  await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

  const fanout = harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId!, {
    targets: ['Reviewer'],
    prompt: 'Review while the Boss remains responsible.'
  })
  await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
  await expect(fanout).resolves.toMatchObject({ ok: true, participantIds: ['reviewer'] })
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
    await startUnsettledReviewFanout(harness)

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

    completeRun(
      harness,
      0,
      "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models."
    )
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

  it('hands a quota-terminal authority turn to an eligible Captain once', async () => {
    const harness = makeHarness()
    await startUnsettledReviewFanout(harness)

    completeRun(
      harness,
      0,
      "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models."
    )
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))

    expect(harness.dispatched[2]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-terra',
      ensembleRun: { participantId: 'captain', role: 'Captain' }
    })
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('takes over the authority turn')
      )
    ).toBe(true)
    expect(
      harness.dispatched.slice(2).some((run) => run.ensembleRun?.participantId === 'boss')
    ).toBe(false)

    await harness.orchestrator.cancelRound('ensemble-chat', 'Test complete.')
  })

  it('hands an explicitly failed authority turn to an eligible Captain', async () => {
    const harness = makeHarness()
    await startUnsettledReviewFanout(harness)

    failRun(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))

    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('captain')
    expect(
      harness.dispatched.slice(2).some((run) => run.ensembleRun?.participantId === 'boss')
    ).toBe(false)

    await harness.orchestrator.cancelRound('ensemble-chat', 'Test complete.')
  })

  it('waits for owned lanes and returns control when no peer manager can take over', async () => {
    const harness = makeHarness({ includeCaptain: false })
    await startUnsettledReviewFanout(harness)

    completeRun(
      harness,
      0,
      "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models."
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.dispatched).toHaveLength(2)

    completeRun(harness, 1, 'Review lane completed safely.')
    await vi.waitFor(() => expect(harness.chat.ensemble?.activeRound?.status).toBe('completed'))

    expect(harness.dispatched).toHaveLength(2)
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('returning control to the user instead of retrying')
      )
    ).toBe(true)
  })
})
