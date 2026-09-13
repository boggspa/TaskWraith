import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'

function participant(
  id: string,
  provider: EnsembleParticipant['provider'],
  role: string,
  order: number
): EnsembleParticipant {
  return {
    id,
    provider,
    enabled: true,
    role,
    order,
    instructions: `${role}.`,
    permissionPresetId: 'read_only'
  }
}

function makeHarness(input: {
  participants: EnsembleParticipant[]
  bossmanParticipantId?: string
}) {
  let chat: ChatRecord = {
    appChatId: 'routing-priority',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: input.participants[0].provider,
    title: 'Routing priority',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: input.participants.length,
      participants: input.participants,
      ...(input.bossmanParticipantId ? { bossmanParticipantId: input.bossmanParticipantId } : {}),
      orchestrationMode: 'continuous',
      maxContinuationHops: 12,
      fanoutPolicy: 'off'
    }
  }
  let runCounter = 0
  const dispatched: AgentRunPayload[] = []
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat: (next) => {
      chat = next
    },
    getSettings: () =>
      ({
        storeLocalChatHistory: true,
        storeRawEvents: true,
        ensembleModeEnabled: true,
        chatContextTurns: 8
      }) as AppSettings,
    dispatch: vi.fn(async (payload: AgentRunPayload) => {
      dispatched.push(payload)
      return { dispatched: true, appRunId: payload.appRunId! }
    }),
    cancelRun: vi.fn(async () => true),
    createRunId: (provider) => `${provider}-routing-priority-${++runCounter}`,
    now: () => 1_000 + runCounter,
    nowIso: () => new Date(1_000 + runCounter).toISOString()
  })

  const routeFor = (index: number) => {
    const run = dispatched[index]
    return {
      provider: run.provider,
      route: { appRunId: run.appRunId, appChatId: chat.appChatId }
    }
  }

  return {
    get chat() {
      return chat
    },
    dispatched,
    orchestrator,
    async start() {
      orchestrator.startRound({
        chatId: chat.appChatId,
        prompt: 'Complete the work and route the next turn.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(dispatched).toHaveLength(1))
    },
    complete(index: number, content: string) {
      const { provider, route } = routeFor(index)
      orchestrator.handleProviderOutput(provider, route, { type: 'content', text: content })
      orchestrator.handleProviderOutput(provider, route, { type: 'result', status: 'success' })
    }
  }
}

const harnesses: Array<ReturnType<typeof makeHarness>> = []

afterEach(async () => {
  await Promise.all(
    harnesses
      .splice(0)
      .map((harness) => harness.orchestrator.cancelRound(harness.chat.appChatId, 'Test complete.'))
  )
})

function harness(input: Parameters<typeof makeHarness>[0]): ReturnType<typeof makeHarness> {
  const created = makeHarness(input)
  harnesses.push(created)
  return created
}

function dispatchedParticipantIds(
  current: ReturnType<typeof makeHarness>
): Array<string | undefined> {
  return current.dispatched.map((run) => run.ensembleRun?.participantId)
}

describe('assistant routing priority', () => {
  it('dispatches a valid direct yield target before an assistant-text Boss tag', async () => {
    const current = harness({
      bossmanParticipantId: 'boss',
      participants: [
        participant('boss', 'codex', 'Boss', 1),
        participant('analyst', 'claude', 'Analyst', 2),
        participant('worker', 'gemini', 'Worker', 3)
      ]
    })
    await current.start()

    expect(
      current.orchestrator.markYielded(
        current.dispatched[0].appRunId!,
        'Analyst should inspect first.',
        'Analyst'
      )
    ).toMatchObject({
      kind: 'yielded',
      routing: { ok: true, targetParticipantId: 'analyst' }
    })
    await vi.waitFor(() => expect(current.dispatched).toHaveLength(2))

    const analystRun = current.dispatched[1]
    current.orchestrator.handleProviderOutput(
      analystRun.provider,
      { appRunId: analystRun.appRunId, appChatId: current.chat.appChatId },
      { type: 'content', text: '@Boss review this after Worker implements it.' }
    )
    expect(
      current.orchestrator.markYielded(
        analystRun.appRunId!,
        'Worker owns the implementation.',
        'Worker'
      )
    ).toMatchObject({
      kind: 'yielded',
      routing: { ok: true, targetParticipantId: 'worker' }
    })

    await vi.waitFor(() => expect(current.dispatched).toHaveLength(3))
    expect(dispatchedParticipantIds(current)).toEqual(['boss', 'analyst', 'worker'])
    expect(current.chat.ensemble?.activeRound?.continuationHops).toBe(0)
  })

  it.each(['answered', 'yielded'])(
    're-enters an eligible %s peer for exactly one mention hop',
    async (status) => {
      const current = harness({
        participants: [
          participant('analyst', 'claude', 'Analyst', 1),
          participant('implementer', 'codex', 'Implementer', 2),
          participant('reviewer', 'gemini', 'Reviewer', 3)
        ]
      })
      await current.start()

      if (status === 'yielded') {
        expect(
          current.orchestrator.markYielded(
            current.dispatched[0].appRunId!,
            'Initial analysis complete.',
            'Implementer'
          )
        ).toMatchObject({ kind: 'yielded', routing: { ok: true } })
      } else {
        current.complete(0, 'Initial analysis complete.')
      }
      await vi.waitFor(() => expect(current.dispatched).toHaveLength(2))
      current.complete(1, 'Implementation complete. @Analyst please reconcile the result.')

      await vi.waitFor(() => expect(current.dispatched).toHaveLength(3))
      expect(dispatchedParticipantIds(current)).toEqual(['analyst', 'implementer', 'analyst'])
      expect(current.chat.ensemble?.activeRound?.continuationHops).toBe(1)
      current.complete(2, 'Reconciliation complete.')
      await vi.waitFor(() => expect(current.dispatched).toHaveLength(4))
      expect(dispatchedParticipantIds(current)).toEqual([
        'analyst',
        'implementer',
        'analyst',
        'reviewer'
      ])
      expect(current.chat.ensemble?.activeRound?.continuationHops).toBe(1)
    }
  )

  it('promotes a pending assistant-text target ahead of the next serial seat without a tool call', async () => {
    const current = harness({
      participants: [
        participant('analyst', 'claude', 'Analyst', 1),
        participant('implementer', 'codex', 'Implementer', 2),
        participant('reviewer', 'gemini', 'Reviewer', 3)
      ]
    })
    await current.start()

    current.complete(
      0,
      'Analysis complete; I could not call a lifecycle tool. @Reviewer please take the next turn.'
    )

    await vi.waitFor(() => expect(current.dispatched).toHaveLength(2))
    expect(dispatchedParticipantIds(current)).toEqual(['analyst', 'reviewer'])
    expect(current.chat.ensemble?.activeRound?.continuationHops).toBe(0)
    expect(current.chat.messages.flatMap((message) => message.toolActivities || [])).toEqual([])
  })

  it('keeps serial order when an assistant tag resolves to no participant', async () => {
    const current = harness({
      participants: [
        participant('analyst', 'claude', 'Analyst', 1),
        participant('implementer', 'codex', 'Implementer', 2),
        participant('reviewer', 'gemini', 'Reviewer', 3)
      ]
    })
    await current.start()

    current.complete(0, '@Nobody please take the next turn.')

    await vi.waitFor(() => expect(current.dispatched).toHaveLength(2))
    expect(dispatchedParticipantIds(current)).toEqual(['analyst', 'implementer'])
    expect(current.chat.ensemble?.activeRound?.continuationHops).toBe(0)
  })

  it('keeps serial order when an ordinary seat mentions itself', async () => {
    const current = harness({
      participants: [
        participant('analyst', 'claude', 'Analyst', 1),
        participant('implementer', 'codex', 'Implementer', 2),
        participant('reviewer', 'gemini', 'Reviewer', 3)
      ]
    })
    await current.start()

    current.complete(0, 'As @Analyst I have completed the analysis.')

    await vi.waitFor(() => expect(current.dispatched).toHaveLength(2))
    expect(dispatchedParticipantIds(current)).toEqual(['analyst', 'implementer'])
    expect(current.chat.ensemble?.activeRound?.continuationHops).toBe(0)
  })

  it('keeps serial order and warns when an assistant tag is ambiguous', async () => {
    const current = harness({
      participants: [
        participant('analyst', 'kimi', 'Analyst', 1),
        participant('implementer', 'claude', 'Implementer', 2),
        participant('codex-builder', 'codex', 'Builder', 3),
        participant('codex-reviewer', 'codex', 'Reviewer', 4)
      ]
    })
    await current.start()

    current.complete(0, '@codex please take the next turn.')

    await vi.waitFor(() => expect(current.dispatched).toHaveLength(2))
    expect(dispatchedParticipantIds(current)).toEqual(['analyst', 'implementer'])
    expect(current.chat.ensemble?.activeRound?.continuationHops).toBe(0)
    expect(
      current.chat.messages.some(
        (message) => message.content.includes('@codex') && message.content.includes('was ambiguous')
      )
    ).toBe(true)
  })
})
