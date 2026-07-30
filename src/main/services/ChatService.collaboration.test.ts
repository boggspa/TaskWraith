import { describe, expect, it, vi } from 'vitest'
import { ChatService, type ChatServiceDeps, type ChatServiceStore } from './ChatService'
import { HumanCollaborationStore } from '../collaboration/HumanCollaborationStore'
import { isHumanCollaboratorComment } from '../collaboration/HumanCollaboratorMessages'
import type { ChatListItem, ChatRecord } from '../store/types'

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
    setChatKind: vi.fn(),
    getChildChats: vi.fn(() => []),
    getSideChats: vi.fn(() => []),
    saveChat: vi.fn((next: ChatRecord) => {
      chats.set(next.appChatId, next)
      return next
    }),
    deleteChat: vi.fn(),
    clearChats: vi.fn()
  }
  const collaboration = new HumanCollaborationStore()
  const deps: ChatServiceDeps = {
    appStore: store,
    humanCollaborationStore: collaboration,
    findRegisteredWorkspace: vi.fn(),
    canonicalPath: vi.fn((value) => value),
    prepareForkMessages: vi.fn(({ copiedMessages }) => copiedMessages),
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

/*
 * Destructive chat paths must take the live channel down, not just flip the
 * record. `revokeShare` alone bites on the collaborator's NEXT inbound frame,
 * and a collaborator who is merely watching sends nothing — so their sealed
 * socket survives the chat, the next projection build throws 'Chat not found.'
 * and they sit on a frozen transcript with no signal. Closing every invite's
 * room is what actually ends it.
 */

/** Same idiom as `harness()`, plus a room-closing spy, a shared call log for
 *  ordering, a workspace-aware `getChatList` (the clear scope reads it) and
 *  switches for dropping the two optional deps. */
function roomHarness(
  options: {
    chats?: ChatRecord[]
    withCollaborationStore?: boolean
    withCloseCollaborationRoom?: boolean
  } = {}
) {
  const seed = options.chats ?? [chat()]
  const chats = new Map<string, ChatRecord>(seed.map((record) => [record.appChatId, record]))
  // Every close and every revoke, in the order the service performed them.
  const calls: string[] = []
  const store: ChatServiceStore = {
    getChats: vi.fn(() => Array.from(chats.values())),
    getChatList: vi.fn((workspaceId?: string): ChatListItem[] =>
      Array.from(chats.values())
        .filter((record) => !workspaceId || record.workspaceId === workspaceId)
        .map((record) => ({
          ...record,
          summaryOnly: true as const,
          messageCount: record.messages.length,
          runCount: record.runs.length
        }))
    ),
    getPinnedMessages: vi.fn(() => []),
    getChat: vi.fn((chatId) => chats.get(chatId) || null),
    createChat: vi.fn(),
    createGlobalChat: vi.fn(),
    createEnsembleChat: vi.fn(),
    createSubThread: vi.fn(),
    createSideChat: vi.fn(),
    setChatKind: vi.fn(),
    getChildChats: vi.fn(() => []),
    getSideChats: vi.fn(() => []),
    saveChat: vi.fn((next: ChatRecord) => {
      chats.set(next.appChatId, next)
      return next
    }),
    deleteChat: vi.fn(),
    clearChats: vi.fn()
  }
  const collaboration = new HumanCollaborationStore()
  const revokeShare = collaboration.revokeShare.bind(collaboration)
  vi.spyOn(collaboration, 'revokeShare').mockImplementation((shareId, now) => {
    calls.push(`revoke:${shareId}`)
    return revokeShare(shareId, now)
  })
  // Rooms whose close attempt blows up, standing in for a transport in a bad
  // state. Populated by the test after the roomIds exist. The call is logged
  // BEFORE the throw so the log still records that the attempt was made.
  const throwingRooms = new Set<string>()
  const closeCollaborationRoom = vi.fn((roomId: string) => {
    calls.push(`close:${roomId}`)
    if (throwingRooms.has(roomId)) throw new Error(`Relay transport is down: ${roomId}`)
  })
  const deps: ChatServiceDeps = {
    appStore: store,
    ...(options.withCollaborationStore === false ? {} : { humanCollaborationStore: collaboration }),
    findRegisteredWorkspace: vi.fn(),
    canonicalPath: vi.fn((value) => value),
    prepareForkMessages: vi.fn(({ copiedMessages }) => copiedMessages),
    sanitizeChatForSave: vi.fn((value) => value),
    appendDurableRunEventForRoute: vi.fn(),
    ...(options.withCloseCollaborationRoom === false ? {} : { closeCollaborationRoom })
  }
  return {
    service: new ChatService(deps),
    store,
    collaboration,
    chats,
    calls,
    closeCollaborationRoom,
    throwingRooms
  }
}

/** One share (one invite ⇒ one room) on `chatId`. */
function shared(service: ChatService, chatId = 'chat-1') {
  const created = service.createHumanCollaborationShare({ chatId, mode: 'comments' })
  return { shareId: created.share.shareId, roomId: created.roomId }
}

describe('ChatService closes collaboration rooms on destructive chat paths', () => {
  it('deleteChat closes the shared chat room and revokes the share', () => {
    const { service, store, collaboration, closeCollaborationRoom } = roomHarness()
    const { shareId, roomId } = shared(service)
    expect(collaboration.getShare(shareId)?.enabled).toBe(true)

    service.deleteChat('chat-1')

    expect(closeCollaborationRoom).toHaveBeenCalledTimes(1)
    expect(closeCollaborationRoom).toHaveBeenCalledWith(roomId)
    expect(collaboration.getShare(shareId)?.enabled).toBe(false)
    expect(store.deleteChat).toHaveBeenCalledWith('chat-1')
  })

  it('deleteChat closes EVERY invite room on the share, not just the first', () => {
    const { service, collaboration, closeCollaborationRoom } = roomHarness()
    // A second invite on an already-shared chat reuses the enabled share and
    // appends a fresh roomId — two live doors behind one share record.
    const first = shared(service)
    const second = shared(service)
    expect(second.shareId).toBe(first.shareId)
    expect(second.roomId).not.toBe(first.roomId)
    expect(collaboration.getShare(first.shareId)?.invites).toHaveLength(2)

    service.deleteChat('chat-1')

    expect(closeCollaborationRoom).toHaveBeenCalledWith(first.roomId)
    expect(closeCollaborationRoom).toHaveBeenCalledWith(second.roomId)
    expect(closeCollaborationRoom).toHaveBeenCalledTimes(2)
  })

  it('prepareClearChats with no workspace ends every share in the store', async () => {
    const { service, collaboration, closeCollaborationRoom } = roomHarness({
      chats: [
        chat({ appChatId: 'chat-1', workspaceId: 'workspace-1' }),
        chat({ appChatId: 'chat-2', workspaceId: 'workspace-2' })
      ]
    })
    const one = shared(service, 'chat-1')
    const two = shared(service, 'chat-2')

    await service.prepareClearChats()

    expect(closeCollaborationRoom).toHaveBeenCalledWith(one.roomId)
    expect(closeCollaborationRoom).toHaveBeenCalledWith(two.roomId)
    expect(collaboration.getShare(one.shareId)?.enabled).toBe(false)
    expect(collaboration.getShare(two.shareId)?.enabled).toBe(false)
  })

  it('prepareClearChats(workspaceId) ends only that workspace and leaves the other alone', async () => {
    const { service, collaboration, closeCollaborationRoom } = roomHarness({
      chats: [
        chat({ appChatId: 'chat-1', workspaceId: 'workspace-1' }),
        chat({ appChatId: 'chat-2', workspaceId: 'workspace-2' })
      ]
    })
    const inScope = shared(service, 'chat-1')
    const untouched = shared(service, 'chat-2')

    await service.prepareClearChats('workspace-1')

    expect(closeCollaborationRoom).toHaveBeenCalledWith(inScope.roomId)
    expect(collaboration.getShare(inScope.shareId)?.enabled).toBe(false)
    // Leakage the other way is just as bad: another workspace's collaborator
    // must keep both their room and their share.
    expect(closeCollaborationRoom).not.toHaveBeenCalledWith(untouched.roomId)
    expect(closeCollaborationRoom).toHaveBeenCalledTimes(1)
    expect(collaboration.getShare(untouched.shareId)?.enabled).toBe(true)
  })

  it('closes the room BEFORE revoking the share', () => {
    const { service, calls } = roomHarness()
    const { shareId, roomId } = shared(service)

    service.deleteChat('chat-1')

    // Revoke-then-close would work today, but the intended order is to drop the
    // socket first so no frame can be served against a half-torn-down share.
    expect(calls).toEqual([`close:${roomId}`, `revoke:${shareId}`])
  })

  it('a throwing room closer never blocks the deletion, and never skips the next room', () => {
    const { service, store, collaboration, closeCollaborationRoom, throwingRooms } = roomHarness()
    const first = shared(service)
    const second = shared(service)
    // Only the FIRST door is jammed. A try/catch wrapped around the whole loop
    // instead of each call would swallow this and silently abandon the second.
    throwingRooms.add(first.roomId)

    expect(() => service.deleteChat('chat-1')).not.toThrow()

    expect(closeCollaborationRoom).toHaveBeenCalledWith(first.roomId)
    expect(closeCollaborationRoom).toHaveBeenCalledWith(second.roomId)
    expect(closeCollaborationRoom).toHaveBeenCalledTimes(2)
    // A leaked socket is the acceptable failure; an undeleted chat with a
    // half-torn share is not.
    expect(collaboration.getShare(first.shareId)?.enabled).toBe(false)
    expect(store.deleteChat).toHaveBeenCalledWith('chat-1')
  })

  it('a workspace-scoped clear also ends orphan shares whose chat exists nowhere', async () => {
    const { service, collaboration, closeCollaborationRoom, chats } = roomHarness({
      chats: [
        chat({ appChatId: 'chat-1', workspaceId: 'workspace-1' }),
        chat({ appChatId: 'chat-2', workspaceId: 'workspace-2' }),
        chat({ appChatId: 'chat-orphan', workspaceId: 'workspace-2' })
      ]
    })
    const doomed = shared(service, 'chat-1')
    const surviving = shared(service, 'chat-2')
    const orphan = shared(service, 'chat-orphan')
    // The chat is gone; only the share record remembers it. Its last known
    // workspace is the SURVIVING one, so the only thing that can end it here is
    // orphanhood — not membership of the doomed workspace.
    chats.delete('chat-orphan')

    await service.prepareClearChats('workspace-1')

    expect(closeCollaborationRoom).toHaveBeenCalledWith(doomed.roomId)
    expect(collaboration.getShare(doomed.shareId)?.enabled).toBe(false)
    // Nothing else will ever come for the orphan's channel.
    expect(closeCollaborationRoom).toHaveBeenCalledWith(orphan.roomId)
    expect(collaboration.getShare(orphan.shareId)?.enabled).toBe(false)
    // The other half: a live chat in another workspace keeps its door.
    expect(closeCollaborationRoom).not.toHaveBeenCalledWith(surviving.roomId)
    expect(closeCollaborationRoom).toHaveBeenCalledTimes(2)
    expect(collaboration.getShare(surviving.shareId)?.enabled).toBe(true)
  })

  it('deleteChat still works with no collaboration store and no room closer', () => {
    const withoutStore = roomHarness({ withCollaborationStore: false })
    expect(() => withoutStore.service.deleteChat('chat-1')).not.toThrow()
    expect(withoutStore.store.deleteChat).toHaveBeenCalledWith('chat-1')
    expect(withoutStore.closeCollaborationRoom).not.toHaveBeenCalled()

    // Store present, closer absent: the share must still be revoked.
    const withoutCloser = roomHarness({ withCloseCollaborationRoom: false })
    const { shareId } = shared(withoutCloser.service)
    expect(() => withoutCloser.service.deleteChat('chat-1')).not.toThrow()
    expect(withoutCloser.collaboration.getShare(shareId)?.enabled).toBe(false)
    expect(withoutCloser.store.deleteChat).toHaveBeenCalledWith('chat-1')
  })
})
