/**
 * The file system behind a thread's durability barrier: open a path, sync it,
 * close it, all on the thread pool. There is no synchronous call here, so a
 * barrier cannot sync on the thread that raises it.
 *
 * A limited number of syncs run at once, across every thread, and the rest
 * wait their turn in the order they were asked for. Each one holds a pool
 * thread for as long as the drive takes, and on macOS every sync flushes the
 * whole drive cache, so running many together buys little and starves other
 * file work of pool threads.
 *
 * A request for a path whose sync is still waiting to start joins that sync:
 * it will begin after both writes, so it covers both. A sync that has started
 * is never joined, because it may have begun before the later write.
 */
import * as nodeFs from 'node:fs'

import type { ThreadDurabilityPort, ThreadDurabilitySyncOutcome } from './ThreadDurabilityDebt'

/** How many syncs run at once unless the caller says otherwise. */
export const THREAD_DURABILITY_SYNCS_IN_FLIGHT = 2

/** A directory sync that fails with one of these is not offered by the file system. */
const DIRECTORY_SYNC_NOT_OFFERED = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS'])

/** The file calls the port makes. All of them hand their work to the thread pool. */
export interface ThreadDurabilityDebtFsCalls {
  readonly constants: { readonly O_RDONLY: number; readonly O_RDWR: number }
  open(
    path: string,
    flags: number,
    callback: (error: NodeJS.ErrnoException | null, fd: number) => void
  ): void
  fsync(fd: number, callback: (error: NodeJS.ErrnoException | null) => void): void
  close(fd: number, callback: (error: NodeJS.ErrnoException | null) => void): void
}

export interface ThreadDurabilityDebtFsOptions {
  /** Defaults to {@link THREAD_DURABILITY_SYNCS_IN_FLIGHT}. */
  maxInFlight?: number
  platform?: NodeJS.Platform
  /** Fault-injection seam; production calls `node:fs`. */
  fs?: ThreadDurabilityDebtFsCalls
}

export interface ThreadDurabilityDebtFsSnapshot {
  /** Syncs handed to the file system so far. */
  started: number
  inFlight: number
  /** Syncs waiting their turn. */
  queued: number
  /** Requests that joined a sync of the same path that had not started. */
  joined: number
  peakInFlight: number
}

export interface ThreadDurabilityDebtFs extends ThreadDurabilityPort {
  snapshot(): ThreadDurabilityDebtFsSnapshot
}

interface Waiter {
  resolve(outcome: ThreadDurabilitySyncOutcome): void
  reject(error: unknown): void
}

interface Task {
  key: string
  directory: boolean
  path: string
  waiters: Waiter[]
}

/**
 * What settles a request without a sync, and what fails it:
 * - nothing at the path when it is opened (`ENOENT`) settles it as `missing`;
 * - a directory on Windows, where a directory cannot be synced, and a
 *   directory whose file system does not offer the sync (`EINVAL`, `ENOTSUP`,
 *   `ENOSYS` from the sync itself) settle as `synced`: the platform has
 *   nothing more to give;
 * - every other failure to open, sync or close rejects the request.
 */
export function createThreadDurabilityDebtFs(
  options: ThreadDurabilityDebtFsOptions = {}
): ThreadDurabilityDebtFs {
  const fs: ThreadDurabilityDebtFsCalls = options.fs ?? nodeFs
  const windows = (options.platform ?? process.platform) === 'win32'
  const maxInFlight = options.maxInFlight ?? THREAD_DURABILITY_SYNCS_IN_FLIGHT
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) {
    throw new RangeError('Thread durability port: maxInFlight must be a whole number of at least 1')
  }

  const waiting = new Map<string, Task>()
  const queue: Task[] = []
  let queueHead = 0
  let inFlight = 0
  let started = 0
  let joined = 0
  let peakInFlight = 0

  const finish = (
    task: Task,
    error: NodeJS.ErrnoException | null,
    outcome: ThreadDurabilitySyncOutcome
  ): void => {
    inFlight -= 1
    for (const waiter of task.waiters) {
      if (error) waiter.reject(error)
      else waiter.resolve(outcome)
    }
    pump()
  }

  const start = (task: Task): void => {
    // Windows will not flush a file through a handle that cannot write to it.
    const flags = windows && !task.directory ? fs.constants.O_RDWR : fs.constants.O_RDONLY
    fs.open(task.path, flags, (openError, fd) => {
      if (openError) {
        finish(task, openError.code === 'ENOENT' ? null : openError, 'missing')
        return
      }
      fs.fsync(fd, (syncError) => {
        const notOffered =
          task.directory && !!syncError && DIRECTORY_SYNC_NOT_OFFERED.has(syncError.code ?? '')
        fs.close(fd, (closeError) => {
          finish(task, notOffered ? closeError : (syncError ?? closeError), 'synced')
        })
      })
    })
  }

  function pump(): void {
    while (inFlight < maxInFlight && queueHead < queue.length) {
      const task = queue[queueHead]
      queueHead += 1
      if (queueHead === queue.length) {
        queue.length = 0
        queueHead = 0
      }
      // From here a later request for this path needs a sync of its own.
      waiting.delete(task.key)
      inFlight += 1
      started += 1
      if (inFlight > peakInFlight) peakInFlight = inFlight
      start(task)
    }
  }

  const request = (directory: boolean, path: string): Promise<ThreadDurabilitySyncOutcome> => {
    if (directory && windows) return Promise.resolve('synced')
    return new Promise((resolve, reject) => {
      const key = `${directory ? 'd' : 'f'}${path}`
      let task = waiting.get(key)
      if (task) {
        joined += 1
      } else {
        task = { key, directory, path, waiters: [] }
        waiting.set(key, task)
        queue.push(task)
      }
      task.waiters.push({ resolve, reject })
      pump()
    })
  }

  return {
    syncFile: (path) => request(false, path),
    syncDirectory: (path) => request(true, path),
    snapshot: () => ({
      started,
      inFlight,
      queued: queue.length - queueHead,
      joined,
      peakInFlight
    })
  }
}
