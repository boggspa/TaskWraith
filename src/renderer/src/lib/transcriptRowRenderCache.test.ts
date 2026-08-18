import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import {
  transcriptChatRenderSignature,
  transcriptMessageRenderSignature,
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
  messageSignature: transcriptMessageRenderSignature(message),
  chatSignature: transcriptChatRenderSignature(chat()),
  providerLabel: 'Codex',
  provider: 'codex',
  workspacePath: '/repo',
  compactDensity: false,
  liveActivityViewport: false,
  virtualized: true,
  isGlobal: false,
  sideChatSeed: false,
  highlighted: false,
  copied: false,
  pinned: false,
  feedbackVote: null,
  expandedUser: false,
  activityExpansionKey: '',
  subThreadExpanded: false,
  fanoutExpanded: false,
  liveViewportExpandedKey: '',
  collapsedStackKey: '',
  superGroupKey: '',
  pendingPlanChoiceKey: '',
  pendingAgentQuestionsKey: '',
  agentQuestionTombstoneKey: '',
  agentQuestionSeatKey: '',
  assistantRunModelKey: '',
  renameContinuityKey: '',
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

  it('keeps cloned equivalent row messages cache-compatible', () => {
    const cloned = { ...message }
    expect(
      transcriptRowRenderSignatureEqual(
        signature(),
        signature({ message: cloned, messageSignature: transcriptMessageRenderSignature(cloned) })
      )
    ).toBe(true)
  })

  it('invalidates when rendered row message content changes', () => {
    const changed = { ...message, content: 'Live text changed' }
    expect(
      transcriptRowRenderSignatureEqual(
        signature(),
        signature({ message: changed, messageSignature: transcriptMessageRenderSignature(changed) })
      )
    ).toBe(false)
  })

  it('invalidates when peer-message attribution metadata changes', () => {
    const first: ChatMessage = {
      ...message,
      role: 'tool',
      metadata: {
        kind: 'threadMessage',
        providerContextVisibility: 'projection-only',
        threadMessageId: 'peer-1',
        threadMessageFromChatId: 'chat-sender',
        threadMessageFromChatTitle: 'Original peer'
      }
    }
    const changed: ChatMessage = {
      ...first,
      metadata: { ...first.metadata, threadMessageFromChatTitle: 'Renamed peer' }
    }

    expect(transcriptMessageRenderSignature(changed)).not.toBe(
      transcriptMessageRenderSignature(first)
    )
  })

  it('invalidates when any per-kind live-viewport expansion toggles', () => {
    expect(
      transcriptRowRenderSignatureEqual(
        signature({ liveViewportExpandedKey: '000' }),
        signature({ liveViewportExpandedKey: '010' })
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

  it('does not invalidate every row for unrelated ensemble ledger churn', () => {
    const base = chat({
      chatKind: 'ensemble',
      ensemble: {
        participants: [
          {
            id: 'writer',
            provider: 'codex',
            model: 'gpt-5.5',
            role: 'Writer',
            order: 0,
            enabled: true
          }
        ],
        sessionActivityLedger: [
          {
            id: 'ledger-1',
            timestamp: '2026-01-01T00:01:00.000Z',
            changedBy: 'user',
            scope: 'participant',
            target: 'writer',
            oldValue: 'Codex / Writer',
            newValue: 'Codex / Reviewer'
          }
        ]
      }
    } as Partial<ChatRecord>)
    const changedLedger = transcriptChatRenderSignature({
      ...base,
      ensemble: {
        ...base.ensemble!,
        sessionActivityLedger: [
          ...(base.ensemble?.sessionActivityLedger || []),
          {
            id: 'ledger-2',
            timestamp: '2026-01-01T00:02:00.000Z',
            changedBy: 'user',
            scope: 'participant',
            target: 'writer',
            oldValue: 'Codex / Reviewer',
            newValue: 'Codex / Writer'
          }
        ]
      }
    } as ChatRecord)

    expect(changedLedger).toBe(transcriptChatRenderSignature(base))
  })

  it('invalidates row-local chrome changes', () => {
    expect(transcriptRowRenderSignatureEqual(signature(), signature({ copied: true }))).toBe(false)
    expect(transcriptRowRenderSignatureEqual(signature(), signature({ highlighted: true }))).toBe(
      false
    )
    expect(
      transcriptRowRenderSignatureEqual(signature(), signature({ pendingAgentQuestionsKey: 'q1' }))
    ).toBe(false)
    expect(
      transcriptRowRenderSignatureEqual(
        signature(),
        signature({ agentQuestionTombstoneKey: 'answered|Replace|preset||shown' })
      )
    ).toBe(false)
    // The seat resolves from the run, so it can appear after the row was first
    // cached. Without this the card keeps saying "Claude asked" forever.
    expect(
      transcriptRowRenderSignatureEqual(
        signature(),
        signature({ agentQuestionSeatKey: 'claude|claude-fable-5|SolBoss|1||||false|workspace_write' })
      )
    ).toBe(false)
    expect(transcriptRowRenderSignatureEqual(signature(), signature({ virtualized: false }))).toBe(false)
    expect(
      transcriptRowRenderSignatureEqual(signature(), signature({ assistantRunModelKey: 'run:gpt-5.5' }))
    ).toBe(false)
    expect(
      transcriptRowRenderSignatureEqual(
        signature(),
        signature({ renameContinuityKey: 'Planner\u0000Architect' })
      )
    ).toBe(false)
  })
})
