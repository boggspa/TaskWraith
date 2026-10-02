import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createRunEventRecord,
  parseRunEventLine,
  safeRunEventFileName,
  serializeRunEventRecord
} from '../RunEventStore'
import { RunEventLedgerWriter } from './RunEventLedgerWriter'
import { inspectRunEventLedgerTail, runEventLedgerAppendPrefix } from './RunEventLedgerTail'

function line(sequence: number): string {
  return serializeRunEventRecord(
    createRunEventRecord(
      { runId: 'model', kind: 'tool', phase: 'artifact', source: 'main' },
      sequence
    )
  )
}

describe('RunEventLedgerTail model', () => {
  // Demonstrated red against the real writer before the standalone repair.
  it('existing writer preserves the first record appended after a torn tail', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-m5-tail-'))
    try {
      const runEventsDir = path.join(root, 'events')
      const writer = new RunEventLedgerWriter({
        runEventsDir,
        runArtifactsDir: path.join(root, 'artifacts')
      })
      writer.append({ runId: 'torn', kind: 'tool', phase: 'artifact', source: 'main' })
      const ledger = path.join(runEventsDir, safeRunEventFileName('torn'))
      fs.appendFileSync(ledger, '{"schemaVersion":1,"sequence":2,"runI')
      writer.forgetHead('torn')
      const appended = writer.append({
        runId: 'torn',
        kind: 'tool',
        phase: 'artifact',
        source: 'main'
      })
      const records = fs
        .readFileSync(ledger, 'utf8')
        .split('\n')
        .map(parseRunEventLine)
        .filter(Boolean)
      expect(records.some((record) => record!.id === appended.id)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves the first new record after a torn fragment without truncation', () => {
    const before = line(1) + '{"schemaVersion":1,"sequence":2,"runI'
    const inspected = inspectRunEventLedgerTail(Buffer.from(before))
    expect(inspected.head?.sequence).toBe(1)
    expect(inspected.appendPrefix).toBe('\n')
    const appended = line(2)
    const repaired = before + inspected.appendPrefix + appended
    expect(repaired.startsWith(before)).toBe(true)
    const records = repaired.split('\n').map(parseRunEventLine).filter(Boolean)
    expect(records.map((record) => record!.sequence)).toEqual([1, 2])
  })

  it('preserves both records when only the previous final newline was lost', () => {
    const before = line(1).trimEnd()
    const inspected = inspectRunEventLedgerTail(Buffer.from(before))
    expect(inspected.head?.sequence).toBe(1)
    const repaired = before + inspected.appendPrefix + line(2)
    expect(repaired.split('\n').map(parseRunEventLine).filter(Boolean)).toHaveLength(2)
  })

  it('rechecks EOF after every failed write, including repeated partial retries', () => {
    let body = line(1)
    const next = line(2)
    body += next.slice(0, 30)
    body += runEventLedgerAppendPrefix(Buffer.from(body).at(-1)) + next.slice(0, 50)
    body += runEventLedgerAppendPrefix(Buffer.from(body).at(-1)) + next
    expect(
      body
        .split('\n')
        .map(parseRunEventLine)
        .filter(Boolean)
        .map((record) => record!.sequence)
    ).toEqual([1, 2])
  })

  it('takes sequence and hash from the highest record in shuffled and duplicated tails', () => {
    const highest = line(30)
    const head = inspectRunEventLedgerTail(Buffer.from(highest + line(2) + highest + line(1))).head
    expect(head).toEqual({ sequence: 30, hash: parseRunEventLine(highest)!.hash })
  })

  it('ignores a cut first fragment, malformed final fragment and invalid sequences', () => {
    const bytes = Buffer.from(line(90).slice(40) + line(4) + '{"sequence":99')
    expect(inspectRunEventLedgerTail(bytes, false).head?.sequence).toBe(4)
    const invalid = JSON.parse(line(5))
    invalid.sequence = -1
    expect(inspectRunEventLedgerTail(Buffer.from(JSON.stringify(invalid))).head).toBeNull()
  })

  it('fails closed when the highest sequence has conflicting hash identities', () => {
    const original = line(5)
    const duplicate = JSON.parse(original)
    duplicate.hash = 'b'.repeat(64)
    expect(() =>
      inspectRunEventLedgerTail(Buffer.from(original + JSON.stringify(duplicate)))
    ).toThrow('Conflicting')
  })

  it('does not add separators to empty or LF-terminated ledgers', () => {
    expect(inspectRunEventLedgerTail(Buffer.alloc(0))).toEqual({ head: null, appendPrefix: '' })
    expect(inspectRunEventLedgerTail(Buffer.from(line(1))).appendPrefix).toBe('')
    expect(runEventLedgerAppendPrefix(0x0d)).toBe('\n')
  })
})
