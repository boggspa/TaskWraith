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

/** Last-writer-wins projection of a chat's row in the incremental JSONL index. */
function readIndexEntry(
  root: string,
  chatId: string
): { sourceChatMtimeMs?: number; sourceChatSize?: number; ensemble?: unknown } | null {
  const indexPath = path.join(root, 'chat-list-index.jsonl')
  if (!fs.existsSync(indexPath)) return null
  let found: Record<string, unknown> | null = null
  for (const line of fs.readFileSync(indexPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed)
      if (rec.chatId === chatId && rec.entry) found = rec.entry
    } catch {
      /* skip corrupt */
    }
  }
  return found as { sourceChatMtimeMs?: number; sourceChatSize?: number; ensemble?: unknown } | null
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
  // The AUTHORITATIVE families the standalone Host owns stay byte-frozen: the
  // in-process AppStore reads them but must neither rewrite them nor drop a
  // `.corrupt-*` backup beside a corrupt one. The legacy chat-list-index.json
  // monolith rides with them — the incremental JSONL superseded it, so nothing
  // rewrites the old file under Host ownership.
  const frozenPaths = [
    path.join(userDataPath, 'workspaces.json'),
    path.join(userDataPath, 'chats'),
    path.join(userDataPath, 'chat-journal'),
    path.join(userDataPath, 'chat-journal-v2'),
    path.join(userDataPath, 'chat-list-index.json')
  ]
  const before = frozenPaths.map(snapshotTree)

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

  expect(frozenPaths.map(snapshotTree)).toEqual(before)

  // The chat-list index is a DERIVED accelerator the Host never writes — only
  // this process does. Freezing it under Host ownership (the original gate) is
  // what let it rot corpus-wide: a row that cannot be restamped never vouches,
  // so every boot scan and first-paint getChatList fell back to a full record
  // read+replay — the 30-60min cold-boot stall on large profiles. So under Host
  // ownership the index is REFRESHED, not frozen. Prove the fat, non-vouching
  // legacy row was replaced by a lean row whose stat matches the chat on disk:
  // the row now vouches, and the next scan takes the stat-only shortcut.
  const chatStat = fs.statSync(path.join(userDataPath, 'chats', `${chat.appChatId}.json`))
  const refreshed = readIndexEntry(userDataPath, chat.appChatId)
  expect(refreshed, 'index row was not refreshed under Host ownership').toBeTruthy()
  expect(refreshed?.sourceChatMtimeMs).toBe(chatStat.mtimeMs)
  expect(refreshed?.sourceChatSize).toBe(chatStat.size)
})
