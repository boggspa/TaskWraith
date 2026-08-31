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
  blackboardStackKey: '',
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

  it('invalidates an execution-result row when only its live graph view changes', () => {
    expect(
      transcriptRowRenderSignatureEqual(
        signature({ executionViewKey: 'execution-1:queued' }),
        signature({ executionViewKey: 'execution-1:running' })
      )
    ).toBe(false)
    expect(
      transcriptRowRenderSignatureEqual(
        signature({ executionViewKey: 'execution-1:running' }),
        signature({ executionViewKey: 'execution-1:running' })
      )
    ).toBe(true)
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

  it('invalidates when an assistant speaker snapshot arrives after the bubble mounts', () => {
    const first: ChatMessage = {
      ...message,
      metadata: { assistantProvider: 'pi', providerModel: 'deepseek/deepseek-v4-flash' }
    }
    const changed: ChatMessage = {
      ...first,
      metadata: {
        ...first.metadata,
        providerModelLabel: 'DeepSeek V4 Flash',
        assistantReasoningEffort: 'ultratask'
      }
    }

    expect(transcriptMessageRenderSignature(changed)).not.toBe(
      transcriptMessageRenderSignature(first)
    )
  })

  it('invalidates a cached Task Complete card when late commit repair updates metadata only', () => {
    const first: ChatMessage = {
      ...message,
      role: 'system',
      content: 'Close-out content remains unchanged',
      metadata: {
        kind: 'taskWraithCloseout',
        closeoutScope: 'ensembleRound',
        closeoutRoundId: 'round-1',
        closeoutReceipt: {
          version: 1,
          targetId: 'round-1',
          scope: 'ensembleRound',
          status: 'completed',
          observedCommitCount: 0,
          observedChangedFileCount: 2
        }
      }
    }
    const repaired: ChatMessage = {
      ...first,
      metadata: {
        ...first.metadata,
        closeoutCommits: [
          {
            hash: 'a048ce5',
            subject: 'Repair persisted close-out commits',
            stats: '2 files, +212 -157',
            participantId: 'writer',
            files: [
              {
                path: 'src/renderer/src/lib/transcriptRowRenderCache.ts',
                additions: 12,
                deletions: 3,
                hunks: '@@ cache repair @@'
              }
            ]
          }
        ]
      }
    }

    expect(repaired.content).toBe(first.content)
    expect(
      transcriptRowRenderSignatureEqual(
        signature({ message: first, messageSignature: transcriptMessageRenderSignature(first) }),
        signature({
          message: repaired,
          messageSignature: transcriptMessageRenderSignature(repaired)
        })
      )
    ).toBe(false)
  })

  it('invalidates a cached Task Complete card when a sub-thread tombstone is refreshed', () => {
    const first: ChatMessage = {
      ...message,
      role: 'system',
      content: 'Close-out content remains unchanged',
      metadata: {
        kind: 'taskWraithCloseout',
        closeoutScope: 'run',
        sourceRunId: 'run-1',
        closeoutSubagentDelegations: [
          {
            subThreadId: 'child-1',
            identitySeed: 'child-1',
            title: 'Review the cache',
            provider: 'claude',
            parentProvider: 'codex',
            status: 'running',
            promptPreview: 'Find stale transcript rows.'
          }
        ]
      }
    }
    const refreshed: ChatMessage = {
      ...first,
      metadata: {
        ...first.metadata,
        closeoutSubagentDelegations: [
          {
            ...first.metadata!.closeoutSubagentDelegations![0],
            status: 'returned',
            promptPreview: 'Found and repaired stale transcript rows.'
          }
        ]
      }
    }

    expect(refreshed.content).toBe(first.content)
    expect(
      transcriptRowRenderSignatureEqual(
        signature({ message: first, messageSignature: transcriptMessageRenderSignature(first) }),
        signature({
          message: refreshed,
          messageSignature: transcriptMessageRenderSignature(refreshed)
        })
      )
    ).toBe(false)
  })

  it('uses a deterministic compact signature for complete close-out card metadata', () => {
    const hugeHunk = 'line\n'.repeat(4_000)
    const first: ChatMessage = {
      ...message,
      role: 'system',
      metadata: {
        kind: 'taskWraithCloseout',
        closeoutSource: 'summaryProvider',
        closeoutProvider: 'claude',
        closeoutModel: 'claude-opus-5',
        closeoutDurationMs: 63_000,
        closeoutParticipantTable: {
          totalWorkLabel: '1 turn',
          rows: [
            {
              participantId: 'writer',
              seatLink: {
                participantId: 'writer',
                before: { provider: 'claude', model: 'claude-opus-5' },
                after: { provider: 'claude', model: 'claude-opus-5' }
              },
              seatText: 'Claude / Writer',
              workLabel: '1 turn',
              status: 'answered',
              statusGlyphMarkdown: ':white_check_mark:'
            }
          ]
        },
        closeoutFileChanges: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 2 }],
        closeoutCommits: [
          {
            hash: '1234567890abcdef',
            subject: 'Keep cache fresh',
            files: [{ path: 'src/a.ts', hunks: hugeHunk }]
          }
        ],
        closeoutSubagentDelegations: [
          {
            subThreadId: 'child-1',
            identitySeed: 'child-1',
            title: 'Inspect close-out',
            provider: 'claude',
            status: 'completed'
          }
        ]
      }
    }
    const equivalent: ChatMessage = {
      ...first,
      metadata: {
        closeoutSubagentDelegations: first.metadata!.closeoutSubagentDelegations,
        closeoutCommits: first.metadata!.closeoutCommits,
        closeoutFileChanges: first.metadata!.closeoutFileChanges,
        closeoutParticipantTable: first.metadata!.closeoutParticipantTable,
        closeoutDurationMs: 63_000,
        closeoutModel: 'claude-opus-5',
        closeoutProvider: 'claude',
        closeoutSource: 'summaryProvider',
        kind: 'taskWraithCloseout'
      }
    }

    const firstSignature = transcriptMessageRenderSignature(first)
    expect(transcriptMessageRenderSignature(equivalent)).toBe(firstSignature)
    expect(firstSignature.length).toBeLessThan(1_500)
  })

  it('invalidates when a captured ensemble seat adds effort or thinking state', () => {
    const first: ChatMessage = {
      ...message,
      metadata: {
        ensembleProvider: 'kimi',
        ensembleModel: 'kimi-k2.7-code',
        ensembleSeatSnapshot: { provider: 'kimi', model: 'kimi-k2.7-code' }
      }
    }
    const changed: ChatMessage = {
      ...first,
      metadata: {
        ...first.metadata,
        ensembleThinkingEnabled: true,
        ensembleSeatSnapshot: {
          provider: 'kimi',
          model: 'kimi-k2.7-code',
          reasoningEffort: 'ultratask',
          thinkingEnabled: true
        }
      }
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

  it('invalidates when a Blackboard stack grows or changes disclosure state', () => {
    expect(
      transcriptRowRenderSignatureEqual(
        signature({ blackboardStackKey: 'first#1:2:closed:lead' }),
        signature({ blackboardStackKey: 'first#1:3:closed:lead' })
      )
    ).toBe(false)
    expect(
      transcriptRowRenderSignatureEqual(
        signature({ blackboardStackKey: 'first#1:3:closed:lead' }),
        signature({ blackboardStackKey: 'first#1:3:open:lead' })
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
