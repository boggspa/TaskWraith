import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'

function makeHarness() {
  const participants: EnsembleParticipant[] = [
    ['boss', 'codex', 'Orchestrator'],
    ['advisor', 'grok', 'Advisor'],
    ['worker', 'claude', 'Worker'],
    ['validator', 'codex', 'Validator']
  ].map(([id, provider, role], order) => ({
    id,
    provider: provider as EnsembleParticipant['provider'],
    role,
    order,
    enabled: true,
    instructions: role,
    permissionPresetId: 'workspace_write'
  }))
  let chat: ChatRecord = {
    appChatId: 'yield-handoff',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'codex',
    title: 'Explicit handoffs after pass selection',
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
      captainParticipantIds: ['advisor'],
      orchestrationMode: 'continuous',
      maxContinuationHops: 32,
      fanoutPolicy: 'off'
    }
  }
  let counter = 0
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
    createRunId: (provider) => `${provider}-handoff-${++counter}`,
    now: () => 1_000 + counter,
    nowIso: () => new Date(1_000 + counter).toISOString()
  })
  const output = (index: number, event: Record<string, unknown>) => {
    const run = dispatched[index]
    orchestrator.handleProviderOutput(
      run.provider,
      { appRunId: run.appRunId, appChatId: chat.appChatId },
      event
    )
  }
  return {
    get chat() {
      return chat
    },
    dispatched,
    orchestrator,
    output,
    async start() {
      orchestrator.startRound({
        chatId: chat.appChatId,
        prompt: 'Continue the implementation.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(dispatched).toHaveLength(1))
    },
    async selectValidator() {
      expect(
        await orchestrator.bossmanControlForRun(dispatched[0].appRunId, {
          action: 'select_participants',
          participantRoles: ['Validator']
        })
      ).toMatchObject({ ok: true })
    },
    complete(index: number) {
      output(index, { type: 'content', text: 'Checks completed; implementation can proceed.' })
      output(index, { type: 'result', status: 'success' })
    },
    yield(index: number, target: string) {
      output(index, {
        type: 'tool_use',
        tool_id: `handoff-${index}`,
        tool_name: 'ensemble_yield',
        parameters: { target }
      })
      return orchestrator.markYielded(dispatched[index].appRunId!, 'Please take over.', target)
    }
  }
}

const harnesses: ReturnType<typeof makeHarness>[] = []
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.orchestrator.cancelRound(h.chat.appChatId)))
})

function harness() {
  const h = makeHarness()
  harnesses.push(h)
  return h
}

describe('explicit Ensemble handoff after pass selection', () => {
  it.each([
    ['Advisor', 'advisor'],
    ['Worker', 'worker']
  ])('dispatches an omitted %s when Validator explicitly hands off', async (role, id) => {
    const h = harness()
    await h.start()
    await h.selectValidator()
    h.complete(0)
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(2))
    expect(h.dispatched[1].ensembleRun?.participantId).toBe('validator')

    expect(h.yield(1, role)).toMatchObject({
      kind: 'yielded',
      routing: { ok: true, targetParticipantId: id }
    })
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(3))
    expect(h.dispatched[2].ensembleRun?.participantId).toBe(id)
    expect(h.chat.ensemble?.activeRound?.continuationHops).toBe(1)
  })

  it('keeps an omitted Captain available for an explicit handoff in a later pass', async () => {
    const h = harness()
    await h.start()
    await h.selectValidator()
    h.complete(0)
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(2))
    h.complete(1)
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(3))
    expect(h.chat.ensemble?.activeRound?.continuationPass).toBe(2)
    expect(h.dispatched[2].ensembleRun?.participantId).toBe('boss')

    expect(h.yield(2, 'Advisor')).toMatchObject({
      kind: 'yielded',
      routing: { ok: true, targetParticipantId: 'advisor' }
    })
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(4))
    expect(h.dispatched[3].ensembleRun?.participantId).toBe('advisor')
  })

  it('preserves an explicit skip and records the rejected handoff as an error', async () => {
    const h = harness()
    await h.start()
    expect(
      await h.orchestrator.bossmanControlForRun(h.dispatched[0].appRunId, {
        action: 'skip_participant',
        targetParticipantId: 'advisor',
        reason: 'Skip this seat explicitly.'
      })
    ).toMatchObject({ ok: true })
    await h.selectValidator()
    h.complete(0)
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(2))

    expect(h.yield(1, 'Advisor')).toMatchObject({
      kind: 'yielded',
      routing: { ok: false, reason: 'blocked_status' }
    })
    const activity = h.chat.messages
      .flatMap((message) => message.toolActivities || [])
      .find((candidate) => candidate.id === 'handoff-1')
    expect(activity).toMatchObject({
      status: 'error',
      resultSummary: expect.stringContaining('not routed'),
      rawResultEvent: {
        success: false,
        result: { ok: false, error: 'blocked_status' }
      }
    })
    expect(activity?.displayName).not.toContain('yielded to')
    expect(h.dispatched.some((run) => run.ensembleRun?.participantId === 'advisor')).toBe(false)
  })

  it('replaces a streamed provider acknowledgement with the host rejection', async () => {
    const h = harness()
    h.chat.ensemble!.participants.find((participant) => participant.id === 'validator')!.provider =
      'cursor'
    await h.start()
    await h.selectValidator()
    h.complete(0)
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(2))
    h.chat.ensemble!.participants.find((participant) => participant.id === 'advisor')!.enabled =
      false
    h.output(1, {
      type: 'tool_use',
      tool_id: 'streamed-yield',
      tool_name: 'ensemble_yield',
      parameters: { target: 'Advisor' }
    })
    h.output(1, {
      type: 'tool_result',
      tool_id: 'streamed-yield',
      success: true,
      content: 'Yielded.'
    })

    const activity = h.chat.messages
      .flatMap((message) => message.toolActivities || [])
      .find((candidate) => candidate.id === 'streamed-yield')
    expect(activity).toMatchObject({
      status: 'error',
      resultSummary: expect.stringContaining('not routed'),
      rawResultEvent: { result: { ok: false, error: 'blocked_status' } }
    })
  })
})
