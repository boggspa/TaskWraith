/**
 * Per-scope write lanes for the transactional persist (Independent Threads
 * M4, slice 2).
 *
 * Today nothing orders two writers of one thread record. The projection
 * queue is one global FIFO; recovery admits run beside commands; and
 * Domain's out-of-command writers (transcript appends, run updates,
 * configure, archive, the seat-toggle rewrite) read and then write with no
 * compare-and-swap, so a persist that awaits an off-loop read can be
 * overtaken. M4 gives every writer of a record that record's lane.
 *
 * A scope is one thread's record (`hostThreadScope(threadId)`) or the public
 * window (`HOST_WINDOW_SCOPE`, taken by refills). Each scope carries:
 * - a FIFO of writers and at most one holder, its `owner`;
 * - `version`: the revision last committed through the lane, or null when
 *   unknown or deleted;
 * - `epoch`: `{ hostIncarnation, deleteCounter }`. A committed delete bumps
 *   the counter, and every writer admitted under an older epoch is refused
 *   `epoch_stale` there and then, whether it was waiting or arrives later,
 *   so a persist queued behind a delete never holds the lane and can never
 *   bring back the thread it was meant for (Appendix D, row D6). The
 *   incarnation is this Host's opaque boot identity, compared for equality
 *   only: an epoch from another incarnation is stale;
 * - `publishedCursor`: where the scope's last effects were published.
 *
 * Different scopes never wait on each other. A writer that needs a thread
 * lane and the window takes the thread lane first. A scope's state lives as
 * long as the ledger (one small entry per scope ever acquired), because a
 * delete's epoch must outlive the writers admitted before it.
 *
 * Unwired in this slice: nothing takes a lane yet.
 */
import type { HostCursorPosition } from '../shared/hostProtocol'

declare const hostScopeBrand: unique symbol

/** A thread's record or the public window; made only by this module. */
export type HostScopeId = string & { readonly [hostScopeBrand]: true }

export interface HostScopeEpoch {
  readonly hostIncarnation: string
  readonly deleteCounter: number
}

/**
 * The failure a writer refused `epoch_stale` reports. It names neither a
 * revision nor a conflict: Desktop treats any rejection whose code or
 * message contains either word as a revision conflict and re-sends the
 * record as a create (`classifyHostPersistRejection`), which would bring the
 * deleted thread back. `thread_record_deleted` is already the delete's own
 * success summary.
 */
export const HOST_SCOPE_EPOCH_STALE_ERROR_CODE = 'thread_record_epoch_stale'
export const HOST_SCOPE_EPOCH_STALE_MESSAGE =
  'The thread was deleted after this write was admitted.'

export const HOST_WINDOW_SCOPE = 'window' as HostScopeId

const THREAD_SCOPE_PREFIX = 'thread:'
const MAX_THREAD_ID_LENGTH = 512
const MAX_INCARNATION_LENGTH = 256
const MAX_OWNER_LENGTH = 256

export interface HostScopeView {
  readonly scope: HostScopeId
  readonly epoch: HostScopeEpoch
  readonly version: number | null
  readonly publishedCursor: HostCursorPosition | null
  /** The holder's label, or null when the lane is free. */
  readonly owner: string | null
  readonly waiting: number
}

export interface HostScopeSlot {
  readonly scope: HostScopeId
  readonly owner: string
  /** The scope's current epoch; `deleted()` moves it. */
  readonly epoch: HostScopeEpoch
  readonly version: number | null
  readonly publishedCursor: HostCursorPosition | null
  readonly released: boolean
  /** Record a commit: the revision is a safe integer above the last one. */
  commit(version: number): void
  /** Record where this scope's effects were published. */
  published(position: HostCursorPosition): void
  /**
   * Record a committed delete of the thread: bump the epoch, forget the
   * version, and refuse every waiter admitted under the old epoch.
   */
  deleted(): HostScopeEpoch
  /** Hand the lane to the next writer. Idempotent. */
  release(): void
}

export type HostScopeRefusal = 'epoch_stale' | 'aborted' | 'closed'

export type HostScopeAcquireResult =
  | { readonly ok: true; readonly slot: HostScopeSlot }
  | { readonly ok: false; readonly reason: 'epoch_stale'; readonly epoch: HostScopeEpoch }
  | { readonly ok: false; readonly reason: 'aborted' | 'closed' }

export interface HostScopeAcquireRequest {
  /** A label for the writer, reported while it holds or waits. */
  readonly owner: string
  /**
   * The epoch the writer was admitted under. When given, the writer is
   * refused `epoch_stale` rather than granted once the epoch has moved.
   * Writers that act on whatever is current (transcript appends) omit it.
   */
  readonly epoch?: HostScopeEpoch
  /** Leaves the queue while still waiting; no effect once granted. */
  readonly signal?: AbortSignal
}

export type HostScopeLaneEvent =
  | {
      readonly kind: 'granted'
      readonly scope: HostScopeId
      readonly owner: string
      readonly waitMs: number | null
    }
  | {
      readonly kind: 'released'
      readonly scope: HostScopeId
      readonly owner: string
      readonly holdMs: number | null
    }
  | {
      readonly kind: 'refused'
      readonly scope: HostScopeId
      readonly owner: string
      readonly reason: HostScopeRefusal
    }

export interface HostScopeLedgerOptions {
  /** This Host's boot identity (for example its `bootEpoch`); opaque. */
  readonly hostIncarnation: string
  /** Lane events; a throwing observer never disturbs a lane. */
  readonly observer?: (event: HostScopeLaneEvent) => void
  /** Clock seam for the observer's timings; never read without an observer. */
  readonly now?: () => number
}

export interface HostScopeLedger {
  readonly hostIncarnation: string
  readonly closed: boolean
  view(scope: HostScopeId): HostScopeView
  acquire(scope: HostScopeId, request: HostScopeAcquireRequest): Promise<HostScopeAcquireResult>
  /** Refuse new and queued writers; holders keep their lanes until they release. */
  close(): void
}

interface Waiter {
  readonly owner: string
  readonly epoch: HostScopeEpoch | null
  readonly queuedAt: number | null
  readonly settle: (result: HostScopeAcquireResult) => void
  detach: () => void
}

interface ScopeState {
  readonly scope: HostScopeId
  deleteCounter: number
  version: number | null
  publishedCursor: HostCursorPosition | null
  holder: { readonly owner: string; readonly grantedAt: number | null } | null
  readonly waiters: Waiter[]
}

type HostScopeRefused = Extract<HostScopeAcquireResult, { ok: false }>

const ABORTED: HostScopeRefused = Object.freeze({ ok: false, reason: 'aborted' } as const)
const CLOSED: HostScopeRefused = Object.freeze({ ok: false, reason: 'closed' } as const)

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function isLabel(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !hasControlCharacter(value)
  )
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/** The scope of one thread's record. */
export function hostThreadScope(threadId: string): HostScopeId {
  if (!isLabel(threadId, MAX_THREAD_ID_LENGTH)) {
    throw new TypeError('hostThreadScope needs a thread id')
  }
  return `${THREAD_SCOPE_PREFIX}${threadId}` as HostScopeId
}

function isScope(value: unknown): value is HostScopeId {
  return (
    value === HOST_WINDOW_SCOPE ||
    (typeof value === 'string' &&
      value.startsWith(THREAD_SCOPE_PREFIX) &&
      isLabel(value.slice(THREAD_SCOPE_PREFIX.length), MAX_THREAD_ID_LENGTH))
  )
}

function assertScope(value: unknown): asserts value is HostScopeId {
  if (!isScope(value)) throw new TypeError('HostScopeLedger needs a scope from hostThreadScope')
}

export function sameHostScopeEpoch(left: HostScopeEpoch, right: HostScopeEpoch): boolean {
  return (
    left.hostIncarnation === right.hostIncarnation && left.deleteCounter === right.deleteCounter
  )
}

function readEpoch(value: unknown): HostScopeEpoch {
  const epoch = value as Partial<HostScopeEpoch> | null
  if (
    epoch === null ||
    typeof epoch !== 'object' ||
    !isLabel(epoch.hostIncarnation, MAX_INCARNATION_LENGTH) ||
    !isNonNegativeSafeInteger(epoch.deleteCounter)
  ) {
    throw new TypeError('HostScopeLedger needs an epoch of { hostIncarnation, deleteCounter }')
  }
  return Object.freeze({
    hostIncarnation: epoch.hostIncarnation,
    deleteCounter: epoch.deleteCounter
  })
}

function readPosition(value: unknown): HostCursorPosition {
  const position = value as Partial<HostCursorPosition> | null
  if (
    position === null ||
    typeof position !== 'object' ||
    !isNonNegativeSafeInteger(position.generation) ||
    !isNonNegativeSafeInteger(position.cursor)
  ) {
    throw new TypeError('HostScopeLedger needs a cursor position of { generation, cursor }')
  }
  return Object.freeze({ generation: position.generation, cursor: position.cursor })
}

export function createHostScopeLedger(options: HostScopeLedgerOptions): HostScopeLedger {
  if (!isLabel(options?.hostIncarnation, MAX_INCARNATION_LENGTH)) {
    throw new TypeError('createHostScopeLedger needs this Host’s incarnation')
  }
  const hostIncarnation = options.hostIncarnation
  const observer = options.observer
  const now = options.now ?? (() => Date.now())
  const scopes = new Map<HostScopeId, ScopeState>()
  let closed = false

  /** A guarded clock read, taken only for an observer; null drops one timing. */
  const readClock = (): number | null => {
    if (!observer) return null
    let value: unknown
    try {
      value = now()
    } catch {
      return null
    }
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  }
  const elapsed = (from: number | null): number | null => {
    if (from === null) return null
    const to = readClock()
    return to === null ? null : Math.max(0, to - from)
  }
  const emit = (event: HostScopeLaneEvent): void => {
    if (!observer) return
    try {
      observer(event)
    } catch {
      // Instrumentation never disturbs a lane.
    }
  }

  const epochOf = (state: ScopeState): HostScopeEpoch =>
    Object.freeze({ hostIncarnation, deleteCounter: state.deleteCounter })

  const stateFor = (scope: HostScopeId): ScopeState => {
    let state = scopes.get(scope)
    if (!state) {
      state = {
        scope,
        deleteCounter: 0,
        version: null,
        publishedCursor: null,
        holder: null,
        waiters: []
      }
      scopes.set(scope, state)
    }
    return state
  }

  const refuse = (
    scope: HostScopeId,
    owner: string,
    result: HostScopeRefused
  ): HostScopeAcquireResult => {
    emit({ kind: 'refused', scope, owner, reason: result.reason })
    return result
  }
  const stale = (state: ScopeState, owner: string): HostScopeAcquireResult =>
    refuse(state.scope, owner, { ok: false, reason: 'epoch_stale', epoch: epochOf(state) })

  const createSlot = (state: ScopeState, owner: string): HostScopeSlot => {
    let released = false
    const assertHeld = (action: string): void => {
      if (released) throw new Error(`HostScopeLedger: ${action} after the lane was released`)
    }
    return {
      scope: state.scope,
      owner,
      get epoch() {
        return epochOf(state)
      },
      get version() {
        return state.version
      },
      get publishedCursor() {
        return state.publishedCursor
      },
      get released() {
        return released
      },
      commit(version: number): void {
        assertHeld('commit')
        if (!isNonNegativeSafeInteger(version)) {
          throw new TypeError('HostScopeLedger: a committed version is a non-negative safe integer')
        }
        if (state.version !== null && version <= state.version) {
          throw new Error(
            `HostScopeLedger: version ${version} does not follow ${state.version} on ${state.scope}`
          )
        }
        state.version = version
      },
      published(position: HostCursorPosition): void {
        assertHeld('published')
        const next = readPosition(position)
        const last = state.publishedCursor
        if (last !== null && last.generation === next.generation && next.cursor < last.cursor) {
          throw new Error(`HostScopeLedger: cursor ${next.cursor} is behind ${last.cursor}`)
        }
        state.publishedCursor = next
      },
      deleted(): HostScopeEpoch {
        assertHeld('deleted')
        if (state.scope === HOST_WINDOW_SCOPE) {
          throw new Error('HostScopeLedger: the window scope is not a record')
        }
        state.deleteCounter += 1
        state.version = null
        const current = epochOf(state)
        // Writers admitted before the delete leave the queue now rather
        // than wait behind writers they will never follow.
        for (const waiter of [...state.waiters]) {
          if (waiter.epoch === null || sameHostScopeEpoch(waiter.epoch, current)) continue
          // An observer may have taken it out already (an abort it caused).
          const index = state.waiters.indexOf(waiter)
          if (index < 0) continue
          state.waiters.splice(index, 1)
          waiter.detach()
          waiter.settle(stale(state, waiter.owner))
        }
        return current
      },
      release(): void {
        if (released) return
        released = true
        const holder = state.holder
        state.holder = null
        emit({
          kind: 'released',
          scope: state.scope,
          owner,
          holdMs: elapsed(holder ? holder.grantedAt : null)
        })
        pump(state)
      }
    }
  }

  /**
   * Grant a free lane to its first waiter. Every waiter's epoch is current:
   * one admitted before a delete was refused when the delete was recorded.
   */
  const pump = (state: ScopeState): void => {
    if (state.holder === null && state.waiters.length > 0) {
      const waiter = state.waiters.shift() as Waiter
      waiter.detach()
      const grantedAt = readClock()
      state.holder = { owner: waiter.owner, grantedAt }
      emit({
        kind: 'granted',
        scope: state.scope,
        owner: waiter.owner,
        waitMs:
          waiter.queuedAt === null || grantedAt === null
            ? null
            : Math.max(0, grantedAt - waiter.queuedAt)
      })
      waiter.settle({ ok: true, slot: createSlot(state, waiter.owner) })
    }
  }

  return {
    hostIncarnation,
    get closed() {
      return closed
    },
    view(scope: HostScopeId): HostScopeView {
      assertScope(scope)
      const state = scopes.get(scope)
      return {
        scope,
        epoch: state ? epochOf(state) : Object.freeze({ hostIncarnation, deleteCounter: 0 }),
        version: state ? state.version : null,
        publishedCursor: state ? state.publishedCursor : null,
        owner: state && state.holder ? state.holder.owner : null,
        waiting: state ? state.waiters.length : 0
      }
    },
    acquire(scope: HostScopeId, request: HostScopeAcquireRequest): Promise<HostScopeAcquireResult> {
      assertScope(scope)
      if (!isLabel(request?.owner, MAX_OWNER_LENGTH)) {
        throw new TypeError('HostScopeLedger needs an owner label')
      }
      const owner = request.owner
      const epoch = request.epoch === undefined ? null : readEpoch(request.epoch)
      const signal = request.signal
      if (closed) return Promise.resolve(refuse(scope, owner, CLOSED))
      if (signal?.aborted) return Promise.resolve(refuse(scope, owner, ABORTED))
      const state = stateFor(scope)
      // A writer already behind a delete is refused now, not after a wait.
      if (epoch !== null && !sameHostScopeEpoch(epoch, epochOf(state))) {
        return Promise.resolve(stale(state, owner))
      }
      return new Promise<HostScopeAcquireResult>((resolve) => {
        const waiter: Waiter = {
          owner,
          epoch,
          queuedAt: readClock(),
          settle: resolve,
          detach: () => {}
        }
        if (signal) {
          const onAbort = (): void => {
            const index = state.waiters.indexOf(waiter)
            if (index < 0) return
            state.waiters.splice(index, 1)
            resolve(refuse(scope, owner, ABORTED))
          }
          signal.addEventListener('abort', onAbort, { once: true })
          waiter.detach = () => signal.removeEventListener('abort', onAbort)
        }
        state.waiters.push(waiter)
        pump(state)
      })
    },
    close(): void {
      if (closed) return
      closed = true
      for (const state of scopes.values()) {
        const waiters = state.waiters.splice(0, state.waiters.length)
        for (const waiter of waiters) {
          waiter.detach()
          waiter.settle(refuse(state.scope, waiter.owner, CLOSED))
        }
      }
    }
  }
}
