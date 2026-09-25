import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEmptyHostSnapshot } from '../shared/hostProtocol'
import { applyHostSnapshotDeltas } from '../shared/hostSnapshotApply'
import {
  HOST_DELTA_MAX_PAYLOAD_BYTES,
  HOST_DELTA_SINCE_MAX_BYTES,
  HostDeltaStore,
  prepareHostDeltaPayload
} from './HostDeltaStore'

// M4 slice 7d (R2-S5, design §15.8): every client rejects the `_truncated`
// stub, so real rows up to the protocol's largest are carried whole, and a
// since() reply too large for one transport line answers a resnapshot.

const paths: string[] = []
function directory() {
  const value = mkdtempSync(join(tmpdir(), 'host-delta-large-rows-'))
  paths.push(value)
  return value
}
afterEach(() => {
  for (const value of paths.splice(0)) rmSync(value, { recursive: true, force: true })
})

const now = () => '2026-09-25T16:00:00.000Z'
const clientCache = () =>
  createEmptyHostSnapshot({
    generation: 1,
    cursor: 0,
    freshness: 'live',
    generatedAt: '2026-09-25T16:00:00.000Z'
  })

/** A round at the protocol's list cap: 2,000 run ids, about 80 KB of JSON. */
function largestRound(roundId: string) {
  return {
    roundId,
    threadId: 'thread-1',
    status: 'running',
    participantIds: Array.from({ length: 50 }, (_, index) => `ensemble-seat-${index}`),
    providerRunIds: Array.from({ length: 2000 }, () => randomUUID())
  }
}

describe('HostDeltaStore large rows (M4 slice 7d)', () => {
  it('carries a round at the protocol list cap whole, and a client applies it', () => {
    const round = largestRound('round-1')
    expect(Buffer.byteLength(JSON.stringify(round))).toBeGreaterThan(8_000)
    const store = new HostDeltaStore({ dataDir: directory(), now })
    const appended = store.append({
      kind: 'upsert',
      family: 'round',
      entityId: 'round-1',
      payload: round
    })
    expect(appended.kind).toBe('appended')

    const since = store.since({ generation: 1, cursor: 0 })
    expect(since.kind).toBe('deltas')
    if (since.kind !== 'deltas') return
    expect(since.deltas[0]?.payload).toEqual(round)

    // The same client apply that rejects the stub accepts the carried row.
    const applied = applyHostSnapshotDeltas(clientCache(), since.deltas)
    expect(applied.outcome).toBe('applied')
    if (applied.outcome !== 'applied') return
    expect(applied.snapshot.rounds[0]?.providerRunIds).toHaveLength(2000)
  })

  it('carries large rows through a group and a reopen', async () => {
    const dataDir = directory()
    const round = largestRound('round-1')
    const store = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
    store.appendGroup({
      commandId: 'cmd',
      effects: [{ kind: 'upsert', family: 'round', entityId: 'round-1', payload: round }]
    })
    await store.awaitDurable()
    const reopened = new HostDeltaStore({ dataDir, now })
    expect(reopened.getByCursor(1)?.envelope.payload).toEqual(round)
  })

  it('caps by UTF-8 bytes: exactly the cap is carried, one byte more is stubbed', () => {
    // {"note":"…"} adds 11 bytes of JSON around the string.
    const exact = { note: 'n'.repeat(HOST_DELTA_MAX_PAYLOAD_BYTES - 11) }
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(HOST_DELTA_MAX_PAYLOAD_BYTES)
    expect(prepareHostDeltaPayload(exact)).toEqual({ ok: true, payload: exact })

    const over = { note: 'n'.repeat(HOST_DELTA_MAX_PAYLOAD_BYTES - 10) }
    expect(prepareHostDeltaPayload(over)).toMatchObject({ ok: true, payload: { _truncated: true } })

    // Fewer characters than the cap, more bytes: bytes decide.
    const wide = { note: 'é'.repeat(Math.ceil(HOST_DELTA_MAX_PAYLOAD_BYTES / 2)) }
    expect(JSON.stringify(wide).length).toBeLessThan(HOST_DELTA_MAX_PAYLOAD_BYTES)
    expect(prepareHostDeltaPayload(wide)).toMatchObject({ ok: true, payload: { _truncated: true } })
  })

  it('answers a resnapshot, not an oversized reply, past the since() byte bound', () => {
    const store = new HostDeltaStore({ dataDir: directory(), now, compactAfterRecords: 10000 })
    for (let index = 0; index < 3; index += 1) {
      store.append({
        kind: 'upsert',
        family: 'round',
        entityId: `round-${index}`,
        payload: largestRound(`round-${index}`)
      })
    }
    // Three ~80 KB rows exceed the default 192,000-byte reply bound.
    expect(store.since({ generation: 1, cursor: 0 })).toEqual({
      kind: 'full_resnapshot_required',
      reason: 'retention_gap',
      generation: 1,
      cursor: 3,
      clientGeneration: 1,
      clientCursor: 0
    })
    // A client one row behind still gets its delta.
    const near = store.since({ generation: 1, cursor: 2 })
    expect(near.kind).toBe('deltas')
    if (near.kind === 'deltas') expect(near.deltas.map((delta) => delta.cursor)).toEqual([3])
    expect(HOST_DELTA_SINCE_MAX_BYTES).toBe(192_000)
  })

  it('serves a reply exactly at the byte bound and refuses one byte past it', () => {
    const store = new HostDeltaStore({ dataDir: directory(), now, compactAfterRecords: 10000 })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'a' })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'b' })
    const bytes = [1, 2].reduce((sum, cursor) => sum + store.getByCursor(cursor)!.retainedBytes, 0)

    const exact = new HostDeltaStore({
      dataDir: directory(),
      now,
      compactAfterRecords: 10000,
      sinceMaxBytes: bytes
    })
    exact.append({ kind: 'upsert', family: 'thread', entityId: 'a' })
    exact.append({ kind: 'upsert', family: 'thread', entityId: 'b' })
    expect(exact.since({ generation: 1, cursor: 0 }).kind).toBe('deltas')

    const under = new HostDeltaStore({
      dataDir: directory(),
      now,
      compactAfterRecords: 10000,
      sinceMaxBytes: bytes - 1
    })
    under.append({ kind: 'upsert', family: 'thread', entityId: 'a' })
    under.append({ kind: 'upsert', family: 'thread', entityId: 'b' })
    expect(under.since({ generation: 1, cursor: 0 })).toMatchObject({
      kind: 'full_resnapshot_required',
      reason: 'retention_gap'
    })
  })
})
