import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  THREAD_LOG_BATCH_FORMAT,
  THREAD_LOG_BATCH_VERSION
} from '../host-shared/thread-log/ThreadLogBatch'
import { THREAD_LOG_SEGMENT_MAX_LINE_BYTES } from '../host-shared/thread-log/ThreadLogSegmentReader'
import { readThreadLogHead, threadLogFiles } from './HostThreadLogHead'

const TEMPORARY_PREFIX = 'host-thread-log-head-'
const CHAT = 'thread-1'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  if (
    directory === temporary ||
    path.dirname(directory) !== temporary ||
    !path.basename(directory).startsWith(TEMPORARY_PREFIX) ||
    path.basename(directory).length <= TEMPORARY_PREFIX.length
  ) {
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  }
  rmSync(directory, { recursive: true, force: true })
}

let directory = ''

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
})

afterEach(() => {
  removeTemporaryDirectory(directory)
})

function line(revision: number, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    format: THREAD_LOG_BATCH_FORMAT,
    version: THREAD_LOG_BATCH_VERSION,
    chatId: CHAT,
    baseRevision: revision - 1,
    revision,
    savedAt: `2026-10-05T10:00:0${revision % 10}.000Z`,
    operations: [],
    ...extra
  })}\n`
}

function checkpoint(revision: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 'taskwraith-chat-checkpoint',
    version: 1,
    chatId: CHAT,
    revision,
    savedAt: '2026-10-05T09:59:00.000Z',
    reason: 'compaction',
    ...extra,
    record: { appChatId: CHAT, messages: [], runs: [] }
  })
}

const files = () => threadLogFiles(directory, CHAT)

describe('the head of a thread log', () => {
  it('is none when the thread has no log', async () => {
    expect(await readThreadLogHead(directory, CHAT)).toEqual({ kind: 'none' })
    writeFileSync(files().active, '')
    expect(await readThreadLogHead(directory, CHAT)).toEqual({ kind: 'none' })
  })

  it('is the active segment’s last whole line; a line cut short does not count', async () => {
    writeFileSync(files().sealed, line(3))
    writeFileSync(files().active, `${line(4)}${line(5)}{"format":"taskwraith-chat-mut`)
    expect(await readThreadLogHead(directory, CHAT)).toEqual({
      kind: 'head',
      revision: 5,
      savedAt: '2026-10-05T10:00:05.000Z'
    })
  })

  it('is the sealed segment’s last line while the active one has no whole line', async () => {
    writeFileSync(files().checkpoint, checkpoint(1))
    writeFileSync(files().sealed, `${line(2)}${line(3)}`)
    writeFileSync(files().active, '{"format":')
    expect(await readThreadLogHead(directory, CHAT)).toMatchObject({ kind: 'head', revision: 3 })
  })

  it('is the checkpoint’s revision when no segment has a line', async () => {
    writeFileSync(files().checkpoint, checkpoint(12))
    expect(await readThreadLogHead(directory, CHAT)).toEqual({
      kind: 'head',
      revision: 12,
      savedAt: '2026-10-05T09:59:00.000Z'
    })
  })

  it('reads a last line longer than one piece, whole', async () => {
    const big = line(7, {
      operations: [{ type: 'record_patch', set: { title: 'x'.repeat(200_000) }, clear: [] }]
    })
    writeFileSync(files().active, `${line(6)}${big}`)
    expect(await readThreadLogHead(directory, CHAT)).toMatchObject({ kind: 'head', revision: 7 })
    writeFileSync(files().active, big)
    expect(await readThreadLogHead(directory, CHAT)).toMatchObject({ kind: 'head', revision: 7 })
  })

  it('is unreadable, never smaller, when a file is there and cannot be read as this thread’s', async () => {
    const unreadable = { kind: 'unreadable', reason: expect.any(String) }
    writeFileSync(files().checkpoint, checkpoint(4))
    writeFileSync(files().active, `${line(5)}not a batch\n`)
    expect(await readThreadLogHead(directory, CHAT)).toEqual(unreadable)
    writeFileSync(files().active, line(5, { chatId: 'thread-2' }))
    expect(await readThreadLogHead(directory, CHAT)).toEqual(unreadable)
    writeFileSync(files().active, line(5, { revision: -1 }))
    expect(await readThreadLogHead(directory, CHAT)).toEqual(unreadable)
    writeFileSync(files().active, line(5, { format: 'other' }))
    expect(await readThreadLogHead(directory, CHAT)).toEqual(unreadable)
    rmSync(files().active)
    mkdirSync(files().active)
    expect(await readThreadLogHead(directory, CHAT)).toEqual(unreadable)
    rmSync(files().active, { recursive: true })
    writeFileSync(files().checkpoint, checkpoint(4, { chatId: 'thread-2' }))
    expect(await readThreadLogHead(directory, CHAT)).toEqual(unreadable)
    writeFileSync(files().checkpoint, checkpoint(4, { format: 'other' }))
    expect(await readThreadLogHead(directory, CHAT)).toEqual(unreadable)
    writeFileSync(files().checkpoint, '{"format":"taskwraith-chat-checkpoint"')
    expect(await readThreadLogHead(directory, CHAT)).toEqual(unreadable)
  })

  it('is unreadable past the longest line a segment may hold', async () => {
    // A whole last line longer than any batch.
    writeFileSync(
      files().active,
      `${line(1)}${'y'.repeat(THREAD_LOG_SEGMENT_MAX_LINE_BYTES + 1)}\n`
    )
    expect(await readThreadLogHead(directory, CHAT)).toMatchObject({
      kind: 'unreadable',
      reason: expect.stringContaining('too long')
    })
    // A cut-short write is at most one line; one longer than two is not a log.
    writeFileSync(
      files().active,
      `${line(1)}${'x'.repeat(2 * THREAD_LOG_SEGMENT_MAX_LINE_BYTES + 128 * 1024)}`
    )
    expect(await readThreadLogHead(directory, CHAT)).toMatchObject({
      kind: 'unreadable',
      reason: expect.stringContaining('too long')
    })
    // Within the bound, the line before a cut-short write is the head.
    writeFileSync(files().active, `${line(1)}${'x'.repeat(THREAD_LOG_SEGMENT_MAX_LINE_BYTES)}`)
    expect(await readThreadLogHead(directory, CHAT)).toMatchObject({ kind: 'head', revision: 1 })
  })

  it('is unreadable when a log’s name is a link', async () => {
    writeFileSync(path.join(directory, 'elsewhere.jsonl'), line(4))
    symlinkSync(path.join(directory, 'elsewhere.jsonl'), files().active)
    expect(await readThreadLogHead(directory, CHAT)).toMatchObject({ kind: 'unreadable' })
  })

  it.skipIf(process.platform === 'win32')('is unreadable without waiting on a FIFO', async () => {
    const made = spawnSync('mkfifo', [files().active], { encoding: 'utf8' })
    expect(made.status, made.stderr).toBe(0)
    expect(await readThreadLogHead(directory, CHAT)).toMatchObject({
      kind: 'unreadable',
      reason: expect.stringContaining('not a file')
    })
  })

  it('names only files of a thread id', () => {
    expect(() => threadLogFiles(directory, '../escape')).toThrow('Invalid thread id')
  })
})
