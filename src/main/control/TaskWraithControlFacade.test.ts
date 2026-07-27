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
})
