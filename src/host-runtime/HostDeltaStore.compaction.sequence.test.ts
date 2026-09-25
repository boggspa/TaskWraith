import {
  fsyncSync,
  mkdtempSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOST_DELTA_CHECKPOINT_FILENAME,
  HOST_DELTA_SEALED_SEGMENT_PATTERN,
  HostDeltaStore,
  type HostDeltaCompactionStage,
  type HostDeltaStoreOptions
} from './HostDeltaStore'

// M4 slice 7c amendments (design §15.6): a checkpoint records the sealed
// segments it covers (`sealedThrough`), and sealed sequences never go back.
// Each case stops a background compaction at a stage, as a crash would, and
// reopens a fresh store on the same directory.

const paths: string[] = []
function directory() {
  const value = mkdtempSync(join(tmpdir(), 'host-delta-sealed-sequence-'))
  paths.push(value)
  return value
}
afterEach(() => {
  for (const value of paths.splice(0)) rmSync(value, { recursive: true, force: true })
})

const now = () => '2026-09-25T15:00:00.000Z'
function open(dataDir: string, extra: Partial<HostDeltaStoreOptions> = {}) {
  return new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000, ...extra })
}
function stopAt(stage: HostDeltaCompactionStage) {
  return (reached: HostDeltaCompactionStage) => {
    if (reached === stage) throw new Error(`stopped at ${stage}`)
  }
}
function sealed(dataDir: string): string[] {
  return readdirSync(dataDir).filter((name) => HOST_DELTA_SEALED_SEGMENT_PATTERN.test(name))
}

describe('HostDeltaStore sealed segment coverage (M4 slice 7c)', () => {
  it('never brings back a released empty group from a sealed segment the checkpoint covers', async () => {
    const dataDir = directory()
    const store = open(dataDir, { onCompactionStage: stopAt('checkpoint-renamed') })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'seed' })
    // An empty group sits at the head, which is exactly where the checkpoint
    // cursor will be: the cursor alone cannot say whether it is covered.
    expect(store.appendGroup({ commandId: 'released', effects: [] }).kind).toBe('appended')
    expect(store.releaseGroup('released')).toBe(true)

    const result = await store.compactInBackground()
    expect(result.kind).toBe('failed')
    // The checkpoint landed; the sealed segment was never unlinked.
    expect(sealed(dataDir)).toHaveLength(1)

    const reopened = open(dataDir)
    expect(reopened.findGroup('released')).toBeNull()
    expect(reopened.getPosition()).toEqual({ generation: 1, cursor: 1 })
  })

  it('numbers a new sealed segment above every sequence a checkpoint ever covered', async () => {
    const dataDir = directory()
    const first = open(dataDir)
    first.appendGroup({
      commandId: 'a',
      effects: [{ kind: 'upsert', family: 'thread', entityId: 'a' }]
    })
    await first.awaitDurable()
    expect(await first.compactInBackground()).toMatchObject({ kind: 'compacted' })
    // An inline checkpoint unlinks every segment; numbering must not restart.
    first.compact()
    expect(sealed(dataDir)).toEqual([])

    const second = open(dataDir, { onCompactionStage: stopAt('rotated') })
    const group = second.appendGroup({
      commandId: 'b',
      effects: [{ kind: 'upsert', family: 'thread', entityId: 'b' }]
    })
    expect(group.kind).toBe('appended')
    await second.awaitDurable()
    // Rotated, then stopped before any checkpoint: only the segment holds b.
    expect(await second.compactInBackground()).toMatchObject({ kind: 'failed' })
    const [segment] = sealed(dataDir)
    expect(segment).toBeDefined()
    expect(HOST_DELTA_SEALED_SEGMENT_PATTERN.exec(segment!)![1]).not.toBe('00000000000000000001')

    const reopened = open(dataDir)
    expect(reopened.findGroup('b')).toMatchObject({ commandId: 'b', count: 1, durable: true })
    expect(reopened.getPosition()).toEqual({ generation: 1, cursor: 2 })
    expect(reopened.getByCursor(2)?.envelope.entityId).toBe('b')
  })

  it('makes the checkpoint rename durable before it reports the checkpoint renamed', async () => {
    if (process.platform === 'win32') return
    const dataDir = directory()
    const fsyncs: string[] = []
    let directoryFsyncsAtRename = -1
    const store = open(dataDir, {
      groupFsync: async (path) => {
        fsyncs.push(path)
        const descriptor = openSync(path, 'r')
        try {
          fsyncSync(descriptor)
        } finally {
          closeSync(descriptor)
        }
      },
      onCompactionStage: (stage) => {
        if (stage === 'checkpoint-written') fsyncs.length = 0
        if (stage === 'checkpoint-renamed') {
          directoryFsyncsAtRename = fsyncs.filter((path) => path === dataDir).length
        }
      }
    })
    store.appendGroup({
      commandId: 'a',
      effects: [{ kind: 'upsert', family: 'thread', entityId: 'a' }]
    })
    await store.awaitDurable()
    expect(await store.compactInBackground()).toMatchObject({ kind: 'compacted' })
    // The rename (and the rotation's rename before it) is durable only once
    // the directory is fsynced.
    expect(directoryFsyncsAtRename).toBe(1)
  })

  it('drops a checkpoint anchor that ends past the checkpoint cursor', async () => {
    const dataDir = directory()
    const store = open(dataDir)
    store.appendGroup({
      commandId: 'a',
      effects: [{ kind: 'upsert', family: 'thread', entityId: 'a' }]
    })
    await store.awaitDurable()
    expect(await store.compactInBackground()).toMatchObject({ kind: 'compacted' })
    const checkpointPath = join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME)
    const doc = JSON.parse(readFileSync(checkpointPath, 'utf8')) as {
      cursor: number
      groups: Array<{ commandId: string; end: number }>
    }
    expect(doc.groups).toHaveLength(1)
    doc.groups.push({ ...doc.groups[0]!, commandId: 'beyond', end: doc.cursor + 1 })
    writeFileSync(checkpointPath, `${JSON.stringify(doc)}\n`)

    const reopened = open(dataDir)
    expect(reopened.findGroup('a')).not.toBeNull()
    expect(reopened.findGroup('beyond')).toBeNull()
    expect(reopened.getRecoveryState().recoveryState).toBe('degraded-checkpoint')
  })
})
