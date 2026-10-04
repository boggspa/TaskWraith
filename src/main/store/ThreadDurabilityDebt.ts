/**
 * What a thread owes the disk, and the barrier that pays it.
 *
 * A writer that does not sync after it writes notes the debt here instead: a
 * file whose bytes are not yet on the disk, or a directory that gained or lost
 * a name. Noting is one insertion into that thread's own collection. Nothing
 * is registered across threads, no descriptor is held, and nothing is synced
 * until a barrier is raised for the thread.
 *
 * `barrier(chatId)` pays what the thread owed when it was raised: the files
 * first, then the directories, since a name must not be made durable before
 * the bytes it names. It resolves when all of it is synced. If a sync fails it
 * rejects, and what failed, with every directory it had not reached, is owed
 * again for the next barrier.
 *
 * One barrier runs for a thread at a time. A barrier raised while one is
 * running joins it when nothing has been noted since that one began; otherwise
 * it joins the single barrier that follows, which starts when the running one
 * ends and pays whatever is owed then, including what the running one failed
 * to sync. What is noted while a barrier runs is never taken by that barrier:
 * a sync already asked for may have begun before the later write.
 *
 * Threads do not wait for each other here. A barrier hands all its files to
 * the port at once, and how many syncs run together is the port's decision.
 *
 * The module has no file system and no clock of its own and starts no timer.
 * It also has no way to sync on the thread that calls it: the port has only
 * asynchronous calls.
 *
 * Memory: for each thread that owes something or has a barrier running, one
 * entry per distinct path noted since that thread's last barrier began. A
 * thread with nothing owed and no barrier running has no state at all. There
 * is no cap: a thread that writes many different files and is never given a
 * barrier holds one entry for each of them.
 */

export const THREAD_DURABILITY_OWNERS = [
  'journal',
  'run-events',
  'detail',
  'catalogue',
  'directory'
] as const

export type ThreadDurabilityOwner = (typeof THREAD_DURABILITY_OWNERS)[number]
export type ThreadDurabilityFileOwner = Exclude<ThreadDurabilityOwner, 'directory'>

/** One thing a write left owing. */
export type ThreadDurabilityDebtNote =
  /** A file whose bytes were written and not synced. */
  | { file: string; owner: ThreadDurabilityFileOwner }
  /** A directory in which a name was created, renamed or removed. */
  | { directory: string }

export type NoteThreadDurabilityDebt = (chatId: string, debt: ThreadDurabilityDebtNote) => void

/** `missing` is a path with nothing at it any more: there is nothing left to sync. */
export type ThreadDurabilitySyncOutcome = 'synced' | 'missing'

/**
 * How one path is synced. Both calls are asynchronous and reject for any
 * failure other than the path being gone.
 */
export interface ThreadDurabilityPort {
  syncFile(path: string): Promise<ThreadDurabilitySyncOutcome>
  syncDirectory(path: string): Promise<ThreadDurabilitySyncOutcome>
}

export interface ThreadDurabilityOwnerCounters {
  /** Calls to `note`, repeats of one path included. */
  noted: number
  synced: number
  /** Syncs that found the path gone, which settles the debt. */
  missing: number
  failed: number
}

export interface ThreadDurabilityDebtSnapshot {
  owners: Record<ThreadDurabilityOwner, ThreadDurabilityOwnerCounters>
  barriers: {
    /** Calls to `barrier`. */
    raised: number
    /** Raised for a thread that owed nothing and had no barrier running. */
    idle: number
    /** Raised while one was running or queued, and joined to it. */
    shared: number
    /** Barriers that went to the port. */
    rounds: number
    /** Of those, the ones in which a sync failed. */
    failed: number
    /** From each call to `barrier` to its settling, summed and at its longest. */
    waitMsTotal: number
    longestWaitMs: number
  }
  /** Threads holding state right now, and what they owe that no barrier has taken yet. */
  owed: { threads: number; files: number; directories: number }
  /** Always zero: see the note on the port at the top of this file. */
  syncsOnCallingThread: 0
}

export interface ThreadDurabilityDebt {
  note: NoteThreadDurabilityDebt
  /** Resolves when everything the thread owed at this call is synced. */
  barrier(chatId: string): Promise<void>
  /** Drop what a thread owes without syncing it: the thread is being erased. */
  forget(chatId: string): void
  snapshot(): ThreadDurabilityDebtSnapshot
}

export interface ThreadDurabilityDebtOptions {
  port: ThreadDurabilityPort
  /** Milliseconds, read only to time barriers. */
  now?: () => number
}

interface ThreadState {
  files: Map<string, ThreadDurabilityFileOwner>
  directories: Set<string>
  /** The barrier paying what was owed when it began. */
  running: Promise<void> | null
  /** The one barrier that follows it, for whoever needs more than it took. */
  next: Promise<void> | null
}

export function createThreadDurabilityDebt(
  options: ThreadDurabilityDebtOptions
): ThreadDurabilityDebt {
  const { port } = options
  const now = options.now ?? Date.now
  const threads = new Map<string, ThreadState>()
  const owners = Object.fromEntries(
    THREAD_DURABILITY_OWNERS.map((owner) => [owner, { noted: 0, synced: 0, missing: 0, failed: 0 }])
  ) as Record<ThreadDurabilityOwner, ThreadDurabilityOwnerCounters>
  const barriers = {
    raised: 0,
    idle: 0,
    shared: 0,
    rounds: 0,
    failed: 0,
    waitMsTotal: 0,
    longestWaitMs: 0
  }

  const owesNothing = (state: ThreadState): boolean =>
    state.files.size === 0 && state.directories.size === 0

  const note: NoteThreadDurabilityDebt = (chatId, debt) => {
    let state = threads.get(chatId)
    if (!state) {
      state = { files: new Map(), directories: new Set(), running: null, next: null }
      threads.set(chatId, state)
    }
    if ('file' in debt) {
      owners[debt.owner].noted += 1
      state.files.set(debt.file, debt.owner)
    } else {
      owners.directory.noted += 1
      state.directories.add(debt.directory)
    }
  }

  /** Ask the port for every path at once; a port that throws has failed that sync. */
  const syncAll = (
    paths: Iterable<string>,
    sync: (path: string) => Promise<ThreadDurabilitySyncOutcome>
  ): Promise<PromiseSettledResult<ThreadDurabilitySyncOutcome>[]> =>
    Promise.allSettled(
      [...paths].map((path) => {
        try {
          return sync(path)
        } catch (error) {
          return Promise.reject(error)
        }
      })
    )

  const pay = async (
    chatId: string,
    state: ThreadState,
    files: Map<string, ThreadDurabilityFileOwner>,
    directories: Set<string>
  ): Promise<void> => {
    const failures: unknown[] = []
    const unpaidFiles = new Map<string, ThreadDurabilityFileOwner>()
    const fileOutcomes = await syncAll(files.keys(), (path) => port.syncFile(path))
    let index = 0
    for (const [path, owner] of files) {
      const outcome = fileOutcomes[index]
      index += 1
      if (outcome.status === 'fulfilled') {
        owners[owner][outcome.value === 'missing' ? 'missing' : 'synced'] += 1
      } else {
        owners[owner].failed += 1
        unpaidFiles.set(path, owner)
        failures.push(outcome.reason)
      }
    }

    let unpaidDirectories = directories
    if (failures.length === 0) {
      unpaidDirectories = new Set()
      const outcomes = await syncAll(directories, (path) => port.syncDirectory(path))
      index = 0
      for (const path of directories) {
        const outcome = outcomes[index]
        index += 1
        if (outcome.status === 'fulfilled') {
          owners.directory[outcome.value === 'missing' ? 'missing' : 'synced'] += 1
        } else {
          owners.directory.failed += 1
          unpaidDirectories.add(path)
          failures.push(outcome.reason)
        }
      }
    }

    state.running = null
    // A thread forgotten meanwhile has had its debt dropped, this part included.
    if (threads.get(chatId) === state) {
      for (const [path, owner] of unpaidFiles) state.files.set(path, owner)
      for (const path of unpaidDirectories) state.directories.add(path)
      if (owesNothing(state)) threads.delete(chatId)
    }
    if (failures.length > 0) {
      barriers.failed += 1
      throw failures[0]
    }
  }

  /** Take what the thread owes now and start paying it. */
  const run = (chatId: string, state: ThreadState): Promise<void> => {
    const { files, directories } = state
    state.files = new Map()
    state.directories = new Set()
    barriers.rounds += 1
    state.running = pay(chatId, state, files, directories)
    return state.running
  }

  const follow = (chatId: string, state: ThreadState): Promise<void> => {
    state.next = null
    // Forgotten while it waited: what it was queued to pay has been dropped.
    if (threads.get(chatId) !== state) return Promise.resolve()
    // A barrier raised in the moment since the last one ended is already
    // paying everything this one was queued for.
    if (state.running) return state.running
    return run(chatId, state)
  }

  const settled = (chatId: string): Promise<void> => {
    const state = threads.get(chatId)
    if (!state) {
      barriers.idle += 1
      return Promise.resolve()
    }
    if (!state.running) return run(chatId, state)
    if (owesNothing(state)) {
      barriers.shared += 1
      return state.running
    }
    if (state.next) {
      barriers.shared += 1
      return state.next
    }
    const afterRunning = (): Promise<void> => follow(chatId, state)
    state.next = state.running.then(afterRunning, afterRunning)
    return state.next
  }

  const barrier = (chatId: string): Promise<void> => {
    barriers.raised += 1
    const raisedAt = now()
    const promise = settled(chatId)
    const timed = (): void => {
      const waited = now() - raisedAt
      barriers.waitMsTotal += waited
      if (waited > barriers.longestWaitMs) barriers.longestWaitMs = waited
    }
    promise.then(timed, timed)
    return promise
  }

  const forget = (chatId: string): void => {
    threads.delete(chatId)
  }

  const snapshot = (): ThreadDurabilityDebtSnapshot => {
    let files = 0
    let directories = 0
    for (const state of threads.values()) {
      files += state.files.size
      directories += state.directories.size
    }
    return {
      owners: Object.fromEntries(
        THREAD_DURABILITY_OWNERS.map((owner) => [owner, { ...owners[owner] }])
      ) as Record<ThreadDurabilityOwner, ThreadDurabilityOwnerCounters>,
      barriers: { ...barriers },
      owed: { threads: threads.size, files, directories },
      syncsOnCallingThread: 0
    }
  }

  return { note, barrier, forget, snapshot }
}
