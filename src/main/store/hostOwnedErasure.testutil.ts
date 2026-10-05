/**
 * The real store over a temporary profile whose chats the Host owns, for
 * erasure tests that must take the Host route.
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
import { dirname, join, sep } from 'node:path'

import { vi } from 'vitest'

import type {
  HostThreadRecordPersistInput,
  HostThreadRecordPersistPort
} from '../host/HostThreadRecordPersistCommand'
import type { DurabilityFlusherPorts } from './MainDurabilityFlusher'
import type { ChatRecord } from './types'

const PREFIX = 'owner-host-owned-erasure-'
const profiles: string[] = []
const shutdowns: Array<() => Promise<void>> = []

/**
 * Removes a folder this file made with mkdtemp under the temporary folder,
 * and refuses anything else.
 */
function removeTemporary(directory: string): void {
  const own = tmpdir() + sep + PREFIX
  if (directory === tmpdir() || !directory.startsWith(own) || directory.includes(sep, own.length)) {
    throw new Error(`Refusing to remove ${directory}`)
  }
  rmSync(directory, { recursive: true, force: true })
}

/** Call after each test: stops every store it opened and removes their profiles. */
export async function disposeHostOwnedStores(): Promise<void> {
  while (shutdowns.length > 0) await shutdowns.pop()!()
  vi.doUnmock('./MainDurabilityRuntime')
  while (profiles.length > 0) removeTemporary(profiles.pop()!)
}

export function chatRecord(
  appChatId: string,
  revision: number,
  overrides: Partial<ChatRecord> = {}
): ChatRecord {
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
    persistenceRevision: revision,
    ...overrides
  }
}

/** One descriptor the journal's flusher closed, and what was on disk then. */
export interface ClosedDescriptor {
  ino: number
  directory: boolean
  /** Names in the journal directory at the close; null once it is gone. */
  journalFilesAtClose: string[] | null
}

/** One sync the journal's flusher ran. */
export interface SyncedDescriptor {
  ino: number
  /** True when the descriptor was the directory the journal's name led to then. */
  journalDirectory: boolean
}

/** A journal adapter over the real filesystem that records what it synced and closed. */
export interface RecordingAdapter extends DurabilityFlusherPorts {
  dispose(): Promise<void>
  readonly closed: ClosedDescriptor[]
  readonly synced: SyncedDescriptor[]
}

export function recordingAdapter(journalDirectory: () => string): RecordingAdapter {
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

export interface HostOwnedStore {
  AppStore: typeof import('./index').AppStore
  profilePath: string
  journalDirectory: string
}

/**
 * The real store over a temporary profile with the legacy writer gate
 * Host-owned, so erasure takes the Host route. `adapter` attaches the journal
 * flusher (and so the journal's descriptor cache) exactly as the composition
 * does under its rollout switch, without touching the process environment.
 * `profilePath` starts a store again over a profile an earlier one used, as a
 * restarted process would. `gateOpen` leaves the legacy writer gate open, as
 * it was before the Host owned the store, so saves take the admitted path.
 */
export async function importHostOwnedStore(
  seeds: ChatRecord[],
  adapter?: RecordingAdapter,
  options: { profilePath?: string; gateOpen?: boolean } = {}
): Promise<HostOwnedStore> {
  const profilePath = options.profilePath ?? mkdtempSync(join(tmpdir(), PREFIX))
  if (options.profilePath === undefined) profiles.push(profilePath)
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
  if (options.gateOpen)
    return { AppStore, profilePath, journalDirectory: join(profilePath, 'chat-journal-v2') }
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
      const recordPath = join(chatsDir, `${input.chatId}.json`)
      // One record of this profile, never anything outside its folder.
      if (dirname(recordPath) !== chatsDir) throw new Error(`Refusing to remove ${recordPath}`)
      rmSync(recordPath, { force: true })
    }),
    enqueue: vi.fn((input: HostThreadRecordPersistInput) => applyPersist(input)),
    drain: vi.fn(async () => {}),
    drainAll: vi.fn(async () => {}),
    pending: vi.fn(() => 0)
  }
  AppStore.setHostThreadRecordPersistPortForTests(persistPort as HostThreadRecordPersistPort)
  return { AppStore, profilePath, journalDirectory: join(profilePath, 'chat-journal-v2') }
}
