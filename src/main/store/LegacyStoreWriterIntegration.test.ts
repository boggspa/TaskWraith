import fs from 'node:fs'
import path from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'

const userDataPath = vi.hoisted(
  () => `/tmp/taskwraith-legacy-writer-integration-${process.pid}-${Date.now()}`
)

vi.mock('electron', () => ({ app: { getPath: () => userDataPath } }))

import { AppStore } from '../store'
import { LegacyStoreWriterGateClosedError, legacyStoreWriterGate } from './LegacyStoreWriterGate'
import type { ChatRecord } from './types'

afterAll(() => fs.rmSync(userDataPath, { recursive: true, force: true }))

function snapshotTree(root: string): unknown[] {
  const rows: unknown[] = []
  const visit = (current: string): void => {
    if (!fs.existsSync(current)) return
    const stat = fs.lstatSync(current)
    const relative = path.relative(root, current) || '.'
    rows.push({
      relative,
      kind: stat.isDirectory() ? 'directory' : 'file',
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(stat.isFile() ? { contents: fs.readFileSync(current).toString('base64') } : {})
    })
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current).sort()) visit(path.join(current, entry))
    }
  }
  visit(root)
  return rows
}

it('fences Host-owned workspace/chat writes while leaving settings available', async () => {
  const workspacePath = path.join(userDataPath, 'workspace')
  AppStore.addOrUpdateWorkspace(workspacePath)
  const workspacesFile = path.join(userDataPath, 'workspaces.json')
  const workspacesBefore = fs.readFileSync(workspacesFile, 'utf8')
  const existingChat: ChatRecord = {
    appChatId: 'existing-chat',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'gemini',
    title: 'Existing chat',
    workspaceId: 'workspace-1',
    workspacePath,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: []
  }
  AppStore.saveChat(existingChat)
  const hostOwnedBytesBefore = snapshotTree(userDataPath)

  expect(legacyStoreWriterGate.beginDrain()).toBe(true)
  await legacyStoreWriterGate.awaitDrained()
  expect(
    legacyStoreWriterGate.markHostOwned({
      hostId: 'node-host-integration',
      generation: 1,
      cutoverId: 'cutover-integration'
    })
  ).toBe(true)

  expect(() => AppStore.addOrUpdateWorkspace(path.join(userDataPath, 'late-workspace'))).toThrow(
    LegacyStoreWriterGateClosedError
  )
  const chat: ChatRecord = {
    ...existingChat,
    appChatId: 'late-chat',
    title: 'Late chat'
  }
  expect(() => AppStore.saveChat(chat)).toThrow(LegacyStoreWriterGateClosedError)
  expect(() => AppStore.deleteChat(existingChat.appChatId)).toThrow(
    LegacyStoreWriterGateClosedError
  )
  expect(() => AppStore.truncateChatHistory(existingChat.appChatId)).toThrow(
    LegacyStoreWriterGateClosedError
  )
  expect(() => AppStore.clearChats()).toThrow(LegacyStoreWriterGateClosedError)
  expect(fs.readFileSync(workspacesFile, 'utf8')).toBe(workspacesBefore)
  expect(fs.existsSync(path.join(userDataPath, 'chats', 'late-chat.json'))).toBe(false)
  expect(snapshotTree(userDataPath)).toEqual(hostOwnedBytesBefore)

  expect(() => AppStore.updateSettings({ themeAppearance: 'dark' })).not.toThrow()
  expect(
    JSON.parse(fs.readFileSync(path.join(userDataPath, 'settings.json'), 'utf8'))
  ).toMatchObject({
    themeAppearance: 'dark'
  })
})
