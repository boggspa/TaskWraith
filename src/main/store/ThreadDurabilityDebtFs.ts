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
 * The rest wait their turn, in three classes, each in the order it was asked
 * for: urgent ones, asked for by a barrier the user is sitting in, then normal
 * ones, then background ones, which nobody waits on. While normal syncs wait,
 * at most THREAD_DURABILITY_URGENT_RUN urgent syncs start in a row before one
 * of them does. While an urgency is open (`urgent()`), a free place starts
 * only an urgent sync, within that same bound, so that an urgent barrier's
 * directories, asked for when its files are done, do not find the places
 * taken by syncs that started in between. Urgencies come at the rate a person
 * acts, and each ends when its barrier settles.
 *
 * A background sync starts in a free place only when no urgent or normal sync
 * waits and no urgency is open, so work nobody waits on never delays a sync
 * somebody does. So that a steady flow of other syncs cannot hold it back for
 * good, while background syncs wait at most THREAD_DURABILITY_FOREGROUND_RUN
 * others start in a row before one of them does. Background syncs that are
 * waiting are never counted as ahead of a new request (`ahead`).
 *
 * An urgent sync that would find every place taken by syncs that are not
 * urgent starts at once instead, in one more place kept for urgent syncs and
 * never used by anything else: a sync paying seconds of streamed bytes can
 * hold a place for most of a second, and the user waits for the urgent one.
 * When an urgent sync already holds a place, or the kept place is taken, an
 * urgent request waits as any does. The kept place takes no place from
 * anyone, so a start in it counts toward neither bound above.
 *
 * A request for a path whose sync is still waiting to start joins that sync:
 * it will begin after both writes, so it covers both. A request of a sooner
 * class moves the sync it joins up to that class, and an urgency's `raise`
 * moves the syncs it names up to urgent. A sync that has started is never
 * joined, because it may have begun before the later write.
 *
 * Each class is timed twice: each request from the moment it is made to the
 * start of the sync that serves it, at the class it asked for, and each sync
 * from its start to its settling, failed or found gone included, at the class
 * it started in. Each time is summed, kept at its longest, and counted in one
 * of five bands: under 10 ms, 10 to 50, 50 to 200, 200 to 1,000, and 1,000 or
 * more. A directory on Windows is not synced and not timed.
 */
import * as nodeFs from 'node:fs'
import { performance } from 'node:perf_hooks'

import type {
  ThreadDurabilityPort,
  ThreadDurabilitySyncOptions,
  ThreadDurabilitySyncOutcome,
  ThreadDurabilityUrgency
} from './ThreadDurabilityDebt'
import type { ThreadDurabilitySyncPath } from './ThreadDurabilitySyncWorker'

/** How many syncs run at once unless the caller says otherwise. */
export const THREAD_DURABILITY_SYNCS_IN_FLIGHT = 2

/** While normal syncs wait, at most this many urgent ones start in a row. */
export const THREAD_DURABILITY_URGENT_RUN = 64

/** While background syncs wait, at most this many urgent or normal ones start in a row. */
export const THREAD_DURABILITY_FOREGROUND_RUN = 64

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
  /**
   * Makes one sync's open, sync and close somewhere else (a worker thread) and
   * answers once with each call's error, judged here exactly as the three
   * calls' own. Without it the three calls are made through `fs`.
   */
  syncPath?: ThreadDurabilitySyncPath
  /** Milliseconds, read only to time syncs. Defaults to `performance.now`. */
  now?: () => number
  /**
   * Keep one place beyond `maxInFlight` for an urgent sync that finds every
   * other place taken by syncs that are not urgent. Defaults to true; tests of
   * the order within the shared places turn it off.
   */
  keepUrgentPlace?: boolean
}

/** Times of one kind, in milliseconds: summed, the longest, and how many fell in each band. */
export interface ThreadDurabilitySyncTiming {
  count: number
  totalMs: number
  longestMs: number
  under10Ms: number
  from10To50Ms: number
  from50To200Ms: number
  from200To1000Ms: number
  from1000Ms: number
}

/** How long the syncs of one class waited, and how long they took. */
export interface ThreadDurabilitySyncClassTiming {
  /** Each request, at the class it asked for, to the start of the sync that serves it. */
  requestToStart: ThreadDurabilitySyncTiming
  /** Each sync, at the class it started in, from its start to its settling. */
  startToSettle: ThreadDurabilitySyncTiming
}

export interface ThreadDurabilityDebtFsSnapshot {
  /** Syncs handed to the file system so far. */
  started: number
  inFlight: number
  /** Syncs waiting their turn, of every class. */
  queued: number
  /** Requests that joined a sync of the same path that had not started. */
  joined: number
  peakInFlight: number
  /** Of the syncs waiting, the urgent ones and the normal ones. */
  queuedUrgent: number
  queuedNormal: number
  /** Of the syncs started, the urgent ones. */
  startedUrgent: number
  /** Waiting syncs moved up to a sooner class by a request that joined them, or by an urgency's `raise`. */
  promoted: number
  /** Normal syncs started by the bound on urgent ones in a row. */
  fairStarts: number
  /** Urgencies open now. */
  urgencies: number
  /** Of the syncs waiting, the background ones. */
  queuedBackground: number
  /** Of the syncs started, the background ones. */
  startedBackground: number
  /** Background syncs started by the bound on other syncs in a row. */
  backgroundFairStarts: number
  timing: Record<SyncClass, ThreadDurabilitySyncClassTiming>
  /** Urgent syncs started in the place kept for them, every other place being taken by syncs that are not urgent. */
  extraUrgentStarts: number
}

export interface ThreadDurabilityDebtFs extends ThreadDurabilityPort {
  urgent(): ThreadDurabilityUrgency
  ahead(urgent: boolean): number
  snapshot(): ThreadDurabilityDebtFsSnapshot
}

/** How soon a waiting sync starts, soonest first. */
type SyncClass = 'urgent' | 'normal' | 'background'

interface Waiter {
  resolve(outcome: ThreadDurabilitySyncOutcome): void
  reject(error: unknown): void
  /** The class this request asked for, and when. */
  syncClass: SyncClass
  requestedAt: number
}

const SOONER: Record<SyncClass, number> = { urgent: 0, normal: 1, background: 2 }

interface Task {
  key: string
  directory: boolean
  path: string
  waiters: Waiter[]
  syncClass: SyncClass
  started: boolean
  startedAt: number
  /** It holds the place kept for urgent syncs. */
  extra: boolean
}

const noTime = (): ThreadDurabilitySyncTiming => ({
  count: 0,
  totalMs: 0,
  longestMs: 0,
  under10Ms: 0,
  from10To50Ms: 0,
  from50To200Ms: 0,
  from200To1000Ms: 0,
  from1000Ms: 0
})

/** Count one time of `ms` into `timing`. */
function addTime(timing: ThreadDurabilitySyncTiming, ms: number): void {
  timing.count += 1
  timing.totalMs += ms
  if (ms > timing.longestMs) timing.longestMs = ms
  if (ms < 10) timing.under10Ms += 1
  else if (ms < 50) timing.from10To50Ms += 1
  else if (ms < 200) timing.from50To200Ms += 1
  else if (ms < 1_000) timing.from200To1000Ms += 1
  else timing.from1000Ms += 1
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
  const syncPath = options.syncPath
  const now = options.now ?? (() => performance.now())
  const windows = (options.platform ?? process.platform) === 'win32'
  const maxInFlight = options.maxInFlight ?? THREAD_DURABILITY_SYNCS_IN_FLIGHT
  const keepUrgentPlace = options.keepUrgentPlace ?? true
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) {
    throw new RangeError('Thread durability port: maxInFlight must be a whole number of at least 1')
  }

  const waiting = new Map<string, Task>()
  const urgentQueue = new TaskQueue()
  const normalQueue = new TaskQueue()
  const backgroundQueue = new TaskQueue()
  let queuedUrgent = 0
  let queuedNormal = 0
  let queuedBackground = 0
  /** Syncs running: in the places every class shares, and in the one kept for urgent syncs. */
  let inFlight = 0
  let sharedInFlight = 0
  /** Of the syncs in the shared places, the urgent ones. */
  let urgentShared = 0
  let extraInFlight = false
  let extraUrgentStarts = 0
  let started = 0
  let startedUrgent = 0
  let startedBackground = 0
  let joined = 0
  let promoted = 0
  let fairStarts = 0
  let backgroundFairStarts = 0
  let peakInFlight = 0
  let urgencies = 0
  /** Urgent syncs started since a normal one, while a normal one waited. */
  let urgentRun = 0
  /** Urgent and normal syncs started since a background one, while a background one waited. */
  let foregroundRun = 0
  const timing: Record<SyncClass, ThreadDurabilitySyncClassTiming> = {
    urgent: { requestToStart: noTime(), startToSettle: noTime() },
    normal: { requestToStart: noTime(), startToSettle: noTime() },
    background: { requestToStart: noTime(), startToSettle: noTime() }
  }

  /** Count a sync of this class as waiting, or as waiting no longer. */
  const countQueued = (syncClass: SyncClass, change: 1 | -1): void => {
    if (syncClass === 'urgent') queuedUrgent += change
    else if (syncClass === 'normal') queuedNormal += change
    else queuedBackground += change
  }

  /** Put a sync that has not started at the back of its class. */
  const enqueue = (task: Task): void => {
    countQueued(task.syncClass, 1)
    if (task.syncClass === 'urgent') urgentQueue.push(task)
    else if (task.syncClass === 'normal') normalQueue.push(task)
    else backgroundQueue.push(task)
  }

  const finish = (
    task: Task,
    error: NodeJS.ErrnoException | null,
    outcome: ThreadDurabilitySyncOutcome
  ): void => {
    inFlight -= 1
    if (task.extra) extraInFlight = false
    else {
      sharedInFlight -= 1
      if (task.syncClass === 'urgent') urgentShared -= 1
    }
    addTime(timing[task.syncClass].startToSettle, now() - task.startedAt)
    for (const waiter of task.waiters) {
      if (error) waiter.reject(error)
      else waiter.resolve(outcome)
    }
    pump()
  }

  const start = (task: Task): void => {
    // Windows will not flush a file through a handle that cannot write to it.
    const flags = windows && !task.directory ? fs.constants.O_RDWR : fs.constants.O_RDONLY
    if (syncPath) {
      syncPath(task.path, flags, ({ openError, syncError, closeError }) => {
        if (openError) {
          finish(task, openError.code === 'ENOENT' ? null : openError, 'missing')
          return
        }
        const notOffered =
          task.directory && !!syncError && DIRECTORY_SYNC_NOT_OFFERED.has(syncError.code ?? '')
        finish(task, notOffered ? closeError : (syncError ?? closeError), 'synced')
      })
      return
    }
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
    const backgroundWaits = queuedBackground > 0
    if (backgroundWaits && foregroundRun >= THREAD_DURABILITY_FOREGROUND_RUN) {
      backgroundFairStarts += 1
      foregroundRun = 0
      return backgroundQueue.next((task) => task.syncClass === 'background')
    }
    const othersWait = queuedNormal > 0
    const othersDue = othersWait && urgentRun >= THREAD_DURABILITY_URGENT_RUN
    let task: Task | undefined
    if (queuedUrgent > 0 && !othersDue) {
      urgentRun = othersWait ? urgentRun + 1 : 0
      task = urgentQueue.next(() => true)
    } else if (othersWait && (othersDue || (queuedUrgent === 0 && urgencies === 0))) {
      if (othersDue) fairStarts += 1
      urgentRun = 0
      task = normalQueue.next((each) => each.syncClass === 'normal')
    } else if (backgroundWaits && queuedUrgent === 0 && queuedNormal === 0 && urgencies === 0) {
      foregroundRun = 0
      return backgroundQueue.next((each) => each.syncClass === 'background')
    }
    if (task) foregroundRun = backgroundWaits ? foregroundRun + 1 : 0
    return task
  }

  /** Hand a waiting sync to the file system, in a shared place or in the one kept for urgent syncs. */
  const launch = (task: Task, extra: boolean): void => {
    countQueued(task.syncClass, -1)
    if (task.syncClass === 'urgent') startedUrgent += 1
    else if (task.syncClass === 'background') startedBackground += 1
    task.started = true
    task.extra = extra
    task.startedAt = now()
    for (const waiter of task.waiters) {
      addTime(timing[waiter.syncClass].requestToStart, task.startedAt - waiter.requestedAt)
    }
    // From here a later request for this path needs a sync of its own.
    waiting.delete(task.key)
    if (extra) extraInFlight = true
    else {
      sharedInFlight += 1
      if (task.syncClass === 'urgent') urgentShared += 1
    }
    inFlight += 1
    started += 1
    if (inFlight > peakInFlight) peakInFlight = inFlight
    start(task)
  }

  function pump(): void {
    while (sharedInFlight < maxInFlight) {
      const task = pick()
      if (!task) break
      launch(task, false)
    }
    // Every shared place is taken, and by nothing urgent: an urgent sync
    // waiting starts in the place kept for it.
    if (
      keepUrgentPlace &&
      !extraInFlight &&
      queuedUrgent > 0 &&
      sharedInFlight >= maxInFlight &&
      urgentShared === 0
    ) {
      const task = urgentQueue.next(() => true)
      if (task) {
        extraUrgentStarts += 1
        launch(task, true)
      }
    }
  }

  /**
   * Move a waiting sync up to a sooner class, at the back of it. One already
   * in that class or a sooner one stays where it is.
   */
  const promote = (task: Task, syncClass: SyncClass): void => {
    if (SOONER[task.syncClass] <= SOONER[syncClass]) return
    countQueued(task.syncClass, -1)
    task.syncClass = syncClass
    enqueue(task)
    promoted += 1
  }

  const request = (
    directory: boolean,
    path: string,
    options?: ThreadDurabilitySyncOptions
  ): Promise<ThreadDurabilitySyncOutcome> => {
    if (directory && windows) return Promise.resolve('synced')
    const syncClass: SyncClass =
      options?.urgent === true ? 'urgent' : options?.background === true ? 'background' : 'normal'
    return new Promise((resolve, reject) => {
      const key = `${directory ? 'd' : 'f'}${path}`
      let task = waiting.get(key)
      if (task) {
        joined += 1
        promote(task, syncClass)
      } else {
        task = {
          key,
          directory,
          path,
          waiters: [],
          syncClass,
          started: false,
          startedAt: 0,
          extra: false
        }
        waiting.set(key, task)
        enqueue(task)
      }
      task.waiters.push({ resolve, reject, syncClass, requestedAt: now() })
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
          if (task) promote(task, 'urgent')
        }
        for (const path of directories) {
          const task = waiting.get(`d${path}`)
          if (task) promote(task, 'urgent')
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
    // Background syncs that are waiting start behind any request this asks about.
    ahead: (urgentRequest) => inFlight + queuedUrgent + (urgentRequest ? 0 : queuedNormal),
    snapshot: () => ({
      started,
      inFlight,
      queued: queuedUrgent + queuedNormal + queuedBackground,
      joined,
      peakInFlight,
      queuedUrgent,
      queuedNormal,
      startedUrgent,
      promoted,
      fairStarts,
      urgencies,
      queuedBackground,
      startedBackground,
      backgroundFairStarts,
      timing: {
        urgent: copyTiming(timing.urgent),
        normal: copyTiming(timing.normal),
        background: copyTiming(timing.background)
      },
      extraUrgentStarts
    })
  }
}

const copyTiming = (timing: ThreadDurabilitySyncClassTiming): ThreadDurabilitySyncClassTiming => ({
  requestToStart: { ...timing.requestToStart },
  startToSettle: { ...timing.startToSettle }
})
