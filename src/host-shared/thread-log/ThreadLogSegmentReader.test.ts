/**
 * The reader follows one segment of a thread's log while another process
 * appends to it. Most cases run against a file held in memory, so a writer's
 * change can be placed at an exact point of a read; the cases that depend on
 * what the operating system does with names and descriptors use real files.
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  THREAD_LOG_BATCH_FORMAT,
  THREAD_LOG_BATCH_VERSION,
  type ThreadLogBatch
} from './ThreadLogBatch'
import {
  THREAD_LOG_SEGMENT_MAX_LINE_BYTES,
  THREAD_LOG_SEGMENT_MAX_READ_BYTES,
  openThreadLogSegmentReader,
  type ThreadLogSegmentFileStat,
  type ThreadLogSegmentRead,
  type ThreadLogSegmentReader,
  type ThreadLogSegmentReaderFs,
  type ThreadLogSegmentReaderOptions
} from './ThreadLogSegmentReader'

const CHAT = 'chat-1'
const SEGMENT = '/log/chat-1.mutations.jsonl'

function batch(baseRevision: number, revision: number, content = `to ${revision}`): ThreadLogBatch {
  return {
    format: THREAD_LOG_BATCH_FORMAT,
    version: THREAD_LOG_BATCH_VERSION,
    chatId: CHAT,
    baseRevision,
    revision,
    savedAt: '2026-10-04T00:00:00.000Z',
    operations: [{ type: 'message_content_append', messageId: 'message', content }]
  }
}

const lineOf = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`)

/** A batch whose line, without its newline, is exactly `bytes` long. */
function batchOfLineBytes(baseRevision: number, revision: number, bytes: number): ThreadLogBatch {
  const padding = bytes - (lineOf(batch(baseRevision, revision, '')).length - 1)
  if (padding < 0) throw new Error(`a batch line cannot be as short as ${bytes} bytes`)
  return batch(baseRevision, revision, 'x'.repeat(padding))
}

interface MemoryFile {
  ino: bigint
  bytes: Buffer
  links: number
  mtimeNs: bigint
  regular: boolean
}

function missing(target: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file, ${target}`), { code: 'ENOENT' })
}

/**
 * Files in memory. The reader sees them through the five calls it is allowed;
 * the test plays the writer through the other methods, and `beforeRead` lets
 * it do so in the middle of a read.
 */
class MemoryDisk implements ThreadLogSegmentReaderFs {
  readonly constants = { O_RDONLY: 0, O_NOFOLLOW: 0x100, O_NONBLOCK: 0x4 }
  /** Every call the reader made, in order. */
  calls: string[] = []
  largestRead = 0
  bytesRead = 0
  /** Runs before the reader's nth read of file bytes, counted from 0. */
  beforeRead: ((index: number) => void) | null = null
  /** A disk whose clock is too coarse to give a change a new time. */
  clockStopped = false
  /** The most one read hands over, as a read is allowed to return less than was asked. */
  mostPerRead = Number.MAX_SAFE_INTEGER
  private reads = 0
  private clock = 1n
  private nextIno = 1n
  private nextFd = 10
  private readonly names = new Map<string, MemoryFile>()
  private readonly descriptors = new Map<number, MemoryFile>()

  private touch(file: MemoryFile): void {
    if (!this.clockStopped) this.clock += 1n
    file.mtimeNs = this.clock
  }

  private named(target: string): MemoryFile {
    const file = this.names.get(target)
    if (!file) throw missing(target)
    return file
  }

  private stat(file: MemoryFile): ThreadLogSegmentFileStat {
    return {
      dev: 1n,
      ino: file.ino,
      nlink: BigInt(file.links),
      size: BigInt(file.bytes.length),
      mtimeNs: file.mtimeNs,
      isFile: () => file.regular
    }
  }

  create(target: string, bytes: Buffer = Buffer.alloc(0), regular = true): void {
    const replaced = this.names.get(target)
    if (replaced) replaced.links -= 1
    const file = { ino: this.nextIno, bytes: Buffer.from(bytes), links: 1, mtimeNs: 0n, regular }
    this.nextIno += 1n
    this.touch(file)
    this.names.set(target, file)
  }

  append(target: string, bytes: Buffer): void {
    if (!this.names.has(target)) this.create(target)
    const file = this.named(target)
    file.bytes = Buffer.concat([file.bytes, bytes])
    this.touch(file)
  }

  truncate(target: string, size: number): void {
    const file = this.named(target)
    file.bytes = Buffer.from(file.bytes.subarray(0, size))
    this.touch(file)
  }

  /** Same file, new contents: what no writer of the log does. */
  overwrite(target: string, bytes: Buffer): void {
    const file = this.named(target)
    file.bytes = Buffer.from(bytes)
    this.touch(file)
  }

  rename(from: string, to: string): void {
    const file = this.named(from)
    const replaced = this.names.get(to)
    if (replaced) replaced.links -= 1
    this.names.delete(from)
    this.names.set(to, file)
  }

  unlink(target: string): void {
    this.named(target).links -= 1
    this.names.delete(target)
  }

  contents(target: string): Buffer {
    return Buffer.from(this.named(target).bytes)
  }

  openDescriptors(): number {
    return this.descriptors.size
  }

  openSync(target: string, flags: number): number {
    this.calls.push(`open:${flags}`)
    const file = this.named(target)
    const fd = this.nextFd
    this.nextFd += 1
    this.descriptors.set(fd, file)
    return fd
  }

  fstatSync(fd: number): ThreadLogSegmentFileStat {
    this.calls.push('fstat')
    return this.stat(this.descriptors.get(fd)!)
  }

  lstatSync(target: string): ThreadLogSegmentFileStat {
    this.calls.push('lstat')
    return this.stat(this.named(target))
  }

  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number {
    this.calls.push('read')
    const index = this.reads
    this.reads += 1
    this.beforeRead?.(index)
    this.largestRead = Math.max(this.largestRead, length)
    const file = this.descriptors.get(fd)!
    const count = Math.max(0, Math.min(length, this.mostPerRead, file.bytes.length - position))
    if (count > 0) file.bytes.copy(buffer, offset, position, position + count)
    this.bytesRead += count
    return count
  }

  closeSync(fd: number): void {
    this.calls.push('close')
    this.descriptors.delete(fd)
  }
}

describe('thread log segment reader', () => {
  let disk: MemoryDisk

  beforeEach(() => {
    disk = new MemoryDisk()
  })

  const open = (options: Partial<ThreadLogSegmentReaderOptions> = {}): ThreadLogSegmentReader => {
    const reader = openThreadLogSegmentReader({
      filePath: SEGMENT,
      chatId: CHAT,
      headRevision: 1,
      fs: disk,
      ...options
    })
    if (!reader) throw new Error('the segment does not exist')
    return reader
  }

  /** Reads until the reader says it reached the end or stopped for good. */
  const drain = (reader: ThreadLogSegmentReader): ThreadLogSegmentRead[] => {
    const reads: ThreadLogSegmentRead[] = []
    for (;;) {
      const read = reader.read()
      reads.push(read)
      if (read.status !== 'ok' || read.reachedEnd) return reads
      if (reads.length > 100_000) throw new Error('the reader never reached the end')
    }
  }

  const second = batch(1, 2)
  const third = batch(2, 3)
  const fourth = batch(3, 4)
  const fifth = batch(4, 5)

  describe('complete lines', () => {
    it('returns each complete line as a batch, in order, and none of them twice', () => {
      disk.append(SEGMENT, Buffer.concat([lineOf(second), lineOf(third)]))
      const reader = open()

      expect(reader.read()).toEqual({
        status: 'ok',
        reachedEnd: true,
        batches: [second, third],
        duplicates: 0,
        offset: lineOf(second).length + lineOf(third).length,
        headRevision: 3,
        pendingBytes: 0,
        file: 'at-path'
      })
      expect(reader.read()).toMatchObject({ status: 'ok', batches: [], headRevision: 3 })

      disk.append(SEGMENT, lineOf(fourth))
      expect(reader.read()).toMatchObject({
        status: 'ok',
        reachedEnd: true,
        batches: [fourth],
        offset: disk.contents(SEGMENT).length,
        headRevision: 4,
        pendingBytes: 0
      })
    })

    it('reads nothing from an empty segment and waits', () => {
      disk.create(SEGMENT)
      const reader = open()
      expect(reader.read()).toMatchObject({
        status: 'ok',
        reachedEnd: true,
        batches: [],
        offset: 0,
        headRevision: 1
      })
      disk.append(SEGMENT, lineOf(second))
      expect(reader.read()).toMatchObject({ batches: [second], headRevision: 2 })
    })

    it('passes over an empty line, as the journal does when it replays', () => {
      disk.append(
        SEGMENT,
        Buffer.concat([lineOf(second), Buffer.from('\n\n'), lineOf(third), Buffer.from('\n')])
      )
      expect(open().read()).toMatchObject({
        status: 'ok',
        batches: [second, third],
        duplicates: 0,
        offset: disk.contents(SEGMENT).length,
        pendingBytes: 0
      })
    })

    it('starts at a byte offset it is given and reads nothing before it', () => {
      disk.append(SEGMENT, Buffer.concat([lineOf(second), lineOf(third), lineOf(fourth)]))
      const reader = open({ offset: lineOf(second).length, headRevision: 2 })
      expect(reader.read()).toMatchObject({
        status: 'ok',
        batches: [third, fourth],
        duplicates: 0,
        offset: disk.contents(SEGMENT).length
      })
    })

    it('reads a line longer than one read of the file', () => {
      const long = batch(1, 2, `${'long line with café € \u{1f600} '.repeat(9000)}end`)
      expect(lineOf(long).length).toBeGreaterThan(3 * 64 * 1024)
      disk.append(SEGMENT, Buffer.concat([lineOf(long), lineOf(third)]))
      const reader = open()
      const reads = drain(reader)
      expect(reads.flatMap((read) => read.batches)).toEqual([long, third])
      expect(reads.at(-1)).toMatchObject({ status: 'ok', offset: disk.contents(SEGMENT).length })
    })
  })

  describe('a line that has not finished arriving', () => {
    it('never consumes a fragment, however often it is asked', () => {
      const fragment = lineOf(third).subarray(0, 40)
      disk.append(SEGMENT, Buffer.concat([lineOf(second), fragment]))
      const reader = open()

      expect(reader.read()).toEqual({
        status: 'ok',
        reachedEnd: true,
        batches: [second],
        duplicates: 0,
        offset: lineOf(second).length,
        headRevision: 2,
        pendingBytes: 40,
        file: 'at-path'
      })
      for (let again = 0; again < 3; again += 1) {
        expect(reader.read()).toMatchObject({
          status: 'ok',
          reachedEnd: true,
          batches: [],
          offset: lineOf(second).length,
          headRevision: 2,
          pendingBytes: 40
        })
      }

      disk.append(SEGMENT, lineOf(third).subarray(40, 70))
      expect(reader.read()).toMatchObject({ batches: [], headRevision: 2, pendingBytes: 70 })

      disk.append(SEGMENT, lineOf(third).subarray(70))
      expect(reader.read()).toMatchObject({
        status: 'ok',
        batches: [third],
        offset: disk.contents(SEGMENT).length,
        headRevision: 3,
        pendingBytes: 0
      })
    })

    it('does not read an unfinished line again until the file changes', () => {
      // As long as the whole third line, and still without a newline.
      const whole = lineOf(third).length
      const fragment = lineOf(batch(2, 3, 'lost in the crash '.repeat(20))).subarray(0, whole)
      disk.append(SEGMENT, Buffer.concat([lineOf(second), fragment]))
      const reader = open()
      expect(reader.read()).toMatchObject({ batches: [second], pendingBytes: whole })

      disk.calls = []
      expect(reader.read()).toMatchObject({
        status: 'ok',
        reachedEnd: true,
        batches: [],
        pendingBytes: whole
      })
      expect(disk.calls).not.toContain('read')

      // Changed to the same size: only the time it was written gives it away.
      disk.truncate(SEGMENT, lineOf(second).length)
      disk.append(SEGMENT, lineOf(third))
      expect(reader.read()).toMatchObject({ status: 'ok', batches: [third], pendingBytes: 0 })
    })

    it('does not take a last line that is whole except for its newline', () => {
      const whole = lineOf(third)
      disk.append(SEGMENT, Buffer.concat([lineOf(second), whole.subarray(0, whole.length - 1)]))
      const reader = open()
      expect(reader.read()).toMatchObject({
        batches: [second],
        headRevision: 2,
        pendingBytes: whole.length - 1
      })
      disk.append(SEGMENT, Buffer.from('\n'))
      expect(reader.read()).toMatchObject({ batches: [third], headRevision: 3, pendingBytes: 0 })
    })

    it('reads on when the writer cuts the fragment away and appends in its place', () => {
      disk.append(
        SEGMENT,
        Buffer.concat([lineOf(second), lineOf(batch(2, 3, 'lost')).subarray(0, 50)])
      )
      const reader = open()
      expect(reader.read()).toMatchObject({ batches: [second], pendingBytes: 50 })

      disk.truncate(SEGMENT, lineOf(second).length)
      expect(reader.read()).toMatchObject({ status: 'ok', batches: [], pendingBytes: 0 })
      disk.append(SEGMENT, lineOf(third))
      expect(reader.read()).toMatchObject({ status: 'ok', batches: [third], headRevision: 3 })
    })
  })

  describe('damage', () => {
    it('reports a fragment followed by a later line as corrupt, at the fragment', () => {
      const fragment = lineOf(batch(2, 3, 'lost in the crash')).subarray(0, 60)
      disk.append(SEGMENT, Buffer.concat([lineOf(second), fragment, lineOf(third), lineOf(fourth)]))
      const reader = open()

      expect(reader.read()).toEqual({
        status: 'corrupt',
        batches: [second],
        duplicates: 0,
        offset: lineOf(second).length,
        headRevision: 2,
        pendingBytes: 60 + lineOf(third).length + lineOf(fourth).length,
        file: 'at-path'
      })
    })

    it('reports it when the later line arrives after the fragment was already seen', () => {
      const fragment = lineOf(batch(2, 3, 'lost in the crash')).subarray(0, 60)
      disk.append(SEGMENT, Buffer.concat([lineOf(second), fragment]))
      const reader = open()
      expect(reader.read()).toMatchObject({ status: 'ok', batches: [second], pendingBytes: 60 })

      disk.append(SEGMENT, lineOf(third))
      expect(reader.read()).toMatchObject({
        status: 'corrupt',
        batches: [],
        offset: lineOf(second).length,
        headRevision: 2
      })
    })

    it.each([
      ['text that is not JSON', Buffer.from('not json\n')],
      ['JSON that is not a batch', lineOf({ revision: 3 })],
      ['a batch of another thread', lineOf({ ...batch(2, 3), chatId: 'chat-2' })],
      ['a batch that does not advance', lineOf({ ...batch(2, 3), revision: 2 })],
      [
        'an operation the log does not know',
        lineOf({ ...batch(2, 3), operations: [{ type: 'x' }] })
      ],
      ['a line of spaces', Buffer.from('  \n')]
    ])('reports %s as corrupt and returns nothing after it', (_name, damaged) => {
      disk.append(SEGMENT, Buffer.concat([lineOf(second), damaged, lineOf(third), lineOf(fourth)]))
      const reader = open()
      expect(reader.read()).toMatchObject({
        status: 'corrupt',
        batches: [second],
        offset: lineOf(second).length,
        headRevision: 2
      })
    })

    it('stops for good: a later read returns the report again and does not touch the file', () => {
      disk.append(SEGMENT, Buffer.concat([lineOf(second), Buffer.from('not json\n')]))
      const reader = open()
      const first = reader.read()
      expect(first).toMatchObject({ status: 'corrupt', batches: [second] })

      // Even a file put right afterwards is not read: the caller starts over.
      disk.overwrite(SEGMENT, Buffer.concat([lineOf(second), lineOf(third)]))
      disk.calls = []
      expect(reader.read()).toEqual({ ...first, batches: [] })
      expect(reader.read()).toEqual({ ...first, batches: [] })
      expect(disk.calls).toEqual([])
    })
  })

  describe('the revision chain', () => {
    it('skips a batch the head already covers and counts it', () => {
      disk.append(
        SEGMENT,
        Buffer.concat([
          lineOf(second),
          lineOf(third),
          lineOf(fourth),
          lineOf(third),
          // Judged by its revision alone, as the journal does: its base is not the head.
          lineOf(batch(0, 2)),
          lineOf(fifth)
        ])
      )
      expect(open({ headRevision: 3 }).read()).toMatchObject({
        status: 'ok',
        batches: [fourth, fifth],
        duplicates: 4,
        offset: disk.contents(SEGMENT).length,
        headRevision: 5,
        pendingBytes: 0
      })
    })

    it('reports a batch that does not continue the head as a gap and stops before it', () => {
      disk.append(
        SEGMENT,
        Buffer.concat([lineOf(second), lineOf(second), lineOf(fourth), lineOf(fifth)])
      )
      const reader = open()
      const first = reader.read()
      expect(first).toEqual({
        status: 'gap',
        baseRevision: 3,
        revision: 4,
        batches: [second],
        duplicates: 1,
        offset: lineOf(second).length * 2,
        headRevision: 2,
        pendingBytes: lineOf(fourth).length + lineOf(fifth).length,
        file: 'at-path'
      })
      disk.calls = []
      expect(reader.read()).toEqual({ ...first, batches: [], duplicates: 0 })
      expect(disk.calls).toEqual([])
    })

    it('reports a batch that starts before the head and ends after it as a gap', () => {
      disk.append(SEGMENT, lineOf(batch(1, 4)))
      expect(open({ headRevision: 2 }).read()).toMatchObject({
        status: 'gap',
        baseRevision: 1,
        revision: 4,
        batches: [],
        offset: 0,
        headRevision: 2
      })
    })
  })

  describe('wherever the bytes are split', () => {
    // Two-, three- and four-byte characters, so most cut points fall inside one.
    const written = [
      batch(1, 2, 'plain ascii'),
      batch(2, 3, 'café € \u{1f600}'),
      batch(2, 3, 'a duplicate'),
      batch(3, 4, '日本語 – \u{1f9f5}'),
      batch(4, 5, '')
    ]
    const bytes = Buffer.concat([
      lineOf(written[0]),
      lineOf(written[1]),
      Buffer.from('\n'),
      lineOf(written[2]),
      lineOf(written[3]),
      lineOf(written[4])
    ])
    const expected = [written[0], written[1], written[3], written[4]]
    const longestLine = Math.max(...written.map((each) => lineOf(each).length))

    const collect = (reads: ThreadLogSegmentRead[]): unknown => ({
      batches: reads.flatMap((read) => read.batches),
      duplicates: reads.reduce((sum, read) => sum + read.duplicates, 0),
      statuses: [...new Set(reads.map((read) => read.status))],
      offset: reads.at(-1)!.offset,
      headRevision: reads.at(-1)!.headRevision,
      pendingBytes: reads.at(-1)!.pendingBytes
    })
    const whole = {
      batches: expected,
      duplicates: 1,
      statuses: ['ok'],
      offset: bytes.length,
      headRevision: 5,
      pendingBytes: 0
    }

    it('has characters of more than one byte to split', () => {
      expect(bytes.length).toBeGreaterThan(bytes.toString('utf8').length + 10)
    })

    it('yields the same batches when the file grows in two steps cut at any byte', () => {
      for (let cut = 0; cut <= bytes.length; cut += 1) {
        const local = new MemoryDisk()
        local.create(SEGMENT, bytes.subarray(0, cut))
        const reader = open({ fs: local })
        const reads = drain(reader)
        local.append(SEGMENT, bytes.subarray(cut))
        reads.push(...drain(reader))
        expect(collect(reads), `cut at byte ${cut}`).toEqual(whole)
      }
    })

    it('yields the same batches whatever size it reads the file in', () => {
      for (let chunkBytes = 1; chunkBytes <= bytes.length + 1; chunkBytes += 1) {
        const local = new MemoryDisk()
        local.create(SEGMENT, bytes)
        const reads = drain(open({ fs: local, chunkBytes }))
        expect(collect(reads), `${chunkBytes} bytes at a time`).toEqual(whole)
        // A piece and the bytes checked again, or one whole line with its newline.
        expect(local.largestRead).toBeLessThanOrEqual(Math.max(chunkBytes + 64, longestLine))
      }
    })

    it('yields the same batches when it grows byte by byte and is read after every byte', () => {
      for (const chunkBytes of [1, 7, 64 * 1024]) {
        const local = new MemoryDisk()
        local.create(SEGMENT)
        const reader = open({ fs: local, chunkBytes })
        const reads: ThreadLogSegmentRead[] = []
        for (let index = 0; index < bytes.length; index += 1) {
          local.append(SEGMENT, bytes.subarray(index, index + 1))
          reads.push(...drain(reader))
        }
        expect(collect(reads), `${chunkBytes} bytes at a time`).toEqual(whole)
      }
    })

    it('yields the same batches when the disk hands over less than it was asked for', () => {
      for (const mostPerRead of [1, 5, 61]) {
        const local = new MemoryDisk()
        local.mostPerRead = mostPerRead
        local.create(SEGMENT, bytes)
        const reads = drain(open({ fs: local, chunkBytes: 100 }))
        expect(collect(reads), `${mostPerRead} bytes a read`).toEqual(whole)
      }
    })

    it('yields the same batches however little one read may consume', () => {
      for (let maxReadBytes = 1; maxReadBytes <= bytes.length + 1; maxReadBytes += 17) {
        const local = new MemoryDisk()
        local.create(SEGMENT, bytes)
        const reads = drain(open({ fs: local, maxReadBytes, chunkBytes: 32 }))
        expect(collect(reads), `${maxReadBytes} bytes a read`).toEqual(whole)
      }
    })
  })

  describe('how much one read takes', () => {
    it('hands back after about the read limit and picks up where it stopped', () => {
      const lines = Array.from({ length: 40 }, (_unused, index) => batch(index + 1, index + 2))
      const each = lineOf(lines[0]).length
      disk.append(SEGMENT, Buffer.concat(lines.map(lineOf)))
      const reader = open({ chunkBytes: each, maxReadBytes: each * 4 })

      const first = reader.read()
      expect(first).toMatchObject({ status: 'ok', reachedEnd: false })
      expect(first.batches.length).toBeGreaterThanOrEqual(4)
      expect(first.batches.length).toBeLessThanOrEqual(6)
      expect(first.pendingBytes).toBe(disk.contents(SEGMENT).length - first.offset)

      const reads = [first, ...drain(reader)]
      expect(reads.length).toBeGreaterThan(5)
      expect(reads.flatMap((read) => read.batches)).toEqual(lines)
      expect(reads.at(-1)).toMatchObject({ status: 'ok', reachedEnd: true, pendingBytes: 0 })
    })

    it('reads about a megabyte a call unless told otherwise', () => {
      expect(THREAD_LOG_SEGMENT_MAX_READ_BYTES).toBe(1024 * 1024)
      const line = lineOf(batchOfLineBytes(1, 2, 1023))
      const lines = 3 * 1024
      disk.create(SEGMENT)
      const all: Buffer[] = []
      for (let index = 0; index < lines; index += 1) {
        all.push(lineOf(batchOfLineBytes(index + 1, index + 2, 1023)))
      }
      expect(all[0].length).toBe(line.length)
      disk.append(SEGMENT, Buffer.concat(all))
      const reader = open()
      const first = reader.read()
      expect(first).toMatchObject({ status: 'ok', reachedEnd: false })
      expect(first.offset).toBeGreaterThanOrEqual(1024 * 1024)
      expect(first.offset).toBeLessThan(1024 * 1024 + 64 * 1024 + 1024)
      expect(drain(reader).at(-1)).toMatchObject({ reachedEnd: true, headRevision: lines + 1 })
    })
  })

  describe('a very long line', () => {
    it('refuses a line longer than the limit and does not read it into memory', () => {
      disk.append(SEGMENT, lineOf(second))
      disk.append(SEGMENT, Buffer.alloc(1024 * 1024, 0x78))
      const reader = open({ maxLineBytes: 4096, chunkBytes: 1024 })

      const first = reader.read()
      expect(first).toEqual({
        status: 'oversized',
        limit: 4096,
        batches: [second],
        duplicates: 0,
        offset: lineOf(second).length,
        headRevision: 2,
        pendingBytes: 1024 * 1024,
        file: 'at-path'
      })
      // One piece at a time, and no further than it takes to pass the limit.
      expect(disk.largestRead).toBeLessThanOrEqual(1024 + 64)
      expect(disk.bytesRead).toBeLessThanOrEqual(lineOf(second).length * 2 + 4096 + 3 * 1024)

      disk.calls = []
      expect(reader.read()).toEqual({ ...first, batches: [] })
      expect(disk.calls).toEqual([])
    })

    it('draws the line at the same byte whether or not the newline has arrived', () => {
      const limit = 512
      const atLimit = batchOfLineBytes(1, 2, limit)
      const overLimit = batchOfLineBytes(1, 2, limit + 1)
      expect(lineOf(atLimit).length).toBe(limit + 1)

      for (const chunkBytes of [64, limit, limit + 1, 64 * 1024]) {
        const complete = new MemoryDisk()
        complete.create(SEGMENT, lineOf(atLimit))
        expect(
          open({ fs: complete, maxLineBytes: limit, chunkBytes }).read(),
          `a whole line at the limit, ${chunkBytes} at a time`
        ).toMatchObject({ status: 'ok', batches: [atLimit] })

        const waiting = new MemoryDisk()
        waiting.create(SEGMENT, lineOf(atLimit).subarray(0, limit))
        expect(
          open({ fs: waiting, maxLineBytes: limit, chunkBytes }).read(),
          `an unfinished line at the limit, ${chunkBytes} at a time`
        ).toMatchObject({ status: 'ok', batches: [], pendingBytes: limit })

        const tooLong = new MemoryDisk()
        tooLong.create(SEGMENT, lineOf(overLimit))
        expect(
          open({ fs: tooLong, maxLineBytes: limit, chunkBytes }).read(),
          `a whole line over the limit, ${chunkBytes} at a time`
        ).toMatchObject({ status: 'oversized', limit, batches: [], offset: 0 })

        const growing = new MemoryDisk()
        growing.create(SEGMENT, lineOf(overLimit).subarray(0, limit + 1))
        expect(
          open({ fs: growing, maxLineBytes: limit, chunkBytes }).read(),
          `an unfinished line over the limit, ${chunkBytes} at a time`
        ).toMatchObject({ status: 'oversized', limit, batches: [], offset: 0 })
      }
    })

    it('holds one piece of an unfinished line at a time while it waits', () => {
      disk.append(SEGMENT, lineOf(second))
      disk.append(SEGMENT, Buffer.alloc(300_000, 0x78))
      const reader = open({ chunkBytes: 4096 })
      expect(reader.read()).toMatchObject({
        status: 'ok',
        batches: [second],
        pendingBytes: 300_000
      })
      expect(reader.read()).toMatchObject({ status: 'ok', batches: [], pendingBytes: 300_000 })
      expect(disk.largestRead).toBeLessThanOrEqual(4096 + 64)
    })

    it('allows sixteen mebibytes a line unless told otherwise', () => {
      expect(THREAD_LOG_SEGMENT_MAX_LINE_BYTES).toBe(16 * 1024 * 1024)
      disk.create(SEGMENT, Buffer.alloc(THREAD_LOG_SEGMENT_MAX_LINE_BYTES, 0x78))
      const reader = open()
      expect(reader.read()).toMatchObject({
        status: 'ok',
        pendingBytes: THREAD_LOG_SEGMENT_MAX_LINE_BYTES
      })
      disk.append(SEGMENT, Buffer.from('x'))
      expect(reader.read()).toMatchObject({
        status: 'oversized',
        limit: THREAD_LOG_SEGMENT_MAX_LINE_BYTES
      })
    })
  })

  describe('a file that is not the one it was reading', () => {
    it('reports a file shorter than what it consumed, and does not start over', () => {
      disk.append(SEGMENT, Buffer.concat([lineOf(second), lineOf(third)]))
      const reader = open()
      const consumed = reader.read()
      expect(consumed).toMatchObject({ batches: [second, third] })

      disk.truncate(SEGMENT, lineOf(second).length)
      const first = reader.read()
      expect(first).toEqual({
        status: 'shrunk',
        size: lineOf(second).length,
        batches: [],
        duplicates: 0,
        offset: consumed.offset,
        headRevision: 3,
        pendingBytes: 0,
        file: 'at-path'
      })

      // Growing back past the offset does not make it readable again.
      disk.append(SEGMENT, Buffer.concat([lineOf(third), lineOf(fourth)]))
      disk.calls = []
      expect(reader.read()).toEqual(first)
      expect(disk.calls).toEqual([])
    })

    it('reports consumed bytes that were replaced in the same file', () => {
      disk.append(SEGMENT, Buffer.concat([lineOf(second), lineOf(third)]))
      const reader = open()
      expect(reader.read()).toMatchObject({ batches: [second, third], headRevision: 3 })

      // Same length up to the offset, so only the bytes themselves give it away.
      const other = [batch(1, 2, 'TO 2'), batch(2, 3, 'TO 3')]
      expect(lineOf(other[1]).length).toBe(lineOf(third).length)
      disk.overwrite(SEGMENT, Buffer.concat([lineOf(other[0]), lineOf(other[1]), lineOf(fourth)]))

      expect(reader.read()).toMatchObject({
        status: 'rewritten',
        batches: [],
        offset: lineOf(second).length + lineOf(third).length,
        headRevision: 3
      })
    })

    it('reports a starting offset that is not the start of a line', () => {
      disk.append(SEGMENT, Buffer.concat([lineOf(second), lineOf(third)]))
      const reader = open({ offset: lineOf(second).length - 1, headRevision: 2 })
      expect(reader.read()).toMatchObject({
        status: 'rewritten',
        batches: [],
        offset: lineOf(second).length - 1
      })
    })

    it.each([
      ['to a different size', batch(3, 4, 'next '.repeat(100)), false],
      // Only the time the file was written tells this one from the fragment.
      ['to the size it had', batchOfLineBytes(3, 4, 600 - lineOf(third).length - 1), false],
      // And only the size tells this one, on a disk whose clock did not move.
      ['within one tick of the clock', batch(3, 4, 'next '.repeat(100)), true]
    ])(
      'never mixes bytes read before and after the writer changed the file %s',
      (_name, next, clockStopped) => {
        // A torn line longer than one read, then the repair a restarted writer
        // makes: the fragment is cut and two shorter lines take its place.
        const torn = lineOf(batch(2, 3, 'lost '.repeat(200))).subarray(0, 600)
        disk.append(SEGMENT, Buffer.concat([lineOf(second), torn]))
        expect(lineOf(second).length + lineOf(third).length).toBeLessThan(256 * 2)
        const reader = open({ chunkBytes: 256 })

        let reads = 0
        disk.beforeRead = (index) => {
          reads += 1
          // By its third read the reader has the start of the fragment in hand
          // and is looking further along the file for the newline.
          if (index !== 2) return
          disk.clockStopped = clockStopped
          disk.truncate(SEGMENT, lineOf(second).length)
          disk.append(SEGMENT, Buffer.concat([lineOf(third), lineOf(next)]))
        }

        const result = drain(reader)
        expect(reads).toBeGreaterThan(3)
        expect(result.map((read) => read.status)).toEqual(result.map(() => 'ok'))
        expect(result.flatMap((read) => read.batches)).toEqual([second, third, next])
        expect(result.at(-1)).toMatchObject({
          offset: disk.contents(SEGMENT).length,
          headRevision: 4,
          pendingBytes: 0
        })
      }
    )

    it('reads again, and does not wait, when the file is cut short under a long line', () => {
      const long = batch(1, 2, 'long '.repeat(400))
      disk.append(SEGMENT, lineOf(long))
      const reader = open({ chunkBytes: 256 })
      disk.beforeRead = (index) => {
        if (index === 1) disk.truncate(SEGMENT, 300)
      }

      expect(reader.read()).toMatchObject({
        status: 'ok',
        reachedEnd: true,
        batches: [],
        offset: 0,
        pendingBytes: 300
      })
      disk.append(SEGMENT, lineOf(long).subarray(300))
      expect(reader.read()).toMatchObject({ status: 'ok', batches: [long], headRevision: 2 })
    })

    it('gives up a read on a file that will not hold still, and consumes nothing from it', () => {
      disk.append(SEGMENT, lineOf(second))
      const reader = open()
      let appended = 0
      disk.beforeRead = () => {
        appended += 1
        disk.append(SEGMENT, lineOf(batch(appended + 1, appended + 2)))
      }

      expect(reader.read()).toMatchObject({
        status: 'ok',
        reachedEnd: false,
        batches: [],
        offset: 0,
        headRevision: 1,
        pendingBytes: lineOf(second).length * 3
      })
      expect(appended).toBe(3)

      disk.beforeRead = null
      const settled = reader.read()
      expect(settled.batches.map((each) => each.revision)).toEqual([2, 3, 4, 5])
      expect(settled).toMatchObject({ status: 'ok', reachedEnd: true })
    })

    it('says when another file takes the path, and keeps to the file it holds', () => {
      disk.append(SEGMENT, lineOf(second))
      const reader = open()
      expect(reader.read()).toMatchObject({ batches: [second], file: 'at-path' })

      // Rotation: the writer's last bytes are in the renamed file.
      disk.append(SEGMENT, lineOf(third))
      disk.rename(SEGMENT, '/log/chat-1.sealed.mutations.jsonl')
      disk.create(SEGMENT, lineOf(fourth))
      expect(reader.read()).toMatchObject({
        status: 'ok',
        reachedEnd: true,
        batches: [third],
        headRevision: 3,
        pendingBytes: 0,
        file: 'moved'
      })

      disk.unlink('/log/chat-1.sealed.mutations.jsonl')
      expect(reader.read()).toMatchObject({ status: 'ok', batches: [], file: 'unlinked' })
    })

    it('says the path is no longer its own when nothing is there at all', () => {
      disk.append(SEGMENT, lineOf(second))
      const reader = open()
      disk.rename(SEGMENT, '/log/elsewhere')
      expect(reader.read()).toMatchObject({ batches: [second], file: 'moved' })
    })

    it('looks at the path before it measures the file, so a moved file is read to its end', () => {
      disk.append(SEGMENT, lineOf(second))
      const reader = open()
      disk.calls = []
      reader.read()
      expect(disk.calls).toEqual(['lstat', 'fstat', 'fstat', 'read', 'fstat'])

      // And with nothing new there is nothing to read at all.
      disk.calls = []
      reader.read()
      expect(disk.calls).toEqual(['lstat', 'fstat', 'fstat'])
    })
  })

  describe('opening and closing', () => {
    it('opens for reading only and makes no call that could change a file', () => {
      disk.append(SEGMENT, Buffer.concat([lineOf(second), Buffer.from('torn')]))
      const reader = open()
      reader.read()
      reader.close()
      const flags = disk.constants.O_RDONLY | disk.constants.O_NOFOLLOW | disk.constants.O_NONBLOCK
      expect(disk.calls[0]).toBe(`open:${flags}`)
      expect([...new Set(disk.calls.slice(1))].sort()).toEqual(['close', 'fstat', 'lstat', 'read'])
    })

    it('returns nothing to read when the segment does not exist', () => {
      expect(
        openThreadLogSegmentReader({ filePath: SEGMENT, chatId: CHAT, headRevision: 1, fs: disk })
      ).toBeNull()
    })

    it('refuses what is not a regular file and leaves no descriptor open', () => {
      disk.create(SEGMENT, Buffer.alloc(0), false)
      expect(() => open()).toThrow(/not a regular file/)
      expect(disk.openDescriptors()).toBe(0)
    })

    it('closes its descriptor once, and refuses to read afterwards', () => {
      disk.append(SEGMENT, lineOf(second))
      const reader = open()
      expect(disk.openDescriptors()).toBe(1)
      reader.close()
      reader.close()
      expect(disk.openDescriptors()).toBe(0)
      expect(disk.calls.filter((call) => call === 'close')).toHaveLength(1)
      expect(() => reader.read()).toThrow(/closed/)
    })

    it.each([
      ['a negative offset', { offset: -1 }],
      ['a fractional offset', { offset: 1.5 }],
      ['a negative head revision', { headRevision: -1 }],
      ['a head revision that is not a number', { headRevision: Number.NaN }],
      ['a line limit of zero', { maxLineBytes: 0 }],
      ['a read limit of zero', { maxReadBytes: 0 }],
      ['a read size of zero', { chunkBytes: 0 }]
    ])('refuses %s before it opens anything', (_name, options) => {
      disk.append(SEGMENT, lineOf(second))
      disk.calls = []
      expect(() => open(options)).toThrow(RangeError)
      expect(disk.calls).toEqual([])
    })
  })
})

describe('thread log segment reader on real files', () => {
  let directory: string
  let active: string
  let sealed: string
  const readers: ThreadLogSegmentReader[] = []

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-segment-reader-'))
    active = path.join(directory, 'chat-1.mutations.jsonl')
    sealed = path.join(directory, 'chat-1.sealed.mutations.jsonl')
  })

  afterEach(() => {
    for (const reader of readers.splice(0)) reader.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const open = (headRevision = 1): ThreadLogSegmentReader => {
    const reader = openThreadLogSegmentReader({ filePath: active, chatId: CHAT, headRevision })
    if (!reader) throw new Error('the segment does not exist')
    readers.push(reader)
    return reader
  }

  const second = batch(1, 2, 'café € \u{1f600}')
  const third = batch(2, 3)
  const fourth = batch(3, 4)

  it('follows a file as it is appended to', () => {
    fs.writeFileSync(active, lineOf(second))
    const reader = open()
    expect(reader.read()).toMatchObject({ status: 'ok', batches: [second], file: 'at-path' })

    fs.appendFileSync(active, lineOf(third).subarray(0, 25))
    expect(reader.read()).toMatchObject({ status: 'ok', batches: [], pendingBytes: 25 })
    fs.appendFileSync(active, lineOf(third).subarray(25))
    expect(reader.read()).toMatchObject({
      status: 'ok',
      batches: [third],
      offset: fs.statSync(active).size,
      headRevision: 3,
      pendingBytes: 0
    })
  })

  it('returns nothing to read for a missing segment and does not create it', () => {
    expect(
      openThreadLogSegmentReader({ filePath: active, chatId: CHAT, headRevision: 1 })
    ).toBeNull()
    expect(fs.readdirSync(directory)).toEqual([])
  })

  // What the next three ask of the operating system is how POSIX treats names
  // and descriptors; the reader's own part in each is covered above.
  it.skipIf(process.platform === 'win32')(
    'does not follow a symbolic link or open a directory',
    () => {
      const elsewhere = path.join(directory, 'elsewhere')
      fs.writeFileSync(elsewhere, lineOf(second))
      fs.symlinkSync(elsewhere, active)
      expect(() =>
        openThreadLogSegmentReader({ filePath: active, chatId: CHAT, headRevision: 1 })
      ).toThrow()

      expect(() =>
        openThreadLogSegmentReader({ filePath: directory, chatId: CHAT, headRevision: 1 })
      ).toThrow(/not a regular file/)
    }
  )

  it.each([
    ['torn', Buffer.concat([lineOf(second), Buffer.from('{"torn')]), 'ok'],
    [
      'damaged',
      Buffer.concat([lineOf(second), Buffer.from('not json\n'), lineOf(third)]),
      'corrupt'
    ]
  ])(
    'changes no byte of a %s segment, and cannot: its descriptor is read-only',
    (_name, bytes, status) => {
      fs.writeFileSync(active, bytes)
      const before = fs.statSync(active, { bigint: true })
      const opened: Array<{ fd: number; flags: unknown }> = []
      const realOpen = fs.openSync
      vi.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
        const fd = realOpen(target, flags, mode)
        opened.push({ fd, flags })
        return fd
      })
      syncBuiltinESMExports()

      const reader = open()
      expect(reader.read()).toMatchObject({ status, batches: [second] })
      reader.read()

      expect(opened).toHaveLength(1)
      const flags = opened[0].flags as number
      expect(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)).toBe(0)
      const noFollow = fs.constants.O_NOFOLLOW ?? 0
      expect(flags & noFollow).toBe(noFollow)
      expect(() => fs.writeSync(opened[0].fd, 'x')).toThrow()
      vi.restoreAllMocks()
      syncBuiltinESMExports()
      const after = fs.statSync(active, { bigint: true })
      expect(fs.readFileSync(active)).toEqual(bytes)
      expect({ ino: after.ino, size: after.size, mtimeNs: after.mtimeNs }).toEqual({
        ino: before.ino,
        size: before.size,
        mtimeNs: before.mtimeNs
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps reading the file it holds after a rename, and never the file that took its path',
    () => {
      fs.writeFileSync(active, lineOf(second))
      const reader = open()
      expect(reader.read()).toMatchObject({ batches: [second], file: 'at-path' })

      // What rotation does: the last bytes land, the segment is sealed by rename,
      // and the next append makes a new file under the old name.
      fs.appendFileSync(active, lineOf(third))
      fs.renameSync(active, sealed)
      fs.writeFileSync(active, lineOf(fourth))
      expect(reader.read()).toMatchObject({
        status: 'ok',
        reachedEnd: true,
        batches: [third],
        headRevision: 3,
        pendingBytes: 0,
        file: 'moved'
      })

      fs.unlinkSync(sealed)
      expect(reader.read()).toMatchObject({ status: 'ok', batches: [], file: 'unlinked' })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reports a file swapped in over its path as one it no longer follows',
    () => {
      fs.writeFileSync(active, lineOf(second))
      const reader = open()
      reader.read()

      const replacement = path.join(directory, 'replacement.tmp')
      fs.writeFileSync(replacement, Buffer.concat([lineOf(second), lineOf(third)]))
      fs.renameSync(replacement, active)
      expect(reader.read()).toMatchObject({
        status: 'ok',
        batches: [],
        headRevision: 2,
        file: 'unlinked'
      })
    }
  )

  it('reports a file cut below what it consumed', () => {
    fs.writeFileSync(active, Buffer.concat([lineOf(second), lineOf(third)]))
    const reader = open()
    reader.read()
    fs.truncateSync(active, lineOf(second).length)
    expect(reader.read()).toMatchObject({
      status: 'shrunk',
      size: lineOf(second).length,
      batches: []
    })
  })

  it('starts no timer and watches nothing: it reads only when it is asked', () => {
    vi.useFakeTimers()
    const watch = vi.spyOn(fs, 'watch')
    const watchFile = vi.spyOn(fs, 'watchFile')
    syncBuiltinESMExports()

    fs.writeFileSync(active, lineOf(second))
    const reader = open()
    reader.read()
    fs.appendFileSync(active, lineOf(third))
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(reader.read()).toMatchObject({ batches: [third] })
    reader.close()

    expect(vi.getTimerCount()).toBe(0)
    expect(watch).not.toHaveBeenCalled()
    expect(watchFile).not.toHaveBeenCalled()
  })
})
