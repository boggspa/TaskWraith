import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HostThreadRecordPersistInput,
  HostThreadRecordPersistPort
} from './HostThreadRecordPersistCommand'

const profiles: string[] = []

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

interface WiredStore {
  AppStore: typeof import('../store/index').AppStore
  profilePath: string
  persistPort: HostThreadRecordPersistPort & {
    enqueue: ReturnType<typeof vi.fn>
    drain: ReturnType<typeof vi.fn>
    drainAll: ReturnType<typeof vi.fn>
  }
  enqueued: HostThreadRecordPersistInput[]
}

async function importStore(options?: { hostOwnGate?: boolean }): Promise<WiredStore> {
  const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-persist-drain-shutdown-'))
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
  const { AppStore } = await import('../store/index')
  const { legacyStoreWriterGate } = await import('../store/LegacyStoreWriterGate')
  if (options?.hostOwnGate !== false) {
    if (!legacyStoreWriterGate.beginDrain()) throw new Error('test gate did not begin draining')
    const owned = legacyStoreWriterGate.markHostOwned({
      hostId: 'test-host',
      generation: 1,
      cutoverId: 'test-cutover'
    })
    if (!owned) throw new Error('test gate did not become host-owned')
  }
  const enqueued: HostThreadRecordPersistInput[] = []
  const persistPort = {
    persist: vi.fn(),
    enqueue: vi.fn((input: HostThreadRecordPersistInput) => {
      enqueued.push(input)
    }),
    drain: vi.fn(async () => {}),
    drainAll: vi.fn(async () => {}),
    pending: vi.fn(() => 0)
  }
  AppStore.setHostThreadRecordPersistPortForTests(persistPort)
  return { AppStore, profilePath, persistPort, enqueued }
}

function chatRecord(appChatId: string): Record<string, unknown> {
  return {
    appChatId,
    scope: 'global',
    chatKind: 'single',
    provider: 'codex',
    title: 'Quit-time loss probe',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    workflowMode: 'normal',
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        content: 'This transcript row must survive quit.',
        timestamp: '2026-08-28T00:00:00.000Z'
      }
    ],
    runs: []
  }
}

function seedRunningChat(profilePath: string, appChatId: string): Record<string, unknown> {
  const record = {
    ...chatRecord(appChatId),
    persistenceRevision: 3,
    runs: [
      {
        runId: 'run-1',
        startedAt: '2026-08-28T00:00:00.000Z',
        status: 'running'
      }
    ]
  }
  const chatsDir = join(profilePath, 'chats')
  mkdirSync(chatsDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(chatsDir, `${appChatId}.json`), JSON.stringify(record), { mode: 0o600 })
  return record
}

describe('HostPersistDrainShutdown', () => {
  it('checkpoints D1, materializes its latest Host record, then drains at shutdown', async () => {
    const { AppStore, profilePath, persistPort, enqueued } = await importStore()
    const chatId = 'chat-shutdown-drain'
    const seeded = seedRunningChat(profilePath, chatId)
    AppStore.saveChat({ ...seeded, title: 'Latest journal-backed title' } as never)
    expect(enqueued).toHaveLength(0)

    await AppStore.flushAllChatSaves()

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({ chatId, expectedRevision: 3 })
    expect(enqueued[0].record).toMatchObject({
      title: 'Latest journal-backed title',
      persistenceRevision: 4
    })
    expect(persistPort.drainAll).toHaveBeenCalledTimes(1)
    expect(existsSync(join(profilePath, 'chat-journal-v2', `${chatId}.checkpoint.json`))).toBe(true)
    expect(existsSync(join(profilePath, 'chat-journal-v2', `${chatId}.mutations.jsonl`))).toBe(
      false
    )
  })

  it('bounds the shutdown drain so a hung Host cannot hold the process open, and reports the unconfirmed records', async () => {
    const { AppStore, persistPort } = await importStore()
    // A Host that never answers: the lane stays in flight forever.
    persistPort.drainAll.mockImplementationOnce(() => new Promise<void>(() => {}))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      AppStore.saveChat(chatRecord('chat-shutdown-timeout') as never)
      const started = Date.now()
      await AppStore.flushAllChatSaves({ hostDrainTimeoutMs: 25 })
      // Quit proceeded well inside any plausible Host timeout instead of
      // hanging on the unreachable Host.
      expect(Date.now() - started).toBeLessThan(5_000)
      // The loss is loud, not silent: the report names the unconfirmed count.
      expect(consoleError).toHaveBeenCalled()
      const report = consoleError.mock.calls.flat().join(' ')
      expect(report).toContain('1')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('reports a Host persist failure at shutdown without blocking quit', async () => {
    const { AppStore, persistPort } = await importStore()
    persistPort.drainAll.mockRejectedValueOnce(new Error('Host socket closed'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      AppStore.saveChat(chatRecord('chat-shutdown-failure') as never)
      await expect(AppStore.flushAllChatSaves()).resolves.toBeUndefined()
      expect(consoleError).toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('keeps the legacy coalescer flush path when the writer gate is open', async () => {
    const { AppStore, persistPort } = await importStore({ hostOwnGate: false })
    AppStore.saveChat(chatRecord('chat-shutdown-legacy') as never)
    await AppStore.flushAllChatSaves()
    expect(persistPort.drainAll).not.toHaveBeenCalled()
    expect(AppStore.getChat('chat-shutdown-legacy')?.title).toBe('Quit-time loss probe')
  })
})
