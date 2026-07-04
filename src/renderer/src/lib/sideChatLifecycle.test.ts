import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { assignAgentIdentityFromSeed } from './agentIdentitySeed'
import {
  SIDE_CHAT_HIDDEN_CONTEXT_CONSUMED_AT_METADATA_KEY,
  SIDE_CHAT_HIDDEN_CONTEXT_PROMPT_METADATA_KEY,
  SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY,
  applySideChatLifecycle,
  getLinkedChatAgentIdentity,
  getLinkedChatKindLabel,
  getPendingSideChatHiddenContextPrompt,
  getSideChatLifecycleState,
  getSideChatMode,
  getSideChatSelectedParticipantId,
  isTerminatedSideChat,
  isTopLevelWorkspaceChat
} from './sideChatLifecycle'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Chat',
    createdAt: 100,
    updatedAt: 100,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

describe('side chat lifecycle helpers', () => {
  it('derives side-chat mode and lifecycle fallbacks', () => {
    expect(getSideChatMode(chat())).toBe('singleProvider')
    expect(getSideChatMode(chat({ chatKind: 'ensemble' }))).toBe('ensembleClone')
    expect(
      getSideChatMode(
        chat({
          sideChatContext: { createdAt: 100, mode: 'fanOut' }
        })
      )
    ).toBe('fanOut')

    expect(getSideChatLifecycleState(chat())).toBe('active')
    expect(getSideChatLifecycleState(chat({ archived: true }))).toBe('terminated')
    expect(
      getSideChatLifecycleState(
        chat({
          sideChatContext: { createdAt: 100, lifecycleState: 'closed' }
        })
      )
    ).toBe('closed')
  })

  it('reads pending hidden context only for unconsumed side chats', () => {
    expect(
      getPendingSideChatHiddenContextPrompt(
        chat({
          parentChatRelation: 'sideChat',
          providerMetadata: {
            [SIDE_CHAT_HIDDEN_CONTEXT_PROMPT_METADATA_KEY]: '  hidden context  '
          }
        })
      )
    ).toBe('hidden context')
    expect(
      getPendingSideChatHiddenContextPrompt(
        chat({
          parentChatRelation: 'sideChat',
          providerMetadata: {
            [SIDE_CHAT_HIDDEN_CONTEXT_PROMPT_METADATA_KEY]: 'hidden context',
            [SIDE_CHAT_HIDDEN_CONTEXT_CONSUMED_AT_METADATA_KEY]: '2026-06-27T12:00:00.000Z'
          }
        })
      )
    ).toBe('')
    expect(getPendingSideChatHiddenContextPrompt(chat())).toBe('')
  })

  it('classifies linked chat identity and labels', () => {
    const subThread = chat({ appChatId: 'sub-1', parentChatId: 'parent-1' })
    const sideChat = chat({
      appChatId: 'side-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      providerMetadata: {
        [SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]: 'participant-1'
      }
    })
    const guestChat = chat({
      appChatId: 'guest-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      sideChatContext: { createdAt: 100, mode: 'guestParticipant' }
    })

    expect(getLinkedChatAgentIdentity(subThread)).toEqual(assignAgentIdentityFromSeed('sub-1'))
    expect(getLinkedChatAgentIdentity(sideChat)).toEqual(
      assignAgentIdentityFromSeed('parent-1:participant-1')
    )
    expect(getLinkedChatAgentIdentity(guestChat)).toEqual(assignAgentIdentityFromSeed('parent-1:guest'))
    expect(getLinkedChatKindLabel(sideChat)).toBe('Isolated side chat')
    expect(getLinkedChatKindLabel(guestChat)).toBe('Guest side chat')
    expect(getLinkedChatKindLabel(subThread)).toBe('Sub-thread')
    expect(getSideChatSelectedParticipantId(sideChat)).toBe('participant-1')
  })

  it('detects top-level workspace chats and terminated side chats', () => {
    expect(isTopLevelWorkspaceChat(chat())).toBe(true)
    expect(isTopLevelWorkspaceChat(chat({ parentChatId: 'parent-1' }))).toBe(false)
    expect(isTopLevelWorkspaceChat(chat({ parentChatRelation: 'sideChat' }))).toBe(false)
    expect(isTerminatedSideChat(chat({ parentChatRelation: 'sideChat', archived: true }))).toBe(true)
  })

  it('applies side-chat lifecycle timestamps without changing non-side chats', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-27T12:00:00.000Z'))
    const now = Date.now()
    const source = chat({
      parentChatRelation: 'sideChat',
      sideChatContext: {
        createdAt: 100,
        lifecycleState: 'closed',
        closedAt: 200,
        terminatedAt: 300,
        terminationReason: 'old'
      }
    })

    const nonSideChat = chat()
    expect(applySideChatLifecycle(nonSideChat, 'closed')).toBe(nonSideChat)
    expect(applySideChatLifecycle(source, 'active')).toMatchObject({
      archived: false,
      sideChatContext: {
        createdAt: 100,
        lifecycleState: 'active',
        openedAt: now,
        closedAt: undefined,
        terminatedAt: undefined,
        terminationReason: undefined
      }
    })
    expect(applySideChatLifecycle(source, 'closed')).toMatchObject({
      sideChatContext: {
        lifecycleState: 'closed',
        closedAt: now,
        terminatedAt: undefined,
        terminationReason: undefined
      }
    })
    expect(applySideChatLifecycle(source, 'terminated', 'ended')).toMatchObject({
      archived: true,
      updatedAt: now,
      sideChatContext: {
        lifecycleState: 'terminated',
        closedAt: now,
        terminatedAt: now,
        terminationReason: 'ended'
      }
    })
    vi.useRealTimers()
  })
})
