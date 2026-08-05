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
    const source = readFileSync(new URL('../components/TranscriptPanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain('transcriptPanelPropsEqual')
    expect(source).not.toMatch(/previous\.currentChat === next\.currentChat/)
  })
})
