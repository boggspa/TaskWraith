import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { threadLogFiles } from '../thread-log/ThreadLogFiles'
import { readThreadFoldLog } from './ThreadFoldLogSource'

const CHAT = 'chat-fold-1'
const TEMPORARY_PREFIX = 'thread-fold-log-source-'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (!path.basename(directory).startsWith(TEMPORARY_PREFIX)) throw new Error('refusing')
    rmSync(directory, { recursive: true, force: true })
  }
})

function journal(): string {
  const directory = mkdtempSync(path.join(tmpdir(), TEMPORARY_PREFIX))
  directories.push(directory)
  return directory
}

function batch(revision: number, title = `t${revision}`, chatId = CHAT) {
  return {
    format: 'taskwraith-chat-mutation',
    version: 1,
    chatId,
    baseRevision: revision - 1,
    revision,
    savedAt: new Date(Date.UTC(2026, 9, 6, 0, 0, revision)).toISOString(),
    operations: [{ type: 'record_patch', set: { title }, clear: [] }]
  }
}

function lines(batches: unknown[]): string {
  return batches.map((item) => `${JSON.stringify(item)}\n`).join('')
}

describe('readThreadFoldLog', () => {
  it('reports none when the log holds nothing above the full copy', () => {
    const directory = journal()
    expect(readThreadFoldLog({ directory, chatId: CHAT, fullCopyRevision: 0 })).toEqual({
      kind: 'none'
    })
    writeFileSync(threadLogFiles(directory, CHAT).active, lines([batch(1), batch(2)]))
    expect(readThreadFoldLog({ directory, chatId: CHAT, fullCopyRevision: 2 })).toEqual({
      kind: 'none'
    })
  })

  it('hands over sealed then active batches above the full copy, with the log head and timestamp', () => {
    const directory = journal()
    const files = threadLogFiles(directory, CHAT)
    writeFileSync(files.sealed, lines([batch(1), batch(2), batch(3)]))
    writeFileSync(files.active, lines([batch(4), batch(5)]))
    const read = readThreadFoldLog({ directory, chatId: CHAT, fullCopyRevision: 2 })
    expect(read).toMatchObject({ kind: 'log', headRevision: 5, complete: true })
    if (read.kind !== 'log') throw new Error('expected a log')
    expect(read.batches.map((item) => item.revision)).toEqual([3, 4, 5])
    expect(read.updatedAt).toBe(batch(5).savedAt)
  })

  it('splits a log longer than one request into its oldest whole prefix', () => {
    const directory = journal()
    writeFileSync(
      threadLogFiles(directory, CHAT).active,
      lines([batch(1), batch(2), batch(3), batch(4)])
    )
    const first = readThreadFoldLog({ directory, chatId: CHAT, fullCopyRevision: 0, maxBatches: 3 })
    expect(first).toMatchObject({ kind: 'log', headRevision: 3, complete: false })
    // The caller adopts that prefix, which moves the full copy; the next read continues.
    const second = readThreadFoldLog({
      directory,
      chatId: CHAT,
      fullCopyRevision: 3,
      maxBatches: 3
    })
    expect(second).toMatchObject({ kind: 'log', headRevision: 4, complete: true })
  })

  it('splits by bytes too, and refuses only a single batch over the budget', () => {
    const directory = journal()
    writeFileSync(threadLogFiles(directory, CHAT).active, lines([batch(1), batch(2)]))
    const one = Buffer.byteLength(JSON.stringify(batch(1)), 'utf8')
    expect(
      readThreadFoldLog({ directory, chatId: CHAT, fullCopyRevision: 0, maxFoldBytes: one + 1 })
    ).toMatchObject({ kind: 'log', headRevision: 1, complete: false })
    expect(
      readThreadFoldLog({ directory, chatId: CHAT, fullCopyRevision: 0, maxFoldBytes: one - 1 })
    ).toMatchObject({ kind: 'oversize', limit: one - 1 })
  })

  it('refuses a gapped log rather than folding past a missing batch', () => {
    const directory = journal()
    writeFileSync(threadLogFiles(directory, CHAT).active, lines([batch(1), batch(3)]))
    expect(readThreadFoldLog({ directory, chatId: CHAT, fullCopyRevision: 0 })).toEqual({
      kind: 'gap'
    })
  })

  it('refuses a corrupt or foreign line, never handing over a partial list', () => {
    const directory = journal()
    writeFileSync(threadLogFiles(directory, CHAT).active, `${JSON.stringify(batch(1))}\nnot json\n`)
    expect(readThreadFoldLog({ directory, chatId: CHAT, fullCopyRevision: 0 })).toEqual({
      kind: 'corrupt'
    })
    const other = journal()
    writeFileSync(threadLogFiles(other, CHAT).active, lines([batch(1, 't', 'chat-other')]))
    expect(readThreadFoldLog({ directory: other, chatId: CHAT, fullCopyRevision: 0 })).toEqual({
      kind: 'corrupt'
    })
  })
})
