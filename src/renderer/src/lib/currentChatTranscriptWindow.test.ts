import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { ChatMessage, ChatRecord, ChatRun } from '../../../main/store/types'
import {
  resolveCurrentChatTranscriptWindow,
  useCurrentChatTranscriptWindow
} from './currentChatTranscriptWindow'
import { ChatTranscriptStore } from './chatTranscriptStore'
import {
  bindChatTranscriptStore,
  resetChatTranscriptStoreBindingForTests
} from './useChatTranscript'

function message(id: string): ChatMessage {
  return { id, role: 'assistant', content: `content-${id}`, timestamp: '1' } as ChatMessage
}

function fullChat(ids: string[]): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Full',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: ids.map(message),
    runs: []
  } as ChatRecord
}

function pagedShell(): ChatRecord {
  return {
    ...fullChat([]),
    summaryOnly: true,
    messageCount: 2000,
    runCount: 0,
    transcriptPaged: true
  } as unknown as ChatRecord
}

describe('resolveCurrentChatTranscriptWindow', () => {
  it('returns the record arrays untouched for a fully hydrated chat', () => {
    const chat = fullChat(['m1', 'm2'])
    const resolved = resolveCurrentChatTranscriptWindow(chat, null)
    expect(resolved.paged).toBe(false)
    expect(resolved.messages).toBe(chat.messages)
    expect(resolved.runs).toBe(chat.runs)
    expect(resolved.hasOlder).toBe(false)
  })

  it('returns the store window — not the shell’s empty arrays — for a paged chat', () => {
    const windowMessages = [message('w1'), message('w2')]
    const windowRuns = [{ runId: 'r1', startedAt: '1' } as ChatRun]
    const resolved = resolveCurrentChatTranscriptWindow(pagedShell(), {
      messages: windowMessages,
      runs: windowRuns,
      hasOlder: true
    })
    expect(resolved.paged).toBe(true)
    expect(resolved.messages).toBe(windowMessages)
    expect(resolved.runs).toBe(windowRuns)
    expect(resolved.hasOlder).toBe(true)
  })

  it('a paged chat with no loaded page yet yields empty arrays marked paged (never the record)', () => {
    const resolved = resolveCurrentChatTranscriptWindow(pagedShell(), null)
    expect(resolved.paged).toBe(true)
    expect(resolved.messages).toEqual([])
    expect(resolved.hasOlder).toBe(false)
  })

  it('null chat yields an empty, non-paged window', () => {
    const resolved = resolveCurrentChatTranscriptWindow(null, null)
    expect(resolved).toEqual({ paged: false, hasOlder: false, messages: [], runs: [] })
  })
})

describe('useCurrentChatTranscriptWindow', () => {
  it('is exported as a function (hook binding exercised via store tests)', () => {
    expect(typeof useCurrentChatTranscriptWindow).toBe('function')
    // Binding hygiene for downstream tests that bind a store.
    const store = new ChatTranscriptStore()
    bindChatTranscriptStore(store)
    resetChatTranscriptStoreBindingForTests()
  })
})

describe('App.tsx read-path source scan (15 audited sites)', () => {
  const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  const mentionMenu = readFileSync(
    new URL('../components/AgentMentionMenu.tsx', import.meta.url),
    'utf8'
  )

  it.each([
    // Each pair: the OLD direct-read shape is gone, the NEW anchor exists.
    // Class W search — escalate-then-compute; the direct read became paged-aware:
    [
      'thread search',
      'const transcriptMessages = currentChat?.messages || EMPTY_CHAT_MESSAGES',
      'currentChatTranscript.paged'
    ],
    // Class T — window-fed sites:
    [
      'live output tokens',
      'for (const message of currentChat.messages || [])',
      'liveRunOutputTokens'
    ],
    [
      'side chat summary seed',
      '[...(currentChat?.messages || [])]\n      .reverse()',
      'sideChatSummarySeed'
    ],
    [
      'live tool file summary',
      'const messages = currentChat?.messages || EMPTY_CHAT_MESSAGES',
      'liveToolFileSummaryMessages'
    ],
    [
      'round file-change summaries',
      'selectRunEvidenceMessages(currentChat?.messages,',
      'roundFileChangeSummaries'
    ],
    [
      'closeout fingerprint',
      'messages: currentChat.messages,',
      'closeoutSubagentRefreshFingerprint'
    ]
  ])('site %s no longer reads the record’s raw arrays directly', (_name, oldShape, anchor) => {
    expect(source, `site anchor missing: ${anchor}`).toContain(anchor)
    expect(source, `stale direct read still present: ${oldShape}`).not.toContain(oldShape)
  })

  it('Class W ambient surfaces escalate to full hydration instead of computing from the page', () => {
    // The shared escalation effect: paged current chat → background full
    // hydration (covers search, pins, the composer-footprint context meter
    // #4/#13, and the mention menu via onRequestFullChat).
    expect(source).toContain(
      'if (!currentChatTranscript.paged) return\n    const chatId = currentChat?.appChatId'
    )
    expect(source).toContain('void refreshSingleChat(chatId)')
    // Pins still compute from the record — correct because the effect above
    // hydrates first; the page is never fed to buildPinnedMessageSummaries.
    expect(source).toContain('buildPinnedMessageSummaries(currentChat?.messages)')
  })

  it('compaction escalates before any provenance decision and keeps the lever visible on paged threads', () => {
    // #8/#9/#15: the in-callback escalation precedes every some(assistant)
    // branch inside compactChatContext.
    expect(source).toContain('chat = await refreshSingleChat(chat.appChatId)')
    const callbackStart = source.indexOf('const compactChatContext = useCallback(')
    const firstDecision = source.indexOf("some((m) => m.role === 'assistant')", callbackStart)
    const escalation = source.indexOf('isTranscriptPagedShell(chat)', callbackStart)
    expect(callbackStart).toBeGreaterThanOrEqual(0)
    expect(escalation).toBeGreaterThan(callbackStart)
    expect(escalation).toBeLessThan(firstDecision)
    // Visibility gate reads the window/older-history marker, not the shell.
    expect(source).toContain('currentChatHasAssistantMessage')
  })

  it('wires the shared window hook into App and the mention menu escalation prop', () => {
    expect(source).toContain('useCurrentChatTranscriptWindow(currentChat)')
    expect(mentionMenu).toContain('isTranscriptPagedShell(chat)')
    expect(mentionMenu).toContain('onRequestFullChat')
  })

  it('keeps the updateChatById-escalated run-diff site reading the hydrated updater source', () => {
    // #10 (run diff by path) is correct by construction: updateChatById
    // full-hydrates summary records before running the updater. Pin the shape.
    expect(source).toContain('buildRunDiffByPath(source.messages, grants,')
    expect(source).toContain('updateChatById(completedRunChatId, (source) =>')
  })
})
