import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { deriveChatRecordMutation } from './ChatRecordMutation'
import { captureThreadCatalogueWitness } from '../../host-shared/thread-catalogue/ThreadCatalogueWitness'
import type { ChatRecord } from './types'

describe('always-on sealed readers', () => {
  it('authoritative replacement cannot replay superseded sealed history', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-reset-'))
    const base: ChatRecord = {
      appChatId: 'chat',
      title: 'base',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: [],
      persistenceRevision: 1
    }
    try {
      const journal = createIncrementalChatJournal(root)
      journal.initialize('chat', base)
      const sealed = path.join(root, 'chat.sealed.mutations.jsonl')
      fs.writeFileSync(
        sealed,
        JSON.stringify(
          deriveChatRecordMutation(base, { ...base, title: 'obsolete', persistenceRevision: 2 })
        ) + '\n'
      )
      journal.replaceAuthoritativeCheckpoint('chat', { ...base, title: 'authoritative' })
      expect(fs.existsSync(sealed)).toBe(false)
      expect(createIncrementalChatJournal(root).replay('chat').record?.title).toBe('authoritative')
      journal.purge('chat')
      fs.writeFileSync(sealed, '\n')
      journal.initialize('chat', base)
      expect(fs.existsSync(sealed)).toBe(false)
      expect(journal.replay('chat').record?.title).toBe('base')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('replays sealed then active with no rotation flag and leaves read-only torn sources unchanged', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-reader-'))
    const directory = path.join(root, 'chat-journal-v2')
    const base: ChatRecord = {
      appChatId: 'chat',
      title: 'base',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: [],
      persistenceRevision: 1
    }
    try {
      createIncrementalChatJournal(directory).initialize('chat', base)
      const second = { ...base, title: 'sealed', persistenceRevision: 2 }
      const third = { ...second, title: 'active', persistenceRevision: 3 }
      const sealed = path.join(directory, 'chat.sealed.mutations.jsonl')
      const active = path.join(directory, 'chat.mutations.jsonl')
      fs.writeFileSync(sealed, JSON.stringify(deriveChatRecordMutation(base, second)) + '\n{torn')
      fs.writeFileSync(active, JSON.stringify(deriveChatRecordMutation(second, third)) + '\n')
      const reader = createIncrementalChatJournal(directory, {
        canWrite: () => false,
        canRepairOnRead: () => false
      })
      const bytes = fs.readFileSync(sealed)
      expect(reader.replay('chat').record?.title).toBe('active')
      expect(fs.readFileSync(sealed)).toEqual(bytes)
      const options = { profilePath: root, runtimeInstanceId: 'test', segmented: false }
      const before = captureThreadCatalogueWitness(options, 'chat')
      fs.appendFileSync(sealed, 'changed')
      expect(captureThreadCatalogueWitness(options, 'chat').witness).not.toBe(before.witness)
      fs.writeFileSync(
        active,
        JSON.stringify({
          ...deriveChatRecordMutation(second, third),
          baseRevision: 4,
          revision: 5
        }) + '\n'
      )
      const gapReader = createIncrementalChatJournal(directory, { canWrite: () => false })
      expect(() => gapReader.replay('chat')).toThrow('revision gap')
      expect(fs.readFileSync(sealed).toString()).toBe(bytes.toString() + 'changed')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
