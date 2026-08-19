import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMultiviewPaneRefs } from '../hooks/useMultiviewState'
import { buildChatViewProps, type BuildChatViewPropsInput } from './buildChatViewProps'

// Counting the real cost directly: this is the call the 98ed6ce81 digest work
// was built to keep off the streaming path, and the pane builder reached it
// raw on every render, once per mounted pane.
const liveSummaryCalls = vi.fn()
vi.mock('./LiveFileDiffSummary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./LiveFileDiffSummary')>()
  return {
    ...actual,
    getLiveToolFileDiffSummaries: (
      ...args: Parameters<typeof actual.getLiveToolFileDiffSummaries>
    ) => {
      liveSummaryCalls(...args)
      return actual.getLiveToolFileDiffSummaries(...args)
    }
  }
})

type Input = BuildChatViewPropsInput

const RUN_ID = 'run-1'

const messages = [
  {
    id: 'tool-1',
    role: 'tool',
    content: '',
    timestamp: '2026-08-19T02:00:00.000Z',
    runId: RUN_ID,
    toolActivities: [
      {
        id: 'write-1',
        toolName: 'write_file',
        displayName: 'Wrote file',
        category: 'write',
        status: 'success',
        parameters: { path: 'pane-memo.txt', content: 'one\ntwo\n' }
      }
    ]
  }
] as unknown as Input['messages']

const chat = {
  appChatId: 'chat-memo',
  runs: [{ runId: RUN_ID, provider: 'codex' }]
} as unknown as Input['chat']

const currentRun = { runId: RUN_ID, provider: 'codex' } as unknown as Input['currentRun']

const makeInput = (over: Partial<Input> = {}): Input => ({
  refs: createMultiviewPaneRefs(),
  chat,
  messages,
  provider: 'codex',
  providerLabel: 'Codex',
  isWelcomeChat: false,
  isThinking: true,
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
  currentRun,
  currentWorkspacePath: '/tmp/pane-memo',
  ...over
})

describe('pane file-change memo', () => {
  beforeEach(() => {
    liveSummaryCalls.mockClear()
  })

  it('proves the fixture actually reaches the expensive path', () => {
    const props = buildChatViewProps(makeInput())
    expect(liveSummaryCalls.mock.calls.length).toBeGreaterThan(0)
    expect(props.displayFileChangeSummaries.length).toBeGreaterThan(0)
  })

  it('does not redo the live diff scan when a pane re-renders unchanged', () => {
    buildChatViewProps(makeInput())
    const afterFirst = liveSummaryCalls.mock.calls.length
    // Same chat, same messages array, same run: a re-render that changed
    // nothing this builder reads must cost nothing.
    buildChatViewProps(makeInput())
    buildChatViewProps(makeInput())
    expect(liveSummaryCalls.mock.calls.length).toBe(afterFirst)
  })

  it('hands back the same summary arrays so the transcript memo can bail', () => {
    // TranscriptPanel compares these by identity; a fresh array per render
    // forces a full regroup + re-window even when the content is identical.
    const first = buildChatViewProps(makeInput())
    const second = buildChatViewProps(makeInput())
    expect(second.displayFileChangeSummaries).toBe(first.displayFileChangeSummaries)
    expect(second.roundFileChangeSummaries).toBe(first.roundFileChangeSummaries)
  })

  it('recomputes when the transcript actually changes', () => {
    buildChatViewProps(makeInput())
    const afterFirst = liveSummaryCalls.mock.calls.length
    const grown = [
      ...(messages as unknown[]),
      {
        id: 'tool-2',
        role: 'tool',
        content: '',
        timestamp: '2026-08-19T02:00:01.000Z',
        runId: RUN_ID,
        toolActivities: [
          {
            id: 'write-2',
            toolName: 'write_file',
            displayName: 'Wrote file',
            category: 'write',
            status: 'success',
            parameters: { path: 'pane-memo-2.txt', content: 'three\n' }
          }
        ]
      }
    ] as unknown as Input['messages']
    const next = buildChatViewProps(makeInput({ messages: grown }))
    expect(liveSummaryCalls.mock.calls.length).toBeGreaterThan(afterFirst)
    expect(next.displayFileChangeSummaries.length).toBeGreaterThan(1)
  })

  it('keeps two panes on the same chat from evicting each other', () => {
    // Duplicate-chat panes differ only by workspace path; a single-entry cache
    // would thrash between them and recompute on every render for both.
    const paneA = makeInput({ currentWorkspacePath: '/tmp/pane-a' })
    const paneB = makeInput({ currentWorkspacePath: '/tmp/pane-b' })
    buildChatViewProps(paneA)
    buildChatViewProps(paneB)
    const afterWarm = liveSummaryCalls.mock.calls.length
    buildChatViewProps(paneA)
    buildChatViewProps(paneB)
    expect(liveSummaryCalls.mock.calls.length).toBe(afterWarm)
  })

  it('separates panes whose run differs on the same messages', () => {
    const other = { runId: 'run-2', provider: 'codex' } as unknown as Input['currentRun']
    buildChatViewProps(makeInput())
    const warm = liveSummaryCalls.mock.calls.length
    const different = buildChatViewProps(makeInput({ currentRun: other }))
    expect(liveSummaryCalls.mock.calls.length).toBeGreaterThan(warm)
    // run-2 has no evidence in this transcript.
    expect(different.displayFileChangeSummaries).toEqual([])
  })
})
