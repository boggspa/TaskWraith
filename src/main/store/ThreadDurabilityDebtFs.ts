/**
 * The file system behind a thread's durability barrier: open a path, sync it,
 * close it, all on the thread pool. There is no synchronous call here, so a
 * barrier cannot sync on the thread that raises it.
 *
 * A limited number of syncs run at once, across every thread. Each one holds a
 * pool thread for as long as the drive takes, and costs about a whole flush of
 * the drive whenever anything on the volume was written since the last one,
 * as something always is while agents write: measured on this machine with
 * another process writing, 4 to 5 ms a sync even for a file with nothing new
 * in it, so 7 files took 33 ms one at a time, 20 ms two at a time and 14 ms
 * seven at a time, and 60 files 291, 157, 89 and 84 ms at 1, 2, 8 and 60 at a
 * time. (With nothing else writing, a sync after a write costs one flush and
 * a sync of a clean file next to nothing, which is why 30b89abca measured a
 * barrier at one flush whatever its size.) So a barrier costs a sync per path,
 * running more at once buys little past a few, and two at once leaves pool
 * threads for other file work.
 *
 * The rest wait their turn: urgent ones, asked for by a barrier the user is
 * sitting in, ahead of the others, and each kind in the order it was asked
 * for. While other work waits, at most THREAD_DURABILITY_URGENT_RUN urgent
 * syncs start in a row before one of the others does. While an urgency is
 * open (`urgent()`), a free place starts only an urgent sync, within that
 * same bound, so that an urgent barrier's directories, asked for when its
 * files are done, do not find the places taken by syncs that started in
 * between. Urgencies come at the rate a person acts, and each ends when its
 * barrier settles.
 *
 * A request for a path whose sync is still waiting to start joins that sync:
 * it will begin after both writes, so it covers both. An urgent request moves
 * the sync it joins ahead, and so does an urgency's `raise`. A sync that has
 * started is never joined, because it may have begun before the later write.
 */
import * as nodeFs from 'node:fs'

import type {
  ThreadDurabilityPort,
  ThreadDurabilitySyncOptions,
  ThreadDurabilitySyncOutcome,
  ThreadDurabilityUrgency
} from './ThreadDurabilityDebt'

/** How many syncs run at once unless the caller says otherwise. */
export const THREAD_DURABILITY_SYNCS_IN_FLIGHT = 2

/** While syncs that are not urgent wait, at most this many urgent ones start in a row. */
export const THREAD_DURABILITY_URGENT_RUN = 64

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
  /** Of the syncs waiting, the urgent ones and the rest. */
  queuedUrgent: number
  queuedNormal: number
  /** Of the syncs started, the urgent ones. */
  startedUrgent: number
  /** Waiting syncs moved ahead by an urgent request or an urgency's `raise`. */
  promoted: number
  /** Syncs that were not urgent, started by the bound on urgent ones in a row. */
  fairStarts: number
  /** Urgencies open now. */
  urgencies: number
}

export interface ThreadDurabilityDebtFs extends ThreadDurabilityPort {
  urgent(): ThreadDurabilityUrgency
  ahead(urgent: boolean): number
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
  urgent: boolean
  started: boolean
}

/** Tasks in the order they were queued; a task that has left its place is passed over. */
class TaskQueue {
  private tasks: Task[] = []
  private head = 0

  push(task: Task): void {
    this.tasks.push(task)
  }

  /** The first task still waiting here that `belongs` keeps. */
  next(belongs: (task: Task) => boolean): Task | undefined {
    while (this.head < this.tasks.length) {
      const task = this.tasks[this.head]
      this.head += 1
      if (this.head === this.tasks.length) {
        this.tasks = []
        this.head = 0
      }
      if (!task.started && belongs(task)) return task
    }
    return undefined
  }
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
  const urgentQueue = new TaskQueue()
  const normalQueue = new TaskQueue()
  let queuedUrgent = 0
  let queuedNormal = 0
  let inFlight = 0
  let started = 0
  let startedUrgent = 0
  let joined = 0
  let promoted = 0
  let fairStarts = 0
  let peakInFlight = 0
  let urgencies = 0
  /** Urgent syncs started since one that was not, while one that was not waited. */
  let urgentRun = 0

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

  /** The next sync to start, if a place may take one now. */
  const pick = (): Task | undefined => {
    const othersWait = queuedNormal > 0
    const othersDue = othersWait && urgentRun >= THREAD_DURABILITY_URGENT_RUN
    if (queuedUrgent > 0 && !othersDue) {
      urgentRun = othersWait ? urgentRun + 1 : 0
      return urgentQueue.next(() => true)
    }
    if (othersWait && (othersDue || (queuedUrgent === 0 && urgencies === 0))) {
      if (othersDue) fairStarts += 1
      urgentRun = 0
      return normalQueue.next((task) => !task.urgent)
    }
    return undefined
  }

  function pump(): void {
    while (inFlight < maxInFlight) {
      const task = pick()
      if (!task) return
      if (task.urgent) {
        queuedUrgent -= 1
        startedUrgent += 1
      } else {
        queuedNormal -= 1
      }
      task.started = true
      // From here a later request for this path needs a sync of its own.
      waiting.delete(task.key)
      inFlight += 1
      started += 1
      if (inFlight > peakInFlight) peakInFlight = inFlight
      start(task)
    }
  }

  /** Move a waiting sync ahead of every one that is not urgent. */
  const promote = (task: Task): void => {
    if (task.urgent) return
    task.urgent = true
    queuedNormal -= 1
    queuedUrgent += 1
    promoted += 1
    urgentQueue.push(task)
  }

  const request = (
    directory: boolean,
    path: string,
    options?: ThreadDurabilitySyncOptions
  ): Promise<ThreadDurabilitySyncOutcome> => {
    if (directory && windows) return Promise.resolve('synced')
    const urgent = options?.urgent === true
    return new Promise((resolve, reject) => {
      const key = `${directory ? 'd' : 'f'}${path}`
      let task = waiting.get(key)
      if (task) {
        joined += 1
        if (urgent) promote(task)
      } else {
        task = { key, directory, path, waiters: [], urgent, started: false }
        waiting.set(key, task)
        if (urgent) {
          queuedUrgent += 1
          urgentQueue.push(task)
        } else {
          queuedNormal += 1
          normalQueue.push(task)
        }
      }
      task.waiters.push({ resolve, reject })
      pump()
    })
  }

  const urgent = (): ThreadDurabilityUrgency => {
    urgencies += 1
    let open = true
    return {
      raise: (files, directories) => {
        for (const path of files) {
          const task = waiting.get(`f${path}`)
          if (task) promote(task)
        }
        for (const path of directories) {
          const task = waiting.get(`d${path}`)
          if (task) promote(task)
        }
        pump()
      },
      end: () => {
        if (!open) return
        open = false
        urgencies -= 1
        pump()
      }
    }
  }

  return {
    syncFile: (path, options) => request(false, path, options),
    syncDirectory: (path, options) => request(true, path, options),
    urgent,
    ahead: (urgentRequest) => inFlight + queuedUrgent + (urgentRequest ? 0 : queuedNormal),
    snapshot: () => ({
      started,
      inFlight,
      queued: queuedUrgent + queuedNormal,
      joined,
      peakInFlight,
      queuedUrgent,
      queuedNormal,
      startedUrgent,
      promoted,
      fairStarts,
      urgencies
    })
  }
}
