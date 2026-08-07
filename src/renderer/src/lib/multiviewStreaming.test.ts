import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { deriveChatIsRunning } from './chatRunDisplay'
import { buildChatViewProps, type BuildChatViewPropsInput } from './buildChatViewProps'
import {
  applySetFocusedPane,
  applySetLayout,
  applySetPaneChat,
  createInitialMultiviewState
} from '../hooks/useMultiviewState'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const paneSource = readFileSync(new URL('../components/ChatViewPane.tsx', import.meta.url), 'utf8')

/**
 * Integration cover for the review's top multi-pane risk: two chats streaming
 * AT THE SAME TIME in two panes. Exercises the real per-chat helpers
 * (deriveChatIsRunning + buildChatViewProps) and the layout transitions so a
 * regression that re-globalizes run state or crosses messages between panes
 * fails here. (resolveActiveRunContext itself was verified chatId-safe in the
 * design review; this pins the renderer-side derivations that feed the panes.)
 */
const chatA = {
  appChatId: 'A',
  provider: 'codex',
  messages: [{ id: 'a1' }, { id: 'a2' }],
  runs: []
} as unknown as ChatRecord
const chatB = {
  appChatId: 'B',
  provider: 'claude',
  messages: [{ id: 'b1' }],
  runs: []
} as unknown as ChatRecord

const refs = {
  scrollRef: { current: null },
  contentRef: { current: null },
  endRef: { current: null }
} as unknown as BuildChatViewPropsInput['refs']

const viewerInput = (chat: ChatRecord, running: ReadonlySet<string>): BuildChatViewPropsInput => ({
  refs,
  chat,
  messages: chat.messages,
  provider: chat.provider as BuildChatViewPropsInput['provider'],
  providerLabel: chat.provider ?? 'unknown',
  isWelcomeChat: false,
  isThinking: deriveChatIsRunning({ chat, runningChatIds: running }),
  runCompleteNotice: null,
  pendingAgentQuestions: [],
  chats: [chatA, chatB],
  runningChatIds: [...running],
  compactDensity: false,
  copiedId: null,
  copy: () => {},
  onOpenSubThread: () => {},
  onCopyMessage: () => {},
  onPreviewImage: () => {}
})

describe('two-pane simultaneous streaming', () => {
  const runningChatIds = new Set(['A', 'B']) // BOTH chats running at once

  it('reports both panes running simultaneously — per chat, not one global flag', () => {
    expect(deriveChatIsRunning({ chat: chatA, runningChatIds })).toBe(true)
    expect(deriveChatIsRunning({ chat: chatB, runningChatIds })).toBe(true)
  })

  it('each viewer renders only its own chat messages (no cross-contamination)', () => {
    const propsA = buildChatViewProps(viewerInput(chatA, runningChatIds))
    const propsB = buildChatViewProps(viewerInput(chatB, runningChatIds))
    expect(propsA.messages).toBe(chatA.messages)
    expect(propsB.messages).toBe(chatB.messages)
    expect(propsB.messages).not.toBe(chatA.messages)
    expect(propsA.isThinking).toBe(true)
    expect(propsB.isThinking).toBe(true)
  })

  it('only one chat is the focused/interactive one while both stream', () => {
    let s = createInitialMultiviewState('A')
    s = applySetLayout(s, 'vertical-2')
    s = applySetPaneChat(s, 1, 'B')
    s = applySetFocusedPane(s, 0)
    const focusedChatId = s.panes[s.focusedPaneIndex]?.chatId
    expect(focusedChatId).toBe('A')
    // Switching focus to B does not stop A streaming, and vice versa.
    s = applySetFocusedPane(s, 1)
    expect(s.panes[s.focusedPaneIndex]?.chatId).toBe('B')
    expect(deriveChatIsRunning({ chat: chatA, runningChatIds })).toBe(true)
    expect(deriveChatIsRunning({ chat: chatB, runningChatIds })).toBe(true)
  })

  it('a non-running pane stays idle while its neighbour streams', () => {
    const onlyA = new Set(['A'])
    expect(deriveChatIsRunning({ chat: chatA, runningChatIds: onlyA })).toBe(true)
    expect(deriveChatIsRunning({ chat: chatB, runningChatIds: onlyA })).toBe(false)
    expect(buildChatViewProps(viewerInput(chatB, onlyA)).isThinking).toBe(false)
  })

  it('passes pane-owned scroll and follow controls through without sharing identities', () => {
    const autoFollowRef = { current: false }
    const onManualTranscriptJump = () => {}
    const onJumpToLatest = () => {}
    const onProgrammaticScrollWrite = () => {}
    const getUserScrollGestureLive = () => false
    const props = buildChatViewProps({
      ...viewerInput(chatA, runningChatIds),
      autoFollowRef,
      getUserScrollGestureLive,
      externalRestoreAnchorMessageId: 'a1',
      onManualTranscriptJump,
      onJumpToLatest,
      onProgrammaticScrollWrite
    })

    expect(props.autoFollowRef).toBe(autoFollowRef)
    expect(props.getUserScrollGestureLive).toBe(getUserScrollGestureLive)
    expect(props.externalRestoreAnchorMessageId).toBe('a1')
    expect(props.onManualTranscriptJump).toBe(onManualTranscriptJump)
    expect(props.onJumpToLatest).toBe(onJumpToLatest)
    expect(props.onProgrammaticScrollWrite).toBe(onProgrammaticScrollWrite)
  })

  it('wires stable pane ownership through A→B→A rendering and focused-surface transfer', () => {
    expect(appSource).toContain('key={viewerPaneId || `pane-${viewerPaneIndex}`}')
    expect(appSource).toContain('incomingPaneRefs?.chatScrollStateByIdRef.current.get(chatId)')
    expect(appSource).toContain(
      'outgoingPaneRefs.chatScrollStateByIdRef.current.set(outgoingChatId, outgoingCachedScroll)'
    )
    expect(appSource).toContain('autoFollow: incomingCachedScroll.autoFollow')
    expect(paneSource).toContain('useTranscriptScrollState({')
    expect(paneSource).toContain('chatScrollStateByIdRef: props.refs.chatScrollStateByIdRef')
    expect(paneSource).toContain('setAutoFollowRef: props.refs.setAutoFollow')
    expect(paneSource).toContain(
      'props.refs.bindRelockToLatest(paneScrollState.relockToLatest)'
    )
  })
})
