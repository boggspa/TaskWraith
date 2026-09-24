import { describe, expect, it, vi } from 'vitest'
import type {
  ChatListItem,
  ChatMessage,
  ChatRecord,
  ChatRun,
  EnsembleConfig,
  EnsembleParticipant
} from './types'
import { assertAuthoritativeChatForSave } from './assertAuthoritativeChatForSave'
import { escalateSummaryChatForSave, isEscalatableSummaryChat } from './escalateSummaryChatForSave'

const BRIEF = 'SEAT-BRIEF-MARKER'

function message(index: number): ChatMessage {
  return {
    id: `m-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `content ${index}`,
    timestamp: '2026-09-01T00:00:00.000Z'
  }
}

function run(index: number, status: 'completed' | 'running' = 'completed'): ChatRun {
  return {
    runId: `run-${index}`,
    provider: 'claude',
    startedAt: '2026-09-01T00:00:00.000Z',
    ...(status === 'completed' ? { endedAt: '2026-09-01T00:01:00.000Z' } : {}),
    status
  }
}

function seat(
  index: number,
  instructions = `${BRIEF} brief for seat ${index}`
): EnsembleParticipant {
  return {
    id: `ensemble-participant-${index}`,
    provider: 'claude',
    enabled: true,
    role: `Role ${index}`,
    instructions,
    order: index
  } as EnsembleParticipant
}

function roster(participants: EnsembleParticipant[]): EnsembleConfig {
  return { enabled: true, maxParticipants: 50, participants } as unknown as EnsembleConfig
}

function canonicalChat(messageCount = 2000): ChatRecord {
  return {
    appChatId: 'chat-escalate',
    provider: 'claude',
    title: 'Canonical title',
    scope: 'global',
    chatKind: 'ensemble',
    createdAt: 1,
    updatedAt: 10,
    persistenceRevision: 7,
    archived: false,
    ensemble: roster([seat(1), seat(2), seat(3)]),
    ollamaSessionMemory: { summary: 'solo memory' },
    ollamaSessionMemories: { 'ensemble-participant-1': { summary: 'seat memory' } },
    messages: Array.from({ length: messageCount }, (_, index) => message(index)),
    runs: [run(1), run(2), run(3, 'running')]
  } as unknown as ChatRecord
}

type ShellOverrides = Partial<ChatRecord> & Record<string, unknown>

/** `buildChatShell` (chatTranscriptPageHandlers.ts): full chrome + counts +
 *  last run + the paged marker. */
function pagedShell(chat: ChatRecord, overrides: ShellOverrides = {}): ChatRecord {
  const { messages, runs, ...chrome } = chat
  return {
    ...chrome,
    messages: [],
    runs: [],
    summaryOnly: true,
    messageCount: messages.length,
    runCount: runs.length,
    lastRun: runs[runs.length - 1],
    transcriptPaged: true,
    ...overrides
  } as unknown as ChatRecord
}

/** `demoteChatToSummary` (chatByteLru.ts): same spread, no paged marker. */
function demotedRow(chat: ChatRecord, overrides: ShellOverrides = {}): ChatRecord {
  const { transcriptPaged: _transcriptPaged, ...row } = pagedShell(
    chat,
    overrides
  ) as ChatRecord & {
    transcriptPaged?: true
  }
  return row as ChatRecord
}

/** `normalizeChatListItem` / `toChatListItem` (store): sheds the jumbo
 *  session-memory fields and adds the index-only projection fields. */
function listRow(chat: ChatRecord, overrides: ShellOverrides = {}): ChatRecord {
  const {
    ollamaSessionMemory: _memory,
    ollamaSessionMemories: _memories,
    ...rest
  } = demotedRow(chat) as ChatRecord & { ollamaSessionMemory?: unknown }
  return {
    ...rest,
    runsSummary: chat.runs.map((row) => ({ runId: row.runId })),
    searchText: 'canonical title claude chat-escalate',
    searchPreview: 'content 1999',
    sourceChatMtimeMs: 123,
    sourceChatSize: 456,
    ...overrides
  } as unknown as ChatRecord
}

const PROJECTION_FIELDS = [
  'summaryOnly',
  'transcriptPaged',
  'messageCount',
  'runCount',
  'lastRun',
  'runsSummary',
  'searchText',
  'searchPreview',
  'sourceChatMtimeMs',
  'sourceChatSize'
] as const

function expectNoProjectionFields(record: ChatRecord): void {
  // Explicit per-field, over a constant list — never a possibly-empty one.
  expect(PROJECTION_FIELDS).toHaveLength(10)
  for (const field of PROJECTION_FIELDS) {
    expect(record, `${field} leaked onto the escalated record`).not.toHaveProperty(field)
  }
}

describe('isEscalatableSummaryChat', () => {
  it('recognises every summary producer shape and nothing else', () => {
    const canonical = canonicalChat(4)
    expect(isEscalatableSummaryChat(pagedShell(canonical))).toBe(true)
    expect(isEscalatableSummaryChat(demotedRow(canonical))).toBe(true)
    expect(isEscalatableSummaryChat(listRow(canonical))).toBe(true)
    // Absent arrays count as empty (a structured-clone-stripped shell).
    const { messages: _m, runs: _r, ...withoutArrays } = pagedShell(canonical)
    expect(isEscalatableSummaryChat(withoutArrays as ChatRecord)).toBe(true)

    expect(isEscalatableSummaryChat(canonical)).toBe(false)
    expect(isEscalatableSummaryChat({ ...canonical, summaryOnly: false } as ChatRecord)).toBe(false)
    expect(
      isEscalatableSummaryChat(pagedShell(canonical, { messages: canonical.messages.slice(-2) }))
    ).toBe(false)
    expect(isEscalatableSummaryChat(pagedShell(canonical, { runs: [run(9)] }))).toBe(false)
  })
})

describe('escalateSummaryChatForSave', () => {
  it('returns a full record untouched by reference without consulting the canonical read', () => {
    const canonical = canonicalChat(4)
    const incoming = { ...canonical, title: 'Renamed' }
    const readCanonical = vi.fn(() => canonical)

    expect(escalateSummaryChatForSave(incoming, readCanonical)).toBe(incoming)
    expect(readCanonical).not.toHaveBeenCalled()
  })

  it('leaves a summary create (no canonical record) to the fence', () => {
    const shell = pagedShell(canonicalChat(4))
    const readCanonical = vi.fn(() => null)

    expect(escalateSummaryChatForSave(shell, readCanonical)).toBe(shell)
    expect(readCanonical).toHaveBeenCalledTimes(1)
    expect(readCanonical).toHaveBeenCalledWith('chat-escalate')
  })

  it('leaves a marked record that still carries transcript rows to the fence', () => {
    const canonical = canonicalChat(6)
    const readCanonical = vi.fn(() => canonical)
    const withMessages = pagedShell(canonical, { messages: canonical.messages.slice(-3) })
    const withRuns = pagedShell(canonical, { runs: [run(1)] })

    expect(escalateSummaryChatForSave(withMessages, readCanonical)).toBe(withMessages)
    expect(escalateSummaryChatForSave(withRuns, readCanonical)).toBe(withRuns)
    expect(readCanonical).not.toHaveBeenCalled()
  })

  it('cannot borrow transcript authority from a canonical that is itself a summary', () => {
    const canonical = canonicalChat(4)
    const shell = pagedShell(canonical)
    expect(escalateSummaryChatForSave(shell, () => demotedRow(canonical))).toBe(shell)
  })

  it('rebuilds a paged shell onto the canonical transcript under the shell chrome', () => {
    const canonical = canonicalChat(2000)
    const shell = pagedShell(canonical, {
      title: 'Renamed on a paged open',
      archived: true,
      // A stale revision from when the shell was projected: never persisted.
      persistenceRevision: 5,
      ensemble: roster([seat(1), seat(2, `${BRIEF} edited brief`), seat(4)])
    })

    const escalated = escalateSummaryChatForSave(shell, () => canonical)

    expect(escalated).not.toBe(shell)
    // Transcript authority is the canonical record's, shared by reference.
    expect(escalated.messages).toBe(canonical.messages)
    expect(escalated.runs).toBe(canonical.runs)
    expect(escalated.messages).toHaveLength(2000)
    // Chrome is the shell's live intent.
    expect(escalated.title).toBe('Renamed on a paged open')
    expect(escalated.archived).toBe(true)
    expect(escalated.ensemble?.participants.map((participant) => participant.id)).toEqual([
      'ensemble-participant-1',
      'ensemble-participant-2',
      'ensemble-participant-4'
    ])
    expect(escalated.ensemble?.participants[1]?.instructions).toBe(`${BRIEF} edited brief`)
    // Fields the shell carried through its chrome spread survive.
    expect(escalated.ollamaSessionMemories).toEqual(canonical.ollamaSessionMemories)
    // The persistence revision is main's counter, not the shell's stale copy.
    expect(escalated.persistenceRevision).toBe(7)
    expectNoProjectionFields(escalated)
    // The caller's object is never mutated.
    expect((shell as Partial<ChatListItem>).summaryOnly).toBe(true)
    expect(shell.messages).toEqual([])
  })

  it('rebuilds an LRU-demoted summary row (no paged marker) the same way', () => {
    const canonical = canonicalChat(300)
    const row = demotedRow(canonical, { title: 'Renamed after demotion', pinned: true })

    const escalated = escalateSummaryChatForSave(row, () => canonical)

    expect(escalated.messages).toBe(canonical.messages)
    expect(escalated.runs).toBe(canonical.runs)
    expect(escalated.title).toBe('Renamed after demotion')
    expect(escalated.pinned).toBe(true)
    expect(escalated.persistenceRevision).toBe(7)
    expectNoProjectionFields(escalated)
  })

  it('restores the jumbo fields a list row shed, but honours an explicit deletion', () => {
    const canonical = canonicalChat(40)

    const fromRow = escalateSummaryChatForSave(
      listRow(canonical, { title: 'Renamed from a list row' }),
      () => canonical
    )
    expect(fromRow.title).toBe('Renamed from a list row')
    expect(fromRow.messages).toBe(canonical.messages)
    expect(fromRow.ollamaSessionMemory).toEqual(canonical.ollamaSessionMemory)
    expect(fromRow.ollamaSessionMemories).toEqual(canonical.ollamaSessionMemories)
    expectNoProjectionFields(fromRow)

    const deleting = escalateSummaryChatForSave(
      demotedRow(canonical, { ollamaSessionMemory: undefined }),
      () => canonical
    )
    expect('ollamaSessionMemory' in deleting).toBe(true)
    expect(deleting.ollamaSessionMemory).toBeUndefined()
    expect(deleting.ollamaSessionMemories).toEqual(canonical.ollamaSessionMemories)
  })

  it('produces a record the Stage 1a guard admits as a full match, while an unmarked page still fails', () => {
    const canonical = canonicalChat(2000)
    const escalated = escalateSummaryChatForSave(pagedShell(canonical), () => canonical)

    expect(escalated.messages.map((row) => row.id)).toEqual(canonical.messages.map((row) => row.id))
    expect(() => assertAuthoritativeChatForSave(escalated, canonical)).not.toThrow()

    // The fence escalation must never weaken: the same thread's tail page,
    // saved unmarked, is still the transcript-loss case the guard rejects.
    const unmarkedTailPage = { ...canonical, messages: canonical.messages.slice(500) }
    expect(escalateSummaryChatForSave(unmarkedTailPage, () => canonical)).toBe(unmarkedTailPage)
    expect(() => assertAuthoritativeChatForSave(unmarkedTailPage, canonical)).toThrow(
      /windowed transcript page/
    )
  })
})
