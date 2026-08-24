import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatRecord } from './types'

const userDataPath = vi.hoisted(
  () => `/tmp/taskwraith-legacy-read-only-import-${process.pid}-${Date.now()}`
)

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`electron:${plain}`, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace(/^electron:/, '')
  }
}))

function snapshotTree(root: string): unknown[] {
  const rows: unknown[] = []
  const visit = (current: string): void => {
    const stat = fs.lstatSync(current)
    rows.push({
      relative: path.relative(root, current) || '.',
      kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(stat.isFile() ? { contents: fs.readFileSync(current).toString('base64') } : {})
    })
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current).sort()) visit(path.join(current, entry))
    }
  }
  if (!fs.existsSync(root)) return [{ relative: '.', kind: 'missing' }]
  visit(root)
  return rows
}

function chatFixture(): ChatRecord {
  return {
    appChatId: 'read-chat',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'gemini',
    title: 'Read-only fixture',
    workspaceId: 'workspace-1',
    workspacePath: '/workspace',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: []
  }
}

afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  const { resetHostStoreRuntimeForTests } = await import('../../host-runtime/HostStoreRuntime')
  resetHostStoreRuntimeForTests()
  vi.resetModules()
  fs.rmSync(userDataPath, { recursive: true, force: true })
})

it('imports Host-owned legacy data in read-only mode without repairing any profile artifact', async () => {
  vi.resetModules()
  vi.useFakeTimers()
  fs.rmSync(userDataPath, { recursive: true, force: true })
  fs.mkdirSync(path.join(userDataPath, 'chats'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(userDataPath, 'chat-journal'), { mode: 0o700 })
  fs.mkdirSync(path.join(userDataPath, 'chat-journal-v2'), { mode: 0o700 })

  const chat = chatFixture()
  const checkpoint = {
    format: 'taskwraith-chat-checkpoint',
    version: 1,
    chatId: chat.appChatId,
    revision: 0,
    savedAt: '2026-08-24T00:00:00.000Z',
    reason: 'initial',
    record: chat
  }
  const fatIndexEntry = {
    chatId: chat.appChatId,
    entry: {
      appChatId: chat.appChatId,
      title: chat.title,
      workspaceId: chat.workspaceId,
      provider: chat.provider,
      ensemble: { participants: [{ id: 'seat-1', instructions: 'fat legacy brief' }] }
    }
  }

  fs.writeFileSync(path.join(userDataPath, 'workspaces.json'), '{corrupt-workspaces', 'utf8')
  fs.writeFileSync(path.join(userDataPath, 'chats', 'corrupt-chat.json'), '{corrupt-chat', 'utf8')
  fs.writeFileSync(path.join(userDataPath, 'chats', `${chat.appChatId}.json`), JSON.stringify(chat))
  fs.writeFileSync(
    path.join(userDataPath, 'chat-journal', `${chat.appChatId}.jsonl`),
    `${JSON.stringify({ savedAt: checkpoint.savedAt, record: chat })}\n{"torn`,
    'utf8'
  )
  fs.writeFileSync(
    path.join(userDataPath, 'chat-journal-v2', `${chat.appChatId}.checkpoint.json`),
    JSON.stringify(checkpoint),
    'utf8'
  )
  fs.writeFileSync(
    path.join(userDataPath, 'chat-journal-v2', `${chat.appChatId}.mutations.jsonl`),
    '{"torn',
    'utf8'
  )
  fs.writeFileSync(
    path.join(userDataPath, 'chat-list-index.json'),
    JSON.stringify({ [chat.appChatId]: fatIndexEntry.entry }),
    'utf8'
  )
  fs.writeFileSync(
    path.join(userDataPath, 'chat-list-index.jsonl'),
    `${JSON.stringify(fatIndexEntry)}\n`,
    'utf8'
  )
  const hostOwnedPaths = [
    path.join(userDataPath, 'workspaces.json'),
    path.join(userDataPath, 'chats'),
    path.join(userDataPath, 'chat-journal'),
    path.join(userDataPath, 'chat-journal-v2'),
    path.join(userDataPath, 'chat-list-index.json'),
    path.join(userDataPath, 'chat-list-index.jsonl'),
    path.join(userDataPath, 'chat-list-summaries')
  ]
  const before = hostOwnedPaths.map(snapshotTree)

  const { configureHostStoreRuntime } = await import('../../host-runtime/HostStoreRuntime')
  configureHostStoreRuntime({
    profilePath: userDataPath,
    secureStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`node:${plain}`, 'utf8'),
      decryptString: (encrypted) => encrypted.toString('utf8').replace(/^node:/, '')
    }
  })
  const { legacyStoreWriterGate } = await import('./LegacyStoreWriterGate')
  expect(legacyStoreWriterGate.beginDrain()).toBe(true)
  await legacyStoreWriterGate.awaitDrained()
  expect(
    legacyStoreWriterGate.markHostOwned({
      hostId: 'node-host-read-only-import',
      generation: 1,
      cutoverId: 'cutover-read-only-import'
    })
  ).toBe(true)

  const { AppStore } = await import('./index')
  expect(AppStore.getWorkspaces()).toEqual([])
  expect(AppStore.getChat('corrupt-chat')).toBeNull()
  expect(AppStore.getChat(chat.appChatId)?.appChatId).toBe(chat.appChatId)
  expect(() => AppStore.getChatList()).not.toThrow()
  expect(AppStore.flushChatSave(chat.appChatId)).toBe(false)
  AppStore.flushAllChatSaves()
  await vi.advanceTimersByTimeAsync(15_000)

  expect(hostOwnedPaths.map(snapshotTree)).toEqual(before)
})
