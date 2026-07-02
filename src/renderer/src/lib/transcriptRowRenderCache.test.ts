import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import {
  transcriptChatRenderSignature,
  transcriptRowRenderSignatureEqual,
  type TranscriptRowRenderSignature
} from './transcriptRowRenderCache'

const message: ChatMessage = {
  id: 'assistant-1',
  role: 'assistant',
  content: 'Stable text',
  timestamp: '2026-01-01T00:00:00.000Z'
}

const chat = (overrides: Partial<ChatRecord> = {}): ChatRecord =>
  ({
    appChatId: 'chat-1',
    chatKind: 'single',
    provider: 'codex',
    workspacePath: '/repo',
    messages: [message],
    ...overrides
  }) as ChatRecord

const signature = (
  overrides: Partial<TranscriptRowRenderSignature> = {}
): TranscriptRowRenderSignature => ({
  rowKey: 'assistant-1#0',
  message,
  chatSignature: transcriptChatRenderSignature(chat()),
  providerLabel: 'Codex',
  provider: 'codex',
  workspacePath: '/repo',
  compactDensity: false,
  liveActivityViewport: false,
  isGlobal: false,
  sideChatSeed: false,
  highlighted: false,
  copied: false,
  pinned: false,
  feedbackVote: null,
  expandedUser: false,
  activityExpansionKey: '',
  subThreadExpanded: false,
  pendingPlanChoiceKey: '',
  pendingAgentQuestionsKey: '',
  auxiliaryKey: '',
  revealKey: 'plain',
  callbackRefs: [],
  ...overrides
})

describe('transcriptRowRenderCache', () => {
  it('keeps equivalent chat records cache-compatible for stable rows', () => {
    const first = transcriptChatRenderSignature(chat())
    const second = transcriptChatRenderSignature(chat({ messages: [{ ...message }] }))

    expect(second).toBe(first)
    expect(
      transcriptRowRenderSignatureEqual(
        signature({ chatSignature: first }),
        signature({ chatSignature: second })
      )
    ).toBe(true)
  })

  it('invalidates when the row message object changes', () => {
    expect(
      transcriptRowRenderSignatureEqual(
        signature(),
        signature({ message: { ...message, content: 'Live text changed' } })
      )
    ).toBe(false)
  })

  it('invalidates when chat-level pooled identity changes', () => {
    const first = transcriptChatRenderSignature(
      chat({
        providerMetadata: {
          pooledAgentId: 'pooled-agent-a',
          pooledAgentIdentity: {
            schemaVersion: 1,
            agentId: 'pooled-agent-a',
            nickname: 'Circuit Cactus',
            iconKind: 'seed',
            hue: 139
          }
        }
      })
    )
    const second = transcriptChatRenderSignature(
      chat({
        providerMetadata: {
          pooledAgentId: 'pooled-agent-a',
          pooledAgentIdentity: {
            schemaVersion: 1,
            agentId: 'pooled-agent-a',
            nickname: 'Socket Sorcery',
            iconKind: 'seed',
            hue: 164
          }
        }
      })
    )

    expect(second).not.toBe(first)
  })

  it('invalidates row-local chrome changes', () => {
    expect(transcriptRowRenderSignatureEqual(signature(), signature({ copied: true }))).toBe(false)
    expect(transcriptRowRenderSignatureEqual(signature(), signature({ highlighted: true }))).toBe(
      false
    )
    expect(
      transcriptRowRenderSignatureEqual(signature(), signature({ pendingAgentQuestionsKey: 'q1' }))
    ).toBe(false)
  })
})
