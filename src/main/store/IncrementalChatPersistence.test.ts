import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import {
  createIncrementalChatPersistence,
  type IncrementalChatPersistence
} from './IncrementalChatPersistence'
import type { ChatRecord } from './types'

function chat(revision = 1, content = 'initial'): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Chat',
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision,
    messages: [
      {
        id: 'message-1',
        role: 'assistant',
        content,
        timestamp: '2026-08-16T00:00:00.000Z'
      }
    ],
    runs: []
  }
}

function advance(source: ChatRecord, content: string): ChatRecord {
  const next = structuredClone(source)
  next.messages[0].content = content
  next.updatedAt += 1
  next.persistenceRevision = (source.persistenceRevision ?? 0) + 1
  return next
}

describe('IncrementalChatPersistence', () => {
  let baseDir: string
  let persistence: IncrementalChatPersistence
  const logger = { error: vi.fn(), warn: vi.fn() }

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-chat-persistence-'))
    logger.error.mockClear()
    logger.warn.mockClear()
    persistence = createIncrementalChatPersistence({
      journal: createIncrementalChatJournal(baseDir),
      logger
    })
  })

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  it('seeds once and then appends replayable mutation batches', () => {
    const first = chat()
    const second = advance(first, 'streamed second state')

    expect(persistence.persist(null, first, 'normal')).toMatchObject({ seeded: true })
    expect(persistence.persist(first, second, 'normal')).toMatchObject({
      seeded: false,
      checkpointed: false,
      parityVerified: null
    })

    expect(persistence.replay('chat-1').record).toEqual(second)
    expect(persistence.stats()).toMatchObject({
      seeds: 1,
      mutationBatchesAppended: 1,
      failures: 0
    })
  })

  it('materializes and verifies terminal state', () => {
    const first = chat()
    const terminal = advance(first, 'terminal answer')
    terminal.runs = [
      {
        runId: 'run-1',
        startedAt: '2026-08-16T00:00:00.000Z',
        endedAt: '2026-08-16T00:00:01.000Z',
        status: 'success'
      }
    ]
    persistence.persist(null, first, 'normal')

    expect(persistence.persist(first, terminal, 'terminal')).toMatchObject({
      checkpointed: true,
      parityVerified: true
    })
    expect(fs.existsSync(path.join(baseDir, 'chat-1.mutations.jsonl'))).toBe(false)
    expect(persistence.stats()).toMatchObject({
      terminalCheckpoints: 1,
      parityChecks: 1,
      parityMatches: 1,
      parityMismatches: 0
    })
  })

  it('repairs a same-revision side-band drift before deriving the next batch', () => {
    const sideBand = chat(1, 'wrong side-band baseline')
    const authoritative = chat(1, 'legacy authoritative baseline')
    const next = advance(authoritative, 'next exact state')
    const journal = createIncrementalChatJournal(baseDir)
    journal.initialize('chat-1', sideBand)
    persistence = createIncrementalChatPersistence({ journal, logger })

    persistence.persist(authoritative, next, 'normal')

    expect(persistence.replay('chat-1').record).toEqual(next)
    expect(persistence.stats()).toMatchObject({
      baselineChecks: 1,
      baselineRepairs: 1,
      parityMismatches: 1
    })
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('retains the approval fsync boundary and verifies without checkpointing', () => {
    const first = chat()
    const approval = advance(first, 'approval opened')
    persistence.persist(null, first, 'normal')

    expect(persistence.persist(first, approval, 'approval')).toMatchObject({
      checkpointed: false,
      parityVerified: true
    })
    expect(fs.existsSync(path.join(baseDir, 'chat-1.mutations.jsonl'))).toBe(true)
    expect(persistence.replay('chat-1').record).toEqual(approval)
  })

  it('re-establishes the authoritative baseline after one failed append', () => {
    const first = chat()
    const second = advance(first, 'second')
    const third = advance(second, 'third')
    const journal = createIncrementalChatJournal(baseDir)
    const append = vi.spyOn(journal, 'append')
    append.mockImplementationOnce(() => {
      throw new Error('simulated fsync failure')
    })
    persistence = createIncrementalChatPersistence({ journal, logger })
    persistence.persist(null, first, 'normal')

    expect(() => persistence.persist(first, second, 'normal')).toThrow(/simulated fsync failure/)
    expect(persistence.persist(second, third, 'terminal')).toMatchObject({
      parityVerified: true
    })
    expect(persistence.replay('chat-1').record).toEqual(third)
    expect(persistence.stats().baselineRepairs).toBe(1)
  })

  it('purges per-chat state and clears all journal artifacts', () => {
    const first = chat()
    persistence.persist(null, first, 'normal')
    persistence.purge('chat-1')
    expect(fs.readdirSync(baseDir)).toEqual([])

    persistence.persist(null, first, 'normal')
    persistence.clear()
    expect(fs.existsSync(baseDir)).toBe(false)
  })
})
