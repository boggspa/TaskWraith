import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseRunEventLine,
  RUN_EVENT_EMPTY_HASH,
  serializeRunEventRecord,
  verifyRunEventHashChain
} from '../RunEventStore'
import { RunEventLedgerWriter } from './RunEventLedgerWriter'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import { MainDurabilityDirectoryLeases } from './MainDurabilityDirectoryLeases'
import type { RunEventInput, RunEventRecord } from './types'

describe('RunEventLedgerWriter', () => {
  let root: string
  let runEventsDir: string
  let runArtifactsDir: string
  let writer: RunEventLedgerWriter

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-run-event-writer-'))
    runEventsDir = path.join(root, 'run-events')
    runArtifactsDir = path.join(root, 'run-artifacts')
    writer = new RunEventLedgerWriter({ runEventsDir, runArtifactsDir })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(root, { recursive: true, force: true })
  })

  function input(runId: string, overrides: Partial<RunEventInput> = {}): RunEventInput {
    return {
      runId,
      kind: 'provider_raw',
      phase: 'raw',
      source: 'provider',
      payload: { data: 'provider output\n' },
      timestamp: '2026-09-24T00:00:00.000Z',
      ...overrides
    }
  }

  function records(runId: string): RunEventRecord[] {
    return fs
      .readFileSync(path.join(runEventsDir, `${runId}.jsonl`), 'utf8')
      .split('\n')
      .map(parseRunEventLine)
      .filter((record): record is RunEventRecord => record !== null)
  }

  it('uses injected soft/prompt/strict durability while preserving read-your-writes and retirement', async () => {
    let syncs = 0
    const completions: (() => void)[] = []
    const flusher = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (_fd, done) => {
        const complete = () => done()
        completions.push(complete)
        return { joinSync: complete }
      },
      fsyncSync: (fd) => {
        syncs++
        fs.fsyncSync(fd)
      },
      close: (fd) => fs.closeSync(fd)
    })
    const injected = new RunEventLedgerWriter({
      runEventsDir,
      runArtifactsDir,
      durabilityFlusher: flusher,
      directoryLeases: new MainDurabilityDirectoryLeases(flusher)
    })
    const first = injected.append(input('injected'))
    expect(records('injected')).toEqual([first])
    expect(syncs).toBe(process.platform === 'win32' ? 0 : 1)
    injected.append(input('injected', { kind: 'lifecycle' }))
    expect(completions.length).toBeGreaterThan(0)
    const strict = injected.append(input('injected'), { durability: 'strict' })
    expect(records('injected').at(-1)).toEqual(strict)
    expect(syncs).toBeGreaterThan(0)
    injected.drainDurabilitySync()
    await injected.awaitDurable('injected')
    injected.retireSync(['injected'])
    await injected.retire()
    expect(verifyRunEventHashChain(records('injected'))).toBe(true)
  })

  it('keeps independent run chains and resumes the exact on-disk head after reopening', () => {
    const first = writer.append(input('run-a'))
    const other = writer.append(input('run-b'))
    const second = writer.append(input('run-a'))
    writer = new RunEventLedgerWriter({ runEventsDir, runArtifactsDir })
    const third = writer.append(input('run-a'))

    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3])
    expect(other).toMatchObject({ sequence: 1, previousHash: RUN_EVENT_EMPTY_HASH })
    expect(second.previousHash).toBe(first.hash)
    expect(third.previousHash).toBe(second.hash)
    expect(records('run-a')).toEqual([first, second, third])
    expect(verifyRunEventHashChain(records('run-a'))).toBe(true)
    expect(fs.readFileSync(path.join(runEventsDir, 'run-a.jsonl'), 'utf8')).toBe(
      [first, second, third].map(serializeRunEventRecord).join('')
    )
  })

  it('writes opt-in redacted stream artifacts with the existing per-append identities', () => {
    const hidden = writer.append(input('run-artifacts'))
    expect(hidden.artifacts).toBeUndefined()
    expect(fs.existsSync(runArtifactsDir)).toBe(false)

    const stdout = writer.append(
      input('run-artifacts', { payload: { data: 'provider token=abc1234567890\n' } }),
      { storeRawEvents: true }
    )
    const stderr = writer.append(
      input('run-artifacts', {
        kind: 'provider_error',
        payload: { error: 'provider error token=abc1234567890\n' }
      }),
      { storeRawEvents: true }
    )
    for (const [record, stream, text] of [
      [stdout, 'stdout', 'provider token=[redacted]\n'],
      [stderr, 'stderr', 'provider error token=[redacted]\n']
    ] as const) {
      const bytes = fs.readFileSync(path.join(runArtifactsDir, 'run-artifacts', `${stream}.log`))
      expect(bytes.toString('utf8')).toBe(text)
      expect(record.artifacts).toEqual([
        {
          id: `run-artifacts:${stream}:${record.sequence}`,
          kind: stream,
          path: `run-artifacts/${stream}.log`,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength,
          sequence: record.sequence
        }
      ])
      expect(JSON.stringify(record)).not.toContain('abc1234567890')
    }
  })

  it('preserves lifecycle, strict and every-25th-event file durability boundaries', () => {
    const realFsync = fs.fsyncSync.bind(fs)
    const barriers: string[] = []
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      barriers.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file')
      realFsync(fd)
    })

    writer.append(input('run-flush'))
    expect(barriers).toEqual([])
    writer.append(input('run-flush', { kind: 'lifecycle', phase: 'control' }))
    expect(barriers).toEqual(['file'])
    for (let sequence = 3; sequence <= 24; sequence++) writer.append(input('run-flush'))
    expect(barriers).toEqual(['file'])
    expect(writer.append(input('run-flush')).sequence).toBe(25)
    expect(barriers).toEqual(['file', 'file'])
    const strict = writer.append(input('run-flush'), { durability: 'strict' })
    expect(barriers).toEqual(['file', 'file', 'file'])
    expect(records('run-flush').at(-1)).toEqual(strict)
  })

  it('persists newly created directory entries around a strict append', () => {
    const realFsync = fs.fsyncSync.bind(fs)
    const barriers: string[] = []
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      barriers.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file')
      realFsync(fd)
    })

    const record = writer.append(input('run-strict'), { durability: 'strict' })
    expect(barriers).toEqual(
      process.platform === 'win32' ? ['file'] : ['directory', 'file', 'directory']
    )
    expect(records('run-strict')).toEqual([record])
  })

  it('closes a failed write and does not advance its cached sequence or hash', () => {
    const first = writer.append(input('run-write-failure'))
    const close = vi.spyOn(fs, 'closeSync')
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('injected write failure')
    })
    expect(() => writer.append(input('run-write-failure'))).toThrow('injected write failure')
    expect(close).toHaveBeenCalledOnce()
    write.mockRestore()

    const next = writer.append(input('run-write-failure'))
    expect(next).toMatchObject({ sequence: 2, previousHash: first.hash })
    expect(records('run-write-failure')).toEqual([first, next])
    expect(verifyRunEventHashChain(records('run-write-failure'))).toBe(true)
  })

  it('preserves records and hash chains after a cold torn tail or missing final newline', () => {
    for (const fragment of ['{"schemaVersion":1,"sequence":2,"runI', '']) {
      const runId = fragment ? 'run-torn-tail' : 'run-missing-newline'
      const first = writer.append(input(runId))
      const ledger = path.join(runEventsDir, `${runId}.jsonl`)
      if (fragment) fs.appendFileSync(ledger, fragment)
      else fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').trimEnd())
      writer.forgetHead(runId)
      const second = writer.append(input(runId))
      expect(records(runId)).toEqual([first, second])
      expect(verifyRunEventHashChain(records(runId))).toBe(true)
    }
  })

  it('repairs a partial failed write on the next append in the same process', () => {
    const runId = 'run-partial-write'
    const first = writer.append(input(runId))
    const realWrite = fs.writeFileSync.bind(fs)
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((fd, data) => {
      realWrite(fd, String(data).slice(0, 40))
      throw new Error('partial write failure')
    })
    expect(() => writer.append(input(runId))).toThrow('partial write failure')
    write.mockRestore()
    const second = writer.append(input(runId))
    expect(records(runId)).toEqual([first, second])
    expect(verifyRunEventHashChain(records(runId))).toBe(true)
  })

  it('propagates a strict file-fsync failure and closes its open handle', () => {
    writer.append(input('run-fsync-failure'))
    const close = vi.spyOn(fs, 'closeSync')
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw new Error('injected fsync failure')
    })
    expect(() => writer.append(input('run-fsync-failure'), { durability: 'strict' })).toThrow(
      'injected fsync failure'
    )
    expect(close).toHaveBeenCalledOnce()
  })

  it('forgets one deleted ledger independently and clears all heads for a profile reset', () => {
    const a = writer.append(input('run-reset-a'))
    const b = writer.append(input('run-reset-b'))
    fs.rmSync(path.join(runEventsDir, 'run-reset-a.jsonl'))
    writer.forgetHead('run-reset-a')
    const recreated = writer.append(input('run-reset-a'))
    expect(recreated).toMatchObject({ sequence: 1, previousHash: RUN_EVENT_EMPTY_HASH })
    expect(writer.append(input('run-reset-b'))).toMatchObject({
      sequence: b.sequence + 1,
      previousHash: b.hash
    })
    expect(a.sequence).toBe(1)

    fs.rmSync(runEventsDir, { recursive: true })
    writer.clearHeads()
    for (const runId of ['run-reset-a', 'run-reset-b']) {
      expect(writer.append(input(runId))).toMatchObject({
        sequence: 1,
        previousHash: RUN_EVENT_EMPTY_HASH
      })
    }
  })
})
