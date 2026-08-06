/**
 * Lane 2 — chat-list-index CALL-SITE projection.
 *
 * Two separate defects are pinned here, both observable from outside:
 *
 * 1. SIZE. `toChatListItem` spreads `...normalizedChat`, which drags the whole
 *    `ensemble` blob (seat briefs + round summaries + blackboard) into what is
 *    supposed to be a LIST projection. Measured on the reporting user's profile
 *    that was 229 KB of a 234 KB entry (98%), which is what grew
 *    `chat-list-index.jsonl` to 98.7 MB and made every full parse cost ~485 ms.
 *
 * 2. RATE. `saveChat` called `chatListIndexStore.readAll()` twice per save — a
 *    full parse of that file on the main thread, on every save. Under fan-out
 *    N lanes each arm their own flush, so the cost multiplies by N.
 *
 * The row keeps a LEAN ensemble rather than none. Dropping the field outright
 * saves 100% of those bytes but blanks the sidebar's Ensembles rows, which read
 * activeRound/participants for a row's subtitle and running state and are the
 * ONLY source for a chat the user has not opened. The lean copy saves 97.3%.
 *
 * The last test is the load-bearing one. A lean roster must never be persisted:
 * the renderer merges a refreshed row over a loaded record and that merge drops
 * `summaryOnly`, so a hollow roster can reach `saveChat` looking fully hydrated.
 * Writing it would erase every seat's brief, which is unrecoverable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from './index'
import { ChatListIndexStore } from './ChatListIndexStore'
import type { ChatListItem, ChatRecord } from './types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-chatlist-projection-test-${process.pid}`)

// Run the durable write inline so the coalesced callback (one of the two
// readAll sites) is actually exercised inside saveChat.
vi.hoisted(() => {
  process.env.TASKWRAITH_SAVE_COALESCE_MS = '-1'
})

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const chatsDir = join(userDataPath, 'chats')
const chatListIndexPath = join(userDataPath, 'chat-list-index.jsonl')

/** A marker that only ever exists inside a seat's brief, so a substring search
 *  over a row or an index line is a fair "did the fat blob leak?" test. */
const ROSTER_MARKER = 'PARTICIPANT-INSTRUCTIONS-MARKER'

function fatEnsemble(): Record<string, unknown> {
  const participants = Array.from({ length: 15 }, (_, i) => ({
    id: `ensemble-participant-${i + 1}`,
    provider: 'claude',
    model: 'claude-opus-5',
    role: `Role ${i + 1}`,
    // Real rosters carry multi-paragraph briefs; this is what makes the blob fat.
    instructions: `${ROSTER_MARKER} ${'brief text '.repeat(400)}`,
    enabled: true,
    order: i + 1,
    permissionPresetId: 'default'
  }))
  return {
    enabled: true,
    maxParticipants: 50,
    participants,
    bossmanParticipantId: 'ensemble-participant-1',
    captainParticipantIds: ['ensemble-participant-2'],
    activeRound: {
      roundId: 'round-1',
      status: 'active',
      activeParticipantId: 'ensemble-participant-2',
      startedAt: '2026-08-06T00:00:00.000Z',
      participants: participants.map((p) => ({
        participantId: p.id,
        order: p.order,
        status: 'idle'
      })),
      bossmanParticipantId: 'ensemble-participant-1',
      captainParticipantIds: ['ensemble-participant-2']
    },
    roundSummaries: Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `round-${i}`,
        { roundId: `round-${i}`, summary: 'a round summary that is not small '.repeat(60) }
      ])
    ),
    blackboard: [{ id: 'bb-1', key: 'k', value: 'v '.repeat(500) }],
    sessionActivityLedger: [{ id: 'sa-1', note: 'ledger '.repeat(200) }]
  }
}

function ensembleChat(appChatId: string): ChatRecord {
  const base = AppStore.createChat('ws-1', '/repo')
  return {
    ...base,
    appChatId,
    chatKind: 'ensemble',
    title: 'Ensemble chat',
    ensemble: fatEnsemble(),
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'hello',
        timestamp: '2026-01-01T00:00:00.000Z'
      }
    ],
    runs: []
  } as unknown as ChatRecord
}

function readIndexLines(): string[] {
  const raw = fs.readFileSync(chatListIndexPath, 'utf-8')
  return raw.split('\n').filter((line) => line.trim().length > 0)
}

describe('chat-list index projection', () => {
  beforeEach(() => {
    AppStore.resetTransientDeletionGuardsForTests()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(chatsDir, { recursive: true })
    vi.restoreAllMocks()
  })

  it('drops the fat ensemble sub-blobs from the list projection', () => {
    const chat = ensembleChat('chat-projection-1')
    const item = AppStore.toChatListItem(chat)

    // The briefs, round summaries, blackboard and activity ledger are the bulk
    // of the bytes and nothing in the chat list reads them.
    expect(JSON.stringify(item)).not.toContain(ROSTER_MARKER)
    expect(item.ensemble?.roundSummaries).toBeUndefined()
    expect(item.ensemble?.blackboard).toBeUndefined()
    expect(item.ensemble?.sessionActivityLedger).toBeUndefined()

    const ensembleBytes = JSON.stringify(chat.ensemble).length
    const itemBytes = JSON.stringify(item).length
    expect(ensembleBytes).toBeGreaterThan(100_000)
    expect(itemBytes).toBeLessThan(ensembleBytes * 0.05)
  })

  it('keeps what the sidebar Ensembles rows actually render', () => {
    const chat = ensembleChat('chat-projection-1b')
    const item = AppStore.toChatListItem(chat)

    // Sidebar.tsx derives a row's subtitle from the active participant's
    // provider + role, and its running state from the active round. For a chat
    // the user has not opened, this row is the only source for both.
    expect(item.ensemble?.activeRound?.roundId).toBe('round-1')
    const seat = item.ensemble?.participants?.find((p) => p.id === 'ensemble-participant-2')
    expect(seat?.role).toBe('Role 2')
    expect(seat?.provider).toBe('claude')
    // ...but not the brief.
    expect(seat?.instructions).toBe('')
  })

  it('does not resurrect a default roster when a row is read back', () => {
    const chat = ensembleChat('chat-projection-2')
    const item = AppStore.toChatListItem(chat)
    const roundTripped = AppStore.normalizeChatListItem(item)

    // normalizeChatRecord rebuilds a DEFAULT ensemble for ensemble chats. If a
    // row came back carrying default seats it would advertise a roster the user
    // never configured.
    expect(roundTripped.ensemble?.participants).toHaveLength(15)
    expect(roundTripped.ensemble?.participants?.[0]?.id).toBe('ensemble-participant-1')
    expect(JSON.stringify(roundTripped)).not.toContain(ROSTER_MARKER)
  })

  it('refuses to persist a hollow roster that arrived via a list row', () => {
    const chat = ensembleChat('chat-projection-3')
    AppStore.saveChat(chat)

    // Build the hollow shape DIRECTLY — flagged lean ensemble on a full-looking
    // record (no `summaryOnly`). This is what reaches saveChat after a list-row
    // merge drops `summaryOnly`. Do NOT build via mergeChatRecordValue: that
    // omit now preserves hydrated briefs, so a merge-built fixture never hits
    // the saveChat guard (SolWork proved: disable the guard → 297 green).
    const hollow = {
      ...chat,
      ensemble: AppStore.toChatListEnsembleProjection(chat.ensemble!)
    } as ChatRecord

    // Sanity: the fixture is actually hollow + flagged, otherwise this test
    // could pass without exercising the guard at all.
    expect(AppStore.isChatListEnsembleProjection(hollow.ensemble)).toBe(true)
    expect(hollow.ensemble?.participants?.[0]?.instructions).toBe('')
    expect(JSON.stringify(hollow.ensemble)).not.toContain(ROSTER_MARKER)

    AppStore.saveChat(hollow)

    // Every seat's brief must survive. Losing these is unrecoverable.
    // Verified RED by mutation: commenting out the saveChat hollow-roster
    // guard (index.ts isChatListEnsembleProjection branch) blanks the briefs.
    const persisted = AppStore.getChat('chat-projection-3')
    expect(persisted?.ensemble?.participants).toHaveLength(15)
    expect(persisted?.ensemble?.participants?.[0]?.instructions).toContain(ROSTER_MARKER)
    expect(JSON.stringify(persisted)).not.toContain('__chatListProjection')
  })

  it('writes a list-index line without the roster briefs', () => {
    const chat = ensembleChat('chat-projection-4')
    AppStore.saveChat(chat)

    const lines = readIndexLines()
    const line = lines.find((entry) => entry.includes('chat-projection-4'))
    expect(line).toBeDefined()
    expect(line).not.toContain(ROSTER_MARKER)
    // A list row is a row, not a record. 20 KB is already generous.
    expect(line!.length).toBeLessThan(20_000)
  })

  /**
   * CROSS-LANE (owner: ChatListIndexStore.ts). FIXED 2026-08-06.
   *
   * Was red because `stripSummaries` dropped `ensemble` before the JSONL line
   * was written, so the row reached the sidebar with no roster — and
   * `normalizeChatRecord` then rebuilt createDefaultEnsembleConfig's ~4 seats
   * as if they were the user's 15. Fabricated data is worse than none.
   *
   * Not fixed by the one-liner ("stop stripping `ensemble`"). That was a trap:
   * keyed on bare PRESENCE of `ensemble`, keeping the roster would fire a full
   * compaction on every `readAll()` (~485 ms per saveChat). The discriminator
   * that resolves it: `toChatListEnsembleProjection` stamps
   * `__chatListProjection`, so `stripSummaries` keeps a FLAGGED lean ensemble
   * and projects an unflagged fat one down to lean (never drops the roster).
   * The read-path detector is `entryHasUnprojectedEnsemble` — legacy blobs
   * heal exactly once; lean rows never re-trigger compact.
   */
  it('serves the sidebar a real roster after a full disk round-trip', () => {
    const chat = ensembleChat('chat-projection-7')
    AppStore.saveChat(chat)

    const row = AppStore.getChatList().find((c) => c.appChatId === 'chat-projection-7')

    expect(row?.ensemble?.participants).toHaveLength(15)
    expect(row?.ensemble?.participants?.[1]?.role).toBe('Role 2')
    expect(row?.ensemble?.activeRound?.roundId).toBe('round-1')
    expect(JSON.stringify(row)).not.toContain(ROSTER_MARKER)
  })

  /**
   * The same fabrication, one step earlier: the row that is ALREADY on disk.
   *
   * Every existing install's `chat-list-index.jsonl` was written before the
   * projection existed, so its ensemble rows are fat and unflagged. Keeping the
   * roster on the WRITE path does nothing for them — they are healed by the
   * one-time compaction, and compaction re-applies `stripSummaries`, which
   * drops an unflagged ensemble outright. So the migration hands the sidebar a
   * row with no roster, `normalizeChatRecord` rebuilds
   * `createDefaultEnsembleConfig`, and the row advertises ~4 seats the user
   * never configured — the precise defect this lane exists to remove, still
   * shipping for all pre-existing data until each chat happens to be saved
   * again (a chat the user never opens is never re-saved).
   *
   * Dropping and re-deriving are NOT equivalent here: the real roster is
   * present in the legacy line, so migrating it down to lean costs one
   * projection and loses nothing. Fat-in / lean-out, never fat-in / gone.
   */
  it('heals a legacy fat row into its real roster, not a fabricated default', () => {
    const chat = ensembleChat('chat-projection-9')
    // The legacy shape the old writer produced: fat blob inline, no flag.
    const {
      runsSummary: _runsSummary,
      lastRun: _lastRun,
      ...listShape
    } = AppStore.toChatListItem(chat) as ChatListItem & { runsSummary?: unknown; lastRun?: unknown }
    const legacyEntry = { ...listShape, ensemble: fatEnsemble() }
    fs.writeFileSync(
      chatListIndexPath,
      JSON.stringify({ chatId: 'chat-projection-9', entry: legacyEntry }) + '\n',
      'utf-8'
    )
    // Sanity: the fixture really is the fat legacy shape, otherwise this test
    // could pass by never exercising the migration at all.
    expect(readIndexLines()[0]).toContain(ROSTER_MARKER)

    // Drive the store directly. Going via AppStore.getChatList() does NOT
    // exercise the migration: it re-derives the row from the chat record on
    // disk, so the roster comes back real whatever the index did, and the
    // assertion passes for the wrong reason (confirmed — this test was green
    // against the unfixed store until it was lowered to the store).
    const store = new ChatListIndexStore(userDataPath)
    store.clearCache()
    const healed = store.readAll()['chat-projection-9']

    // The roster was sitting in the legacy line. It must survive the heal.
    expect(healed?.ensemble?.participants).toHaveLength(15)
    expect(healed?.ensemble?.participants?.[1]?.role).toBe('Role 2')
    expect(healed?.ensemble?.activeRound?.roundId).toBe('round-1')
    // ...but the briefs must not, in memory or on the healed line.
    expect(JSON.stringify(healed)).not.toContain(ROSTER_MARKER)
    expect(fs.readFileSync(chatListIndexPath, 'utf-8')).not.toContain(ROSTER_MARKER)
  })

  /**
   * The regression the fix above had to avoid, pinned so nobody reintroduces
   * it by "simplifying" the detector back to a presence check.
   *
   * `readAll` compacts when it sees an ensemble that does not belong on a list
   * line. Keyed on the bare PRESENCE of `ensemble`, every healthy lean row
   * matches, so a full rewrite fires on EVERY read — on the path measured at
   * ~485 ms per `saveChat` (memory: fanout-main-stall-chatlist-index). This is
   * a correctness-shaped assertion for a perf bug: the index is append-only,
   * so a compaction is directly observable as the line count collapsing.
   *
   * Verified RED by mutation: restoring the presence-only predicate collapses
   * the two lines to one and fails here.
   */
  it('does not compact on read just because a row carries its lean roster', () => {
    const chat = ensembleChat('chat-projection-8')
    AppStore.saveChat(chat)
    AppStore.saveChat({ ...chat, title: 'Ensemble chat (edited)' })

    const countLines = (): number =>
      readIndexLines().filter((entry) => entry.includes('chat-projection-8')).length

    // Append-only, so this chat holds several revisions. More than one is what
    // makes a compaction observable at all — do not pin the exact number, it
    // tracks how many writes the save path happens to make.
    const before = countLines()
    expect(before).toBeGreaterThan(1)

    // Drive the store directly and clear the cache between reads. Going via
    // AppStore.getChatList() does NOT exercise this: the cache is already warm
    // from the saves, readAll() never runs, and the assertion passes for the
    // wrong reason (confirmed — the mutation probe below stayed green).
    const store = new ChatListIndexStore(userDataPath)
    store.clearCache()
    store.readAll()
    store.clearCache()
    store.readAll()

    expect(countLines()).toBe(before)
  })

  it('performs no full-index parse on the save path', () => {
    const chat = ensembleChat('chat-projection-5')
    // Prime the index so the save path has a previous entry to compare against.
    AppStore.saveChat(chat)

    const readAllSpy = vi.spyOn(ChatListIndexStore.prototype, 'readAll')
    AppStore.saveChat({ ...chat, title: 'Renamed' } as ChatRecord)

    // readAll re-reads and re-parses the whole JSONL (plus one summary file per
    // chat). Both save-path callers want exactly one entry.
    expect(readAllSpy).not.toHaveBeenCalled()
  })

  it('still refreshes the entry that the save path looked up', () => {
    const chat = ensembleChat('chat-projection-6')
    AppStore.saveChat(chat)
    AppStore.saveChat({ ...chat, title: 'Renamed' } as ChatRecord)

    const item = AppStore.getChatList().find((c) => c.appChatId === 'chat-projection-6') as
      | ChatListItem
      | undefined
    expect(item?.title).toBe('Renamed')
    // The source stat is what getChatList uses to decide the entry is fresh —
    // if the save path stopped maintaining it, every list read would rebuild
    // from the chat file and the index would be pointless.
    const stat = fs.statSync(join(chatsDir, 'chat-projection-6.json'))
    expect(item?.sourceChatMtimeMs).toBe(stat.mtimeMs)
    expect(item?.sourceChatSize).toBe(stat.size)
  })
})
