/**
 * History for a thread the Host follows by its log, in the shapes the wire
 * already has: a page of the tail from the follower's window, an older page
 * from a whole record that the seed port loads off the event loop, and
 * `history.since` from the batches the follower applied. Entries, their order
 * and the pages they fall in are those of the profile store's `threadHistory`
 * over the whole record at the same revision; the projection here is that
 * store's, rule for rule.
 *
 * The terminal app holds the newest entries and any older pages it asked for,
 * keyed by id. It applies a removal by dropping the id, and an append or a
 * replacement by putting the entry in place of the one with its id or, when it
 * holds none, after everything it holds. It takes `generation` and `cursor`
 * from every page it loads, older pages too, and meets
 * `full_resnapshot_required` by loading the tail again.
 *
 * So inside one generation entries are only added after all others, changed
 * in place, or removed, and no id is added twice. Each entry keeps one
 * sequence number for the whole generation: its position when the generation
 * began, or the next number when it was added. Anything else begins a new
 * generation: a seed, a change to a message before the window, an entry added
 * before another, a change of order, an id added again, a message changed as
 * it leaves the window, or a held message that names a run the view lacks.
 *
 * - `generation` is HOST_THREAD_LOG_HISTORY_GENERATION_BASE plus a number
 *   drawn for each generation, so it never equals the full copy's, which is a
 *   revision, nor one this history gave out before.
 * - A cursor names a revision and the sequence number of the oldest entry the
 *   client holds; a page's `nextBefore` is its own generation and cursor. As a
 *   client holds every entry from that one on, deltas leave out the entries
 *   before it, which it would otherwise put after everything it holds.
 * - An older page is the entries numbered below the one its cursor names,
 *   which stay put while batches arrive, and it hands back the revision of the
 *   page that cursor came from. A client that had moved past that revision
 *   takes again deltas it has, which leaves it where it was: an append finds
 *   its id held only when every later append is held too.
 * - A change that leaves positions alone but cannot be sent, the tool rows of
 *   a run named by a message no longer in the window, tells only the clients
 *   that hold such an entry to load again.
 * - So does the removal of an entry a client held: the terminal app drops it
 *   without taking the entry before its rows in its place, and a client that
 *   applies deltas must never hold less than the page a fresh load gives.
 */
import { randomInt } from 'node:crypto'
import * as nodeFs from 'node:fs'
import * as path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type { ThreadLogSegmentReaderFs } from '../host-shared/thread-log/ThreadLogSegmentReader'
import {
  HOST_HISTORY_MAX_ENTRY_TEXT,
  HOST_HISTORY_MAX_PAGE_SIZE,
  type HostHistoryCursor,
  type HostHistoryDelta,
  type HostHistorySinceRequest,
  type HostHistorySinceResult,
  type HostHistoryToolEntry,
  type HostThreadHistoryPage,
  type HostThreadHistoryRequest,
  type HostTranscriptHistoryEntry
} from '../shared/hostHistoryProtocol'
import {
  HostThreadLogFollower,
  type HostThreadLogAppliedBatch,
  type HostThreadLogFollowerOptions,
  type HostThreadLogMessage,
  type HostThreadLogRecord,
  type HostThreadLogRun,
  type HostThreadLogView
} from './HostThreadLogFollower'

/**
 * Generations served from the log are this plus a number drawn for each. The
 * full copy's generation is a revision, far below it, so a client moving
 * between the two always loads again.
 */
export const HOST_THREAD_LOG_HISTORY_GENERATION_BASE = 2 ** 40
/**
 * Sequence numbers a cursor can carry. A cursor is the revisions since the
 * generation began times this, plus a sequence number, so both stay exact
 * below 2 ** 53; a generation about to pass either bound begins again.
 */
export const HOST_THREAD_LOG_HISTORY_SEQUENCE_SPAN = 2 ** 24
const REVISION_SPAN = 2 ** 29
/** Batches whose changes are kept for `history.since`. */
export const HOST_THREAD_LOG_HISTORY_MAX_RETAINED_BATCHES = 4096
/** Upper bounds of the buckets that count, per batch, how long it took to be served. */
export const HOST_THREAD_LOG_HISTORY_LAG_BOUNDS_MS: readonly number[] = [
  100, 250, 500, 1000, 2000, 5000
]

const MAX_RETAINED_CHANGES = 65_536
const MAX_REMOVALS = 8192
const MAX_MISSING_RUN_REFERENCES = 4096
/** Entries that left the window, kept so a client a little behind still gets them as deltas. */
const MAX_LEFT_WINDOW_BYTES = 1024 * 1024
const MAX_LEFT_WINDOW_ENTRIES = 4096
const MAX_UNSERVED = 4096
const TAIL_CHUNK_BYTES = 64 * 1024
const MAX_TAIL_BYTES = 1024 * 1024
const CHECKPOINT_HEADER_BYTES = 4096
const MAX_SETTLING_POLLS = 4
const MAX_RECORD_LOADS = 3
const MAX_CATCH_UP_POLLS = 8

// eslint-disable-next-line no-control-regex -- the profile store's history refuses terminal controls.
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** The profile store's check of transcript text: present, bounded, free of terminal controls. */
function safeText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= HOST_HISTORY_MAX_ENTRY_TEXT &&
    !CONTROL_CHARACTER.test(value)
  )
}

/** Whether the profile store's history shows a message. */
function shows(message: HostThreadLogMessage): boolean {
  const role = message.role
  return (role === 'user' || role === 'assistant' || role === 'system') && safeText(message.content)
}

/** The run whose tool rows a shown message carries: an assistant message's run, by id. */
function namedRun(message: HostThreadLogMessage): string | null {
  const runId = message.runId
  return message.role === 'assistant' && typeof runId === 'string' && runId !== '' ? runId : null
}

function toolRows(run: HostThreadLogRun | undefined): HostHistoryToolEntry[] {
  return (
    (run?.toolActivities as HostHistoryToolEntry[] | undefined)?.map((activity) => ({
      ...activity
    })) ?? []
  )
}

/** The entry the profile store's history shows for a message, given the first run with its run id. */
function entryOf(
  message: HostThreadLogMessage,
  run: HostThreadLogRun | undefined
): HostTranscriptHistoryEntry | null {
  if (!shows(message)) return null
  const createdAt = Date.parse(message.timestamp as string)
  return {
    entryId: message.id,
    role: message.role as 'user' | 'assistant' | 'system',
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    text: message.content,
    ...(namedRun(message) !== null ? { tools: toolRows(run) } : {})
  }
}

/** Each run id's first run, which is the one the profile store finds for a message. */
function firstRuns(runs: Iterable<HostThreadLogRun>): Map<string, HostThreadLogRun> {
  const first = new Map<string, HostThreadLogRun>()
  for (const run of runs) {
    if (typeof run.runId === 'string' && !first.has(run.runId)) first.set(run.runId, run)
  }
  return first
}

/**
 * Each held run id's first held run. The view holds its runs in the record's
 * order and every run a held message names, so for a held message this is
 * the record's first run with the id.
 */
function heldRuns(view: HostThreadLogView): Map<string, HostThreadLogRun> {
  return firstRuns(view.runs.map((held) => held.run))
}

function revisionOf(record: { readonly persistenceRevision?: unknown }): number {
  const revision = record.persistenceRevision
  return Number.isSafeInteger(revision) && (revision as number) >= 0 ? (revision as number) : 0
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** The whole record's history, as the profile store's `threadHistory` projects it. */
export function hostThreadLogHistoryEntries(
  record: HostThreadLogRecord
): HostTranscriptHistoryEntry[] {
  const runs = firstRuns(record.runs as HostThreadLogRun[])
  const entries: HostTranscriptHistoryEntry[] = []
  for (const message of record.messages as HostThreadLogMessage[]) {
    const runId = namedRun(message)
    const entry = entryOf(message, runId === null ? undefined : runs.get(runId))
    if (entry) entries.push(entry)
  }
  return entries
}

/** How many of the removed numbers, ascending, are below `sequence`. */
function countBelow(removed: readonly number[], sequence: number): number {
  let count = 0
  while (count < removed.length && removed[count] < sequence) count += 1
  return count
}

/** The sequence number at `position`, the numbers in `removed` (ascending) left out. */
function sequenceAt(position: number, removed: readonly number[]): number {
  let sequence = position
  for (const each of removed) {
    if (each > sequence) break
    sequence += 1
  }
  return sequence
}

/** A message of the window, the entry it shows, and that entry's sequence number (-1 for none). */
interface Held {
  readonly message: HostThreadLogMessage
  /** The run the entry's tool rows came from, so an unchanged message and run keep their entry. */
  readonly run: HostThreadLogRun | undefined
  readonly entry: HostTranscriptHistoryEntry | null
  readonly sequence: number
}

interface Change {
  readonly kind: HostHistoryDelta['kind']
  readonly id: string
  readonly sequence: number
}

/** What one applied batch did to the history. */
interface BatchChanges {
  readonly baseRevision: number
  readonly revision: number
  readonly changes: readonly Change[]
  readonly appended: number
  /** Entries numbered below this may have changed in a way no delta says; zero for none. */
  readonly unsaidBelow: number
}

export interface HostThreadLogHistoryOptions extends Omit<
  HostThreadLogFollowerOptions,
  'observer'
> {
  /** Batches whose changes are kept for `history.since`. */
  readonly maxRetainedBatches?: number
}

/** Why a generation began. */
export type HostThreadLogHistoryGenerationCause =
  | 'seed'
  | 'trimmed-while-changed'
  | 'added-before'
  | 'order'
  | 'added-again'
  | 'duplicate-id'
  | 'span'

export const HOST_THREAD_LOG_HISTORY_GENERATION_CAUSES: readonly HostThreadLogHistoryGenerationCause[] =
  ['seed', 'trimmed-while-changed', 'added-before', 'order', 'added-again', 'duplicate-id', 'span']

/** Why the history asked its follower for a seed before it could go on. */
export type HostThreadLogHistorySeedCause = 'older-row' | 'unresolved-run' | 'record-mismatch'

export interface HostThreadLogHistoryFreshness {
  /** The newest revision a tail page or `history.since` answered with; null before the first. */
  readonly servedRevision: number | null
  /** The follower's revision, which can be ahead of the one served. */
  readonly followedRevision: number | null
  /** The newest revision in the log: its newest segment's last line, else its checkpoint. */
  readonly logHeadRevision: number | null
  readonly revisionsBehind: number | null
  /** `savedAt` of the log's newest batch, or of its checkpoint when no segment has a line. */
  readonly headSavedAt: string | null
  /** Wall time since `headSavedAt` while the history served is behind the log; zero when it is not. */
  readonly behindMs: number | null
  /**
   * Batches the follower applied, counted by the time from the app saving
   * each to the first answer that served it: one count for each bound of
   * HOST_THREAD_LOG_HISTORY_LAG_BOUNDS_MS, and a last one for longer.
   */
  readonly servedLagCounts: readonly number[]
  /** Batches served that the counts above leave out: no time saved, or too many waiting. */
  readonly servedLagUncounted: number
}

export interface HostThreadLogHistoryStats {
  readonly generations: Readonly<Record<HostThreadLogHistoryGenerationCause, number>>
  readonly seedsAsked: Readonly<Record<HostThreadLogHistorySeedCause, number>>
  /** Batches that changed an entry before the window without moving it. */
  readonly batchesWithUnsaidChanges: number
  /** `history.since` answered by loading again, because an entry the client held was removed. */
  readonly reloadsForRemovals: number
  readonly tailPages: { readonly window: number; readonly record: number }
  readonly olderPages: { readonly window: number; readonly record: number }
  readonly recordLoads: number
  readonly deltaAnswers: number
  readonly resnapshots: Readonly<
    Record<Extract<HostHistorySinceResult, { kind: 'full_resnapshot_required' }>['reason'], number>
  >
}

export interface HostThreadLogHistoryMemory {
  readonly heldMessages: number
  readonly retainedBatches: number
  readonly retainedChanges: number
  readonly removals: number
  readonly leftWindowEntries: number
  readonly leftWindowBytes: number
  readonly runReferences: number
  readonly unserved: number
}

/** History for one thread, served from a follower of its log that it owns. */
export class HostThreadLogHistory {
  readonly chatId: string
  /** The follower this history polls. It is the follower's only observer. */
  readonly follower: HostThreadLogFollower
  private readonly seedPort: HostThreadLogFollowerOptions['seedPort']
  private readonly now: () => number
  private readonly fs: ThreadLogSegmentReaderFs
  private readonly paths: { active: string; sealed: string; checkpoint: string }
  private readonly maxRetainedBatches: number

  /** The generation clients are on; null while there is none to serve. */
  private generation: number | null = null
  private generationRevision = 0
  /** False from asking the follower for a seed until the seed arrives. */
  private settled = false
  /** Too many entries to number: requests are refused until a seed says otherwise. */
  private tooLong = false
  private held: Held[] = []
  /** Entries before the window. */
  private olderEntries = 0
  private nextSequence = 0
  /** Sequence numbers removed in this generation, ascending, with the revision of each removal. */
  private removals: Array<{ readonly sequence: number; readonly revision: number }> = []
  private removedIds = new Set<string>()
  private batches: BatchChanges[] = []
  private retainedChanges = 0
  private leftWindow = new Map<
    string,
    { readonly entry: HostTranscriptHistoryEntry; readonly bytes: number }
  >()
  private leftWindowBytes = 0
  /** Each held run id's first held run. */
  private runs = new Map<string, HostThreadLogRun>()
  /** Runs the view holds whose tool rows a shown message before the window carries. */
  private olderHeldRuns = new Set<string>()
  /** Run ids no run has that a shown message before the window names. */
  private olderMissingRuns = new Set<string>()
  private olderRunsOverflow = false

  private servedRevision: number | null = null
  private unserved: Array<{ readonly revision: number; readonly savedAt: number }> = []
  private readonly lagCounts = new Array<number>(
    HOST_THREAD_LOG_HISTORY_LAG_BOUNDS_MS.length + 1
  ).fill(0)
  private lagUncounted = 0

  private readonly generationCounts = Object.fromEntries(
    HOST_THREAD_LOG_HISTORY_GENERATION_CAUSES.map((cause) => [cause, 0])
  ) as Record<HostThreadLogHistoryGenerationCause, number>
  private readonly seedCounts: Record<HostThreadLogHistorySeedCause, number> = {
    'older-row': 0,
    'unresolved-run': 0,
    'record-mismatch': 0
  }
  private batchesWithUnsaidChanges = 0
  private reloadsForRemovals = 0
  private tailPagesFromWindow = 0
  private tailPagesFromRecord = 0
  private olderPagesFromWindow = 0
  private olderPagesFromRecord = 0
  private recordLoads = 0
  private deltaAnswers = 0
  private readonly resnapshotCounts = {
    generation_mismatch: 0,
    retention_gap: 0,
    cursor_mismatch: 0
  }

  constructor(options: HostThreadLogHistoryOptions) {
    const { maxRetainedBatches, ...followerOptions } = options
    this.chatId = options.chatId
    this.seedPort = options.seedPort
    this.now = options.now ?? Date.now
    this.fs = options.fs ?? nodeFs
    const directory = path.resolve(options.directory)
    this.paths = {
      active: path.join(directory, `${this.chatId}.mutations.jsonl`),
      sealed: path.join(directory, `${this.chatId}.sealed.mutations.jsonl`),
      checkpoint: path.join(directory, `${this.chatId}.checkpoint.json`)
    }
    this.maxRetainedBatches = maxRetainedBatches ?? HOST_THREAD_LOG_HISTORY_MAX_RETAINED_BATCHES
    if (!Number.isSafeInteger(this.maxRetainedBatches) || this.maxRetainedBatches < 0) {
      throw new RangeError('Thread log history: maxRetainedBatches must be a whole number')
    }
    this.follower = new HostThreadLogFollower({
      ...followerOptions,
      observer: {
        seeded: (record) => this.observe(() => this.seeded(record)),
        applied: (applied, trimmed) => this.observe(() => this.applied(applied, trimmed)),
        dropped: () => this.observe(() => this.reset())
      }
    })
  }

  /** A page of the thread's history: its tail, or the entries before `before`. */
  async threadHistory(request: HostThreadHistoryRequest): Promise<HostThreadHistoryPage> {
    this.assertThread(request.threadId)
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > HOST_HISTORY_MAX_PAGE_SIZE
    ) {
      throw new Error('History page size is invalid')
    }
    await this.settle()
    return request.before
      ? this.olderPage(request.before, request.limit)
      : this.tailPage(request.limit)
  }

  /** What changed after a client's cursor, as deltas, or that it must load the tail again. */
  async historySince(request: HostHistorySinceRequest): Promise<HostHistorySinceResult> {
    this.assertThread(request.threadId)
    await this.settle()
    const generation = this.generation!
    const head = this.follower.headRevision!
    const { generation: clientGeneration, cursor: clientCursor } = request.since
    const resnapshot = (
      reason: Extract<HostHistorySinceResult, { kind: 'full_resnapshot_required' }>['reason']
    ): HostHistorySinceResult => {
      this.resnapshotCounts[reason] += 1
      return {
        kind: 'full_resnapshot_required',
        threadId: this.chatId,
        generation,
        cursor: this.encode(head, 0),
        clientGeneration,
        clientCursor,
        reason
      }
    }
    if (clientGeneration !== generation) return resnapshot('generation_mismatch')
    const named = this.decode(clientCursor)
    if (!named) return resnapshot('cursor_mismatch')
    let deltas: HostHistoryDelta[] = []
    if (named.revision < head) {
      const first = this.batches.findIndex((batch) => batch.baseRevision === named.revision)
      if (first < 0) return resnapshot('retention_gap')
      const range = this.batches.slice(first)
      if (range.some((batch) => batch.unsaidBelow > named.sequence)) {
        return resnapshot('retention_gap')
      }
      const merged = this.deltasFor(range, named.sequence)
      if (merged === 'removed-held') {
        this.reloadsForRemovals += 1
        return resnapshot('retention_gap')
      }
      if (merged === 'left-window' || merged.length > HOST_HISTORY_MAX_PAGE_SIZE) {
        return resnapshot('retention_gap')
      }
      deltas = merged
    }
    this.deltaAnswers += 1
    this.served(head)
    return {
      kind: 'deltas',
      threadId: this.chatId,
      generation,
      fromCursor: clientCursor,
      toCursor: this.encode(head, named.sequence),
      deltas
    }
  }

  /** How far the history served is behind the log, by revisions and by wall time. */
  freshness(): HostThreadLogHistoryFreshness {
    const head = this.logHead()
    const served = this.servedRevision
    const behind = served === null || head === null ? null : Math.max(0, head.revision - served)
    const savedAt = head?.savedAt ? Date.parse(head.savedAt) : Number.NaN
    return {
      servedRevision: served,
      followedRevision: this.follower.headRevision,
      logHeadRevision: head?.revision ?? null,
      revisionsBehind: behind,
      headSavedAt: head?.savedAt ?? null,
      behindMs:
        behind === null
          ? null
          : behind === 0
            ? 0
            : Number.isFinite(savedAt)
              ? Math.max(0, this.now() - savedAt)
              : null,
      servedLagCounts: [...this.lagCounts],
      servedLagUncounted: this.lagUncounted
    }
  }

  stats(): HostThreadLogHistoryStats {
    return {
      generations: { ...this.generationCounts },
      seedsAsked: { ...this.seedCounts },
      batchesWithUnsaidChanges: this.batchesWithUnsaidChanges,
      reloadsForRemovals: this.reloadsForRemovals,
      tailPages: { window: this.tailPagesFromWindow, record: this.tailPagesFromRecord },
      olderPages: { window: this.olderPagesFromWindow, record: this.olderPagesFromRecord },
      recordLoads: this.recordLoads,
      deltaAnswers: this.deltaAnswers,
      resnapshots: { ...this.resnapshotCounts }
    }
  }

  memory(): HostThreadLogHistoryMemory {
    return {
      heldMessages: this.held.length,
      retainedBatches: this.batches.length,
      retainedChanges: this.retainedChanges,
      removals: this.removals.length,
      leftWindowEntries: this.leftWindow.size,
      leftWindowBytes: this.leftWindowBytes,
      runReferences: this.olderHeldRuns.size + this.olderMissingRuns.size,
      unserved: this.unserved.length
    }
  }

  close(): void {
    this.follower.close()
  }

  // ---------------------------------------------------------------------------
  // Following the follower.
  // ---------------------------------------------------------------------------

  /** A failure here must not leave numbers that no longer match the view: start again from a seed. */
  private observe(call: () => void): void {
    try {
      call()
    } catch (error) {
      this.reset()
      this.follower.requestSeed()
      throw error
    }
  }

  private reset(): void {
    this.generation = null
    this.settled = false
    this.held = []
    this.olderEntries = 0
    this.nextSequence = 0
    this.removals = []
    this.removedIds = new Set()
    this.batches = []
    this.retainedChanges = 0
    this.leftWindow = new Map()
    this.leftWindowBytes = 0
    this.runs = new Map()
    this.olderHeldRuns = new Set()
    this.olderMissingRuns = new Set()
    this.olderRunsOverflow = false
  }

  private seeded(record: HostThreadLogRecord): void {
    this.reset()
    this.tooLong = false
    const view = this.follower.view()
    if (!view) return
    // Batches applied before the seed and not served: those past it were another lineage's.
    this.unserved = this.unserved.filter((each) => {
      if (each.revision <= view.revision) return true
      this.lagUncounted += 1
      return false
    })
    this.runs = heldRuns(view)
    const messages = record.messages as HostThreadLogMessage[]
    const exists = new Set<string>()
    for (const run of record.runs as HostThreadLogRun[]) {
      if (typeof run.runId === 'string') exists.add(run.runId)
    }
    const windowStart = view.messageCount - view.messages.length
    let older = 0
    for (let index = 0; index < windowStart; index += 1) {
      const message = messages[index]
      if (!shows(message)) continue
      older += 1
      const runId = namedRun(message)
      if (runId === null) continue
      if (this.runs.has(runId)) this.olderHeldRuns.add(runId)
      else if (!exists.has(runId)) this.noteMissingRun(runId)
    }
    this.olderEntries = older
    const projected = this.project(view, null)
    this.held = projected.held
    if (projected.unresolved) {
      this.awaitSeed('unresolved-run')
      return
    }
    this.begin(view.revision, 'seed')
  }

  private applied(
    applied: HostThreadLogAppliedBatch,
    trimmed: readonly HostThreadLogMessage[]
  ): void {
    this.noteApplied(applied)
    if (this.generation === null || !this.settled) return
    const view = this.follower.view()
    if (!view) return
    const revision = applied.batch.revision
    const { effects } = applied
    if (effects.olderMessageOperations.length > 0) {
      // A message before the window changed: what is shown before it, and where, is unknown.
      this.awaitSeed('older-row')
      return
    }
    const previousRuns = this.runs
    this.runs = heldRuns(view)
    const touchedRuns = new Set(effects.runsChanged)
    const toolsChanged = new Set<string>()
    for (const runId of touchedRuns) {
      const before = previousRuns.get(runId)
      const after = this.runs.get(runId)
      if (before !== after && !isDeepStrictEqual(toolRows(before), toolRows(after))) {
        toolsChanged.add(runId)
      }
    }

    let cause: HostThreadLogHistoryGenerationCause | null = null
    const previous = new Map<HostThreadLogMessage, Held>()
    const previousById = new Map<string, Held>()
    for (const held of this.held) {
      previous.set(held.message, held)
      if (!held.entry) continue
      if (previousById.has(held.message.id)) cause = 'duplicate-id'
      previousById.set(held.message.id, held)
    }

    // Messages that left the window are entries before it now, as they were.
    const trimmedIds = new Set<string>()
    for (const message of trimmed) {
      trimmedIds.add(message.id)
      const before = previous.get(message)
      // The follower hands a changed message over as a new row: this one changed as it left.
      if (!before) cause ??= 'trimmed-while-changed'
      if (!shows(message)) continue
      this.olderEntries += 1
      const runId = namedRun(message)
      if (before?.entry && (runId === null || !toolsChanged.has(runId))) {
        this.keepLeftWindow(before.entry)
      }
      if (runId === null) continue
      if (this.runs.has(runId)) this.olderHeldRuns.add(runId)
      else if (touchedRuns.has(runId) || !previousRuns.has(runId)) this.noteMissingRun(runId)
      // Otherwise the run exists and is no longer held: a change to it arrives as an older run operation.
    }
    const unsaid =
      effects.olderRunOperations.length > 0 ||
      (this.olderRunsOverflow
        ? toolsChanged.size > 0
        : [...toolsChanged].some(
            (runId) => this.olderHeldRuns.has(runId) || this.olderMissingRuns.has(runId)
          ))
    this.settleOlderRuns(touchedRuns)

    const next = this.project(view, previous)
    if (next.unresolved) {
      this.awaitSeed('unresolved-run')
      return
    }
    if (cause === null) {
      const outcome = this.compare(previousById, next.held, trimmedIds)
      if (typeof outcome === 'string') cause = outcome
      else {
        for (const change of outcome.changes) {
          if (change.kind !== 'remove') continue
          this.removals.splice(this.removalIndex(change.sequence), 0, {
            sequence: change.sequence,
            revision
          })
          this.removedIds.add(change.id)
        }
        this.held = outcome.held
        this.nextSequence = outcome.nextSequence
        if (unsaid) this.batchesWithUnsaidChanges += 1
        this.keepBatch({
          baseRevision: applied.batch.baseRevision,
          revision,
          changes: outcome.changes,
          appended: outcome.appended,
          unsaidBelow: unsaid ? this.windowStartSequence() : 0
        })
        if (
          this.nextSequence >= HOST_THREAD_LOG_HISTORY_SEQUENCE_SPAN ||
          revision - this.generationRevision >= REVISION_SPAN ||
          this.removals.length > MAX_REMOVALS
        ) {
          this.begin(revision, 'span')
        }
        return
      }
    }
    this.held = next.held
    this.begin(revision, cause)
  }

  /**
   * The window's messages with the entries they show. A message keeps its
   * entry while the follower hands over the same row and the same run.
   */
  private project(
    view: HostThreadLogView,
    previous: ReadonlyMap<HostThreadLogMessage, Held> | null
  ): { held: Held[]; unresolved: boolean } {
    const unresolvedRuns = new Set(view.unresolvedRunIds)
    let unresolved = false
    const held = view.messages.map((message): Held => {
      const runId = namedRun(message)
      const run = runId === null ? undefined : this.runs.get(runId)
      const before = previous?.get(message)
      const entry = before && before.run === run ? before.entry : entryOf(message, run)
      if (entry && runId !== null && unresolvedRuns.has(runId)) unresolved = true
      return { message, run, entry, sequence: before?.sequence ?? -1 }
    })
    return { held, unresolved }
  }

  /**
   * One batch's changes to the window as deltas a client can apply, with the
   * window numbered; or why they cannot be said that way.
   */
  private compare(
    previousById: ReadonlyMap<string, Held>,
    next: readonly Held[],
    trimmedIds: ReadonlySet<string>
  ):
    | HostThreadLogHistoryGenerationCause
    | { held: Held[]; changes: Change[]; appended: number; nextSequence: number } {
    const nextIds = new Set<string>()
    for (const held of next) {
      if (!held.entry) continue
      const id = held.message.id
      if (nextIds.has(id) || trimmedIds.has(id) || this.leftWindow.has(id)) return 'duplicate-id'
      nextIds.add(id)
    }
    const changes: Change[] = []
    const staying: Held[] = []
    for (const held of this.held) {
      if (!held.entry || trimmedIds.has(held.message.id)) continue
      if (nextIds.has(held.message.id)) staying.push(held)
      else changes.push({ kind: 'remove', id: held.message.id, sequence: held.sequence })
    }
    const appends: Change[] = []
    const numbered: Held[] = []
    let sequence = this.nextSequence
    let at = 0
    for (const held of next) {
      if (!held.entry) {
        numbered.push({ ...held, sequence: -1 })
        continue
      }
      const id = held.message.id
      const before = previousById.get(id)
      if (before && !trimmedIds.has(id)) {
        // An entry added before one the client holds would land after it.
        if (appends.length > 0) return 'added-before'
        if (staying[at]?.message.id !== id) return 'order'
        at += 1
        if (before.entry !== held.entry && !isDeepStrictEqual(before.entry, held.entry)) {
          changes.push({ kind: 'replace', id, sequence: before.sequence })
        }
        numbered.push({ ...held, sequence: before.sequence })
        continue
      }
      if (this.removedIds.has(id)) return 'added-again'
      appends.push({ kind: 'append', id, sequence })
      numbered.push({ ...held, sequence })
      sequence += 1
    }
    return {
      held: numbered,
      changes: [...changes, ...appends],
      appended: appends.length,
      nextSequence: sequence
    }
  }

  /**
   * One list of deltas for a run of batches, for a client holding the entries
   * numbered from `from` on: each entry's last change, removals first, then
   * the rest in the order of the entries, as they stand now. A removal of an
   * entry the client held before the run is not said: the terminal app drops
   * it without taking the entry before its rows in its place, and so would
   * hold less than a page. That client loads the tail again.
   */
  private deltasFor(
    range: readonly BatchChanges[],
    from: number
  ): HostHistoryDelta[] | 'removed-held' | 'left-window' {
    const last = new Map<string, Change>()
    const appended = new Set<string>()
    for (const batch of range) {
      for (const change of batch.changes) {
        if (change.kind === 'append') appended.add(change.id)
        // An entry appended in the range is still news to a client before it.
        if (change.kind === 'replace' && last.get(change.id)?.kind === 'append') continue
        last.set(change.id, change)
      }
    }
    const deltas: HostHistoryDelta[] = []
    const upserts: Change[] = []
    for (const change of last.values()) {
      if (change.sequence < from) continue
      if (change.kind !== 'remove') upserts.push(change)
      else if (!appended.has(change.id)) return 'removed-held'
      // Appended and removed in the range: only a client that took it, after
      // an older page sent it back to an earlier cursor, still holds it.
      else deltas.push({ kind: 'remove', entryId: change.id })
    }
    upserts.sort((a, b) => a.sequence - b.sequence)
    const current = new Map<string, HostTranscriptHistoryEntry>()
    for (const held of this.held) if (held.entry) current.set(held.message.id, held.entry)
    for (const change of upserts) {
      const entry = current.get(change.id) ?? this.leftWindow.get(change.id)?.entry
      if (!entry) return 'left-window'
      deltas.push({ kind: change.kind as 'append' | 'replace', entry: structuredClone(entry) })
    }
    return deltas
  }

  private begin(revision: number, cause: HostThreadLogHistoryGenerationCause): void {
    let sequence = this.olderEntries
    this.held = this.held.map((held) => ({ ...held, sequence: held.entry ? sequence++ : -1 }))
    this.generationCounts[cause] += 1
    this.removals = []
    this.removedIds = new Set()
    this.batches = []
    this.retainedChanges = 0
    this.leftWindow = new Map()
    this.leftWindowBytes = 0
    if (sequence >= HOST_THREAD_LOG_HISTORY_SEQUENCE_SPAN) {
      this.tooLong = true
      this.generation = null
      this.settled = false
      return
    }
    this.nextSequence = sequence
    this.generationRevision = revision
    let drawn = HOST_THREAD_LOG_HISTORY_GENERATION_BASE + randomInt(2 ** 48 - 1)
    while (drawn === this.generation) {
      drawn = HOST_THREAD_LOG_HISTORY_GENERATION_BASE + randomInt(2 ** 48 - 1)
    }
    this.generation = drawn
    this.settled = true
  }

  private awaitSeed(cause: HostThreadLogHistorySeedCause): void {
    this.settled = false
    this.seedCounts[cause] += 1
    this.follower.requestSeed()
  }

  private noteMissingRun(runId: string): void {
    if (this.olderMissingRuns.has(runId)) return
    if (this.olderMissingRuns.size >= MAX_MISSING_RUN_REFERENCES) this.olderRunsOverflow = true
    else this.olderMissingRuns.add(runId)
  }

  /** Keep the run references of entries before the window in step with the runs the view holds. */
  private settleOlderRuns(touched: ReadonlySet<string>): void {
    for (const runId of this.olderHeldRuns) {
      if (this.runs.has(runId)) continue
      this.olderHeldRuns.delete(runId)
      // Gone with a change, most likely removed; untouched, it exists and is no longer held.
      if (touched.has(runId)) this.noteMissingRun(runId)
    }
    for (const runId of this.olderMissingRuns) {
      if (!this.runs.has(runId)) continue
      this.olderMissingRuns.delete(runId)
      this.olderHeldRuns.add(runId)
    }
  }

  private keepLeftWindow(entry: HostTranscriptHistoryEntry): void {
    const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8')
    this.leftWindow.set(entry.entryId, { entry, bytes })
    this.leftWindowBytes += bytes
    for (const [id, kept] of this.leftWindow) {
      if (
        this.leftWindowBytes <= MAX_LEFT_WINDOW_BYTES &&
        this.leftWindow.size <= MAX_LEFT_WINDOW_ENTRIES
      ) {
        break
      }
      this.leftWindow.delete(id)
      this.leftWindowBytes -= kept.bytes
    }
  }

  private keepBatch(batch: BatchChanges): void {
    this.batches.push(batch)
    this.retainedChanges += batch.changes.length
    while (
      this.batches.length > this.maxRetainedBatches ||
      this.retainedChanges > MAX_RETAINED_CHANGES
    ) {
      this.retainedChanges -= this.batches.shift()!.changes.length
    }
  }

  /** Where a removed number goes among those removed, which stay ascending. */
  private removalIndex(sequence: number): number {
    let low = 0
    let high = this.removals.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.removals[middle].sequence < sequence) low = middle + 1
      else high = middle
    }
    return low
  }

  private windowStartSequence(): number {
    return this.held.find((held) => held.entry)?.sequence ?? this.nextSequence
  }

  private noteApplied(applied: HostThreadLogAppliedBatch): void {
    this.unserved.push({
      revision: applied.batch.revision,
      savedAt: Date.parse(applied.batch.savedAt)
    })
    if (this.unserved.length > MAX_UNSERVED) {
      this.unserved.shift()
      this.lagUncounted += 1
    }
  }

  /** An answer at `revision` served every batch up to it. */
  private served(revision: number): void {
    if (this.servedRevision === null || revision > this.servedRevision) {
      this.servedRevision = revision
    }
    const at = this.now()
    while (this.unserved.length > 0 && this.unserved[0].revision <= revision) {
      const { savedAt } = this.unserved.shift()!
      if (!Number.isFinite(savedAt)) {
        this.lagUncounted += 1
        continue
      }
      const lag = Math.max(0, at - savedAt)
      const bucket = HOST_THREAD_LOG_HISTORY_LAG_BOUNDS_MS.findIndex((bound) => lag <= bound)
      this.lagCounts[bucket < 0 ? HOST_THREAD_LOG_HISTORY_LAG_BOUNDS_MS.length : bucket] += 1
    }
  }

  // ---------------------------------------------------------------------------
  // Pages.
  // ---------------------------------------------------------------------------

  /** Read the log and settle on a generation, or say why there is none. */
  private async settle(): Promise<void> {
    for (let polls = 0; polls < MAX_SETTLING_POLLS; polls += 1) {
      const result = await this.follower.poll()
      if (result.status !== 'following') {
        throw new Error(
          `Thread history is not available from the log: ${
            result.status === 'unfollowable' ? result.why : result.status
          }`
        )
      }
      if (this.tooLong) {
        throw new Error('Thread history is not available from the log: too many entries')
      }
      // Waiting for the seed this history asked for, which the next poll builds.
      if (this.generation === null || !this.settled) continue
      if (result.caughtUp) return
    }
    if (this.generation === null || !this.settled) {
      throw new Error('Thread history is not available from the log: no generation settled')
    }
  }

  private assertThread(threadId: string): void {
    if (threadId !== this.chatId) throw new Error('History is for another thread')
  }

  private encode(revision: number, sequence: number): number {
    return (revision - this.generationRevision) * HOST_THREAD_LOG_HISTORY_SEQUENCE_SPAN + sequence
  }

  /** The revision and sequence number a cursor of this generation names, or null for none. */
  private decode(cursor: number): { revision: number; sequence: number } | null {
    if (!Number.isSafeInteger(cursor) || cursor < 0) return null
    const span = Math.floor(cursor / HOST_THREAD_LOG_HISTORY_SEQUENCE_SPAN)
    const sequence = cursor - span * HOST_THREAD_LOG_HISTORY_SEQUENCE_SPAN
    const revision = this.generationRevision + span
    const head = this.follower.headRevision
    if (head === null || revision > head || sequence > this.nextSequence) return null
    return { revision, sequence }
  }

  private shown(): Array<{ entry: HostTranscriptHistoryEntry; sequence: number }> {
    const shown: Array<{ entry: HostTranscriptHistoryEntry; sequence: number }> = []
    for (const held of this.held)
      if (held.entry) shown.push({ entry: held.entry, sequence: held.sequence })
    return shown
  }

  private page(
    revision: number,
    sequence: number,
    entries: readonly HostTranscriptHistoryEntry[],
    older: boolean
  ): HostThreadHistoryPage {
    const generation = this.generation!
    const cursor = this.encode(revision, sequence)
    return {
      threadId: this.chatId,
      generation,
      cursor,
      entries: entries.map((entry) => structuredClone(entry)),
      ...(older ? { nextBefore: { generation, cursor } } : {})
    }
  }

  private async tailPage(limit: number): Promise<HostThreadHistoryPage> {
    const shown = this.shown()
    if (shown.length >= limit || this.olderEntries === 0) {
      const entries = shown.slice(Math.max(0, shown.length - limit))
      const head = this.follower.headRevision!
      this.tailPagesFromWindow += 1
      this.served(head)
      return this.page(
        head,
        entries[0]?.sequence ?? this.nextSequence,
        entries.map((each) => each.entry),
        this.olderEntries + shown.length > entries.length
      )
    }
    return this.pageFromRecord(null, limit)
  }

  private async olderPage(
    before: HostHistoryCursor,
    limit: number
  ): Promise<HostThreadHistoryPage> {
    if (before.generation !== this.generation) throw new Error('History generation mismatch')
    const named = this.decode(before.cursor)
    if (!named) throw new Error('History cursor is invalid')
    const shown = this.shown().filter((each) => each.sequence < named.sequence)
    if (shown.length >= limit || this.olderEntries === 0) {
      const entries = shown.slice(Math.max(0, shown.length - limit))
      this.olderPagesFromWindow += 1
      return this.page(
        named.revision,
        entries[0]?.sequence ?? named.sequence,
        entries.map((each) => each.entry),
        this.olderEntries + shown.length > entries.length
      )
    }
    return this.pageFromRecord(named, limit)
  }

  /**
   * A page from the whole record: the tail when `named` is null, else the
   * entries numbered below `named.sequence`. The follower is brought to the
   * record's revision first, so that it has seen every batch up to it and any
   * generation that began on the way.
   */
  private async pageFromRecord(
    named: { readonly revision: number; readonly sequence: number } | null,
    limit: number
  ): Promise<HostThreadHistoryPage> {
    const generation = this.generation
    for (let load = 0; load < MAX_RECORD_LOADS; load += 1) {
      this.recordLoads += 1
      const record = await this.seedPort.seed({ chatId: this.chatId, reason: 'requested' })
      if (
        !record ||
        record.appChatId !== this.chatId ||
        !Array.isArray(record.messages) ||
        !Array.isArray(record.runs)
      ) {
        throw new Error('Thread history is not available from the log: absent')
      }
      const revision = revisionOf(record)
      for (let polls = 0; polls < MAX_CATCH_UP_POLLS; polls += 1) {
        const head = this.follower.headRevision
        if (head !== null && head >= revision && this.settled) break
        await this.settle()
      }
      if (named && this.generation !== generation) throw new Error('History generation mismatch')
      if (this.generation === null || !this.settled) {
        throw new Error('Thread history is not available from the log: no generation settled')
      }
      const head = this.follower.headRevision!
      // Loaded before the generation began, or past what the follower reached: load again.
      if (revision < this.generationRevision || revision > head) continue
      if (named && named.revision > revision) continue
      const then = this.numbersAt(revision)
      if (!then) continue
      const all = hostThreadLogHistoryEntries(record)
      if (all.length !== then.count || (revision === head && !this.windowMatches(all))) {
        this.awaitSeed('record-mismatch')
        throw new Error('Thread history from the log does not match its record; ask again')
      }
      const end = named ? named.sequence - countBelow(then.removed, named.sequence) : all.length
      const start = Math.max(0, end - limit)
      const entries = all.slice(start, end)
      const sequence =
        entries.length > 0 ? sequenceAt(start, then.removed) : (named?.sequence ?? then.next)
      if (named) this.olderPagesFromRecord += 1
      else {
        this.tailPagesFromRecord += 1
        this.served(revision)
      }
      return this.page(named ? named.revision : revision, sequence, entries, start > 0)
    }
    throw new Error('Thread history could not settle on a revision; ask again')
  }

  /** The numbering as it stood at `revision`: the next number, and those removed by then. */
  private numbersAt(revision: number): { next: number; removed: number[]; count: number } | null {
    let next = this.nextSequence
    if (revision < this.follower.headRevision!) {
      const first = this.batches.findIndex((batch) => batch.revision > revision)
      if (first < 0 || this.batches[first].baseRevision !== revision) return null
      for (let index = first; index < this.batches.length; index += 1) {
        next -= this.batches[index].appended
      }
    }
    const removed = this.removals
      .filter((each) => each.revision <= revision)
      .map((each) => each.sequence)
    return { next, removed, count: next - removed.length }
  }

  /** The record's entries end with the window's, as the history numbered them. */
  private windowMatches(all: readonly HostTranscriptHistoryEntry[]): boolean {
    const shown = this.shown()
    if (all.length - shown.length !== this.olderEntries) return false
    return shown.every((each, index) =>
      isDeepStrictEqual(all[this.olderEntries + index], each.entry)
    )
  }

  // ---------------------------------------------------------------------------
  // The log's head, for freshness. Read only, and bounded.
  // ---------------------------------------------------------------------------

  private logHead(): { revision: number; savedAt: string | null } | null {
    for (const filePath of [this.paths.active, this.paths.sealed]) {
      const line = this.lastLine(filePath)
      if (line === 'unreadable') return null
      if (line) return line
    }
    return this.checkpointHead()
  }

  /** The last whole line of a segment; null when there is no segment or no whole line. */
  private lastLine(
    filePath: string
  ): { revision: number; savedAt: string | null } | 'unreadable' | null {
    const fs = this.fs
    let fd: number
    try {
      fd = fs.openSync(
        filePath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
      )
    } catch (error) {
      return isNotFound(error) ? null : 'unreadable'
    }
    try {
      const stat = fs.fstatSync(fd, { bigint: true })
      if (!stat.isFile()) return 'unreadable'
      const size = Number(stat.size)
      // The bytes from `from` to the end, read back a piece at a time until
      // they hold the last newline and the one before it.
      let from = size
      let tail = Buffer.alloc(0)
      let end = -1
      while (from > 0 && size - from < MAX_TAIL_BYTES) {
        const length = Math.min(TAIL_CHUNK_BYTES, from)
        from -= length
        const piece = Buffer.alloc(length)
        let read = 0
        while (read < length) {
          const count = fs.readSync(fd, piece, read, length - read, from + read)
          if (count === 0) return 'unreadable'
          read += count
        }
        tail = Buffer.concat([piece, tail])
        if (end < 0) {
          const at = tail.lastIndexOf(0x0a)
          if (at < 0) continue
          end = from + at
        }
        const before = end - from > 0 ? tail.lastIndexOf(0x0a, end - from - 1) : -1
        if (before < 0 && from > 0) continue
        const batch = JSON.parse(tail.toString('utf8', before + 1, end - from)) as {
          revision?: unknown
          savedAt?: unknown
        }
        if (!Number.isSafeInteger(batch.revision)) return 'unreadable'
        return {
          revision: batch.revision as number,
          savedAt: typeof batch.savedAt === 'string' ? batch.savedAt : null
        }
      }
      return end < 0 && from === 0 ? null : 'unreadable'
    } catch {
      return 'unreadable'
    } finally {
      fs.closeSync(fd)
    }
  }

  private checkpointHead(): { revision: number; savedAt: string | null } | null {
    const fs = this.fs
    let fd: number
    try {
      fd = fs.openSync(
        this.paths.checkpoint,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
      )
    } catch {
      return null
    }
    try {
      const buffer = Buffer.alloc(CHECKPOINT_HEADER_BYTES)
      let length = 0
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, length)
        if (count === 0) break
        length += count
      }
      const text = buffer.toString('utf8', 0, length)
      // The journal writes the record last, after the fields read here.
      const recordAt = text.indexOf(',"record":')
      if (recordAt < 0) return null
      const header = JSON.parse(`${text.slice(0, recordAt)}}`) as {
        chatId?: unknown
        revision?: unknown
        savedAt?: unknown
      }
      if (header.chatId !== this.chatId || !Number.isSafeInteger(header.revision)) return null
      return {
        revision: header.revision as number,
        savedAt: typeof header.savedAt === 'string' ? header.savedAt : null
      }
    } catch {
      return null
    } finally {
      fs.closeSync(fd)
    }
  }
}
