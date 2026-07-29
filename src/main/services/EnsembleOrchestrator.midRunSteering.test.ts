import { describe, expect, it, vi } from 'vitest'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'

const CHAT_ID = 'ensemble-chat'
const STEER_TEXT = 'MID-RUN: verify the retry boundary too.'

function participant(
  id: string,
  provider: EnsembleParticipant['provider'],
  order: number
): EnsembleParticipant {
  return {
    id,
    provider,
    enabled: true,
    role: id === 'codex' ? 'Worker' : 'Reviewer',
    instructions: 'Answer the user.',
    order,
    model: `${provider}-model`,
    permissionPresetId: 'workspace_write'
  }
}

function makeChat(): ChatRecord {
  return {
    appChatId: CHAT_ID,
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'codex',
    title: 'Mid-run steering',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 2,
      participants: [participant('codex', 'codex', 1), participant('claude', 'claude', 2)]
    }
  }
}

function makeHarness(options: { rejectFirstBoundaryDispatch?: boolean } = {}) {
  let chat = makeChat()
  let counter = 0
  let pendingEntryIds: string[] = []
  let boundaryDispatchCount = 0
  const dispatched: AgentRunPayload[] = []
  const accepted: boolean[] = []
  const cancelRun = vi.fn(async () => true)
  const getPendingMidRunSteeringEntryIds = vi.fn(() => [...pendingEntryIds])
  const appendMidRunSteering = vi.fn((input: { chatId: string; roundId: string; text: string }) => {
    expect(input.chatId).toBe(CHAT_ID)
    expect(input.roundId).toBe(chat.ensemble?.activeRound?.roundId)
    pendingEntryIds = ['steer-entry-1']
    chat = {
      ...chat,
      messages: [
        ...chat.messages,
        {
          id: 'steer-message-1',
          role: 'user',
          content: input.text,
          timestamp: '2026-07-29T03:00:00.000Z',
          metadata: { kind: 'midRunSteering' }
        }
      ]
    }
  })
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat: (next) => {
      chat = next
    },
    getSettings: () =>
      ({
        storeLocalChatHistory: true,
        storeRawEvents: false,
        ensembleModeEnabled: true,
        chatContextTurns: 8
      }) as AppSettings,
    dispatch: vi.fn(async (payload: AgentRunPayload) => {
      dispatched.push(payload)
      if (pendingEntryIds.length > 0) {
        boundaryDispatchCount += 1
        if (options.rejectFirstBoundaryDispatch && boundaryDispatchCount === 1) {
          accepted.push(false)
          return {
            dispatched: false,
            appRunId: payload.appRunId || '',
            failureMessage: 'boundary seat unavailable'
          }
        }
        pendingEntryIds = []
      }
      accepted.push(true)
      return { dispatched: true, appRunId: payload.appRunId || '' }
    }),
    cancelRun,
    createRunId: (provider) => `${provider}-run-${++counter}`,
    now: () => counter,
    nowIso: () => `2026-07-29T03:00:0${counter}.000Z`,
    appendMidRunSteering,
    getPendingMidRunSteeringEntryIds
  })
  return {
    get chat() {
      return chat
    },
    accepted,
    appendMidRunSteering,
    cancelRun,
    dispatched,
    getPendingMidRunSteeringEntryIds,
    orchestrator
  }
}

type Harness = ReturnType<typeof makeHarness>

function complete(harness: Harness, index: number): void {
  const payload = harness.dispatched[index]
  expect(harness.accepted[index]).toBe(true)
  harness.orchestrator.handleProviderOutput(
    payload.provider,
    { appRunId: payload.appRunId, appChatId: CHAT_ID },
    { type: 'result', status: 'success' }
  )
}

function stream(harness: Harness, index: number, text: string): void {
  const payload = harness.dispatched[index]
  harness.orchestrator.handleProviderOutput(
    payload.provider,
    { appRunId: payload.appRunId, appChatId: CHAT_ID },
    { type: 'content', text }
  )
}

async function reachFinalLiveSeat(harness: Harness): Promise<string> {
  const result = harness.orchestrator.startRound({
    chatId: CHAT_ID,
    prompt: 'Initial ensemble prompt.',
    event: { sender: {} as Electron.WebContents }
  })
  expect(result.status).toBe('started')
  expect(result.roundId).toBeTruthy()
  await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
  stream(harness, 0, 'Initial worker answer.')
  complete(harness, 0)
  await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
  expect(harness.dispatched[1].ensembleRun?.participantId).toBe('claude')
  return result.roundId!
}

describe('EnsembleOrchestrator mid-run steering', () => {
  it('absorbs a final-hop interjection and delivers it in the same round', async () => {
    const harness = makeHarness()
    const roundId = await reachFinalLiveSeat(harness)

    expect(
      harness.orchestrator.absorbMidRunSteering({
        chatId: CHAT_ID,
        roundId,
        text: STEER_TEXT
      })
    ).toEqual({ status: 'steered', roundId })
    expect(harness.appendMidRunSteering).toHaveBeenCalledOnce()
    expect(harness.cancelRun).not.toHaveBeenCalled()

    stream(harness, 1, 'Initial reviewer answer.')
    complete(harness, 1)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))

    const boundaryPayload = harness.dispatched[2]
    expect(boundaryPayload.ensembleRun?.roundId).toBe(roundId)
    expect(boundaryPayload.ensembleRun?.participantId).toBe('claude')
    expect(boundaryPayload.prompt).toContain(STEER_TEXT)
    expect(harness.chat.ensemble?.activeRound?.roundId).toBe(roundId)
    expect(harness.chat.ensemble?.activeRound?.status).toBe('running')
    expect(harness.cancelRun).not.toHaveBeenCalled()

    stream(harness, 2, 'Boundary answer.')
    complete(harness, 2)
    await vi.waitFor(() => {
      expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
    })
    expect(harness.dispatched).toHaveLength(3)
  })

  it('tries another eligible seat when the preferred boundary dispatch is rejected', async () => {
    const harness = makeHarness({ rejectFirstBoundaryDispatch: true })
    const roundId = await reachFinalLiveSeat(harness)

    expect(
      harness.orchestrator.absorbMidRunSteering({
        chatId: CHAT_ID,
        roundId,
        text: STEER_TEXT
      })
    ).toEqual({ status: 'steered', roundId })
    stream(harness, 1, 'Initial reviewer answer.')
    complete(harness, 1)

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    expect(harness.accepted.slice(2)).toEqual([false, true])
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('claude')
    expect(harness.dispatched[3].ensembleRun?.participantId).toBe('codex')
    expect(harness.dispatched[3].ensembleRun?.roundId).toBe(roundId)
    expect(harness.dispatched[3].prompt).toContain(STEER_TEXT)
    expect(harness.cancelRun).not.toHaveBeenCalled()

    stream(harness, 3, 'Fallback boundary answer.')
    complete(harness, 3)
    await vi.waitFor(() => {
      expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
    })
  })
})
