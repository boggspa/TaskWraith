/**
 * The sync worker: real syncs on a real worker thread, the old three-call path
 * once the worker is lost, and the port judging the worker's single answer as
 * it judges its own three calls.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createThreadDurabilityDebtFs } from './ThreadDurabilityDebtFs'
import {
  createThreadDurabilitySyncWorker,
  type ThreadDurabilitySyncPath,
  type ThreadDurabilitySyncWorkerHandle
} from './ThreadDurabilitySyncWorker'

const PREFIX = 'thread-durability-sync-worker-'
const directories: string[] = []

function directory(): string {
  const made = mkdtempSync(path.join(tmpdir(), PREFIX))
  directories.push(made)
  return made
}

afterEach(() => {
  for (const made of directories.splice(0)) {
    if (path.dirname(made) !== tmpdir() || !path.basename(made).startsWith(PREFIX)) {
      throw new Error(`Refusing to remove ${made}: not a folder this file made`)
    }
    rmSync(made, { recursive: true, force: true })
  }
})

const syncOnce = (syncPath: ThreadDurabilitySyncPath, target: string, flags: number) =>
  new Promise<Parameters<Parameters<ThreadDurabilitySyncPath>[2]>[0]>((resolve) =>
    syncPath(target, flags, resolve)
  )

/** A worker handle the test drives by hand. */
function fakeWorker() {
  const listeners: Record<string, Array<(value: unknown) => void>> = {}
  const posted: Array<{ id: number; path: string; flags: number }> = []
  const handle: ThreadDurabilitySyncWorkerHandle = {
    postMessage: (message) => void posted.push(message as (typeof posted)[number]),
    on: ((event: string, listener: (value: unknown) => void) => {
      ;(listeners[event] ??= []).push(listener)
      return handle
    }) as ThreadDurabilitySyncWorkerHandle['on'],
    unref: vi.fn(),
    terminate: vi.fn(async () => 0)
  }
  const emit = (event: string, value: unknown) => listeners[event]?.forEach((each) => each(value))
  return { handle, posted, emit }
}

describe('the thread durability sync worker', () => {
  it('syncs a real file and a real directory on a worker thread, answering once each', async () => {
    const dir = directory()
    const file = path.join(dir, 'a.jsonl')
    writeFileSync(file, 'line\n')
    const worker = createThreadDurabilitySyncWorker()
    try {
      expect(await syncOnce(worker.syncPath, file, fs.constants.O_RDONLY)).toEqual({
        openError: null,
        syncError: null,
        closeError: null
      })
      expect(await syncOnce(worker.syncPath, dir, fs.constants.O_RDONLY)).toEqual({
        openError: null,
        syncError: null,
        closeError: null
      })
      const missing = await syncOnce(
        worker.syncPath,
        path.join(dir, 'gone.jsonl'),
        fs.constants.O_RDONLY
      )
      expect(missing.openError?.code).toBe('ENOENT')
      expect(worker.snapshot()).toMatchObject({ workerSyncs: 3, inlineSyncs: 0, lost: false })
    } finally {
      await worker.dispose()
    }
  })

  it('fails the syncs a lost worker owed, and makes later ones the old way', async () => {
    const dir = directory()
    const file = path.join(dir, 'a.jsonl')
    writeFileSync(file, 'line\n')
    const fake = fakeWorker()
    const worker = createThreadDurabilitySyncWorker({ createWorker: () => fake.handle })
    const owed = syncOnce(worker.syncPath, file, fs.constants.O_RDONLY)
    expect(fake.posted).toHaveLength(1)
    fake.emit('error', new Error('worker died'))
    const lost = await owed
    // Never reported done: the sync it owed fails, so its debt is owed again.
    expect(lost.syncError?.message).toMatch(/sync worker failed/)
    expect(await syncOnce(worker.syncPath, file, fs.constants.O_RDONLY)).toEqual({
      openError: null,
      syncError: null,
      closeError: null
    })
    expect(fake.posted).toHaveLength(1)
    expect(worker.snapshot()).toMatchObject({ lost: true, lostSyncs: 1, inlineSyncs: 1 })
  })

  it('ignores an answer for a sync it does not owe', async () => {
    const fake = fakeWorker()
    const worker = createThreadDurabilitySyncWorker({ createWorker: () => fake.handle })
    const callback = vi.fn()
    worker.syncPath('/nowhere', 0, callback)
    fake.emit('message', { id: 99, open: null, sync: null, close: null })
    expect(callback).not.toHaveBeenCalled()
    fake.emit('message', { id: fake.posted[0].id, open: null, sync: null, close: null })
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('hands back the fields of an errno error the worker met, not only its code', async () => {
    const missing = path.join(directory(), 'gone.jsonl')
    const worker = createThreadDurabilitySyncWorker()
    try {
      const { openError } = await syncOnce(worker.syncPath, missing, fs.constants.O_RDONLY)
      expect(openError).toMatchObject({ code: 'ENOENT', syscall: 'open', path: missing })
      expect(typeof openError?.errno).toBe('number')
      expect(worker.snapshot()).toMatchObject({ workerSyncs: 1, lost: false })
    } finally {
      await worker.dispose()
    }
  })

  it('stops a worker it could not finish starting, and syncs the old way', async () => {
    const fake = fakeWorker()
    const handle = {
      ...fake.handle,
      unref: () => {
        throw new Error('worker already gone')
      }
    }
    const worker = createThreadDurabilitySyncWorker({ createWorker: () => handle })
    const file = path.join(directory(), 'a.jsonl')
    writeFileSync(file, 'line\n')
    expect(await syncOnce(worker.syncPath, file, fs.constants.O_RDONLY)).toEqual({
      openError: null,
      syncError: null,
      closeError: null
    })
    expect(fake.handle.terminate).toHaveBeenCalledTimes(1)
    expect(fake.posted).toHaveLength(0)
    expect(worker.snapshot()).toMatchObject({ lost: true, inlineSyncs: 1, workerSyncs: 0 })
    // Its error listener was attached before anything could fail: an error now is heard.
    expect(() => fake.emit('error', new Error('late'))).not.toThrow()
  })
})

describe('the durability port through a sync path', () => {
  const answer =
    (result: Partial<Parameters<Parameters<ThreadDurabilitySyncPath>[2]>[0]>) =>
    (): ThreadDurabilitySyncPath =>
    (_path, _flags, callback) =>
      queueMicrotask(() =>
        callback({ openError: null, syncError: null, closeError: null, ...result })
      )
  const errno = (code: string) => Object.assign(new Error(code), { code })

  it('makes no file call of its own when given a sync path', async () => {
    const calls = { open: vi.fn(), fsync: vi.fn(), close: vi.fn() }
    const port = createThreadDurabilityDebtFs({
      fs: { constants: { O_RDONLY: 0, O_RDWR: 2 }, ...calls } as never,
      syncPath: answer({})()
    })
    await expect(port.syncFile('/a')).resolves.toBe('synced')
    expect(calls.open).not.toHaveBeenCalled()
    expect(port.snapshot().started).toBe(1)
  })

  it('judges the single answer exactly as the three calls', async () => {
    const port = (result: Parameters<typeof answer>[0]) =>
      createThreadDurabilityDebtFs({ platform: 'darwin', syncPath: answer(result)() })
    await expect(port({ openError: errno('ENOENT') }).syncFile('/a')).resolves.toBe('missing')
    await expect(port({ openError: errno('EACCES') }).syncFile('/a')).rejects.toThrow('EACCES')
    await expect(port({ syncError: errno('EIO') }).syncFile('/a')).rejects.toThrow('EIO')
    await expect(port({ closeError: errno('EBADF') }).syncFile('/a')).rejects.toThrow('EBADF')
    // A directory whose file system does not offer the sync has nothing more to give.
    await expect(port({ syncError: errno('EINVAL') }).syncDirectory('/d')).resolves.toBe('synced')
    await expect(port({ syncError: errno('EINVAL') }).syncFile('/a')).rejects.toThrow('EINVAL')
  })
})
