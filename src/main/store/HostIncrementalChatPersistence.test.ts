/**
 * Stage 2 — ID/revision mutation persistence re-homed onto the Host write path.
 *
 * After the Host cutover the legacy writer gate is host-owned, production
 * saves route through `saveChatThroughHost`, and the legacy-admitted
 * `persistIncrementalChat` is never reached — the T4 journal would be
 * write-dead. These tests pin the re-home:
 *
 *  - a mutation save (authoredTranscript) enqueues the whole record on the
 *    Host persist queue AND appends its mutation batch to the main-owned
 *    sideband journal (`chat-journal-v2`);
 *  - a non-mutation save stays whole-record-only;
 *  - the journal repairs its baseline when a non-mutation Host save advanced
 *    the record between two mutation saves;
 *  - the legacy admitted path is unchanged while the gate is open;
 *  - the Stage 1a save guard keeps admitting authored-mutation saves on the
 *    Host path (every saveChat below with authoredTranscript must not throw).
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
import { ChatTranscriptMutationAuthor } from './ChatTranscriptMutationAuthoring'
import type { ChatMessage, ChatRecord } from './types'

const profiles: string[] = []

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

interface WiredStore {
  AppStore: typeof import('./index').AppStore
  profilePath: string
  enqueued: HostThreadRecordPersistInput[]
}

async function importStoreWithHostOwnedGate(options?: {
  hostOwnGate?: boolean
}): Promise<WiredStore> {
  const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-host-incremental-persist-'))
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

function message(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, timestamp: '2026-09-01T00:00:00.000Z' }
}

function durableChat(chatId: string, revision: number, runs: ChatRecord['runs'] = []): ChatRecord {
  return {
    appChatId: chatId,
    provider: 'codex',
    title: 'Stage 2 chat',
    scope: 'global',
    chatKind: 'single',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: revision,
    archived: false,
    messages: [
      message('m1', 'user', 'First message'),
      message('m2', 'assistant', 'Second message')
    ],
    runs
  }
}

function seedDurableChat(profilePath: string, chat: ChatRecord): void {
  const chatsDir = join(profilePath, 'chats')
  mkdirSync(chatsDir, { recursive: true, mode: 0o700 })
  const chatPath = join(chatsDir, `${chat.appChatId}.json`)
  writeFileSync(chatPath, JSON.stringify(chat))
  chmodSync(chatPath, 0o600)
}

function journalV2Files(profilePath: string, chatId: string): string[] {
  const dir = join(profilePath, 'chat-journal-v2')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((entry) => entry.startsWith(chatId))
    .sort()
}

function readJournalCheckpoint(
  profilePath: string,
  chatId: string
): { revision: number; record: ChatRecord } {
  return JSON.parse(
    readFileSync(join(profilePath, 'chat-journal-v2', `${chatId}.checkpoint.json`), 'utf8')
  ) as { revision: number; record: ChatRecord }
}

describe('Stage 2 — incremental persistence on the Host write path', () => {
  it('appends the journal batch alongside the whole-record enqueue for an authored mutation save', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-host-mutation'
    const previous = durableChat(chatId, 3)
    seedDurableChat(profilePath, previous)

    const m3 = message('m3', 'assistant', 'Appended by the mutation')
    const author = new ChatTranscriptMutationAuthor(previous.messages.length)
    author.append([m3])

    // The Stage 1a guard must keep admitting authored-mutation saves here;
    // a windowed-page rejection would throw synchronously inside saveChat.
    let saved: ChatRecord | undefined
    expect(() => {
      saved = AppStore.saveChat(
        { ...previous, messages: [...previous.messages, m3] },
        {
          authoredTranscript: author.finish()
        }
      ) as ChatRecord
    }).not.toThrow()

    // The whole record still rides the Host persist queue — the authoritative write.
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].chatId).toBe(chatId)
    expect(enqueued[0].expectedRevision).toBe(3)
    expect((enqueued[0].record as unknown as ChatRecord).persistenceRevision).toBe(4)
    expect(saved?.persistenceRevision).toBe(4)

    // ...and the authored mutation is durable in the sideband journal too.
    // The terminal boundary (no running run) checkpoints and parity-verifies.
    const stats = AppStore.getIncrementalChatPersistenceStats()
    expect(stats.seeds).toBe(0)
    expect(stats.mutationBatchesAppended).toBe(1)
    expect(stats.terminalCheckpoints).toBe(1)
    // Two parity checks by construction: ensureBaseline verifies the freshly
    // seeded baseline, then the terminal boundary verifies the append.
    expect(stats.parityChecks).toBe(2)
    expect(stats.parityMatches).toBe(2)
    expect(stats.parityMismatches).toBe(0)
    expect(journalV2Files(profilePath, chatId)).toEqual([`${chatId}.checkpoint.json`])
    const checkpoint = readJournalCheckpoint(profilePath, chatId)
    expect(checkpoint.revision).toBe(4)
    expect(checkpoint.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('keeps a running chat on the normal boundary: the mutation line lands in the journal', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-host-mutation-running'
    const previous = durableChat(chatId, 3, [
      { runId: 'run-1', startedAt: '2026-09-01T00:00:00.000Z', status: 'running' }
    ])
    seedDurableChat(profilePath, previous)

    const m3 = message('m3', 'assistant', 'Streaming delta')
    const author = new ChatTranscriptMutationAuthor(previous.messages.length)
    author.append([m3])
    AppStore.saveChat(
      { ...previous, messages: [...previous.messages, m3] },
      {
        authoredTranscript: author.finish()
      }
    )

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].expectedRevision).toBe(3)
    const stats = AppStore.getIncrementalChatPersistenceStats()
    expect(stats.mutationBatchesAppended).toBe(1)
    expect(stats.terminalCheckpoints).toBe(0)
    expect(stats.boundaryMix.normal).toBe(1)
    const lines = readFileSync(
      join(profilePath, 'chat-journal-v2', `${chatId}.mutations.jsonl`),
      'utf8'
    )
      .trim()
      .split('\n')
    expect(lines).toHaveLength(1)
    const batch = JSON.parse(lines[0]) as {
      chatId: string
      baseRevision: number
      revision: number
      operations: Array<{ type: string }>
    }
    expect(batch.chatId).toBe(chatId)
    expect(batch.baseRevision).toBe(3)
    expect(batch.revision).toBe(4)
    expect(batch.operations.some((operation) => operation.type === 'messages_splice')).toBe(true)
  })

  it('leaves a non-mutation Host save whole-record-only', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-host-whole-only'
    seedDurableChat(profilePath, durableChat(chatId, 3))

    AppStore.saveChat({ ...durableChat(chatId, 3), title: 'Renamed without mutation' })

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].expectedRevision).toBe(3)
    expect(journalV2Files(profilePath, chatId)).toEqual([])
    const stats = AppStore.getIncrementalChatPersistenceStats()
    expect(stats.mutationBatchesAppended).toBe(0)
    expect(stats.seeds).toBe(0)
    expect(stats.baselineChecks).toBe(0)
  })

  it('repairs the journal baseline when a non-mutation Host save advanced the record between mutations', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-host-baseline-repair'
    const previous = durableChat(chatId, 3)
    seedDurableChat(profilePath, previous)

    // Mutation save: journal seeded at 3, batch lands 3 -> 4 (terminal checkpoint).
    const m3 = message('m3', 'assistant', 'First mutation')
    const author1 = new ChatTranscriptMutationAuthor(previous.messages.length)
    author1.append([m3])
    const first = AppStore.saveChat(
      { ...previous, messages: [...previous.messages, m3] },
      { authoredTranscript: author1.finish() }
    ) as ChatRecord
    expect(first.persistenceRevision).toBe(4)

    // Non-mutation save: the Host whole-record write advances to 5; the
    // journal stays at 4 by design (whole-record-only).
    AppStore.saveChat({ ...first, title: 'Chrome-only change' })

    // The next mutation save must re-anchor the journal onto revision 5 and
    // then append 5 -> 6 instead of replaying against the stale base.
    const current = AppStore.getChat(chatId)!
    const m4 = message('m4', 'assistant', 'Second mutation')
    const author2 = new ChatTranscriptMutationAuthor(current.messages.length)
    author2.append([m4])
    const saved = AppStore.saveChat(
      { ...current, messages: [...current.messages, m4] },
      { authoredTranscript: author2.finish() }
    ) as ChatRecord

    expect(saved.persistenceRevision).toBe(6)
    expect(enqueued).toHaveLength(3)
    expect(enqueued.map((input) => input.expectedRevision)).toEqual([3, 4, 5])
    const stats = AppStore.getIncrementalChatPersistenceStats()
    expect(stats.mutationBatchesAppended).toBe(2)
    expect(stats.baselineRepairs).toBeGreaterThanOrEqual(1)
    expect(stats.parityMismatches).toBe(0)
    const checkpoint = readJournalCheckpoint(profilePath, chatId)
    expect(checkpoint.revision).toBe(6)
    expect(checkpoint.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('keeps the legacy admitted incremental path live while the gate is open', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate({
      hostOwnGate: false
    })
    const chatId = 'chat-legacy-mutation'
    const chat = durableChat(chatId, 3)
    // No seeded file: the first admitted save writes the compatibility
    // checkpoint and seeds the journal exactly as before the cutover.
    const m3 = message('m3', 'assistant', 'Legacy path mutation')
    const author = new ChatTranscriptMutationAuthor(chat.messages.length)
    author.append([m3])

    AppStore.saveChat(
      { ...chat, messages: [...chat.messages, m3] },
      {
        authoredTranscript: author.finish()
      }
    )

    expect(enqueued).toHaveLength(0)
    expect(existsSync(join(profilePath, 'chats', `${chatId}.json`))).toBe(true)
    const seedStats = AppStore.getIncrementalChatPersistenceStats()
    expect(seedStats.seeds).toBe(1)
    expect(seedStats.mutationBatchesAppended).toBe(0)

    // A follow-up admitted mutation save appends through the legacy wrapper.
    const current = AppStore.getChat(chatId)!
    const m4 = message('m4', 'assistant', 'Legacy second mutation')
    const author2 = new ChatTranscriptMutationAuthor(current.messages.length)
    author2.append([m4])
    AppStore.saveChat(
      { ...current, messages: [...current.messages, m4] },
      {
        authoredTranscript: author2.finish()
      }
    )

    const stats = AppStore.getIncrementalChatPersistenceStats()
    expect(stats.mutationBatchesAppended).toBe(1)
    expect(enqueued).toHaveLength(0)
    expect(AppStore.getChat(chatId)?.messages.map((entry) => entry.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4'
    ])
  })
})
