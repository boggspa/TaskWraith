import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { HostProfileDomainStore } from '../../src/host-runtime/HostProfileDomainStore'

const require = createRequire(import.meta.url)
const { buildSoakFixture } = require('./multiviewSoakDriver.cjs')

it('the multiview fixtures are accepted by the actual Host record decoder and durable writer', () => {
  const profilePath = mkdtempSync(join(tmpdir(), 'soak-profile-compat-'))
  try {
    const store = new HostProfileDomainStore({
      profilePath,
      authority: { assertProfileAuthority: () => {} }
    })
    const { fixture, pagedChatId } = buildSoakFixture({ paneCount: 4 })
    for (const chat of fixture.chats) {
      const workspace = store.registerWorkspace({ path: profilePath })
      const bound = {
        ...chat,
        scope: 'workspace',
        workspaceId: workspace.id,
        workspacePath: workspace.path
      }
      const saved = store.persistThreadRecord({
        threadId: chat.appChatId,
        expectedRevision: 0,
        record: bound
      })
      expect(saved.appChatId).toBe(chat.appChatId)
      expect(store.getThread(chat.appChatId)?.messages.length).toBe(chat.messages.length)
    }
    expect(
      fixture.chats.find((chat: { appChatId: string }) => chat.appChatId === pagedChatId).messages
        .length
    ).toBeGreaterThan(1500)
  } finally {
    rmSync(profilePath, { recursive: true, force: true })
  }
})
