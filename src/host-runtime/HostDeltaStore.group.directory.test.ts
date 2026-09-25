import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Every synchronous fsync the store issues, as the path it opened. The store
// imports `node:fs` by name, so the seam is a module mock that records and
// then calls through.
const synced = vi.hoisted(() => ({
  paths: [] as string[],
  byDescriptor: new Map<number, string>()
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args)
      synced.byDescriptor.set(descriptor, String(args[0]))
      return descriptor
    },
    fsyncSync: (descriptor: number) => {
      synced.paths.push(synced.byDescriptor.get(descriptor) ?? `fd:${descriptor}`)
      actual.fsyncSync(descriptor)
    }
  }
})

import { HOST_DELTA_JOURNAL_FILENAME, HostDeltaStore } from './HostDeltaStore'

const now = () => '2026-09-25T09:00:00.000Z'
let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'host-delta-group-directory-'))
  synced.paths.length = 0
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('HostDeltaStore group journal name durability (M4 slice 7a)', () => {
  it('fsyncs the directory when a legacy append settles a group that created the journal', async () => {
    if (process.platform === 'win32') return
    // Keep the async flush from running first: the legacy append settles the group.
    const store = new HostDeltaStore({ dataDir, now, groupFsync: () => new Promise(() => {}) })
    const group = store.appendGroup({
      commandId: 'cmd',
      effects: [{ kind: 'upsert', family: 'thread', entityId: 'thread-0' }]
    })
    expect(group.kind).toBe('appended')
    expect(statSync(join(dataDir, HOST_DELTA_JOURNAL_FILENAME)).size).toBeGreaterThan(0)

    synced.paths.length = 0
    store.append({ kind: 'upsert', family: 'thread', entityId: 'legacy' })

    // The legacy append did not create the journal, but its fsync settled a
    // group that did: that group's name must be durable too.
    expect(synced.paths).toEqual([join(dataDir, HOST_DELTA_JOURNAL_FILENAME), dataDir])
    expect(store.findGroup('cmd')?.durable).toBe(true)
  })

  it('fsyncs the directory for the reset that follows a failed flush of a group-created journal', async () => {
    if (process.platform === 'win32') return
    const store = new HostDeltaStore({
      dataDir,
      now,
      groupFsync: async () => {
        throw new Error('injected group fsync failure')
      }
    })
    store.appendGroup({
      commandId: 'cmd',
      effects: [{ kind: 'upsert', family: 'thread', entityId: 'thread-0' }]
    })
    synced.paths.length = 0

    const result = await store.awaitDurable()

    // The reset line lands in the journal the failed group created, so the
    // reset's own fsync has to make that journal's name durable.
    expect(result.kind).toBe('reset')
    expect(synced.paths).toEqual([join(dataDir, HOST_DELTA_JOURNAL_FILENAME), dataDir])
  })

  it('fsyncs the directory for a legacy append that settles a group while its own flush is still running', async () => {
    if (process.platform === 'win32') return
    // Review fix (design §18): the directory debt was cleared when the async
    // flush started, so a legacy fsync in that window skipped the directory
    // and acknowledged the group's records anyway.
    let started = false
    const store = new HostDeltaStore({
      dataDir,
      now,
      groupFsync: () => {
        started = true
        return new Promise(() => {})
      }
    })
    store.appendGroup({
      commandId: 'cmd',
      effects: [{ kind: 'upsert', family: 'thread', entityId: 'thread-0' }]
    })
    void store.awaitDurable()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(started).toBe(true)

    synced.paths.length = 0
    store.append({ kind: 'upsert', family: 'thread', entityId: 'legacy' })

    expect(synced.paths).toEqual([join(dataDir, HOST_DELTA_JOURNAL_FILENAME), dataDir])
    expect(store.findGroup('cmd')?.durable).toBe(true)
  })

  it('leaves the directory alone for a legacy append to a journal that was already durable', () => {
    const store = new HostDeltaStore({ dataDir, now })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'first' })
    synced.paths.length = 0
    store.append({ kind: 'upsert', family: 'thread', entityId: 'second' })
    expect(synced.paths).toEqual([join(dataDir, HOST_DELTA_JOURNAL_FILENAME)])
  })
})
