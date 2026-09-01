/**
 * Stage 6 — escalate-not-reject on BOTH whole-record save paths.
 *
 * A paged open (>1,500 messages), an LRU demotion, or a sidebar row hands the
 * renderer a summary shell: `summaryOnly: true`, empty `messages`/`runs`,
 * full chrome. ~25 direct `window.api.saveChat` sites save that record
 * whole; both fences used to throw, so on a big Ensemble thread a seat
 * removal, goal update, rename or pin became a failed user action. These
 * tests pin the replacement contract:
 *
 *  - a marked shell saved over a canonical record keeps EVERY message and run
 *    row and lands only the chrome change — on the Host-routed path
 *    (`saveChatThroughHost`) and the legacy admitted path (`saveChatAdmitted`);
 *  - a summary CREATE (no canonical record) still fails closed;
 *  - an UNMARKED windowed page still fails closed (Stage 1a guard intact);
 *  - journal semantics equal a chrome-only full-record save: a chrome delta
 *    on the admitted incremental journal, whole-record-only on the Host path;
 *  - a lean sidebar row keeps the stored roster briefs and the session
 *    memories the list projection shed.
 *
 * Wiring idiom shared with HostIncrementalChatPersistence.test.ts: a fresh
 * module graph per test, a temp profile, the Host persist port replaced by a
 * recording stub, and the writer gate optionally Host-owned.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HostThreadRecordPersistInput,
  HostThreadRecordPersistPort
} from '../host/HostThreadRecordPersistCommand'
import type {
  ActiveGoal,
  ChatListItem,
  ChatMessage,
  ChatRecord,
  ChatRun,
  EnsembleConfig,
  EnsembleParticipant
} from './types'

const BRIEF = 'SEAT-BRIEF-MARKER'
const profiles: string[] = []

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

interface WiredStore {
  AppStore: typeof import('./index').AppStore
  profilePath: string
  enqueued: HostThreadRecordPersistInput[]
}

async function importStore(options?: { hostOwnGate?: boolean }): Promise<WiredStore> {
  const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-summary-save-escalation-'))
  profiles.push(profilePath)
  vi.resetModules()
  const { configureHostStoreRuntime, resetHostStoreRuntimeForTests } =
    await import('../../host-runtime/HostStoreRuntime')
  resetHostStoreRuntimeForTests()
  configureHostStoreRuntime({
    profilePath,
    secureStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`node:${plain}`, 'utf8'),
      decryptString: (encrypted) => encrypted.toString('utf8').replace(/^node:/, '')
    }
  })
  const { AppStore } = await import('./index')
  if (options?.hostOwnGate !== false) {
    const { legacyStoreWriterGate } = await import('./LegacyStoreWriterGate')
    if (!legacyStoreWriterGate.beginDrain()) throw new Error('test gate did not begin draining')
    const owned = legacyStoreWriterGate.markHostOwned({
      hostId: 'test-host',
      generation: 1,
      cutoverId: 'test-cutover'
    })
    if (!owned) throw new Error('test gate did not become host-owned')
  }
  const enqueued: HostThreadRecordPersistInput[] = []
  const persistPort: HostThreadRecordPersistPort = {
    persist: vi.fn(),
    enqueue: vi.fn((input: HostThreadRecordPersistInput) => {
      enqueued.push(input)
    }),
    drain: vi.fn(async () => {}),
    drainAll: vi.fn(async () => {}),
    pending: vi.fn(() => 0)
  }
  AppStore.setHostThreadRecordPersistPortForTests(persistPort)
  return { AppStore, profilePath, enqueued }
}

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
    model: 'claude-fable-5',
    enabled: true,
    role: `Role ${index}`,
    instructions,
    order: index,
    permissionPresetId: 'default'
  } as EnsembleParticipant
}

function roster(participants: EnsembleParticipant[]): EnsembleConfig {
  return {
    enabled: true,
    maxParticipants: 50,
    participants,
    bossmanParticipantId: 'ensemble-participant-1'
  } as unknown as EnsembleConfig
}

function canonicalChat(
  chatId: string,
  options: { messageCount?: number; runs?: ChatRun[]; revision?: number } = {}
): ChatRecord {
  return {
    appChatId: chatId,
    provider: 'claude',
    title: 'Stage 6 chat',
    scope: 'global',
    chatKind: 'ensemble',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: options.revision ?? 3,
    archived: false,
    ensemble: roster([seat(1), seat(2), seat(3)]),
    ollamaSessionMemories: { 'ensemble-participant-1': { summary: 'seat working memory' } },
    messages: Array.from({ length: options.messageCount ?? 2000 }, (_, index) => message(index)),
    runs: options.runs ?? [run(1), run(2), run(3)]
  } as unknown as ChatRecord
}

function seedDurableChat(profilePath: string, chat: ChatRecord): void {
  const chatsDir = join(profilePath, 'chats')
  mkdirSync(chatsDir, { recursive: true, mode: 0o700 })
  const chatPath = join(chatsDir, `${chat.appChatId}.json`)
  writeFileSync(chatPath, JSON.stringify(chat))
  chmodSync(chatPath, 0o600)
}

type ShellOverrides = Partial<ChatRecord> & Record<string, unknown>

/** The get-chat-transcript-page shell (`buildChatShell`): full chrome, counts,
 *  last run, paged marker, EMPTY transcript arrays. */
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

/** The renderer LRU demotion (`demoteChatToSummary`): no paged marker. */
function demotedRow(chat: ChatRecord, overrides: ShellOverrides = {}): ChatRecord {
  const { transcriptPaged: _marker, ...row } = pagedShell(chat, overrides) as ChatRecord & {
    transcriptPaged?: true
  }
  return row as ChatRecord
}

function journalV2Files(profilePath: string, chatId: string): string[] {
  const dir = join(profilePath, 'chat-journal-v2')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((entry) => entry.startsWith(chatId))
    .sort()
}

function readMutationBatches(
  profilePath: string,
  chatId: string
): Array<{ baseRevision: number; revision: number; operations: Array<Record<string, unknown>> }> {
  return readFileSync(join(profilePath, 'chat-journal-v2', `${chatId}.mutations.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

/** The durable artifact each path writes: the Host enqueue on the Host path,
 *  the flushed compatibility checkpoint on the admitted path. */
function durableRecord(store: WiredStore, chatId: string, hostOwnGate: boolean): ChatRecord {
  if (hostOwnGate) {
    const last = store.enqueued.at(-1)
    if (!last) throw new Error('nothing was enqueued on the Host persist port')
    expect(last.chatId).toBe(chatId)
    return last.record as unknown as ChatRecord
  }
  store.AppStore.flushAllChatSaves()
  return JSON.parse(readFileSync(join(store.profilePath, 'chats', `${chatId}.json`), 'utf8'))
}

function ids(rows: Array<{ id: string }> | Array<{ runId: string }>): string[] {
  return rows.map((row) => ('id' in row ? row.id : row.runId))
}

function expectFullRecord(record: ChatRecord): void {
  expect(record).not.toHaveProperty('summaryOnly')
  expect(record).not.toHaveProperty('transcriptPaged')
  expect(record).not.toHaveProperty('messageCount')
  expect(record).not.toHaveProperty('runCount')
  expect(record).not.toHaveProperty('lastRun')
  expect(record).not.toHaveProperty('runsSummary')
}

describe.each([
  { path: 'Host-routed', hostOwnGate: true },
  { path: 'legacy admitted', hostOwnGate: false }
])('$path save path', ({ hostOwnGate }) => {
  it('escalates a transcriptPaged shell onto the canonical transcript and lands the chrome', async () => {
    const store = await importStore({ hostOwnGate })
    const chatId = 'chat-paged-shell'
    const canonical = canonicalChat(chatId, { messageCount: 2000 })
    seedDurableChat(store.profilePath, canonical)

    const goal = {
      id: 'goal-stage-6',
      objective: 'Ship escalate-not-reject',
      status: 'active',
      mode: 'agent',
      provider: 'claude',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z'
    } as unknown as ActiveGoal
    const shell = pagedShell(canonical, {
      title: 'Renamed on a paged open',
      // Seat 2's brief edited, seat 3 removed, seat 4 added — a roster
      // mutation with the briefs the renderer holds on a paged shell.
      ensemble: roster([seat(1), seat(2, `${BRIEF} edited brief`), seat(4)]),
      activeGoal: goal,
      pinned: true,
      pinnedNotes: 'pinned from a paged open'
    })

    let saved: ChatRecord | undefined
    expect(() => {
      saved = store.AppStore.saveChat(shell)
    }).not.toThrow()
    if (!saved) throw new Error('saveChat returned nothing')

    // Every message and run row survives, byte-for-byte.
    expect(saved.messages).toHaveLength(2000)
    expect(saved.messages).toEqual(canonical.messages)
    expect(ids(saved.runs)).toEqual(['run-1', 'run-2', 'run-3'])
    expectFullRecord(saved)
    // ...and the chrome change is what landed.
    expect(saved.title).toBe('Renamed on a paged open')
    expect(saved.ensemble?.participants.map((participant) => participant.id)).toEqual([
      'ensemble-participant-1',
      'ensemble-participant-2',
      'ensemble-participant-4'
    ])
    expect(saved.ensemble?.participants[1]?.instructions).toBe(`${BRIEF} edited brief`)
    expect(saved.ensemble?.participants[0]?.instructions).toContain(BRIEF)
    expect(saved.activeGoal?.id).toBe('goal-stage-6')
    expect(saved.pinned).toBe(true)
    expect(saved.pinnedNotes).toBe('pinned from a paged open')
    expect(saved.ollamaSessionMemories).toEqual(canonical.ollamaSessionMemories)
    expect(saved.persistenceRevision).toBe(4)

    // The in-process read and the durable artifact agree with the return.
    const reread = store.AppStore.getChat(chatId)
    expect(reread?.title).toBe('Renamed on a paged open')
    expect(reread?.messages).toHaveLength(2000)
    const durable = durableRecord(store, chatId, hostOwnGate)
    expect(durable.title).toBe('Renamed on a paged open')
    expect(ids(durable.messages)).toEqual(ids(canonical.messages))
    expect(ids(durable.runs)).toEqual(['run-1', 'run-2', 'run-3'])
    expect(durable.ensemble?.participants).toHaveLength(3)
    expectFullRecord(durable)
    if (hostOwnGate) {
      expect(store.enqueued).toHaveLength(1)
      expect(store.enqueued[0].expectedRevision).toBe(3)
      // Exactly a chrome-only full-record Host save: whole-record-only, no
      // sideband journal batch (compare HostIncrementalChatPersistence).
      expect(journalV2Files(store.profilePath, chatId)).toEqual([])
    }
  })

  it('escalates an LRU-demoted summary row (no paged marker) the same way', async () => {
    const store = await importStore({ hostOwnGate })
    const chatId = 'chat-demoted-row'
    const canonical = canonicalChat(chatId, { messageCount: 300 })
    seedDurableChat(store.profilePath, canonical)

    const saved = store.AppStore.saveChat(
      demotedRow(canonical, { title: 'Renamed after demotion', archived: true })
    )

    expect(saved.messages).toEqual(canonical.messages)
    expect(ids(saved.runs)).toEqual(['run-1', 'run-2', 'run-3'])
    expect(saved.title).toBe('Renamed after demotion')
    expect(saved.archived).toBe(true)
    expectFullRecord(saved)
    const durable = durableRecord(store, chatId, hostOwnGate)
    expect(durable.title).toBe('Renamed after demotion')
    expect(durable.archived).toBe(true)
    expect(durable.messages).toHaveLength(300)
    expectFullRecord(durable)
  })

  it('still rejects a summary create: no canonical record to escalate onto', async () => {
    const store = await importStore({ hostOwnGate })
    const chatId = 'chat-summary-create'

    expect(() => store.AppStore.saveChat(pagedShell(canonicalChat(chatId)))).toThrow(/summary-only/)
    expect(store.enqueued).toHaveLength(0)
    expect(existsSync(join(store.profilePath, 'chats', `${chatId}.json`))).toBe(false)
    expect(store.AppStore.getChat(chatId)).toBeNull()
  })

  it('still rejects an unmarked windowed page: the Stage 1a fence is intact', async () => {
    const store = await importStore({ hostOwnGate })
    const chatId = 'chat-unmarked-page'
    const canonical = canonicalChat(chatId, { messageCount: 6 })
    seedDurableChat(store.profilePath, canonical)

    expect(() =>
      store.AppStore.saveChat({
        ...canonical,
        title: 'Tail page passed as a whole record',
        messages: canonical.messages.slice(3)
      })
    ).toThrow(/windowed transcript page/)
    expect(store.enqueued).toHaveLength(0)
    expect(store.AppStore.getChat(chatId)?.messages).toHaveLength(6)
    expect(store.AppStore.getChat(chatId)?.title).toBe('Stage 6 chat')
  })
})

describe('journal semantics of an escalated save', () => {
  it('records the same chrome-only delta on the admitted incremental journal as a full-record save', async () => {
    const store = await importStore({ hostOwnGate: false })
    // Two identical chats: one renamed through a FULL record (the baseline
    // every existing caller produces), one through a demoted shell. A running
    // run keeps both saves on the normal boundary, where the mutation batch
    // is the durable artifact (no whole-record rewrite).
    const fullId = 'chat-journal-full-record'
    const shellId = 'chat-journal-summary-shell'
    const seed = (chatId: string): ChatRecord =>
      canonicalChat(chatId, { messageCount: 50, runs: [run(1), run(2, 'running')] })
    const fullCanonical = seed(fullId)
    const shellCanonical = seed(shellId)
    seedDurableChat(store.profilePath, fullCanonical)
    seedDurableChat(store.profilePath, shellCanonical)

    store.AppStore.saveChat({ ...fullCanonical, title: 'Renamed mid-run' })
    const saved = store.AppStore.saveChat(demotedRow(shellCanonical, { title: 'Renamed mid-run' }))

    expect(saved.messages).toEqual(shellCanonical.messages)
    expect(saved.runs.at(-1)?.status).toBe('running')
    const [fullBatch] = readMutationBatches(store.profilePath, fullId)
    const shellBatches = readMutationBatches(store.profilePath, shellId)
    expect(shellBatches).toHaveLength(1)
    const [shellBatch] = shellBatches
    expect(shellBatch.baseRevision).toBe(3)
    expect(shellBatch.revision).toBe(4)
    // Identical operation shape to the full-record rename (the pipeline's own
    // historical-run stamping included), and not one transcript operation:
    // no messages_splice / message_* / tool_* op — the transcript was never
    // rewritten, only borrowed from the canonical record.
    const opTypes = (batch: { operations: Array<Record<string, unknown>> }): unknown[] =>
      batch.operations.map((operation) => operation.type)
    expect(opTypes(shellBatch)).toEqual(opTypes(fullBatch))
    expect(opTypes(shellBatch)).toContain('record_patch')
    expect(
      opTypes(shellBatch).filter(
        (type) => typeof type === 'string' && /^(messages_|message_|tool_)/.test(type)
      )
    ).toEqual([])
    const recordPatch = shellBatch.operations.find((operation) => operation.type === 'record_patch')
    expect((recordPatch?.set as Record<string, unknown>).title).toBe('Renamed mid-run')
    const stats = store.AppStore.getIncrementalChatPersistenceStats()
    expect(stats.mutationBatchesAppended).toBe(2)
    expect(stats.parityMismatches).toBe(0)
    expect(store.AppStore.getChat(shellId)?.title).toBe('Renamed mid-run')
    expect(store.AppStore.getChat(shellId)?.messages).toHaveLength(50)
  })
})

describe('lean sidebar rows', () => {
  it('saves a chat-list row without erasing the stored roster briefs or the shed session memories', async () => {
    const store = await importStore({ hostOwnGate: false })
    const chatId = 'chat-lean-row'
    const canonical = canonicalChat(chatId, { messageCount: 12 })
    seedDurableChat(store.profilePath, canonical)

    const row = store.AppStore.toChatListItem(canonical)
    // Precondition: the row really is the lean projection, or this test could
    // pass without exercising either remerge.
    expect((row as ChatListItem).summaryOnly).toBe(true)
    expect(store.AppStore.isChatListEnsembleProjection(row.ensemble)).toBe(true)
    expect(row.ensemble?.participants[0]?.instructions).toBe('')
    expect(row).not.toHaveProperty('ollamaSessionMemories')
    expect(row.runsSummary).toHaveLength(3)

    const saved = store.AppStore.saveChat({ ...row, title: 'Renamed from a sidebar row' })

    expect(saved.title).toBe('Renamed from a sidebar row')
    expect(saved.messages).toEqual(canonical.messages)
    expect(ids(saved.runs)).toEqual(['run-1', 'run-2', 'run-3'])
    // The stored roster wins over the lean projection (existing remerge)...
    expect(saved.ensemble?.participants).toHaveLength(3)
    expect(saved.ensemble?.participants[0]?.instructions).toContain(BRIEF)
    expect(JSON.stringify(saved)).not.toContain('__chatListProjection')
    // ...and the per-field sheds are restored from the canonical record.
    expect(saved.ollamaSessionMemories).toEqual(canonical.ollamaSessionMemories)
    expectFullRecord(saved)
    expect(saved).not.toHaveProperty('searchText')
    expect(saved).not.toHaveProperty('sourceChatMtimeMs')
    const persisted = store.AppStore.getChat(chatId)
    expect(persisted?.ensemble?.participants[0]?.instructions).toContain(BRIEF)
    expect(persisted?.ollamaSessionMemories).toEqual(canonical.ollamaSessionMemories)
  })
})
