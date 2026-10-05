import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createIncrementalChatJournal,
  type IncrementalChatJournalOptions
} from './IncrementalChatJournal'
import { createIncrementalChatPersistence } from './IncrementalChatPersistence'
import { deriveChatRecordMutation } from './ChatRecordMutation'
import type { ChatRecord } from './types'

const PREFIX = 'log-persistence-cap-head-'

function chat(revision: number, id = 'chat-1'): ChatRecord {
  return {
    appChatId: id,
    title: id,
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision,
    messages: [
      { id: 'message', role: 'assistant', content: `reply ${revision}`, timestamp: '2026-10-05' }
    ],
    runs: []
  }
}

describe('the exact head during an append-triggered cap checkpoint', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    const temporary = os.tmpdir()
    expect(root).not.toBe(temporary)
    expect(root.startsWith(temporary + path.sep + PREFIX)).toBe(true)
    expect(path.dirname(root)).toBe(temporary)
    fs.rmSync(root, { recursive: true, force: true })
  })

  const open = (options: IncrementalChatJournalOptions = {}) => {
    const journal = createIncrementalChatJournal(root, {
      noteDurabilityDebt: () => {},
      checkpointPreparation: { start: () => null },
      maxJournalBytes: 1,
      compactionHardCapBytes: 1,
      ...options
    })
    const persistence = createIncrementalChatPersistence({
      journal,
      logger: { error: () => {}, warn: () => {} }
    })
    return { journal, persistence }
  }

  it('uses the current record without replay when append crosses the cap, and recovers identical bytes', () => {
    const { journal, persistence } = open()
    persistence.persist(null, chat(1), 'normal')
    persistence.persist(chat(1), chat(2), 'normal')
    const before = journal.stats()

    persistence.persist(chat(2), chat(3), 'normal')

    expect(journal.stats().compactionCapFallbacks).toBe(1)
    expect(journal.stats().checkpointsFromMemory - before.checkpointsFromMemory).toBe(1)
    expect(journal.stats().replayedBatches - before.replayedBatches).toBe(0)
    const recovered = createIncrementalChatJournal(root, { canWrite: () => false }).replay('chat-1')
    expect(recovered).toMatchObject({ record: chat(3), revision: 3, appliedBatches: 0 })
  })

  it('keeps a manual checkpoint using the settled remembered head', () => {
    const { journal, persistence } = open({ maxJournalBytes: 1_000_000 })
    persistence.persist(null, chat(1), 'normal')
    persistence.persist(chat(1), chat(2), 'normal')

    expect(journal.checkpoint('chat-1', 'manual')).toBe(true)
    expect(journal.stats()).toMatchObject({ checkpointsFromMemory: 1, replayedBatches: 0 })
    expect(journal.replay('chat-1').record).toEqual(chat(2))
  })

  it.each(['before', 'after'] as const)(
    'does not leave a failed append candidate reusable when append throws %s its bytes are written',
    (when) => {
      const { journal, persistence } = open({ maxJournalBytes: 1_000_000 })
      persistence.persist(null, chat(1), 'normal')
      const next = chat(2)
      const append = journal.append.bind(journal)
      const intercepted = vi.spyOn(journal, 'append').mockImplementationOnce((batch, options) => {
        if (when === 'after') append(batch, options)
        throw new Error('injected append failure')
      })

      expect(() => persistence.persist(chat(1), next, 'normal')).toThrow('injected append failure')
      intercepted.mockRestore()
      const onDisk = when === 'before' ? { ...chat(2), title: 'actual append' } : chat(2)
      if (when === 'before') append(deriveChatRecordMutation(chat(1), onDisk))
      next.title = 'must not be checkpointed'

      expect(journal.checkpoint('chat-1', 'manual')).toBe(true)
      expect(journal.stats().checkpointsFromMemory).toBe(0)
      expect(journal.replay('chat-1').record).toEqual(onDisk)
    }
  )

  it.each(['revision', 'fingerprint'] as const)(
    'rejects an append candidate changed by a nested guard (%s)',
    (changed) => {
      let mutate: (() => void) | undefined
      const { journal, persistence } = open({ beforeSourceMutation: () => mutate?.() })
      persistence.persist(null, chat(1), 'normal')
      persistence.persist(chat(1), chat(2), 'normal')
      const next = chat(3)
      mutate = () => {
        mutate = undefined
        if (changed === 'revision') next.persistenceRevision = 99
        else next.messages = [...next.messages, { ...next.messages[0], id: 'unjournaled' }]
      }

      persistence.persist(chat(2), next, 'normal')

      expect(journal.stats()).toMatchObject({ compactionCapFallbacks: 1, checkpointsFromMemory: 0 })
      expect(journal.replay('chat-1').record).toEqual(chat(3))
    }
  )

  it('restores the outer candidate after a nested append on another chat', () => {
    let nested: (() => void) | undefined
    const { journal, persistence } = open({ beforeSourceMutation: () => nested?.() })
    for (const id of ['chat-1', 'chat-2']) {
      persistence.persist(null, chat(1, id), 'normal')
      persistence.persist(chat(1, id), chat(2, id), 'normal')
    }
    nested = () => {
      nested = undefined
      persistence.persist(chat(2, 'chat-2'), chat(3, 'chat-2'), 'normal')
    }

    persistence.persist(chat(2), chat(3), 'normal')

    expect(journal.stats()).toMatchObject({ compactionCapFallbacks: 2, checkpointsFromMemory: 2 })
    expect(journal.stats().replayedBatches).toBe(0)
    for (const id of ['chat-1', 'chat-2']) expect(journal.replay(id).record).toEqual(chat(3, id))
  })

  it('leaves the switch-off append checkpoint on its existing path', () => {
    const { journal, persistence } = open({ noteDurabilityDebt: undefined })
    persistence.persist(null, chat(1), 'normal')

    persistence.persist(chat(1), chat(2), 'normal')

    expect(journal.stats()).toMatchObject({
      compactionCapFallbacks: 0,
      checkpointsFromMemory: 0,
      replayedBatches: 1
    })
    expect(journal.replay('chat-1').record).toEqual(chat(2))
  })
})
