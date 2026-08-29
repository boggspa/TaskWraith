import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { ChatListItem, ChatRecord } from './store/types'
import {
  appendThreadTitleRepairLedger,
  clearThreadTitleRepairFailure,
  deriveThreadTitleFromTranscript,
  emptyThreadTitleRepairState,
  isThreadTitleRepairBlocked,
  isThreadTitleRepairLedgerFull,
  isThreadTitleRepairTarget,
  parseThreadTitleRepairState,
  recordThreadTitleRepairFailure,
  selectThreadTitleRepairCandidates,
  sliceRepairBatch,
  stampThreadTitleRepairAttempt,
  type ThreadTitleRepairState
} from './store/ThreadTitleRepair'

/**
 * Effectful half of the bounded placeholder-title repair pass.
 *
 * A thread whose first prompt arrived through a path that did not derive a
 * title keeps its create-factory placeholder forever, because both live gates
 * require `messages.length === 0`. This drains those threads in bounded slices,
 * well off the paint path, writing through the same primitive the manual rename
 * uses so nothing about persistence is novel.
 *
 * Nothing here may break the app. Every read, write and broadcast is contained:
 * a repair that cannot run is a repair that did not happen.
 */

/**
 * Delay from the trigger to the first slice. Long enough that the pass never
 * competes with first paint or with the run the user just started.
 */
export const THREAD_TITLE_REPAIR_INITIAL_DELAY_MS = 45_000

/** Gap between slices while candidates remain. */
export const THREAD_TITLE_REPAIR_SLICE_INTERVAL_MS = 15_000

/**
 * Slices one process will run. Twelve slices of eight is 96 records, comfortably
 * past the 28 candidates measured on a real profile, and a hard stop against a
 * candidate that defers forever because its chat is always busy.
 */
export const MAX_THREAD_TITLE_REPAIR_SLICES_PER_PROCESS = 12

/**
 * Bounded, non-fatal wait for the Host to confirm a repaired record, matching
 * `settleEnsembleCreatePersistBarrier`. The barrier is what re-anchors the
 * optimistic persistence shadow after a conflict, so it is worth awaiting — but
 * a saturated Host can fail every persist in a session, and an unbounded wait
 * would wedge the drain on its first record.
 */
export const THREAD_TITLE_REPAIR_PERSIST_BARRIER_TIMEOUT_MS = 5_000

export type ThreadTitleRepairMode = 'apply' | 'dry' | 'off'

export interface ThreadTitleRepairRunnerDeps {
  statePath: string
  /**
   * The complete chat list, unscoped.
   *
   * Deliberately not the array the `get-chat-list` handler just built: that one
   * can be workspace-scoped, and a partial observation would silently leave
   * candidates outside the caller's workspace unrepaired. Discovery is
   * index-backed and costs no record reads, so sourcing it here is cheap and
   * definitionally complete.
   */
  listChats: () => ChatListItem[]
  getChat: (chatId: string) => ChatRecord | null
  saveChat: (chat: ChatRecord) => ChatRecord
  awaitChatRecordPersisted?: (chatId: string) => Promise<void>
  isChatBusy: (chatId: string) => boolean
  broadcastChatUpdated: (chat: ChatRecord) => void
  broadcastThreadUpdate: (chatId: string | undefined) => void
  pushRemoteTaskCardDelta: (chatId: string) => void
  readStateFile: (path: string) => string | null
  writeStateFile: (path: string, contents: string) => void
  mode?: ThreadTitleRepairMode
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => void
  log?: (message: string) => void
  onError?: (message: string, error: unknown) => void
}

export interface ThreadTitleRepairRunner {
  /** Arms the deferred drain, at most once per process. */
  observe: () => void
  /** Runs one slice now. Concurrent callers join the in-flight drain. */
  drainNow: () => Promise<void>
}

export function readThreadTitleRepairStateFile(path: string): string | null {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

/** tmp-with-pid then rename, `0o600`, matching `DailyUsageRollupStore`. */
export function writeThreadTitleRepairStateFile(path: string, contents: string): void {
  const tempPath = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tempPath, contents, { encoding: 'utf8', mode: 0o600 })
    renameSync(tempPath, path)
  } catch (error) {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // Best effort: the next drain stamps and writes again.
    }
    throw error
  }
}

export function threadTitleRepairModeFromEnv(raw: string | undefined): ThreadTitleRepairMode {
  const normalized = (raw ?? '').trim().toLowerCase()
  if (normalized === 'off' || normalized === '0' || normalized === 'false') return 'off'
  if (normalized === 'dry') return 'dry'
  return 'apply'
}

export function createThreadTitleRepairRunner(
  deps: ThreadTitleRepairRunnerDeps
): ThreadTitleRepairRunner {
  const mode = deps.mode ?? 'apply'
  const now = deps.now ?? (() => Date.now())
  const schedule =
    deps.schedule ??
    ((run: () => void, delayMs: number) => {
      const timer = setTimeout(run, delayMs)
      timer.unref?.()
    })
  const log = deps.log ?? ((message: string) => console.log(message))
  const onError =
    deps.onError ??
    ((message: string, error: unknown) => {
      console.error(message, error)
    })

  let armed = false
  let drainInFlight: Promise<void> | null = null
  let slicesRun = 0

  const readState = (): ThreadTitleRepairState => {
    try {
      const raw = deps.readStateFile(deps.statePath)
      if (!raw) return emptyThreadTitleRepairState()
      return parseThreadTitleRepairState(JSON.parse(raw))
    } catch (error) {
      onError('[thread-title-repair] could not read repair state; starting from empty.', error)
      return emptyThreadTitleRepairState()
    }
  }

  const writeState = (state: ThreadTitleRepairState): boolean => {
    try {
      deps.writeStateFile(deps.statePath, JSON.stringify(state))
      return true
    } catch (error) {
      onError('[thread-title-repair] could not write repair state; standing down.', error)
      return false
    }
  }

  const settlePersistBarrier = async (chatId: string): Promise<void> => {
    const barrier = deps.awaitChatRecordPersisted?.(chatId)
    if (!barrier) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // Handle the barrier itself rather than the race: the losing branch stays
    // pending, and a late rejection with no handler surfaces as an unhandled
    // rejection in main.
    const reported = barrier.catch((error) => {
      onError(
        `[thread-title-repair] Host record persist failed for chat ${chatId}; the title was ` +
          'written but is not yet durable.',
        error
      )
    })
    const bound = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), THREAD_TITLE_REPAIR_PERSIST_BARRIER_TIMEOUT_MS)
      timer.unref?.()
    })
    try {
      await Promise.race([reported, bound])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Returns the state after this candidate, and whether a repair was applied. */
  const repairOne = async (
    state: ThreadTitleRepairState,
    chatId: string
  ): Promise<{ state: ThreadTitleRepairState; applied: boolean }> => {
    // Read late and write immediately. The record must not cross an await
    // between the read and the save, or a concurrent turn's appended messages
    // can be forced back out by a stale snapshot when the revision rebases.
    const fresh = deps.getChat(chatId)
    if (!fresh) {
      return { state: recordThreadTitleRepairFailure(state, chatId), applied: false }
    }
    if (!isThreadTitleRepairTarget(fresh)) {
      // Already repaired, or a real title arrived. Not a failure.
      return { state: clearThreadTitleRepairFailure(state, chatId), applied: false }
    }
    if (isThreadTitleRepairBlocked(fresh, deps.isChatBusy(chatId))) {
      // Deferred, not failed: retry on the next slice.
      return { state, applied: false }
    }
    const derived = deriveThreadTitleFromTranscript(fresh)
    if (!derived) {
      return { state: recordThreadTitleRepairFailure(state, chatId), applied: false }
    }
    if (mode === 'dry') {
      log(`[thread-title-repair] dry run: ${chatId} "${fresh.title}" -> "${derived}"`)
      return { state, applied: false }
    }

    const previousTitle = fresh.title
    const saved = deps.saveChat({ ...fresh, title: derived })
    // saveChat returns the *current* record unchanged on a workspace or
    // revision mismatch, so a returned record is not proof of a write.
    if (!saved || saved.title !== derived) {
      return { state: recordThreadTitleRepairFailure(state, chatId), applied: false }
    }

    await settlePersistBarrier(chatId)

    deps.broadcastChatUpdated(saved)
    deps.broadcastThreadUpdate(saved.appChatId)
    if (previousTitle !== saved.title) deps.pushRemoteTaskCardDelta(saved.appChatId)

    const next = appendThreadTitleRepairLedger(clearThreadTitleRepairFailure(state, chatId), {
      chatId,
      previousTitle,
      derivedTitle: saved.title,
      at: now()
    })
    return { state: next, applied: true }
  }

  const runSlice = async (): Promise<void> => {
    if (mode === 'off') return

    let state = readState()
    if (isThreadTitleRepairLedgerFull(state)) {
      log('[thread-title-repair] ledger is full; no further titles will be repaired.')
      return
    }

    // Stamp the attempt before doing any work and read it back. A state file
    // that cannot record attempts cannot bound retries either, so a pass that
    // could not stamp must not write.
    const stamped = stampThreadTitleRepairAttempt(state, now())
    if (!writeState(stamped)) return
    const confirmed = readState()
    if (confirmed.attempts !== stamped.attempts) {
      onError(
        '[thread-title-repair] attempt stamp did not round-trip; standing down.',
        new Error('thread title repair state did not persist')
      )
      return
    }
    state = confirmed

    const candidates = selectThreadTitleRepairCandidates(deps.listChats(), state)
    if (candidates.length === 0) return

    const slice = sliceRepairBatch(candidates)
    let applied = 0
    for (const candidate of slice) {
      try {
        const result = await repairOne(state, candidate.chatId)
        state = result.state
        if (result.applied) applied += 1
      } catch (error) {
        // One bad record must never stop the drain.
        onError(`[thread-title-repair] could not repair chat ${candidate.chatId}.`, error)
        state = recordThreadTitleRepairFailure(state, candidate.chatId)
      }
      if (isThreadTitleRepairLedgerFull(state)) break
    }
    writeState(state)
    if (applied > 0) {
      log(
        `[thread-title-repair] derived a title for ${applied} placeholder-titled ` +
          `thread${applied === 1 ? '' : 's'}.`
      )
    }

    slicesRun += 1
    const remaining = selectThreadTitleRepairCandidates(deps.listChats(), state)
    if (remaining.length > 0 && slicesRun < MAX_THREAD_TITLE_REPAIR_SLICES_PER_PROCESS) {
      schedule(() => void drainNow(), THREAD_TITLE_REPAIR_SLICE_INTERVAL_MS)
    }
  }

  const drainNow = (): Promise<void> => {
    // Join rather than start a second drain: a bare boolean set after the first
    // await lets every concurrent caller straight through.
    if (drainInFlight) return drainInFlight
    const running = runSlice()
      .catch((error) => {
        onError('[thread-title-repair] drain failed.', error)
      })
      .finally(() => {
        drainInFlight = null
      })
    drainInFlight = running
    return running
  }

  return {
    observe: () => {
      if (mode === 'off' || armed) return
      armed = true
      schedule(() => void drainNow(), THREAD_TITLE_REPAIR_INITIAL_DELAY_MS)
    },
    drainNow
  }
}
