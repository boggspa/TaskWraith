import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { createIncrementalChatPersistence } from './IncrementalChatPersistence'
import type { DeferredCheckpointResult } from './CheckpointPreparationProtocol'
import type { ChatRecord } from './types'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'itp-persistence-prepare-'))
  directories.push(dir)
  const journal = createIncrementalChatJournal(dir)
  const persistence = createIncrementalChatPersistence({
    journal,
    logger: { error: vi.fn(), warn: vi.fn() }
  })
  const before: ChatRecord = {
    appChatId: 'chat-1',
    title: 'first',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: 1,
    archived: false,
    messages: [],
    runs: []
  }
  const after = { ...before, title: 'second', updatedAt: 2, persistenceRevision: 2 }
  persistence.persist(null, before, 'normal')
  persistence.persist(before, after, 'normal')
  let settle!: (value: DeferredCheckpointResult) => void
  vi.spyOn(journal, 'checkpointDeferred').mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = resolve
      })
  )
  return { journal, persistence, after, settle: (value: DeferredCheckpointResult) => settle(value) }
}

describe('persistence bookkeeping after prepared checkpoint adoption', () => {
  it('clears mutation accounting only on completed adoption', async () => {
    const { persistence, journal, after, settle } = fixture()
    const bytes = persistence.pendingMutationBytes('chat-1')
    const result = persistence.checkpointChatDeferred('chat-1')
    expect(persistence.pendingMutationBytes('chat-1')).toBe(bytes)
    journal.checkpoint('chat-1', 'idle', after)
    settle('checkpointed')
    await expect(result).resolves.toBe('checkpointed')
    expect(persistence.pendingMutationBytes('chat-1')).toBe(0)
    expect(persistence.stats().idleCheckpoints).toBe(1)
  })

  it('does not clear a save arriving between adoption and the continuation', async () => {
    const { persistence, journal, after, settle } = fixture()
    const result = persistence.checkpointChatDeferred('chat-1')
    journal.checkpoint('chat-1', 'idle')
    settle('checkpointed')
    const latest = { ...after, title: 'third', updatedAt: 3, persistenceRevision: 3 }
    persistence.persist(after, latest, 'normal')
    const pending = persistence.pendingMutationBytes('chat-1')
    await result
    expect(persistence.pendingMutationBytes('chat-1')).toBe(pending)
    expect(pending).toBeGreaterThan(0)
    expect(journal.replay('chat-1').record).toEqual(latest)
  })

  it.each(['superseded', 'unavailable'] as const)(
    'keeps accounting on %s preparation',
    async (outcome) => {
      const { persistence, settle } = fixture()
      const bytes = persistence.pendingMutationBytes('chat-1')
      const result = persistence.checkpointChatDeferred('chat-1')
      settle(outcome)
      await expect(result).resolves.toBe(outcome)
      expect(persistence.pendingMutationBytes('chat-1')).toBe(bytes)
      expect(persistence.stats().idleCheckpoints).toBe(0)
    }
  )
})
