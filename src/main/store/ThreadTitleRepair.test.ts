import { describe, expect, it } from 'vitest'
import {
  appendThreadTitleRepairLedger,
  clearThreadTitleRepairFailure,
  defaultThreadTitleRepairStatePath,
  deriveThreadTitleFromTranscript,
  emptyThreadTitleRepairState,
  isRepairablePlaceholderTitle,
  isThreadTitleRepairBlocked,
  isThreadTitleRepairLedgerFull,
  isThreadTitleRepairTarget,
  MAX_TITLE_REPAIR_FAILURES_PER_CHAT,
  MAX_TITLE_REPAIR_LEDGER_ENTRIES,
  parseThreadTitleRepairState,
  recordThreadTitleRepairFailure,
  selectThreadTitleRepairCandidates,
  sliceRepairBatch,
  THREAD_TITLE_REPAIR_STATE_FILENAME,
  type ThreadTitleRepairState
} from './ThreadTitleRepair'
import type { ChatListItem, ChatMessage, ChatRecord } from './types'

function item(overrides: Partial<ChatListItem>): ChatListItem {
  return {
    appChatId: 'chat-1',
    title: 'New Chat',
    messages: [],
    runs: [],
    summaryOnly: true,
    messageCount: 4,
    runCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as unknown as ChatListItem
}

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'hello',
    timestamp: '2026-08-29T00:00:00.000Z',
    ...overrides
  } as ChatMessage
}

function record(overrides: Partial<ChatRecord>): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'New Chat',
    messages: [],
    runs: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as unknown as ChatRecord
}

describe('thread title repair candidate selection', () => {
  it('selects a placeholder-titled thread that already has messages', () => {
    const candidates = selectThreadTitleRepairCandidates(
      [item({ appChatId: 'chat-a', title: 'New Chat', messageCount: 12 })],
      emptyThreadTitleRepairState()
    )
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ chatId: 'chat-a', placeholderTitle: 'New Chat' })
  })

  it('excludes an empty thread, keeping the pass disjoint from the first-prompt gates', () => {
    // Both live gates fire only while messages.length === 0. If this pass could
    // reach one of those threads the two mechanisms would race on the same
    // record and neither test suite could tell which one titled it.
    const candidates = selectThreadTitleRepairCandidates(
      [
        item({ appChatId: 'empty', title: 'New Chat', messageCount: 0 }),
        item({ appChatId: 'started', title: 'New Chat', messageCount: 1 })
      ],
      emptyThreadTitleRepairState()
    )
    expect(candidates.map((candidate) => candidate.chatId)).toEqual(['started'])
  })

  it('never widens past the shared placeholder set', () => {
    const candidates = selectThreadTitleRepairCandidates(
      [
        item({ appChatId: 'placeholder', title: 'New Ensemble' }),
        item({ appChatId: 'authored', title: 'Persistence review' }),
        item({ appChatId: 'subthread', title: 'Sub-thread (codex)' }),
        item({ appChatId: 'sidechat', title: 'Isolated side chat' }),
        item({ appChatId: 'lowercase', title: 'New chat' }),
        item({ appChatId: 'fork', title: 'Fork of crab research' }),
        item({ appChatId: 'prefixed', title: 'New Chat about crabs' })
      ],
      emptyThreadTitleRepairState()
    )
    // Assert the positive first: a "none of these leaked in" claim over an
    // empty array would pass with the whole filter deleted.
    expect(candidates.map((candidate) => candidate.chatId)).toEqual(['placeholder'])
  })

  it('excludes an empty title, which no rename could restore', () => {
    const candidates = selectThreadTitleRepairCandidates(
      [
        item({ appChatId: 'blank', title: '   ' }),
        item({ appChatId: 'placeholder', title: 'New Workflow' })
      ],
      emptyThreadTitleRepairState()
    )
    expect(candidates.map((candidate) => candidate.chatId)).toEqual(['placeholder'])
  })

  it('excludes a chat that has already failed its retry ceiling', () => {
    const state: ThreadTitleRepairState = {
      ...emptyThreadTitleRepairState(),
      failures: { quarantined: MAX_TITLE_REPAIR_FAILURES_PER_CHAT }
    }
    const candidates = selectThreadTitleRepairCandidates(
      [item({ appChatId: 'quarantined' }), item({ appChatId: 'fresh' })],
      state
    )
    expect(candidates.map((candidate) => candidate.chatId)).toEqual(['fresh'])
  })

  it('repairs oldest first so saveChat updatedAt bumps preserve relative order', () => {
    const candidates = selectThreadTitleRepairCandidates(
      [
        item({ appChatId: 'newest', updatedAt: 300 }),
        item({ appChatId: 'oldest', updatedAt: 100 }),
        item({ appChatId: 'middle', updatedAt: 200 })
      ],
      emptyThreadTitleRepairState()
    )
    expect(candidates.map((candidate) => candidate.chatId)).toEqual(['oldest', 'middle', 'newest'])
  })

  it('takes the record size from the index when it vouched', () => {
    const candidates = selectThreadTitleRepairCandidates(
      [item({ appChatId: 'sized', sourceChatSize: 4096 }), item({ appChatId: 'unsized' })],
      emptyThreadTitleRepairState()
    )
    expect(candidates.map((candidate) => candidate.approxBytes)).toEqual([4096, 0])
  })
})

describe('repairable placeholder titles', () => {
  it('accepts the create-factory placeholders and rejects an empty title', () => {
    expect(isRepairablePlaceholderTitle('New Chat')).toBe(true)
    expect(isRepairablePlaceholderTitle('  New   Ensemble ')).toBe(true)
    expect(isRepairablePlaceholderTitle('')).toBe(false)
    expect(isRepairablePlaceholderTitle('   ')).toBe(false)
    expect(isRepairablePlaceholderTitle(null)).toBe(false)
    expect(isRepairablePlaceholderTitle('Persistence review')).toBe(false)
  })

  it('re-checks the freshly read record before a write', () => {
    expect(isThreadTitleRepairTarget(record({ messages: [message({})] }))).toBe(true)
    expect(
      isThreadTitleRepairTarget(record({ title: 'Real title', messages: [message({})] }))
    ).toBe(false)
    expect(isThreadTitleRepairTarget(record({ messages: [] }))).toBe(false)
  })
})

describe('thread title derivation', () => {
  it('derives from the first user message, whitespace collapsed and without an ellipsis', () => {
    const title = deriveThreadTitleFromTranscript(
      record({
        messages: [
          message({ id: 'a', role: 'assistant', content: 'Ready when you are' }),
          message({ id: 'b', role: 'user', content: '  Explain   the\nbarrier  ' })
        ]
      })
    )
    expect(title).toBe('Explain the barrier')
  })

  it('caps at the shared title length and adds no ellipsis', () => {
    const title = deriveThreadTitleFromTranscript(
      record({ messages: [message({ content: 'A'.repeat(400) })] })
    )
    expect(title).toHaveLength(160)
    expect(title?.endsWith('...')).toBe(false)
  })

  it('returns null rather than deriving from an empty first message', () => {
    expect(
      deriveThreadTitleFromTranscript(record({ messages: [message({ content: '   ' })] }))
    ).toBe(null)
    expect(
      deriveThreadTitleFromTranscript(
        record({ messages: [message({ role: 'assistant', content: 'no user turn here' })] })
      )
    ).toBe(null)
    expect(deriveThreadTitleFromTranscript(record({ messages: [] }))).toBe(null)
  })

  it('skips retired external-gateway rows that persist as user turns', () => {
    const title = deriveThreadTitleFromTranscript(
      record({
        messages: [
          message({
            id: 'gateway',
            content: 'inbound gateway text',
            metadata: { kind: 'channelInbound' }
          }),
          message({ id: 'human', content: 'the real first prompt' })
        ]
      })
    )
    expect(title).toBe('the real first prompt')
  })
})

describe('repair liveness gate', () => {
  it('defers only on in-memory run liveness, never on persisted round residue', () => {
    // A months-old record can still carry ensemble.activeRound: it survives
    // restart by design. Gating on the record would refuse those threads
    // forever, so the gate must read only the live run manager.
    const stale = record({
      messages: [message({})],
      ensemble: { activeRound: { id: 'round-1' } },
      runs: [{ id: 'run-1', status: 'running' }]
    } as unknown as Partial<ChatRecord>)
    expect(isThreadTitleRepairBlocked(stale, false)).toBe(false)
    expect(isThreadTitleRepairBlocked(stale, true)).toBe(true)
  })
})

describe('repair slicing', () => {
  it('caps a slice by record count', () => {
    const candidates = Array.from({ length: 20 }, (_unused, index) => ({
      chatId: `chat-${index}`,
      placeholderTitle: 'New Chat',
      messageCount: 1,
      updatedAt: index,
      approxBytes: 1024
    }))
    expect(sliceRepairBatch(candidates)).toHaveLength(8)
  })

  it('caps a slice by bytes but always admits the first candidate', () => {
    const huge = {
      chatId: 'huge',
      placeholderTitle: 'New Chat',
      messageCount: 1,
      updatedAt: 1,
      approxBytes: 38 * 1024 * 1024
    }
    const next = { ...huge, chatId: 'next', updatedAt: 2 }
    // The largest real candidate exceeds the whole slice budget on its own; a
    // strictly enforced budget would leave it unrepairable forever.
    expect(sliceRepairBatch([huge, next]).map((candidate) => candidate.chatId)).toEqual(['huge'])
  })
})

describe('repair state', () => {
  it('counts failures per chat and clears them on success', () => {
    let state = emptyThreadTitleRepairState()
    state = recordThreadTitleRepairFailure(state, 'chat-a')
    state = recordThreadTitleRepairFailure(state, 'chat-a')
    expect(state.failures['chat-a']).toBe(2)
    state = clearThreadTitleRepairFailure(state, 'chat-a')
    expect(state.failures['chat-a']).toBeUndefined()
  })

  it('treats a full ledger as a stop condition rather than dropping the undo record', () => {
    const entries = Array.from({ length: MAX_TITLE_REPAIR_LEDGER_ENTRIES }, (_unused, index) => ({
      chatId: `chat-${index}`,
      previousTitle: 'New Chat',
      derivedTitle: `title ${index}`,
      at: index
    }))
    const full: ThreadTitleRepairState = { ...emptyThreadTitleRepairState(), entries }
    expect(isThreadTitleRepairLedgerFull(full)).toBe(true)
    expect(isThreadTitleRepairLedgerFull(emptyThreadTitleRepairState())).toBe(false)
    // The oldest entry is the one a user is least likely to remember approving,
    // so it must survive rather than be evicted.
    const appended = appendThreadTitleRepairLedger(full, {
      chatId: 'chat-new',
      previousTitle: 'New Chat',
      derivedTitle: 'new title',
      at: 1
    })
    expect(appended.entries[0].chatId).toBe('chat-0')
  })

  it('keeps the state file out of the chat record directory', () => {
    const path = defaultThreadTitleRepairStatePath('/profile/userData')
    expect(path).toBe(`/profile/userData/${THREAD_TITLE_REPAIR_STATE_FILENAME}`)
    // A non-chat entry under chats/ makes the Host's sweep throw, which aborts
    // the listing for every thread in the corpus.
    expect(path).not.toContain('/chats/')
  })

  it('falls back to empty state for an unreadable or older state file', () => {
    expect(parseThreadTitleRepairState(null).attempts).toBe(0)
    expect(parseThreadTitleRepairState({ version: 999, attempts: 7 }).attempts).toBe(0)
    const parsed = parseThreadTitleRepairState({
      version: 1,
      attempts: 3,
      repaired: 2,
      lastDrainAt: 5,
      failures: { 'chat-a': 2, 'chat-b': 'nonsense' },
      entries: [{ chatId: 'chat-a', previousTitle: 'New Chat', derivedTitle: 'x', at: 1 }, null]
    })
    expect(parsed.attempts).toBe(3)
    expect(parsed.failures).toEqual({ 'chat-a': 2 })
    expect(parsed.entries).toHaveLength(1)
  })
})
