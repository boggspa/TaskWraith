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

it('fences Host-owned workspace/chat writes while leaving settings available', async () => {
  const workspacePath = path.join(userDataPath, 'workspace')
  AppStore.addOrUpdateWorkspace(workspacePath)
  const workspacesFile = path.join(userDataPath, 'workspaces.json')
  const workspacesBefore = fs.readFileSync(workspacesFile, 'utf8')

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
    appChatId: 'late-chat',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'gemini',
    title: 'Late chat',
    workspaceId: 'workspace-1',
    workspacePath,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: []
  }
  expect(() => AppStore.saveChat(chat)).toThrow(LegacyStoreWriterGateClosedError)
  expect(fs.readFileSync(workspacesFile, 'utf8')).toBe(workspacesBefore)
  expect(fs.existsSync(path.join(userDataPath, 'chats', 'late-chat.json'))).toBe(false)

  expect(() => AppStore.updateSettings({ themeAppearance: 'dark' })).not.toThrow()
  expect(
    JSON.parse(fs.readFileSync(path.join(userDataPath, 'settings.json'), 'utf8'))
  ).toMatchObject({
    themeAppearance: 'dark'
  })
})
