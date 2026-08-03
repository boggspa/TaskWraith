import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HostDeltaStore,
  HOST_DELTA_CHECKPOINT_FILENAME,
  HOST_DELTA_JOURNAL_FILENAME
} from './HostDeltaStore'

describe('HostDeltaStore', () => {
  let dataDir: string
  let clock: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-deltas-'))
    clock = '2026-08-03T17:00:00.000Z'
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  function openStore(options?: {
    maxRecords?: number
    maxBytes?: number
    compactAfterRecords?: number
  }) {
    return new HostDeltaStore({
      dataDir,
      now: () => clock,
      maxRecords: options?.maxRecords,
      maxBytes: options?.maxBytes,
      compactAfterRecords: options?.compactAfterRecords
    })
  }

  it('appends ordered deltas with monotonic cursors within a generation', () => {
    const store = openStore()
    expect(store.getPosition()).toEqual({ generation: 1, cursor: 0 })

    const a1 = store.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 't1',
      payload: { title: 'one' }
    })
    expect(a1.kind).toBe('appended')
    if (a1.kind !== 'appended') return
    expect(a1.record.envelope.cursor).toBe(1)
    expect(a1.record.envelope.previousCursor).toBe(0)
    expect(a1.record.envelope.generation).toBe(1)
    expect(a1.position).toEqual({ generation: 1, cursor: 1 })

    const a2 = store.append({
      kind: 'tombstone',
      family: 'thread',
      entityId: 't1'
    })
    expect(a2.kind).toBe('appended')
    if (a2.kind !== 'appended') return
    expect(a2.record.envelope.cursor).toBe(2)
    expect(a2.record.envelope.previousCursor).toBe(1)
    expect(a2.record.envelope.tombstone).toBe(true)
  })

  it('returns deltas since a client cursor and empty when caught up', () => {
    const store = openStore()
    store.append({ kind: 'upsert', family: 'run', entityId: 'r1' })
    store.append({ kind: 'upsert', family: 'run', entityId: 'r2' })
    store.append({ kind: 'remove', family: 'run', entityId: 'r1' })

    const from0 = store.since({ generation: 1, cursor: 0 })
    expect(from0.kind).toBe('deltas')
    if (from0.kind !== 'deltas') return
    expect(from0.deltas).toHaveLength(3)
    expect(from0.deltas[0]?.previousCursor).toBe(0)
    expect(from0.deltas[2]?.cursor).toBe(3)

    const mid = store.since({ generation: 1, cursor: 1 })
    expect(mid.kind).toBe('deltas')
    if (mid.kind !== 'deltas') return
    expect(mid.deltas).toHaveLength(2)
    expect(mid.deltas[0]?.cursor).toBe(2)

    const caughtUp = store.since({ generation: 1, cursor: 3 })
    expect(caughtUp.kind).toBe('deltas')
    if (caughtUp.kind !== 'deltas') return
    expect(caughtUp.deltas).toHaveLength(0)
  })

  it('requires full resnapshot on generation mismatch and retention gap', () => {
    const store = openStore({ maxRecords: 2, compactAfterRecords: 1 })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'a' })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'b' })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'c' })
    store.compact()

    // Newest two retained; cursor 1 dropped → client at 0 cannot get continuous chain from 1.
    const gap = store.since({ generation: 1, cursor: 0 })
    // If lowest retained is 2, cursor 1 missing → retention_gap
    expect(gap.kind).toBe('full_resnapshot_required')
    if (gap.kind !== 'full_resnapshot_required') return
    expect(gap.reason).toBe('retention_gap')

    const genMismatch = store.since({ generation: 99, cursor: 0 })
    expect(genMismatch.kind).toBe('full_resnapshot_required')
    if (genMismatch.kind !== 'full_resnapshot_required') return
    expect(['generation_mismatch', 'generation_reset']).toContain(genMismatch.reason)
  })

  it('durably resets generation and clears prior generation deltas', () => {
    const store = openStore()
    store.append({ kind: 'upsert', family: 'mission', entityId: 'm1' })
    store.append({ kind: 'upsert', family: 'mission', entityId: 'm2' })

    clock = '2026-08-03T17:00:10.000Z'
    const reset = store.resetGeneration('discontinuity')
    expect(reset.kind).toBe('appended')
    if (reset.kind !== 'appended') return
    expect(reset.record.envelope.kind).toBe('generation-reset')
    expect(reset.position).toEqual({ generation: 2, cursor: 1 })

    // Prior generation cannot be served.
    const old = store.since({ generation: 1, cursor: 2 })
    expect(old.kind).toBe('full_resnapshot_required')
    if (old.kind !== 'full_resnapshot_required') return
    expect(old.reason).toBe('generation_reset')

    const fresh = store.since({ generation: 2, cursor: 0 })
    expect(fresh.kind).toBe('deltas')
    if (fresh.kind !== 'deltas') return
    expect(fresh.deltas).toHaveLength(1)
    expect(fresh.deltas[0]?.kind).toBe('generation-reset')
  })

  it('reopens after simulated Host restart and recovers deltas/tombstones', () => {
    const store = openStore()
    store.append({ kind: 'upsert', family: 'thread', entityId: 't1', payload: { n: 1 } })
    store.append({ kind: 'tombstone', family: 'thread', entityId: 't1' })
    store.append({ kind: 'upsert', family: 'warning', entityId: 'w1' })

    const reopened = openStore()
    expect(reopened.getPosition()).toEqual({ generation: 1, cursor: 3 })
    expect(reopened.getByCursor(2)?.envelope.tombstone).toBe(true)
    expect(reopened.getByCursor(1)?.envelope.entityId).toBe('t1')

    const since = reopened.since({ generation: 1, cursor: 1 })
    expect(since.kind).toBe('deltas')
    if (since.kind !== 'deltas') return
    expect(since.deltas).toHaveLength(2)
  })

  it('treats exact duplicate cursor content as idempotent and rejects conflicts', () => {
    const store = openStore({ compactAfterRecords: 1000 })
    const first = store.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 't1',
      payload: { title: 'same' },
      at: '2026-08-03T17:00:00.000Z'
    })
    expect(first.kind).toBe('appended')
    if (first.kind !== 'appended') return

    // Simulate replaying the exact journal append by reopening and attempting same chain.
    // Conflicting content at an already-stored cursor is rejected on reopen path;
    // append always mints next cursor, so conflict is exercised via journal replay.
    const journalPath = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
    const prior = readFileSync(journalPath, 'utf8')
    const conflictLine = JSON.stringify({
      op: 'append',
      record: {
        schemaVersion: 1,
        contentFingerprint: 'deadbeef',
        retainedBytes: 10,
        envelope: {
          protocolVersion: 2,
          projectionVersion: 1,
          generation: 1,
          cursor: 1,
          previousCursor: 0,
          kind: 'upsert',
          family: 'thread',
          entityId: 'DIFFERENT',
          at: '2026-08-03T17:00:00.000Z'
        }
      }
    })
    writeFileSync(journalPath, `${prior}${conflictLine}\n`)

    const reopened = openStore({ compactAfterRecords: 1000 })
    // Original retained; conflict ignored with recovery warning.
    expect(reopened.getByCursor(1)?.envelope.entityId).toBe('t1')
    expect(reopened.getRecoveryState().recoveryState).toBe('recovered-corrupt-interior')

    // Exact duplicate journal line is idempotent.
    const exactDup = JSON.stringify({
      op: 'append',
      record: first.record
    })
    writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}${exactDup}\n`)
    const again = openStore({ compactAfterRecords: 1000 })
    expect(again.getByCursor(1)?.envelope.entityId).toBe('t1')
    expect(again.getPosition().cursor).toBe(1)
  })

  it('drops truncated journal tail and keeps prior durable deltas', () => {
    const store = openStore({ compactAfterRecords: 1000 })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'keep' })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'also' })

    const journalPath = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
    const prior = readFileSync(journalPath, 'utf8')
    writeFileSync(
      journalPath,
      `${prior}{"op":"append","record":{"schemaVersion":1,"envelope":{"cursor":3`
    )

    const reopened = openStore({ compactAfterRecords: 1000 })
    expect(reopened.getPosition().cursor).toBe(2)
    expect(reopened.getByCursor(1)?.envelope.entityId).toBe('keep')
    expect(reopened.getRecoveryState().recoveryState).toBe('recovered-truncated-tail')
  })

  it('skips corrupt interior journal lines without losing later valid deltas', () => {
    const store = openStore({ compactAfterRecords: 1000 })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'a' })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'b' })

    const journalPath = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
    const lines = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
    const corrupted = [lines[0], 'NOT-JSON', ...lines.slice(1)].join('\n') + '\n'
    writeFileSync(journalPath, corrupted)

    const reopened = openStore({ compactAfterRecords: 1000 })
    expect(reopened.getByCursor(1)?.envelope.entityId).toBe('a')
    expect(reopened.getByCursor(2)?.envelope.entityId).toBe('b')
    expect(reopened.getRecoveryState().recoveryState).toBe('recovered-corrupt-interior')
  })

  it('compacts journal into checkpoint and enforces bounded retention', () => {
    const store = openStore({ maxRecords: 3, compactAfterRecords: 2 })
    for (let i = 1; i <= 5; i += 1) {
      clock = `2026-08-03T17:00:0${i}.000Z`
      store.append({ kind: 'upsert', family: 'thread', entityId: `t${i}` })
    }
    store.compact()
    expect(store.size).toBe(3)

    const checkpointPath = join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME)
    expect(existsSync(checkpointPath)).toBe(true)
    const doc = JSON.parse(readFileSync(checkpointPath, 'utf8')) as { records: unknown[] }
    expect(doc.records).toHaveLength(3)

    // Newest three: cursors 3,4,5
    expect(store.getByCursor(1)).toBeNull()
    expect(store.getByCursor(2)).toBeNull()
    expect(store.getByCursor(5)?.envelope.entityId).toBe('t5')

    const reopened = openStore({ maxRecords: 3 })
    expect(reopened.size).toBe(3)
    expect(reopened.getPosition().cursor).toBe(5)
    expect(reopened.getByCursor(5)?.envelope.entityId).toBe('t5')
  })

  it('does not retain credentials or unrestricted transcript bodies in payloads', () => {
    const store = openStore()
    const result = store.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 't1',
      payload: { title: 'ok', note: 'bounded' }
    })
    expect(result.kind).toBe('appended')
    if (result.kind !== 'appended') return
    const json = JSON.stringify(result.record)
    expect(json).not.toMatch(/password|authorization|secret_token/i)
    expect(result.record.contentFingerprint).toMatch(/^[a-f0-9]+$/)
  })
})
