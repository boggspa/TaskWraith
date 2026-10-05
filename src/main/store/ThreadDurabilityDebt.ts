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
 * A note may name the run it was written for. `barrier(chatId, { run })` pays
 * the thread's own debt, noted without a run, and that run's, and leaves what
 * other runs owe to their own barriers. A barrier without a run pays all of
 * it, so a run that never gets a barrier of its own is paid by the thread's
 * next one. A path noted by several runs, or by a run and by the thread, is
 * synced once, by the first barrier that takes it, for all of them.
 *
 * `barrier(chatId, { threadOnly: true })` pays the thread's own debt alone,
 * and leaves what every run owes to that run's barrier or to one without a
 * run. It cannot name a run. A wait the user sits in needs no more: the
 * message, the decision or the destructive batch it waits for, and the record
 * a dispatch reads, are journal lines. It joins a running barrier when nothing
 * of the thread's own has been noted since that one began, and otherwise the
 * barrier queued behind it, which pays the thread's own debt whatever runs it
 * pays for besides.
 *
 * `barrier(chatId, { urgent: true })` is for a wait the user is sitting in.
 * It asks the port for its syncs as urgent, which the port starts ahead of
 * every sync that is not urgent and has not started, and it keeps the port's
 * urgency open until it settles. When it has to wait for a barrier already
 * running or queued on its thread, it raises that one: a queued barrier asks
 * for its syncs as urgent when it starts, and a running one asks for the rest
 * of its syncs as urgent and has the port move the ones still waiting ahead.
 *
 * An urgent barrier of the thread's own debt alone never waits for another
 * barrier. Raised while one runs or is queued on its thread, it syncs, itself
 * and urgently, the thread's own paths that are owed and those the running
 * barrier took that no sync has covered since, files first, and settles when
 * those are synced. Each is synced by a sync that starts after the request,
 * so after the path's last note: the port joins a sync that has not started
 * and starts a new one beside a sync in flight. It takes nothing, so what it
 * syncs stays owed to the thread's barriers, which sync it again; a user acts
 * rarely enough for that to cost nothing that matters. With no barrier
 * running or queued it pays the thread's own debt as any barrier does.
 *
 * One barrier runs for a thread at a time. A barrier raised while one is
 * running joins it when nothing it would pay has been noted since that one
 * began; otherwise it joins the single barrier that follows, which starts when
 * the running one ends and pays whatever is owed then for every caller that
 * joined it, including what the running one failed to sync. What is noted
 * while a barrier runs is never taken by that barrier: a sync already asked
 * for may have begun before the later write.
 *
 * One thing noted while a barrier runs does change what it pays. Files are
 * synced by name, and a sync that was asked for may reach the name only after
 * the file has been renamed, and find nothing there, or a newer file. So a
 * writer that renames a file with unsynced bytes says where it came from, and
 * a barrier that was asked for the old name and is still syncing files syncs
 * the new name too before it settles, whichever run the file belongs to.
 *
 * Threads do not wait for each other here. A barrier hands all its files to
 * the port at once, and how many syncs run together, and in what order, is the
 * port's decision.
 *
 * `trickle(chatId)` syncs what a thread owes in the background, without a
 * barrier: every file it owes, at the port's background class, then every
 * directory noted before the round began, once each file sync of the round
 * has settled and none failed. A path is paid by a barrier's rule: when
 * nothing was noted for it after its sync was asked for, which is before the
 * sync began. One noted since, one a barrier took meanwhile and one whose
 * sync failed are left as they are: owed, or the barrier's to pay. The round
 * stands outside the thread's barriers: none waits for it or joins it, and a
 * barrier takes what it needs as it would anyway. When the round's sync of a
 * path it takes is still waiting in the port, the barrier's own request joins
 * it there and moves it up to the barrier's class; when that sync is in
 * flight, the barrier's starts beside it. At most one round runs for a
 * thread, and at most one trickle sync of a path waits or runs, whichever
 * thread asked for it. Nobody waits on a round, so it settles without its
 * failures, which are counted. When to trickle a thread is the caller's
 * decision (`ThreadDebtTracker`).
 *
 * The module has no file system and no clock of its own and starts no timer.
 * It also has no way to sync on the thread that calls it: the port has only
 * asynchronous calls.
 *
 * Memory: for each thread that owes something or has a barrier running or
 * queued, one entry per distinct path owed, one more for each run that noted
 * that path, and one set for each run that owes something. The trickle holds
 * one entry for each path a sync of it is waiting or in flight for. A barrier holds
 * the paths it took until it settles, and a queued one the runs it will pay
 * for. A thread with nothing owed and no barrier has no state at all, nor does
 * a run that owes nothing. There is no cap: a thread that writes many
 * different files and is never given a barrier holds an entry for each.
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

/**
 * One thing a write left owing. `run` is the run it was written for, when the
 * file or the name is that run's own: a barrier for that run pays it, and a
 * barrier for another run does not.
 */
export type ThreadDurabilityDebtNote =
  /**
   * A file whose bytes were written and not synced. `renamedFrom` is the name
   * those bytes were under until now, when the file has just been renamed.
   */
  | { file: string; owner: ThreadDurabilityFileOwner; renamedFrom?: string; run?: string }
  /** A directory in which a name was created, renamed or removed. */
  | { directory: string; run?: string }

export type NoteThreadDurabilityDebt = (chatId: string, debt: ThreadDurabilityDebtNote) => void

/** `missing` is a path with nothing at it any more: there is nothing left to sync. */
export type ThreadDurabilitySyncOutcome = 'synced' | 'missing'

/** How soon a sync has to run. */
export interface ThreadDurabilitySyncOptions {
  /** Start it ahead of every sync that is not urgent and has not started. */
  urgent?: boolean
  /** Nobody waits on it: start it behind every other sync. Ignored when `urgent` is set. */
  background?: boolean
}

/** Opened by an urgent barrier when it is raised, and ended when it settles. */
export interface ThreadDurabilityUrgency {
  /** Move the syncs of these paths that have not started ahead of every sync that is not urgent. */
  raise(files: Iterable<string>, directories: Iterable<string>): void
  end(): void
}

/**
 * How one path is synced. Both calls are asynchronous and reject for any
 * failure other than the path being gone. A port that keeps no queue of its
 * own may ignore `options`, and leave out the two optional calls.
 */
export interface ThreadDurabilityPort {
  syncFile(
    path: string,
    options?: ThreadDurabilitySyncOptions
  ): Promise<ThreadDurabilitySyncOutcome>
  syncDirectory(
    path: string,
    options?: ThreadDurabilitySyncOptions
  ): Promise<ThreadDurabilitySyncOutcome>
  /** Opens an urgency; see the port's own description of what it does while one is open. */
  urgent?(): ThreadDurabilityUrgency
  /** How many syncs are running, or would start before a sync asked for now as urgent or not. */
  ahead?(urgent: boolean): number
}

export type ThreadDurabilityBarrierOptions = {
  /** A wait the user is sitting in. */
  urgent?: boolean
} & (
  | {
      /** Pay only the thread's own debt and this run's. */
      run?: string
      threadOnly?: false
    }
  | {
      /** Pay only the thread's own debt: what was noted without a run. */
      threadOnly: true
      run?: undefined
    }
)

export interface ThreadDurabilityOwnerCounters {
  /** Calls to `note`, repeats of one path included. */
  noted: number
  synced: number
  /** Syncs that found the path gone, which settles the debt. */
  missing: number
  failed: number
}

export interface ThreadDurabilityWaitCounters {
  /** Barriers of this kind that have settled. */
  count: number
  /** From each call to `barrier` to its settling, summed and at its longest. */
  totalMs: number
  longestMs: number
  /** Syncs running or ahead of it in the port when each was raised, summed and at most. */
  aheadTotal: number
  aheadMost: number
  /** Of these, the barriers that joined a barrier running on their thread or queued behind one. */
  waitedBehind: number
  /**
   * The time each spent waiting for another barrier on its thread, before the
   * syncs that pay it began (all of its wait when it joined a running one),
   * summed and at its longest.
   */
  behindTotalMs: number
  behindLongestMs: number
  /** The time from the start of the syncs that pay each to its settling, summed and at its longest. */
  ownSyncsTotalMs: number
  ownSyncsLongestMs: number
}

export interface ThreadDurabilityTrickleCounters {
  /** Rounds begun. At most one runs for a thread at a time. */
  rounds: number
  /** Syncs asked of the port at its background class, at most one waiting or in flight for a path. */
  started: number
  /**
   * Of those, the ones that paid their path, synced or found gone, nothing
   * having been noted for it since they were asked for.
   */
  paid: number
  /** The ones that settled with their path noted again since: it stays owed. */
  notedSince: number
  /** The ones whose path a barrier took, or an erasure dropped, before they settled. */
  takenOver: number
  /** The ones that failed: their path stays owed. */
  failed: number
  /** Trickle syncs waiting or in flight now. */
  inFlight: number
}

export interface ThreadDurabilityDebtSnapshot {
  owners: Record<ThreadDurabilityOwner, ThreadDurabilityOwnerCounters>
  barriers: {
    /** Calls to `barrier`. */
    raised: number
    /** Raised when nothing it would pay was owed and no barrier was running. */
    idle: number
    /** Raised while one was running or queued, and joined to it. */
    shared: number
    /** Barriers that went to the port. */
    rounds: number
    /** Files a running barrier took on because they were renamed under it. */
    renamedUnderway: number
    /** Of those, the ones in which a sync failed. */
    failed: number
    /** From each call to `barrier` to its settling, summed and at its longest. */
    waitMsTotal: number
    longestWaitMs: number
    /** Raised with a run. */
    scoped: number
    /** Raised for the thread's own debt alone. */
    threadOnly: number
    /** Raised as urgent. */
    urgent: number
    /**
     * Barriers running or queued that an urgent one raised, because it had to
     * wait for them. An urgent barrier of the thread's own debt alone never
     * waits for one, so only an urgent barrier of a run or of everything
     * raises one.
     */
    hastened: number
    /**
     * Urgent barriers of the thread's own debt alone raised while another
     * barrier ran or was queued on their thread, which synced the thread's own
     * paths beside it instead of waiting for it. Their syncs pay no debt and
     * are not counted by owner.
     */
    beside: number
    /** Of those, the ones in which a sync failed. The thread's debt is as it was. */
    besideFailed: number
    /**
     * Rounds begun for barriers of one or more runs, as a run's final record
     * raises, and the paths, files and directories, those rounds took:
     * summed, and the most one took.
     */
    runRounds: number
    runPathsTotal: number
    runPathsMost: number
  }
  /** The background syncs of what threads owe, outside their barriers (`trickle`). */
  trickle: ThreadDurabilityTrickleCounters
  /** Settled barriers the user sat in, and the rest. */
  waits: Record<'urgent' | 'normal', ThreadDurabilityWaitCounters>
  /** Threads holding state right now, and what they owe that no barrier has taken yet. */
  owed: { threads: number; files: number; directories: number }
  /** Runs that owe something no barrier has taken yet. */
  owingRuns: number
  /** Always zero: see the note on the port at the top of this file. */
  syncsOnCallingThread: 0
}

export interface ThreadDurabilityDebt {
  note: NoteThreadDurabilityDebt
  /**
   * Resolves when everything the thread owed at this call is synced: with a
   * run, the thread's own debt and that run's; with `threadOnly`, the
   * thread's own debt alone.
   */
  barrier(chatId: string, options?: ThreadDurabilityBarrierOptions): Promise<void>
  /** Drop what a thread owes without syncing it: the thread is being erased. */
  forget(chatId: string): void
  /**
   * Sync what the thread owes in the background, outside its barriers; see
   * the top of this file. Resolves when the round has settled, and never
   * rejects. A thread that owes nothing starts none, and one whose round still
   * runs is given that round.
   */
  trickle(chatId: string): Promise<void>
  snapshot(): ThreadDurabilityDebtSnapshot
}

export interface ThreadDurabilityDebtOptions {
  port: ThreadDurabilityPort
  /** Milliseconds, read only to time barriers. */
  now?: () => number
}

/** Who owes a path: the thread itself, the runs that noted it, or both. */
interface Owed {
  own: boolean
  runs: Set<string> | null
  /** When it was last noted, in notes: a sync asked for since covers it. */
  noted: number
}

interface OwedFile extends Owed {
  owner: ThreadDurabilityFileOwner
}

type Kind = 'files' | 'directories'

interface Paths {
  files: Set<string>
  directories: Set<string>
}

interface Debt {
  files: Map<string, OwedFile>
  directories: Map<string, Owed>
}

interface Running {
  promise: Promise<void>
  /** Asks for its syncs as urgent. */
  urgent: boolean
  /** The paths it has asked the port for that have not settled. */
  unsettled: Paths
  /**
   * The thread's own paths it took that no sync has covered since: what an
   * urgent barrier of the thread's own debt raised meanwhile syncs itself
   * rather than wait for this one.
   */
  ownUnsynced: Paths
  /**
   * Set while it is still syncing files: every name it has been asked for,
   * and the names it has yet to ask for because a file it was asked for was
   * renamed, with who owes each.
   */
  syncing: { asked: Set<string>; renamed: Map<string, OwedFile> } | null
}

interface Queued {
  promise: Promise<void>
  /** The runs it pays for besides the thread's own debt; null for everything. */
  runs: Set<string> | null
  urgent: boolean
  /** When it began to pay; null until then. */
  began: { at: number | null }
}

/** What a caller of `barrier` waits for, and where that wait begins to be its own syncs. */
interface Wait {
  promise: Promise<void>
  /** When the syncs that pay it began; null while, or if, it waits for another barrier. */
  ownFrom: { at: number | null }
  /** It joined a barrier running on its thread or queued behind one. */
  behind: boolean
}

interface ThreadState {
  owed: Debt
  /** The paths the thread owes itself. */
  own: Paths
  /** The paths each run owes. */
  runs: Map<string, Paths>
  /** The barrier paying what was owed when it began. */
  running: Running | null
  /** The one barrier that follows it, for whoever needs more than it took. */
  next: Queued | null
  /** The trickle's round, while one runs. */
  trickle: Promise<void> | null
}

const URGENT: ThreadDurabilitySyncOptions = { urgent: true }
const BACKGROUND: ThreadDurabilitySyncOptions = { background: true }

const noPaths = (): Paths => ({ files: new Set(), directories: new Set() })

const waitCounters = (): ThreadDurabilityWaitCounters => ({
  count: 0,
  totalMs: 0,
  longestMs: 0,
  aheadTotal: 0,
  aheadMost: 0,
  waitedBehind: 0,
  behindTotalMs: 0,
  behindLongestMs: 0,
  ownSyncsTotalMs: 0,
  ownSyncsLongestMs: 0
})

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
    renamedUnderway: 0,
    failed: 0,
    waitMsTotal: 0,
    longestWaitMs: 0,
    scoped: 0,
    threadOnly: 0,
    urgent: 0,
    hastened: 0,
    beside: 0,
    besideFailed: 0,
    runRounds: 0,
    runPathsTotal: 0,
    runPathsMost: 0
  }
  const waits = { urgent: waitCounters(), normal: waitCounters() }
  /** Counts every note, and every path owed again, so that a sync can tell what came after it was asked for. */
  let notes = 0
  /** The paths a trickle sync waits or is in flight for, across every thread. */
  const trickling: Record<Kind, Set<string>> = { files: new Set(), directories: new Set() }
  const trickled = { rounds: 0, started: 0, paid: 0, notedSince: 0, takenOver: 0, failed: 0 }

  const owesNothing = (state: ThreadState): boolean =>
    state.owed.files.size === 0 && state.owed.directories.size === 0

  /**
   * Whether anything a barrier paying for these runs would take is owed: the
   * thread's own debt and theirs. Null is every run; an empty set is the
   * thread's own debt alone.
   */
  const owesFor = (state: ThreadState, runs: ReadonlySet<string> | null): boolean => {
    if (runs === null) return !owesNothing(state)
    if (state.own.files.size > 0 || state.own.directories.size > 0) return true
    for (const run of runs) if (state.runs.has(run)) return true
    return false
  }

  /** Record that the thread, or a run, owes a path. */
  const owe = (state: ThreadState, kind: Kind, path: string, entry: Owed, run?: string): void => {
    if (run === undefined) {
      if (!entry.own) {
        entry.own = true
        state.own[kind].add(path)
      }
      return
    }
    entry.runs ??= new Set()
    if (entry.runs.has(run)) return
    entry.runs.add(run)
    let paths = state.runs.get(run)
    if (!paths) {
      paths = noPaths()
      state.runs.set(run, paths)
    }
    paths[kind].add(path)
  }

  /** Forget who owed a path a barrier has taken. */
  const disown = (state: ThreadState, kind: Kind, path: string, entry: Owed): void => {
    if (entry.own) state.own[kind].delete(path)
    for (const run of entry.runs ?? []) {
      const paths = state.runs.get(run)
      if (!paths) continue
      paths[kind].delete(path)
      if (paths.files.size === 0 && paths.directories.size === 0) state.runs.delete(run)
    }
  }

  const oweFile = (
    state: ThreadState,
    path: string,
    owner: ThreadDurabilityFileOwner,
    run?: string
  ): void => {
    let entry = state.owed.files.get(path)
    if (entry) entry.owner = owner
    else {
      entry = { owner, own: false, runs: null, noted: 0 }
      state.owed.files.set(path, entry)
    }
    entry.noted = ++notes
    owe(state, 'files', path, entry, run)
  }

  const oweDirectory = (state: ThreadState, path: string, run?: string): void => {
    let entry = state.owed.directories.get(path)
    if (!entry) {
      entry = { own: false, runs: null, noted: 0 }
      state.owed.directories.set(path, entry)
    }
    entry.noted = ++notes
    owe(state, 'directories', path, entry, run)
  }

  /** A path a barrier took and did not pay is owed again, by whoever owed it. */
  const oweAgain = (
    state: ThreadState,
    path: string,
    entry: Owed,
    owner?: ThreadDurabilityFileOwner
  ): void => {
    const again = (run?: string): void =>
      owner === undefined ? oweDirectory(state, path, run) : oweFile(state, path, owner, run)
    if (entry.own) again()
    for (const run of entry.runs ?? []) again(run)
  }

  const note: NoteThreadDurabilityDebt = (chatId, debt) => {
    let state = threads.get(chatId)
    if (!state) {
      state = {
        owed: { files: new Map(), directories: new Map() },
        own: noPaths(),
        runs: new Map(),
        running: null,
        next: null,
        trickle: null
      }
      threads.set(chatId, state)
    }
    if ('file' in debt) {
      owners[debt.owner].noted += 1
      oweFile(state, debt.file, debt.owner, debt.run)
      const syncing = state.running?.syncing
      if (debt.renamedFrom !== undefined && syncing?.asked.has(debt.renamedFrom)) {
        syncing.asked.add(debt.file)
        syncing.renamed.set(debt.file, {
          owner: debt.owner,
          own: debt.run === undefined,
          runs: debt.run === undefined ? null : new Set([debt.run]),
          noted: notes
        })
        barriers.renamedUnderway += 1
      }
    } else {
      owners.directory.noted += 1
      oweDirectory(state, debt.directory, debt.run)
    }
  }

  /** Take what a barrier paying for these runs pays: the thread's own debt and theirs, or, for null, all of it. */
  const take = (state: ThreadState, runs: ReadonlySet<string> | null): Debt => {
    if (runs === null) {
      const taken = state.owed
      state.owed = { files: new Map(), directories: new Map() }
      state.own = noPaths()
      state.runs = new Map()
      return taken
    }
    const taken: Debt = { files: new Map(), directories: new Map() }
    const sources = [state.own]
    for (const run of runs) {
      const paths = state.runs.get(run)
      if (paths) sources.push(paths)
    }
    for (const paths of sources) {
      for (const path of [...paths.files]) {
        const entry = state.owed.files.get(path)
        if (!entry) continue
        state.owed.files.delete(path)
        disown(state, 'files', path, entry)
        taken.files.set(path, entry)
      }
      for (const path of [...paths.directories]) {
        const entry = state.owed.directories.get(path)
        if (!entry) continue
        state.owed.directories.delete(path)
        disown(state, 'directories', path, entry)
        taken.directories.set(path, entry)
      }
    }
    return taken
  }

  /** Ask the port for every path at once; a port that throws has failed that sync. */
  const syncAll = (
    running: Running,
    kind: Kind,
    paths: readonly string[]
  ): Promise<PromiseSettledResult<ThreadDurabilitySyncOutcome>[]> =>
    Promise.allSettled(
      paths.map((path) => {
        let request: Promise<ThreadDurabilitySyncOutcome>
        try {
          // Asked as it stands at this moment: an urgent caller may raise it later.
          if (kind === 'files')
            request = running.urgent ? port.syncFile(path, URGENT) : port.syncFile(path)
          else
            request = running.urgent ? port.syncDirectory(path, URGENT) : port.syncDirectory(path)
        } catch (error) {
          return Promise.reject(error)
        }
        running.unsettled[kind].add(path)
        const settledPath = (): void => {
          running.unsettled[kind].delete(path)
        }
        request.then(() => {
          settledPath()
          running.ownUnsynced[kind].delete(path)
        }, settledPath)
        return request
      })
    )

  const pay = async (
    chatId: string,
    state: ThreadState,
    running: Running,
    taken: Debt
  ): Promise<void> => {
    const failures: unknown[] = []
    const unpaidFiles = new Map<string, OwedFile>()
    const syncing = { asked: new Set(taken.files.keys()), renamed: new Map<string, OwedFile>() }
    running.syncing = syncing
    // The files owed when the barrier began, then any of them renamed since.
    // A file renamed under a barrier that has already failed waits for the
    // next one, where the note that named it has put it.
    for (
      let asked = taken.files;
      asked.size > 0 && failures.length === 0;
      asked = syncing.renamed
    ) {
      syncing.renamed = new Map()
      const paths = [...asked.keys()]
      const outcomes = await syncAll(running, 'files', paths)
      paths.forEach((path, index) => {
        const entry = asked.get(path)!
        const outcome = outcomes[index]
        if (outcome.status === 'fulfilled') {
          owners[entry.owner][outcome.value === 'missing' ? 'missing' : 'synced'] += 1
        } else {
          owners[entry.owner].failed += 1
          unpaidFiles.set(path, entry)
          failures.push(outcome.reason)
        }
      })
    }
    // From here every sync this barrier asked for has run, each before any
    // rename still to come.
    running.syncing = null

    let unpaidDirectories = taken.directories
    if (failures.length === 0) {
      unpaidDirectories = new Map()
      const paths = [...taken.directories.keys()]
      const outcomes = await syncAll(running, 'directories', paths)
      paths.forEach((path, index) => {
        const outcome = outcomes[index]
        if (outcome.status === 'fulfilled') {
          owners.directory[outcome.value === 'missing' ? 'missing' : 'synced'] += 1
        } else {
          owners.directory.failed += 1
          unpaidDirectories.set(path, taken.directories.get(path)!)
          failures.push(outcome.reason)
        }
      })
    }

    state.running = null
    // A thread forgotten meanwhile has had its debt dropped, this part included.
    if (threads.get(chatId) === state) {
      for (const [path, entry] of unpaidFiles) oweAgain(state, path, entry, entry.owner)
      for (const [path, entry] of unpaidDirectories) oweAgain(state, path, entry)
      if (owesNothing(state) && !state.next) threads.delete(chatId)
    }
    if (failures.length > 0) {
      barriers.failed += 1
      throw failures[0]
    }
  }

  /** Take what the thread owes now for these runs, and start paying it. */
  const begin = (
    chatId: string,
    state: ThreadState,
    runs: ReadonlySet<string> | null,
    urgent: boolean
  ): Running => {
    const taken = take(state, runs)
    barriers.rounds += 1
    if (runs !== null && runs.size > 0) {
      const paths = taken.files.size + taken.directories.size
      barriers.runRounds += 1
      barriers.runPathsTotal += paths
      if (paths > barriers.runPathsMost) barriers.runPathsMost = paths
    }
    const ownUnsynced = noPaths()
    for (const [path, entry] of taken.files) if (entry.own) ownUnsynced.files.add(path)
    for (const [path, entry] of taken.directories) if (entry.own) ownUnsynced.directories.add(path)
    const running: Running = {
      promise: Promise.resolve(),
      urgent,
      unsettled: noPaths(),
      ownUnsynced,
      syncing: null
    }
    state.running = running
    running.promise = pay(chatId, state, running, taken)
    return running
  }

  /**
   * Join the barrier queued behind the running one, widened to these runs, or
   * queue one. `caller` is false when a queued barrier is put behind a running
   * one again.
   */
  const queue = (
    chatId: string,
    state: ThreadState,
    runs: ReadonlySet<string> | null,
    urgent: boolean,
    caller: boolean
  ): Queued => {
    const queued = state.next
    if (queued) {
      if (caller) barriers.shared += 1
      if (runs === null) queued.runs = null
      else if (queued.runs) for (const each of runs) queued.runs.add(each)
      if (urgent && !queued.urgent) {
        queued.urgent = true
        if (caller) barriers.hastened += 1
      }
      return queued
    }
    const next: Queued = {
      promise: Promise.resolve(),
      runs: runs === null ? null : new Set(runs),
      urgent,
      began: { at: null }
    }
    const afterRunning = (): Promise<void> => follow(chatId, state, next)
    next.promise = state.running!.promise.then(afterRunning, afterRunning)
    state.next = next
    return next
  }

  const follow = (chatId: string, state: ThreadState, queued: Queued): Promise<void> => {
    if (state.next === queued) state.next = null
    // Forgotten while it waited: what it was queued to pay has been dropped.
    if (threads.get(chatId) !== state) return Promise.resolve()
    // A barrier raised in the moment since the last one ended may already be
    // paying everything this one was queued for.
    if (!owesFor(state, queued.runs)) {
      if (state.running) return state.running.promise
      if (!state.next && owesNothing(state)) threads.delete(chatId)
      return Promise.resolve()
    }
    if (state.running) return queue(chatId, state, queued.runs, queued.urgent, false).promise
    queued.began.at = now()
    return begin(chatId, state, queued.runs, queued.urgent).promise
  }

  /** An urgent caller has to wait for this barrier: the rest of its syncs are asked as urgent, and the waiting ones move ahead. */
  const hasten = (running: Running, urgency: ThreadDurabilityUrgency | undefined): void => {
    if (running.urgent) return
    running.urgent = true
    barriers.hastened += 1
    urgency?.raise(running.unsettled.files, running.unsettled.directories)
  }

  /**
   * An urgent barrier of the thread's own debt alone, raised while another
   * barrier runs or is queued on the thread: the thread's own paths owed now,
   * and those the running barrier took that no sync has covered since, synced
   * urgently, files first. It takes nothing and waits for nothing else.
   */
  const beside = async (state: ThreadState): Promise<void> => {
    barriers.beside += 1
    const { running } = state
    const paths: Paths = {
      files: new Set(state.own.files),
      directories: new Set(state.own.directories)
    }
    if (running) {
      for (const path of running.ownUnsynced.files) paths.files.add(path)
      for (const path of running.ownUnsynced.directories) paths.directories.add(path)
    }
    for (const kind of ['files', 'directories'] as const) {
      if (paths[kind].size === 0) continue
      const outcomes = await Promise.allSettled(
        [...paths[kind]].map((path) => {
          try {
            const request =
              kind === 'files' ? port.syncFile(path, URGENT) : port.syncDirectory(path, URGENT)
            // Begun after this barrier was raised, so after the running one took it.
            request.then(
              () => running?.ownUnsynced[kind].delete(path),
              () => {}
            )
            return request
          } catch (error) {
            return Promise.reject(error)
          }
        })
      )
      const failed = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
      )
      if (failed) {
        barriers.besideFailed += 1
        throw failed.reason
      }
    }
  }

  const settled = (
    chatId: string,
    runs: ReadonlySet<string> | null,
    urgent: boolean,
    urgency: ThreadDurabilityUrgency | undefined
  ): Wait => {
    const atOnce = (promise: Promise<void>): Wait => ({
      promise,
      ownFrom: { at: now() },
      behind: false
    })
    const state = threads.get(chatId)
    if (!state) {
      barriers.idle += 1
      return atOnce(Promise.resolve())
    }
    const { running } = state
    if (!running) {
      if (!owesFor(state, runs)) {
        barriers.idle += 1
        return atOnce(Promise.resolve())
      }
      // In the moment between a barrier's end and the start of the one queued
      // behind it, a caller joins the queued one.
      if (state.next) {
        const queued = queue(chatId, state, runs, urgent, true)
        return { promise: queued.promise, ownFrom: queued.began, behind: false }
      }
      return atOnce(begin(chatId, state, runs, urgent).promise)
    }
    // Whatever this caller waits for comes after the running barrier.
    if (urgent) hasten(running, urgency)
    if (!owesFor(state, runs)) {
      barriers.shared += 1
      return { promise: running.promise, ownFrom: { at: null }, behind: true }
    }
    const queued = queue(chatId, state, runs, urgent, true)
    return { promise: queued.promise, ownFrom: queued.began, behind: true }
  }

  const barrier = (chatId: string, options: ThreadDurabilityBarrierOptions = {}): Promise<void> => {
    const threadOnly = options.threadOnly === true
    if (threadOnly && options.run !== undefined) {
      return Promise.reject(
        new TypeError('A barrier of the thread’s own debt alone cannot name a run')
      )
    }
    const urgent = options.urgent === true
    barriers.raised += 1
    if (options.run !== undefined) barriers.scoped += 1
    if (threadOnly) barriers.threadOnly += 1
    if (urgent) barriers.urgent += 1
    const kind = urgent ? waits.urgent : waits.normal
    const ahead = port.ahead?.(urgent) ?? 0
    kind.aheadTotal += ahead
    if (ahead > kind.aheadMost) kind.aheadMost = ahead
    const urgency = urgent ? port.urgent?.() : undefined
    const raisedAt = now()
    const runs = threadOnly
      ? new Set<string>()
      : options.run === undefined
        ? null
        : new Set([options.run])
    const state = threads.get(chatId)
    const wait: Wait =
      threadOnly && urgent && state && (state.running || state.next)
        ? { promise: beside(state), ownFrom: { at: raisedAt }, behind: false }
        : settled(chatId, runs, urgent, urgency)
    const timed = (): void => {
      const waited = now() - raisedAt
      barriers.waitMsTotal += waited
      if (waited > barriers.longestWaitMs) barriers.longestWaitMs = waited
      kind.count += 1
      kind.totalMs += waited
      if (waited > kind.longestMs) kind.longestMs = waited
      const ownFrom = wait.ownFrom.at
      const behindMs = ownFrom === null ? waited : Math.min(waited, Math.max(0, ownFrom - raisedAt))
      if (wait.behind) kind.waitedBehind += 1
      kind.behindTotalMs += behindMs
      if (behindMs > kind.behindLongestMs) kind.behindLongestMs = behindMs
      kind.ownSyncsTotalMs += waited - behindMs
      if (waited - behindMs > kind.ownSyncsLongestMs) kind.ownSyncsLongestMs = waited - behindMs
      urgency?.end()
    }
    wait.promise.then(timed, timed)
    return wait.promise
  }

  const forget = (chatId: string): void => {
    threads.delete(chatId)
  }

  /**
   * Ask the port for a trickle sync of each path the thread still owes, and
   * settle each by a barrier's rule. Resolves true when every sync asked for
   * succeeded and no path was passed over for a sync of it already waiting
   * or in flight.
   */
  const trickleSyncs = async (
    chatId: string,
    state: ThreadState,
    kind: Kind,
    paths: readonly string[]
  ): Promise<boolean> => {
    let whole = true
    const requests: Array<Promise<boolean>> = []
    for (const path of paths) {
      const entry = state.owed[kind].get(path)
      if (!entry) continue
      if (trickling[kind].has(path)) {
        whole = false
        continue
      }
      // A sync that starts after this request covers every note up to here.
      const asked = notes
      let request: Promise<ThreadDurabilitySyncOutcome>
      try {
        request =
          kind === 'files' ? port.syncFile(path, BACKGROUND) : port.syncDirectory(path, BACKGROUND)
      } catch (error) {
        request = Promise.reject(error)
      }
      trickling[kind].add(path)
      trickled.started += 1
      requests.push(
        request.then(
          () => {
            trickling[kind].delete(path)
            if (threads.get(chatId) !== state || state.owed[kind].get(path) !== entry) {
              trickled.takenOver += 1
            } else if (entry.noted > asked) {
              trickled.notedSince += 1
            } else {
              state.owed[kind].delete(path)
              disown(state, kind, path, entry)
              trickled.paid += 1
            }
            return true
          },
          () => {
            trickling[kind].delete(path)
            trickled.failed += 1
            return false
          }
        )
      )
    }
    const outcomes = await Promise.all(requests)
    return whole && outcomes.every(Boolean)
  }

  const trickleRound = async (chatId: string, state: ThreadState): Promise<void> => {
    trickled.rounds += 1
    const from = notes
    const filesPaid = await trickleSyncs(chatId, state, 'files', [...state.owed.files.keys()])
    // A directory sync makes names durable: only after the files of the
    // round, and only for a directory noted before the round began, whose
    // names are those files'.
    if (!filesPaid || threads.get(chatId) !== state) return
    const directories: string[] = []
    for (const [path, entry] of state.owed.directories) {
      if (entry.noted <= from) directories.push(path)
    }
    await trickleSyncs(chatId, state, 'directories', directories)
  }

  const trickle = (chatId: string): Promise<void> => {
    const state = threads.get(chatId)
    if (!state) return Promise.resolve()
    if (state.trickle) return state.trickle
    if (owesNothing(state)) return Promise.resolve()
    const round = trickleRound(chatId, state).finally(() => {
      state.trickle = null
      if (threads.get(chatId) === state && owesNothing(state) && !state.running && !state.next) {
        threads.delete(chatId)
      }
    })
    state.trickle = round
    return round
  }

  const snapshot = (): ThreadDurabilityDebtSnapshot => {
    let files = 0
    let directories = 0
    let owingRuns = 0
    for (const state of threads.values()) {
      files += state.owed.files.size
      directories += state.owed.directories.size
      owingRuns += state.runs.size
    }
    return {
      owners: Object.fromEntries(
        THREAD_DURABILITY_OWNERS.map((owner) => [owner, { ...owners[owner] }])
      ) as Record<ThreadDurabilityOwner, ThreadDurabilityOwnerCounters>,
      barriers: { ...barriers },
      trickle: {
        ...trickled,
        inFlight: trickling.files.size + trickling.directories.size
      },
      waits: { urgent: { ...waits.urgent }, normal: { ...waits.normal } },
      owed: { threads: threads.size, files, directories },
      owingRuns,
      syncsOnCallingThread: 0
    }
  }

  return { note, barrier, forget, trickle, snapshot }
}
