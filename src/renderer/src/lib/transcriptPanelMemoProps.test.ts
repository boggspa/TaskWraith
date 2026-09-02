import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import {
  transcriptChatIdentityEqual,
  transcriptPanelPropsEqual,
  type TranscriptPanelMemoComparable
} from './transcriptPanelMemoProps'

function chat(title: string, messages: ChatRecord['messages']): ChatRecord {
  return {
    appChatId: 'chat-a',
    title,
    createdAt: 1,
    updatedAt: 10,
    archived: false,
    messages,
    runs: []
  }
}

function baseProps(
  overrides: Partial<TranscriptPanelMemoComparable> = {}
): TranscriptPanelMemoComparable {
  const messages: ChatRecord['messages'] = []
  const currentChat = chat('A', messages)
  return {
    scrollRef: { current: null },
    contentRef: { current: null },
    endRef: { current: null },
    messages,
    isWelcomeChat: false,
    isThinking: false,
    pendingPlanChoice: null,
    pendingProposedPlan: null,
    pendingAgentQuestions: [],
    onAgentQuestionSubmit: () => {},
    onAgentQuestionDismiss: () => {},
    runCompleteNotice: null,
    runCompleteDurationText: null,
    currentRun: null,
    currentChat,
    currentProviderLabel: 'Codex',
    currentProvider: 'codex',
    displayFileChangeSummaries: [],
    fileChangeSummaryText: '',
    fileChangeShouldShowStats: false,
    fileChangeDisplayAdds: 0,
    fileChangeDisplayDels: 0,
    chats: [currentChat],
    runningChatIds: [],
    onCopyMessage: () => {},
    onDeleteMessage: () => {},
    onPreviewImage: () => {},
    copiedId: null,
    copy: () => {},
    compactDensity: false,
    ...overrides
  }
}

describe('transcriptPanelMemoProps', () => {
  it('treats currentChat object-identity churn as equal when transcript identity matches', () => {
    const messages: ChatRecord['messages'] = []
    const left = chat('Same', messages)
    const right = { ...left }
    expect(left).not.toBe(right)
    expect(transcriptChatIdentityEqual(left, right)).toBe(true)
  })

  it('invalidates when messages reference changes', () => {
    const left = chat('Same', [])
    const right = chat('Same', [{ id: 'm', role: 'user', content: 'x', createdAt: 1 } as never])
    expect(transcriptChatIdentityEqual(left, right)).toBe(false)
  })

  it('does not require currentChat === for panel props equality', () => {
    const messages: ChatRecord['messages'] = []
    const currentChat = chat('A', messages)
    const shared = baseProps({ messages, currentChat, chats: [currentChat] })
    const nextChat = { ...currentChat }
    const next = { ...shared, currentChat: nextChat }
    expect(shared.currentChat).not.toBe(next.currentChat)
    expect(transcriptChatIdentityEqual(shared.currentChat, next.currentChat)).toBe(true)
    expect(transcriptPanelPropsEqual(shared, next)).toBe(true)
  })

  it('guards TranscriptPanel against currentChat === memo keying', () => {
    const source = readFileSync(
      new URL('../components/TranscriptPanel.tsx', import.meta.url),
      'utf8'
    )
    expect(source).toContain('transcriptPanelPropsEqual')
    expect(source).not.toMatch(/previous\.currentChat === next\.currentChat/)
  })

  it('invalidates when citation open or extract-resolve handler identity changes', () => {
    const shared = baseProps()
    const openA = () => undefined
    const openB = () => undefined
    const resolveA = () => null
    expect(
      transcriptPanelPropsEqual(shared, {
        ...shared,
        onOpenProjectReferenceCitation: openA,
        resolveProjectReferenceExtract: resolveA
      })
    ).toBe(false)
    expect(
      transcriptPanelPropsEqual(
        { ...shared, onOpenProjectReferenceCitation: openA },
        { ...shared, onOpenProjectReferenceCitation: openB }
      )
    ).toBe(false)
    expect(
      transcriptPanelPropsEqual(
        {
          ...shared,
          onOpenProjectReferenceCitation: openA,
          resolveProjectReferenceExtract: resolveA
        },
        {
          ...shared,
          onOpenProjectReferenceCitation: openA,
          resolveProjectReferenceExtract: resolveA
        }
      )
    ).toBe(true)
  })

  it('invalidates when fleet child pending approval maps or respond handler change', () => {
    const shared = baseProps()
    const respondA = () => undefined
    const respondB = () => undefined
    const approval = { id: 'apr-1' }
    expect(
      transcriptPanelPropsEqual(shared, {
        ...shared,
        pendingAgentApprovalByChatId: { 'child-1': approval as never }
      })
    ).toBe(false)
    expect(
      transcriptPanelPropsEqual(
        {
          ...shared,
          pendingAgentApprovalByChatId: { 'child-1': approval as never },
          pendingApprovalQueueByChatId: {},
          onRespondAgentApproval: respondA
        },
        {
          ...shared,
          pendingAgentApprovalByChatId: { 'child-1': approval as never },
          pendingApprovalQueueByChatId: {},
          onRespondAgentApproval: respondA
        }
      )
    ).toBe(true)
    expect(
      transcriptPanelPropsEqual(
        {
          ...shared,
          pendingAgentApprovalByChatId: { 'child-1': approval as never },
          onRespondAgentApproval: respondA
        },
        {
          ...shared,
          pendingAgentApprovalByChatId: { 'child-1': { id: 'apr-2' } as never },
          onRespondAgentApproval: respondA
        }
      )
    ).toBe(false)
    expect(
      transcriptPanelPropsEqual(
        { ...shared, onRespondAgentApproval: respondA },
        { ...shared, onRespondAgentApproval: respondB }
      )
    ).toBe(false)
    expect(
      transcriptPanelPropsEqual(
        {
          ...shared,
          pendingApprovalQueueByChatId: { 'child-1': [approval as never] }
        },
        {
          ...shared,
          pendingApprovalQueueByChatId: { 'child-1': [{ id: 'apr-2' } as never] }
        }
      )
    ).toBe(false)
  })

  it('invalidates on execution-only progress and control changes', () => {
    const shared = baseProps()
    const open = () => undefined
    const cancel = () => undefined
    const baseView = {
      executionId: 'execution-1',
      state: 'running',
      settled: false,
      counts: {
        total: 2,
        proposed: 1,
        queued: 1,
        running: 0,
        needsAction: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        settled: 0
      },
      cells: [
        { id: 'scout-1', status: 'queued', kind: 'solo_agent' },
        { id: 'scout-2', status: 'proposed', kind: 'solo_agent' }
      ]
    }
    const left = {
      ...shared,
      hasLiveOwnedExecution: true,
      ownedExecutionViews: [baseView],
      onOpenExecutionMapForThread: open,
      onCancelOwnedExecution: cancel
    }
    expect(
      transcriptPanelPropsEqual(left, { ...left, ownedExecutionViews: [{ ...baseView }] })
    ).toBe(true)
    expect(
      transcriptPanelPropsEqual(left, {
        ...left,
        ownedExecutionViews: [
          {
            ...baseView,
            counts: { ...baseView.counts, queued: 0, running: 1 },
            cells: [{ ...baseView.cells[0], status: 'working' }, baseView.cells[1]]
          }
        ]
      })
    ).toBe(false)
    expect(transcriptPanelPropsEqual(left, { ...left, hasLiveOwnedExecution: false })).toBe(false)
    expect(
      transcriptPanelPropsEqual(left, { ...left, onCancelOwnedExecution: () => undefined })
    ).toBe(false)
  })
})
