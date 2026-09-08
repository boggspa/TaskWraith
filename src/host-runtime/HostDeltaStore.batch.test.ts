import {
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HostDeltaStore,
  HOST_DELTA_CHECKPOINT_FILENAME,
  HOST_DELTA_JOURNAL_FILENAME,
  type HostDeltaAppendInput
} from './HostDeltaStore'
const paths: string[] = []
function directory() {
  const value = mkdtempSync(join(tmpdir(), 'host-batch-independent-'))
  paths.push(value)
  return value
}
afterEach(() => {
  for (const value of paths.splice(0)) rmSync(value, { recursive: true, force: true })
})
const effects = (count = 3): HostDeltaAppendInput[] =>
  Array.from({ length: count }, (_, index) => ({
    kind: 'upsert',
    family: 'thread',
    entityId: `thread-${index}`,
    payload: { title: `Title ${index}` }
  }))
const now = () => '2026-09-08T20:00:00.000Z'

describe('HostDeltaStore independent batch durability review', () => {
  it('exposes neither memory nor notifications before the one journal fsync', () => {
    const dataDir = directory()
    let fsyncs = 0
    const seen: number[] = []
    const store: HostDeltaStore = new HostDeltaStore({
      dataDir,
      now,
      compactAfterRecords: 10000,
      batchFsync: (fd) => {
        fsyncs++
        expect(store.getPosition()).toEqual({ generation: 1, cursor: 0 })
        expect(store.getByCursor(1)).toBeNull()
        expect(seen).toEqual([])
        fsyncSync(fd)
      }
    })
    store.subscribe((event) => seen.push(event.position.cursor))
    const result = store.appendBatch(effects())
    expect(result.kind).toBe('appended')
    expect(fsyncs).toBe(1)
    expect(seen).toEqual([1, 2, 3])
    expect(store.getPosition()).toEqual({ generation: 1, cursor: 3 })
    expect(new HostDeltaStore({ dataDir, now }).getPosition()).toEqual(store.getPosition())
  })

  it('rejects an invalid middle effect without writing a prefix', () => {
    const dataDir = directory()
    let writes = 0
    const store = new HostDeltaStore({
      dataDir,
      now,
      batchWrite: (fd, bytes, offset, length) => {
        writes++
        return writeSync(fd, bytes, offset, length, null)
      }
    })
    const input = effects()
    input[1] = { ...input[1], payload: { secret: 'must-not-persist' } }
    expect(store.appendBatch(input)).toMatchObject({
      kind: 'rejected',
      failedAtIndex: 1,
      position: { generation: 1, cursor: 0 }
    })
    expect(writes).toBe(0)
    expect(existsSync(join(dataDir, HOST_DELTA_JOURNAL_FILENAME))).toBe(false)
  })

  it('rolls a short write back to the exact old length before safely reusing the next cursor', () => {
    const dataDir = directory()
    let failing = false,
      writes = 0,
      rollbacks = 0
    const store = new HostDeltaStore({
      dataDir,
      now,
      compactAfterRecords: 10000,
      batchWrite: (fd, bytes, offset, length) => {
        if (failing && ++writes === 1)
          return writeSync(fd, bytes, offset, Math.min(17, length), null)
        if (failing) throw new Error('injected write failure')
        return writeSync(fd, bytes, offset, length, null)
      },
      batchTruncate: (fd, length) => {
        rollbacks++
        ftruncateSync(fd, length)
      }
    })
    store.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 'initial',
      payload: { title: 'Initial' }
    })
    const file = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
    const before = readFileSync(file)
    failing = true
    expect(store.appendBatch(effects())).toMatchObject({
      kind: 'write-failed',
      rollback: 'proven',
      position: { generation: 1, cursor: 1 }
    })
    expect(rollbacks).toBe(1)
    expect(readFileSync(file)).toEqual(before)
    expect(store.getPosition().cursor).toBe(1)
    failing = false
    expect(store.appendBatch(effects(1))).toMatchObject({
      kind: 'appended',
      position: { generation: 1, cursor: 2 }
    })
    expect(new HostDeltaStore({ dataDir, now }).getPosition().cursor).toBe(2)
  })

  it('does not clear an uncertain rollback poison through append, reset, compact or reopen', () => {
    const dataDir = directory()
    let failing = true
    const store = new HostDeltaStore({
      dataDir,
      now,
      batchFsync: (fd) => {
        if (failing) throw new Error('injected fsync failure')
        fsyncSync(fd)
      },
      batchTruncate: (fd, length) => {
        if (failing) throw new Error('injected rollback failure')
        ftruncateSync(fd, length)
      }
    })
    expect(store.appendBatch(effects())).toMatchObject({
      kind: 'write-failed',
      rollback: 'uncertain'
    })
    failing = false
    expect(() => store.appendBatch(effects(1))).toThrow(/blocked/)
    expect(() => store.append(effects(1)[0])).toThrow(/blocked/)
    expect(() => store.resetGeneration('unsafe recovery')).toThrow(/blocked/)
    expect(() => store.compact()).toThrow(/blocked/)
    try {
      store.reopen()
    } catch {
      /* Refusing reopen is also safe. */
    }
    expect(() => store.appendBatch(effects(1))).toThrow(/blocked/)
  })

  it('keeps a durable batch committed even if compaction and its logger fail', () => {
    const dataDir = directory()
    const seen: number[] = []
    const store = new HostDeltaStore({
      dataDir,
      now,
      compactAfterRecords: 1,
      log: () => {
        throw new Error('logger failed')
      }
    })
    // A directory at the checkpoint destination forces the real rename to fail.
    mkdirSync(join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME))
    store.subscribe((event) => seen.push(event.record.envelope.cursor))
    expect(store.appendBatch(effects())).toMatchObject({
      kind: 'appended',
      position: { generation: 1, cursor: 3 }
    })
    expect(seen).toEqual([1, 2, 3])
    expect(new HostDeltaStore({ dataDir, now }).getPosition().cursor).toBe(3)
  })

  it('preserves FIFO notifications when a listener appends during a committed batch', () => {
    const dataDir = directory()
    const seen: Array<[number, number]> = []
    const store = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
    store.subscribe((event) => {
      if (event.record.envelope.cursor === 1)
        store.append({
          kind: 'upsert',
          family: 'thread',
          entityId: 'nested',
          payload: { title: 'Nested' }
        })
    })
    store.subscribe((event) => seen.push([event.record.envelope.cursor, event.position.cursor]))
    const result = store.appendBatch(effects())
    expect(seen).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4]
    ])
    expect(result.position).toEqual({ generation: 1, cursor: 3 })
    expect(store.getPosition()).toEqual({ generation: 1, cursor: 4 })
    expect(new HostDeltaStore({ dataDir, now }).getPosition()).toEqual(store.getPosition())
  })
})
