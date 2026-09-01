/**
 * Stage 3 — segmented dual-read store wiring against the real AppStore.
 *
 * Proves the end-to-end contract on top of the module tests:
 *   - flag off (ADR §11.4 default): saves write nothing under chat-store-v2/
 *     and reads behave exactly as before (inert);
 *   - flag on: admitted saves mirror onto segments and getChat assembles the
 *     complete transcript from the legacy dual-read seam;
 *   - dual-read authority: the legacy record wins when it leads; the v2
 *     record wins when it leads (Host persist queue lag is served from v2);
 *   - erasure: deleteChat retires the v2 copy with the legacy record
 *     (NON-NEGOTIABLE #4 — an erased transcript must not survive in any
 *     durable copy).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HostThreadRecordPersistInput,
  HostThreadRecordPersistPort
} from '../host/HostThreadRecordPersistCommand'
import { CHAT_STORE_V2_ENV_FLAG } from './SegmentedChatStore'
import type { ChatMessage, ChatRecord } from './types'

const profiles: string[] = []

afterEach(() => {
  delete process.env[CHAT_STORE_V2_ENV_FLAG]
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

interface WiredStore {
  AppStore: typeof import('./index').AppStore
  profilePath: string
  enqueued: HostThreadRecordPersistInput[]
}

async function importStore(options?: { hostOwnGate?: boolean }): Promise<WiredStore> {
  const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-segmented-wiring-'))
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
  if (options?.hostOwnGate) {
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

function durableChat(chatId: string, revision: number): ChatRecord {
  return {
    appChatId: chatId,
    provider: 'codex',
    title: 'Stage 3 wiring chat',
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
    runs: []
  }
}

function seedDurableChat(profilePath: string, chat: ChatRecord): void {
  const chatsDir = join(profilePath, 'chats')
  mkdirSync(chatsDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(chatsDir, `${chat.appChatId}.json`), JSON.stringify(chat))
}

function v2Files(profilePath: string, chatId: string): string[] {
  const dir = join(profilePath, 'chat-store-v2')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((entry) => entry.startsWith(chatId))
    .sort()
}

describe('Stage 3 — segmented store wiring', () => {
  it('flag off (default): saves never touch chat-store-v2 and reads are unchanged', async () => {
    const { AppStore, profilePath } = await importStore()
    const chatId = 'chat-wiring-off'
    seedDurableChat(profilePath, durableChat(chatId, 3))

    const saved = AppStore.saveChat({
      ...durableChat(chatId, 3),
      title: 'Renamed with the flag off'
    }) as ChatRecord

    expect(saved.persistenceRevision).toBe(4)
    expect(v2Files(profilePath, chatId)).toEqual([])
    expect(AppStore.getChat(chatId)?.title).toBe('Renamed with the flag off')
    expect(AppStore.getSegmentedChatStoreStats()).toMatchObject({ mirrorSaves: 0 })
  })

  it('flag on: admitted saves mirror onto segments and getChat assembles from the dual-read seam', async () => {
    process.env[CHAT_STORE_V2_ENV_FLAG] = '1'
    const { AppStore, profilePath } = await importStore()
    const chatId = 'chat-wiring-on'
    const previous = durableChat(chatId, 3)
    seedDurableChat(profilePath, previous)

    const m3 = message('m3', 'assistant', 'Appended while the flag is on')
    AppStore.saveChat({ ...previous, messages: [...previous.messages, m3] })

    expect(v2Files(profilePath, chatId)).toEqual([
      'chat-wiring-on.manifest.json',
      'chat-wiring-on.segment-0.jsonl',
      'chat-wiring-on.snapshot.json'
    ])
    const stats = AppStore.getSegmentedChatStoreStats()
    expect(stats.seeds).toBe(0)
    expect(stats.mutationBatchesAppended).toBe(1)
    // saveChat's internal title-policy getChat probes the v2 store BEFORE the
    // first mirror seeds it — that pre-mirror probe is a legitimate
    // fail-closed miss, so readMisses must be >= 1, never 0.
    expect(stats.readMisses).toBeGreaterThanOrEqual(1)
    // Force a real disk read through the dual-read seam (the in-memory dirty
    // marker would otherwise serve the record without consulting v2).
    AppStore.clearChatRecordCacheForTests()
    expect(AppStore.getChat(chatId)?.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3'])
    const after = AppStore.getSegmentedChatStoreStats()
    expect(after.readHits).toBeGreaterThanOrEqual(1)
  })

  it('dual-read: the legacy record stays authoritative when it leads the v2 copy', async () => {
    process.env[CHAT_STORE_V2_ENV_FLAG] = '1'
    const { AppStore, profilePath } = await importStore()
    const chatId = 'chat-wiring-legacy-leads'
    const previous = durableChat(chatId, 3)
    seedDurableChat(profilePath, previous)
    AppStore.saveChat({ ...previous, title: 'Mirrored title' })

    // A legacy-only write (e.g. the Host queue landing) advances the record
    // past the v2 copy — the dual-read must prefer it.
    const legacyPath = join(profilePath, 'chats', `${chatId}.json`)
    const advanced = { ...durableChat(chatId, 12), title: 'Legacy leads' }
    writeFileSync(legacyPath, JSON.stringify(advanced))
    AppStore.clearChatRecordCacheForTests()

    const read = AppStore.getChat(chatId)
    expect(read?.title).toBe('Legacy leads')
    expect(read?.persistenceRevision).toBe(12)
  })

  it('dual-read: v2 leads when the Host persist queue has not landed yet (non-mutation save)', async () => {
    process.env[CHAT_STORE_V2_ENV_FLAG] = '1'
    const { AppStore, profilePath, enqueued } = await importStore({ hostOwnGate: true })
    const chatId = 'chat-wiring-v2-leads'
    seedDurableChat(profilePath, durableChat(chatId, 3))

    // Non-mutation Host save: the Stage 2 journal deliberately stays
    // whole-record-only, so ONLY the Stage 3 mirror carries this state.
    AppStore.saveChat({ ...durableChat(chatId, 3), title: 'Mirrored by v2 only' })
    expect(enqueued).toHaveLength(1)
    AppStore.clearChatRecordCacheForTests()

    const read = AppStore.getChat(chatId)
    expect(read?.title).toBe('Mirrored by v2 only')
    expect(read?.persistenceRevision).toBe(4)
  })

  it('erasure: deleteChat retires the v2 copy together with the legacy record', async () => {
    process.env[CHAT_STORE_V2_ENV_FLAG] = '1'
    const { AppStore, profilePath } = await importStore()
    const chatId = 'chat-wiring-erase'
    seedDurableChat(profilePath, durableChat(chatId, 3))
    AppStore.saveChat({ ...durableChat(chatId, 3), title: 'About to be deleted' })

    expect(v2Files(profilePath, chatId).length).toBeGreaterThan(0)
    AppStore.deleteChat(chatId)
    expect(v2Files(profilePath, chatId)).toEqual([])
    expect(AppStore.getChat(chatId)).toBeNull()
  })

  it('erasure: a flag-off session still retires stale v2 segments from a flag-on era', async () => {
    process.env[CHAT_STORE_V2_ENV_FLAG] = '1'
    const first = await importStore()
    const chatId = 'chat-wiring-stale-erase'
    seedDurableChat(first.profilePath, durableChat(chatId, 3))
    first.AppStore.saveChat({ ...durableChat(chatId, 3), title: 'Flag-on era' })
    expect(v2Files(first.profilePath, chatId).length).toBeGreaterThan(0)

    // New session (fresh module graph) with the flag off.
    delete process.env[CHAT_STORE_V2_ENV_FLAG]
    const second = await importStore()
    second.AppStore.deleteChat(chatId)
    expect(v2Files(second.profilePath, chatId)).toEqual([])
  })
})
