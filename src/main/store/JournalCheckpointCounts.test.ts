/**
 * The journal's checkpoints counted by trigger, through a real journal over a
 * temporary directory.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { deriveChatRecordMutation } from './ChatRecordMutation'
import {
  createIncrementalChatJournal,
  type IncrementalChatJournal,
  type IncrementalChatJournalOptions,
  type IncrementalChatJournalStats
} from './IncrementalChatJournal'
import { countJournalCheckpoints, JOURNAL_CHECKPOINT_TRIGGERS } from './JournalCheckpointCounts'
import type { ChatRecord } from './types'

const CHAT = 'chat-1'
const PREFIX = 'owner-checkpoint-counts-'
const directories: string[] = []

/**
 * Removes a folder this file made with mkdtemp under the temporary folder,
 * and refuses anything else.
 */
function removeTemporary(directory: string): void {
  const own = os.tmpdir() + path.sep + PREFIX
  if (
    directory === os.tmpdir() ||
    !directory.startsWith(own) ||
    directory.includes(path.sep, own.length)
  ) {
    throw new Error(`Refusing to remove ${directory}`)
  }
  fs.rmSync(directory, { recursive: true, force: true })
}

/** A directory of this test's own, removed after each test. */
function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  directories.push(directory)
  return directory
}

afterEach(() => {
  while (directories.length > 0) removeTemporary(directories.pop()!)
})

function record(revision: number): ChatRecord {
  return {
    appChatId: CHAT,
    scope: 'global',
    chatKind: 'single',
    provider: 'codex',
    title: 'Counted',
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision,
    messages: Array.from({ length: revision }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      content: `Row ${index}`,
      timestamp: '2026-10-05T00:00:00.000Z'
    })),
    runs: []
  }
}

/** A real journal, its clock, and the journal counted with a clock that moves 5 ms a reading. */
function counted(options: IncrementalChatJournalOptions = {}) {
  const directory = temporaryDirectory()
  let clock = 1_000
  const journal = createIncrementalChatJournal(directory, { now: () => clock, ...options })
  let reading = 0
  const counts = countJournalCheckpoints(journal, () => (reading += 5))
  const checkpointBytes = (): number =>
    fs.statSync(path.join(directory, `${CHAT}.checkpoint.json`)).size
  return {
    journal: counts.journal,
    snapshot: counts.snapshot,
    checkpointBytes,
    advance: (ms: number) => (clock += ms),
    append: (from: number, to: number) =>
      counts.journal.append(deriveChatRecordMutation(record(from), record(to)))
  }
}

function only(
  trigger: (typeof JOURNAL_CHECKPOINT_TRIGGERS)[number],
  entry: { count: number; bytes: number; mainMs: number }
) {
  return Object.fromEntries(
    JOURNAL_CHECKPOINT_TRIGGERS.map((each) => [
      each,
      each === trigger ? entry : { count: 0, bytes: 0, mainMs: 0 }
    ])
  )
}

describe("the journal's checkpoints, counted by trigger", () => {
  it('counts the first checkpoint of a thread, with its bytes and the time spent writing it', () => {
    const journal = counted()

    journal.journal.initialize(CHAT, record(1))

    expect(journal.snapshot()).toEqual(
      only('initial', { count: 1, bytes: journal.checkpointBytes(), mainMs: 5 })
    )
  })

  it('counts a checkpoint by the reason its caller gives', () => {
    const journal = counted()
    journal.journal.initialize(CHAT, record(1))
    journal.append(1, 2)

    journal.journal.checkpoint(CHAT, 'terminal', record(2))

    expect(journal.snapshot().terminal).toEqual({
      count: 1,
      bytes: journal.checkpointBytes(),
      mainMs: 5
    })
  })

  it('counts the compaction an append forces past the bounds as bounded', () => {
    const journal = counted({ maxJournalEntries: 2 })
    journal.journal.initialize(CHAT, record(1))
    journal.append(1, 2)
    expect(journal.snapshot().bounded.count).toBe(0)

    journal.append(2, 3)

    expect(journal.snapshot().bounded).toEqual({
      count: 1,
      bytes: journal.checkpointBytes(),
      mainMs: 5
    })
  })

  it('counts the re-anchor as recovery', () => {
    const journal = counted()
    journal.journal.initialize(CHAT, record(1))

    journal.journal.replaceAuthoritativeCheckpoint(CHAT, record(4))

    expect(journal.snapshot().recovery).toEqual({
      count: 1,
      bytes: journal.checkpointBytes(),
      mainMs: 5
    })
  })

  it('counts the idle compaction, and the ones taken at shutdown', () => {
    const journal = counted({ idleCheckpointMs: 1_000 })
    journal.journal.initialize(CHAT, record(1))
    journal.append(1, 2)
    journal.advance(2_000)

    journal.journal.checkpointIdle()
    journal.append(2, 3)
    journal.journal.checkpointAll()

    const counts = journal.snapshot()
    expect([counts.idle.count, counts.shutdown.count]).toEqual([1, 1])
  })

  it('counts nothing for calls that write no checkpoint', () => {
    const journal = counted()
    journal.journal.initialize(CHAT, record(1))
    const afterFirst = journal.snapshot()

    journal.append(1, 2)
    journal.journal.replay(CHAT)
    journal.journal.checkpointIdle()

    expect(journal.snapshot()).toEqual(afterFirst)
  })
})

/** A journal that only counts, for what the real one cannot be made to do on demand. */
function fakeJournal() {
  const stats = { checkpointsWritten: 0, checkpointBytesWritten: 0 }
  const write = (bytes: number) => {
    stats.checkpointsWritten += 1
    stats.checkpointBytesWritten += bytes
  }
  const journal = {
    stats: () => ({ ...stats }) as unknown as IncrementalChatJournalStats,
    checkpoint: () => {
      write(10)
      return true
    },
    checkpointAll: () => 0,
    replay: () => null
  } as unknown as IncrementalChatJournal
  return { journal, write }
}

describe('what the count leaves alone', () => {
  it('leaves checkpoints written outside a counted call to other, untimed', () => {
    const fake = fakeJournal()
    const counts = countJournalCheckpoints(fake.journal, () => 0)

    fake.write(300)

    expect(counts.snapshot().other).toEqual({ count: 1, bytes: 300, mainMs: 0 })
  })

  it('leaves a checkpoint given a reason it does not know to other, untimed', () => {
    const fake = fakeJournal()
    const counts = countJournalCheckpoints(fake.journal, () => 0)

    counts.journal.checkpoint(CHAT, 'unheard-of' as never)

    expect(counts.snapshot()).toEqual(only('other', { count: 1, bytes: 10, mainMs: 0 }))
  })

  it('counts a checkpoint written by a counted call inside another one once, for the outer', () => {
    const fake = fakeJournal()
    let reading = 0
    const counts = countJournalCheckpoints(fake.journal, () => (reading += 5))
    ;(fake.journal as { checkpointAll: () => number }).checkpointAll = () => {
      counts.journal.checkpoint(CHAT, 'manual')
      return 1
    }

    counts.journal.checkpointAll('shutdown')

    expect(counts.snapshot()).toEqual(only('shutdown', { count: 1, bytes: 10, mainMs: 5 }))
  })

  it('keeps every member of the journal, optional ones present only where they were', () => {
    const original = createIncrementalChatJournal(temporaryDirectory())
    const wrapped = countJournalCheckpoints(original).journal

    expect(Object.keys(wrapped).sort()).toEqual(Object.keys(original).sort())
    expect(wrapped.replay).toBe(original.replay)
    expect(wrapped.checkpoint).not.toBe(original.checkpoint)
    expect(wrapped.checkpoint).toBe(wrapped.checkpoint)
  })
})
