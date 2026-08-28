import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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

interface ErasureDeleteInput {
  chatId: string
  expectedRevision: number
}

interface WiredStore {
  AppStore: typeof import('../store/index').AppStore
  profilePath: string
  chatsDir: string
  deleted: ErasureDeleteInput[]
  persisted: HostThreadRecordPersistInput[]
  persistPort: HostThreadRecordPersistPort & {
    deleteRecord: ReturnType<typeof vi.fn>
    persist: ReturnType<typeof vi.fn>
  }
}

function minimalChatRecord(appChatId: string, revision: number): Record<string, unknown> {
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
        timestamp: '2026-08-28T00:00:00.000Z'
      }
    ],
    runs: [],
    persistenceRevision: revision
  }
}

async function importStoreWithHostOwnedGate(
  chatSeeds: Array<{ id: string; revision: number; workspaceId?: string; workspacePath?: string }>
): Promise<WiredStore> {
  const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-chat-erasure-wiring-'))
  profiles.push(profilePath)
  const chatsDir = join(profilePath, 'chats')
  mkdirSync(chatsDir, { recursive: true, mode: 0o700 })
  for (const seed of chatSeeds) {
    const record = {
      ...minimalChatRecord(seed.id, seed.revision),
      ...(seed.workspaceId
        ? { scope: 'workspace', workspaceId: seed.workspaceId, workspacePath: seed.workspacePath }
        : {})
    }
    const filePath = join(chatsDir, `${seed.id}.json`)
    writeFileSync(filePath, JSON.stringify(record))
    chmodSync(filePath, 0o600)
  }
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
  const deleted: ErasureDeleteInput[] = []
  const persisted: HostThreadRecordPersistInput[] = []
  // Faithful Host-mimicking port: persist applies the real persistThreadRecord
  // revision contract to the tmp profile (create=0, update=previous+1), and
  // delete removes the file — so the transaction's read-backs see exactly what
  // a real Host would leave behind.
  const persistPort = {
    persist: vi.fn(async (input: HostThreadRecordPersistInput) => {
      persisted.push(input)
      const filePath = join(chatsDir, `${input.chatId}.json`)
      const currentRaw = existsSync(filePath)
        ? (JSON.parse(readFileSync(filePath, 'utf8')) as { persistenceRevision?: number })
        : null
      const currentRevision =
        currentRaw && Number.isSafeInteger(currentRaw.persistenceRevision)
          ? (currentRaw.persistenceRevision as number)
          : 0
      if (currentRaw === null && input.expectedRevision !== 0) {
        throw new Error('Thread is not found')
      }
      if (currentRaw !== null && currentRevision !== input.expectedRevision) {
        throw new Error('Thread persistence revision mismatch')
      }
      const next = {
        ...(input.record as unknown as Record<string, unknown>),
        persistenceRevision: currentRaw === null ? 0 : currentRevision + 1
      }
      writeFileSync(filePath, JSON.stringify(next))
      chmodSync(filePath, 0o600)
      return {} as never
    }),
    deleteRecord: vi.fn(async (input: ErasureDeleteInput) => {
      deleted.push(input)
      rmSync(join(chatsDir, `${input.chatId}.json`), { force: true })
    }),
    enqueue: vi.fn(),
    drain: vi.fn(async () => {}),
    drainAll: vi.fn(async () => {}),
    pending: vi.fn(() => 0)
  }
  AppStore.setHostThreadRecordPersistPortForTests(persistPort as HostThreadRecordPersistPort)
  return { AppStore, profilePath, chatsDir, deleted, persisted, persistPort }
}

describe('HostChatErasureWiring', () => {
  it('(a) routes deleteChat through thread.record.delete when the gate is Host-owned', async () => {
    const { AppStore, chatsDir, deleted, persisted } = await importStoreWithHostOwnedGate([
      { id: 'chat-del', revision: 2 }
    ])
    // RED-first evidence: at HEAD 07aa234a1 this call threw
    // LegacyStoreWriterGateClosedError synchronously out of the legacy
    // admission gate. It must now complete through the Host route.
    await AppStore.deleteChatViaHost('chat-del')
    expect(deleted).toEqual([{ chatId: 'chat-del', expectedRevision: 2 }])
    // The Host-side fake removed the file, and the transaction completed:
    // no durable intent remains pending.
    expect(existsSync(join(chatsDir, 'chat-del.json'))).toBe(false)
    expect(AppStore.getPendingHistoryDeletion()).toBeNull()
    expect(AppStore.getChat('chat-del')).toBeNull()
    // Tombstone: a late save for the deleted chat must not resurrect it.
    AppStore.saveChat(minimalChatRecord('chat-del', 3) as never)
    expect(persisted).toHaveLength(0)
  })

  it('(b) routes truncate through thread.record.persist with the scrubbed complete record', async () => {
    const { AppStore, chatsDir, deleted, persisted } = await importStoreWithHostOwnedGate([
      { id: 'chat-trunc', revision: 5 }
    ])
    const truncated = await AppStore.truncateChatHistoryViaHost('chat-trunc')
    expect(deleted).toHaveLength(0)
    expect(persisted).toHaveLength(1)
    const [input] = persisted
    expect(input.chatId).toBe('chat-trunc')
    expect(input.expectedRevision).toBe(5)
    const record = input.record as unknown as {
      messages: unknown[]
      runs: unknown[]
      persistenceRevision?: number
    }
    expect(record.messages).toEqual([])
    expect(record.runs).toEqual([])
    expect(record.persistenceRevision).toBe(6)
    expect(truncated?.messages).toEqual([])
    // The faithful fake landed the write, so the durable file is the scrubbed
    // record at the next Host-owned revision.
    const onDisk = JSON.parse(readFileSync(join(chatsDir, 'chat-trunc.json'), 'utf8')) as {
      messages: unknown[]
      persistenceRevision?: number
    }
    expect(onDisk.messages).toEqual([])
    expect(onDisk.persistenceRevision).toBe(6)
  })

  it('(c) clears one workspace through repeated thread.record.delete only for that scope', async () => {
    const { AppStore, deleted } = await importStoreWithHostOwnedGate([
      { id: 'ws-a-1', revision: 1, workspaceId: 'ws-a', workspacePath: '/tmp/ws-a' },
      { id: 'ws-a-2', revision: 4, workspaceId: 'ws-a', workspacePath: '/tmp/ws-a' },
      { id: 'ws-b-1', revision: 7, workspaceId: 'ws-b', workspacePath: '/tmp/ws-b' }
    ])
    await AppStore.clearChatsViaHost('ws-a')
    expect(deleted.map((input) => input.chatId).sort()).toEqual(['ws-a-1', 'ws-a-2'])
    expect(deleted.find((input) => input.chatId === 'ws-a-1')?.expectedRevision).toBe(1)
    expect(deleted.find((input) => input.chatId === 'ws-a-2')?.expectedRevision).toBe(4)
    expect(AppStore.getChat('ws-a-1')).toBeNull()
    expect(AppStore.getChat('ws-a-2')).toBeNull()
    expect(AppStore.getChat('ws-b-1')?.title).toBe('Chat ws-b-1')
  })

  it('(d) clears every chat globally through repeated thread.record.delete', async () => {
    const { AppStore, chatsDir, deleted } = await importStoreWithHostOwnedGate([
      { id: 'g-1', revision: 0 },
      { id: 'g-2', revision: 9 }
    ])
    await AppStore.clearChatsViaHost()
    expect(deleted.map((input) => input.chatId).sort()).toEqual(['g-1', 'g-2'])
    expect(AppStore.getChat('g-1')).toBeNull()
    expect(AppStore.getChat('g-2')).toBeNull()
    expect(existsSync(join(chatsDir, 'g-1.json'))).toBe(false)
    expect(existsSync(join(chatsDir, 'g-2.json'))).toBe(false)
  })
})
