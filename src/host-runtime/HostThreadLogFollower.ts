/**
 * The Host's reader of a thread whose log another process writes.
 *
 * While the desktop app owns a thread, the thread's changes reach the Host
 * through its log rather than through copies of the whole record: the app
 * appends them under `chat-journal-v2/`, and this follows those files as they
 * grow. It reads them in the order the app's own load does (the checkpoint,
 * then the sealed segment a compaction is folding, then the active segment)
 * and takes the longest chain of batches it can, never reading more strictly
 * than that load. It never writes, repairs, watches a file or starts a timer:
 * its caller says when to read (`poll`), and each call does a bounded amount
 * of work on the event loop.
 *
 * It keeps a bounded view of the thread: the record without its transcript,
 * the newest messages, the newest runs and any older run a held message names.
 * Each batch is applied with the shared apply code, one operation at a time, to
 * just the rows that operation touches. An operation on a row the view does
 * not hold cannot change a row it does hold, so it is noted rather than applied
 * and needs no reseed. The view is built again from a seed, a whole record that
 * a port loads off the event loop, only when the log cannot take it forward:
 * the lines it needs were folded away, the thread was re-anchored, or the bytes
 * it had read were rewritten.
 *
 * Why no batch is missed or applied twice, however the app's files move:
 * - Only a batch that continues the view's revision is applied.
 * - Every segment is made under the active name. The follower holds the file
 *   it reads, so a rename to the sealed name, or an unlink, loses nothing: the
 *   segment reader reads a file that has left its name to its end.
 * - When the files it holds have nothing more, it looks at both names. A file
 *   it never held is either under the sealed name, since the next file is made
 *   under the active name only after this one left it, or gone, folded into a
 *   checkpoint whose revision then passes the view's: that forces a reseed.
 * - It looks at the active name first, so a file renamed between the two
 *   looks is seen at one of them, and opens the sealed file first, as the
 *   older. It reads a file only if it is the one its look found: a name that
 *   held another file by the open sends it to look at both names again, rather
 *   than read a newer file before the one that moved on.
 *
 * Why it does not mix two lineages: the checkpoint is looked at after the
 * names, and a file is read only if it is the one seen at its name. A segment
 * made after a re-anchor is under a name only once the re-anchor's checkpoint
 * is in place, so the look that follows finds that checkpoint, which forces a
 * reseed. Should a fold replace it first, a file new to the view that repeats
 * a revision the view has forces one too. Not caught: a re-anchor at exactly
 * the view's revision whose checkpoint a fold replaced before any look, as its
 * lines continue the view and repeat nothing. No checkpoint names its lineage;
 * the design has the app re-anchor only before a claim is granted.
 *
 * Damage is met as the app's own load meets it. A line that is not a batch,
 * or a batch that does not continue the chain, ends what its segment adds
 * (`stoppedAt`) until the file leaves its name or a checkpoint passes it. A
 * segment cut below or changed before what was read, or a line too long to
 * read here, is answered with a seed; a batch the apply code refuses, with one
 * seed, and then the view holds before it.
 */
import * as nodeFs from 'node:fs'
import * as path from 'node:path'

import { applyThreadLogBatch, type ThreadLogRecord } from '../host-shared/thread-log/ThreadLogApply'
import {
  THREAD_LOG_BATCH_FORMAT,
  THREAD_LOG_BATCH_VERSION,
  type ThreadLogBatch,
  type ThreadLogMessage,
  type ThreadLogOperation,
  type ThreadLogRun
} from '../host-shared/thread-log/ThreadLogBatch'
import {
  THREAD_LOG_SEGMENT_MAX_LINE_BYTES,
  THREAD_LOG_SEGMENT_MAX_READ_BYTES,
  openThreadLogSegmentReader,
  type ThreadLogSegmentFileStat,
  type ThreadLogSegmentReader,
  type ThreadLogSegmentReaderFs
} from '../host-shared/thread-log/ThreadLogSegmentReader'

/**
 * Messages the view holds by default. The terminal app asks for a tail of 50
 * history entries and the wire allows 100; a round of the largest ensemble adds
 * about 51 messages. 256 holds the tail page several times over, and the rows
 * the history skips (tool rows, empty rows) besides.
 */
export const HOST_THREAD_LOG_WINDOW_MESSAGES = 256
/** Runs the view holds by default: an assistant reply has one run, so this matches the messages. */
export const HOST_THREAD_LOG_WINDOW_RUNS = 256
/**
 * Bytes, as JSON, the view may hold for one thread by default: the record
 * without its transcript, the held messages and the held runs. When the
 * newest messages are large the window holds fewer of them.
 */
export const HOST_THREAD_LOG_MAX_VIEW_BYTES = 7 * 1024 * 1024
/**
 * Bytes of applied batches kept for one thread by default, for clients that
 * ask what changed since a revision. The terminal app asks every 5 s; the
 * heaviest thread measured wrote about 3 MB of changes in 2 min, so this
 * keeps about 40 s of it. With the view's bytes, a thread holds at most 8 MiB.
 */
export const HOST_THREAD_LOG_MAX_RETAINED_BYTES = 1024 * 1024
/** Applied batches kept for one thread by default, whatever their size. */
export const HOST_THREAD_LOG_MAX_RETAINED_BATCHES = 4096
/** Threads followed at once by default; the least recently used is dropped. */
export const HOST_THREAD_LOG_MAX_THREADS = 16

/** Enough of a checkpoint file to hold every field written before its record. */
const CHECKPOINT_HEADER_BYTES = 4096
const CHECKPOINT_FORMAT = 'taskwraith-chat-checkpoint'
/** Checkpoints that start a lineage rather than fold the log's own lines. */
const LINEAGE_REASONS: ReadonlySet<string> = new Set(['recovery', 'initial'])
/** The journal names files only for ids of this shape. */
const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/
/** Seeds one poll may ask for before it hands back, so a thread that keeps moving cannot hold it. */
const MAX_SEEDS_PER_POLL = 3
/** Steps one poll may take between files, past which it hands back. */
const MAX_STEPS_PER_POLL = 64
/**
 * Files remembered as met since the seed. A file leaves the names within two
 * rotations, so this is ample; a file forgotten is only read as new again.
 */
const KNOWN_FILES = 16
/** How much of a long line is read at a time when looking for its end. */
const LINE_END_CHUNK_BYTES = 64 * 1024

/** A transcript row as the follower holds it: what the log addresses it by, and the rest. */
export type HostThreadLogMessage = ThreadLogMessage & { readonly [key: string]: unknown }
export type HostThreadLogRun = ThreadLogRun & { readonly [key: string]: unknown }

/** A thread's whole record, as a seed hands it over. */
export interface HostThreadLogRecord extends ThreadLogRecord {
  readonly [key: string]: unknown
}

/** Why a view was built from a seed. */
export type HostThreadLogSeedReason =
  /** The first view of the thread, or the first since the thread had no log. */
  | 'cold'
  /** A checkpoint passed the view's revision and no file the follower can read continues it. */
  | 'checkpoint-passed'
  /**
   * The lines ahead may be another lineage: a re-anchor or a first checkpoint
   * replaced the checkpoint, or a file met for the first time since the seed
   * repeats revisions the view already has.
   */
  | 'lineage'
  /** A segment it had read was cut below, or changed before, what it had read. */
  | 'rewritten'
  /** A line too long to read on the event loop. */
  | 'oversized'
  /**
   * A batch the shared apply code refuses for the rows the view holds. When
   * the seed's view refuses it too, the follower holds before it instead of
   * asking again.
   */
  | 'unapplicable'
  /** Its user asked, for instance because a held message names a run the view lacks. */
  | 'requested'

export const HOST_THREAD_LOG_SEED_REASONS: readonly HostThreadLogSeedReason[] = [
  'cold',
  'checkpoint-passed',
  'lineage',
  'rewritten',
  'oversized',
  'unapplicable',
  'requested'
]

export interface HostThreadLogSeedRequest {
  readonly chatId: string
  readonly reason: HostThreadLogSeedReason
}

/** Loads a thread's record off the event loop. */
export interface HostThreadLogSeedPort {
  /**
   * The thread's record at the head of its log, as the app's own load builds
   * it when it leaves syncing to the thread barrier: the checkpoint and the
   * longest chain of lines from it. Null when the thread has no checkpoint.
   * The follower takes the record over and never changes its rows.
   */
  seed(request: HostThreadLogSeedRequest): Promise<HostThreadLogRecord | null>
}

/** What one applied batch did to the view. */
export interface HostThreadLogBatchEffects {
  /** Held messages it added or changed, by id. */
  readonly messagesChanged: readonly string[]
  /** Of those, the ones it added. */
  readonly messagesAdded: readonly string[]
  /** Held messages it removed, by id. */
  readonly messagesRemoved: readonly string[]
  /** It added a message anywhere but after the last one, or removed one: positions moved. */
  readonly messagesMoved: boolean
  /** Indexes into the batch's operations of those that touched messages the view does not hold. */
  readonly olderMessageOperations: readonly number[]
  /** Held runs it added, changed or removed, by run id. */
  readonly runsChanged: readonly string[]
  /** Indexes into the batch's operations of those that touched runs the view does not hold. */
  readonly olderRunOperations: readonly number[]
  /** It changed the record outside the transcript. */
  readonly shellChanged: boolean
}

export interface HostThreadLogAppliedBatch {
  readonly batch: ThreadLogBatch
  /** Bytes of its line in the log. */
  readonly bytes: number
  /** When the follower applied it, by the follower's clock. */
  readonly appliedAt: number
  readonly effects: HostThreadLogBatchEffects
}

export type HostThreadLogDropReason = 'absent' | 'unfollowable' | 'reseed' | 'closed'

/**
 * Where a segment stops adding to the view: a line that is not a batch, a
 * batch that does not continue the chain (the app's own load stops at both),
 * or a batch that the shared apply code refused even for a seed's view.
 */
export type HostThreadLogStop = 'corrupt' | 'gap' | 'unapplicable'

/** Told, in order, everything that happens to a follower's view. */
export interface HostThreadLogFollowerObserver {
  /** A view was built from `record`, the whole record the seed returned. */
  seeded?(record: HostThreadLogRecord): void
  /** A batch was applied. `trimmed` are the messages that left the window after it, oldest first. */
  applied?(applied: HostThreadLogAppliedBatch, trimmed: readonly HostThreadLogMessage[]): void
  /** The view was dropped. */
  dropped?(reason: HostThreadLogDropReason): void
}

export interface HostThreadLogHeldRun {
  /** The run's position in the record's runs. */
  readonly index: number
  readonly run: HostThreadLogRun
}

export interface HostThreadLogView {
  readonly chatId: string
  readonly revision: number
  /** `savedAt` of the newest batch applied since the seed; null right after a seed. */
  readonly savedAt: string | null
  /** Every field of the record but `messages` and `runs`. Never changed once handed out. */
  readonly shell: Readonly<Record<string, unknown>>
  readonly messageCount: number
  /** The newest messages: `messages[i]` is the record's message `messageCount - messages.length + i`. */
  readonly messages: readonly HostThreadLogMessage[]
  readonly runCount: number
  /** The runs held, by position: the newest ones, and any older one a held message names. */
  readonly runs: readonly HostThreadLogHeldRun[]
  /** Runs a held message names that the view neither holds nor knows to be missing. */
  readonly unresolvedRunIds: readonly string[]
}

export type HostThreadLogPollResult =
  | {
      readonly status: 'following'
      readonly revision: number
      /** False when the call handed back before the end of the log: call again without waiting. */
      readonly caughtUp: boolean
      /** Batches applied by this call. */
      readonly applied: number
      /** Set while the view cannot go past a segment's damage. */
      readonly stoppedAt: HostThreadLogStop | null
    }
  /** The thread has no log to follow: no checkpoint, or it was deleted. */
  | { readonly status: 'absent' }
  /**
   * The seed was behind the log's checkpoint, or the record without its
   * transcript is larger than the view may hold. Tried again once the
   * checkpoint changes.
   */
  | { readonly status: 'unfollowable'; readonly why: 'seed-behind-checkpoint' | 'over-budget' }

export interface HostThreadLogFollowerOptions {
  readonly chatId: string
  /** The journal's directory: `<profile>/chat-journal-v2`. */
  readonly directory: string
  readonly seedPort: HostThreadLogSeedPort
  /** Defaults to {@link HOST_THREAD_LOG_WINDOW_MESSAGES}. */
  readonly windowMessages?: number
  /** Defaults to {@link HOST_THREAD_LOG_WINDOW_RUNS}. */
  readonly windowRuns?: number
  /** Defaults to {@link HOST_THREAD_LOG_MAX_VIEW_BYTES}. */
  readonly maxViewBytes?: number
  /** Defaults to {@link HOST_THREAD_LOG_MAX_RETAINED_BYTES}. */
  readonly maxRetainedBytes?: number
  /** Defaults to {@link HOST_THREAD_LOG_MAX_RETAINED_BATCHES}. */
  readonly maxRetainedBatches?: number
  /**
   * Bytes of log one poll reads before it hands back. It may go past them by
   * one piece the segment reader reads at a time (64 KiB) and the line it is
   * in, as a line is never split. Defaults to the segment reader's read size.
   */
  readonly maxPollBytes?: number
  /**
   * A line longer than this is not read on the event loop: the view is built
   * from a seed instead, and the file is read on from after the line.
   * Defaults to the segment reader's limit.
   */
  readonly maxLineBytes?: number
  readonly observer?: HostThreadLogFollowerObserver
  readonly now?: () => number
  /** Fault-injection seam; production reads through `node:fs`. None of its calls can change a file. */
  readonly fs?: ThreadLogSegmentReaderFs
}

export interface HostThreadLogFollowerStats {
  /** Views built from a seed, for each reason. */
  readonly seeds: Readonly<Record<HostThreadLogSeedReason, number>>
  /** Seeds refused because they were behind the log's checkpoint. */
  readonly seedsRefused: number
  readonly batchesApplied: number
  /** Lines passed over because the view already held them. */
  readonly duplicatesPassed: number
  readonly bytesRead: number
  readonly segmentsOpened: number
  /** Times a segment stopped adding to the view, for each cause. */
  readonly stops: Readonly<Record<HostThreadLogStop, number>>
  /** Operations noted rather than applied because their row is not in the view. */
  readonly olderMessageOperations: number
  readonly olderRunOperations: number
  readonly observerFailures: number
}

export interface HostThreadLogFollowerMemory {
  /** Bytes, as JSON, of the record without its transcript, the held messages and the held runs. */
  readonly viewBytes: number
  /** Bytes of the retained batches' lines. */
  readonly retainedBytes: number
  readonly messages: number
  readonly runs: number
  readonly retainedBatches: number
  /** Descriptors the follower holds open. */
  readonly openFiles: number
}

interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

interface CheckpointHead {
  readonly identity: FileIdentity & { readonly size: bigint; readonly mtimeNs: bigint }
  readonly revision: number
  readonly reason: string
}

type SegmentRole = 'sealed' | 'active'

interface Source {
  readonly role: SegmentRole
  readonly identity: FileIdentity
  readonly reader: ThreadLogSegmentReader
  offset: number
  /** `reading` until read to its end after leaving its name; `stopped` at damage. */
  state: 'reading' | 'finished' | 'stopped'
  stop: HostThreadLogStop | null
  /** Neither under a name when the view was seeded nor opened since: every line in it is new. */
  readonly fresh: boolean
}

interface HeldRun {
  readonly index: number
  readonly run: HostThreadLogRun
  readonly bytes: number
}

/** A batch being applied: copies of what it changes, kept apart until every operation has worked. */
interface Staging {
  shell: Record<string, unknown> | null
  messages: HostThreadLogMessage[]
  messageBytes: number[]
  messageCount: number
  runs: HeldRun[]
  runsFrom: number
  runCount: number
  touched: Set<string>
  inserted: Set<string>
  removed: Set<string>
  moved: boolean
  olderMessageOperations: number[]
  runsChanged: Set<string>
  insertedRunIds: Set<string>
  removedRunIds: Set<string>
  olderRunOperations: number[]
  shellChanged: boolean
}

type Step =
  | { readonly kind: 'caught-up' | 'more' | 'absent' }
  | { readonly kind: 'reseed'; readonly reason: HostThreadLogSeedReason }

function wholeNumber(
  value: number | undefined,
  fallback: number,
  least: number,
  name: string
): number {
  const chosen = value ?? fallback
  if (!Number.isSafeInteger(chosen) || chosen < least) {
    throw new RangeError(`Thread log follower: ${name} must be a whole number of at least ${least}`)
  }
  return chosen
}

function revisionOf(record: { readonly persistenceRevision?: number }): number {
  const revision = record.persistenceRevision
  return Number.isSafeInteger(revision) && (revision as number) >= 0 ? (revision as number) : 0
}

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
}

/**
 * Bytes a string adds to the JSON of the string it is appended to. JSON
 * escapes one character at a time, so this is exact, except for a surrogate
 * pair cut between two appends, which it counts as larger than it is.
 */
function appendedJsonBytes(text: string): number {
  return jsonBytes(text) - 2
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function runIdOf(run: unknown): string | null {
  const id = (run as { runId?: unknown } | null)?.runId
  return typeof id === 'string' ? id : null
}

function runNamedBy(message: unknown): string | null {
  const id = (message as { runId?: unknown } | null)?.runId
  return typeof id === 'string' ? id : null
}

/** As the shared apply code checks a splice, before a view's rows are touched. */
function assertSpliceBounds(
  length: number,
  index: number,
  deleteCount: number,
  label: string
): void {
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(deleteCount) ||
    index < 0 ||
    deleteCount < 0 ||
    index > length ||
    index + deleteCount > length
  ) {
    throw new Error(`${label} splice is out of bounds`)
  }
}

/**
 * Follows one thread's log. Not safe to share between two callers that both
 * expect to see every batch: an observer is told of each one, in order.
 */
export class HostThreadLogFollower {
  readonly chatId: string
  private readonly fs: ThreadLogSegmentReaderFs
  private readonly readerFs: ThreadLogSegmentReaderFs
  private readonly seedPort: HostThreadLogSeedPort
  private readonly observer: HostThreadLogFollowerObserver | undefined
  private readonly now: () => number
  private readonly windowMessages: number
  private readonly windowRuns: number
  private readonly maxViewBytes: number
  private readonly maxRetainedBytes: number
  private readonly maxRetainedBatches: number
  private readonly maxPollBytes: number
  private readonly maxLineBytes: number
  private readonly paths: {
    readonly checkpoint: string
    readonly sealed: string
    readonly active: string
    readonly tombstone: string
  }

  private closed = false
  private polling: Promise<HostThreadLogPollResult> | null = null
  private state: 'unseeded' | 'following' | 'absent' | 'unfollowable' = 'unseeded'
  private seedDue: HostThreadLogSeedReason | null = 'cold'
  private unfollowable: {
    readonly why: 'seed-behind-checkpoint' | 'over-budget'
    readonly checkpoint: CheckpointHead['identity'] | null
  } | null = null

  // The view.
  private revision = 0
  private savedAt: string | null = null
  private shell: Record<string, unknown> = {}
  private shellBytes = 2
  private messages: HostThreadLogMessage[] = []
  private messageBytes: number[] = []
  private messagesBytes = 0
  private messageCount = 0
  private runs: HeldRun[] = []
  /** Every run at or after this position is held. */
  private runsFrom = 0
  private runsBytes = 0
  private runCount = 0
  /** Held messages naming each run id. */
  private runReferences = new Map<string, number>()
  /** Run ids a held message names that the record is known not to have. */
  private missingRunIds = new Set<string>()
  /** Held ids that an older row shares: the log's operations reach the older row first. */
  private ambiguousMessageIds = new Set<string>()
  private ambiguousRunIds = new Set<string>()

  // Following.
  private sources: Source[] = []
  private checkpoint: CheckpointHead | null = null
  private stoppedAt: HostThreadLogStop | null = null
  private lastOpened: FileIdentity | null = null
  /** Where a line too long to read starts: after a seed, that file is read from past it. */
  private longLine: { readonly identity: FileIdentity; readonly offset: number } | null = null
  /** The revision of a batch the view refused, until the view passes it. */
  private refusedRevision: number | null = null
  /** Files the view may meet again: those under either name after its seed, and each opened since. */
  private knownFiles: FileIdentity[] = []

  // Retained batches.
  private retained: HostThreadLogAppliedBatch[] = []
  private retainedBytes = 0

  // Counters.
  private readonly seeds = Object.fromEntries(
    HOST_THREAD_LOG_SEED_REASONS.map((reason) => [reason, 0])
  ) as Record<HostThreadLogSeedReason, number>
  private seedsRefused = 0
  private batchesApplied = 0
  private duplicatesPassed = 0
  private bytesRead = 0
  private segmentsOpened = 0
  private readonly stops: Record<HostThreadLogStop, number> = {
    corrupt: 0,
    gap: 0,
    unapplicable: 0
  }
  private olderMessageOperations = 0
  private olderRunOperations = 0
  private observerFailures = 0

  constructor(options: HostThreadLogFollowerOptions) {
    if (!CHAT_ID_PATTERN.test(options.chatId)) {
      throw new Error('Thread log follower: unsafe chat id')
    }
    this.chatId = options.chatId
    this.fs = options.fs ?? nodeFs
    this.seedPort = options.seedPort
    this.observer = options.observer
    this.now = options.now ?? Date.now
    this.windowMessages = wholeNumber(
      options.windowMessages,
      HOST_THREAD_LOG_WINDOW_MESSAGES,
      0,
      'windowMessages'
    )
    this.windowRuns = wholeNumber(options.windowRuns, HOST_THREAD_LOG_WINDOW_RUNS, 0, 'windowRuns')
    this.maxViewBytes = wholeNumber(
      options.maxViewBytes,
      HOST_THREAD_LOG_MAX_VIEW_BYTES,
      1,
      'maxViewBytes'
    )
    this.maxRetainedBytes = wholeNumber(
      options.maxRetainedBytes,
      HOST_THREAD_LOG_MAX_RETAINED_BYTES,
      0,
      'maxRetainedBytes'
    )
    this.maxRetainedBatches = wholeNumber(
      options.maxRetainedBatches,
      HOST_THREAD_LOG_MAX_RETAINED_BATCHES,
      0,
      'maxRetainedBatches'
    )
    this.maxPollBytes = wholeNumber(
      options.maxPollBytes,
      THREAD_LOG_SEGMENT_MAX_READ_BYTES,
      1,
      'maxPollBytes'
    )
    this.maxLineBytes = wholeNumber(
      options.maxLineBytes,
      THREAD_LOG_SEGMENT_MAX_LINE_BYTES,
      1,
      'maxLineBytes'
    )
    const directory = path.resolve(options.directory)
    this.paths = {
      checkpoint: path.join(directory, `${this.chatId}.checkpoint.json`),
      sealed: path.join(directory, `${this.chatId}.sealed.mutations.jsonl`),
      active: path.join(directory, `${this.chatId}.mutations.jsonl`),
      tombstone: path.join(directory, `${this.chatId}.tombstone`)
    }
    const fs = this.fs
    // The segment reader opens files itself; this learns which file each one holds.
    this.readerFs = {
      constants: fs.constants,
      openSync: (filePath, flags) => {
        const fd = fs.openSync(filePath, flags)
        try {
          const stat = fs.fstatSync(fd, { bigint: true })
          this.lastOpened = { dev: stat.dev, ino: stat.ino }
        } catch (error) {
          fs.closeSync(fd)
          throw error
        }
        return fd
      },
      fstatSync: (fd, statOptions) => fs.fstatSync(fd, statOptions),
      lstatSync: (filePath, statOptions) => fs.lstatSync(filePath, statOptions),
      readSync: (fd, buffer, offset, length, position) =>
        fs.readSync(fd, buffer, offset, length, position),
      closeSync: (fd) => fs.closeSync(fd)
    }
  }

  /**
   * Read what has arrived and apply it. Concurrent calls share one poll. A
   * call that returns `caughtUp: false` handed back early: call again.
   */
  poll(): Promise<HostThreadLogPollResult> {
    if (this.closed) return Promise.reject(new Error('Thread log follower is closed'))
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = null
    })
    return this.polling
  }

  /** Build the view again from a seed at the next poll. */
  requestSeed(): void {
    if (this.state === 'following') this.seedDue = 'requested'
  }

  /** The view, or null while there is none. */
  view(): HostThreadLogView | null {
    if (this.state !== 'following') return null
    const held = new Set(this.runs.map((each) => runIdOf(each.run)))
    return {
      chatId: this.chatId,
      revision: this.revision,
      savedAt: this.savedAt,
      shell: this.shell,
      messageCount: this.messageCount,
      messages: this.messages.slice(),
      runCount: this.runCount,
      runs: this.runs.map(({ index, run }) => ({ index, run })),
      unresolvedRunIds: [...this.runReferences.keys()].filter(
        (runId) => !held.has(runId) && !this.missingRunIds.has(runId)
      )
    }
  }

  /** The view's revision, or null while there is none. */
  get headRevision(): number | null {
    return this.state === 'following' ? this.revision : null
  }

  /**
   * The batches applied after `revision`, oldest first, while every one of
   * them is still retained; null when some are not, or the revision is not one
   * the view passed through since its seed.
   */
  appliedSince(revision: number): readonly HostThreadLogAppliedBatch[] | null {
    if (this.state !== 'following' || revision > this.revision) return null
    if (revision === this.revision) return []
    const first = this.retained.findIndex((applied) => applied.batch.baseRevision === revision)
    return first < 0 ? null : this.retained.slice(first)
  }

  stats(): HostThreadLogFollowerStats {
    return {
      seeds: { ...this.seeds },
      seedsRefused: this.seedsRefused,
      batchesApplied: this.batchesApplied,
      duplicatesPassed: this.duplicatesPassed,
      bytesRead: this.bytesRead,
      segmentsOpened: this.segmentsOpened,
      stops: { ...this.stops },
      olderMessageOperations: this.olderMessageOperations,
      olderRunOperations: this.olderRunOperations,
      observerFailures: this.observerFailures
    }
  }

  memory(): HostThreadLogFollowerMemory {
    return {
      viewBytes: this.viewBytes(),
      retainedBytes: this.retainedBytes,
      messages: this.messages.length,
      runs: this.runs.length,
      retainedBatches: this.retained.length,
      openFiles: this.sources.length
    }
  }

  /** Release every descriptor and drop the view. A poll in flight ends without changing anything. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.dropView('closed')
  }

  private async pollOnce(): Promise<HostThreadLogPollResult> {
    let seeded = 0
    let applied = 0
    for (;;) {
      if (this.closed) return { status: 'absent' }
      if (this.state === 'unfollowable') {
        if (!this.checkpointChangedSinceRefusal()) {
          return { status: 'unfollowable', why: this.unfollowable!.why }
        }
        this.seedDue = 'cold'
      } else if (this.state === 'absent') {
        if (!this.hasCheckpoint()) return { status: 'absent' }
        this.seedDue = 'cold'
      }
      if (this.seedDue !== null) {
        if (seeded >= MAX_SEEDS_PER_POLL) {
          return {
            status: 'following',
            revision: this.revision,
            caughtUp: false,
            applied,
            stoppedAt: this.stoppedAt
          }
        }
        seeded += 1
        const outcome = await this.seed(this.seedDue)
        if (outcome !== null) return outcome
        continue
      }
      const before = this.batchesApplied
      const step = this.advance()
      applied += this.batchesApplied - before
      if (step.kind === 'reseed') {
        this.seedDue = step.reason
        continue
      }
      if (step.kind === 'absent') {
        this.dropView('absent')
        this.state = 'absent'
        return { status: 'absent' }
      }
      if (this.state === 'unfollowable') {
        return { status: 'unfollowable', why: this.unfollowable!.why }
      }
      return {
        status: 'following',
        revision: this.revision,
        caughtUp: step.kind === 'caught-up',
        applied,
        stoppedAt: step.kind === 'caught-up' ? this.stoppedAt : null
      }
    }
  }

  /** Build the view from a seed. Null when it was built; otherwise what the poll answers. */
  private async seed(reason: HostThreadLogSeedReason): Promise<HostThreadLogPollResult | null> {
    if (this.state === 'following') this.dropView('reseed')
    else this.closeSources()
    this.seedDue = null
    // What the log's checkpoint was before the seed was asked for: a seed
    // behind it did not come from this log.
    const before = this.readCheckpointHead()
    let record: HostThreadLogRecord | null
    try {
      record = await this.seedPort.seed({ chatId: this.chatId, reason })
    } catch (error) {
      if (!this.closed) {
        this.seedDue = reason
        this.state = 'unseeded'
      }
      throw error
    }
    if (this.closed) return { status: 'absent' }
    if (!record) {
      this.state = 'absent'
      return { status: 'absent' }
    }
    if (
      record.appChatId !== this.chatId ||
      !Array.isArray(record.messages) ||
      !Array.isArray(record.runs)
    ) {
      this.seedDue = reason
      this.state = 'unseeded'
      throw new Error('Thread log seed is not a record of this thread')
    }
    const revision = revisionOf(record)
    const head = typeof before === 'object' ? before : null
    if (head && head.revision > revision) {
      this.seedsRefused += 1
      return this.refuse('seed-behind-checkpoint', head.identity)
    }
    this.seeds[reason] += 1
    this.buildView(record, revision)
    this.checkpoint = head
    if (!this.withinBudget()) return this.refuse('over-budget', head?.identity ?? null)
    this.state = 'following'
    // Looked at after the seed: a file made later holds only revisions after
    // it. The active name first, as rotation moves a file from it to the sealed
    // name, so a file renamed between the two looks is seen at one of them.
    for (const filePath of [this.paths.active, this.paths.sealed]) {
      const identity = this.identityAt(filePath)
      if (identity) this.know(identity)
    }
    const seeded = record
    this.notify(() => this.observer?.seeded?.(seeded))
    return null
  }

  private refuse(
    why: 'seed-behind-checkpoint' | 'over-budget',
    checkpoint: CheckpointHead['identity'] | null
  ): HostThreadLogPollResult {
    this.dropView('unfollowable')
    this.state = 'unfollowable'
    this.unfollowable = { why, checkpoint }
    return { status: 'unfollowable', why }
  }

  private checkpointChangedSinceRefusal(): boolean {
    const stat = this.statAt(this.paths.checkpoint)
    const refused = this.unfollowable?.checkpoint ?? null
    if (!stat) return refused !== null
    return (
      !refused ||
      stat.dev !== refused.dev ||
      stat.ino !== refused.ino ||
      stat.size !== refused.size ||
      stat.mtimeNs !== refused.mtimeNs
    )
  }

  private hasCheckpoint(): boolean {
    return this.statAt(this.paths.checkpoint) !== null && this.statAt(this.paths.tombstone) === null
  }

  // ---------------------------------------------------------------------------
  // Reading the files.
  // ---------------------------------------------------------------------------

  private advance(): Step {
    let consumed = 0
    for (let steps = 0; steps < MAX_STEPS_PER_POLL; steps += 1) {
      const source = this.sources.find((each) => each.state === 'reading')
      if (!source) {
        const found = this.discover()
        if (found === 'opened' || found === 'again') continue
        if (found === 'idle') return { kind: 'caught-up' }
        return found
      }
      const read = source.reader.read()
      const advanced = Math.max(0, read.offset - source.offset)
      consumed += advanced
      this.bytesRead += advanced
      source.offset = read.offset
      this.duplicatesPassed += read.duplicates
      // In one lineage each revision is written to one file, so a file new to
      // the view cannot repeat one the view has: these lines are another
      // lineage's, from a re-anchor whose checkpoint was replaced unseen.
      if (source.fresh && read.duplicates > 0) return { kind: 'reseed', reason: 'lineage' }
      let refused = false
      for (const batch of read.batches) {
        if (this.applyBatch(batch)) {
          if (this.state === 'unfollowable') return { kind: 'caught-up' }
          if (this.refusedRevision !== null && batch.revision >= this.refusedRevision) {
            this.refusedRevision = null
          }
          continue
        }
        // The view may be what is wrong: a seed's view is asked first. A batch
        // the seed's view refuses as well would be refused after every seed.
        if (this.refusedRevision !== batch.revision) {
          this.refusedRevision = batch.revision
          return { kind: 'reseed', reason: 'unapplicable' }
        }
        refused = true
        break
      }
      if (refused) {
        this.stop(source, 'unapplicable')
        continue
      }
      switch (read.status) {
        case 'ok':
          if (!read.reachedEnd) {
            if (consumed >= this.maxPollBytes) return { kind: 'more' }
            continue
          }
          if (read.file === 'at-path' && source.role === 'active') {
            // The file the app appends to now, read to its end.
            this.stoppedAt = null
            return { kind: 'caught-up' }
          }
          // A sealed segment is never appended to, and a file that has left
          // its name was read with everything written to it.
          source.state = 'finished'
          continue
        case 'corrupt':
        case 'gap':
          // The app's own load ends what this segment adds at the same line.
          this.stop(source, read.status)
          continue
        case 'oversized':
          // Reopening at the line would meet it again: the seed has it, and
          // the file is read on from past it.
          this.longLine = { identity: source.identity, offset: read.offset }
          return { kind: 'reseed', reason: 'oversized' }
        case 'shrunk':
        case 'rewritten':
          return { kind: 'reseed', reason: 'rewritten' }
      }
    }
    return { kind: 'more' }
  }

  /** The segment adds nothing more to the view; it is kept, unread, while its name holds it. */
  private stop(source: Source, cause: HostThreadLogStop): void {
    source.state = 'stopped'
    source.stop = cause
    this.stops[cause] += 1
  }

  /**
   * The files held have nothing more: look at both names for the next file,
   * then at the checkpoint, after the names, so that a segment made after a
   * re-anchor is never read before the re-anchor's checkpoint is seen.
   */
  private discover(): 'opened' | 'again' | 'idle' | Step {
    if (this.statAt(this.paths.tombstone)) return { kind: 'absent' }
    // The active name first: rotation moves a file from it to the sealed name,
    // so a file renamed between the two looks is seen at one of them.
    const active = this.identityAt(this.paths.active)
    const sealed = this.identityAt(this.paths.sealed)
    const named = { sealed, active }
    this.releaseSources(named)
    let opened: Source | null = null
    let moved = false
    // The sealed segment first, as it is the older one.
    for (const role of ['sealed', 'active'] as const) {
      const identity = named[role]
      if (!identity || this.holds(identity)) continue
      const found = this.open(role, identity)
      if (found === 'moved') {
        // By the open the name held another file, or none: the one looked at
        // may have moved on to the sealed name unread. Both names are looked
        // at again rather than a newer file read first.
        moved = true
        break
      }
      if (found) {
        opened = found
        break
      }
    }
    const checkpoint = this.lookAtCheckpoint()
    if (checkpoint !== null) {
      opened?.reader.close()
      return checkpoint
    }
    if (opened) {
      this.sources.push(opened)
      return 'opened'
    }
    if (moved) return 'again'
    if (this.checkpoint && this.checkpoint.revision > this.revision) {
      return { kind: 'reseed', reason: 'checkpoint-passed' }
    }
    this.stoppedAt = this.sources.reduce<HostThreadLogStop | null>(
      (stop, source) => (source.state === 'stopped' ? source.stop : stop),
      null
    )
    return 'idle'
  }

  /**
   * Close the files that have left both names and have nothing more: one read
   * to its end, or one stopped at damage. A file under a name is kept, so that
   * it is not opened again and read twice.
   */
  private releaseSources(named: {
    readonly sealed: FileIdentity | null
    readonly active: FileIdentity | null
  }): void {
    this.sources = this.sources.filter((source) => {
      if (source.state === 'reading') return true
      const keep =
        (named.sealed !== null && sameFile(named.sealed, source.identity)) ||
        (named.active !== null && sameFile(named.active, source.identity))
      if (!keep) source.reader.close()
      return keep
    })
  }

  /** Remember a file as met; false when it already was. */
  private know(identity: FileIdentity): boolean {
    if (this.knownFiles.some((known) => sameFile(known, identity))) return false
    this.knownFiles.push(identity)
    if (this.knownFiles.length > KNOWN_FILES) this.knownFiles.shift()
    return true
  }

  private holds(identity: FileIdentity): boolean {
    return this.sources.some((source) => sameFile(source.identity, identity))
  }

  /**
   * A reader on the file under a name, which a look at that name found to be
   * `expected`; `moved` when the name no longer holds it, null when there is
   * nothing to read in it yet.
   */
  private open(role: SegmentRole, expected: FileIdentity): Source | 'moved' | null {
    const filePath = role === 'sealed' ? this.paths.sealed : this.paths.active
    let offset = 0
    if (this.longLine && sameFile(this.longLine.identity, expected)) {
      const after = this.lineEndAfter(filePath, expected, this.longLine.offset)
      // The long line has not ended yet: nothing past it can be read.
      if (after === null) return null
      offset = after
    }
    this.lastOpened = null
    const reader = openThreadLogSegmentReader({
      filePath,
      chatId: this.chatId,
      headRevision: this.revision,
      offset,
      maxLineBytes: this.maxLineBytes,
      // One read of the segment then stays within what a poll may read.
      maxReadBytes: this.maxPollBytes,
      fs: this.readerFs
    })
    if (!reader) return 'moved'
    const identity = this.lastOpened as FileIdentity | null
    if (!identity || !sameFile(identity, expected) || this.holds(identity)) {
      reader.close()
      return 'moved'
    }
    this.segmentsOpened += 1
    const fresh = this.know(identity)
    return {
      role,
      identity,
      reader,
      offset,
      state: 'reading',
      stop: null,
      fresh
    }
  }

  /** The byte after the newline that ends the line at `offset`, or null before it has arrived. */
  private lineEndAfter(filePath: string, expected: FileIdentity, offset: number): number | null {
    const fs = this.fs
    let fd: number
    try {
      fd = fs.openSync(
        filePath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
      )
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
    try {
      const stat = fs.fstatSync(fd, { bigint: true })
      if (!stat.isFile() || !sameFile(stat, expected)) return null
      const size = Number(stat.size)
      const chunk = Buffer.alloc(LINE_END_CHUNK_BYTES)
      for (let position = offset; position < size; ) {
        const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position)
        if (count === 0) break
        const newline = chunk.subarray(0, count).indexOf(0x0a)
        if (newline >= 0) return position + newline + 1
        position += count
      }
      return null
    } finally {
      fs.closeSync(fd)
    }
  }

  /** Null when the checkpoint lets the view stand; otherwise what to do instead. */
  private lookAtCheckpoint(): Step | null {
    const stat = this.statAt(this.paths.checkpoint)
    if (!stat) return { kind: 'absent' }
    const known = this.checkpoint?.identity
    if (
      known &&
      known.dev === stat.dev &&
      known.ino === stat.ino &&
      known.size === stat.size &&
      known.mtimeNs === stat.mtimeNs
    ) {
      return null
    }
    const head = this.readCheckpointHead()
    // A checkpoint that cannot be read is one the app's load reads as absent.
    if (typeof head !== 'object') return { kind: 'absent' }
    if (LINEAGE_REASONS.has(head.reason)) return { kind: 'reseed', reason: 'lineage' }
    this.checkpoint = head
    return null
  }

  /** The checkpoint's revision and reason, read from the fields before its record. */
  private readCheckpointHead(): CheckpointHead | 'absent' | 'unreadable' {
    const fs = this.fs
    let fd: number
    try {
      fd = fs.openSync(
        this.paths.checkpoint,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
      )
    } catch (error) {
      if (isNotFound(error)) return 'absent'
      return 'unreadable'
    }
    try {
      const stat = fs.fstatSync(fd, { bigint: true })
      if (!stat.isFile()) return 'unreadable'
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
      if (recordAt < 0) return 'unreadable'
      let header: unknown
      try {
        header = JSON.parse(`${text.slice(0, recordAt)}}`)
      } catch {
        return 'unreadable'
      }
      const fields = header as Record<string, unknown>
      if (
        !fields ||
        typeof fields !== 'object' ||
        fields.format !== CHECKPOINT_FORMAT ||
        fields.chatId !== this.chatId ||
        !Number.isSafeInteger(fields.revision) ||
        (fields.revision as number) < 0 ||
        typeof fields.reason !== 'string'
      ) {
        return 'unreadable'
      }
      return {
        identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs },
        revision: fields.revision as number,
        reason: fields.reason
      }
    } catch {
      return 'unreadable'
    } finally {
      fs.closeSync(fd)
    }
  }

  private statAt(filePath: string): ThreadLogSegmentFileStat | null {
    try {
      const stat = this.fs.lstatSync(filePath, { bigint: true })
      return stat.isFile() ? stat : null
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  private identityAt(filePath: string): FileIdentity | null {
    const stat = this.statAt(filePath)
    return stat ? { dev: stat.dev, ino: stat.ino } : null
  }

  private closeSources(): void {
    for (const source of this.sources) source.reader.close()
    this.sources = []
  }

  // ---------------------------------------------------------------------------
  // The view.
  // ---------------------------------------------------------------------------

  private dropView(reason: HostThreadLogDropReason): void {
    const had = this.state === 'following'
    this.closeSources()
    this.knownFiles = []
    this.checkpoint = null
    this.stoppedAt = null
    this.revision = 0
    this.savedAt = null
    this.shell = {}
    this.shellBytes = 2
    this.messages = []
    this.messageBytes = []
    this.messagesBytes = 0
    this.messageCount = 0
    this.runs = []
    this.runsFrom = 0
    this.runsBytes = 0
    this.runCount = 0
    this.runReferences = new Map()
    this.missingRunIds = new Set()
    this.ambiguousMessageIds = new Set()
    this.ambiguousRunIds = new Set()
    this.retained = []
    this.retainedBytes = 0
    if (this.state === 'following') this.state = 'unseeded'
    if (had) this.notify(() => this.observer?.dropped?.(reason))
  }

  private buildView(record: HostThreadLogRecord, revision: number): void {
    const { messages, runs, ...rest } = record
    this.revision = revision
    this.savedAt = null
    this.shell = { ...rest }
    this.shellBytes = jsonBytes(this.shell)
    this.messageCount = messages.length
    const windowStart = Math.max(0, messages.length - this.windowMessages)
    this.messages = messages.slice(windowStart) as HostThreadLogMessage[]
    this.messageBytes = this.messages.map(jsonBytes)
    this.messagesBytes = this.messageBytes.reduce((sum, bytes) => sum + bytes, 0)
    // An operation reaches the first row with its id, which may be an older one.
    const olderMessageIds = new Set<string>()
    for (let index = 0; index < windowStart; index += 1) olderMessageIds.add(messages[index].id)
    this.ambiguousMessageIds = new Set(
      this.messages.map((message) => message.id).filter((id) => olderMessageIds.has(id))
    )
    this.runCount = runs.length
    this.runsFrom = Math.max(0, runs.length - this.windowRuns)
    this.countRunReferences()
    const runsById = new Map<string, number>()
    runs.forEach((run, index) => {
      const id = runIdOf(run)
      if (id !== null && !runsById.has(id)) runsById.set(id, index)
    })
    const held: HeldRun[] = []
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index] as HostThreadLogRun
      const id = runIdOf(run)
      if (index >= this.runsFrom || (id !== null && this.runReferences.has(id))) {
        held.push({ index, run, bytes: jsonBytes(run) })
      }
    }
    this.runs = held
    this.runsBytes = held.reduce((sum, each) => sum + each.bytes, 0)
    const heldIndexes = new Set(held.map((each) => each.index))
    this.ambiguousRunIds = new Set<string>()
    runs.forEach((run, index) => {
      const id = runIdOf(run)
      if (id !== null && !heldIndexes.has(index) && held.some((each) => runIdOf(each.run) === id)) {
        this.ambiguousRunIds.add(id)
      }
    })
    this.missingRunIds = new Set(
      [...this.runReferences.keys()].filter((runId) => !runsById.has(runId))
    )
    this.retained = []
    this.retainedBytes = 0
    this.trim()
  }

  private viewBytes(): number {
    return this.shellBytes + this.messagesBytes + this.runsBytes
  }

  private withinBudget(): boolean {
    return this.viewBytes() <= this.maxViewBytes
  }

  private countRunReferences(): void {
    const references = new Map<string, number>()
    for (const message of this.messages) {
      const runId = runNamedBy(message)
      if (runId !== null) references.set(runId, (references.get(runId) ?? 0) + 1)
    }
    this.runReferences = references
  }

  /**
   * Keep the window to its counts and the view to its bytes: the oldest
   * messages go first, then the oldest runs no held message names. Returns the
   * messages that left the window.
   */
  private trim(): HostThreadLogMessage[] {
    const trimmed: HostThreadLogMessage[] = []
    const dropMessage = (): void => {
      const message = this.messages.shift()!
      this.messagesBytes -= this.messageBytes.shift()!
      trimmed.push(message)
      const runId = runNamedBy(message)
      if (runId !== null) {
        const left = (this.runReferences.get(runId) ?? 1) - 1
        if (left > 0) this.runReferences.set(runId, left)
        else {
          this.runReferences.delete(runId)
          this.missingRunIds.delete(runId)
        }
      }
      // A held message with the same id now has an older twin.
      if (this.messages.some((each) => each.id === message.id)) {
        this.ambiguousMessageIds.add(message.id)
      }
    }
    while (this.messages.length > this.windowMessages) dropMessage()
    while (this.runCount - this.runsFrom > this.windowRuns) this.dropOldestNewestRun()
    while (this.viewBytes() > this.maxViewBytes) {
      if (this.messages.length > 0) dropMessage()
      else if (this.runsFrom < this.runCount) this.dropOldestNewestRun()
      else break
    }
    this.pruneRuns()
    return trimmed
  }

  /** The newest runs start one later; the run that leaves them stays only while a held message names it. */
  private dropOldestNewestRun(): void {
    this.runsFrom += 1
    this.pruneRuns()
  }

  /** Drop the held runs before the newest ones that no held message names. */
  private pruneRuns(): void {
    if (this.runs.every((each) => each.index >= this.runsFrom)) return
    this.runs = this.runs.filter((each) => {
      if (each.index >= this.runsFrom) return true
      const id = runIdOf(each.run)
      const keep = id !== null && this.runReferences.has(id)
      if (!keep) this.runsBytes -= each.bytes
      return keep
    })
  }

  // ---------------------------------------------------------------------------
  // Applying a batch.
  // ---------------------------------------------------------------------------

  /** False when the shared apply code refuses the batch for the rows held. */
  private applyBatch(batch: ThreadLogBatch): boolean {
    if (batch.baseRevision !== this.revision) return false
    let staging: Staging
    try {
      staging = this.stage(batch)
    } catch {
      return false
    }
    this.commit(batch, staging)
    return true
  }

  /** One operation at a time, each on copies of just the rows it touches. */
  private stage(batch: ThreadLogBatch): Staging {
    const staging: Staging = {
      shell: null,
      messages: this.messages.slice(),
      messageBytes: this.messageBytes.slice(),
      messageCount: this.messageCount,
      runs: this.runs.slice(),
      runsFrom: this.runsFrom,
      runCount: this.runCount,
      touched: new Set(),
      inserted: new Set(),
      removed: new Set(),
      moved: false,
      olderMessageOperations: [],
      runsChanged: new Set(),
      insertedRunIds: new Set(),
      removedRunIds: new Set(),
      olderRunOperations: [],
      shellChanged: false
    }
    batch.operations.forEach((operation, index) => {
      this.stageOperation(staging, operation, index)
    })
    return staging
  }

  private stageOperation(staging: Staging, operation: ThreadLogOperation, index: number): void {
    switch (operation.type) {
      case 'record_patch': {
        const result = this.applyOne({}, operation)
        const shell = (staging.shell ??= { ...this.shell })
        for (const key of [...Object.keys(operation.set), ...operation.clear]) {
          if (Object.prototype.hasOwnProperty.call(result, key)) shell[key] = result[key]
          else delete shell[key]
        }
        staging.shellChanged = true
        return
      }
      case 'ensemble_patch':
      case 'ensemble_participant_patch': {
        const shell = staging.shell ?? this.shell
        const result = this.applyOne(
          Object.prototype.hasOwnProperty.call(shell, 'ensemble')
            ? { ensemble: shell.ensemble }
            : {},
          operation
        )
        ;(staging.shell ??= { ...this.shell }).ensemble = result.ensemble
        staging.shellChanged = true
        return
      }
      case 'messages_splice':
        this.stageMessagesSplice(staging, operation, index)
        return
      case 'message_content_append':
      case 'message_put':
      case 'message_patch':
      case 'tool_activities_presence':
      case 'tool_activities_splice':
      case 'tool_activity_put': {
        const at = this.ambiguousMessageIds.has(operation.messageId)
          ? -1
          : staging.messages.findIndex((message) => message.id === operation.messageId)
        if (at < 0) {
          staging.olderMessageOperations.push(index)
          return
        }
        const before = staging.messages[at]
        if (operation.type === 'message_content_append') {
          // Only the text is involved: the rest of a large row is not copied.
          const [after] = this.applyOne(
            { messages: [{ id: before.id, content: before.content }] },
            operation
          ).messages
          staging.messages[at] = { ...before, content: after.content }
          staging.messageBytes[at] += appendedJsonBytes(operation.content)
        } else {
          const [after] = this.applyOne({ messages: [before] }, operation).messages
          staging.messages[at] = after as HostThreadLogMessage
          staging.messageBytes[at] = jsonBytes(after)
        }
        staging.touched.add(operation.messageId)
        return
      }
      case 'runs_splice':
        this.stageRunsSplice(staging, operation, index)
        return
      case 'run_put': {
        const at = this.ambiguousRunIds.has(operation.runId)
          ? -1
          : staging.runs.findIndex((each) => runIdOf(each.run) === operation.runId)
        if (at < 0) {
          staging.olderRunOperations.push(index)
          return
        }
        const held = staging.runs[at]
        const [after] = this.applyOne({ runs: [held.run] }, operation).runs
        staging.runs[at] = {
          index: held.index,
          run: after as HostThreadLogRun,
          bytes: jsonBytes(after)
        }
        staging.runsChanged.add(operation.runId)
        const nextId = runIdOf(after)
        if (nextId !== null) staging.runsChanged.add(nextId)
        return
      }
      default: {
        const unknown: never = operation
        throw new Error(`Unsupported operation ${String(unknown)}`)
      }
    }
  }

  private stageMessagesSplice(
    staging: Staging,
    operation: Extract<ThreadLogOperation, { type: 'messages_splice' }>,
    index: number
  ): void {
    const count = staging.messageCount
    const { index: at, deleteCount } = operation
    assertSpliceBounds(count, at, deleteCount, 'messages')
    // The shared code checks and copies the rows that go in; where they go is worked out here.
    const inserted = this.applyOne({ messages: [] }, { ...operation, index: 0, deleteCount: 0 })
      .messages as HostThreadLogMessage[]
    const start = count - staging.messages.length
    let removed: HostThreadLogMessage[]
    if (at >= start) {
      removed = staging.messages.splice(at - start, deleteCount, ...inserted)
      staging.messageBytes.splice(at - start, deleteCount, ...inserted.map(jsonBytes))
    } else if (at + deleteCount <= start) {
      // Wholly before the window: nothing held changes, but every position after it moves.
      removed = []
      staging.olderMessageOperations.push(index)
    } else {
      // Across the window's start: the rows put in are the oldest the window now holds.
      const kept = at + deleteCount - start
      removed = staging.messages.slice(0, kept)
      staging.messages = [...inserted, ...staging.messages.slice(kept)]
      staging.messageBytes = [...inserted.map(jsonBytes), ...staging.messageBytes.slice(kept)]
      staging.olderMessageOperations.push(index)
    }
    for (const message of removed) staging.removed.add(message.id)
    for (const message of inserted) staging.inserted.add(message.id)
    staging.messageCount = count - deleteCount + inserted.length
    if (deleteCount > 0 || at < count) staging.moved = true
  }

  private stageRunsSplice(
    staging: Staging,
    operation: Extract<ThreadLogOperation, { type: 'runs_splice' }>,
    index: number
  ): void {
    const count = staging.runCount
    const { index: at, deleteCount } = operation
    assertSpliceBounds(count, at, deleteCount, 'runs')
    const inserted = this.applyOne({ runs: [] }, { ...operation, index: 0, deleteCount: 0 })
      .runs as HostThreadLogRun[]
    const shift = inserted.length - deleteCount
    const next: HeldRun[] = []
    let heldRemoved = 0
    for (const held of staging.runs) {
      if (held.index < at) next.push(held)
      else if (held.index < at + deleteCount) {
        heldRemoved += 1
        const id = runIdOf(held.run)
        if (id !== null) {
          staging.runsChanged.add(id)
          staging.removedRunIds.add(id)
        }
      } else next.push({ ...held, index: held.index + shift })
    }
    if (heldRemoved < deleteCount) staging.olderRunOperations.push(index)
    // Held for now; those before the newest that no held message names go at commit.
    inserted.forEach((run, offset) => {
      next.push({ index: at + offset, run, bytes: jsonBytes(run) })
      const id = runIdOf(run)
      if (id !== null) {
        staging.runsChanged.add(id)
        staging.insertedRunIds.add(id)
      }
    })
    next.sort((a, b) => a.index - b.index)
    staging.runs = next
    if (at + deleteCount <= staging.runsFrom) staging.runsFrom += shift
    else if (at < staging.runsFrom) staging.runsFrom = at
    staging.runCount = count + shift
  }

  /** Apply one operation, with the shared code, to a record that holds just what it needs. */
  private applyOne(
    rows: {
      messages?: ThreadLogMessage[]
      runs?: ThreadLogRun[]
      ensemble?: unknown
    },
    operation: ThreadLogOperation
  ): ThreadLogRecord & Record<string, unknown> {
    const record = {
      appChatId: this.chatId,
      persistenceRevision: 0,
      messages: rows.messages ?? [],
      runs: rows.runs ?? [],
      ...(Object.prototype.hasOwnProperty.call(rows, 'ensemble') ? { ensemble: rows.ensemble } : {})
    } as ThreadLogRecord & Record<string, unknown>
    return applyThreadLogBatch(record, {
      format: THREAD_LOG_BATCH_FORMAT,
      version: THREAD_LOG_BATCH_VERSION,
      chatId: this.chatId,
      baseRevision: 0,
      revision: 1,
      savedAt: '',
      operations: [operation]
    })
  }

  private commit(batch: ThreadLogBatch, staging: Staging): void {
    const before = new Set(this.messages.map((message) => message.id))
    this.shell = { ...(staging.shell ?? this.shell), persistenceRevision: batch.revision }
    this.shellBytes = jsonBytes(this.shell)
    this.messages = staging.messages
    this.messageBytes = staging.messageBytes
    this.messagesBytes = staging.messageBytes.reduce((sum, bytes) => sum + bytes, 0)
    this.messageCount = staging.messageCount
    this.runs = staging.runs
    this.runsBytes = staging.runs.reduce((sum, each) => sum + each.bytes, 0)
    this.runsFrom = staging.runsFrom
    this.runCount = staging.runCount
    this.revision = batch.revision
    this.savedAt = batch.savedAt
    this.batchesApplied += 1
    this.olderMessageOperations += staging.olderMessageOperations.length
    this.olderRunOperations += staging.olderRunOperations.length

    this.countRunReferences()
    for (const id of staging.insertedRunIds) this.missingRunIds.delete(id)
    for (const id of staging.removedRunIds) {
      if (this.runReferences.has(id) && !this.runs.some((each) => runIdOf(each.run) === id)) {
        this.missingRunIds.add(id)
      }
    }
    for (const id of this.missingRunIds) {
      if (!this.runReferences.has(id)) this.missingRunIds.delete(id)
    }
    this.pruneRuns()

    const after = new Set(this.messages.map((message) => message.id))
    const changed = new Set<string>()
    for (const id of [...staging.touched, ...staging.inserted]) if (after.has(id)) changed.add(id)
    const effects: HostThreadLogBatchEffects = {
      messagesChanged: [...changed],
      messagesAdded: [...staging.inserted].filter((id) => after.has(id) && !before.has(id)),
      messagesRemoved: [...staging.removed].filter((id) => !after.has(id)),
      messagesMoved: staging.moved,
      olderMessageOperations: staging.olderMessageOperations,
      runsChanged: [...staging.runsChanged],
      olderRunOperations: staging.olderRunOperations,
      shellChanged: staging.shellChanged
    }
    const trimmed = this.trim()
    const applied: HostThreadLogAppliedBatch = {
      batch,
      bytes: jsonBytes(batch) + 1,
      appliedAt: this.now(),
      effects
    }
    this.retained.push(applied)
    this.retainedBytes += applied.bytes
    while (
      this.retained.length > this.maxRetainedBatches ||
      this.retainedBytes > this.maxRetainedBytes
    ) {
      this.retainedBytes -= this.retained.shift()!.bytes
    }
    if (!this.withinBudget()) {
      this.refuse('over-budget', this.checkpoint?.identity ?? null)
      return
    }
    this.notify(() => this.observer?.applied?.(applied, trimmed))
  }

  private notify(call: () => void): void {
    try {
      call()
    } catch {
      // The view is whole whatever its observer does; the failure is counted.
      this.observerFailures += 1
    }
  }
}

export interface HostThreadLogFollowersOptions extends Omit<
  HostThreadLogFollowerOptions,
  'chatId' | 'observer'
> {
  /** Defaults to {@link HOST_THREAD_LOG_MAX_THREADS}. */
  readonly maxThreads?: number
  /** The observer of a thread's follower, when its user wants one. */
  readonly observerFor?: (chatId: string) => HostThreadLogFollowerObserver | undefined
}

/**
 * The followers of one profile. At most `maxThreads` at once: following one
 * more drops the one used least recently, with its view and its descriptors.
 */
export class HostThreadLogFollowers {
  private readonly followers = new Map<string, HostThreadLogFollower>()
  private readonly maxThreads: number
  private evictions = 0

  constructor(private readonly options: HostThreadLogFollowersOptions) {
    this.maxThreads = wholeNumber(options.maxThreads, HOST_THREAD_LOG_MAX_THREADS, 1, 'maxThreads')
  }

  /** The thread's follower, made if need be; it becomes the most recently used. */
  follow(chatId: string): HostThreadLogFollower {
    const existing = this.followers.get(chatId)
    if (existing) {
      this.followers.delete(chatId)
      this.followers.set(chatId, existing)
      return existing
    }
    const { observerFor, maxThreads: _maxThreads, ...rest } = this.options
    const follower = new HostThreadLogFollower({
      ...rest,
      chatId,
      observer: observerFor?.(chatId)
    })
    this.followers.set(chatId, follower)
    while (this.followers.size > this.maxThreads) {
      const [oldestId, oldest] = this.followers.entries().next().value as [
        string,
        HostThreadLogFollower
      ]
      this.followers.delete(oldestId)
      oldest.close()
      this.evictions += 1
    }
    return follower
  }

  /** The thread's follower, if it has one, without making it the most recently used. */
  peek(chatId: string): HostThreadLogFollower | undefined {
    return this.followers.get(chatId)
  }

  /** Stop following a thread. */
  forget(chatId: string): void {
    this.followers.get(chatId)?.close()
    this.followers.delete(chatId)
  }

  close(): void {
    for (const follower of this.followers.values()) follower.close()
    this.followers.clear()
  }

  memory(): {
    readonly threads: number
    readonly viewBytes: number
    readonly retainedBytes: number
    readonly openFiles: number
    readonly evictions: number
  } {
    let viewBytes = 0
    let retainedBytes = 0
    let openFiles = 0
    for (const follower of this.followers.values()) {
      const memory = follower.memory()
      viewBytes += memory.viewBytes
      retainedBytes += memory.retainedBytes
      openFiles += memory.openFiles
    }
    return {
      threads: this.followers.size,
      viewBytes,
      retainedBytes,
      openFiles,
      evictions: this.evictions
    }
  }
}
