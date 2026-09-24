import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { EnsembleOrchestrator } from '../services/EnsembleOrchestrator'
import type { PdfAttachmentLike } from '../services/PdfAttachmentRenderService'
import type { ChatRecord, EnsembleRoundState } from '../store/types'
import {
  handleRunEnsembleRound,
  type EnsembleRoundHandlerDeps,
  type RunEnsembleRoundPayload
} from './ensembleRoundHandlers'

type OrchestratorStub = Pick<EnsembleOrchestrator, 'absorbMidRunSteering' | 'startRound'>

interface Harness {
  deps: EnsembleRoundHandlerDeps
  event: IpcMainInvokeEvent
  startRound: Mock<OrchestratorStub['startRound']>
  absorbMidRunSteering: Mock<OrchestratorStub['absorbMidRunSteering']>
  getChat: Mock<EnsembleRoundHandlerDeps['getChat']>
  awaitChatRecordPersisted: Mock<EnsembleRoundHandlerDeps['awaitChatRecordPersisted']>
  setOrchestrator: (orchestrator: OrchestratorStub | null) => void
  setEnsembleModeEnabled: (enabled: boolean) => void
}

function makeChat(activeRound?: EnsembleRoundState): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Ensemble test',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 5,
      participants: [],
      activeRound
    }
  }
}

function makeHarness(): Harness {
  const startRound = vi.fn<OrchestratorStub['startRound']>()
  const absorbMidRunSteering = vi.fn<OrchestratorStub['absorbMidRunSteering']>()
  let orchestrator: OrchestratorStub | null = { absorbMidRunSteering, startRound }
  let ensembleModeEnabled = true
  const getChat = vi.fn<EnsembleRoundHandlerDeps['getChat']>().mockReturnValue(makeChat())
  const awaitChatRecordPersisted = vi
    .fn<EnsembleRoundHandlerDeps['awaitChatRecordPersisted']>()
    .mockResolvedValue(undefined)
  const deps: EnsembleRoundHandlerDeps = {
    getEnsembleOrchestrator: () => orchestrator,
    isEnsembleModeEnabled: () => ensembleModeEnabled,
    getChat,
    awaitChatRecordPersisted,
    requireNonEmptyString: (value, label) => {
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${label} is required.`)
      }
      return value
    },
    assertSenderChatScope: () => {},
    assertScheduledEnsembleInteractiveAvailable: () => {},
    imageAttachmentSnapshots: () => [],
    resolveRendererAttachmentPaths: () => [],
    expandPdfAttachmentsForDispatch: async <T extends PdfAttachmentLike>(attachments: T[]) =>
      attachments,
    normalizeExternalPathGrants: () => [],
    ensembleRoundLiveForSteerAbsorb: () => false
  }
  return {
    deps,
    event: { sender: {} } as IpcMainInvokeEvent,
    startRound,
    absorbMidRunSteering,
    getChat,
    awaitChatRecordPersisted,
    setOrchestrator: (next) => {
      orchestrator = next
    },
    setEnsembleModeEnabled: (enabled) => {
      ensembleModeEnabled = enabled
    }
  }
}

function payload(overrides: RunEnsembleRoundPayload = {}): RunEnsembleRoundPayload {
  return { chatId: 'chat-1', prompt: 'hello', ...overrides }
}

describe('handleRunEnsembleRound payload guards', () => {
  it('throws when Ensemble Mode is disabled before touching dispatch', async () => {
    const harness = makeHarness()
    harness.setEnsembleModeEnabled(false)
    await expect(handleRunEnsembleRound(harness.deps, harness.event, payload())).rejects.toThrow(
      'Ensemble Mode is disabled.'
    )
    expect(harness.getChat).not.toHaveBeenCalled()
    expect(harness.startRound).not.toHaveBeenCalled()
  })

  it('rejects renderer scheduled-round dispatch', async () => {
    const harness = makeHarness()
    await expect(
      handleRunEnsembleRound(harness.deps, harness.event, payload({ scheduledTaskId: 'task-1' }))
    ).rejects.toThrow('Renderer scheduled-round dispatch is retired; MAIN owns every occurrence.')
    expect(harness.startRound).not.toHaveBeenCalled()
  })

  it('rejects an invalid project reference selection', async () => {
    const harness = makeHarness()
    await expect(
      handleRunEnsembleRound(
        harness.deps,
        harness.event,
        payload({ projectReferenceContextSelection: 'nope' })
      )
    ).rejects.toThrow('Project reference context selection is invalid.')
    expect(harness.startRound).not.toHaveBeenCalled()
  })

  it('requires a prompt, attachment, or reference selection', async () => {
    const harness = makeHarness()
    await expect(
      handleRunEnsembleRound(harness.deps, harness.event, { chatId: 'chat-1' })
    ).rejects.toThrow('Ensemble prompt, attachment, or Project reference selection is required.')
    expect(harness.startRound).not.toHaveBeenCalled()
  })
})

describe('handleRunEnsembleRound delegation', () => {
  it('absorbs live steering and persists it before returning without starting a round', async () => {
    const harness = makeHarness()
    const round: EnsembleRoundState = {
      roundId: 'round-live',
      status: 'running',
      prompt: 'original',
      startedAt: '2026-09-05T00:00:00.000Z',
      participants: []
    }
    harness.getChat.mockReturnValue(makeChat(round))
    harness.deps.ensembleRoundLiveForSteerAbsorb = vi.fn(() => true)
    harness.absorbMidRunSteering.mockReturnValue({ status: 'steered', roundId: round.roundId })
    harness.awaitChatRecordPersisted.mockImplementation(async () => {
      expect(harness.absorbMidRunSteering).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'chat-1', roundId: round.roundId, text: 'hello' })
      )
      throw new Error('persistence unavailable')
    })
    await expect(
      handleRunEnsembleRound(harness.deps, harness.event, payload({ mode: 'steer' }))
    ).rejects.toThrow('persistence unavailable')
    expect(harness.deps.ensembleRoundLiveForSteerAbsorb).toHaveBeenCalledWith('chat-1', round)
    expect(harness.awaitChatRecordPersisted).toHaveBeenCalledWith('chat-1')
    expect(harness.startRound).not.toHaveBeenCalled()
  })

  it('starts the round and awaits the durability barrier on started status', async () => {
    const harness = makeHarness()
    const started = { status: 'started' } as ReturnType<OrchestratorStub['startRound']>
    harness.startRound.mockReturnValue(started)
    const result = await handleRunEnsembleRound(harness.deps, harness.event, payload())
    expect(result).toBe(started)
    expect(harness.startRound).toHaveBeenCalledTimes(1)
    expect(harness.startRound).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', prompt: 'hello', mode: 'normal' })
    )
    expect(harness.awaitChatRecordPersisted).toHaveBeenCalledWith('chat-1')
    expect(harness.absorbMidRunSteering).not.toHaveBeenCalled()
  })

  it('refuses a round when the roster was projected away, instead of a TypeError', async () => {
    const harness = makeHarness()
    // A catalogue projection drops `ensemble.participants` once the chrome
    // budget is spent. It is declared required, so only a runtime guard helps.
    const rosterless = makeChat()
    delete (rosterless.ensemble as { participants?: unknown }).participants
    harness.getChat.mockReturnValue(rosterless)
    await expect(handleRunEnsembleRound(harness.deps, harness.event, payload())).rejects.toThrow(
      'Ensemble roster is unavailable; reopen the thread and retry.'
    )
    expect(harness.startRound).not.toHaveBeenCalled()
  })

  it('still dispatches when the roster is legitimately empty', async () => {
    const harness = makeHarness()
    harness.startRound.mockReturnValue({ status: 'started' } as ReturnType<
      OrchestratorStub['startRound']
    >)
    await handleRunEnsembleRound(harness.deps, harness.event, payload())
    expect(harness.startRound).toHaveBeenCalledTimes(1)
  })

  it('returns undefined without a barrier when the orchestrator is missing', async () => {
    const harness = makeHarness()
    harness.setOrchestrator(null)
    const result = await handleRunEnsembleRound(harness.deps, harness.event, payload())
    expect(result).toBeUndefined()
    expect(harness.awaitChatRecordPersisted).not.toHaveBeenCalled()
  })

  it('reads the orchestrator on every invocation, not once', async () => {
    const harness = makeHarness()
    const first = { status: 'started' } as ReturnType<OrchestratorStub['startRound']>
    harness.startRound.mockReturnValue(first)
    await handleRunEnsembleRound(harness.deps, harness.event, payload())
    expect(harness.startRound).toHaveBeenCalledTimes(1)
    const secondStartRound = vi.fn<OrchestratorStub['startRound']>()
    const second = { status: 'queued' } as ReturnType<OrchestratorStub['startRound']>
    secondStartRound.mockReturnValue(second)
    harness.setOrchestrator({
      absorbMidRunSteering: harness.absorbMidRunSteering,
      startRound: secondStartRound
    })
    const result = await handleRunEnsembleRound(harness.deps, harness.event, payload())
    expect(result).toBe(second)
    expect(harness.startRound).toHaveBeenCalledTimes(1)
    expect(secondStartRound).toHaveBeenCalledTimes(1)
  })
})
