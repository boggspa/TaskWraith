/**
 * The store half of "the goal keeps unsetting after I set it".
 *
 * `saveChat` is last-write-wins over the whole record and `activeGoal` is in
 * neither save path's main-owned preserve list, so a save built from a base
 * captured before the goal was written deletes the key silently — no error, an
 * accepted result, a revision bump. `b65bdfb14` closed the renderer half and
 * left this one open; these tests pin the replacement contract on BOTH paths:
 *
 *  - a revision-stale record that omits the goal cannot delete the durable one;
 *  - a record at (or above) the durable revision still clears it — the composer
 *    Clear is a legitimate author and must keep working;
 *  - a record that carries its own goal always wins, stale or not, so Set,
 *    Edit and agent-side lifecycle advances are never refused.
 *
 * Wiring idiom shared with SummaryChatSaveEscalation.test.ts: a fresh module
 * graph per test, a temp profile, the Host persist port replaced by a recording
 * stub, and the writer gate optionally Host-owned.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HostThreadRecordPersistInput,
  HostThreadRecordPersistPort
} from '../host/HostThreadRecordPersistCommand'
import { durableActiveGoalToRestore } from './durableActiveGoalToRestore'
import type { ActiveGoal, ChatMessage, ChatRecord } from './types'

const profiles: string[] = []

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

function goal(overrides: Partial<ActiveGoal> = {}): ActiveGoal {
  return {
    id: 'goal-1',
    objective: 'Stop the regressions',
    objectiveSource: 'user',
    status: 'active',
    mode: 'taskwraith_steered',
    provider: 'muse',
    createdAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z',
    ...overrides
  } as unknown as ActiveGoal
}

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-goal',
    provider: 'muse',
    title: 'Goal chat',
    scope: 'global',
    chatKind: 'single',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: 3,
    archived: false,
    messages: [
      { id: 'm-1', role: 'user', content: 'go', timestamp: '2026-09-10T09:00:00.000Z' }
    ] as ChatMessage[],
    runs: [],
    ...overrides
  } as unknown as ChatRecord
}

describe('durableActiveGoalToRestore', () => {
  it('restores the durable goal when a revision-stale record omits it', () => {
    const previous = chat({ persistenceRevision: 3, activeGoal: goal() })
    const incoming = chat({ persistenceRevision: 2 })
    expect(durableActiveGoalToRestore(incoming, previous)?.id).toBe('goal-1')
  })

  it('treats an omission at the durable revision as a deliberate Clear', () => {
    const previous = chat({ persistenceRevision: 3, activeGoal: goal() })
    const incoming = chat({ persistenceRevision: 3 })
    expect(durableActiveGoalToRestore(incoming, previous)).toBeUndefined()
  })

  it('treats an omission above the durable revision as a deliberate Clear', () => {
    const previous = chat({ persistenceRevision: 3, activeGoal: goal() })
    const incoming = chat({ persistenceRevision: 4 })
    expect(durableActiveGoalToRestore(incoming, previous)).toBeUndefined()
  })

  it('never overrides a goal the caller carries, even from a stale base', () => {
    const previous = chat({ persistenceRevision: 3, activeGoal: goal() })
    const incoming = chat({ persistenceRevision: 2, activeGoal: goal({ id: 'goal-2' }) })
    expect(durableActiveGoalToRestore(incoming, previous)).toBeUndefined()
  })

  it('has nothing to restore when the durable record holds no goal', () => {
    const previous = chat({ persistenceRevision: 3 })
    const incoming = chat({ persistenceRevision: 2 })
    expect(durableActiveGoalToRestore(incoming, previous)).toBeUndefined()
  })

  it('has nothing to restore on a create', () => {
    expect(durableActiveGoalToRestore(chat({ persistenceRevision: 0 }), null)).toBeUndefined()
  })

  it('treats an unreadable incoming revision as stale rather than authoritative', () => {
    const previous = chat({ persistenceRevision: 3, activeGoal: goal() })
    const { persistenceRevision: _dropped, ...withoutRevision } = chat()
    expect(durableActiveGoalToRestore(withoutRevision as ChatRecord, previous)?.id).toBe('goal-1')
  })
})

interface WiredStore {
  AppStore: typeof import('./index').AppStore
  profilePath: string
  enqueued: HostThreadRecordPersistInput[]
}

async function importStore(options: { hostOwnGate: boolean }): Promise<WiredStore> {
  const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-durable-goal-'))
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
  if (options.hostOwnGate) {
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

function seedDurableChat(profilePath: string, record: ChatRecord): void {
  const chatsDir = join(profilePath, 'chats')
  mkdirSync(chatsDir, { recursive: true, mode: 0o700 })
  const chatPath = join(chatsDir, `${record.appChatId}.json`)
  writeFileSync(chatPath, JSON.stringify(record))
  chmodSync(chatPath, 0o600)
}

/** The durable artifact each path writes: the Host enqueue on the Host path,
 *  the flushed record on the admitted path. */
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

describe.each([
  { path: 'Host-routed', hostOwnGate: true },
  { path: 'legacy admitted', hostOwnGate: false }
])('$path save path', ({ hostOwnGate }) => {
  it('keeps the durable goal when a stale whole-record save omits it', async () => {
    const store = await importStore({ hostOwnGate })
    seedDurableChat(store.profilePath, chat({ persistenceRevision: 3, activeGoal: goal() }))

    const saved = store.AppStore.saveChat(chat({ persistenceRevision: 2, title: 'Stale writer' }))

    expect(saved.activeGoal?.id).toBe('goal-1')
    expect(saved.title).toBe('Stale writer')
    expect(durableRecord(store, 'chat-goal', hostOwnGate).activeGoal?.id).toBe('goal-1')
  })

  it('lands a Clear authored at the durable revision', async () => {
    const store = await importStore({ hostOwnGate })
    seedDurableChat(store.profilePath, chat({ persistenceRevision: 3, activeGoal: goal() }))

    const saved = store.AppStore.saveChat(chat({ persistenceRevision: 3 }))

    expect(saved.activeGoal).toBeUndefined()
    expect(durableRecord(store, 'chat-goal', hostOwnGate).activeGoal).toBeUndefined()
  })

  it('lands a goal the caller carries on a stale base', async () => {
    const store = await importStore({ hostOwnGate })
    seedDurableChat(store.profilePath, chat({ persistenceRevision: 3, activeGoal: goal() }))

    const saved = store.AppStore.saveChat(
      chat({ persistenceRevision: 2, activeGoal: goal({ id: 'goal-2', objective: 'Newer' }) })
    )

    expect(saved.activeGoal?.id).toBe('goal-2')
    expect(durableRecord(store, 'chat-goal', hostOwnGate).activeGoal?.id).toBe('goal-2')
  })
})
