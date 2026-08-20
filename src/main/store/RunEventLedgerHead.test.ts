import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-ledger-head-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

import { AppStore } from './index'
import { RUN_EVENT_EMPTY_HASH, serializeRunEventRecord } from '../RunEventStore'
import type { RunEventRecord } from './types'

const hashFor = (sequence: number): string => `${sequence}`.padStart(64, 'a')

function ledgerLine(runId: string, sequence: number): string {
  return serializeRunEventRecord({
    schemaVersion: 1,
    id: `evt-${sequence}`,
    sequence,
    previousHash: sequence === 1 ? RUN_EVENT_EMPTY_HASH : hashFor(sequence - 1),
    runId,
    kind: 'tool',
    phase: 'artifact',
    source: 'main',
    timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
    summary: `event ${sequence}`,
    payload: { filler: 'x'.repeat(512) },
    hash: hashFor(sequence)
  } as RunEventRecord)
}

function runEventsDir(): string {
  const dir = join(userDataPath, 'run-events')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeLedger(runId: string, count: number): string {
  const filePath = join(runEventsDir(), `${runId}.jsonl`)
  let body = ''
  for (let sequence = 1; sequence <= count; sequence += 1) body += ledgerLine(runId, sequence)
  fs.writeFileSync(filePath, body)
  return filePath
}

/**
 * A ledger whose apparent size exceeds Node's MAX_STRING_LENGTH, written sparse
 * so it costs one block on disk. This is the shape that corrupted
 * pi-1786908001023-a7xhpwwedrd.jsonl in production: readFileSync(utf-8) throws
 * ERR_STRING_TOO_LONG, the read is swallowed, and the append restarts the
 * hash chain at sequence 1 in the middle of a gigabyte-scale ledger.
 */
function writeOversizedSparseLedger(runId: string, lastSequence: number): string {
  const filePath = join(runEventsDir(), `${runId}.jsonl`)
  const holeBytes = 600 * 1024 * 1024
  const tail = Buffer.from(
    `\n${ledgerLine(runId, lastSequence - 1)}${ledgerLine(runId, lastSequence)}`
  )
  const fd = fs.openSync(filePath, 'w')
  try {
    fs.ftruncateSync(fd, holeBytes)
    fs.writeSync(fd, tail, 0, tail.byteLength, holeBytes)
  } finally {
    fs.closeSync(fd)
  }
  return filePath
}

describe('run-event ledger head', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('continues the chain on a ledger larger than Node can hold in one string', () => {
    const runId = 'run-oversized'
    const filePath = writeOversizedSparseLedger(runId, 41_337)
    expect(fs.statSync(filePath).size).toBeGreaterThan(536_870_888)

    const record = AppStore.appendRunEvent({
      runId,
      kind: 'tool',
      phase: 'artifact',
      source: 'main',
      summary: 'appended'
    })

    expect(record.sequence).toBe(41_338)
    expect(record.previousHash).toBe(hashFor(41_337))
  })

  it('continues an ordinary multi-megabyte ledger', () => {
    const runId = 'run-big-ledger'
    const filePath = writeLedger(runId, 4000)
    expect(fs.statSync(filePath).size).toBeGreaterThan(2 * 1024 * 1024)

    const record = AppStore.appendRunEvent({
      runId,
      kind: 'tool',
      phase: 'artifact',
      source: 'main',
      summary: 'appended'
    })

    expect(record.sequence).toBe(4001)
    expect(record.previousHash).toBe(hashFor(4000))
  })

  it('recovers the head when the ledger ends in a torn partial line', () => {
    const runId = 'run-torn'
    const filePath = writeLedger(runId, 30)
    fs.appendFileSync(filePath, '{"schemaVersion":1,"sequence":31,"runI')

    const record = AppStore.appendRunEvent({
      runId,
      kind: 'tool',
      phase: 'artifact',
      source: 'main'
    })

    expect(record.sequence).toBe(31)
    expect(record.previousHash).toBe(hashFor(30))
  })

  it('starts a fresh chain when no ledger exists', () => {
    const record = AppStore.appendRunEvent({
      runId: 'run-fresh',
      kind: 'tool',
      phase: 'artifact',
      source: 'main'
    })

    expect(record.sequence).toBe(1)
    expect(record.previousHash).toBe(RUN_EVENT_EMPTY_HASH)
  })

  it('starts a fresh chain for an empty ledger file', () => {
    const runId = 'run-empty'
    fs.writeFileSync(join(runEventsDir(), `${runId}.jsonl`), '')

    const record = AppStore.appendRunEvent({
      runId,
      kind: 'tool',
      phase: 'artifact',
      source: 'main'
    })

    expect(record.sequence).toBe(1)
    expect(record.previousHash).toBe(RUN_EVENT_EMPTY_HASH)
  })
})
