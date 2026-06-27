import { describe, expect, it } from 'vitest'
import type { ChatRecord, ProviderId } from '../../../main/store/types'
import { SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY } from './sideChatLifecycle'
import { findReusableSideChat } from './sideChatReuse'

function chat(id: string, overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: id,
    provider: 'codex' as ProviderId,
    title: id,
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

function sideChat(id: string, overrides: Partial<ChatRecord> = {}): ChatRecord {
  return chat(id, {
    parentChatId: 'parent-1',
    parentChatRelation: 'sideChat',
    sideChatContext: {
      createdAt: 1,
      mode: 'singleProvider'
    },
    ...overrides
  })
}

describe('findReusableSideChat', () => {
  it('returns null when no parent chat id is available', () => {
    expect(findReusableSideChat(null, [sideChat('side-1')])).toBeNull()
    expect(findReusableSideChat('', [sideChat('side-1')])).toBeNull()
  })

  it('filters archived, terminated, wrong-parent, and non-side-chat records', () => {
    const reusable = sideChat('reusable')
    const result = findReusableSideChat('parent-1', [
      chat('main'),
      sideChat('archived', { archived: true }),
      sideChat('terminated', {
        sideChatContext: { createdAt: 1, lifecycleState: 'terminated' }
      }),
      sideChat('wrong-parent', { parentChatId: 'parent-2' }),
      chat('sub-thread', { parentChatId: 'parent-1', parentChatRelation: 'subThread' }),
      reusable
    ])

    expect(result).toBe(reusable)
  })

  it('honors mode, provider, and selected participant filters', () => {
    const matching = sideChat('matching', {
      provider: 'claude',
      sideChatContext: { createdAt: 1, mode: 'singleProvider' },
      providerMetadata: {
        [SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]: 'participant-1'
      }
    })
    const wrongMode = sideChat('wrong-mode', {
      provider: 'claude',
      sideChatContext: { createdAt: 1, mode: 'fanOut' },
      providerMetadata: {
        [SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]: 'participant-1'
      }
    })
    const wrongProvider = sideChat('wrong-provider', {
      provider: 'codex',
      providerMetadata: {
        [SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]: 'participant-1'
      }
    })
    const wrongParticipant = sideChat('wrong-participant', {
      provider: 'claude',
      providerMetadata: {
        [SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]: 'participant-2'
      }
    })

    expect(
      findReusableSideChat('parent-1', [wrongMode, wrongProvider, wrongParticipant, matching], {
        mode: 'singleProvider',
        provider: 'claude',
        selectedParticipantId: 'participant-1'
      })
    ).toBe(matching)
  })

  it('chooses the newest reusable side chat by updatedAt with createdAt fallback', () => {
    const older = sideChat('older', { createdAt: 10, updatedAt: 10 })
    const createdFallback = sideChat('created-fallback', {
      createdAt: 30,
      updatedAt: 0
    })
    const newest = sideChat('newest', { createdAt: 20, updatedAt: 40 })

    expect(findReusableSideChat('parent-1', [older, createdFallback, newest])).toBe(newest)
    expect(findReusableSideChat('parent-1', [older, createdFallback])).toBe(createdFallback)
  })
})
