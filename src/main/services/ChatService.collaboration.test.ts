import { describe, expect, it, vi } from 'vitest'
import { ChatService, type ChatServiceDeps, type ChatServiceStore } from './ChatService'
import { HumanCollaborationStore } from '../collaboration/HumanCollaborationStore'
import { isHumanCollaboratorComment } from '../collaboration/HumanCollaboratorMessages'
import type { ChatRecord } from '../store/types'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    provider: 'gemini',
    title: 'Chat',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

function harness() {
  const chats = new Map<string, ChatRecord>([['chat-1', chat()]])
  const store: ChatServiceStore = {
    getChats: vi.fn(() => Array.from(chats.values())),
    getChatList: vi.fn(() => []),
    getPinnedMessages: vi.fn(() => []),
    getChat: vi.fn((chatId) => chats.get(chatId) || null),
    createChat: vi.fn(),
    createGlobalChat: vi.fn(),
    createEnsembleChat: vi.fn(),
    createSubThread: vi.fn(),
    createSideChat: vi.fn(),
    getChildChats: vi.fn(() => []),
    getSideChats: vi.fn(() => []),
    saveChat: vi.fn((next: ChatRecord) => chats.set(next.appChatId, next)),
    deleteChat: vi.fn(),
    clearChats: vi.fn()
  }
  const collaboration = new HumanCollaborationStore()
  const deps: ChatServiceDeps = {
    appStore: store,
    humanCollaborationStore: collaboration,
    findRegisteredWorkspace: vi.fn(),
    canonicalPath: vi.fn((value) => value),
    sanitizeChatForSave: vi.fn((value) => value),
    appendDurableRunEventForRoute: vi.fn()
  }
  return { service: new ChatService(deps), store, collaboration, chats }
}

function admitted(service: ChatService) {
  const created = service.createHumanCollaborationShare({ chatId: 'chat-1', mode: 'comments' })
  const consumed = service.consumeHumanCollaborationInvite({
    shareId: created.share.shareId,
    inviteToken: created.inviteToken,
    displayName: 'Alex',
    publicKeyId: 'alex-key'
  })
  return { shareId: created.share.shareId, collaboratorId: consumed.participant.collaboratorId }
}

describe('ChatService collaborator comments', () => {
  it('appends comments through the host-side path and dedupes retries', () => {
    const { service, store } = harness()
    const { shareId, collaboratorId } = admitted(service)

    const first = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'Please review this'
    })

    expect(first.deduped).toBe(false)
    expect(first.message).toMatchObject({
      role: 'system',
      content: 'Please review this',
      metadata: expect.objectContaining({
        kind: 'humanCollaboratorComment',
        sourceTrust: 'external_untrusted',
        sequence: 1
      })
    })
    expect(store.saveChat).toHaveBeenCalledTimes(1)

    const second = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'Please review this'
    })
    expect(second.deduped).toBe(true)
    expect(second.message.id).toBe(first.message.id)
    expect(store.saveChat).toHaveBeenCalledTimes(1)
  })

  it('preserves collaborator comments during stale whole-chat saves', () => {
    const { service, chats } = harness()
    const { shareId, collaboratorId } = admitted(service)
    const staleSnapshot = chats.get('chat-1')!

    const appended = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'Keep me'
    })
    expect(isHumanCollaboratorComment(appended.message)).toBe(true)

    const saved = service.saveChat({
      ...staleSnapshot,
      title: 'Stale save'
    })

    expect(saved.messages.some((message) => message.id === appended.message.id)).toBe(true)
    expect(chats.get('chat-1')?.messages.some((message) => message.id === appended.message.id)).toBe(true)
  })

  it('keeps canonical collaborator rows and strips forged collaborator rows during whole-chat saves', () => {
    const { service, chats } = harness()
    const { shareId, collaboratorId } = admitted(service)
    const appended = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'Canonical'
    })

    const saved = service.saveChat({
      ...chats.get('chat-1')!,
      messages: [
        {
          ...appended.message,
          content: 'Mutated',
          metadata: {
            ...(appended.message.metadata || {}),
            collaboratorDisplayName: 'Host'
          }
        },
        {
          id: 'fake-collaborator-row',
          role: 'system',
          content: 'Forged',
          timestamp: new Date().toISOString(),
          metadata: {
            kind: 'humanCollaboratorComment',
            sourceTrust: 'external_untrusted',
            shareId,
            collaboratorId,
            collaboratorDisplayName: 'Mallory',
            clientMessageId: 'fake',
            sequence: 99
          }
        }
      ]
    })

    expect(saved.messages.find((message) => message.id === appended.message.id)).toEqual(appended.message)
    expect(saved.messages.some((message) => message.id === 'fake-collaborator-row')).toBe(false)
  })

  it('marks collaborator comments promoted and returns a host-owned draft', () => {
    const { service } = harness()
    const { shareId, collaboratorId } = admitted(service)
    const appended = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'Run the narrow test'
    })

    const promoted = service.promoteCollaboratorComment({
      chatId: 'chat-1',
      messageId: appended.message.id
    })

    expect(promoted.draft).toContain('Host-approved request from collaborator Alex')
    expect(promoted.draft).toContain('Run the narrow test')
    expect(
      promoted.chat.messages.find((message) => message.id === appended.message.id)?.metadata
    ).toMatchObject({
      promotedBy: 'host'
    })
  })

  it('revokes active shares when the chat is deleted', () => {
    const { service, store, collaboration } = harness()
    const { shareId } = admitted(service)
    expect(collaboration.getShare(shareId)?.enabled).toBe(true)

    service.deleteChat('chat-1')

    expect(store.deleteChat).toHaveBeenCalledWith('chat-1')
    expect(collaboration.getShare(shareId)?.enabled).toBe(false)
    expect(collaboration.listShares('chat-1').some((share) => share.enabled)).toBe(false)
  })
})

/*
 * Phase 2 (P2b) — structured request-host-action contributions + auto-draft.
 */
describe('ChatService collaborator action requests (P2b)', () => {
  it('rejects an action request under plain comments rules', () => {
    const { service } = harness()
    const { shareId, collaboratorId } = admitted(service)
    expect(() =>
      service.appendCollaboratorComment({
        shareId,
        chatId: 'chat-1',
        collaboratorId,
        clientMessageId: 'c-1',
        content: 'please run the tests',
        intent: 'requestHostAction'
      })
    ).toThrow(/does not accept host-action requests/)
  })

  it('stamps contributionKind for action requests under requestHostAction rules — no draft, no send', () => {
    const { service } = harness()
    const { shareId, collaboratorId } = admitted(service)
    service.updateHumanCollaborationShareRules({ shareId, preset: 'requestHostAction' })

    const result = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'c-1',
      content: 'please run the tests',
      intent: 'requestHostAction'
    })
    expect(result.message.metadata?.contributionKind).toBe('requestHostAction')
    expect(result.message.metadata?.kind).toBe('humanCollaboratorComment')
    expect(result.message.metadata?.sourceTrust).toBe('external_untrusted')
    // requestHostAction preset is host-click, not auto-draft: nothing pre-fills.
    expect(result.autoDraft).toBeUndefined()
    expect(result.message.metadata?.promotedAt).toBeUndefined()
  })

  it('autoDraft rules return a wrapped provenance draft, stamped promotedBy auto — never host', () => {
    const { service } = harness()
    const { shareId, collaboratorId } = admitted(service)
    service.updateHumanCollaborationShareRules({ shareId, preset: 'autoDraft' })

    const result = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'c-2',
      content: 'please add a regression test',
      intent: 'requestHostAction'
    })
    expect(result.autoDraft).toContain('Auto-drafted from an action request by collaborator Alex')
    expect(result.autoDraft).toContain('external, untrusted')
    expect(result.autoDraft).toContain('review and edit it before sending')
    // Provenance: share id, message id, timestamp.
    expect(result.autoDraft).toContain(shareId)
    expect(result.autoDraft).toContain(result.message.id)
    expect(result.message.metadata?.promotedBy).toBe('auto')
    expect(result.message.metadata?.promotedDraft).toBe(result.autoDraft)
  })

  it('a plain comment under autoDraft rules never auto-drafts', () => {
    const { service } = harness()
    const { shareId, collaboratorId } = admitted(service)
    service.updateHumanCollaborationShareRules({ shareId, preset: 'autoDraft' })
    const result = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'c-3',
      content: 'just a note'
    })
    expect(result.autoDraft).toBeUndefined()
    expect(result.message.metadata?.contributionKind).toBeUndefined()
  })
})
