/**
 * One sync of one path, open to close, made on a worker thread.
 *
 * The durability port syncs a path with three calls on the thread pool: open,
 * sync, close. Each call's callback runs on the main thread, so a sync made
 * through the port waits for the main thread's event loop three times. With
 * the main thread busy (a save, a publication, a run's output) each of those
 * waits is a turn of the loop, and measured under agents at work the three of
 * them cost more than the sync itself. Here the worker makes the three calls
 * on its own idle loop and answers once, so a sync waits for the main thread
 * once.
 *
 * What is synced, and how, does not change: the worker makes the same
 * `node:fs` calls the port makes, with the same flags, and hands back each
 * call's error for the port to judge exactly as before. Nothing is cached:
 * every sync opens the path afresh, after the request, so it covers every
 * write made before it.
 *
 * A worker that fails or exits fails the syncs it still owed (the port
 * rejects them, so their barriers fail and their debt is owed again) and is
 * not started again: every later sync is made the old way, through the
 * port's three calls on the main thread. A sync is never reported done that
 * was not made.
 *
 * The worker is started with the first sync and never keeps the process
 * alive.
 */
import * as nodeFs from 'node:fs'
import { Worker } from 'node:worker_threads'

/** The errors of one sync's three calls; null where a call succeeded or was not made. */
export interface ThreadDurabilitySyncPathResult {
  readonly openError: NodeJS.ErrnoException | null
  readonly syncError: NodeJS.ErrnoException | null
  readonly closeError: NodeJS.ErrnoException | null
}

/** Open `path` with `flags`, sync it and close it; `callback` gets each call's error. */
export type ThreadDurabilitySyncPath = (
  path: string,
  flags: number,
  callback: (result: ThreadDurabilitySyncPathResult) => void
) => void

export interface ThreadDurabilitySyncWorkerSnapshot {
  /** Syncs the worker made and answered. */
  workerSyncs: number
  /** Syncs made the old way after the worker was lost, or before it could start. */
  inlineSyncs: number
  /** Syncs the worker owed when it was lost, failed. */
  lostSyncs: number
  /** Whether the worker was lost (failed, exited or could not start). */
  lost: boolean
}

/** The part of a worker this module uses; a seam for tests. */
export interface ThreadDurabilitySyncWorkerHandle {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  unref(): void
  terminate(): Promise<number>
}

export interface ThreadDurabilitySyncWorkerOptions {
  createWorker?: () => ThreadDurabilitySyncWorkerHandle
  /** The calls made once the worker is lost; `node:fs` by default. */
  fs?: Pick<typeof nodeFs, 'open' | 'fsync' | 'close'>
}

export interface ThreadDurabilitySyncWorker {
  readonly syncPath: ThreadDurabilitySyncPath
  snapshot(): ThreadDurabilitySyncWorkerSnapshot
  /** Stops the worker; later syncs are made the old way. */
  dispose(): Promise<void>
}

/** CommonJS, run with `eval`: it needs no file of its own in the bundle. */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
const fs = require('node:fs')
const plain = (error) => (error ? { code: error.code ?? null, message: String(error.message) } : null)
parentPort.on('message', ({ id, path, flags }) => {
  fs.open(path, flags, (openError, fd) => {
    if (openError) return parentPort.postMessage({ id, open: plain(openError), sync: null, close: null })
    fs.fsync(fd, (syncError) => {
      fs.close(fd, (closeError) => {
        parentPort.postMessage({ id, open: null, sync: plain(syncError), close: plain(closeError) })
      })
    })
  })
})
`

interface PlainError {
  readonly code: string | null
  readonly message: string
}

function errnoOf(plain: PlainError | null | undefined): NodeJS.ErrnoException | null {
  if (!plain) return null
  const error: NodeJS.ErrnoException = new Error(plain.message)
  if (plain.code) error.code = plain.code
  return error
}

export function createThreadDurabilitySyncWorker(
  options: ThreadDurabilitySyncWorkerOptions = {}
): ThreadDurabilitySyncWorker {
  const fs = options.fs ?? nodeFs
  const createWorker =
    options.createWorker ??
    (() => new Worker(WORKER_SOURCE, { eval: true }) as ThreadDurabilitySyncWorkerHandle)
  const pending = new Map<number, (result: ThreadDurabilitySyncPathResult) => void>()
  let worker: ThreadDurabilitySyncWorkerHandle | null = null
  let lost = false
  let nextId = 0
  let workerSyncs = 0
  let inlineSyncs = 0
  let lostSyncs = 0

  const lose = (reason: string): void => {
    if (lost) return
    lost = true
    worker = null
    const owed = [...pending.values()]
    pending.clear()
    lostSyncs += owed.length
    const error: NodeJS.ErrnoException = new Error(`Thread durability sync worker ${reason}`)
    for (const callback of owed) callback({ openError: null, syncError: error, closeError: null })
  }

  const started = (): ThreadDurabilitySyncWorkerHandle | null => {
    if (lost) return null
    if (worker) return worker
    try {
      const created = createWorker()
      created.on('message', (message) => {
        const answer = message as {
          id: number
          open: PlainError | null
          sync: PlainError | null
          close: PlainError | null
        }
        const callback = pending.get(answer.id)
        if (!callback) return
        pending.delete(answer.id)
        workerSyncs += 1
        callback({
          openError: errnoOf(answer.open),
          syncError: errnoOf(answer.sync),
          closeError: errnoOf(answer.close)
        })
      })
      created.on('error', () => lose('failed'))
      created.on('exit', () => lose('exited'))
      created.unref()
      worker = created
      return created
    } catch {
      lose('could not start')
      return null
    }
  }

  const inline: ThreadDurabilitySyncPath = (path, flags, callback) => {
    inlineSyncs += 1
    fs.open(path, flags, (openError, fd) => {
      if (openError) return callback({ openError, syncError: null, closeError: null })
      fs.fsync(fd, (syncError) => {
        fs.close(fd, (closeError) => callback({ openError: null, syncError, closeError }))
      })
    })
  }

  return {
    syncPath(path, flags, callback) {
      const handle = started()
      if (!handle) return inline(path, flags, callback)
      const id = (nextId += 1)
      pending.set(id, callback)
      try {
        handle.postMessage({ id, path, flags })
      } catch {
        pending.delete(id)
        lose('refused a message')
        inline(path, flags, callback)
      }
    },
    snapshot: () => ({ workerSyncs, inlineSyncs, lostSyncs, lost }),
    async dispose() {
      const handle = worker
      lose('was stopped')
      await handle?.terminate()
    }
  }
}
