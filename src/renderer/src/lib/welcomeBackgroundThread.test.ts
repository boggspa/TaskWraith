import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord, EnsembleConfig } from '../../../main/store/types'
import type { QueuedRunRequest } from './runRequestTypes'
import {
  cloneWelcomeBackgroundChat,
  launchWelcomeBackgroundThread,
  shouldStartWelcomeThreadInBackground
} from './welcomeBackgroundThread'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'source',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: 'New Chat',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    workflowMode: 'normal',
    messages: [],
    runs: [],
    ...overrides
  }
}

describe('shouldStartWelcomeThreadInBackground', () => {
  const input = {
    isWelcomeChat: true,
    isWorkflowChatWelcome: false,
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false
  }

  it('accepts Command+Return and Ctrl+Return on an ordinary welcome composer', () => {
    expect(shouldStartWelcomeThreadInBackground(input)).toBe(true)
    expect(shouldStartWelcomeThreadInBackground({ ...input, metaKey: false, ctrlKey: true })).toBe(
      true
    )
  })

  it('leaves normal, workflow, shifted, alternate, and IME submits alone', () => {
    expect(shouldStartWelcomeThreadInBackground({ ...input, metaKey: false })).toBe(false)
    expect(shouldStartWelcomeThreadInBackground({ ...input, isWelcomeChat: false })).toBe(false)
    expect(shouldStartWelcomeThreadInBackground({ ...input, isWorkflowChatWelcome: true })).toBe(
      false
    )
    expect(shouldStartWelcomeThreadInBackground({ ...input, shiftKey: true })).toBe(false)
    expect(shouldStartWelcomeThreadInBackground({ ...input, altKey: true })).toBe(false)
    expect(shouldStartWelcomeThreadInBackground({ ...input, isComposing: true })).toBe(false)
  })
})

describe('cloneWelcomeBackgroundChat', () => {
  it('copies solo starting choices without copying continuity or unrelated metadata', () => {
    const source = chat({
      provider: 'claude',
      linkedProviderSessionId: 'session-source',
      activeGoal: {
        id: 'goal-source',
        objective: 'Do the work',
        status: 'active',
        mode: 'claude_native',
        provider: 'claude',
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z'
      },
      providerMetadata: {
        selectedModelType: 'claude-sonnet-5',
        claudeReasoningEffort: 'high',
        claudeFastMode: true,
        approvalMode: 'auto_edit',
        permissionPresetId: 'workspace_write',
        runtimeProfileId: 'profile-1',
        externalPathGrants: [{ path: '/elsewhere' }],
        arbitraryRuntimeReceipt: 'do-not-copy'
      }
    })
    const fresh = chat({
      appChatId: 'fresh',
      provider: 'gemini',
      createdAt: 10,
      updatedAt: 10
    })

    const cloned = cloneWelcomeBackgroundChat(source, fresh, 20)

    expect(cloned.appChatId).toBe('fresh')
    expect(cloned.createdAt).toBe(10)
    expect(cloned.updatedAt).toBe(20)
    expect(cloned.provider).toBe('claude')
    expect(cloned.providerMetadata).toEqual({
      selectedModelType: 'claude-sonnet-5',
      claudeReasoningEffort: 'high',
      claudeFastMode: true,
      approvalMode: 'auto_edit',
      permissionPresetId: 'workspace_write',
      runtimeProfileId: 'profile-1'
    })
    expect(cloned.linkedProviderSessionId).toBeUndefined()
    expect(cloned.activeGoal).toBeUndefined()
    expect(cloned.messages).toEqual([])
    expect(cloned.runs).toEqual([])
  })

  it('copies an ensemble roster while resetting every run and session field', () => {
    const ensemble: EnsembleConfig = {
      enabled: true,
      maxParticipants: 4,
      orchestrationMode: 'continuous',
      fanoutPolicy: 'read_only',
      participants: [
        {
          id: 'boss',
          provider: 'codex',
          enabled: true,
          role: 'Boss',
          instructions: 'Lead',
          order: 0,
          model: 'gpt-5.6-sol',
          linkedProviderSessionId: 'provider-thread',
          taskWraithMcpProfileReceipt: {
            schemaVersion: 1,
            profileId: 'taskwraith-full-v2',
            provider: 'codex',
            providerSessionId: 'provider-thread',
            pinnedAt: '2026-08-27T00:00:00.000Z'
          },
          promptShellVersion: 'shell-v1',
          promptDynamicStateVersion: 'dynamic-v1',
          tokenTotals: { total_tokens: 123 },
          permissionOverrides: {
            approvalMode: 'default',
            externalPathGrants: [
              {
                id: 'grant-1',
                provider: 'codex',
                path: '/elsewhere',
                access: 'read_write',
                duration: 'thisRun',
                createdAt: '2026-08-27T00:00:00.000Z'
              }
            ]
          }
        }
      ],
      activeRound: {
        roundId: 'round-1',
        status: 'running',
        prompt: 'Old prompt',
        startedAt: '2026-08-27T00:00:00.000Z',
        participants: []
      },
      bossmanControlState: { completedRoundCount: 3 },
      sessionActivityLedger: [],
      lastRoundSummary: 'Old summary',
      roundSummaries: {},
      wakeups: {},
      blackboard: [],
      escalationSignals: [],
      updatedAt: '2026-08-27T00:00:00.000Z'
    }
    const source = chat({
      chatKind: 'ensemble',
      title: 'New Ensemble',
      ensemble
    })
    const fresh = chat({
      appChatId: 'fresh',
      chatKind: 'ensemble',
      title: 'New Ensemble',
      ensemble: { enabled: true, maxParticipants: 4, participants: [] }
    })

    const cloned = cloneWelcomeBackgroundChat(source, fresh, Date.parse('2026-08-27T01:00:00Z'))

    expect(cloned.ensemble?.orchestrationMode).toBe('continuous')
    expect(cloned.ensemble?.fanoutPolicy).toBe('read_only')
    expect(cloned.ensemble?.participants[0]).toMatchObject({
      id: 'boss',
      model: 'gpt-5.6-sol',
      linkedProviderSessionId: null,
      permissionOverrides: { approvalMode: 'default' }
    })
    expect(cloned.ensemble?.participants[0].taskWraithMcpProfileReceipt).toBeUndefined()
    expect(cloned.ensemble?.participants[0].promptShellVersion).toBeUndefined()
    expect(cloned.ensemble?.participants[0].tokenTotals).toBeUndefined()
    expect(cloned.ensemble?.activeRound).toBeUndefined()
    expect(cloned.ensemble?.bossmanControlState).toBeUndefined()
    expect(cloned.ensemble?.lastRoundSummary).toBeUndefined()
    expect(cloned.ensemble?.wakeups).toBeUndefined()
    expect(cloned.ensemble?.updatedAt).toBe('2026-08-27T01:00:00.000Z')
  })

  it('rejects mismatched factories and non-pristine sources', () => {
    expect(() =>
      cloneWelcomeBackgroundChat(chat(), chat({ chatKind: 'ensemble', ensemble: undefined }))
    ).toThrow('wrong chat kind')
    expect(() =>
      cloneWelcomeBackgroundChat(
        chat({ messages: [{ id: 'm1', role: 'user', content: 'Started', timestamp: 'now' }] }),
        chat({ appChatId: 'fresh' })
      )
    ).toThrow('pristine welcome chat')
  })
})

describe('launchWelcomeBackgroundThread', () => {
  function request(source: ChatRecord): QueuedRunRequest {
    return {
      appRunId: 'source-run',
      scope: 'workspace',
      provider: 'codex',
      prompt: 'Do the work',
      selectedModelType: 'gpt-5.6-sol',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: [],
      externalPathGrants: [
        {
          id: 'source-grant',
          provider: 'codex',
          path: '/elsewhere',
          access: 'read_write',
          duration: 'thisRun',
          createdAt: '2026-08-27T00:00:00.000Z'
        }
      ],
      workspaceRecord: {
        id: 'workspace-1',
        path: '/repo',
        displayName: 'Repo',
        pinned: false,
        createdAt: 1,
        lastOpenedAt: 1
      },
      chatRecord: source
    }
  }

  it('persists and queues an independent project-member chat without navigating', async () => {
    const source = chat({ providerMetadata: { selectedModelType: 'gpt-5.6-sol' } })
    const fresh = chat({ appChatId: 'background', provider: 'gemini' })
    const saved = { ...fresh, provider: 'codex', persistenceRevision: 2 }
    const recordChat = vi.fn()
    const addChatToProject = vi.fn()
    const queueRun = vi.fn()
    const executeRun = vi.fn()
    const clearDraft = vi.fn()
    const clearSubmittedContext = vi.fn()
    const reapAbandonedChats = vi.fn()

    const result = await launchWelcomeBackgroundThread(
      {
        target: {
          chat: source,
          prompt: 'Do the work',
          sessionTrust: false,
          imageAttachments: [],
          discordContextSelection: null
        },
        request: request(source),
        scheduledRunAt: '2026-08-28T12:00:00.000Z'
      },
      {
        createWorkspaceChat: vi.fn(async () => fresh),
        createGlobalChat: vi.fn(async () => chat({ appChatId: 'global' })),
        createEnsembleChat: vi.fn(async () => chat({ appChatId: 'ensemble' })),
        saveChat: vi.fn(async () => saved),
        recordChat,
        projectIdsForChat: vi.fn(() => ['project-1']),
        addChatToProject,
        createRunId: () => 'background-run',
        queueRun,
        executeRun,
        currentDraft: () => 'Do the work',
        clearDraft,
        clearSubmittedContext,
        reapAbandonedChats,
        formatScheduledRunTime: () => 'tomorrow at noon'
      }
    )

    expect(result).toBe(saved)
    expect(recordChat).toHaveBeenCalledWith(saved)
    expect(addChatToProject).toHaveBeenCalledWith('project-1', 'background')
    expect(queueRun).toHaveBeenCalledTimes(1)
    expect(executeRun).not.toHaveBeenCalled()
    expect(queueRun.mock.calls[0][0]).toMatchObject({
      appRunId: 'background-run',
      chatRecord: saved,
      scheduledRunAt: '2026-08-28T12:00:00.000Z',
      externalPathGrants: []
    })
    expect(queueRun.mock.calls[0][1]).toBe('Scheduled for tomorrow at noon.')
    expect(clearDraft).toHaveBeenCalledWith('source')
    expect(clearSubmittedContext).toHaveBeenCalledWith(expect.any(Object), 'source')
    expect(reapAbandonedChats).toHaveBeenCalledWith('background')
  })

  it('dispatches immediately and preserves a draft edited during chat creation', async () => {
    const source = chat({ scope: 'global', workspaceId: undefined, workspacePath: undefined })
    const fresh = chat({
      appChatId: 'background-global',
      scope: 'global',
      workspaceId: undefined,
      workspacePath: undefined
    })
    const executeRun = vi.fn()
    const clearDraft = vi.fn()

    await launchWelcomeBackgroundThread(
      {
        target: {
          chat: source,
          prompt: 'First prompt',
          sessionTrust: false,
          imageAttachments: [],
          discordContextSelection: null
        },
        request: { ...request(source), scope: 'global', prompt: 'First prompt' }
      },
      {
        createWorkspaceChat: vi.fn(async () => fresh),
        createGlobalChat: vi.fn(async () => fresh),
        createEnsembleChat: vi.fn(async () => fresh),
        saveChat: vi.fn(async (created) => created),
        recordChat: vi.fn(),
        projectIdsForChat: vi.fn(() => []),
        addChatToProject: vi.fn(),
        createRunId: () => 'background-run',
        queueRun: vi.fn(),
        executeRun,
        currentDraft: () => 'Second prompt',
        clearDraft,
        clearSubmittedContext: vi.fn(),
        reapAbandonedChats: vi.fn(),
        formatScheduledRunTime: (value) => value
      }
    )

    expect(executeRun).toHaveBeenCalledTimes(1)
    expect(executeRun.mock.calls[0][0]).toMatchObject({
      appRunId: 'background-run',
      scope: 'global',
      chatRecord: expect.objectContaining({ appChatId: 'background-global' })
    })
    expect(clearDraft).not.toHaveBeenCalled()
  })
})

describe('welcome background thread wiring', () => {
  it('routes the shortcut through focused and multiview composer launchers', () => {
    const composerSource = readFileSync(
      new URL('../components/Composer.tsx', import.meta.url),
      'utf8'
    )
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

    expect(composerSource).toContain('shouldStartWelcomeThreadInBackground({')
    expect(composerSource).toContain('void handleRunInBackground(')
    expect(appSource).toContain('launchWelcomeBackgroundThread(')
    expect(appSource).toContain('handleRunInBackground: paneHandleRunInBackground')
    expect(appSource).toContain('\n    handleRunInBackground,')
  })
})
