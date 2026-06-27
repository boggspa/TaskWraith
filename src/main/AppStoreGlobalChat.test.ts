import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from './store'
import type { ChatRecord } from './store/types'

const userDataPath = vi.hoisted(() => {
  const tmpRoot =
    process.platform === 'win32' && /^[A-Za-z]:/.test(process.cwd())
      ? `${process.cwd().slice(0, 2)}/tmp`
      : '/tmp'
  return `${tmpRoot}/taskwraith-global-chat-test-${process.pid}`
})

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

describe('AppStore global chats', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
  })

  it('creates, saves, and loads global chats without workspace fields', () => {
    const chat = AppStore.createGlobalChat()

    expect(chat.scope).toBe('global')
    expect(chat.workspaceId).toBeUndefined()
    expect(chat.workspacePath).toBeUndefined()

    AppStore.saveChat({
      ...chat,
      title: 'Planning',
      workspaceId: 'forged-workspace',
      workspacePath: '/tmp/forged-workspace',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Search and plan.',
          timestamp: '2026-05-08T00:00:00.000Z'
        }
      ]
    } as ChatRecord)

    const loaded = AppStore.getChat(chat.appChatId)
    expect(loaded).toMatchObject({
      appChatId: chat.appChatId,
      scope: 'global',
      title: 'Planning'
    })
    expect(loaded?.workspaceId).toBeUndefined()
    expect(loaded?.workspacePath).toBeUndefined()
    expect(loaded?.messages).toHaveLength(1)
  })

  it('returns chat-list summaries without transcript or full run payloads', () => {
    const chat = AppStore.createChat('workspace-1', '/repo')
    AppStore.saveChat({
      ...chat,
      title: 'Indexed Thread',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'This content should stay in the hydrated chat.',
          timestamp: '2026-05-08T00:00:00.000Z'
        }
      ],
      runs: [
        {
          runId: 'run-1',
          provider: 'codex',
          startedAt: '2026-05-08T00:00:00.000Z',
          endedAt: '2026-05-08T00:00:01.000Z',
          status: 'success',
          runDiff: {
            files: [
              {
                path: 'src/large.ts',
                status: 'modified',
                additions: 100,
                deletions: 2,
                hunks: []
              }
            ],
            stats: { filesChanged: 1, additions: 100, deletions: 2 }
          } as any
        }
      ]
    } as ChatRecord)

    const summaries = AppStore.getChatList('workspace-1')
    const summary = summaries.find((item) => item.appChatId === chat.appChatId)
    expect(summary).toMatchObject({
      appChatId: chat.appChatId,
      title: 'Indexed Thread',
      summaryOnly: true,
      messageCount: 1,
      runCount: 1
    })
    expect(summary?.messages).toEqual([])
    expect(summary?.runs).toEqual([])
    expect(summary?.lastRun).toMatchObject({ runId: 'run-1', status: 'success' })
    expect(summary?.lastRun?.runDiff).toBeUndefined()

    const hydrated = AppStore.getChat(chat.appChatId)
    expect(hydrated?.messages).toHaveLength(1)
    expect(hydrated?.runs).toHaveLength(1)
    expect(hydrated?.runs[0].runDiff).toBeTruthy()
  })

  it('defaults legacy chats to workspace scope', () => {
    const workspaceChat = AppStore.normalizeChatRecord({
      appChatId: 'legacy-chat',
      provider: 'gemini',
      title: 'Legacy',
      workspaceId: 'workspace-1',
      workspacePath: '/repo',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: []
    })

    expect(workspaceChat.scope).toBe('workspace')
    expect(workspaceChat.workspacePath).toBe('/repo')
  })

  it('defaults side-chat lifecycle metadata for legacy records', () => {
    const activeSideChat = AppStore.normalizeChatRecord({
      appChatId: 'side-chat',
      provider: 'codex',
      title: 'Side',
      workspaceId: 'workspace-1',
      workspacePath: '/repo',
      createdAt: 10,
      updatedAt: 11,
      archived: false,
      messages: [],
      runs: [],
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      sideChatContext: { createdAt: 10 }
    } as ChatRecord)
    const archivedSideChat = AppStore.normalizeChatRecord({
      ...activeSideChat,
      appChatId: 'archived-side-chat',
      archived: true,
      sideChatContext: { createdAt: 10 }
    } as ChatRecord)

    expect(activeSideChat.sideChatContext?.lifecycleState).toBe('active')
    expect(archivedSideChat.sideChatContext?.lifecycleState).toBe('terminated')
  })

  it('creates fan-out side chats as concurrent linked ensembles', () => {
    const parent = AppStore.createEnsembleChat()
    const sideChat = AppStore.createSideChat({
      parentChatId: parent.appChatId,
      sideChatMode: 'fanOut'
    })

    expect(sideChat.parentChatId).toBe(parent.appChatId)
    expect(sideChat.parentChatRelation).toBe('sideChat')
    expect(sideChat.chatKind).toBe('ensemble')
    expect(sideChat.sideChatContext).toMatchObject({
      mode: 'fanOut',
      lifecycleState: 'active',
      transcriptVisibility: 'none'
    })
    expect(sideChat.ensemble?.concurrentModeEnabled).toBe(true)
    expect(sideChat.ensemble?.participants.map((participant) => participant.id)).toEqual(
      parent.ensemble?.participants.map((participant) => participant.id)
    )
  })

  it('creates guest participant children for global, workspace, and sub-thread parents', () => {
    const globalParent = AppStore.createGlobalChat()
    const globalGuest = AppStore.setGuestParticipant({
      parentChatId: globalParent.appChatId,
      provider: 'codex',
      selectedModelType: 'gpt-5.5',
      codexReasoningEffort: 'high'
    })
    expect(globalGuest.parent.guestParticipant).toMatchObject({
      childChatId: globalGuest.guest.appChatId,
      provider: 'codex',
      selectedModelType: 'gpt-5.5',
      persistent: true
    })
    expect(globalGuest.guest).toMatchObject({
      scope: 'global',
      chatKind: 'single',
      parentChatId: globalParent.appChatId,
      parentChatRelation: 'sideChat'
    })
    expect(globalGuest.guest.workspaceId).toBeUndefined()
    expect(globalGuest.guest.sideChatContext).toMatchObject({
      mode: 'guestParticipant',
      lifecycleState: 'active',
      transcriptVisibility: 'none'
    })

    const workspaceParent = AppStore.createChat('workspace-1', '/repo')
    const workspaceGuest = AppStore.setGuestParticipant({
      parentChatId: workspaceParent.appChatId,
      provider: 'claude',
      selectedModelType: 'claude-sonnet-4-7',
      claudeReasoningEffort: 'medium'
    })
    expect(workspaceGuest.guest).toMatchObject({
      scope: 'workspace',
      workspaceId: 'workspace-1',
      workspacePath: '/repo',
      chatKind: 'single',
      parentChatRelation: 'sideChat'
    })

    const subThread = AppStore.createSubThread({
      parentChatId: workspaceParent.appChatId,
      provider: 'codex',
      delegationPrompt: 'Work in child',
      returnResultToParent: false
    })
    const subThreadGuest = AppStore.setGuestParticipant({
      parentChatId: subThread.appChatId,
      provider: 'kimi',
      selectedModelType: 'kimi-k2.6',
      kimiThinkingEnabled: true
    })
    expect(subThreadGuest.guest.parentChatId).toBe(subThread.appChatId)
    expect(subThreadGuest.guest.sideChatContext?.mode).toBe('guestParticipant')
  })

  it('rejects guest participants on ensemble parents', () => {
    const ensemble = AppStore.createEnsembleChat()
    expect(() =>
      AppStore.setGuestParticipant({
        parentChatId: ensemble.appChatId,
        provider: 'codex',
        selectedModelType: 'gpt-5.5'
      })
    ).toThrow('Guest participants are only available for standard chats.')
  })

  it('switches and removes guest participants without deleting child transcripts', () => {
    const parent = AppStore.createChat('workspace-1', '/repo')
    const first = AppStore.setGuestParticipant({
      parentChatId: parent.appChatId,
      provider: 'codex',
      selectedModelType: 'gpt-5.5'
    })
    AppStore.saveChat({
      ...first.guest,
      messages: [
        {
          id: 'guest-message-1',
          role: 'assistant',
          content: 'First guest transcript',
          timestamp: '2026-06-07T00:00:00.000Z'
        }
      ]
    })

    const switched = AppStore.setGuestParticipant({
      parentChatId: parent.appChatId,
      provider: 'claude',
      selectedModelType: 'claude-sonnet-4-7'
    })
    expect(switched.parent.guestParticipant?.childChatId).toBe(switched.guest.appChatId)
    expect(switched.guest.provider).toBe('claude')
    const closedFirst = AppStore.getChat(first.guest.appChatId)
    expect(closedFirst?.sideChatContext?.lifecycleState).toBe('closed')
    expect(closedFirst?.messages[0]?.content).toBe('First guest transcript')

    const removed = AppStore.removeGuestParticipant(parent.appChatId)
    expect(removed.parent.guestParticipant).toBeUndefined()
    expect(removed.guest?.appChatId).toBe(switched.guest.appChatId)
    expect(removed.guest?.sideChatContext?.lifecycleState).toBe('closed')
    expect(AppStore.getChat(switched.guest.appChatId)).toBeTruthy()
  })

  it('keeps chat ids inside the chat persistence directory', () => {
    const settingsPath = join(userDataPath, 'settings.json')
    fs.writeFileSync(settingsPath, '{"sentinel":true}', 'utf8')

    expect(AppStore.getChatRecordPath('safe-chat')).toBe(
      join(userDataPath, 'chats', 'safe-chat.json')
    )
    expect(AppStore.getChatRecordPath('../settings')).toBeNull()
    expect(AppStore.getChat('../settings')).toBeNull()
    expect(() =>
      AppStore.saveChat({
        appChatId: '../settings',
        scope: 'global',
        provider: 'gemini',
        title: 'Traversal',
        createdAt: 1,
        updatedAt: 1,
        archived: false,
        messages: [],
        runs: []
      } as ChatRecord)
    ).toThrow(/safe chat id/)
    expect(() => AppStore.deleteChat('../settings')).toThrow(/safe chat id/)
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{"sentinel":true}')
  })
})
