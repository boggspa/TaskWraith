/**
 * Host-owned erasure of a chat's journal, driven through the real store.
 *
 * Once journal rotation is on, a chat's log is a checkpoint, a sealed segment
 * and an active segment, and with the journal flusher attached the store keeps
 * descriptors open on the segments. Erasure must leave none of it behind: a
 * surviving sealed segment is transcript on disk after a reported delete, and
 * a surviving descriptor keeps the unlinked bytes alive and writable.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HostThreadRecordPersistInput,
  HostThreadRecordPersistPort
} from '../host/HostThreadRecordPersistCommand'
import { deriveChatRecordMutation } from './ChatRecordMutation'
import {
  createIncrementalChatJournal,
  INCREMENTAL_CHAT_JOURNAL_ARTIFACT_SUFFIXES
} from './IncrementalChatJournal'
import type { DurabilityFlusherPorts } from './MainDurabilityFlusher'
import type { ChatRecord } from './types'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-journal-erasure-'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = tmpdir()
  const made = temporary + sep + TEMPORARY_PREFIX
  if (
    directory === temporary ||
    !directory.startsWith(made) ||
    directory.length <= made.length ||
    dirname(directory) !== temporary
  )
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  rmSync(directory, { recursive: true, force: true })
}

const profiles: string[] = []
const shutdowns: Array<() => Promise<void>> = []

afterEach(async () => {
  while (shutdowns.length > 0) await shutdowns.pop()!()
  vi.doUnmock('./MainDurabilityRuntime')
  while (profiles.length > 0) removeTemporaryDirectory(profiles.pop()!)
})

function chatRecord(appChatId: string, revision: number): ChatRecord {
  return {
    appChatId,
    scope: 'global',
    chatKind: 'single',
    provider: 'codex',
    title: `Chat ${appChatId}`,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    workflowMode: 'normal',
    messages: [
      {
        id: `${appChatId}-msg-1`,
        role: 'user',
        content: `Transcript of ${appChatId}`,
        timestamp: '2026-10-04T00:00:00.000Z'
      }
    ],
    runs: [],
    persistenceRevision: revision
  }
}

function withMessage(source: ChatRecord, id: string, content: string): ChatRecord {
  return {
    ...source,
    messages: [
      ...source.messages,
      { id, role: 'assistant', content, timestamp: '2026-10-04T00:00:01.000Z' }
    ],
    persistenceRevision: (source.persistenceRevision ?? 0) + 1
  }
}

/** A journal adapter over the real filesystem that records what it closed. */
interface RecordingAdapter extends DurabilityFlusherPorts {
  dispose(): Promise<void>
  readonly closed: Array<{ fd: number; journalFilesAtClose: string[] }>
}

function recordingAdapter(journalDirectory: () => string): RecordingAdapter {
  const pending: Array<() => void> = []
  const closed: RecordingAdapter['closed'] = []
  return {
    closed,
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
    fsync(fd, complete) {
      const finish = (): void => {
        fsyncSync(fd)
        complete()
      }
      pending.push(finish)
      return {
        joinSync() {
          pending.splice(pending.indexOf(finish), 1)
          finish()
        }
      }
    },
    fsyncSync,
    close(fd) {
      closed.push({ fd, journalFilesAtClose: readdirSync(journalDirectory()).sort() })
      closeSync(fd)
    },
    dispose: async () => {}
  }
}

interface HostOwnedStore {
  AppStore: typeof import('./index').AppStore
  journalDirectory: string
}

/**
 * The real store over a temporary profile with the legacy writer gate
 * Host-owned, so erasure takes the Host route. `adapter` attaches the journal
 * flusher (and so the journal's descriptor cache) exactly as the composition
 * does under its rollout switch, without touching the process environment.
 */
async function importHostOwnedStore(
  seeds: ChatRecord[],
  adapter?: RecordingAdapter
): Promise<HostOwnedStore> {
  const profilePath = mkdtempSync(join(tmpdir(), TEMPORARY_PREFIX))
  profiles.push(profilePath)
  const chatsDir = join(profilePath, 'chats')
  mkdirSync(chatsDir, { recursive: true, mode: 0o700 })
  for (const seed of seeds) {
    const filePath = join(chatsDir, `${seed.appChatId}.json`)
    writeFileSync(filePath, JSON.stringify(seed))
    chmodSync(filePath, 0o600)
  }
  vi.resetModules()
  if (adapter) {
    const workerEntryPath = join(profilePath, 'unused-fsync-worker.js')
    writeFileSync(workerEntryPath, '')
    vi.doMock('./MainDurabilityRuntime', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./MainDurabilityRuntime')>()
      return {
        ...actual,
        createMainDurabilityRuntime: (
          options: import('./MainDurabilityRuntime').MainDurabilityRuntimeOptions
        ) =>
          actual.createMainDurabilityRuntime({
            ...options,
            env: { TASKWRAITH_JOURNAL_FLUSHER: '1' },
            workerEntryPath,
            createAdapter: () => adapter
          })
      }
    })
  }
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
  shutdowns.push(() => AppStore.shutdownMainDurability())
  const { legacyStoreWriterGate } = await import('./LegacyStoreWriterGate')
  if (!legacyStoreWriterGate.beginDrain()) throw new Error('test gate did not begin draining')
  if (
    !legacyStoreWriterGate.markHostOwned({
      hostId: 'test-host',
      generation: 1,
      cutoverId: 'test-cutover'
    })
  ) {
    throw new Error('test gate did not become host-owned')
  }
  // A Host that applies the revision contract to the temporary profile, so the
  // erasure transaction's read-backs see what a real Host would leave behind.
  const applyPersist = (input: HostThreadRecordPersistInput): void => {
    const filePath = join(chatsDir, `${input.chatId}.json`)
    const current = existsSync(filePath)
      ? (JSON.parse(readFileSync(filePath, 'utf8')) as { persistenceRevision?: number })
      : null
    const currentRevision = current?.persistenceRevision ?? 0
    if (current === null && input.expectedRevision !== 0) throw new Error('Thread is not found')
    if (current !== null && currentRevision !== input.expectedRevision) {
      throw new Error('Thread persistence revision mismatch')
    }
    const requested = input.record.persistenceRevision
    const persistenceRevision =
      current === null
        ? 0
        : Number.isSafeInteger(requested) && requested! > currentRevision
          ? requested
          : currentRevision + 1
    writeFileSync(filePath, JSON.stringify({ ...input.record, persistenceRevision }))
    chmodSync(filePath, 0o600)
  }
  const persistPort = {
    persist: vi.fn(async (input: HostThreadRecordPersistInput) => {
      applyPersist(input)
      return {} as never
    }),
    deleteRecord: vi.fn(async (input: { chatId: string }) => {
      rmSync(join(chatsDir, `${input.chatId}.json`), { force: true })
    }),
    enqueue: vi.fn((input: HostThreadRecordPersistInput) => applyPersist(input)),
    drain: vi.fn(async () => {}),
    drainAll: vi.fn(async () => {}),
    pending: vi.fn(() => 0)
  }
  AppStore.setHostThreadRecordPersistPortForTests(persistPort as HostThreadRecordPersistPort)
  return { AppStore, journalDirectory: join(profilePath, 'chat-journal-v2') }
}

/**
 * Lay down the files a rotated journal leaves for one chat: a checkpoint at
 * the record's revision, a sealed segment with the next batch, and an active
 * segment with the one after. Returns the transcript text each segment holds.
 */
function seedRotatedJournal(
  journalDirectory: string,
  record: ChatRecord
): { sealedText: string; activeText: string } {
  const chatId = record.appChatId
  const sealedText = `sealed segment transcript of ${chatId}`
  const activeText = `active segment transcript of ${chatId}`
  const journal = createIncrementalChatJournal(journalDirectory)
  journal.initialize(chatId, record)
  const second = withMessage(record, `${chatId}-msg-2`, sealedText)
  journal.append(deriveChatRecordMutation(record, second))
  // Rotation renames the active segment; the next append starts a new one.
  renameSync(
    join(journalDirectory, `${chatId}.mutations.jsonl`),
    join(journalDirectory, `${chatId}.sealed.mutations.jsonl`)
  )
  const third = withMessage(second, `${chatId}-msg-3`, activeText)
  journal.append(deriveChatRecordMutation(second, third))
  return { sealedText, activeText }
}

function journalFilesOf(journalDirectory: string, chatId: string): string[] {
  return readdirSync(journalDirectory)
    .filter((name) => name.startsWith(`${chatId}.`))
    .sort()
}

function journalBytes(journalDirectory: string): string {
  return readdirSync(journalDirectory)
    .map((name) => readFileSync(join(journalDirectory, name), 'utf8'))
    .join('\n')
}

describe('Host-owned erasure of a rotated journal', () => {
  it.each(['delete', 'truncate'] as const)(
    'leaves no journal file of the chat on disk after a %s, sealed segment included',
    async (kind) => {
      const erased = chatRecord('chat-erased', 2)
      const kept = chatRecord('chat-kept', 2)
      const { AppStore, journalDirectory } = await importHostOwnedStore([erased, kept])
      const erasedText = seedRotatedJournal(journalDirectory, erased)
      const keptText = seedRotatedJournal(journalDirectory, kept)
      expect(journalFilesOf(journalDirectory, 'chat-erased')).toEqual([
        'chat-erased.checkpoint.json',
        'chat-erased.mutations.jsonl',
        'chat-erased.sealed.mutations.jsonl'
      ])
      expect(journalBytes(journalDirectory)).toContain(erasedText.sealedText)

      if (kind === 'delete') await AppStore.deleteChatViaHost('chat-erased')
      else await AppStore.truncateChatHistoryViaHost('chat-erased')

      expect(journalFilesOf(journalDirectory, 'chat-erased')).toEqual([])
      const remaining = journalBytes(journalDirectory)
      expect(remaining).not.toContain(erasedText.sealedText)
      expect(remaining).not.toContain(erasedText.activeText)
      expect(remaining).not.toContain('Transcript of chat-erased')
      // Erasure is scoped: the neighbour's whole journal is untouched.
      expect(journalFilesOf(journalDirectory, 'chat-kept')).toEqual([
        'chat-kept.checkpoint.json',
        'chat-kept.mutations.jsonl',
        'chat-kept.sealed.mutations.jsonl'
      ])
      expect(remaining).toContain(keptText.sealedText)
      expect(AppStore.getPendingHistoryDeletion()).toBeNull()
    }
  )

  it('removes every file the journal can keep for a chat, from the list the journal exports', async () => {
    // The sealed segment was missed once because erasure kept a private copy
    // of this list. Anything added to the journal's list is erased here too.
    expect(INCREMENTAL_CHAT_JOURNAL_ARTIFACT_SUFFIXES).toEqual([
      '.checkpoint.json',
      '.sealed.mutations.jsonl',
      '.mutations.jsonl',
      '.tombstone'
    ])
    const erased = chatRecord('chat-erased', 2)
    const { AppStore, journalDirectory } = await importHostOwnedStore([erased])
    mkdirSync(journalDirectory, { recursive: true })
    for (const suffix of INCREMENTAL_CHAT_JOURNAL_ARTIFACT_SUFFIXES) {
      writeFileSync(join(journalDirectory, `chat-erased${suffix}`), '')
    }
    expect(journalFilesOf(journalDirectory, 'chat-erased')).toHaveLength(
      INCREMENTAL_CHAT_JOURNAL_ARTIFACT_SUFFIXES.length
    )

    await AppStore.deleteChatViaHost('chat-erased')

    expect(journalFilesOf(journalDirectory, 'chat-erased')).toEqual([])
  })

  it('retires the chat journal descriptor before unlinking when the journal flusher is attached', async () => {
    const erased = chatRecord('chat-erased', 2)
    const kept = chatRecord('chat-kept', 2)
    let journalDirectory = ''
    const adapter = recordingAdapter(() => journalDirectory)
    const store = await importHostOwnedStore([erased, kept], adapter)
    journalDirectory = store.journalDirectory
    const { AppStore } = store
    const registeredJournalFiles = (): number =>
      AppStore.getMainDurabilitySnapshot().telemetry.poolOwners!.journal.activeFiles
    const streamInto = (chatId: string): void => {
      const current = AppStore.getChat(chatId)!
      AppStore.saveChat({
        ...current,
        runs: [{ runId: `${chatId}-run`, startedAt: '2026-10-04T00:00:00.000Z', status: 'running' }]
      })
    }
    expect(AppStore.getMainDurabilitySnapshot().journal).toMatchObject({
      attached: true,
      mode: 'worker'
    })
    streamInto('chat-erased')
    streamInto('chat-kept')
    // One open descriptor per chat journal: the precondition this test needs.
    expect(journalFilesOf(journalDirectory, 'chat-erased')).toContain('chat-erased.mutations.jsonl')
    expect(registeredJournalFiles()).toBe(2)
    expect(adapter.closed).toEqual([])

    await AppStore.deleteChatViaHost('chat-erased')

    expect(journalFilesOf(journalDirectory, 'chat-erased')).toEqual([])
    expect(registeredJournalFiles()).toBe(1)
    expect(adapter.closed).toHaveLength(1)
    // Closed while the file still had its name: retire first, unlink second.
    expect(adapter.closed[0].journalFilesAtClose).toContain('chat-erased.mutations.jsonl')
    expect(journalFilesOf(journalDirectory, 'chat-kept')).toContain('chat-kept.mutations.jsonl')
  })
})
