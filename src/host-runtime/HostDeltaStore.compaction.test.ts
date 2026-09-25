import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HostDeltaStore,
  HOST_DELTA_CHECKPOINT_FILENAME,
  HOST_DELTA_JOURNAL_FILENAME,
  HOST_DELTA_SEALED_SEGMENT_PATTERN,
  hostDeltaGroupSetDigest,
  type HostDeltaAppendInput,
  type HostDeltaCompactionStage,
  type HostDeltaStoreOptions
} from './HostDeltaStore'
import type { HostCursorPosition } from '../shared/hostProtocol'

// M4 slice 7c (design §15.6): open groups are anchored in the checkpoint until
// their receipts are terminal, and compaction leaves the append path: the
// journal is rotated to a sealed segment synchronously, the checkpoint is
// written asynchronously, and the sealed segments are removed once it is
// durable. Every clause is pinned at the store seam; nothing in production
// calls the group API until slice 12.

const paths: string[] = []
function directory() {
  const value = mkdtempSync(join(tmpdir(), 'host-delta-compaction-'))
  paths.push(value)
  return value
}
afterEach(() => {
  for (const value of paths.splice(0)) rmSync(value, { recursive: true, force: true })
})

const now = () => '2026-09-25T14:00:00.000Z'
const effects = (count = 2, prefix = 'thread'): HostDeltaAppendInput[] =>
  Array.from({ length: count }, (_, index) => ({
    kind: 'upsert',
    family: 'thread',
    entityId: `${prefix}-${index}`,
    payload: { title: `${prefix} ${index}` }
  }))
const legacy = (entityId: string): HostDeltaAppendInput => ({
  kind: 'upsert',
  family: 'thread',
  entityId,
  payload: { title: entityId }
})

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Resolves 'pending' when the promise has not settled within a short grace period. */
async function settledWithin<T>(promise: Promise<T>, ms = 150): Promise<T | 'pending'> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Polls a condition; throws when it does not hold within the timeout. */
async function until(condition: () => boolean, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Real fsync through the seam, recording every path it was asked to flush. */
function recordingFsync(calls: string[]): NonNullable<HostDeltaStoreOptions['groupFsync']> {
  return async (path) => {
    calls.push(path)
    const descriptor = openSync(path, 'r')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }
}

/**
 * The first journal fsync through the seam is held until `hold` settles
 * (reject it to fail the fsync); every later call succeeds at once.
 */
function heldFirstFsync(
  journal: string,
  hold: Deferred,
  started: Deferred
): NonNullable<HostDeltaStoreOptions['groupFsync']> {
  let calls = 0
  return async (path) => {
    if (path !== journal) return
    calls += 1
    if (calls === 1) {
      started.resolve()
      await hold.promise
    }
  }
}

/**
 * A stage hook that records every stage it saw and can hold the compaction
 * at chosen stages until released. `reached(stage)` resolves when the hook
 * is entered for that stage, whether or not it holds there.
 */
function stageGate(holdAt: readonly HostDeltaCompactionStage[] = []) {
  const stages: HostDeltaCompactionStage[] = []
  const reached = new Map<HostDeltaCompactionStage, Deferred>()
  const holds = new Map<HostDeltaCompactionStage, Deferred>()
  const entry = (map: Map<HostDeltaCompactionStage, Deferred>, stage: HostDeltaCompactionStage) => {
    let value = map.get(stage)
    if (!value) {
      value = deferred()
      map.set(stage, value)
    }
    return value
  }
  const hook: NonNullable<HostDeltaStoreOptions['onCompactionStage']> = async (stage) => {
    stages.push(stage)
    entry(reached, stage).resolve()
    if (holdAt.includes(stage)) await entry(holds, stage).promise
  }
  return {
    stages,
    hook,
    reached: (stage: HostDeltaCompactionStage) => entry(reached, stage).promise,
    release: (stage: HostDeltaCompactionStage) => entry(holds, stage).resolve()
  }
}

/** A real temp-checkpoint write through the seam, recording each call. */
function recordingCheckpointWrite(calls: Array<{ tmpPath: string; data: string }>) {
  const write: NonNullable<HostDeltaStoreOptions['checkpointWrite']> = async (tmpPath, data) => {
    calls.push({ tmpPath, data })
    writeFileSync(tmpPath, data, { encoding: 'utf8', mode: 0o600 })
    const descriptor = openSync(tmpPath, 'r+')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }
  return write
}

interface CheckpointAnchor {
  commandId: string
  count: number
  setDigest: string
  start: number
  end: number
}
interface CheckpointDoc {
  generation: number
  cursor: number
  lowestRetainedCursor: number
  records: Array<{ envelope: { generation: number; cursor: number; entityId?: string } }>
  groups: CheckpointAnchor[]
}

function journalPath(dataDir: string) {
  return join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
}
function checkpointPath(dataDir: string) {
  return join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME)
}
function journalLines(dataDir: string): Array<Record<string, unknown>> {
  if (!existsSync(journalPath(dataDir))) return []
  return readFileSync(journalPath(dataDir), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}
function journalOps(dataDir: string) {
  return journalLines(dataDir).map((line) => line.op)
}
/**
 * The checkpoint document. §15.6 says the checkpoint "gains `groups`"; an
 * empty list may be written or omitted, so it is normalised to `[]` here.
 */
function readCheckpoint(dataDir: string): CheckpointDoc | null {
  if (!existsSync(checkpointPath(dataDir))) return null
  const doc = JSON.parse(readFileSync(checkpointPath(dataDir), 'utf8')) as CheckpointDoc
  return { ...doc, groups: doc.groups ?? [] }
}
function sealedSegments(dataDir: string): string[] {
  return readdirSync(dataDir)
    .filter((name) => HOST_DELTA_SEALED_SEGMENT_PATTERN.test(name))
    .sort()
}
function sealedName(seq: number) {
  return `host-deltas.journal.${String(seq).padStart(20, '0')}.sealed.jsonl`
}
function position(generation: number, cursor: number): HostCursorPosition {
  return { generation, cursor }
}
function anchor(
  store: HostDeltaStore,
  commandId: string,
  cursors: readonly number[],
  start: number,
  end: number
): CheckpointAnchor {
  return {
    commandId,
    count: cursors.length,
    setDigest: hostDeltaGroupSetDigest(
      cursors.map((cursor) => store.getByCursor(cursor)!.contentFingerprint)
    ),
    start,
    end
  }
}

describe('HostDeltaStore compaction (M4 slice 7c)', () => {
  it('names sealed segments with a 20-digit sequence the pattern captures', async () => {
    const dataDir = directory()
    const store = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
    store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })
    await store.awaitDurable()
    const gate = stageGate(['rotated'])
    const withHook = new HostDeltaStore({
      dataDir,
      now,
      compactAfterRecords: 10000,
      onCompactionStage: gate.hook
    })
    const compaction = withHook.compactInBackground()
    await gate.reached('rotated')
    expect(sealedSegments(dataDir)).toEqual([sealedName(1)])
    const match = HOST_DELTA_SEALED_SEGMENT_PATTERN.exec(sealedName(1))
    expect(match?.[1]).toBe('00000000000000000001')
    expect(HOST_DELTA_SEALED_SEGMENT_PATTERN.test(sealedName(123456))).toBe(true)
    for (const other of [
      HOST_DELTA_JOURNAL_FILENAME,
      HOST_DELTA_CHECKPOINT_FILENAME,
      `host-deltas.journal.${'1'.repeat(19)}.sealed.jsonl`,
      `host-deltas.journal.${'1'.repeat(21)}.sealed.jsonl`,
      `${sealedName(1)}.tmp`,
      `x${sealedName(1)}`
    ]) {
      expect(HOST_DELTA_SEALED_SEGMENT_PATTERN.test(other)).toBe(false)
    }
    gate.release('rotated')
    await expect(compaction).resolves.toEqual({
      kind: 'compacted',
      checkpointCursor: 1,
      sealedRemoved: 1
    })
    expect(sealedSegments(dataDir)).toEqual([])
  })

  describe('anchors', () => {
    it('survive a background compaction and a reopen, including a group retention trimmed', async () => {
      const dataDir = directory()
      // The writer's thresholds are wide so nothing compacts automatically;
      // the compacting instance reopens the same directory with a tight
      // retention bound (a reopen never starts a compaction by itself).
      const writer = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
      writer.append(legacy('seed'))
      const trimmed = writer.appendGroup({ commandId: 'trimmed', effects: effects(3, 'trimmed') })
      const kept = writer.appendGroup({ commandId: 'kept', effects: effects(1, 'kept') })
      expect(trimmed).toMatchObject({
        kind: 'appended',
        group: { start: position(1, 2), end: position(1, 4) }
      })
      expect(kept).toMatchObject({
        kind: 'appended',
        group: { start: position(1, 5), end: position(1, 5) }
      })
      if (trimmed.kind !== 'appended' || kept.kind !== 'appended') return
      await expect(writer.awaitDurable()).resolves.toEqual({
        kind: 'durable',
        position: position(1, 5)
      })
      const trimmedAnchor = anchor(writer, 'trimmed', [2, 3, 4], 2, 4)
      const keptAnchor = anchor(writer, 'kept', [5], 5, 5)

      const store = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000, maxRecords: 2 })
      expect(store.getRecoveryState().size).toBe(5)
      await expect(store.compactInBackground()).resolves.toEqual({
        kind: 'compacted',
        checkpointCursor: 5,
        sealedRemoved: 1
      })
      const checkpoint = readCheckpoint(dataDir)
      expect(checkpoint).toMatchObject({ generation: 1, cursor: 5, lowestRetainedCursor: 4 })
      expect(checkpoint?.records.map((record) => record.envelope.cursor)).toEqual([4, 5])
      expect(checkpoint?.groups).toEqual([trimmedAnchor, keptAnchor])
      expect(sealedSegments(dataDir)).toEqual([])

      // Memory was trimmed with the checkpoint, but the anchor is intact.
      expect(store.getByCursor(2)).toBeNull()
      expect(store.getByCursor(3)).toBeNull()
      expect(store.getByCursor(4)?.envelope.entityId).toBe('trimmed-2')
      expect(store.findGroup('trimmed')).toEqual({ ...trimmed.group, durable: true })
      expect(store.findGroup('kept')).toEqual({ ...kept.group, durable: true })
      expect(store.getPosition()).toEqual(position(1, 5))

      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getRecoveryState().recoveryState).toBe('clean')
      expect(reopened.getPosition()).toEqual(position(1, 5))
      expect(reopened.getAppendedPosition()).toEqual(position(1, 5))
      // D3 completes at `end` even though the records are gone.
      expect(reopened.findGroup('trimmed')).toEqual({ ...trimmed.group, durable: true })
      expect(reopened.findGroup('kept')).toEqual({ ...kept.group, durable: true })
      expect(reopened.getByCursor(2)).toBeNull()
      expect(reopened.getByCursor(4)?.envelope.entityId).toBe('trimmed-2')
      expect(reopened.since(position(1, 1))).toMatchObject({
        kind: 'full_resnapshot_required',
        reason: 'retention_gap'
      })
      expect(reopened.appendGroup({ commandId: 'trimmed', effects: effects(1) })).toEqual({
        kind: 'exists',
        group: { ...trimmed.group, durable: true }
      })
    })

    it('are written by legacy inline compaction too', async () => {
      const dataDir = directory()
      const store = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
      store.append(legacy('seed'))
      const group = store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })
      expect(group.kind).toBe('appended')
      if (group.kind !== 'appended') return
      await store.awaitDurable()

      store.compact()
      expect(sealedSegments(dataDir)).toEqual([])
      const checkpoint = readCheckpoint(dataDir)
      expect(checkpoint).toMatchObject({ generation: 1, cursor: 3 })
      expect(checkpoint?.groups).toEqual([anchor(store, 'a', [2, 3], 2, 3)])
      expect(new HostDeltaStore({ dataDir, now }).findGroup('a')).toEqual({
        ...group.group,
        durable: true
      })
    })

    it('are loaded on reopen for the checkpoint generation only: a later reset clears them', async () => {
      const dataDir = directory()
      const store = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
      store.append(legacy('seed'))
      store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })
      await store.awaitDurable()
      await expect(store.compactInBackground()).resolves.toMatchObject({ kind: 'compacted' })
      expect(readCheckpoint(dataDir)?.groups.map((group) => group.commandId)).toEqual(['a'])
      expect(store.findGroup('a')).not.toBeNull()

      // The reset is in the active journal; the checkpoint still names the anchor.
      expect(store.resetGeneration('slice 7c fixture')).toMatchObject({
        kind: 'appended',
        position: position(2, 1)
      })
      expect(store.findGroup('a')).toBeNull()
      expect(readCheckpoint(dataDir)?.groups.map((group) => group.commandId)).toEqual(['a'])
      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getPosition()).toEqual(position(2, 1))
      expect(reopened.findGroup('a')).toBeNull()

      // And the next checkpoint carries no anchor from the old generation.
      await expect(reopened.compactInBackground()).resolves.toEqual({
        kind: 'compacted',
        checkpointCursor: 1,
        sealedRemoved: 1
      })
      expect(readCheckpoint(dataDir)).toMatchObject({ generation: 2, cursor: 1, groups: [] })
      expect(new HostDeltaStore({ dataDir, now }).findGroup('a')).toBeNull()
    })
  })

  describe('releaseGroup', () => {
    it('removes the anchor from findGroup and the next checkpoint, and frees the commandId', async () => {
      const dataDir = directory()
      const store = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
      store.append(legacy('seed'))
      const first = store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })
      store.appendGroup({ commandId: 'b', effects: effects(1, 'b') })
      await store.awaitDurable()
      expect(first).toMatchObject({ kind: 'appended', group: { end: position(1, 3) } })
      if (first.kind !== 'appended') return
      const bAnchor = anchor(store, 'b', [4], 4, 4)

      expect(store.releaseGroup('a')).toBe(true)
      expect(store.findGroup('a')).toBeNull()
      expect(store.releaseGroup('a')).toBe(false)
      expect(store.releaseGroup('never-appended')).toBe(false)
      // Releasing changes nothing about the records themselves.
      expect(store.getPosition()).toEqual(position(1, 4))
      expect(store.getByCursor(2)?.envelope.entityId).toBe('a-0')
      expect(store.findGroup('b')).toMatchObject({ commandId: 'b', durable: true })

      await expect(store.compactInBackground()).resolves.toMatchObject({ kind: 'compacted' })
      expect(readCheckpoint(dataDir)?.groups).toEqual([bAnchor])
      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.findGroup('a')).toBeNull()
      expect(reopened.findGroup('b')).toMatchObject({ commandId: 'b', durable: true })

      // A released command can get a new group; dedupe is the receipt store's job.
      const again = store.appendGroup({ commandId: 'a', effects: effects(1, 'again') })
      expect(again).toMatchObject({
        kind: 'appended',
        group: { commandId: 'a', count: 1, start: position(1, 5), end: position(1, 5) }
      })
      await store.awaitDurable()
      expect(store.findGroup('a')).toMatchObject({ start: position(1, 5), durable: true })
      expect(store.getByCursor(5)?.envelope.entityId).toBe('again-0')
    })

    it('is remembered across a reopen only through the checkpoint', async () => {
      const dataDir = directory()
      const store = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
      store.append(legacy('seed'))
      store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })
      await store.awaitDurable()
      expect(store.releaseGroup('a')).toBe(true)
      // Nothing on disk records the release yet: the journal replays the group.
      expect(journalOps(dataDir)).toEqual(['append', 'group'])
      expect(new HostDeltaStore({ dataDir, now }).findGroup('a')).not.toBeNull()

      await expect(store.compactInBackground()).resolves.toMatchObject({ kind: 'compacted' })
      expect(readCheckpoint(dataDir)?.groups).toEqual([])
      expect(new HostDeltaStore({ dataDir, now }).findGroup('a')).toBeNull()
    })
  })

  describe('rotation waits for durability', () => {
    it('awaits the pending flush once, then compacts what it made durable', async () => {
      const dataDir = directory()
      const journal = journalPath(dataDir)
      const hold = deferred()
      const started = deferred()
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        groupFsync: heldFirstFsync(journal, hold, started)
      })
      store.append(legacy('seed'))
      const group = store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })
      expect(group.kind).toBe('appended')
      if (group.kind !== 'appended') return
      expect(store.getPosition()).toEqual(position(1, 1))

      // The compaction itself requests the flush; nobody else called awaitDurable.
      const compaction = store.compactInBackground()
      await started.promise
      expect(await settledWithin(compaction)).toBe('pending')
      expect(sealedSegments(dataDir)).toEqual([])
      expect(existsSync(checkpointPath(dataDir))).toBe(false)

      hold.resolve()
      await expect(compaction).resolves.toEqual({
        kind: 'compacted',
        checkpointCursor: 3,
        sealedRemoved: 1
      })
      expect(store.getPosition()).toEqual(position(1, 3))
      expect(store.findGroup('a')).toEqual({ ...group.group, durable: true })
      const checkpoint = readCheckpoint(dataDir)
      expect(checkpoint).toMatchObject({ generation: 1, cursor: 3 })
      expect(checkpoint?.records.map((record) => record.envelope.cursor)).toEqual([1, 2, 3])
      expect(checkpoint?.groups.map((entry) => entry.commandId)).toEqual(['a'])
      expect(sealedSegments(dataDir)).toEqual([])
      expect(journalLines(dataDir)).toEqual([])

      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getRecoveryState().recoveryState).toBe('clean')
      expect(reopened.getPosition()).toEqual(position(1, 3))
      expect(reopened.findGroup('a')).toEqual({ ...group.group, durable: true })
    })

    it('skips not-durable when a newer append arrived during the flush, and writes nothing', async () => {
      const dataDir = directory()
      const journal = journalPath(dataDir)
      const hold = deferred()
      const started = deferred()
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        groupFsync: heldFirstFsync(journal, hold, started)
      })
      store.append(legacy('seed'))
      store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })
      const compaction = store.compactInBackground()
      await started.promise
      const before = readFileSync(journal)

      // Appended while the flush is in flight: not covered by it, and there
      // is no retry loop.
      store.appendGroup({ commandId: 'b', effects: effects(1, 'b') })
      hold.resolve()
      await expect(compaction).resolves.toEqual({ kind: 'skipped', reason: 'not-durable' })
      expect(store.getPosition()).toEqual(position(1, 2))
      expect(store.getAppendedPosition()).toEqual(position(1, 3))
      expect(sealedSegments(dataDir)).toEqual([])
      expect(existsSync(checkpointPath(dataDir))).toBe(false)
      expect(readFileSync(journal).subarray(0, before.length)).toEqual(before)
      expect(journalOps(dataDir)).toEqual(['append', 'group', 'group'])

      // A skipped compaction costs only a later one.
      await expect(store.awaitDurable()).resolves.toEqual({
        kind: 'durable',
        position: position(1, 3)
      })
      await expect(store.compactInBackground()).resolves.toEqual({
        kind: 'compacted',
        checkpointCursor: 3,
        sealedRemoved: 1
      })
      expect(readCheckpoint(dataDir)?.groups.map((entry) => entry.commandId)).toEqual(['a', 'b'])
    })

    it('skips not-durable after the awaited flush ended in a reset', async () => {
      const dataDir = directory()
      const journal = journalPath(dataDir)
      const hold = deferred()
      const started = deferred()
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        groupFsync: heldFirstFsync(journal, hold, started)
      })
      store.append(legacy('seed'))
      store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })
      const compaction = store.compactInBackground()
      await started.promise

      hold.reject(new Error('injected group fsync failure'))
      await expect(compaction).resolves.toEqual({ kind: 'skipped', reason: 'not-durable' })
      expect(store.getPosition()).toEqual(position(2, 1))
      expect(store.getFailStop()).toBeNull()
      expect(store.findGroup('a')).toBeNull()
      expect(sealedSegments(dataDir)).toEqual([])
      expect(existsSync(checkpointPath(dataDir))).toBe(false)
      expect(journalOps(dataDir)).toEqual(['append', 'group', 'generation-reset', 'append'])

      // The new generation compacts normally afterwards.
      await expect(store.compactInBackground()).resolves.toEqual({
        kind: 'compacted',
        checkpointCursor: 1,
        sealedRemoved: 1
      })
      expect(readCheckpoint(dataDir)).toMatchObject({ generation: 2, cursor: 1, groups: [] })
      expect(new HostDeltaStore({ dataDir, now }).getPosition()).toEqual(position(2, 1))
    })

    it('skips fail-stopped on a fail-stopped store', async () => {
      const dataDir = directory()
      let failWrite = false
      let failTruncate = false
      const gate = stageGate()
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        onCompactionStage: gate.hook,
        batchWrite: (descriptor, bytes, offset, length) => {
          if (failWrite) {
            failWrite = false
            throw new Error('injected group write failure')
          }
          return writeSync(descriptor, bytes, offset, length, null)
        },
        batchTruncate: () => {
          if (failTruncate) {
            failTruncate = false
            throw new Error('injected rollback failure')
          }
        }
      })
      store.append(legacy('seed'))
      failWrite = true
      failTruncate = true
      expect(store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })).toMatchObject({
        kind: 'write-failed',
        rollback: 'uncertain',
        recovery: { kind: 'fail-stopped' }
      })
      expect(store.getFailStop()).not.toBeNull()

      await expect(store.compactInBackground()).resolves.toEqual({
        kind: 'skipped',
        reason: 'fail-stopped'
      })
      expect(gate.stages).toEqual([])
      expect(sealedSegments(dataDir)).toEqual([])
      expect(existsSync(checkpointPath(dataDir))).toBe(false)
      expect(journalOps(dataDir)).toEqual(['append'])
    })
  })

  describe('while a compaction runs', () => {
    it('a second call is skipped in-flight, legacy compact() defers, and appends land in the new journal', async () => {
      const dataDir = directory()
      const gate = stageGate(['rotated'])
      const writes: Array<{ tmpPath: string; data: string }> = []
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        onCompactionStage: gate.hook,
        checkpointWrite: recordingCheckpointWrite(writes)
      })
      store.append(legacy('seed'))
      const group = store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })
      expect(group.kind).toBe('appended')
      if (group.kind !== 'appended') return
      await store.awaitDurable()
      const sealedBytes = readFileSync(journalPath(dataDir))

      const first = store.compactInBackground()
      await gate.reached('rotated')
      expect(sealedSegments(dataDir)).toEqual([sealedName(1)])
      expect(readFileSync(join(dataDir, sealedName(1)))).toEqual(sealedBytes)
      expect(journalLines(dataDir)).toEqual([])
      expect(existsSync(checkpointPath(dataDir))).toBe(false)

      await expect(store.compactInBackground()).resolves.toEqual({
        kind: 'skipped',
        reason: 'in-flight'
      })
      expect(gate.stages).toEqual(['rotated'])

      // An append during the async checkpoint goes to the new active journal
      // and is visible at once, as every legacy append is.
      expect(store.append(legacy('during'))).toMatchObject({
        kind: 'appended',
        position: position(1, 4)
      })
      expect(journalOps(dataDir)).toEqual(['append'])
      expect(readFileSync(join(dataDir, sealedName(1)))).toEqual(sealedBytes)
      expect(store.getByCursor(4)?.envelope.entityId).toBe('during')

      // Legacy inline compaction defers without writing anything.
      expect(() => store.compact()).not.toThrow()
      expect(existsSync(checkpointPath(dataDir))).toBe(false)
      expect(journalOps(dataDir)).toEqual(['append'])
      expect(sealedSegments(dataDir)).toEqual([sealedName(1)])
      expect(writes).toEqual([])
      expect(await settledWithin(first)).toBe('pending')

      gate.release('rotated')
      await expect(first).resolves.toEqual({
        kind: 'compacted',
        checkpointCursor: 3,
        sealedRemoved: 1
      })
      expect(gate.stages).toEqual(['rotated', 'checkpoint-written', 'checkpoint-renamed'])
      expect(writes).toHaveLength(1)
      expect(readFileSync(checkpointPath(dataDir), 'utf8')).toBe(writes[0]!.data)
      const checkpoint = readCheckpoint(dataDir)
      expect(checkpoint).toMatchObject({ generation: 1, cursor: 3 })
      // Nothing past the snapshot cursor: the append during it is journal-only.
      expect(checkpoint?.records.map((record) => record.envelope.cursor)).toEqual([1, 2, 3])
      expect(checkpoint?.groups).toEqual([anchor(store, 'a', [2, 3], 2, 3)])
      expect(sealedSegments(dataDir)).toEqual([])
      expect(journalOps(dataDir)).toEqual(['append'])
      expect(store.getPosition()).toEqual(position(1, 4))

      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getRecoveryState().recoveryState).toBe('clean')
      expect(reopened.getPosition()).toEqual(position(1, 4))
      expect([1, 2, 3, 4].map((cursor) => reopened.getByCursor(cursor)?.envelope.entityId)).toEqual(
        ['seed', 'a-0', 'a-1', 'during']
      )
      expect(reopened.findGroup('a')).toEqual({ ...group.group, durable: true })

      // Legacy compaction works again once nothing is in flight.
      store.compact()
      expect(readCheckpoint(dataDir)).toMatchObject({ generation: 1, cursor: 4 })
      expect(journalLines(dataDir)).toEqual([])
      expect(sealedSegments(dataDir)).toEqual([])
      expect(new HostDeltaStore({ dataDir, now }).getPosition()).toEqual(position(1, 4))
    })

    it('awaits every stage hook, with the files in the state the stage names', async () => {
      const dataDir = directory()
      const gate = stageGate(['rotated', 'checkpoint-written', 'checkpoint-renamed'])
      const writes: Array<{ tmpPath: string; data: string }> = []
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        onCompactionStage: gate.hook,
        checkpointWrite: recordingCheckpointWrite(writes)
      })
      store.append(legacy('seed'))
      store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })
      await store.awaitDurable()

      const compaction = store.compactInBackground()
      await gate.reached('rotated')
      expect(sealedSegments(dataDir)).toEqual([sealedName(1)])
      expect(writes).toEqual([])
      expect(existsSync(checkpointPath(dataDir))).toBe(false)
      expect(await settledWithin(compaction)).toBe('pending')

      gate.release('rotated')
      await gate.reached('checkpoint-written')
      expect(writes).toHaveLength(1)
      const [write] = writes
      expect(write!.tmpPath).not.toBe(checkpointPath(dataDir))
      expect(write!.tmpPath.startsWith(dataDir)).toBe(true)
      expect(existsSync(write!.tmpPath)).toBe(true)
      expect(existsSync(checkpointPath(dataDir))).toBe(false)
      expect(JSON.parse(write!.data)).toMatchObject({ generation: 1, cursor: 2 })
      expect(sealedSegments(dataDir)).toEqual([sealedName(1)])
      expect(await settledWithin(compaction)).toBe('pending')

      gate.release('checkpoint-written')
      await gate.reached('checkpoint-renamed')
      expect(existsSync(write!.tmpPath)).toBe(false)
      expect(readFileSync(checkpointPath(dataDir), 'utf8')).toBe(write!.data)
      expect(sealedSegments(dataDir)).toEqual([sealedName(1)])
      expect(await settledWithin(compaction)).toBe('pending')

      gate.release('checkpoint-renamed')
      await expect(compaction).resolves.toEqual({
        kind: 'compacted',
        checkpointCursor: 2,
        sealedRemoved: 1
      })
      expect(sealedSegments(dataDir)).toEqual([])
      expect(gate.stages).toEqual(['rotated', 'checkpoint-written', 'checkpoint-renamed'])
    })

    it('a reset during the checkpoint leaves memory untrimmed and reopen follows the journal', async () => {
      const dataDir = directory()
      const gate = stageGate(['checkpoint-written'])
      const writer = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
      writer.append(legacy('seed'))
      writer.appendGroup({ commandId: 'a', effects: effects(2, 'a') })
      await writer.awaitDurable()
      // Reopened with a retention bound of one record, so the snapshot's
      // retention would cut cursors 1 and 2 if it were applied after the reset.
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        maxRecords: 1,
        onCompactionStage: gate.hook
      })
      expect(store.getPosition()).toEqual(position(1, 3))

      const compaction = store.compactInBackground()
      await gate.reached('checkpoint-written')
      expect(store.resetGeneration('mid-checkpoint')).toMatchObject({
        kind: 'appended',
        position: position(2, 1)
      })
      expect(store.findGroup('a')).toBeNull()
      gate.release('checkpoint-written')
      const result = await compaction
      expect(result.kind).not.toBe('failed')
      expect(readCheckpoint(dataDir)).toMatchObject({ generation: 1, cursor: 3 })
      expect(readCheckpoint(dataDir)?.records.map((record) => record.envelope.cursor)).toEqual([3])
      expect(sealedSegments(dataDir)).toEqual([])

      // The generation changed under the snapshot, so nothing of the new
      // generation was trimmed by the old snapshot's retention.
      expect(store.getPosition()).toEqual(position(2, 1))
      expect(store.getByCursor(1)?.envelope.kind).toBe('generation-reset')
      expect(store.since(position(2, 0))).toMatchObject({
        kind: 'deltas',
        deltas: [{ kind: 'generation-reset', cursor: 1 }]
      })

      // Reopen follows the old-generation checkpoint into the journal's reset.
      // (A further append on the maxRecords: 1 instance would compact inline
      // and trim cursor 1 by retention, which is not what is under test.)
      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getRecoveryState().recoveryState).toBe('clean')
      expect(reopened.getPosition()).toEqual(position(2, 1))
      expect(reopened.findGroup('a')).toBeNull()
      expect(reopened.getByCursor(1)?.envelope.kind).toBe('generation-reset')
      expect(reopened.getFailStop()).toBeNull()
      expect(reopened.append(legacy('after'))).toMatchObject({
        kind: 'appended',
        position: position(2, 2)
      })
      expect(new HostDeltaStore({ dataDir, now }).getByCursor(2)?.envelope.entityId).toBe('after')
    })
  })

  describe('a checkpoint failure', () => {
    it('resolves failed, keeps the sealed segment, and the reopen is lossless', async () => {
      const dataDir = directory()
      const gate = stageGate()
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        onCompactionStage: gate.hook,
        checkpointWrite: async () => {
          throw new Error('injected checkpoint write failure')
        }
      })
      store.append(legacy('seed'))
      const group = store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })
      expect(group.kind).toBe('appended')
      if (group.kind !== 'appended') return
      await store.awaitDurable()
      const sealedBytes = readFileSync(journalPath(dataDir))

      await expect(store.compactInBackground()).resolves.toEqual({
        kind: 'failed',
        detail: expect.stringContaining('injected checkpoint write failure')
      })
      expect(gate.stages).toEqual(['rotated'])
      expect(sealedSegments(dataDir)).toEqual([sealedName(1)])
      expect(readFileSync(join(dataDir, sealedName(1)))).toEqual(sealedBytes)
      expect(existsSync(checkpointPath(dataDir))).toBe(false)
      expect(store.getFailStop()).toBeNull()

      // Nothing is lost in memory, and the store keeps working.
      expect(store.getPosition()).toEqual(position(1, 3))
      expect(store.findGroup('a')).toEqual({ ...group.group, durable: true })
      expect(store.getByCursor(2)?.envelope.entityId).toBe('a-0')
      expect(store.append(legacy('after'))).toMatchObject({
        kind: 'appended',
        position: position(1, 4)
      })
      expect(journalOps(dataDir)).toEqual(['append'])

      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getRecoveryState().recoveryState).toBe('clean')
      expect(reopened.getPosition()).toEqual(position(1, 4))
      expect([1, 2, 3, 4].map((cursor) => reopened.getByCursor(cursor)?.envelope.entityId)).toEqual(
        ['seed', 'a-0', 'a-1', 'after']
      )
      expect(reopened.findGroup('a')).toEqual({ ...group.group, durable: true })
      expect(reopened.since(position(1, 0))).toMatchObject({ kind: 'deltas', toCursor: 4 })
    })

    it('is followed by a rotation to the next sequence that removes every sealed segment', async () => {
      const dataDir = directory()
      let failCheckpoint = true
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        checkpointWrite: async (tmpPath, data) => {
          if (failCheckpoint) throw new Error('injected checkpoint write failure')
          writeFileSync(tmpPath, data, 'utf8')
        }
      })
      store.append(legacy('seed'))
      store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })
      await store.awaitDurable()
      await expect(store.compactInBackground()).resolves.toMatchObject({ kind: 'failed' })
      store.appendGroup({ commandId: 'b', effects: effects(1, 'b') })
      await store.awaitDurable()
      await expect(store.compactInBackground()).resolves.toMatchObject({ kind: 'failed' })
      expect(sealedSegments(dataDir)).toEqual([sealedName(1), sealedName(2)])
      store.append(legacy('tail'))

      failCheckpoint = false
      await expect(store.compactInBackground()).resolves.toEqual({
        kind: 'compacted',
        checkpointCursor: 4,
        sealedRemoved: 3
      })
      expect(sealedSegments(dataDir)).toEqual([])
      const checkpoint = readCheckpoint(dataDir)
      expect(checkpoint).toMatchObject({ generation: 1, cursor: 4 })
      expect(checkpoint?.records.map((record) => record.envelope.cursor)).toEqual([1, 2, 3, 4])
      expect(checkpoint?.groups.map((entry) => entry.commandId)).toEqual(['a', 'b'])
      expect(journalLines(dataDir)).toEqual([])
      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getRecoveryState().recoveryState).toBe('clean')
      expect(reopened.getPosition()).toEqual(position(1, 4))
      expect(reopened.findGroup('a')).toMatchObject({ start: position(1, 2) })
      expect(reopened.findGroup('b')).toMatchObject({ start: position(1, 3) })
    })
  })

  describe('reopen', () => {
    it('reads sealed segments in ascending sequence, then the active journal', async () => {
      const dataDir = directory()
      const store = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
      // Segments sealed by hand, numbered so that lexical and numeric order
      // agree only through the zero padding, and with a gap between them.
      store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })
      await store.awaitDurable()
      renameSync(journalPath(dataDir), join(dataDir, sealedName(2)))
      store.appendGroup({ commandId: 'b', effects: effects(1, 'b') })
      await store.awaitDurable()
      renameSync(journalPath(dataDir), join(dataDir, sealedName(10)))
      store.append(legacy('active'))
      expect(sealedSegments(dataDir)).toEqual([sealedName(2), sealedName(10)])
      expect(journalOps(dataDir)).toEqual(['append'])

      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getRecoveryState().recoveryState).toBe('clean')
      expect(reopened.getPosition()).toEqual(position(1, 3))
      expect([1, 2, 3].map((cursor) => reopened.getByCursor(cursor)?.envelope.entityId)).toEqual([
        'a-0',
        'b-0',
        'active'
      ])
      expect(reopened.findGroup('a')).toMatchObject({ start: position(1, 1), durable: true })
      expect(reopened.findGroup('b')).toMatchObject({ start: position(1, 2), durable: true })
      expect(reopened.since(position(1, 0))).toMatchObject({ kind: 'deltas', toCursor: 3 })
      // Reopen does not touch the segments; only a compaction removes them.
      expect(sealedSegments(dataDir)).toEqual([sealedName(2), sealedName(10)])

      expect(reopened.append(legacy('next'))).toMatchObject({
        kind: 'appended',
        position: position(1, 4)
      })
      await expect(reopened.compactInBackground()).resolves.toEqual({
        kind: 'compacted',
        checkpointCursor: 4,
        sealedRemoved: 3
      })
      expect(sealedSegments(dataDir)).toEqual([])
      expect(readCheckpoint(dataDir)?.groups.map((entry) => entry.commandId)).toEqual(['a', 'b'])
    })

    it('adds nothing back from a sealed segment the checkpoint covers', async () => {
      const dataDir = directory()
      const gate = stageGate(['checkpoint-renamed'])
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        onCompactionStage: gate.hook
      })
      store.append(legacy('seed'))
      store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })
      await store.awaitDurable()
      expect(store.releaseGroup('a')).toBe(true)
      const compaction = store.compactInBackground()
      await gate.reached('checkpoint-renamed')
      // Checkpoint durable, sealed segment not yet removed: every line it
      // holds is covered, including the released group's.
      const sealed = join(dataDir, sealedName(1))
      const whole = readFileSync(sealed)

      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getRecoveryState().recoveryState).toBe('clean')
      expect(reopened.getPosition()).toEqual(position(1, 2))
      expect(reopened.getByCursor(1)?.envelope.entityId).toBe('seed')
      expect(reopened.getByCursor(2)?.envelope.entityId).toBe('a-0')
      expect(reopened.findGroup('a')).toBeNull()
      expect(reopened.since(position(1, 0))).toMatchObject({ kind: 'deltas', toCursor: 2 })
      // Reopen leaves the segment for the compaction to remove.
      expect(readFileSync(sealed)).toEqual(whole)

      gate.release('checkpoint-renamed')
      await expect(compaction).resolves.toMatchObject({ kind: 'compacted', sealedRemoved: 1 })
      expect(sealedSegments(dataDir)).toEqual([])
    })

    it('repairs a torn tail in a sealed segment no checkpoint covers', async () => {
      const dataDir = directory()
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        checkpointWrite: async () => {
          throw new Error('injected checkpoint write failure')
        }
      })
      store.append(legacy('seed'))
      store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })
      await store.awaitDurable()
      await expect(store.compactInBackground()).resolves.toMatchObject({ kind: 'failed' })
      store.append(legacy('after'))
      // The sealed segment is the only copy of cursors 1 and 2; a torn line
      // after them is dropped and truncated, exactly as in the active journal.
      const sealed = join(dataDir, sealedName(1))
      const whole = readFileSync(sealed)
      writeFileSync(sealed, Buffer.concat([whole, Buffer.from('{"op":"append","rec', 'utf8')]))

      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getRecoveryState().recoveryState).toBe('recovered-truncated-tail')
      expect(reopened.getPosition()).toEqual(position(1, 3))
      expect([1, 2, 3].map((cursor) => reopened.getByCursor(cursor)?.envelope.entityId)).toEqual([
        'seed',
        'a-0',
        'after'
      ])
      expect(reopened.findGroup('a')).toMatchObject({ start: position(1, 2), durable: true })
      expect(readFileSync(sealed)).toEqual(whole)
      expect(new HostDeltaStore({ dataDir, now }).getRecoveryState().recoveryState).toBe('clean')
    })
  })

  describe('the automatic trigger', () => {
    it('starts after a group flush settles, never inside an append, and legacy appends defer to it', async () => {
      const dataDir = directory()
      const gate = stageGate(['rotated'])
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 1,
        onCompactionStage: gate.hook
      })
      const group = store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })
      expect(group.kind).toBe('appended')
      if (group.kind !== 'appended') return
      // The threshold is exceeded, but an append never starts a compaction.
      expect(gate.stages).toEqual([])
      expect(sealedSegments(dataDir)).toEqual([])
      expect(existsSync(checkpointPath(dataDir))).toBe(false)
      expect(journalOps(dataDir)).toEqual(['group'])

      await expect(store.awaitDurable()).resolves.toEqual({
        kind: 'durable',
        position: position(1, 2)
      })
      await gate.reached('rotated')
      expect(sealedSegments(dataDir)).toEqual([sealedName(1)])
      expect(existsSync(checkpointPath(dataDir))).toBe(false)

      // A legacy append over the threshold defers its inline compaction while
      // the background one runs; it lands in the new active journal.
      expect(store.append(legacy('during'))).toMatchObject({
        kind: 'appended',
        position: position(1, 3)
      })
      expect(existsSync(checkpointPath(dataDir))).toBe(false)
      expect(journalOps(dataDir)).toEqual(['append'])
      expect(sealedSegments(dataDir)).toEqual([sealedName(1)])

      gate.release('rotated')
      await until(
        () => existsSync(checkpointPath(dataDir)) && sealedSegments(dataDir).length === 0,
        'the automatic compaction to finish'
      )
      expect(gate.stages).toEqual(['rotated', 'checkpoint-written', 'checkpoint-renamed'])
      const checkpoint = readCheckpoint(dataDir)
      expect(checkpoint).toMatchObject({ generation: 1, cursor: 2 })
      expect(checkpoint?.groups).toEqual([anchor(store, 'a', [1, 2], 1, 2)])
      expect(journalOps(dataDir)).toEqual(['append'])

      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getRecoveryState().recoveryState).toBe('clean')
      expect(reopened.getPosition()).toEqual(position(1, 3))
      expect(reopened.findGroup('a')).toEqual({ ...group.group, durable: true })
      expect(reopened.getByCursor(3)?.envelope.entityId).toBe('during')
    })

    it('does not start when the thresholds are not exceeded', async () => {
      const dataDir = directory()
      const gate = stageGate()
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        onCompactionStage: gate.hook
      })
      store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })
      await store.awaitDurable()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(gate.stages).toEqual([])
      expect(sealedSegments(dataDir)).toEqual([])
      expect(existsSync(checkpointPath(dataDir))).toBe(false)
      expect(journalOps(dataDir)).toEqual(['group'])
    })
  })

  it('leaves legacy behaviour byte-identical when no group is appended', async () => {
    const plain = directory()
    const withSeams = directory()
    const fsyncs: string[] = []
    const gate = stageGate()
    const writes: Array<{ tmpPath: string; data: string }> = []
    const script = (store: HostDeltaStore) => {
      store.append(legacy('one'))
      store.append(legacy('two'))
      store.append(legacy('three'))
      store.appendBatch(effects(2, 'batch'))
      store.resetGeneration('legacy fixture')
      store.append(legacy('four'))
      store.compact()
      store.append(legacy('five'))
    }
    const control = new HostDeltaStore({ dataDir: plain, now, compactAfterRecords: 3 })
    script(control)
    const subject = new HostDeltaStore({
      dataDir: withSeams,
      now,
      compactAfterRecords: 3,
      groupFsync: recordingFsync(fsyncs),
      onCompactionStage: gate.hook,
      checkpointWrite: recordingCheckpointWrite(writes)
    })
    const seen: number[] = []
    subject.subscribe((event) => seen.push(event.position.cursor))
    script(subject)

    // The inline compaction fired in both; neither rotated anything.
    expect(readCheckpoint(plain)).not.toBeNull()
    expect(readFileSync(checkpointPath(withSeams))).toEqual(readFileSync(checkpointPath(plain)))
    expect(readFileSync(journalPath(withSeams))).toEqual(readFileSync(journalPath(plain)))
    expect(readdirSync(withSeams).sort()).toEqual(readdirSync(plain).sort())
    expect(sealedSegments(plain)).toEqual([])
    expect(readCheckpoint(withSeams)?.groups).toEqual([])
    expect(fsyncs).toEqual([])
    expect(gate.stages).toEqual([])
    expect(writes).toEqual([])
    expect(seen).toEqual([1, 2, 3, 4, 5, 1, 2, 3])
    expect(subject.getPosition()).toEqual(position(2, 3))
    expect(subject.findGroup('anything')).toBeNull()
    expect(subject.releaseGroup('anything')).toBe(false)
    await expect(subject.awaitDurable()).resolves.toEqual({
      kind: 'durable',
      position: position(2, 3)
    })
    expect(new HostDeltaStore({ dataDir: withSeams, now }).getPosition()).toEqual(position(2, 3))
  })
})
