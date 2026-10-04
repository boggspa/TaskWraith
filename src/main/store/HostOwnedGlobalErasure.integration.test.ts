/**
 * Host-owned global clear, driven through the real store.
 *
 * A global clear removes the journal directory outright. With the journal
 * flusher attached the store keeps a descriptor open on every chat's segment
 * and on the directories it created them in, so the directory may only be
 * removed after those descriptors are retired: a surviving one keeps the
 * unlinked transcript alive and writable, and holds its slot in the journal's
 * descriptor cache for the rest of the process.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HostThreadRecordPersistInput,
  HostThreadRecordPersistPort
} from '../host/HostThreadRecordPersistCommand'
import type { DurabilityFlusherPorts } from './MainDurabilityFlusher'
import type { ChatRecord } from './types'

const profiles: string[] = []
const shutdowns: Array<() => Promise<void>> = []

afterEach(async () => {
  while (shutdowns.length > 0) await shutdowns.pop()!()
  vi.doUnmock('./MainDurabilityRuntime')
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
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

/** One descriptor the journal's flusher closed, and what was on disk then. */
interface ClosedDescriptor {
  ino: number
  directory: boolean
  /** Names in the journal directory at the close; null once it is gone. */
  journalFilesAtClose: string[] | null
}

/** One sync the journal's flusher ran. */
interface SyncedDescriptor {
  ino: number
  /** True when the descriptor was the directory the journal's name led to then. */
  journalDirectory: boolean
}

/** A journal adapter over the real filesystem that records what it synced and closed. */
interface RecordingAdapter extends DurabilityFlusherPorts {
  dispose(): Promise<void>
  readonly closed: ClosedDescriptor[]
  readonly synced: SyncedDescriptor[]
}

function recordingAdapter(journalDirectory: () => string): RecordingAdapter {
  const pending: Array<() => void> = []
  const closed: ClosedDescriptor[] = []
  const synced: SyncedDescriptor[] = []
  const sync = (fd: number): void => {
    const stat = fstatSync(fd)
    synced.push({
      ino: stat.ino,
      journalDirectory:
        stat.isDirectory() &&
        existsSync(journalDirectory()) &&
        statSync(journalDirectory()).ino === stat.ino
    })
    fsyncSync(fd)
  }
  return {
    closed,
    synced,
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
    fsync(fd, complete) {
      const finish = (): void => {
        sync(fd)
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
    fsyncSync: sync,
    close(fd) {
      const stat = fstatSync(fd)
      closed.push({
        ino: stat.ino,
        directory: stat.isDirectory(),
        journalFilesAtClose: existsSync(journalDirectory())
          ? readdirSync(journalDirectory()).sort()
          : null
      })
      closeSync(fd)
    },
    dispose: async () => {}
  }
}

interface HostOwnedStore {
  AppStore: typeof import('./index').AppStore
  profilePath: string
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
  const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-global-erasure-'))
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
  return { AppStore, profilePath, journalDirectory: join(profilePath, 'chat-journal-v2') }
}

describe('Host-owned global clear of the journal', () => {
  it('retires every cached journal descriptor before it removes the journal directory', async () => {
    let journalDirectory = ''
    const adapter = recordingAdapter(() => journalDirectory)
    const store = await importHostOwnedStore(
      [chatRecord('chat-first', 2), chatRecord('chat-second', 2)],
      adapter
    )
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
    streamInto('chat-first')
    streamInto('chat-second')
    // One open descriptor per chat segment, and one on the directory that
    // holds them: the precondition this test needs.
    const segments = ['chat-first.mutations.jsonl', 'chat-second.mutations.jsonl']
    expect(readdirSync(journalDirectory)).toEqual(expect.arrayContaining(segments))
    const segmentInodes = segments.map((name) => statSync(join(journalDirectory, name)).ino).sort()
    const directoryInode = statSync(journalDirectory).ino
    expect(registeredJournalFiles()).toBe(2)
    expect(adapter.closed).toEqual([])

    await AppStore.clearChatsViaHost()

    expect(existsSync(journalDirectory)).toBe(false)
    expect(registeredJournalFiles()).toBe(0)
    const closedSegments = adapter.closed.filter((entry) => !entry.directory)
    expect(closedSegments.map((entry) => entry.ino).sort()).toEqual(segmentInodes)
    // Closed while the segments still had their names: retire first, remove second.
    for (const entry of closedSegments) {
      expect(entry.journalFilesAtClose).toEqual(expect.arrayContaining(segments))
    }
    // The directory's own descriptor goes too (none is kept on Windows). Left
    // open, the next segment created in a new directory of the same name would
    // count a sync of this removed one as covering its name.
    const closedDirectory = adapter.closed.filter(
      (entry) => entry.directory && entry.ino === directoryInode
    )
    expect(closedDirectory).toHaveLength(process.platform === 'win32' ? 0 : 1)
    for (const entry of closedDirectory) {
      expect(entry.journalFilesAtClose).toEqual(expect.arrayContaining(segments))
    }
  })

  it('journals a chat made after the clear in the new directory, through descriptors of its own', async () => {
    let journalDirectory = ''
    const adapter = recordingAdapter(() => journalDirectory)
    const store = await importHostOwnedStore([chatRecord('chat-cleared', 2)], adapter)
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
    streamInto('chat-cleared')
    expect(registeredJournalFiles()).toBe(1)

    await AppStore.clearChatsViaHost()
    AppStore.saveChat(chatRecord('chat-later', 0))
    await AppStore.awaitChatRecordPersisted('chat-later')
    adapter.synced.length = 0
    streamInto('chat-later')

    expect(readdirSync(journalDirectory)).toContain('chat-later.mutations.jsonl')
    // Only the new chat's segment is open: the cleared one gave its slot back.
    expect(registeredJournalFiles()).toBe(1)
    const laterSegmentInode = statSync(join(journalDirectory, 'chat-later.mutations.jsonl')).ino
    expect(adapter.synced.map((entry) => entry.ino)).toContain(laterSegmentInode)
    // The new segment's name was made durable in the directory that holds it,
    // not in the removed one a kept descriptor would still point at. Windows
    // syncs no directory.
    expect(adapter.synced.some((entry) => entry.journalDirectory)).toBe(
      process.platform !== 'win32'
    )
  })
})
