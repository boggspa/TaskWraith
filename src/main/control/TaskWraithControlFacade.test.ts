import fs from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStore } from '../store'
import type { ChatRecord } from '../store/types'
import { setRemoteEnsemblePresetsFromRaw } from '../remote/EnsembleRosterPresetsCache'
import { createTaskWraithControlFacade } from './TaskWraithControlFacade'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-control-facade-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

describe('TaskWraithControlFacade mutation routing', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
    setRemoteEnsemblePresetsFromRaw([])
  })

  it('uses the solo composer executor for a canonical solo chat', async () => {
    const workspace = AppStore.addOrUpdateWorkspace('/repo', {
      id: 'workspace-1',
      displayName: 'Repo'
    })
    const chat: ChatRecord = {
      ...AppStore.createChat(workspace.id, workspace.path),
      provider: 'claude',
      title: 'Solo'
    }
    AppStore.saveChat(chat)
    const executeComposerPrompt = vi.fn(async () => ({
      executed: true,
      message: 'solo dispatched'
    }))
    const executeEnsembleSteer = vi.fn()
    const facade = createTaskWraithControlFacade({
      executeComposerPrompt,
      executeCancelRun: vi.fn(),
      executeEnsembleSteer,
      executeEnsembleCancelRound: vi.fn(),
      executeEnsembleRosterUpdate: vi.fn(),
      now: () => 10_000
    })

    await expect(facade.sendPrompt(chat.appChatId, '  hello  ')).resolves.toEqual({
      dispatched: true,
      message: 'solo dispatched'
    })
    expect(executeComposerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'composerPrompt',
        workspaceId: workspace.id,
        threadId: chat.appChatId,
        provider: 'claude',
        text: 'hello'
      })
    )
    expect(executeEnsembleSteer).not.toHaveBeenCalled()
  })

  it('starts or steers an ensemble through the orchestrator action, never the solo path', async () => {
    const workspace = AppStore.addOrUpdateWorkspace('/ensemble-repo', {
      id: 'workspace-ensemble',
      displayName: 'Ensemble Repo'
    })
    const created = AppStore.createEnsembleChat({
      workspaceId: workspace.id,
      workspacePath: workspace.path
    })
    const first = created.ensemble!.participants[0]!
    const chat: ChatRecord = {
      ...created,
      ensemble: {
        ...created.ensemble!,
        activeRosterPresetId: 'build-review',
        activeRound: {
          roundId: 'round-1',
          status: 'running',
          prompt: 'before',
          startedAt: new Date(0).toISOString(),
          activeParticipantId: first.id,
          participants: created.ensemble!.participants.map((participant, index) => ({
            participantId: participant.id,
            provider: participant.provider,
            role: participant.role,
            order: participant.order,
            status: index === 0 ? 'running' : 'idle'
          }))
        }
      }
    }
    setRemoteEnsemblePresetsFromRaw([
      {
        id: 'build-review',
        name: 'Build + Review',
        participants: []
      }
    ])
    AppStore.saveChat(chat)
    const executeComposerPrompt = vi.fn()
    const executeEnsembleSteer = vi.fn(async () => ({
      executed: true,
      message: 'ensemble steered'
    }))
    const executeEnsembleCancelRound = vi.fn(async () => ({
      executed: true,
      message: 'ensemble cancelled'
    }))
    const facade = createTaskWraithControlFacade({
      executeComposerPrompt,
      executeCancelRun: vi.fn(),
      executeEnsembleSteer,
      executeEnsembleCancelRound,
      executeEnsembleRosterUpdate: vi.fn(),
      now: () => 20_000
    })

    expect(facade.selectThread(chat.appChatId, 80).thread.ensemble?.preset).toBe('Build + Review')
    await expect(facade.sendPrompt(chat.appChatId, 'direct @Lead')).resolves.toEqual({
      dispatched: true,
      message: 'ensemble steered'
    })
    expect(executeEnsembleSteer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ensembleSteer',
        workspaceId: workspace.id,
        threadId: chat.appChatId,
        roundId: 'round-1',
        text: 'direct @Lead'
      })
    )
    expect(executeComposerPrompt).not.toHaveBeenCalled()

    await expect(facade.cancelRun(chat.appChatId)).resolves.toEqual({
      cancelled: true,
      message: 'ensemble cancelled'
    })
    expect(executeEnsembleCancelRound).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ensembleCancelRound',
        threadId: chat.appChatId,
        roundId: 'round-1'
      })
    )
  })

  it('projects curated model offers and only dispatches a selection it offered', async () => {
    const workspace = AppStore.addOrUpdateWorkspace('/offers-repo', {
      id: 'workspace-offers',
      displayName: 'Offers Repo'
    })
    const chat: ChatRecord = {
      ...AppStore.createChat(workspace.id, workspace.path),
      provider: 'claude',
      title: 'Offers',
      requestedModel: 'claude-opus-5',
      providerMetadata: { claudeReasoningEffort: 'high' }
    }
    AppStore.saveChat(chat)
    const executeComposerPrompt = vi.fn(async () => ({
      executed: true,
      message: 'solo dispatched'
    }))
    const facade = createTaskWraithControlFacade({
      executeComposerPrompt,
      executeCancelRun: vi.fn(),
      executeEnsembleSteer: vi.fn(),
      executeEnsembleCancelRound: vi.fn(),
      executeEnsembleRosterUpdate: vi.fn(),
      now: () => 30_000
    })

    const offers = facade.threadOffers(chat.appChatId)
    expect(offers.locked).toBeUndefined()
    expect(offers.source).toBe('curated')
    expect(offers.currentModel).toBe('claude-opus-5')
    expect(offers.currentReasoningEffort).toBe('high')
    const current = offers.models.find((model) => model.current)
    expect(current?.id).toBe('claude-opus-5')
    const alternative = offers.models.find((model) => !model.current && !model.disabled)
    expect(alternative).toBeDefined()
    const effort = alternative!.reasoningEfforts.find((candidate) => !candidate.disabled)
    expect(effort).toBeDefined()

    await expect(
      facade.sendPrompt(chat.appChatId, 'tuned send', {
        model: alternative!.id,
        reasoningEffort: effort!.id
      })
    ).resolves.toEqual({ dispatched: true, message: 'solo dispatched' })
    const action = (
      executeComposerPrompt.mock.calls.at(-1) as unknown[] | undefined
    )?.[0] as Record<string, unknown>
    expect(action.model).toBe(alternative!.id)
    // Claude rides its dedicated effort field on the wire (iOS parity).
    expect(action.claudeReasoningEffort).toBe(effort!.id)
    expect(action.reasoningEffort).toBeUndefined()

    await expect(
      facade.sendPrompt(chat.appChatId, 'bad send', { model: 'gpt-5.6-sol' })
    ).rejects.toThrow('That model is not offered for this thread.')
    await expect(
      facade.sendPrompt(chat.appChatId, 'bad effort', {
        model: alternative!.id,
        reasoningEffort: 'not-a-real-effort'
      })
    ).rejects.toThrow('That reasoning effort is not offered for the selected model.')
  })

  it('keeps an off-catalogue current model selectable and locks non-switchable threads', async () => {
    const workspace = AppStore.addOrUpdateWorkspace('/locked-repo', {
      id: 'workspace-locked',
      displayName: 'Locked Repo'
    })
    const offCatalogue: ChatRecord = {
      ...AppStore.createChat(workspace.id, workspace.path),
      provider: 'claude',
      title: 'Custom model',
      requestedModel: 'claude-experimental-nightly'
    }
    AppStore.saveChat(offCatalogue)
    const ollamaChat: ChatRecord = {
      ...AppStore.createChat(workspace.id, workspace.path),
      provider: 'ollama',
      title: 'Local models'
    }
    AppStore.saveChat(ollamaChat)
    const facade = createTaskWraithControlFacade({
      executeComposerPrompt: vi.fn(),
      executeCancelRun: vi.fn(),
      executeEnsembleSteer: vi.fn(),
      executeEnsembleCancelRound: vi.fn(),
      executeEnsembleRosterUpdate: vi.fn(),
      now: () => 40_000
    })

    const offCatalogueOffers = facade.threadOffers(offCatalogue.appChatId)
    expect(offCatalogueOffers.models[0]).toMatchObject({
      id: 'claude-experimental-nightly',
      current: true
    })

    const lockedOffers = facade.threadOffers(ollamaChat.appChatId)
    expect(lockedOffers.locked).toContain('Ollama')
    expect(lockedOffers.models).toHaveLength(0)
  })

  it('flips exactly one seat through the canonical roster action and honours the floor', async () => {
    const workspace = AppStore.addOrUpdateWorkspace('/seats-repo', {
      id: 'workspace-seats',
      displayName: 'Seats Repo'
    })
    const created = AppStore.createEnsembleChat({
      workspaceId: workspace.id,
      workspacePath: workspace.path
    })
    AppStore.saveChat(created)
    const participants = created.ensemble!.participants
    expect(participants.length).toBeGreaterThanOrEqual(2)
    const [first, second] = participants
    const executeEnsembleRosterUpdate = vi.fn(async () => ({
      executed: true,
      message: 'Roster updated'
    }))
    const facade = createTaskWraithControlFacade({
      executeComposerPrompt: vi.fn(),
      executeCancelRun: vi.fn(),
      executeEnsembleSteer: vi.fn(),
      executeEnsembleCancelRound: vi.fn(),
      executeEnsembleRosterUpdate,
      now: () => 50_000
    })

    // Ensemble threads never expose the model picker.
    expect(facade.threadOffers(created.appChatId).locked).toContain('Ensemble')
    await expect(
      facade.sendPrompt(created.appChatId, 'steer', { model: 'claude-opus-5' })
    ).rejects.toThrow('Model switching from the terminal is solo-thread only.')

    await expect(facade.toggleEnsembleSeat(created.appChatId, second!.id, false)).resolves.toEqual({
      updated: true,
      message: 'Roster updated'
    })
    const action = (
      executeEnsembleRosterUpdate.mock.calls.at(-1) as unknown[] | undefined
    )?.[0] as {
      kind: string
      participants: Array<{ id?: string; provider: string; enabled?: boolean }>
    }
    expect(action.kind).toBe('ensembleRosterUpdate')
    // The FULL canonical roster rides along in speaking order — an omitted
    // entry would delete that seat — with only the target flag flipped.
    expect(action.participants).toEqual(
      [...participants]
        .sort((left, right) => left.order - right.order)
        .map((participant) => ({
          id: participant.id,
          provider: participant.provider,
          enabled: participant.id === second!.id ? false : participant.enabled
        }))
    )

    await expect(facade.toggleEnsembleSeat(created.appChatId, second!.id, true)).resolves.toEqual({
      updated: false,
      message: 'Seat is already enabled.'
    })
    await expect(facade.toggleEnsembleSeat(created.appChatId, 'ghost-seat', true)).rejects.toThrow(
      'That seat no longer exists.'
    )

    const lastEnabled: ChatRecord = {
      ...created,
      ensemble: {
        ...created.ensemble!,
        participants: participants.map((participant, index) => ({
          ...participant,
          enabled: index === 0
        }))
      }
    }
    AppStore.saveChat(lastEnabled)
    await expect(facade.toggleEnsembleSeat(created.appChatId, first!.id, false)).rejects.toThrow(
      'At least one participant must stay enabled.'
    )
    // Disabled seats stay in the projection so the seat lens can re-enable them.
    const summary = facade.selectThread(created.appChatId, 10).thread.ensemble
    expect(summary?.participants.some((participant) => !participant.enabled)).toBe(true)
  })
})
