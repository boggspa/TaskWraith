import { describe, expect, it, vi } from 'vitest'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'
import type { WorkspaceChurnSample } from '../WorkspaceChurn'
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
    dispatched,
    getPendingMidRunSteeringEntryIds,
    orchestrator,
    promptEvidence
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

  it('adds an immediate User Fan-Out for idle tags without interrupting the active speaker', async () => {
    const roster = [
      participant('codex', 'codex', 1, { role: 'Worker', stageRole: 'worker' }),
      participant('claude', 'claude', 2, { role: 'Reviewer', stageRole: 'reviewer' }),
      participant('observer', 'kimi', 3, { role: 'Observer', stageRole: 'scout' }),
      participant('grok-bg', 'grok', 4, { role: 'Background', stageRole: 'background' })
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
    expect(harness.cancelRun).not.toHaveBeenCalled()
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

    const prompt = '@Reviewer try your slice again.'
    expect(
      harness.orchestrator.startRound({
        chatId: CHAT_ID,
        prompt,
        event: { sender: {} as Electron.WebContents },
        mode: 'steer'
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

  // A directed absorb carries routing intent for the seats still to speak. It
  // must not retroactively rewrite the round that is already running: the other
  // seats are live members of it, and dropping them from `participants` loses
  // their status pills, their token tallies, and every working row and lane
  // shimmer derived from the round projection.
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
    expect(harness.chat.ensemble?.activeRound?.dmTargetParticipantId).toBe('claude')
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
    expect(harness.chat.ensemble?.activeRound?.fanoutPolicy).toBe('read_only')
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
