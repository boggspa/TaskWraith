import { describe, expect, it, vi } from 'vitest'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'
import type { WorkspaceChurnSample } from '../WorkspaceChurn'
import type {
  EnsembleSideMessageSteeringInput,
  EnsembleSideMessageSteeringResult
} from '../steering/EnsembleSideMessageSteering'
import { EnsembleOrchestrator, type EnsembleDispatchPromptEvidence } from './EnsembleOrchestrator'
import { deriveActiveEnsembleWorkingPresentations } from '../../renderer/src/lib/workingIndicatorPresentation'

const CHAT_ID = 'ensemble-chat'
const STEER_TEXT = 'MID-RUN: verify the retry boundary too.'

function participant(
  id: string,
  provider: EnsembleParticipant['provider'],
  order: number,
  patch: Partial<EnsembleParticipant> = {}
): EnsembleParticipant {
  return {
    id,
    provider,
    enabled: true,
    role: id === 'codex' ? 'Worker' : 'Reviewer',
    instructions: 'Answer the user.',
    order,
    model: `${provider}-model`,
    permissionPresetId: 'workspace_write',
    ...patch
  }
}

function makeChat(participants?: EnsembleParticipant[]): ChatRecord {
  const roster = participants || [
    participant('codex', 'codex', 1),
    participant('claude', 'claude', 2)
  ]
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
      maxParticipants: roster.length,
      participants: roster
    }
  }
}

function makeHarness(
  options: {
    rejectFirstBoundaryDispatch?: boolean
    participants?: EnsembleParticipant[]
    rejectFirstParticipantDispatchIds?: string[]
    awaitPendingSeatCompaction?: (
      chatId: string,
      participantId: string
    ) => Promise<unknown> | undefined
    sampleWorkspaceChurn?: (workspacePath: string) => Promise<WorkspaceChurnSample | null>
  } = {}
) {
  let chat = makeChat(options.participants)
  let counter = 0
  let steeringCounter = 0
  let pendingEntryIds: string[] = []
  let boundaryDispatchCount = 0
  const rejectedParticipantIds = new Set<string>()
  const dispatched: AgentRunPayload[] = []
  const promptEvidence: Array<EnsembleDispatchPromptEvidence | undefined> = []
  const accepted: boolean[] = []
  const cancelRun = vi.fn(async () => true)
  const getPendingMidRunSteeringEntryIds = vi.fn(() => [...pendingEntryIds])
  const deliverSideMessageSteering = vi.fn(
    (input: EnsembleSideMessageSteeringInput): EnsembleSideMessageSteeringResult => {
      // Persistence is the fallback contract: routing may begin only after the
      // exact visible row is readable from the chat store.
      expect(chat.messages.some((message) => message.id === input.messageId)).toBe(true)
      const entryId = `side-steer-${input.messageId}`
      return {
        entryId,
        attempts: input.targets.map((target) => ({
          participantId: target.participantId,
          runId: target.runId,
          status: 'injected',
          strategy: 'acp-interrupt',
          entryId
        }))
      }
    }
  )
  const appendMidRunSteering = vi.fn((input: { chatId: string; roundId: string; text: string }) => {
    expect(input.chatId).toBe(CHAT_ID)
    expect(input.roundId).toBe(chat.ensemble?.activeRound?.roundId)
    steeringCounter += 1
    const messageId = `steer-message-${steeringCounter}`
    const entryId = `steer-entry-${steeringCounter}`
    pendingEntryIds = [...pendingEntryIds, entryId]
    chat = {
      ...chat,
      messages: [
        ...chat.messages,
        {
          id: messageId,
          role: 'user',
          content: input.text,
          timestamp: '2026-07-29T03:00:00.000Z',
          metadata: { kind: 'midRunSteering' }
        }
      ]
    }
    return { messageId, entryId }
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
    dispatch: vi.fn(async (payload: AgentRunPayload, _event, _observer, evidence) => {
      dispatched.push(payload)
      promptEvidence.push(evidence)
      const participantId = payload.ensembleRun?.participantId
      if (
        participantId &&
        options.rejectFirstParticipantDispatchIds?.includes(participantId) &&
        !rejectedParticipantIds.has(participantId)
      ) {
        rejectedParticipantIds.add(participantId)
        accepted.push(false)
        return {
          dispatched: false,
          appRunId: payload.appRunId || '',
          failureMessage: `${participantId} rejected once`
        }
      }
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
    getPendingMidRunSteeringEntryIds,
    deliverSideMessageSteering,
    awaitPendingSeatCompaction: options.awaitPendingSeatCompaction,
    sampleWorkspaceChurn: options.sampleWorkspaceChurn
  })
  return {
    get chat() {
      return chat
    },
    accepted,
    appendMidRunSteering,
    cancelRun,
    deliverSideMessageSteering,
    dispatched,
    getPendingMidRunSteeringEntryIds,
    orchestrator,
    promptEvidence
  }
}

type Harness = ReturnType<typeof makeHarness>

// Continuous-only rounds auto-continue after the roster drains; a completed
// goal is the established kill-switch that lets a drained round complete
// (same device as EnsembleOrchestrator.test.ts).
function seedCompletedGoal(harness: Harness): void {
  harness.chat.activeGoal = {
    id: 'goal-steering-complete',
    objective: 'Already satisfied — the round may close when the roster drains.',
    status: 'completed',
    mode: 'taskwraith_steered',
    provider: 'codex',
    createdAt: '2026-07-29T03:00:00.000Z',
    updatedAt: '2026-07-29T03:00:00.000Z'
  }
}

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
    seedCompletedGoal(harness)
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

  it('refreshes the transcript after async churn sampling before receipting a steer', async () => {
    const emptySample: WorkspaceChurnSample = { tracked: {}, untracked: {} }
    let resolveSecondSample!: (sample: WorkspaceChurnSample | null) => void
    const heldSecondSample = new Promise<WorkspaceChurnSample | null>((resolve) => {
      resolveSecondSample = resolve
    })
    const sampleWorkspaceChurn = vi
      .fn<(workspacePath: string) => Promise<WorkspaceChurnSample | null>>()
      .mockResolvedValueOnce(emptySample)
      .mockReturnValueOnce(heldSecondSample)
    const harness = makeHarness({ sampleWorkspaceChurn })
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Initial ensemble prompt.',
      event: { sender: {} as Electron.WebContents }
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    complete(harness, 0)
    await vi.waitFor(() => expect(sampleWorkspaceChurn).toHaveBeenCalledTimes(2))
    expect(
      harness.orchestrator.absorbMidRunSteering({
        chatId: CHAT_ID,
        roundId: started.roundId!,
        text: STEER_TEXT
      })
    ).toEqual({ status: 'steered', roundId: started.roundId })

    resolveSecondSample(emptySample)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].prompt).toContain(STEER_TEXT)
    expect(harness.promptEvidence[1]?.suppliedMessageIds).toContain('steer-message-1')

    complete(harness, 1)
    await vi.waitFor(() => {
      expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
    })
  })

  it('tries another eligible seat when the preferred boundary dispatch is rejected', async () => {
    const harness = makeHarness({ rejectFirstBoundaryDispatch: true })
    seedCompletedGoal(harness)
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

  it('holds an active-goal round for pending steering and resumes from recoverable waiting', async () => {
    const harness = makeHarness({
      participants: [participant('work-1', 'codex', 1, { role: 'Work1' })],
      rejectFirstBoundaryDispatch: true
    })
    harness.chat.activeGoal = {
      id: 'goal-steering-wait',
      objective: 'Finish the long-horizon task without losing user steering.',
      status: 'active',
      mode: 'taskwraith_steered',
      provider: 'codex',
      createdAt: '2026-07-29T03:00:00.000Z',
      updatedAt: '2026-07-29T03:00:00.000Z'
    }
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Begin the long-horizon task.',
      event: { sender: {} as Electron.WebContents }
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    expect(
      harness.orchestrator.absorbMidRunSteering({
        chatId: CHAT_ID,
        roundId: started.roundId!,
        text: 'Preserve this interjection across the boundary.',
        dmTargetParticipantId: 'work-1'
      })
    ).toEqual({ status: 'steered', roundId: started.roundId })
    stream(harness, 0, 'Original work completed.')
    complete(harness, 0)

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.accepted[1]).toBe(false)
    await vi.waitFor(() =>
      expect(
        harness.chat.messages.some((message) =>
          message.content.includes('The active-goal round remains open')
        )
      ).toBe(true)
    )
    expect(harness.chat.ensemble?.activeRound).toMatchObject({
      roundId: started.roundId,
      status: 'running'
    })
    expect(harness.chat.ensemble?.activeRound?.endedAt).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.dispatched).toHaveLength(2)

    const participantState = harness.chat.ensemble!.activeRound!.participants[0]!
    participantState.status = 'skipped'
    expect(
      harness.orchestrator.absorbMidRunSteering({
        chatId: CHAT_ID,
        roundId: started.roundId!,
        text: 'Please retry now that Work1 is eligible again.',
        dmTargetParticipantId: 'work-1'
      })
    ).toEqual({ status: 'steered', roundId: started.roundId })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.accepted[2]).toBe(true)
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('work-1')
    expect(harness.dispatched[2].prompt).toContain('Please retry now that Work1 is eligible again.')
    harness.chat.activeGoal!.status = 'completed'
    stream(harness, 2, 'Recovered boundary answer.')
    complete(harness, 2)
    await vi.waitFor(() => {
      expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
    })
  })

  it('adds an immediate User Fan-Out for idle tags without interrupting the active speaker', async () => {
    const roster = [
      participant('codex', 'codex', 1, { role: 'Worker', stageRole: 'worker' }),
      participant('claude', 'claude', 2, { role: 'Reviewer', stageRole: 'reviewer' }),
      participant('observer', 'kimi', 3, { role: 'Observer', stageRole: 'scout' }),
      participant('grok-bg', 'grok', 4, { role: 'Background', stageRole: 'background' })
    ]
    const harness = makeHarness({ participants: roster })
    seedCompletedGoal(harness)
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Original round work.',
      event: { sender: {} as Electron.WebContents }
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')

    const userPrompt =
      '@Worker incorporate this while @Reviewer reviews and @Background inspects asynchronously.'
    expect(
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt: userPrompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      }).status
    ).toBe('queued')
    const steered = harness.orchestrator.steerQueuedPrompt({
      chatId: CHAT_ID,
      index: 0,
      textPrefix: userPrompt,
      event: { sender: {} as Electron.WebContents }
    })

    expect(steered).toEqual({ status: 'steered', roundId: started.roundId })
    expect(harness.cancelRun).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(
      harness.dispatched.slice(1).map((payload) => payload.ensembleRun?.participantId)
    ).toEqual(['claude', 'grok-bg'])
    expect(
      harness.promptEvidence
        .slice(1, 3)
        .every((evidence) => evidence?.suppliedMessageIds.includes('steer-message-1'))
    ).toBe(true)
    for (const payload of harness.dispatched.slice(1)) {
      expect(payload.effectivePermissions?.presetId).toBe('workspace_write')
      expect(payload.effectivePermissions?.readOnly).toBe(false)
      expect(payload.approvalMode).toBe('auto_edit')
      expect(payload.prompt).toContain('Current user-directed fan-out request:')
      expect(payload.prompt).toContain(userPrompt)
      expect(payload.prompt.split(userPrompt)).toHaveLength(2)
      expect(payload.prompt).not.toContain('lower authority than user/system instructions')
    }
    expect(
      harness.dispatched.some((payload) => payload.ensembleRun?.participantId === 'observer')
    ).toBe(false)
    const userRowIndex = harness.chat.messages.findIndex(
      (message) => message.metadata?.kind === 'midRunSteering' && message.content === userPrompt
    )
    const dispatchRowIndex = harness.chat.messages.findIndex((message) =>
      message.content.startsWith('User Fan-Out · 2 participant(s) dispatched concurrently')
    )
    expect(userRowIndex).toBeGreaterThanOrEqual(0)
    expect(dispatchRowIndex).toBeGreaterThan(userRowIndex)
    const dispatchRow = harness.chat.messages[dispatchRowIndex]
    expect(dispatchRow.metadata?.ensembleFanoutCategory).toBe('user')
    expect(dispatchRow.metadata?.ensembleFanoutLabel).toBe('User Fan-Out')
    expect(dispatchRow.metadata?.ensembleFanoutWaveId).toBe(dispatchRow.id)
    expect(dispatchRow.metadata?.ensembleFanoutDispatch).toEqual({
      label: 'User Fan-Out',
      category: 'user',
      participants: [
        {
          participantId: 'claude',
          provider: 'claude',
          role: 'Reviewer',
          model: 'claude-model',
          intent: 'write'
        },
        {
          participantId: 'grok-bg',
          provider: 'grok',
          role: 'Background',
          model: 'grok-model',
          intent: 'write'
        }
      ]
    })
    expect(harness.chat.ensemble?.activeRound?.queuedPrompts).toEqual([])
    expect(
      harness.chat.ensemble?.activeRound?.participants.some(
        (entry) => entry.participantId === 'grok-bg'
      )
    ).toBe(true)

    stream(harness, 1, 'User-directed review lane answer.')
    stream(harness, 2, 'User-directed background lane answer.')
    await vi.waitFor(() =>
      expect(
        harness.chat.messages.filter((message) =>
          harness.dispatched.slice(1, 3).some((payload) => payload.appRunId === message.runId)
        )
      ).toHaveLength(2)
    )
    const userLaneRows = harness.chat.messages.filter((message) =>
      harness.dispatched.slice(1, 3).some((payload) => payload.appRunId === message.runId)
    )
    expect(
      userLaneRows.every(
        (message) =>
          message.metadata?.ensembleFanoutWaveId === dispatchRow.id &&
          message.metadata?.ensembleFanoutCategory === 'user' &&
          message.metadata?.ensembleFanoutLabel === 'User Fan-Out'
      )
    ).toBe(true)

    stream(harness, 0, 'Original speaker completed normally.')
    complete(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    expect(harness.dispatched[3].ensembleRun?.participantId).toBe('observer')

    complete(harness, 3)
    complete(harness, 1)
    complete(harness, 2)
    await vi.waitFor(() => {
      expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
    })
    expect(
      harness.chat.messages.some(
        (message) =>
          message.metadata?.kind === 'ensembleRoundStatus' &&
          message.content === 'User Fan-Out complete · 2 lane(s) returned.'
      )
    ).toBe(false)
    expect(harness.cancelRun).not.toHaveBeenCalled()
  })

  it('keeps a lower-order User Fan-Out lane behind its own dispatch receipt', async () => {
    const roster = [
      participant('orchestrator', 'claude', 1, {
        role: 'Orchestrator',
        stageRole: 'background'
      }),
      participant('owner', 'codex', 5, { role: 'Owner' }),
      participant('work-1', 'kimi', 6, { role: 'Work1' })
    ]
    const harness = makeHarness({ participants: roster })
    harness.chat.ensemble!.bossmanParticipantId = 'owner'
    harness.chat.ensemble!.fanoutPolicy = 'read_only'
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Keep the existing Work1 lane active while the user adds Orchestrator.',
      event: { sender: {} as Electron.WebContents }
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('owner')

    const olderWave = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
      targets: ['Work1'],
      prompt: 'Keep inspecting while the owner continues.'
    })
    expect(olderWave.ok).toBe(true)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    stream(harness, 1, 'OLDER-WORK1-LANE.')
    await vi.waitFor(() =>
      expect(
        harness.chat.messages.some((message) => message.content.includes('OLDER-WORK1-LANE.'))
      ).toBe(true)
    )

    const userPrompt = '@Orchestrator confirm the live round remains healthy.'
    expect(
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt: userPrompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'steer'
      })
    ).toEqual({ status: 'steered', roundId: started.roundId })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('orchestrator')

    const dispatchIndex = harness.chat.messages.findIndex(
      (message) =>
        message.metadata?.kind === 'ensembleRoundStatus' &&
        message.content.startsWith('User Fan-Out · 1 participant(s) dispatched concurrently')
    )
    expect(dispatchIndex).toBeGreaterThanOrEqual(0)
    const dispatchWaveId = harness.chat.messages[dispatchIndex].metadata?.ensembleFanoutWaveId
    expect(dispatchWaveId).toBe(harness.chat.messages[dispatchIndex].id)

    stream(harness, 2, 'NEW-ORCHESTRATOR-LANE.')
    await vi.waitFor(() =>
      expect(
        harness.chat.messages.some((message) => message.content.includes('NEW-ORCHESTRATOR-LANE.'))
      ).toBe(true)
    )
    const newLaneIndex = harness.chat.messages.findIndex((message) =>
      message.content.includes('NEW-ORCHESTRATOR-LANE.')
    )
    expect(newLaneIndex).toBeGreaterThan(dispatchIndex)
    expect(harness.chat.messages[newLaneIndex].metadata?.ensembleFanoutWaveId).toBe(dispatchWaveId)

    complete(harness, 2)
    complete(harness, 1)
    stream(harness, 0, 'Owner finished after both waves.')
    complete(harness, 0)
  })

  it('expands a user @All steer to every idle enabled seat without duplicating the speaker', async () => {
    const roster = [
      participant('codex', 'codex', 1, { role: 'Worker', stageRole: 'worker' }),
      participant('claude', 'claude', 2, { role: 'Reviewer', stageRole: 'reviewer' }),
      participant('observer', 'kimi', 3, {
        role: 'Scout',
        stageRole: 'scout',
        permissionPresetId: 'read_only'
      }),
      participant('grok-bg', 'grok', 4, { role: 'Background', stageRole: 'background' })
    ]
    const harness = makeHarness({ participants: roster })
    seedCompletedGoal(harness)
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Original round work.',
      event: { sender: {} as Electron.WebContents }
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')

    const userPrompt = '@All validate the latest steer in your own lane.'
    expect(
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt: userPrompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      }).status
    ).toBe('queued')
    expect(
      harness.orchestrator.steerQueuedPrompt({
        chatId: CHAT_ID,
        index: 0,
        textPrefix: userPrompt,
        event: { sender: {} as Electron.WebContents }
      })
    ).toEqual({ status: 'steered', roundId: started.roundId })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    expect(
      harness.dispatched.slice(1).map((payload) => payload.ensembleRun?.participantId)
    ).toEqual(['claude', 'observer', 'grok-bg'])
    expect(
      harness.dispatched.filter((payload) => payload.ensembleRun?.participantId === 'codex')
    ).toHaveLength(1)
    expect(
      harness.promptEvidence
        .slice(1)
        .every((evidence) => evidence?.suppliedMessageIds.includes('steer-message-1'))
    ).toBe(true)
    expect(harness.cancelRun).not.toHaveBeenCalled()

    for (let index = 1; index < 4; index += 1) {
      stream(harness, index, `Group lane ${index} answered.`)
      complete(harness, index)
    }
    stream(harness, 0, 'Original speaker completed normally.')
    complete(harness, 0)
    await vi.waitFor(() => {
      expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
    })
  })

  it('expands a user @Management steer to every idle enabled Captain beside the active Boss', async () => {
    const roster = [
      participant('boss', 'codex', 1, { role: 'Coordinator' }),
      participant('captain-a', 'claude', 2, { role: 'Planner' }),
      participant('captain-b', 'kimi', 3, { role: 'Verifier' }),
      participant('worker', 'grok', 4, { role: 'Builder' })
    ]
    const harness = makeHarness({ participants: roster })
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.chat.ensemble!.captainParticipantIds = ['captain-a', 'captain-b']
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Original management round.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    expect(
      harness.orchestrator.absorbMidRunSteering({
        chatId: CHAT_ID,
        roundId: started.roundId!,
        text: '@Management review the changed direction.'
      })
    ).toEqual({ status: 'steered', roundId: started.roundId })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(
      harness.dispatched.slice(1).map((payload) => payload.ensembleRun?.participantId)
    ).toEqual(['captain-a', 'captain-b'])
    expect(
      harness.dispatched.some((payload) => payload.ensembleRun?.participantId === 'worker')
    ).toBe(false)
    await expect(harness.orchestrator.cancelRound(CHAT_ID, 'test complete')).resolves.toBe(true)
  })

  it('keeps an already-running tagged seat on ordinary steer semantics without a duplicate lane', async () => {
    const harness = makeHarness()
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Original round work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const prompt = '@Worker incorporate this correction.'
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt,
      dmTargetParticipantId: 'codex',
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    const result = harness.orchestrator.steerQueuedPrompt({
      chatId: CHAT_ID,
      index: 0,
      textPrefix: prompt,
      event: { sender: {} as Electron.WebContents }
    })

    expect(result).toEqual({ status: 'steered', roundId: started.roundId })
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.appendMidRunSteering).toHaveBeenCalledOnce()
    expect(harness.cancelRun).not.toHaveBeenCalled()
    expect(
      harness.chat.messages.some((message) => message.content.startsWith('User Fan-Out ·'))
    ).toBe(false)

    complete(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    complete(harness, 1)
    await vi.waitFor(() => {
      expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
    })
  })

  // The one seam nobody owns: MAIN writes the lane, the RENDERER decides who is
  // shown working, and each was only ever tested against a hand-built version of
  // the other's shape. This drives a real User Fan-Out and feeds the actual
  // round record to the actual derivation, so "the fan-out seat gets a working
  // row" stops resting on an assumption about what a lane looks like.
  it('surfaces a real User Fan-Out lane as a working row beside the serial speaker', async () => {
    const roster = [
      participant('codex', 'codex', 1, { role: 'Worker' }),
      participant('claude', 'claude', 2, { role: 'Reviewer' })
    ]
    const harness = makeHarness({ participants: roster })
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Original round work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')

    // Only the serial speaker is working so far.
    expect(
      deriveActiveEnsembleWorkingPresentations(harness.chat).map((item) => item.participantId)
    ).toEqual([])

    const prompt = '@Reviewer try your slice again.'
    expect(
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'steer'
      }).status
    ).toBe('steered')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('claude')

    // The shape that hid the seat, pinned exactly: `addLaneToRound` flips
    // `concurrentMode` on when it stores a lane, but NOTHING moves the round's
    // own `fanoutPolicy` off 'off' — a User Fan-Out dispatches on
    // `concurrentLanesEnabled()` alone and does not ask the round's policy.
    // The old derivation required BOTH, so the `fanoutPolicy` clause is what
    // actually dropped this seat. Assert both halves so a future change to
    // either one cannot quietly restore the hole.
    const round = harness.chat.ensemble?.activeRound
    expect(round?.concurrentMode).toBe(true)
    expect(round?.fanoutPolicy).toBe('off')
    expect(
      Object.values(round?.lanes || {}).map((lane) => ({
        participantId: lane.participantId,
        status: lane.status
      }))
    ).toEqual([{ participantId: 'claude', status: 'running' }])
    expect(
      deriveActiveEnsembleWorkingPresentations(harness.chat).map((item) => item.participantId)
    ).toEqual(['codex', 'claude'])
  })

  // The queued row and the composer send the same typed text through two
  // entries, and only the queued one opened a wave — so whether "@Seat do this"
  // reached that seat now or waited for its serial turn depended on whether the
  // text had been parked in the queue first. Retry rides this entry too.
  it('opens a User Fan-Out from a composer steer, not only from the queued row', async () => {
    const roster = [
      participant('codex', 'codex', 1, { role: 'Worker' }),
      participant('claude', 'claude', 2, { role: 'Reviewer' })
    ]
    const harness = makeHarness({ participants: roster })
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Original round work.',
      event: { sender: {} as Electron.WebContents }
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex')

    // The run-ensemble-round handler absorbs eligible steers through the
    // PUBLIC absorbMidRunSteering wrapper and returns before beginRound's
    // mode:'steer' branch runs — so this entry, not just beginRound, must
    // open the tagged seats' wave.
    const prompt = '@Reviewer try your slice again.'
    expect(
      harness.orchestrator.absorbMidRunSteering({
        chatId: CHAT_ID,
        roundId: started.roundId!,
        text: prompt
      })
    ).toEqual({ status: 'steered', roundId: started.roundId })

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('claude')
    expect(
      harness.chat.messages.some((message) => message.content.startsWith('User Fan-Out ·'))
    ).toBe(true)
    // Additive: the original speaker is never interrupted to make room.
    expect(harness.cancelRun).not.toHaveBeenCalled()
  })

  it('keeps an untagged public-wrapper steer on ordinary absorb semantics without a wave', async () => {
    const roster = [
      participant('codex', 'codex', 1, { role: 'Worker' }),
      participant('claude', 'claude', 2, { role: 'Reviewer' })
    ]
    const harness = makeHarness({ participants: roster })
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Original round work.',
      event: { sender: {} as Electron.WebContents }
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    expect(
      harness.orchestrator.absorbMidRunSteering({
        chatId: CHAT_ID,
        roundId: started.roundId!,
        text: 'plain interjection with no seat tag'
      })
    ).toEqual({ status: 'steered', roundId: started.roundId })
    await new Promise((resolve) => setTimeout(resolve, 50))
    // No fallback lane: the interjection rides the next hop prompt only.
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.cancelRun).not.toHaveBeenCalled()
  })

  it('routes a persisted side message into the exact active parallel recipient run', async () => {
    const roster = [
      participant('work-1', 'codex', 1, { role: 'Work1' }),
      participant('work-3', 'kimi', 2, { role: 'Work3' })
    ]
    const harness = makeHarness({ participants: roster })
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Work1 owns the serial task.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    expect(
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt: '@Work3 inspect the parallel safety controls.',
        event: { sender: {} as Electron.WebContents },
        mode: 'steer'
      }).status
    ).toBe('steered')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1]).toMatchObject({
      provider: 'kimi',
      ensembleRun: { participantId: 'work-3' }
    })

    const result = harness.orchestrator.sendSideMessageForRun(harness.dispatched[0].appRunId, {
      to: ['@User', 'Work3'],
      message: 'Hold the commit until the two safety controls are present.',
      reason: 'Advisor requested a publication hold.'
    })

    expect(result).toMatchObject({
      ok: true,
      toUser: true,
      toParticipantIds: ['work-3'],
      liveSteerRequestedParticipantIds: ['work-3']
    })
    expect(result.boundaryDeliveryParticipantIds).toBeUndefined()
    expect(result.message).toContain('Immediate live steer requested for Work3')
    expect(harness.deliverSideMessageSteering).toHaveBeenCalledOnce()
    expect(harness.deliverSideMessageSteering.mock.calls[0]?.[0]).toMatchObject({
      chatId: CHAT_ID,
      fromParticipantId: 'work-1',
      fromLabel: 'Work1',
      toParticipantIds: ['work-3'],
      toLabels: ['Work3'],
      toUser: true,
      message: 'Hold the commit until the two safety controls are present.',
      targets: [
        {
          participantId: 'work-3',
          runId: harness.dispatched[1].appRunId,
          provider: 'kimi'
        }
      ]
    })
    expect(
      harness.chat.messages.find((message) => message.metadata?.kind === 'ensembleSideMessage')
        ?.content
    ).toBe(
      '↪ Work1 to User, Work3: Hold the commit until the two safety controls are present.\nReason: Advisor requested a publication hold.'
    )
  })

  it('keeps a fan-out lane summary for User as a top-level durable participant message', async () => {
    const roster = [
      participant('work-1', 'codex', 1, { role: 'Work1' }),
      participant('work-3', 'kimi', 2, { role: 'Work3' })
    ]
    const harness = makeHarness({ participants: roster })
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Work1 owns the serial task.',
      event: { sender: {} as Electron.WebContents }
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    expect(
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt: '@Work3 inspect the parallel safety controls.',
        event: { sender: {} as Electron.WebContents },
        mode: 'steer'
      }).status
    ).toBe('steered')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

    const laneRunId = harness.dispatched[1].appRunId
    const result = harness.orchestrator.sendSideMessageForRun(laneRunId, {
      to: '@Human',
      message: 'The parallel safety review is complete and the hold remains necessary.'
    })

    expect(result).toEqual({
      ok: true,
      tool: 'ensemble_send',
      toUser: true,
      toParticipantIds: [],
      message: 'ensemble_send: durable transcript message recorded for User.'
    })
    expect(harness.deliverSideMessageSteering).not.toHaveBeenCalled()

    const sideMessage = harness.chat.messages.find(
      (entry) => entry.metadata?.kind === 'ensembleSideMessage'
    )
    expect(sideMessage).toMatchObject({
      role: 'system',
      runId: laneRunId,
      content:
        '↪ Work3 to User: The parallel safety review is complete and the hold remains necessary.',
      metadata: {
        kind: 'ensembleSideMessage',
        toUser: true,
        toParticipantIds: [],
        fromParticipantId: 'work-3',
        ensembleParticipantId: 'work-3',
        ensembleRoundId: started.roundId,
        ensembleFanoutCategory: 'user',
        ensembleFanoutLabel: 'User Fan-Out'
      }
    })
    expect(sideMessage?.metadata?.ensembleSourceLaneId).toBeTruthy()
    expect(sideMessage?.metadata?.ensembleLaneId).toBeUndefined()

    complete(harness, 1)
    expect(harness.chat.messages.some((entry) => entry.id === sideMessage?.id)).toBe(true)
    await expect(harness.orchestrator.cancelRound(CHAT_ID, 'test complete')).resolves.toBe(true)
  })

  it('keeps an idle recipient on the durable next-prompt path without a false live receipt', async () => {
    const roster = [
      participant('work-1', 'codex', 1, { role: 'Work1' }),
      participant('work-3', 'kimi', 2, { role: 'Work3' })
    ]
    const harness = makeHarness({ participants: roster })
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Work1 owns the serial task.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = harness.orchestrator.sendSideMessageForRun(harness.dispatched[0].appRunId, {
      to: 'Work3',
      message: 'Read this when your turn begins.'
    })

    expect(result).toMatchObject({
      ok: true,
      boundaryDeliveryParticipantIds: ['work-3']
    })
    expect(result.liveSteerRequestedParticipantIds).toBeUndefined()
    expect(result.message).toContain('next prompt boundary')
    expect(harness.deliverSideMessageSteering).not.toHaveBeenCalled()
  })

  it('keeps an unknown-only side-message audience fail-closed', async () => {
    const harness = makeHarness()
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Start the round.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    expect(
      harness.orchestrator.sendSideMessageForRun(harness.dispatched[0].appRunId, {
        to: '@SomeoneElse',
        message: 'This must not fall back to User or any participant.'
      })
    ).toEqual({
      ok: false,
      tool: 'ensemble_send',
      message:
        'ensemble_send: target did not resolve to an enabled participant. Use list_ensemble_participants first.',
      error: 'invalid_target'
    })
    expect(
      harness.chat.messages.some((message) => message.metadata?.kind === 'ensembleSideMessage')
    ).toBe(false)
    expect(harness.deliverSideMessageSteering).not.toHaveBeenCalled()
  })

  it('expands explicit side-message groups without treating message-body tags as recipients', async () => {
    const roster = [
      participant('work-1', 'codex', 1, { role: 'Work1', stageRole: 'worker' }),
      participant('review-1', 'claude', 2, { role: 'Review1', stageRole: 'reviewer' }),
      participant('work-2', 'kimi', 3, { role: 'Work2', stageRole: 'worker' }),
      participant('background-shell', 'codex', 4, {
        role: 'Background',
        stageRole: 'background'
      })
    ]
    const harness = makeHarness({ participants: roster })
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Work1 owns the serial task.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = harness.orchestrator.sendSideMessageForRun(harness.dispatched[0].appRunId, {
      to: ['@Workers', '@BG'],
      message: '@User and @All are quoted context, not extra recipient selectors.'
    })

    expect(result).toMatchObject({
      ok: true,
      toParticipantIds: ['work-2', 'background-shell'],
      boundaryDeliveryParticipantIds: ['work-2', 'background-shell']
    })
    expect(result.toParticipantIds).not.toContain('review-1')
    expect(result.toUser).toBeUndefined()
    expect(harness.deliverSideMessageSteering).not.toHaveBeenCalled()
    const sideMessage = harness.chat.messages.find(
      (message) => message.metadata?.kind === 'ensembleSideMessage'
    )
    expect(sideMessage?.metadata?.toParticipantIds).toEqual(['work-2', 'background-shell'])
    expect(sideMessage?.metadata?.toUser).toBeUndefined()
  })

  it('expands @Captains side-message recipients from configured authority ids', async () => {
    const roster = [
      participant('boss', 'codex', 1, { role: 'Lead' }),
      participant('captain-a', 'claude', 2, { role: 'Analyst' }),
      participant('captain-b', 'kimi', 3, { role: 'Verifier' }),
      participant('role-only', 'grok', 4, { role: 'Captain' })
    ]
    const harness = makeHarness({ participants: roster })
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.chat.ensemble!.captainParticipantIds = ['captain-a', 'captain-b']
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Lead owns the current turn.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const result = harness.orchestrator.sendSideMessageForRun(harness.dispatched[0].appRunId, {
      to: '@Captains',
      message: 'Please compare the two options.'
    })

    expect(result).toMatchObject({
      ok: true,
      toParticipantIds: ['captain-a', 'captain-b']
    })
    expect(result.toParticipantIds).not.toContain('role-only')
    await expect(harness.orchestrator.cancelRound(CHAT_ID, 'test complete')).resolves.toBe(true)
  })

  it('lets the Boss route an assistant-authored stage group in roster order', async () => {
    const roster = [
      participant('boss', 'codex', 1, { role: 'Boss', stageRole: 'worker' }),
      participant('scout', 'claude', 2, { role: 'Scout', stageRole: 'scout' }),
      participant('reviewer', 'kimi', 3, { role: 'Reviewer', stageRole: 'reviewer' }),
      participant('worker-1', 'codex', 4, { role: 'Worker1', stageRole: 'worker' }),
      participant('worker-2', 'claude', 5, { role: 'Worker2', stageRole: 'worker' })
    ]
    const harness = makeHarness({ participants: roster })
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Coordinate the staged work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    stream(harness, 0, '@Workers take both implementation slices next.')
    complete(harness, 0)

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('worker-1')
    complete(harness, 1)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('worker-2')
    await expect(harness.orchestrator.cancelRound(CHAT_ID, 'test complete')).resolves.toBe(true)
  })

  it('lets the Boss route every configured Captain despite broad-group authority exclusions', async () => {
    const roster = [
      participant('boss', 'codex', 1, { role: 'Lead' }),
      participant('captain-a', 'claude', 2, { role: 'Analyst' }),
      participant('worker', 'grok', 3, { role: 'Builder' }),
      participant('captain-b', 'kimi', 4, { role: 'Verifier' })
    ]
    const harness = makeHarness({ participants: roster })
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.chat.ensemble!.captainParticipantIds = ['captain-a', 'captain-b']
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Coordinate the management pass.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    stream(harness, 0, '@Captains decide the review split together.')
    complete(harness, 0)

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('captain-a')
    complete(harness, 1)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('captain-b')
    await expect(harness.orchestrator.cancelRound(CHAT_ID, 'test complete')).resolves.toBe(true)
  })

  it('keeps assistant @Management collective instead of collapsing to the priority Boss', async () => {
    const roster = [
      participant('captain-a', 'claude', 1, { role: 'Analyst' }),
      participant('boss', 'codex', 2, { role: 'Lead' }),
      participant('worker', 'grok', 3, { role: 'Builder' }),
      participant('captain-b', 'kimi', 4, { role: 'Verifier' })
    ]
    const harness = makeHarness({ participants: roster })
    harness.chat.ensemble!.bossmanParticipantId = 'boss'
    harness.chat.ensemble!.captainParticipantIds = ['captain-a', 'captain-b']
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Ask management to choose the route.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    stream(harness, 0, '@Management decide together before implementation.')
    complete(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('boss')
    complete(harness, 1)

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('captain-b')
    expect(
      harness.dispatched
        .slice(0, 3)
        .some((payload) => payload.ensembleRun?.participantId === 'worker')
    ).toBe(false)
    await expect(harness.orchestrator.cancelRound(CHAT_ID, 'test complete')).resolves.toBe(true)
  })

  it('keeps an ordinary assistant group tag presentation-only without fan-out authority', async () => {
    const roster = [
      participant('scout', 'codex', 1, { role: 'Scout', stageRole: 'scout' }),
      participant('reviewer', 'claude', 2, { role: 'Reviewer', stageRole: 'reviewer' }),
      participant('background-shell', 'kimi', 3, {
        role: 'Background',
        stageRole: 'background'
      })
    ]
    const harness = makeHarness({ participants: roster })
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Work through the roster.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    stream(harness, 0, '@BG skip ahead and run the checks now.')
    complete(harness, 0)

    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('reviewer')
    expect(
      harness.chat.messages.some((message) =>
        message.content.includes('@BG group routing requires Boss/Captain fan-out authority')
      )
    ).toBe(true)
    await expect(harness.orchestrator.cancelRound(CHAT_ID, 'test complete')).resolves.toBe(true)
  })

  // A directed absorb carries routing intent for one interjection. It must not
  // retroactively rewrite the round that is already running: the other seats
  // are live members of it, and dropping them from `participants` loses their
  // status pills, token tallies, working rows, and lane shimmer.
  it('keeps every seat on the live round when a directed steer lands', async () => {
    const roster = [
      participant('codex', 'codex', 1, { role: 'Worker' }),
      participant('claude', 'claude', 2, { role: 'Reviewer' }),
      participant('observer', 'kimi', 3, { role: 'Observer' })
    ]
    const harness = makeHarness({ participants: roster })
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Original round work.',
      event: { sender: {} as Electron.WebContents }
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const prompt = '@Reviewer try your slice again.'
    expect(
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt,
        dmTargetParticipantId: 'claude',
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      }).status
    ).toBe('queued')
    expect(
      harness.orchestrator.steerQueuedPrompt({
        chatId: CHAT_ID,
        index: 0,
        textPrefix: prompt,
        event: { sender: {} as Electron.WebContents }
      })
    ).toEqual({ status: 'steered', roundId: started.roundId })

    expect(
      harness.chat.ensemble?.activeRound?.participants.map((entry) => entry.participantId)
    ).toEqual(['codex', 'claude', 'observer'])
    expect(harness.chat.ensemble?.activeRound?.dmTargetParticipantId).toBeUndefined()
  })

  it('keeps a live round concurrent when a directed steer lands mid fan-out', async () => {
    const roster = [
      participant('codex', 'codex', 1, { role: 'Worker' }),
      participant('claude', 'claude', 2, { role: 'Reviewer' })
    ]
    const harness = makeHarness({ participants: roster })
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Original round work.',
      event: { sender: {} as Electron.WebContents },
      fanoutPolicy: 'read_only'
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched.length).toBeGreaterThan(0))
    expect(harness.chat.ensemble?.activeRound?.concurrentMode).toBe(true)

    const prompt = '@Reviewer try your slice again.'
    expect(
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt,
        dmTargetParticipantId: 'claude',
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      }).status
    ).toBe('queued')
    expect(
      harness.orchestrator.steerQueuedPrompt({
        chatId: CHAT_ID,
        index: 0,
        textPrefix: prompt,
        event: { sender: {} as Electron.WebContents }
      })
    ).toEqual({ status: 'steered', roundId: started.roundId })

    expect(harness.chat.ensemble?.activeRound?.concurrentMode).toBe(true)
    // On/Off collapse: the round's admitted policy reads as On ('all').
    expect(harness.chat.ensemble?.activeRound?.fanoutPolicy).toBe('all')
  })

  it('returns to the continuous panel after a message-local handoff to a settled fan-out seat', async () => {
    const roster = [
      participant('work-1', 'codex', 1, { role: 'Work1' }),
      participant('work-2', 'claude', 2, { role: 'Work2' })
    ]
    const harness = makeHarness({ participants: roster })
    harness.chat.ensemble!.orchestrationMode = 'continuous'
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Keep the panel running until the task is complete.',
      event: { sender: {} as Electron.WebContents }
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('work-1')

    expect(
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt: '@Work2 start the parallel review.',
        dmTargetParticipantId: 'work-2',
        event: { sender: {} as Electron.WebContents },
        mode: 'steer'
      })
    ).toEqual({ status: 'steered', roundId: started.roundId })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('work-2')

    expect(
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt: '@Work2 incorporate this late boundary correction too.',
        dmTargetParticipantId: 'work-2',
        event: { sender: {} as Electron.WebContents },
        mode: 'steer'
      })
    ).toEqual({ status: 'steered', roundId: started.roundId })
    expect(harness.dispatched).toHaveLength(2)

    stream(harness, 0, 'Work1 completed the original slice.')
    complete(harness, 0)
    await vi.waitFor(() =>
      expect(
        harness.chat.messages.some((message) =>
          message.content.includes('already running in a fan-out lane')
        )
      ).toBe(true)
    )
    stream(harness, 1, 'Work2 completed the first parallel review.')
    complete(harness, 1)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('work-2')
    expect(harness.dispatched[2].prompt).toContain(
      '@Work2 incorporate this late boundary correction too.'
    )

    stream(harness, 2, 'Work2 accepted the late correction.')
    complete(harness, 2)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    expect(harness.dispatched[3].ensembleRun?.participantId).toBe('work-1')
    expect(harness.chat.ensemble?.activeRound).toMatchObject({
      roundId: started.roundId,
      status: 'running'
    })
    expect(harness.chat.ensemble?.activeRound?.dmTargetParticipantId).toBeUndefined()

    await expect(
      harness.orchestrator.cancelRound(CHAT_ID, 'test complete', started.roundId)
    ).resolves.toBe(true)
  })

  it('preserves a rejected User Fan-Out target for its original serial turn', async () => {
    const harness = makeHarness({ rejectFirstParticipantDispatchIds: ['claude'] })
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Original round work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    const prompt = '@Reviewer handle this now.'
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt,
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    harness.orchestrator.steerQueuedPrompt({
      chatId: CHAT_ID,
      index: 0,
      textPrefix: prompt,
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('claude')
    expect(harness.accepted[1]).toBe(false)

    complete(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('claude')
    expect(harness.accepted[2]).toBe(true)
    expect(harness.cancelRun).not.toHaveBeenCalled()

    complete(harness, 2)
    await vi.waitFor(() => {
      expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
    })
  })

  it('keeps write-capable tags serial when the concurrent-write kill switch is off', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '0'
    try {
      const roster = [
        participant('codex', 'codex', 1, { role: 'Worker' }),
        participant('claude', 'claude', 2, { role: 'Reviewer' }),
        participant('observer', 'kimi', 3, {
          role: 'Scout',
          permissionPresetId: 'read_only'
        })
      ]
      const harness = makeHarness({ participants: roster })
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt: 'Original round work.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      const prompt = '@Reviewer inspect with your posture and @Scout gather read-only evidence.'
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      })
      harness.orchestrator.steerQueuedPrompt({
        chatId: CHAT_ID,
        index: 0,
        textPrefix: prompt,
        event: { sender: {} as Electron.WebContents }
      })

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      expect(harness.dispatched[1].ensembleRun?.participantId).toBe('observer')
      expect(harness.dispatched[1].effectivePermissions?.readOnly).toBe(true)
      expect(
        harness.chat.messages.some((message) =>
          message.content.includes(
            'queued 1 write-capable tagged seat(s) for the next serial boundary because TASKWRAITH_CONCURRENT_WRITE_LANES=0'
          )
        )
      ).toBe(true)

      complete(harness, 0)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      expect(harness.dispatched[2].ensembleRun?.participantId).toBe('claude')
      complete(harness, 2)
      complete(harness, 1)
      await vi.waitFor(() => {
        expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
      })
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      else process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previous
    }
  })

  it('serially dispatches a tagged write-capable Background seat when parallel writes are off', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '0'
    try {
      const roster = [
        participant('codex', 'codex', 1, { role: 'Worker' }),
        participant('grok-bg', 'grok', 2, {
          role: 'Background',
          stageRole: 'background'
        })
      ]
      const harness = makeHarness({ participants: roster })
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt: 'Original round work.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      const prompt = '@Background inspect this with your configured tools.'
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      })
      harness.orchestrator.steerQueuedPrompt({
        chatId: CHAT_ID,
        index: 0,
        textPrefix: prompt,
        event: { sender: {} as Electron.WebContents }
      })
      expect(harness.dispatched).toHaveLength(1)
      expect(
        harness.chat.ensemble?.activeRound?.participants.some(
          (entry) => entry.participantId === 'grok-bg'
        )
      ).toBe(true)

      complete(harness, 0)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      expect(harness.dispatched[1].ensembleRun?.participantId).toBe('grok-bg')
      expect(harness.dispatched[1].effectivePermissions?.presetId).toBe('workspace_write')
      expect(harness.dispatched[1].effectivePermissions?.readOnly).toBe(false)
      expect(
        harness.chat.messages.some((message) => message.content.startsWith('User Fan-Out ·'))
      ).toBe(false)

      complete(harness, 1)
      await vi.waitFor(() => {
        expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
      })
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      else process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previous
    }
  })

  it('resumes a gate-off Background serial target after an active read lane settles', async () => {
    const previous = process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
    process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = '0'
    try {
      const roster = [
        participant('codex', 'codex', 1, { role: 'Worker' }),
        participant('observer', 'kimi', 2, {
          role: 'Scout',
          stageRole: 'scout',
          permissionPresetId: 'read_only'
        }),
        participant('grok-bg', 'grok', 3, {
          role: 'Background',
          stageRole: 'background'
        })
      ]
      const harness = makeHarness({ participants: roster })
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt: 'Original round work.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      const scoutPrompt = '@Scout gather evidence now.'
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt: scoutPrompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      })
      harness.orchestrator.steerQueuedPrompt({
        chatId: CHAT_ID,
        index: 0,
        textPrefix: scoutPrompt,
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      expect(harness.dispatched[1].ensembleRun?.participantId).toBe('observer')

      complete(harness, 0)
      await vi.waitFor(() =>
        expect(
          harness.chat.messages.some((message) =>
            message.content.startsWith('Serial queue drained · holding the round open')
          )
        ).toBe(true)
      )

      const backgroundPrompt = '@Background inspect this with your configured tools.'
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt: backgroundPrompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'queue'
      })
      harness.orchestrator.steerQueuedPrompt({
        chatId: CHAT_ID,
        index: 0,
        textPrefix: backgroundPrompt,
        event: { sender: {} as Electron.WebContents }
      })
      expect(harness.dispatched).toHaveLength(2)

      complete(harness, 1)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      expect(harness.dispatched[2].ensembleRun?.participantId).toBe('grok-bg')
      expect(harness.dispatched[2].effectivePermissions?.presetId).toBe('workspace_write')
      expect(harness.dispatched[2].effectivePermissions?.readOnly).toBe(false)

      complete(harness, 2)
      await vi.waitFor(() => {
        expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
      })
      expect(harness.dispatched).toHaveLength(3)
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CONCURRENT_WRITE_LANES
      else process.env.TASKWRAITH_CONCURRENT_WRITE_LANES = previous
    }
  })

  it('does not duplicate a serial seat when User Fan-Out lands during seat compaction', async () => {
    let releaseCompaction!: () => void
    const compactionBarrier = new Promise<void>((resolve) => {
      releaseCompaction = resolve
    })
    const awaitPendingSeatCompaction = vi.fn((_chatId: string, participantId: string) =>
      participantId === 'claude' ? compactionBarrier : undefined
    )
    const harness = makeHarness({ awaitPendingSeatCompaction })
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Original round work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    complete(harness, 0)
    await vi.waitFor(() =>
      expect(awaitPendingSeatCompaction).toHaveBeenCalledWith(CHAT_ID, 'claude')
    )
    expect(harness.dispatched).toHaveLength(1)

    const prompt = '@Reviewer answer this interjection.'
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt,
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    harness.orchestrator.steerQueuedPrompt({
      chatId: CHAT_ID,
      index: 0,
      textPrefix: prompt,
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() =>
      expect(
        awaitPendingSeatCompaction.mock.calls.filter(
          ([, participantId]) => participantId === 'claude'
        )
      ).toHaveLength(2)
    )
    expect(
      harness.chat.messages.some((message) => message.content.startsWith('User Fan-Out ·'))
    ).toBe(false)

    releaseCompaction()
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('claude')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.dispatched).toHaveLength(2)

    complete(harness, 1)
    await vi.waitFor(() => {
      expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
    })
  })

  it('carries the exact User Fan-Out source id across compaction with identical steers', async () => {
    let releaseCompaction!: () => void
    const compactionBarrier = new Promise<void>((resolve) => {
      releaseCompaction = resolve
    })
    const awaitPendingSeatCompaction = vi.fn((_chatId: string, participantId: string) =>
      participantId === 'claude' ? compactionBarrier : undefined
    )
    const harness = makeHarness({ awaitPendingSeatCompaction })
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Original round work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    complete(harness, 0)
    await vi.waitFor(() =>
      expect(awaitPendingSeatCompaction).toHaveBeenCalledWith(CHAT_ID, 'claude')
    )

    const prompt = '@Reviewer answer this identical interjection.'
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt,
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    expect(
      harness.orchestrator.steerQueuedPrompt({
        chatId: CHAT_ID,
        index: 0,
        textPrefix: prompt,
        event: { sender: {} as Electron.WebContents }
      })
    ).toEqual({ status: 'steered', roundId: started.roundId })
    await vi.waitFor(() =>
      expect(
        awaitPendingSeatCompaction.mock.calls.filter(
          ([, participantId]) => participantId === 'claude'
        )
      ).toHaveLength(2)
    )

    expect(
      harness.orchestrator.absorbMidRunSteering({
        chatId: CHAT_ID,
        roundId: started.roundId!,
        text: prompt
      })
    ).toEqual({ status: 'steered', roundId: started.roundId })

    releaseCompaction()
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.promptEvidence[1]?.suppliedMessageIds).toContain('steer-message-2')
    expect(harness.promptEvidence[1]?.suppliedMessageIds.at(-1)).toBe('steer-message-1')

    complete(harness, 1)
    await vi.waitFor(() => {
      expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
    })
  })

  it('does not persist a dispatched User Fan-Out receipt when cancellation wins compaction', async () => {
    let releaseCompaction!: () => void
    const compactionBarrier = new Promise<void>((resolve) => {
      releaseCompaction = resolve
    })
    const awaitPendingSeatCompaction = vi.fn((_chatId: string, participantId: string) =>
      participantId === 'claude' ? compactionBarrier : undefined
    )
    const harness = makeHarness({ awaitPendingSeatCompaction })
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Original round work.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

    complete(harness, 0)
    await vi.waitFor(() =>
      expect(awaitPendingSeatCompaction).toHaveBeenCalledWith(CHAT_ID, 'claude')
    )
    const prompt = '@Reviewer answer this interjection.'
    harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt,
      event: { sender: {} as Electron.WebContents },
      mode: 'queue'
    })
    harness.orchestrator.steerQueuedPrompt({
      chatId: CHAT_ID,
      index: 0,
      textPrefix: prompt,
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() =>
      expect(
        awaitPendingSeatCompaction.mock.calls.filter(
          ([, participantId]) => participantId === 'claude'
        )
      ).toHaveLength(2)
    )

    await expect(
      harness.orchestrator.cancelRound(CHAT_ID, 'user stopped', started.roundId)
    ).resolves.toBe(true)
    releaseCompaction()
    await vi.waitFor(() => {
      expect(harness.chat.ensemble?.activeRound?.status).toBe('cancelled')
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.dispatched).toHaveLength(1)
    expect(
      harness.chat.messages.some((message) => message.content.startsWith('User Fan-Out ·'))
    ).toBe(false)
  })
})
