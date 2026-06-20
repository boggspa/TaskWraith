import { describe, expect, it, vi } from 'vitest'
import { chatViewPanePropsEqual, type ChatViewPaneProps } from './ChatViewPane'

const ref = () => ({ current: null }) as ChatViewPaneProps['refs']['scrollRef']

const sharedRefs = { scrollRef: ref(), contentRef: ref(), endRef: ref() }
const sharedCopy = vi.fn()
const sharedOpenSub = vi.fn()
const sharedCopyMsg = vi.fn()
const sharedPreview = vi.fn()
const sharedFocus = vi.fn()
// Shared empties so two makeProps() calls are reference-identical where the
// comparator actually looks (messages, pendingAgentQuestions).
const EMPTY_MESSAGES = [] as ChatViewPaneProps['messages']
const EMPTY_QUESTIONS = [] as ChatViewPaneProps['pendingAgentQuestions']
const EMPTY_CHATS = [] as ChatViewPaneProps['chats']
const EMPTY_RUNNING = [] as ChatViewPaneProps['runningChatIds']

const makeProps = (over: Partial<ChatViewPaneProps> = {}): ChatViewPaneProps => ({
  refs: sharedRefs,
  chat: null,
  paneIndex: 1,
  messages: EMPTY_MESSAGES,
  provider: 'codex',
  providerLabel: 'Codex',
  isWelcomeChat: false,
  isThinking: false,
  runCompleteNotice: null,
  pendingAgentQuestions: EMPTY_QUESTIONS,
  chats: EMPTY_CHATS,
  runningChatIds: EMPTY_RUNNING,
  compactDensity: false,
  copiedId: null,
  copy: sharedCopy,
  onOpenSubThread: sharedOpenSub,
  onCopyMessage: sharedCopyMsg,
  onPreviewImage: sharedPreview,
  interfaceStyle: 'cursor',
  providerClass: 'codex',
  onFocusPane: sharedFocus,
  ...over
})

describe('chatViewPanePropsEqual', () => {
  it('treats identical props as equal (skip render)', () => {
    expect(chatViewPanePropsEqual(makeProps(), makeProps())).toBe(true)
  })

  it('skips re-render when only the high-churn shared arrays change identity', () => {
    // The whole point: a token in another pane re-creates chats/runningChatIds
    // every frame, but this pane's own messages are unchanged -> no reconcile.
    const a = makeProps({ chats: [], runningChatIds: [] })
    const b = makeProps({ chats: [], runningChatIds: [] }) // fresh arrays, same content
    expect(a.chats).not.toBe(b.chats)
    expect(chatViewPanePropsEqual(a, b)).toBe(true)
  })

  it('re-renders when this pane’s own messages change', () => {
    const messages = [{ id: 'm1' }] as unknown as ChatViewPaneProps['messages']
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ messages }))).toBe(false)
  })

  it('re-renders on run-state, copy-feedback, and appearance changes', () => {
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ isThinking: true }))).toBe(false)
    expect(
      chatViewPanePropsEqual(
        makeProps(),
        makeProps({ runCompleteNotice: { timestamp: 't', exitCode: 0 } })
      )
    ).toBe(false)
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ copiedId: 'm1' }))).toBe(false)
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ interfaceStyle: 'codex' }))).toBe(false)
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ providerClass: 'claude' }))).toBe(false)
  })

  it('re-renders when the chat record identity changes', () => {
    const chat = { appChatId: 'c2' } as unknown as ChatViewPaneProps['chat']
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ chat }))).toBe(false)
  })

  it('re-renders when a viewer is reused for a different pane index', () => {
    expect(chatViewPanePropsEqual(makeProps(), makeProps({ paneIndex: 2 }))).toBe(false)
  })
})
