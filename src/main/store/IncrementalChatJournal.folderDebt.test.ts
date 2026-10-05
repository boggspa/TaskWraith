/**
 * A journal that leaves syncing to the thread's barrier, making its own
 * folder: the folder's name is in its parent, so the parent is owed too, by
 * the first chat the journal notes a debt for once the folder is made.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createIncrementalChatJournal } from './IncrementalChatJournal'
import type { ThreadDurabilityDebtNote } from './ThreadDurabilityDebt'
import type { ChatRecord } from './types'

const PREFIX = 'owner-journal-folder-'
const made: string[] = []

/** Removes a folder made below with PREFIX, and refuses anything else. */
function removeTemporary(directory: string): void {
  const own = tmpdir() + sep + PREFIX
  if (directory === tmpdir() || !directory.startsWith(own) || dirname(directory) !== tmpdir())
    throw new Error(`Refusing to remove ${directory}`)
  rmSync(directory, { recursive: true, force: true })
}

afterEach(() => {
  while (made.length > 0) removeTemporary(made.pop()!)
})

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), PREFIX))
  made.push(directory)
  return directory
}

function record(chatId: string): ChatRecord {
  return {
    appChatId: chatId,
    title: chatId,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    persistenceRevision: 1,
    messages: [{ id: 'm1', role: 'user', content: 'Hello', timestamp: '2026-10-05T00:00:00.000Z' }],
    runs: []
  }
}

/** A journal in `baseDir` under the debt option, and every directory it noted, by chat. */
function journalIn(baseDir: string, canWrite: () => boolean = () => true) {
  const directories: Array<[string, string]> = []
  const journal = createIncrementalChatJournal(baseDir, {
    canWrite,
    noteDurabilityDebt: (chatId: string, note: ThreadDurabilityDebtNote) => {
      if ('directory' in note) directories.push([chatId, note.directory])
    }
  })
  return { journal, directories }
}

describe('the name of a folder the journal makes, under the debt option', () => {
  it('is owed in its parent once, by the first chat noted after the journal made it', () => {
    const root = temporary()
    const baseDir = join(root, 'chat-journal-v2')
    const { journal, directories } = journalIn(baseDir)

    journal.initialize('chat-1', record('chat-1'))
    journal.initialize('chat-2', record('chat-2'))

    expect(directories).toEqual([
      ['chat-1', root],
      ['chat-1', baseDir],
      ['chat-2', baseDir]
    ])
  })

  it('is owed when the journal makes the folder at a later write, not when it is built', () => {
    const root = temporary()
    const baseDir = join(root, 'chat-journal-v2')
    let writable = false
    const { journal, directories } = journalIn(baseDir, () => writable)

    writable = true
    journal.initialize('chat-1', record('chat-1'))

    expect(directories).toEqual([
      ['chat-1', root],
      ['chat-1', baseDir]
    ])
  })

  it('is owed in each folder above that the journal had to make too, down from the first missing one', () => {
    const root = temporary()
    const profile = join(root, 'profile')
    const baseDir = join(profile, 'chat-journal-v2')
    const { journal, directories } = journalIn(baseDir)

    journal.initialize('chat-1', record('chat-1'))

    expect(directories).toEqual([
      ['chat-1', profile],
      ['chat-1', root],
      ['chat-1', baseDir]
    ])
  })

  it('is not owed for a folder that was already there', () => {
    const root = temporary()
    const baseDir = join(root, 'chat-journal-v2')
    mkdirSync(baseDir)
    const { journal, directories } = journalIn(baseDir)

    journal.initialize('chat-1', record('chat-1'))

    expect(directories).toEqual([['chat-1', baseDir]])
  })
})
