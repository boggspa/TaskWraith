import { describe, expect, it, vi } from 'vitest'
import { buildChatViewProps, type BuildChatViewPropsInput } from './buildChatViewProps'

const ref = () => ({ current: null }) as BuildChatViewPropsInput['refs']['scrollRef']

const makeInput = (over: Partial<BuildChatViewPropsInput> = {}): BuildChatViewPropsInput => ({
  refs: { scrollRef: ref(), contentRef: ref(), endRef: ref() },
  chat: null,
  messages: [],
  provider: 'codex',
  providerLabel: 'Codex',
  isWelcomeChat: false,
  isThinking: false,
  runCompleteNotice: null,
  pendingAgentQuestions: [],
  chats: [],
  runningChatIds: [],
  compactDensity: false,
  copiedId: null,
  copy: vi.fn(),
  onOpenSubThread: vi.fn(),
  onCopyMessage: vi.fn(),
  onPreviewImage: vi.fn(),
  ...over
})

describe('buildChatViewProps (viewer policy)', () => {
  it('hard-disables interactive run/plan/agent affordances', () => {
    const p = buildChatViewProps(makeInput())
    expect(p.pendingPlanChoice).toBeNull()
    expect(p.runCompleteDurationText).toBeNull()
    expect(p.onPlanChoiceSubmit('m', 'o')).toBeUndefined()
    expect(p.onAgentQuestionSubmit('q', 'a', false)).toBeUndefined()
    expect(p.onAgentQuestionDismiss('q')).toBeUndefined()
    expect(p.onDeleteMessage('m')).toBeUndefined()
  })

  it('shows no file summary when this pane has no run evidence', () => {
    const p = buildChatViewProps(
      makeInput({
        messages: [
          {
            id: 'legacy-tool',
            role: 'tool',
            content: '',
            timestamp: '2026-07-13T04:46:16.000Z',
            toolActivities: [
              {
                id: 'legacy-write',
                toolName: 'write_file',
                displayName: 'Wrote file',
                category: 'write',
                status: 'success',
                parameters: { path: 'unowned.txt', content: 'unowned\n' }
              }
            ]
          }
        ]
      })
    )
    expect(p.displayFileChangeSummaries).toEqual([])
    expect(p.fileChangeSummaryText).toBe('')
    expect(p.fileChangeShouldShowStats).toBe(false)
    expect(p.fileChangeDisplayAdds).toBe(0)
    expect(p.fileChangeDisplayDels).toBe(0)
  })

  it('projects only this pane current run file changes', () => {
    const summary = {
      path: 'tw-multiview-test2-sentinel.txt',
      status: 'created',
      additions: 2,
      deletions: 0,
      previewKind: 'synthetic_new_file'
    }
    const p = buildChatViewProps(
      makeInput({
        currentWorkspacePath: '/Users/chrisizatt/Documents/Test 2',
        currentRun: {
          runDiff: {
            createdFiles: [summary],
            modifiedFiles: [],
            deletedFiles: []
          }
        } as unknown as BuildChatViewPropsInput['currentRun']
      })
    )
    expect(p.displayFileChangeSummaries).toEqual([summary])
    expect(p.fileChangeSummaryText).toBe('Created 1 · Edited 0 · Deleted 0')
    expect(p.fileChangeShouldShowStats).toBe(true)
    expect(p.fileChangeDisplayAdds).toBe(2)
    expect(p.fileChangeDisplayDels).toBe(0)
  })

  it('does not reuse another pane run summary', () => {
    const test2 = buildChatViewProps(
      makeInput({
        currentRun: {
          runDiff: {
            createdFiles: [{ path: 'test2.txt', status: 'created' }],
            modifiedFiles: [],
            deletedFiles: []
          }
        } as unknown as BuildChatViewPropsInput['currentRun']
      })
    )
    const test3 = buildChatViewProps(
      makeInput({
        currentRun: {
          runDiff: {
            createdFiles: [{ path: 'test3.txt', status: 'created' }],
            modifiedFiles: [],
            deletedFiles: []
          }
        } as unknown as BuildChatViewPropsInput['currentRun']
      })
    )
    expect(test2.displayFileChangeSummaries.map((item) => item.path)).toEqual(['test2.txt'])
    expect(test3.displayFileChangeSummaries.map((item) => item.path)).toEqual(['test3.txt'])
  })

  it('falls back to only the current run tool evidence when an exact diff is empty', () => {
    const toolMessage = (runId: string, path: string) => ({
      id: `tool-${runId}`,
      role: 'tool' as const,
      content: '',
      timestamp: '2026-07-13T04:46:16.000Z',
      runId,
      toolActivities: [
        {
          id: `write-${runId}`,
          toolName: 'write_file',
          displayName: 'Wrote file',
          category: 'write' as const,
          status: 'success' as const,
          parameters: { path, content: 'sentinel\n' },
          diffSummary: {
            additions: 1,
            deletions: 1,
            files: [{ path, status: 'modified' as const, additions: 1, deletions: 1 }],
            source: 'result_diff' as const,
            confidence: 'exact' as const
          }
        }
      ]
    })
    const p = buildChatViewProps(
      makeInput({
        currentWorkspacePath: '/Users/chrisizatt/Documents/Test 3',
        messages: [
          toolMessage('run-other', '/Users/chrisizatt/Documents/Test 2/test2.txt'),
          toolMessage('run-current', '/Users/chrisizatt/Documents/Test 3/test3.txt')
        ],
        currentRun: {
          runId: 'run-current',
          runDiff: { createdFiles: [], modifiedFiles: [], deletedFiles: [] }
        } as unknown as BuildChatViewPropsInput['currentRun']
      })
    )

    expect(p.displayFileChangeSummaries.map((item) => item.path)).toEqual(['test3.txt'])
    expect(p.fileChangeSummaryText).toBe('Created 0 · Edited 1 · Deleted 0 · live est.')
    expect(p.fileChangeDisplayAdds).toBe(1)
    expect(p.fileChangeDisplayDels).toBe(1)
  })

  it('keeps policy props at stable identities across calls (memo-safe)', () => {
    const a = buildChatViewProps(makeInput())
    const b = buildChatViewProps(makeInput())
    expect(a.displayFileChangeSummaries).toBe(b.displayFileChangeSummaries)
    expect(a.onPlanChoiceSubmit).toBe(b.onPlanChoiceSubmit)
    expect(a.onDeleteMessage).toBe(b.onDeleteMessage)
    expect(a.onAgentQuestionSubmit).toBe(b.onAgentQuestionSubmit)
  })

  it('passes per-chat values through unchanged', () => {
    const messages = [{ id: 'm1' }] as unknown as BuildChatViewPropsInput['messages']
    const notice = { timestamp: 't', exitCode: 0 }
    const copy = vi.fn()
    const p = buildChatViewProps(
      makeInput({
        messages,
        isThinking: true,
        provider: 'claude',
        providerLabel: 'Claude',
        runCompleteNotice: notice,
        copy,
        copiedId: 'm1'
      })
    )
    expect(p.messages).toBe(messages)
    expect(p.isThinking).toBe(true)
    expect(p.currentProvider).toBe('claude')
    expect(p.currentProviderLabel).toBe('Claude')
    expect(p.thinkingProvider).toBe('claude')
    expect(p.runCompleteNotice).toBe(notice)
    expect(p.copy).toBe(copy)
    expect(p.copiedId).toBe('m1')
  })

  it('forwards optional pass-throughs and functional viewer handlers', () => {
    const onInspectRun = vi.fn()
    const onOpenSubThread = vi.fn()
    const onCopyMessage = vi.fn()
    const onPreviewImage = vi.fn()
    const p = buildChatViewProps(
      makeInput({
        onInspectRun,
        onOpenSubThread,
        onCopyMessage,
        onPreviewImage,
        liveActivityViewport: true
      })
    )
    expect(p.onInspectRun).toBe(onInspectRun)
    expect(p.onOpenSubThread).toBe(onOpenSubThread)
    expect(p.onCopyMessage).toBe(onCopyMessage)
    expect(p.onPreviewImage).toBe(onPreviewImage)
    expect(p.liveActivityViewport).toBe(true)
  })
})
