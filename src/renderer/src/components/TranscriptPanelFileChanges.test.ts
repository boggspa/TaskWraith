import { describe, expect, it } from 'vitest'
import type { ChatRecord, DiffFileSummary } from '../../../main/store/types'
import {
  buildFileChangeSummaryWindow,
  FILE_CHANGE_SUMMARY_COLLAPSED_LIMIT,
  FILE_CHANGE_SUMMARY_MAX_VISIBLE,
  FILE_CHANGE_SUMMARY_PAGE_SIZE,
  transcriptAuxiliaryChatsSignature,
  transcriptRunningChatIdsSignature
} from './TranscriptPanel'

const makeSummaries = (count: number): DiffFileSummary[] =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/file-${String(index).padStart(3, '0')}.ts`,
    status: 'modified',
    additions: 1,
    deletions: 0,
    previewKind: 'none'
  }))

describe('buildFileChangeSummaryWindow', () => {
  it('starts collapsed and exposes the next bounded page size', () => {
    const window = buildFileChangeSummaryWindow(makeSummaries(30))

    expect(window.items).toHaveLength(FILE_CHANGE_SUMMARY_COLLAPSED_LIMIT)
    expect(window.hiddenCount).toBe(18)
    expect(window.canShowMore).toBe(true)
    expect(window.canShowFewer).toBe(false)
    expect(window.nextShowCount).toBe(18)
  })

  it('pages forward without jumping past the configured page size', () => {
    const window = buildFileChangeSummaryWindow(makeSummaries(90), 36)

    expect(window.visibleCount).toBe(36)
    expect(window.nextCount).toBe(36 + FILE_CHANGE_SUMMARY_PAGE_SIZE)
    expect(window.nextShowCount).toBe(FILE_CHANGE_SUMMARY_PAGE_SIZE)
    expect(window.canShowFewer).toBe(true)
  })

  it('caps extremely large summaries so expansion does not mount unbounded rows', () => {
    const window = buildFileChangeSummaryWindow(makeSummaries(200), 200)

    expect(window.visibleCount).toBe(FILE_CHANGE_SUMMARY_MAX_VISIBLE)
    expect(window.items).toHaveLength(FILE_CHANGE_SUMMARY_MAX_VISIBLE)
    expect(window.hiddenCount).toBe(80)
    expect(window.canShowMore).toBe(false)
    expect(window.canShowFewer).toBe(true)
  })
})

describe('transcript memo input signatures', () => {
  const makeChat = (patch: Partial<ChatRecord> = {}): ChatRecord =>
    ({
      appChatId: 'chat-a',
      title: 'Chat A',
      chatKind: 'single',
      provider: 'codex',
      createdAt: 0,
      updatedAt: 100,
      messages: [],
      runs: [],
      ...patch
    }) as ChatRecord

  it('ignores transcript-only message churn from unrelated chats', () => {
    const before = [
      makeChat({
        messages: [{ id: 'm1', role: 'assistant', content: 'old', timestamp: 't0' }]
      })
    ]
    const after = [
      makeChat({
        messages: [{ id: 'm1', role: 'assistant', content: 'streamed token', timestamp: 't0' }]
      })
    ]

    expect(transcriptAuxiliaryChatsSignature(after)).toBe(
      transcriptAuxiliaryChatsSignature(before)
    )
  })

  it('changes when delegation-visible sub-thread state changes', () => {
    const before = [
      makeChat({
        runs: [{ runId: 'r1', status: 'running', startedAt: 't0' } as ChatRecord['runs'][number]]
      })
    ]
    const after = [
      makeChat({
        runs: [
          {
            runId: 'r1',
            status: 'success',
            startedAt: 't0',
            endedAt: 't1'
          } as ChatRecord['runs'][number]
        ]
      })
    ]

    expect(transcriptAuxiliaryChatsSignature(after)).not.toBe(
      transcriptAuxiliaryChatsSignature(before)
    )
  })

  it('treats running chat ids as a stable set', () => {
    expect(transcriptRunningChatIdsSignature(['side', 'main', 'side'])).toBe(
      transcriptRunningChatIdsSignature(['main', 'side'])
    )
  })
})
