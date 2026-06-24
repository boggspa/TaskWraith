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

  it('shows no diff surface (the focused pane owns it)', () => {
    const p = buildChatViewProps(makeInput())
    expect(p.displayFileChangeSummaries).toEqual([])
    expect(p.fileChangeSummaryText).toBe('')
    expect(p.fileChangeShouldShowStats).toBe(false)
    expect(p.fileChangeDisplayAdds).toBe(0)
    expect(p.fileChangeDisplayDels).toBe(0)
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
    const queuedRunStatusByAppRunId = { 'run-1': 'steer_promoting' }
    const p = buildChatViewProps(
      makeInput({
        onInspectRun,
        onOpenSubThread,
        onCopyMessage,
        onPreviewImage,
        liveActivityViewport: true,
        queuedRunStatusByAppRunId
      })
    )
    expect(p.onInspectRun).toBe(onInspectRun)
    expect(p.onOpenSubThread).toBe(onOpenSubThread)
    expect(p.onCopyMessage).toBe(onCopyMessage)
    expect(p.onPreviewImage).toBe(onPreviewImage)
    expect(p.liveActivityViewport).toBe(true)
    expect(p.queuedRunStatusByAppRunId).toBe(queuedRunStatusByAppRunId)
  })
})
