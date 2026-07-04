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

  it('normalizes chat workflow mode independently from approval permissions', () => {
    const legacyChat = AppStore.normalizeChatRecord({
      appChatId: 'legacy-workflow-chat',
      provider: 'codex',
      title: 'Legacy workflow',
      workspaceId: 'workspace-1',
      workspacePath: '/repo',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: []
    })
    const planChat = AppStore.normalizeChatRecord({
      ...legacyChat,
      workflowMode: 'plan'
    })
    const invalidChat = AppStore.normalizeChatRecord({
      ...legacyChat,
      workflowMode: 'read_only' as any
    })

    expect(legacyChat.workflowMode).toBe('normal')
    expect(planChat.workflowMode).toBe('plan')
    expect(invalidChat.workflowMode).toBe('normal')
  })

  it('creates new chats with normal workflow mode by default', () => {
    expect(AppStore.createChat('workspace-1', '/repo').workflowMode).toBe('normal')
    expect(AppStore.createGlobalChat().workflowMode).toBe('normal')
    expect(AppStore.createEnsembleChat().workflowMode).toBe('normal')
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
    expect(sideChat.ensemble?.fanoutPolicy).toBe('read_only')
    expect(sideChat.ensemble?.participants.map((participant) => participant.id)).toEqual(
      parent.ensemble?.participants.map((participant) => participant.id)
    )
  })

  it('creates default side chats from ensemble parents as linked ensemble clones', () => {
    const parent = AppStore.createEnsembleChat()
    const sideChat = AppStore.createSideChat({
      parentChatId: parent.appChatId
    })

    expect(sideChat.parentChatId).toBe(parent.appChatId)
    expect(sideChat.parentChatRelation).toBe('sideChat')
    expect(sideChat.chatKind).toBe('ensemble')
    expect(sideChat.sideChatContext).toMatchObject({
      mode: 'ensembleClone',
      lifecycleState: 'active',
      transcriptVisibility: 'none'
    })
    expect(sideChat.title).toContain('Side ensemble')
    expect(sideChat.ensemble?.participants.map((participant) => participant.id)).toEqual(
      parent.ensemble?.participants.map((participant) => participant.id)
    )
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
