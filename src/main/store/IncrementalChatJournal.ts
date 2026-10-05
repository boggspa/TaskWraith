import { randomInt } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { applyChatRecordMutations, type ChatRecordMutationBatch } from './ChatRecordMutation'
import { isThreadLogBatch } from '../../host-shared/thread-log/ThreadLogBatch'
import type { ChatRecord } from './types'
import { observeResidual, type ResidualObserver } from './MainDurabilityResiduals'
import type { IncrementalChatJournalDescriptorCache } from './IncrementalChatJournalDescriptorCache'
import type { NoteThreadDurabilityDebt } from './ThreadDurabilityDebt'
import { repairSegmentTornTail } from './IncrementalChatJournalTailRepair'
import {
  checkpointFileReference,
  checkpointReferenceIsCurrent,
  removePreparedCheckpointFiles,
  type CheckpointPreparationJob,
  type CheckpointPreparationPort,
  type CheckpointPreparationSource,
  type DeferredCheckpointResult
} from './CheckpointPreparationProtocol'

export const INCREMENTAL_CHAT_CHECKPOINT_FORMAT = 'taskwraith-chat-checkpoint' as const
export const INCREMENTAL_CHAT_CHECKPOINT_VERSION = 1 as const
/** Backpressure bound for D1 deferred fsyncs. Saturation falls back to sync. */
export const MAX_PENDING_DEFERRED_FSYNCS = 64
/**
 * Every file the journal keeps for one chat, as the suffix after the chat id.
 * The maintenance scan and direct erasure of a chat's journal both read this
 * list, so a file the journal can find is a file erasure removes. The scan
 * takes the first match, so the sealed segment must come before the active
 * segment, whose suffix it also ends with.
 */
export const INCREMENTAL_CHAT_JOURNAL_ARTIFACT_SUFFIXES = [
  '.checkpoint.json',
  '.sealed.mutations.jsonl',
  '.set-aside.mutations.jsonl',
  '.mutations.jsonl',
  '.tombstone'
] as const

export type IncrementalChatCheckpointReason =
  | 'initial'
  | 'terminal'
  | 'idle'
  | 'bounded'
  | 'shutdown'
  | 'manual'
  | 'recovery'

export interface IncrementalChatCheckpoint {
  format: typeof INCREMENTAL_CHAT_CHECKPOINT_FORMAT
  version: typeof INCREMENTAL_CHAT_CHECKPOINT_VERSION
  chatId: string
  revision: number
  savedAt: string
  reason: IncrementalChatCheckpointReason
  record: ChatRecord
}

export interface IncrementalChatReplayResult {
  record: ChatRecord | null
  revision: number | null
  appliedBatches: number
  skippedBatches: number
  recoveredTornTail: boolean
}

/**
 * A cheap, read-only probe of whether a full `replay()` could change the served
 * record — a stat of the mutations tail plus a header-only peek at the
 * checkpoint revision, never the fat record parse `replay()` pays.
 *
 * The read path uses it to skip the checkpoint re-parse for a chat whose
 * journal has been folded away (no tail) and whose checkpoint does not lead the
 * legacy record: in that case replay would reproduce the checkpoint at a
 * revision the caller already discards for the legacy record, so skipping it is
 * a proven no-op on the served bytes. A leading checkpoint or a live tail still
 * forces the real replay.
 */
export interface IncrementalChatPendingReplayState {
  /** True when the journal holds an unflushed mutations tail beyond the checkpoint. */
  hasTail: boolean
  /**
   * The checkpoint's head revision, read from its header WITHOUT parsing the
   * full record; null when there is no checkpoint or its header is unreadable
   * (both of which force the caller onto the full replay path, unchanged).
   */
  checkpointRevision: number | null
}

export interface IncrementalChatJournalStats {
  appends: number
  deferredAppends: number
  deferredFsyncFailures: number
  /** Immediate appends whose line was written and whose sync then failed. */
  immediateFsyncFailures: number
  /** Appends written with no sync and noted as owed; see `noteDurabilityDebt`. */
  unsyncedAppends: number
  drainedDeferredFsyncs: number
  mutationBytesWritten: number
  checkpointsWritten: number
  /** Checkpoints written from the caller's in-memory head, with no replay. */
  checkpointsFromMemory: number
  forcedSynchronousCheckpoints: number
  checkpointBytesWritten: number
  replayedBatches: number
  skippedDuplicateBatches: number
  tornTailsRecovered: number
  /** Torn fragments cut in place before an append; see `repairTornTailBeforeAppend`. */
  tornTailsTruncated: number
  tornTailBytesTruncated: number
  /**
   * Appends refused because the active segment holds an invalid complete line,
   * or, under `noteDurabilityDebt`, a line that does not chain after lines of
   * its own segment that did.
   */
  corruptSegmentRejects: number
  tombstoneRejects: number
  /** Segments set aside because they do not chain; see `noteDurabilityDebt`. */
  segmentsSetAside: number
  /** Chats whose checkpoint did not parse, read as having none; see `noteDurabilityDebt`. */
  checkpointsReadAsAbsent: number
}

/**
 * ADR §5.2 durability classes at the append seam. `immediate` blocks the
 * caller until the fsync lands (D2/D3 — user messages, run transitions,
 * approval/terminal boundaries). `deferred` writes the bytes synchronously
 * (every same-process reader still sees them) and hands the flush to the
 * kernel off-thread — the D1 soft-stream contract: a crash may lose the
 * trailing unflushed window, never ordering, never an acknowledged barrier.
 */
export type IncrementalChatAppendDurability = 'immediate' | 'deferred'

export interface IncrementalChatAppendOptions {
  durability?: IncrementalChatAppendDurability
}

export interface IncrementalChatJournalOptions {
  residualObserver?: ResidualObserver
  /** Root injects only for exact TASKWRAITH_JOURNAL_FLUSHER=1. */
  descriptorCache?: IncrementalChatJournalDescriptorCache
  descriptorDrainSync?: () => void
  /** Explicit opt-in; root requires exact rotation flag 1 and journal flusher. */
  rotationEnabled?: boolean
  /** Opt-in idle compaction only. Strict/bounded/shutdown checkpoints keep their synchronous contract. */
  checkpointPreparation?: CheckpointPreparationPort
  beforeSourceMutation?: (chatId: string) => void
  /** Main's maintenance timers may touch only journals already opened by actual work. */
  maintenanceScope?: 'opened' | 'all'
  /** Dynamic authority gate; false is strictly replay-only. */
  canWrite?: () => boolean
  /**
   * Authority for read-path torn-tail repair (load/replay side effects).
   * Defaults to `canWrite`. Stage 2 splits the two under Host ownership:
   * explicit mirror writes are permitted, but a torn journal tail from the
   * legacy era must not self-heal as a side effect of merely READING a chat
   * — the Host-owned read-only import invariant pins every profile byte.
   */
  canRepairOnRead?: () => boolean
  /**
   * Explicit opt-in; the root does not set it. Where reads may not repair, a
   * torn tail stays on disk, the next batch is written straight after the
   * fragment, and that batch and every later one are unreadable. With this on,
   * an append to a segment last read as torn first cuts the fragment in place,
   * and an append after an invalid complete line is refused rather than
   * written where no reader will reach it. Reads still change no byte.
   */
  repairTornTailBeforeAppend?: boolean
  /**
   * Explicit opt-in; the root does not set it. With it an append only writes.
   * The journal issues no sync for the line, schedules none and never falls
   * back to one, whatever durability the caller asked for. It tells this
   * callback what the disk is owed instead: the segment's bytes, and the
   * directory whenever a segment is created there, renamed by a rotation or
   * removed by a compaction. Whoever needs a line to be on the disk waits on
   * the thread's own barrier: `awaitDeferredDurability` and
   * `drainDeferredDurability` have nothing to wait for, because nothing was
   * issued here. The first checkpoint of a chat is written the same way:
   * written, renamed into place, and its file and the directory owed. Writing
   * any later checkpoint, the re-anchor, torn-tail repair and erasure keep
   * every sync they have.
   *
   * A power cut can then take a chat's first checkpoint, name and all, or
   * leave its name with only part of its bytes. No barrier resolved for that
   * chat, since a barrier pays the checkpoint with its first line, so a
   * checkpoint that does not parse is read as absent: the chat has no record,
   * its segments are set aside as below, and its next save starts it again.
   * It is counted and logged by chat id only. One that parses and is not a
   * checkpoint is still refused.
   *
   * A power cut can then leave segments that do not chain: a segment that
   * reached the disk while the end of the one before it did not, or segments
   * whose checkpoint did not. No barrier resolved for anything after such a
   * gap, since a barrier pays the segments before it, so with this option a
   * load takes the longest chain from the checkpoint with no gap and never
   * throws for one. How the rules for a segment's bytes meet:
   * - bytes after a segment's last newline are a torn tail, and an invalid
   *   complete line ends what its segment adds in the same way: neither is
   *   replayed, nor anything after it in that segment. A read that may repair
   *   (`canRepairOnRead`) rewrites the segment without them, as it always
   *   has; otherwise the next append cuts a torn tail first, and is refused
   *   after an invalid complete line;
   * - a valid line that does not chain, after lines of its own segment that
   *   did, ends what that segment adds too. It is left where it is, even by a
   *   read that may repair, and an append after it is refused until a
   *   checkpoint, a re-anchor or erasure replaces the segment;
   * - a segment whose first line past the head does not chain, or any segment
   *   without a checkpoint, is set aside whole: renamed, or added, to
   *   `<chat>.set-aside.mutations.jsonl`, which nothing parses, which erasure
   *   and the next checkpoint remove, and which is counted and logged by chat
   *   id and revisions only. A read that may not repair, or that the write
   *   gate refuses, leaves it where it is and reads past it, and the next
   *   append moves it before it writes.
   * Without this option a gap throws, as it always has.
   */
  noteDurabilityDebt?: NoteThreadDurabilityDebt
  now?: () => number
  maxJournalBytes?: number
  maxJournalEntries?: number
  idleCheckpointMs?: number
  maxUncheckpointedMs?: number
  maxJournalReadBytes?: number
  /** Test-only crash-window seam. Throwing leaves checkpoint + journal together. */
  afterCheckpointWrite?: (chatId: string, checkpoint: IncrementalChatCheckpoint) => void
  /** Deferred-flush seam: production is `fs.fsync`; tests capture and settle. */
  scheduleFsync?: (fd: number, done: (error?: NodeJS.ErrnoException | null) => void) => void
}

export interface JournalCaptureReadReference {
  readonly file: ReturnType<typeof checkpointFileReference>
  /** Parent-owned read descriptor; child must inherit/duplicate before use.
   * A child owns its duplicate independently. Never pass this integer as a
   * descriptor in another process without an explicit inheritance mapping. */
  readonly fd: number
  readonly prefixBytes: number
  readonly mutablePrefix: boolean
}

export interface JournalCaptureLease {
  readonly chatId: string
  readonly revision: number
  readonly generation: number
  readonly checkpoint: JournalCaptureReadReference
  readonly sealed: JournalCaptureReadReference | null
  readonly active: JournalCaptureReadReference | null
  isCurrent(): boolean
  release(): void
  cancel(): void
}

export interface IncrementalChatJournal {
  captureSource?(chatId: string, revision: number): JournalCaptureLease | null
  rotateForPreparation?(chatId: string): CheckpointPreparationSource | null
  initialize(chatId: string, record: ChatRecord): void
  append(batch: ChatRecordMutationBatch, options?: IncrementalChatAppendOptions): void
  replay(chatId: string): IncrementalChatReplayResult
  /** Cheap probe (stat + checkpoint-header peek) of whether `replay` could lead
   *  the legacy record; see {@link IncrementalChatPendingReplayState}. */
  pendingReplayState(chatId: string): IncrementalChatPendingReplayState
  replaceAuthoritativeCheckpoint(chatId: string, record: ChatRecord): void
  /**
   * Compact the journal into a full checkpoint. `headRecord`, when it is the
   * in-memory record at exactly the journal head revision, is written as-is;
   * otherwise the head is rebuilt by replaying the on-disk checkpoint + tail.
   */
  checkpoint(
    chatId: string,
    reason: IncrementalChatCheckpointReason,
    headRecord?: ChatRecord | null
  ): boolean
  /**
   * Supply the in-memory head record for checkpoints the journal takes on its
   * own (bounded, idle, shutdown). Same contract as `checkpoint`'s headRecord.
   */
  setHeadRecordResolver?(
    resolve: ((chatId: string, headRevision: number) => ChatRecord | null) | null
  ): void
  checkpointIdle(nowMs?: number): number
  checkpointDeferred?(chatId: string): Promise<DeferredCheckpointResult>
  checkpointIdleDeferred?(nowMs?: number): Promise<number>
  /** Erasure routes that directly remove journal files must retire private preparations first. */
  cancelCheckpointPreparations?(chatId?: string): void
  checkpointAll(reason?: IncrementalChatCheckpointReason): number
  /** Synchronously fsync every journal file with an unsettled deferred flush. */
  drainDeferredDurability(): number
  /** Await only already-issued fsyncs; never force a compatibility materialization. */
  awaitDeferredDurability?(chatId: string): Promise<void>
  delete(chatId: string): void
  purge(chatId: string): void
  clear(): void
  stats(): IncrementalChatJournalStats
}

interface RuntimeState {
  headRevision: number | null
  journalEntries: number
  journalBytes: number
  dirtySinceMs: number | null
  lastAppendAtMs: number | null
  tombstoned: boolean
}

interface ParsedJournal {
  batches: ChatRecordMutationBatch[]
  bytes: number
  torn: boolean
  validContent: string
}

/** A segment that does not chain, by its name and the revisions of its first and last lines. */
interface SetAsideSegment {
  filePath: string
  first: number
  last: number
}

/** The random part of a temporary file's name: 2^48 - 1, the most `randomInt` allows. */
const TEMPORARY_NAME_RANGE = 0xffff_ffff_ffff
const DEFAULT_MAX_JOURNAL_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_JOURNAL_ENTRIES = 1_000
const DEFAULT_IDLE_CHECKPOINT_MS = 15_000
const DEFAULT_MAX_UNCHECKPOINTED_MS = 2 * 60 * 1000
const DEFAULT_MAX_JOURNAL_READ_BYTES = 256 * 1024 * 1024
/** Enough of a checkpoint file to hold every header field before the fat
 *  `record`: format, version, chatId, revision, savedAt, reason all sit in the
 *  first ~200 bytes, so a 4KB probe reaches the top-level revision with room to
 *  spare while never touching the megabytes of transcript that follow. */
const CHECKPOINT_HEADER_PROBE_BYTES = 4096
const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/
const CHECKPOINT_REASONS = new Set<IncrementalChatCheckpointReason>([
  'initial',
  'terminal',
  'idle',
  'bounded',
  'shutdown',
  'manual',
  'recovery'
])

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function recordRevision(record: ChatRecord): number {
  return nonNegativeInteger(record.persistenceRevision) ? record.persistenceRevision : 0
}

/** The check itself lives in host-shared, where the Host can reach it. */
export function validMutationBatch(
  value: unknown,
  chatId: string
): value is ChatRecordMutationBatch {
  return isThreadLogBatch(value, chatId)
}

export function validCheckpoint(
  value: unknown,
  chatId: string
): value is IncrementalChatCheckpoint {
  if (!value || typeof value !== 'object') return false
  const checkpoint = value as Partial<IncrementalChatCheckpoint>
  return (
    checkpoint.format === INCREMENTAL_CHAT_CHECKPOINT_FORMAT &&
    checkpoint.version === INCREMENTAL_CHAT_CHECKPOINT_VERSION &&
    checkpoint.chatId === chatId &&
    nonNegativeInteger(checkpoint.revision) &&
    typeof checkpoint.savedAt === 'string' &&
    CHECKPOINT_REASONS.has(checkpoint.reason as IncrementalChatCheckpointReason) &&
    !!checkpoint.record &&
    typeof checkpoint.record === 'object' &&
    checkpoint.record.appChatId === chatId &&
    recordRevision(checkpoint.record) === checkpoint.revision
  )
}

export function createIncrementalChatJournal(
  baseDir: string,
  options: IncrementalChatJournalOptions = {}
): IncrementalChatJournal {
  const now = options.now ?? Date.now
  const canWrite = (): boolean => {
    try {
      return options.canWrite?.() ?? true
    } catch {
      return false
    }
  }
  const canRepair = (): boolean => {
    try {
      return options.canRepairOnRead?.() ?? canWrite()
    } catch {
      return false
    }
  }
  const assertWritable = (): void => {
    if (!canWrite()) throw new Error('Incremental chat journal is read-only')
  }
  const maxJournalBytes = positiveInteger(options.maxJournalBytes, DEFAULT_MAX_JOURNAL_BYTES)
  const maxJournalEntries = positiveInteger(options.maxJournalEntries, DEFAULT_MAX_JOURNAL_ENTRIES)
  const idleCheckpointMs = positiveInteger(options.idleCheckpointMs, DEFAULT_IDLE_CHECKPOINT_MS)
  const maxUncheckpointedMs = positiveInteger(
    options.maxUncheckpointedMs,
    DEFAULT_MAX_UNCHECKPOINTED_MS
  )
  const maxJournalReadBytes = positiveInteger(
    options.maxJournalReadBytes,
    DEFAULT_MAX_JOURNAL_READ_BYTES
  )
  const states = new Map<string, RuntimeState>()
  const preparations = new Map<string, CheckpointPreparationJob>()
  const preparationEpochs = new Map<string, number>()
  const captureEpochs = new Map<string, number>()
  const rotatedSources = new Map<string, CheckpointPreparationSource>()
  const rotatedAccounting = new Map<string, { entries: number; bytes: number }>()
  const invalidatePreparation = (chatId: string, invalidateCapture = true): void => {
    if (invalidateCapture) captureEpochs.set(chatId, (captureEpochs.get(chatId) ?? 0) + 1)
    preparationEpochs.set(chatId, (preparationEpochs.get(chatId) ?? 0) + 1)
    rotatedSources.delete(chatId)
    rotatedAccounting.delete(chatId)
    const job = preparations.get(chatId)
    // Fence before cancellation can synchronously deliver any callback.
    preparations.delete(chatId)
    job?.cancel()
  }
  const scheduleFsync =
    options.scheduleFsync ?? ((fd, done) => fs.fsync(fd, (error) => done(error)))
  const noteDebt = options.noteDurabilityDebt
  let writeSequence = 0
  let appends = 0
  let deferredAppends = 0
  let deferredFsyncFailures = 0
  let immediateFsyncFailures = 0
  let unsyncedAppends = 0
  let drainedDeferredFsyncs = 0
  let mutationBytesWritten = 0
  let checkpointsWritten = 0
  let checkpointsFromMemory = 0
  let forcedSynchronousCheckpoints = 0
  let checkpointBytesWritten = 0
  let replayedBatches = 0
  let skippedDuplicateBatches = 0
  let tornTailsRecovered = 0
  let tornTailsTruncated = 0
  let tornTailBytesTruncated = 0
  let corruptSegmentRejects = 0
  let segmentsSetAside = 0
  let checkpointsReadAsAbsent = 0
  /** Chats whose checkpoint a load read as absent, logged once each. */
  const checkpointsAbsentLogged = new Set<string>()
  /** Chats whose active segment stops at a line that does not chain: no line may follow it. */
  const brokenChains = new Set<string>()
  /**
   * Segments a read found not to chain and could not move, because reads may
   * not change the directory here or the write gate refused: moved by the next
   * write to the chat, before it writes.
   */
  const unmovedSetAside = new Map<string, readonly SetAsideSegment[]>()
  /** Set-aside segments already logged, so one left in place is logged once. */
  const setAsideLogged = new Set<string>()
  let tombstoneRejects = 0
  /** Segments whose tail the writer must inspect before its next append lands. */
  const suspectTailPaths = new Set<string>()

  /** Unsettled deferred flushes, by journal file. An entry's fd is closed by
   * its own completion callback exactly once; draining marks entries settled
   * and flushes via a fresh fd, so the two paths never race on a handle. */
  interface PendingDeferredFsync {
    fd: number
    settled: boolean
    waiters: Array<(error?: NodeJS.ErrnoException | null) => void>
  }
  const pendingDeferredByPath = new Map<string, Set<PendingDeferredFsync>>()
  const fsyncEscalatedChatIds = new Set<string>()
  const deferredFailureByChat = new Map<string, NodeJS.ErrnoException>()
  let pendingDeferredCount = 0
  if (canWrite()) {
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    removePreparedCheckpointFiles(baseDir, undefined, true)
  }

  const assertChatId = (chatId: string): void => {
    if (!CHAT_ID_PATTERN.test(chatId)) throw new Error(`Unsafe chat id: ${chatId}`)
  }

  const checkpointPath = (chatId: string): string => path.join(baseDir, `${chatId}.checkpoint.json`)
  const journalPath = (chatId: string): string => path.join(baseDir, `${chatId}.mutations.jsonl`)
  const tombstonePath = (chatId: string): string => path.join(baseDir, `${chatId}.tombstone`)

  const fsyncDirectory = (): void => {
    let fd: number | null = null
    try {
      fd = fs.openSync(baseDir, 'r')
      fs.fsyncSync(fd)
    } catch {
      // Directory fsync is not available on every supported platform. The
      // file itself remains fsynced and replay is still fail-closed.
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          /* best effort */
        }
      }
    }
  }

  /**
   * A name for a file before it is renamed into place. A power cut can leave
   * one behind, name and all, and a later process may have the same pid and
   * count its writes from zero again: the random number keeps a name left
   * behind from being chosen again.
   */
  const temporaryPath = (filePath: string): string =>
    path.join(
      baseDir,
      `.${path.basename(filePath)}.${process.pid}.${writeSequence++}.${randomInt(TEMPORARY_NAME_RANGE)}.tmp`
    )

  const atomicWrite = (filePath: string, data: string): number => {
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    const tempPath = temporaryPath(filePath)
    let fd: number | null = null
    try {
      fd = fs.openSync(tempPath, 'wx+', 0o600)
      fs.writeFileSync(fd, data, 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = null
      fs.renameSync(tempPath, filePath)
      fsyncDirectory()
      return Buffer.byteLength(data, 'utf8')
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          /* best effort */
        }
      }
      try {
        fs.unlinkSync(tempPath)
      } catch {
        /* best effort */
      }
      throw error
    }
  }

  /**
   * As `atomicWrite`, without its syncs: the file is owed to the chat's next
   * barrier, and the caller owes the directory its new name.
   */
  const writeUnsynced = (chatId: string, filePath: string, data: string): number => {
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    const tempPath = temporaryPath(filePath)
    let fd: number | null = null
    try {
      fd = fs.openSync(tempPath, 'wx+', 0o600)
      fs.writeFileSync(fd, data, 'utf8')
      fs.closeSync(fd)
      fd = null
      fs.renameSync(tempPath, filePath)
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          /* best effort */
        }
      }
      try {
        fs.unlinkSync(tempPath)
      } catch {
        /* best effort */
      }
      throw error
    }
    noteDebt!(chatId, { file: filePath, owner: 'journal' })
    return Buffer.byteLength(data, 'utf8')
  }

  // The journal file is created lazily by its first append (initialize, a
  // checkpoint, delete, clear and re-anchor all unlink it). Fsyncing the file
  // makes its bytes durable but not its name, so an append that creates it
  // also fsyncs the directory, or a power loss can drop an acknowledged
  // revision with no gap to show for it. An empty file stands in for "created
  // here": re-fsyncing the directory for a leftover empty file is harmless.
  const createdByThisAppend = (fd: number): boolean => fs.fstatSync(fd).size === 0

  /**
   * Put the whole line in the file, or throw. One write call may take only
   * part of what it is given without failing; a line left short there would
   * count as appended and take every later line with it on the next load.
   */
  const writeLine = (fd: number, line: string): number => {
    const bytes = Buffer.from(line, 'utf8')
    let written = 0
    while (written < bytes.length) {
      const count = fs.writeSync(fd, bytes, written, bytes.length - written)
      if (count <= 0) {
        throw new Error(
          `Incremental chat journal wrote ${written} of ${bytes.length} bytes of a line`
        )
      }
      written += count
    }
    return bytes.length
  }

  /**
   * Write the line and sync it. A sync that fails after the whole line was
   * written is handed back, not thrown: the line is in the file either way,
   * and the caller has to account for it before it reports the failure.
   */
  const appendLine = (
    filePath: string,
    line: string,
    explicitImmediate = false
  ): { bytes: number; syncFailure: NodeJS.ErrnoException | null } => {
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    const fd = fs.openSync(filePath, 'a', 0o600)
    let created = false
    let bytes: number
    let syncFailure: NodeJS.ErrnoException | null = null
    try {
      created = createdByThisAppend(fd)
      bytes = writeLine(fd, line)
      if (explicitImmediate) observeResidual(options.residualObserver, 'd2d3Durability')
      try {
        fs.fsyncSync(fd)
      } catch (error) {
        syncFailure = error as NodeJS.ErrnoException
      }
    } finally {
      fs.closeSync(fd)
    }
    if (created) fsyncDirectory()
    return { bytes, syncFailure }
  }

  /** D1 append: the write is synchronous (ordering + same-process visibility
   * unchanged); only the disk flush leaves the caller's critical path. */
  const appendLineDeferred = (filePath: string, line: string, chatId: string): number => {
    if (options.descriptorCache) {
      options.descriptorCache.append(chatId, filePath, line, 'deferred')
      return Buffer.byteLength(line, 'utf8')
    }
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    const fd = fs.openSync(filePath, 'a', 0o600)
    let created: boolean
    let bytes: number
    try {
      created = createdByThisAppend(fd)
      bytes = writeLine(fd, line)
    } catch (error) {
      // The line is not in the file, or not all of it: the append has failed.
      // Only a failure to schedule the flush, below, is made good in line.
      try {
        fs.closeSync(fd)
      } catch {
        /* the write failure is the one to report */
      }
      throw error
    }
    let entries = pendingDeferredByPath.get(filePath)
    if (!entries) {
      entries = new Set()
      pendingDeferredByPath.set(filePath, entries)
    }
    const entry: PendingDeferredFsync = { fd, settled: false, waiters: [] }
    try {
      // Only the file's flush is deferred. Its name is made durable here, once
      // per file, so no later barrier on this path can outrun it.
      if (created) fsyncDirectory()
      entries.add(entry)
      pendingDeferredCount += 1
      scheduleFsync(fd, (error) => {
        const wasSettled = entry.settled
        if (!wasSettled) {
          entry.settled = true
          entries!.delete(entry)
          pendingDeferredCount -= 1
          for (const waiter of entry.waiters.splice(0)) waiter(error)
        }
        try {
          fs.closeSync(fd)
        } catch {
          /* already closed handles are the only expected failure here */
        }
        if (!wasSettled && error) {
          deferredFailureByChat.set(chatId, error)
          deferredFsyncFailures += 1
          fsyncEscalatedChatIds.add(chatId)
          console.error(`[incremental-chat] deferred journal fsync failed for ${chatId}`, error)
        }
      })
    } catch (error) {
      // Scheduling itself failed: keep the D1 contract by flushing inline.
      if (!entry.settled && entries.delete(entry)) pendingDeferredCount -= 1
      try {
        fs.fsyncSync(fd)
        entry.settled = true
        for (const waiter of entry.waiters.splice(0)) waiter(null)
      } finally {
        fs.closeSync(fd)
      }
      void error
    }
    return bytes
  }

  /**
   * Write the line and leave the disk owed for it: no sync is issued here, now
   * or later. The directory is owed too when this line made the segment.
   */
  const appendLineUnsynced = (
    filePath: string,
    line: string,
    chatId: string,
    note: NoteThreadDurabilityDebt
  ): number => {
    if (options.descriptorCache) {
      options.descriptorCache.append(chatId, filePath, line, {
        owed: (directory) => note(chatId, { directory })
      })
      note(chatId, { file: filePath, owner: 'journal' })
      return Buffer.byteLength(line, 'utf8')
    }
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    const fd = fs.openSync(filePath, 'a', 0o600)
    let created: boolean
    let bytes: number
    try {
      created = createdByThisAppend(fd)
      bytes = writeLine(fd, line)
    } finally {
      fs.closeSync(fd)
    }
    if (created) note(chatId, { directory: baseDir })
    note(chatId, { file: filePath, owner: 'journal' })
    return bytes
  }

  const drainDeferredDurability = (): number => {
    assertWritable()
    if (options.descriptorCache) {
      if (!options.descriptorDrainSync) throw new Error('Journal descriptor drain unavailable')
      options.descriptorDrainSync()
      return 0
    }
    let drained = 0
    const paths = new Set([
      ...pendingDeferredByPath.keys(),
      ...[...deferredFailureByChat.keys()].map(journalPath)
    ])
    for (const filePath of paths) {
      const entries = pendingDeferredByPath.get(filePath) ?? new Set<PendingDeferredFsync>()
      const chatId = path.basename(filePath, '.mutations.jsonl')
      const unsettled = [...entries].filter((entry) => !entry.settled)
      if (unsettled.length === 0 && !deferredFailureByChat.has(chatId)) continue
      try {
        // 'r+' rather than 'r': Windows FlushFileBuffers requires write access,
        // so fsync on a read-only handle fails with EPERM. That error landed in
        // the catch below, which assumes a deleted file, so every deferred
        // append silently went unflushed on Windows and the drain reported 0.
        const fd = fs.openSync(filePath, 'r+')
        try {
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
      } catch {
        // The file is gone (chat deleted/purged mid-flight); nothing to flush.
        continue
      }
      deferredFailureByChat.delete(chatId)
      for (const entry of unsettled) {
        entry.settled = true
        entries.delete(entry)
        pendingDeferredCount -= 1
        drained += 1
        for (const waiter of entry.waiters.splice(0)) waiter(null)
      }
    }
    drainedDeferredFsyncs += drained
    return drained
  }

  const awaitDeferredDurability = async (chatId: string): Promise<void> => {
    assertChatId(chatId)
    if (options.descriptorCache) return options.descriptorCache.awaitDurable(chatId)
    const failure = deferredFailureByChat.get(chatId)
    if (failure) throw failure
    const entries = [...(pendingDeferredByPath.get(journalPath(chatId)) ?? [])].filter(
      (entry) => !entry.settled
    )
    await Promise.all(
      entries.map(
        (entry) =>
          new Promise<void>((resolve, reject) => {
            entry.waiters.push((error) => (error ? reject(error) : resolve()))
          })
      )
    )
  }

  const acknowledgeJournalBarrier = (chatId: string): void => {
    deferredFailureByChat.delete(chatId)
    const entries = pendingDeferredByPath.get(journalPath(chatId))
    for (const entry of entries ?? []) {
      if (entry.settled) continue
      entry.settled = true
      pendingDeferredCount -= 1
      for (const waiter of entry.waiters.splice(0)) waiter(null)
    }
    pendingDeferredByPath.delete(journalPath(chatId))
  }

  const readCheckpoint = (chatId: string): IncrementalChatCheckpoint | null => {
    let raw: string
    try {
      raw = fs.readFileSync(checkpointPath(chatId), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      if (!noteDebt) throw new Error(`Incremental chat checkpoint for ${chatId} is corrupt`)
      // A first checkpoint a power cut left only part of: see `noteDurabilityDebt`.
      if (!checkpointsAbsentLogged.has(chatId)) {
        checkpointsAbsentLogged.add(chatId)
        checkpointsReadAsAbsent += 1
        console.warn(
          `[incremental-chat] the checkpoint of ${chatId} does not parse and is read as absent`
        )
      }
      return null
    }
    if (!validCheckpoint(parsed, chatId)) {
      throw new Error(`Incremental chat checkpoint for ${chatId} has an invalid shape`)
    }
    return parsed
  }

  const parseSegment = (chatId: string, filePath: string): ParsedJournal => {
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { batches: [], bytes: 0, torn: false, validContent: '' }
      }
      throw error
    }
    if (stat.size > maxJournalReadBytes) {
      throw new Error(`Incremental chat journal for ${chatId} exceeds ${maxJournalReadBytes} bytes`)
    }

    const raw = fs.readFileSync(filePath, 'utf8')
    const complete = raw.endsWith('\n')
    const lines = raw.split('\n')
    const batches: ChatRecordMutationBatch[] = []
    const validLines: string[] = []
    let torn = !complete && raw.length > 0
    const limit = complete ? lines.length - 1 : lines.length - 1

    for (let index = 0; index < limit; index += 1) {
      const line = lines[index]
      if (!line) continue
      try {
        const parsed = JSON.parse(line) as unknown
        if (!validMutationBatch(parsed, chatId)) throw new Error('invalid batch')
        batches.push(parsed)
        validLines.push(line)
      } catch {
        torn = true
        break
      }
    }

    return {
      batches,
      bytes: stat.size,
      torn,
      validContent: validLines.length > 0 ? `${validLines.join('\n')}\n` : ''
    }
  }

  const recoverTornTail = (
    chatId: string,
    parsed: ParsedJournal,
    filePath = journalPath(chatId)
  ): void => {
    if (!parsed.torn) return
    options.descriptorCache?.retireSync([chatId])
    invalidatePreparation(chatId)
    options.beforeSourceMutation?.(chatId)
    if (parsed.validContent) atomicWrite(filePath, parsed.validContent)
    else {
      try {
        fs.unlinkSync(filePath)
        fsyncDirectory()
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    parsed.bytes = Buffer.byteLength(parsed.validContent, 'utf8')
    tornTailsRecovered += 1
  }

  // Readers discover rotated files regardless of rollout flags. Each segment's
  // repair remains behind the existing authority boundary; never concatenate
  // a torn sealed suffix with active bytes and rewrite them as one file.
  const sealedPath = (chatId: string): string =>
    path.join(baseDir, `${chatId}.sealed.mutations.jsonl`)
  const setAsidePath = (chatId: string): string =>
    path.join(baseDir, `${chatId}.set-aside.mutations.jsonl`)
  const parseSegments = (chatId: string): { sealed: ParsedJournal; active: ParsedJournal } => {
    const sealed = parseSegment(chatId, sealedPath(chatId))
    const active = parseSegment(chatId, journalPath(chatId))
    if (canRepair()) {
      recoverTornTail(chatId, sealed, sealedPath(chatId))
      recoverTornTail(chatId, active)
    } else if (options.repairTornTailBeforeAppend) {
      // A read only remembers what it saw; the next append does the repair.
      if (sealed.torn) suspectTailPaths.add(sealedPath(chatId))
      if (active.torn) suspectTailPaths.add(journalPath(chatId))
    }
    return { sealed, active }
  }
  const parseJournal = (chatId: string): ParsedJournal => {
    const { sealed, active } = parseSegments(chatId)
    return {
      batches: [...sealed.batches, ...active.batches],
      bytes: sealed.bytes + active.bytes,
      torn: sealed.torn || active.torn,
      validContent: ''
    }
  }

  /**
   * Under `noteDurabilityDebt`: the longest chain from the checkpoint with no
   * gap, through the sealed segment and then the active one. A segment whose
   * first line past the head does not chain, or any segment when there is no
   * checkpoint, is not part of it; a line that does not chain after lines of
   * its own segment that did ends what that segment adds.
   */
  const chainUnderDebt = (
    chatId: string,
    checkpointRevision: number | null
  ): {
    batches: ChatRecordMutationBatch[]
    revision: number | null
    skipped: number
    entries: number
    bytes: number
    aside: SetAsideSegment[]
    broken: boolean
    torn: boolean
  } => {
    const { sealed, active } = parseSegments(chatId)
    let head = checkpointRevision
    const batches: ChatRecordMutationBatch[] = []
    const aside: SetAsideSegment[] = []
    let skipped = 0
    let entries = 0
    let bytes = 0
    let broken = false
    for (const [filePath, parsed] of [
      [sealedPath(chatId), sealed],
      [journalPath(chatId), active]
    ] as const) {
      let applied = 0
      let chains = true
      if (head === null) chains = parsed.batches.length === 0
      else {
        for (const batch of parsed.batches) {
          if (batch.revision <= head) {
            skipped += 1
            continue
          }
          if (batch.baseRevision !== head) {
            if (applied === 0) chains = false
            else if (filePath === journalPath(chatId)) broken = true
            break
          }
          batches.push(batch)
          head = batch.revision
          applied += 1
        }
      }
      if (chains) {
        entries += parsed.batches.length
        bytes += parsed.bytes
      } else {
        aside.push({
          filePath,
          first: parsed.batches[0].revision,
          last: parsed.batches[parsed.batches.length - 1].revision
        })
      }
    }
    return {
      batches,
      revision: head,
      skipped,
      entries,
      bytes,
      aside,
      broken,
      torn: sealed.torn || active.torn
    }
  }

  /**
   * Move segments that do not chain out of every reader's way, kept until
   * erasure or the next checkpoint. A read moves them only where reads may
   * change the directory (`canRepairOnRead`) and the write gate allows it;
   * otherwise they stay where they are, are read past, and are moved by the
   * next write to the chat before it writes, so that no line is ever written
   * after one that does not chain.
   */
  const setAside = (chatId: string, aside: readonly SetAsideSegment[], writing: boolean): void => {
    if (aside.length === 0) {
      unmovedSetAside.delete(chatId)
      return
    }
    for (const { filePath, first, last } of aside) {
      const logged = `${filePath}:${first}:${last}`
      if (setAsideLogged.has(logged)) continue
      setAsideLogged.add(logged)
      console.warn(
        `[incremental-chat] a segment of ${chatId} does not chain and is set aside: ` +
          `revisions ${first} to ${last}`
      )
    }
    let may = noteDebt !== undefined && (writing ? canWrite() : canRepair())
    if (may && !writing) {
      try {
        options.beforeSourceMutation?.(chatId)
      } catch {
        may = false
      }
    }
    if (!may || !noteDebt) {
      unmovedSetAside.set(chatId, aside)
      return
    }
    invalidatePreparation(chatId)
    options.descriptorCache?.retireSync([chatId])
    for (const { filePath } of aside) {
      const target = setAsidePath(chatId)
      if (fs.existsSync(target)) {
        // One name per chat, so that erasure finds it: a second one is added to it.
        fs.appendFileSync(target, fs.readFileSync(filePath))
        fs.unlinkSync(filePath)
        noteDebt(chatId, { file: target, owner: 'journal' })
      } else {
        fs.renameSync(filePath, target)
        noteDebt(chatId, { file: target, owner: 'journal', renamedFrom: filePath })
      }
      suspectTailPaths.delete(filePath)
      segmentsSetAside += 1
    }
    noteDebt(chatId, { directory: baseDir })
    unmovedSetAside.delete(chatId)
  }

  /** A write is about to change the chat's segments: first move what a read could not. */
  const moveUnmovedSetAside = (chatId: string): void => {
    const unmoved = unmovedSetAside.get(chatId)
    if (unmoved) setAside(chatId, unmoved, true)
  }

  /** The chat's segments are gone or rewritten: nothing is broken or waits to be moved. */
  const forgetChainDamage = (chatId: string): void => {
    brokenChains.delete(chatId)
    unmovedSetAside.delete(chatId)
  }

  /** Remove what a checkpoint or erasure leaves no reader for: the set-aside segments. */
  const removeSetAside = (chatId: string): void => {
    try {
      fs.unlinkSync(setAsidePath(chatId))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  const replayableLine = (chatId: string, line: Buffer): boolean => {
    // The parser skips an empty line, so it is not damage.
    if (line.length === 0) return true
    try {
      return validMutationBatch(JSON.parse(line.toString('utf8')), chatId)
    } catch {
      return false
    }
  }

  /**
   * Cut the torn fragment off each suspect segment of one chat, each file on
   * its own and in place: a torn sealed tail is never carried into the active
   * segment. False means the active segment is damaged and must not grow.
   */
  const repairSuspectTails = (chatId: string, state: RuntimeState): boolean => {
    for (const filePath of [sealedPath(chatId), journalPath(chatId)]) {
      if (!suspectTailPaths.has(filePath)) continue
      const repair = repairSegmentTornTail(filePath, {
        maxBytes: maxJournalReadBytes,
        isValidLine: (line) => replayableLine(chatId, line),
        beforeSourceMutation: () => options.beforeSourceMutation?.(chatId),
        retireDescriptor: () => {
          invalidatePreparation(chatId)
          options.descriptorCache?.retireSync([chatId])
        }
      })
      // Nothing is appended to a sealed segment, so damage there poisons nothing.
      if (repair.status === 'corrupt' && filePath === journalPath(chatId)) return false
      suspectTailPaths.delete(filePath)
      if (repair.status !== 'repaired') continue
      tornTailsTruncated += 1
      tornTailBytesTruncated += repair.removedBytes
      state.journalBytes = Math.max(0, state.journalBytes - repair.removedBytes)
    }
    return true
  }

  const validateRevisionChain = (
    chatId: string,
    startRevision: number,
    batches: readonly ChatRecordMutationBatch[]
  ): { revision: number; skipped: number } => {
    let revision = startRevision
    let skipped = 0
    for (const batch of batches) {
      if (batch.revision <= revision) {
        skipped += 1
        continue
      }
      if (batch.baseRevision !== revision) {
        throw new Error(
          `Incremental chat journal revision gap for ${chatId}: ` +
            `head ${revision}, batch ${batch.baseRevision} -> ${batch.revision}`
        )
      }
      revision = batch.revision
    }
    return { revision, skipped }
  }

  const loadState = (chatId: string): RuntimeState => {
    assertChatId(chatId)
    const existing = states.get(chatId)
    if (existing) return existing
    const tombstoned = fs.existsSync(tombstonePath(chatId))
    const checkpoint = tombstoned ? null : readCheckpoint(chatId)
    if (noteDebt && !tombstoned) {
      const chained = chainUnderDebt(chatId, checkpoint?.revision ?? null)
      setAside(chatId, chained.aside, false)
      if (chained.broken) brokenChains.add(chatId)
      else brokenChains.delete(chatId)
      const firstMs = Date.parse(chained.batches[0]?.savedAt ?? '')
      const lastMs = Date.parse(chained.batches.at(-1)?.savedAt ?? '')
      const loaded: RuntimeState = {
        headRevision: checkpoint ? chained.revision : null,
        journalEntries: chained.entries,
        journalBytes: chained.bytes,
        dirtySinceMs: chained.entries > 0 ? (Number.isFinite(firstMs) ? firstMs : now()) : null,
        lastAppendAtMs: chained.entries > 0 ? (Number.isFinite(lastMs) ? lastMs : now()) : null,
        tombstoned
      }
      skippedDuplicateBatches += chained.skipped
      states.set(chatId, loaded)
      return loaded
    }
    const parsed = tombstoned
      ? { batches: [], bytes: 0, torn: false, validContent: '' }
      : parseJournal(chatId)
    if (!checkpoint && parsed.batches.length > 0) {
      throw new Error(`Incremental chat journal for ${chatId} has no checkpoint baseline`)
    }
    const chain = checkpoint
      ? validateRevisionChain(chatId, checkpoint.revision, parsed.batches)
      : { revision: 0, skipped: 0 }
    const firstSavedAt = parsed.batches[0]?.savedAt
    const lastSavedAt = parsed.batches.at(-1)?.savedAt
    const firstMs = firstSavedAt ? Date.parse(firstSavedAt) : Number.NaN
    const lastMs = lastSavedAt ? Date.parse(lastSavedAt) : Number.NaN
    const state: RuntimeState = {
      headRevision: checkpoint ? chain.revision : null,
      journalEntries: parsed.batches.length,
      journalBytes: parsed.bytes,
      dirtySinceMs: parsed.batches.length > 0 ? (Number.isFinite(firstMs) ? firstMs : now()) : null,
      lastAppendAtMs: parsed.batches.length > 0 ? (Number.isFinite(lastMs) ? lastMs : now()) : null,
      tombstoned
    }
    skippedDuplicateBatches += chain.skipped
    states.set(chatId, state)
    return state
  }

  const initialize = (chatId: string, record: ChatRecord): void => {
    invalidatePreparation(chatId)
    options.beforeSourceMutation?.(chatId)
    assertWritable()
    assertChatId(chatId)
    if (record.appChatId !== chatId) throw new Error('Checkpoint chat identity mismatch')
    const state = loadState(chatId)
    if (state.tombstoned) {
      tombstoneRejects += 1
      throw new Error(`Chat ${chatId} is tombstoned`)
    }
    const revision = recordRevision(record)
    if (state.headRevision !== null) {
      if (state.headRevision !== revision) {
        throw new Error(
          `Incremental chat baseline mismatch for ${chatId}: ${state.headRevision} != ${revision}`
        )
      }
      return
    }
    const checkpoint: IncrementalChatCheckpoint = {
      format: INCREMENTAL_CHAT_CHECKPOINT_FORMAT,
      version: INCREMENTAL_CHAT_CHECKPOINT_VERSION,
      chatId,
      revision,
      savedAt: new Date(now()).toISOString(),
      reason: 'initial',
      // Serialized immediately below; see replaceAuthoritativeCheckpoint.
      record
    }
    // Under the barrier, as a line is: nothing is lost if a power cut takes
    // it, since no barrier has resolved for the chat. See `noteDurabilityDebt`.
    const bytes = noteDebt
      ? writeUnsynced(chatId, checkpointPath(chatId), JSON.stringify(checkpoint))
      : atomicWrite(checkpointPath(chatId), JSON.stringify(checkpoint))
    options.descriptorCache?.retireSync([chatId])
    for (const filePath of [sealedPath(chatId), journalPath(chatId)]) {
      try {
        fs.unlinkSync(filePath)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    removeSetAside(chatId)
    forgetChainDamage(chatId)
    if (noteDebt) noteDebt(chatId, { directory: baseDir })
    else fsyncDirectory()
    checkpointsWritten += 1
    checkpointBytesWritten += bytes
    state.headRevision = revision
  }

  const replay = (chatId: string): IncrementalChatReplayResult => {
    assertChatId(chatId)
    const state = loadState(chatId)
    if (state.tombstoned) {
      return {
        record: null,
        revision: null,
        appliedBatches: 0,
        skippedBatches: 0,
        recoveredTornTail: false
      }
    }
    const checkpoint = readCheckpoint(chatId)
    if (!checkpoint) {
      return {
        record: null,
        revision: null,
        appliedBatches: 0,
        skippedBatches: 0,
        recoveredTornTail: false
      }
    }
    if (noteDebt) {
      const chained = chainUnderDebt(chatId, recordRevision(checkpoint.record))
      setAside(chatId, chained.aside, false)
      if (chained.broken) brokenChains.add(chatId)
      const record = applyChatRecordMutations(checkpoint.record, chained.batches)
      replayedBatches += chained.batches.length
      skippedDuplicateBatches += chained.skipped
      state.headRevision = recordRevision(record)
      state.journalEntries = chained.entries
      state.journalBytes = chained.bytes
      return {
        record,
        revision: recordRevision(record),
        appliedBatches: chained.batches.length,
        skippedBatches: chained.skipped,
        recoveredTornTail: chained.torn && canRepair()
      }
    }
    const parsed = parseJournal(chatId)
    const repairedTornTail = parsed.torn && canRepair()
    const applicableBatches: ChatRecordMutationBatch[] = []
    let revision = recordRevision(checkpoint.record)
    let skippedBatches = 0
    for (const batch of parsed.batches) {
      if (batch.revision <= revision) {
        skippedBatches += 1
        continue
      }
      applicableBatches.push(batch)
      revision = batch.revision
    }
    const record = applyChatRecordMutations(checkpoint.record, applicableBatches)
    const appliedBatches = applicableBatches.length
    replayedBatches += appliedBatches
    skippedDuplicateBatches += skippedBatches
    state.headRevision = recordRevision(record)
    state.journalEntries = parsed.batches.length
    state.journalBytes = parsed.bytes
    return {
      record,
      revision: recordRevision(record),
      appliedBatches,
      skippedBatches,
      recoveredTornTail: repairedTornTail
    }
  }

  /**
   * The checkpoint's head revision from a header-only read — never the full
   * record parse. Returns null when the checkpoint is absent or its header does
   * not yield a top-level revision, both of which the caller treats as "cannot
   * prove a no-op, do the real replay".
   */
  const peekCheckpointRevision = (chatId: string): number | null => {
    let fd: number | null = null
    try {
      fd = fs.openSync(checkpointPath(chatId), 'r')
      const buffer = Buffer.allocUnsafe(CHECKPOINT_HEADER_PROBE_BYTES)
      const read = fs.readSync(fd, buffer, 0, CHECKPOINT_HEADER_PROBE_BYTES, 0)
      const head = buffer.toString('utf8', 0, read)
      // Bound the search to the header: the fat `record` is serialised last, so
      // slicing before it means a `persistenceRevision` (or any nested field)
      // inside the transcript can never be mistaken for the top-level revision.
      const recordAt = head.indexOf('"record"')
      const header = recordAt >= 0 ? head.slice(0, recordAt) : head
      const match = /"revision"\s*:\s*(\d+)/.exec(header)
      if (!match) return null
      const value = Number(match[1])
      return Number.isSafeInteger(value) && value >= 0 ? value : null
    } catch {
      // ENOENT (no checkpoint) or any read error — force the full replay path.
      return null
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          /* best effort */
        }
      }
    }
  }

  const pendingReplayState = (chatId: string): IncrementalChatPendingReplayState => {
    // Never throw from a probe: an unsafe id (or any stat failure) forces the
    // real replay path, which validates and fails exactly as it does today.
    if (!CHAT_ID_PATTERN.test(chatId)) return { hasTail: true, checkpointRevision: null }
    let hasTail = false
    for (const filePath of [sealedPath(chatId), journalPath(chatId)]) {
      try {
        hasTail ||= fs.statSync(filePath).size > 0
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return { hasTail: true, checkpointRevision: null }
        }
      }
    }
    return { hasTail, checkpointRevision: peekCheckpointRevision(chatId) }
  }

  let headRecordResolver: ((chatId: string, headRevision: number) => ChatRecord | null) | null =
    null

  /**
   * The in-memory head, when the caller holds the record at exactly the
   * journal head revision. Replaying instead reads and parses the whole
   * on-disk checkpoint and re-applies the tail — on a 20MB+ thread that was
   * a full-file parse on main for every bounded/idle/terminal checkpoint.
   */
  const resolveHead = (
    chatId: string,
    state: RuntimeState,
    headRecord: ChatRecord | null | undefined
  ): ChatRecord | null => {
    const headRevision = state.headRevision
    if (headRevision === null) return null
    let candidate: ChatRecord | null = headRecord ?? null
    if (!candidate) {
      try {
        candidate = headRecordResolver?.(chatId, headRevision) ?? null
      } catch {
        candidate = null
      }
    }
    if (!candidate || candidate.appChatId !== chatId) return null
    return recordRevision(candidate) === headRevision ? candidate : null
  }

  const checkpoint = (
    chatId: string,
    reason: IncrementalChatCheckpointReason,
    headRecord?: ChatRecord | null
  ): boolean => {
    invalidatePreparation(chatId)
    options.beforeSourceMutation?.(chatId)
    assertWritable()
    assertChatId(chatId)
    const state = loadState(chatId)
    if (state.tombstoned || state.journalEntries === 0) return false
    const inMemoryHead = resolveHead(chatId, state, headRecord)
    const replayed = inMemoryHead
      ? { record: inMemoryHead, revision: recordRevision(inMemoryHead) }
      : replay(chatId)
    if (!replayed.record || replayed.revision === null) return false
    if (inMemoryHead) checkpointsFromMemory += 1
    const nextCheckpoint: IncrementalChatCheckpoint = {
      format: INCREMENTAL_CHAT_CHECKPOINT_FORMAT,
      version: INCREMENTAL_CHAT_CHECKPOINT_VERSION,
      chatId,
      revision: replayed.revision,
      savedAt: new Date(now()).toISOString(),
      reason,
      record: replayed.record
    }
    const bytes = atomicWrite(checkpointPath(chatId), JSON.stringify(nextCheckpoint))
    checkpointsWritten += 1
    checkpointBytesWritten += bytes
    options.afterCheckpointWrite?.(chatId, nextCheckpoint)
    options.descriptorCache?.retireSync([chatId])
    for (const filePath of [sealedPath(chatId), journalPath(chatId)]) {
      try {
        fs.unlinkSync(filePath)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    removeSetAside(chatId)
    forgetChainDamage(chatId)
    // The checkpoint above is on the disk and holds every line just removed.
    // A removal the disk never hears of brings back lines replay passes over.
    if (noteDebt) noteDebt(chatId, { directory: baseDir })
    else fsyncDirectory()
    state.headRevision = replayed.revision
    acknowledgeJournalBarrier(chatId)
    state.journalEntries = 0
    state.journalBytes = 0
    state.dirtySinceMs = null
    state.lastAppendAtMs = null
    return true
  }

  const replaceAuthoritativeCheckpoint = (chatId: string, record: ChatRecord): void => {
    invalidatePreparation(chatId)
    options.beforeSourceMutation?.(chatId)
    assertWritable()
    assertChatId(chatId)
    if (record.appChatId !== chatId) throw new Error('Checkpoint chat identity mismatch')
    const state = loadState(chatId)
    if (state.tombstoned) {
      tombstoneRejects += 1
      throw new Error(`Chat ${chatId} is tombstoned`)
    }
    const revision = recordRevision(record)
    const nextCheckpoint: IncrementalChatCheckpoint = {
      format: INCREMENTAL_CHAT_CHECKPOINT_FORMAT,
      version: INCREMENTAL_CHAT_CHECKPOINT_VERSION,
      chatId,
      revision,
      savedAt: new Date(now()).toISOString(),
      reason: 'recovery',
      // Serialized immediately below, so the snapshot IS the stringify; a
      // JSON clone first only doubled a whole-record parse+stringify.
      record
    }
    const bytes = atomicWrite(checkpointPath(chatId), JSON.stringify(nextCheckpoint))
    options.descriptorCache?.retireSync([chatId])
    checkpointsWritten += 1
    checkpointBytesWritten += bytes
    for (const filePath of [sealedPath(chatId), journalPath(chatId)]) {
      try {
        fs.unlinkSync(filePath)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    removeSetAside(chatId)
    forgetChainDamage(chatId)
    fsyncDirectory()
    state.headRevision = revision
    state.journalEntries = 0
    acknowledgeJournalBarrier(chatId)
    state.journalBytes = 0
    state.dirtySinceMs = null
    state.lastAppendAtMs = null
  }

  const captureSource = (chatId: string, revision: number): JournalCaptureLease | null => {
    assertChatId(chatId)
    const state = states.get(chatId)
    if (
      !state ||
      state.tombstoned ||
      state.headRevision !== revision ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      fs.existsSync(tombstonePath(chatId))
    )
      return null
    const generation = captureEpochs.get(chatId) ?? 0
    captureEpochs.set(chatId, generation)
    const opened: number[] = []
    let released = false
    const close = (): void => {
      if (released) return
      released = true
      let failure: unknown
      for (const fd of opened) {
        try {
          fs.closeSync(fd)
        } catch (error) {
          failure ??= error
        }
      }
      if (failure) throw failure
    }
    const open = (filePath: string, mutablePrefix: boolean): JournalCaptureReadReference => {
      const file = checkpointFileReference(filePath)
      const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      opened.push(fd)
      const stat = fs.fstatSync(fd, { bigint: true })
      if (
        !stat.isFile() ||
        String(stat.dev) !== file.identity.dev ||
        String(stat.ino) !== file.identity.ino ||
        Number(stat.size) !== file.identity.size ||
        String(stat.mtimeNs) !== file.identity.mtimeNs
      )
        throw new Error('Capture source changed during open')
      return Object.freeze({
        file: Object.freeze({ ...file, identity: Object.freeze({ ...file.identity }) }),
        fd,
        prefixBytes: file.identity.size,
        mutablePrefix
      })
    }
    try {
      const checkpoint = open(checkpointPath(chatId), false)
      const sealed = fs.existsSync(sealedPath(chatId)) ? open(sealedPath(chatId), false) : null
      const active = fs.existsSync(journalPath(chatId)) ? open(journalPath(chatId), true) : null
      const current = (reference: JournalCaptureReadReference, paths: string[]): boolean => {
        const identity = reference.file.identity
        const same = (stat: fs.BigIntStats): boolean =>
          stat.isFile() &&
          String(stat.dev) === identity.dev &&
          String(stat.ino) === identity.ino &&
          (reference.mutablePrefix
            ? Number(stat.size) >= reference.prefixBytes
            : Number(stat.size) === reference.prefixBytes &&
              String(stat.mtimeNs) === identity.mtimeNs)
        if (!same(fs.fstatSync(reference.fd, { bigint: true }))) return false
        return paths.some((filePath) => {
          try {
            return same(fs.lstatSync(filePath, { bigint: true }))
          } catch {
            return false
          }
        })
      }
      return Object.freeze({
        chatId,
        revision,
        generation,
        checkpoint,
        sealed,
        active,
        isCurrent: (): boolean => {
          if (
            released ||
            (captureEpochs.get(chatId) ?? 0) !== generation ||
            states.get(chatId) !== state ||
            state.tombstoned ||
            fs.existsSync(tombstonePath(chatId))
          )
            return false
          try {
            return (
              current(checkpoint, [checkpointPath(chatId)]) &&
              (!sealed || current(sealed, [sealedPath(chatId)])) &&
              (!active || current(active, [journalPath(chatId), sealedPath(chatId)]))
            )
          } catch {
            return false
          }
        },
        release: close,
        cancel: close
      })
    } catch (error) {
      try {
        close()
      } catch {
        /* Preserve the source-open failure. */
      }
      throw error
    }
  }

  const rotateForPreparation = (chatId: string): CheckpointPreparationSource | null => {
    assertWritable()
    assertChatId(chatId)
    if (!options.rotationEnabled || !options.descriptorCache) return null
    const state = states.get(chatId)
    if (!state || state.tombstoned || state.headRevision === null || state.journalEntries === 0)
      return null
    if (fs.existsSync(sealedPath(chatId))) return null
    // A tail known to be torn is repaired by the next append, never sealed as it is.
    if (suspectTailPaths.has(journalPath(chatId))) return null
    // Nor is a segment that stops at a line that does not chain.
    if (brokenChains.has(chatId)) return null
    options.beforeSourceMutation?.(chatId)
    if (!canWrite() || fs.existsSync(tombstonePath(chatId))) return null
    const revision = state.headRevision
    const checkpoint = checkpointFileReference(checkpointPath(chatId))
    if (noteDebt) {
      options.descriptorCache.rotate(chatId, sealedPath(chatId), {
        owed: (directory) => noteDebt(chatId, { directory })
      })
      // The bytes the active segment was owed for now sit under this name,
      // and a barrier already running may reach the old name only after this.
      noteDebt(chatId, {
        file: sealedPath(chatId),
        owner: 'journal',
        renamedFrom: journalPath(chatId)
      })
    } else options.descriptorCache.rotate(chatId, sealedPath(chatId))
    // Existing production worker accepts checkpoint + one immutable journal.
    // That journal is now sealed at exactly R; streaming goes to another inode.
    const source = {
      chatId,
      revision,
      savedAt: new Date(now()).toISOString(),
      checkpoint,
      journal: checkpointFileReference(sealedPath(chatId))
    }
    rotatedSources.set(chatId, source)
    rotatedAccounting.set(chatId, { entries: state.journalEntries, bytes: state.journalBytes })
    return source
  }

  const append = (
    batch: ChatRecordMutationBatch,
    appendOptions?: IncrementalChatAppendOptions
  ): void => {
    if (!options.rotationEnabled) invalidatePreparation(batch.chatId, false)
    options.beforeSourceMutation?.(batch.chatId)
    assertWritable()
    assertChatId(batch.chatId)
    if (!validMutationBatch(batch, batch.chatId)) throw new Error('Invalid chat mutation batch')
    const state = loadState(batch.chatId)
    if (state.tombstoned) {
      tombstoneRejects += 1
      throw new Error(`Chat ${batch.chatId} is tombstoned`)
    }
    if (state.headRevision === null) {
      throw new Error(`Chat ${batch.chatId} must be initialized before append`)
    }
    if (batch.baseRevision !== state.headRevision) {
      throw new Error(
        `Incremental chat append revision mismatch for ${batch.chatId}: ` +
          `${state.headRevision} != ${batch.baseRevision}`
      )
    }
    moveUnmovedSetAside(batch.chatId)
    if (
      brokenChains.has(batch.chatId) ||
      (suspectTailPaths.size > 0 && !repairSuspectTails(batch.chatId, state))
    ) {
      corruptSegmentRejects += 1
      throw new Error(
        `Incremental chat journal for ${batch.chatId} is damaged; refusing to append after it`
      )
    }
    // A deferred request escalates to sync for exactly one append after a
    // failed deferred flush (re-establishing durable ground before deferring
    // again), and whenever the pending set is saturated (backpressure). A
    // journal that leaves syncing to the thread barrier defers nothing: no
    // flush is ever pending for it, so there is nothing to saturate or fail.
    const deferred =
      !noteDebt &&
      appendOptions?.durability === 'deferred' &&
      !fsyncEscalatedChatIds.delete(batch.chatId) &&
      pendingDeferredCount < MAX_PENDING_DEFERRED_FSYNCS
    const line = `${JSON.stringify(batch)}\n`
    // A write that throws part-way leaves a fragment only this mark remembers.
    if (options.repairTornTailBeforeAppend) suspectTailPaths.add(journalPath(batch.chatId))
    let bytes: number
    let syncFailure: NodeJS.ErrnoException | null = null
    if (noteDebt) {
      bytes = appendLineUnsynced(journalPath(batch.chatId), line, batch.chatId, noteDebt)
      unsyncedAppends += 1
    } else if (options.descriptorCache && !deferred) {
      if (appendOptions?.durability !== 'deferred')
        observeResidual(options.residualObserver, 'd2d3Durability')
      options.descriptorCache.append(batch.chatId, journalPath(batch.chatId), line, 'immediate')
      bytes = Buffer.byteLength(line, 'utf8')
    } else if (deferred) {
      bytes = appendLineDeferred(journalPath(batch.chatId), line, batch.chatId)
    } else {
      const written = appendLine(
        journalPath(batch.chatId),
        line,
        appendOptions?.durability !== 'deferred'
      )
      bytes = written.bytes
      syncFailure = written.syncFailure
    }
    if (options.repairTornTailBeforeAppend) suspectTailPaths.delete(journalPath(batch.chatId))
    if (!deferred && !syncFailure) acknowledgeJournalBarrier(batch.chatId)
    if (deferred) deferredAppends += 1
    appends += 1
    mutationBytesWritten += bytes
    state.headRevision = batch.revision
    state.journalEntries += 1
    state.journalBytes += bytes
    state.dirtySinceMs ??= now()
    state.lastAppendAtMs = now()
    if (syncFailure) {
      // The line is in the file, so the head has moved with it: a second line
      // at this revision would be passed over as a duplicate on every later
      // load. What failed is the promise that the line is on the disk. The
      // caller is told, and the chat owes a flush until a sync pays it.
      immediateFsyncFailures += 1
      deferredFailureByChat.set(batch.chatId, syncFailure)
      fsyncEscalatedChatIds.add(batch.chatId)
      throw syncFailure
    }

    if (
      state.journalEntries >= maxJournalEntries ||
      state.journalBytes >= maxJournalBytes ||
      (state.dirtySinceMs !== null && now() - state.dirtySinceMs >= maxUncheckpointedMs)
    ) {
      if (options.rotationEnabled) {
        if (fs.existsSync(sealedPath(batch.chatId))) {
          // Ratified S4: an outstanding sealed segment cannot disable bounds.
          // The covering checkpoint permits both inode retirements and removal.
          forcedSynchronousCheckpoints += 1
          observeResidual(options.residualObserver, 'forcedSynchronousCheckpoints')
          checkpoint(batch.chatId, 'bounded')
        } else rotateForPreparation(batch.chatId)
      } else checkpoint(batch.chatId, 'bounded')
    }
  }

  const knownChatIds = (): Set<string> => {
    const ids = new Set(states.keys())
    if (options.maintenanceScope === 'opened') return ids
    let entries: string[] = []
    try {
      entries = fs.readdirSync(baseDir)
    } catch {
      return ids
    }
    for (const entry of entries) {
      for (const suffix of INCREMENTAL_CHAT_JOURNAL_ARTIFACT_SUFFIXES) {
        if (!entry.endsWith(suffix)) continue
        const chatId = entry.slice(0, -suffix.length)
        if (CHAT_ID_PATTERN.test(chatId)) ids.add(chatId)
        break
      }
    }
    return ids
  }

  const cancelCheckpointPreparations = (chatId?: string): void => {
    assertWritable()
    if (chatId !== undefined) assertChatId(chatId)
    const retired = [...preparations].filter(([id]) => chatId === undefined || id === chatId)
    for (const [id] of retired) preparations.delete(id)
    let failure: unknown
    for (const [, job] of retired) {
      try {
        job.cancel()
      } catch (error) {
        failure ??= error
      }
    }
    // Includes private leftovers from a crashed owner, even with the flag OFF.
    try {
      removePreparedCheckpointFiles(baseDir, chatId)
    } catch (error) {
      failure ??= error
    }
    if (failure) throw failure
  }

  const checkpointDeferred = async (chatId: string): Promise<DeferredCheckpointResult> => {
    assertWritable()
    assertChatId(chatId)
    // Existing worker protocol reads one active segment. Do not hand it an
    // incomplete source until the separate rotation/capture slice extends it.
    if (!options.rotationEnabled && fs.existsSync(sealedPath(chatId))) return 'unavailable'
    // Maintenance must never cold-load a full record on main just to enqueue.
    const state = states.get(chatId)
    if (!state || state.tombstoned || state.journalEntries === 0 || state.headRevision === null)
      return 'unchanged'
    if (!options.checkpointPreparation) return 'unavailable'
    if (preparations.has(chatId)) {
      observeResidual(options.residualObserver, 'preparationRefusals')
      return 'unavailable'
    }
    options.beforeSourceMutation?.(chatId)
    if (fs.existsSync(tombstonePath(chatId))) return 'superseded'
    // The worker folds whole segments, never one that stops at a line that
    // does not chain. (A segment a read left in place because it does not
    // chain at all is never counted, so a chat with only that is unchanged.)
    if (brokenChains.has(chatId)) {
      observeResidual(options.residualObserver, 'preparationRefusals')
      return 'unavailable'
    }
    const entries = state.journalEntries
    const rotated = options.rotationEnabled
      ? (rotatedSources.get(chatId) ?? rotateForPreparation(chatId))
      : null
    if (options.rotationEnabled && !rotated) {
      observeResidual(options.residualObserver, 'preparationRefusals')
      return 'unavailable'
    }
    const source = rotated ?? {
      chatId,
      revision: state.headRevision,
      savedAt: new Date(now()).toISOString(),
      checkpoint: checkpointFileReference(checkpointPath(chatId)),
      journal: checkpointFileReference(journalPath(chatId))
    }
    const revision = source.revision
    const epoch = preparationEpochs.get(chatId) ?? 0
    const job = options.checkpointPreparation.start(source)
    if (!job) {
      observeResidual(options.residualObserver, 'preparationRefusals')
      return 'unavailable'
    }
    preparations.set(chatId, job)
    let installedCheckpoint: CheckpointPreparationSource['checkpoint'] | undefined
    try {
      const prepared = await job.result
      if (preparations.get(chatId) !== job) return 'superseded'
      // The guard may refuse a recovery hold. It runs BEFORE the final checks;
      // no await or arbitrary callback separates those checks from retirement.
      options.beforeSourceMutation?.(chatId)
      if (
        !canWrite() ||
        preparations.get(chatId) !== job ||
        states.get(chatId) !== state ||
        state.tombstoned ||
        fs.existsSync(tombstonePath(chatId)) ||
        (rotated
          ? (preparationEpochs.get(chatId) ?? 0) !== epoch
          : state.headRevision !== revision || state.journalEntries !== entries) ||
        !checkpointReferenceIsCurrent(source.checkpoint) ||
        !checkpointReferenceIsCurrent(source.journal)
      )
        return 'superseded'
      if (
        prepared.chatId !== chatId ||
        prepared.revision !== revision ||
        !/^[a-f0-9]{64}$/.test(prepared.sha256) ||
        prepared.identity.dev !== job.output.identity.dev ||
        prepared.identity.ino !== job.output.identity.ino ||
        prepared.identity.size <= 0 ||
        prepared.identity.size > 128 * 1024 * 1024 ||
        !checkpointReferenceIsCurrent({ path: job.output.path, identity: prepared.identity })
      )
        throw new Error('Prepared checkpoint ownership mismatch')

      // Ready means fsynced and CLOSED in the child. Establish the new durable
      // checkpoint before unlinking the old tail. A crash between the two is
      // handled by the existing duplicate-revision replay rule.
      fs.renameSync(job.output.path, checkpointPath(chatId))
      if (rotated) {
        const installed = checkpointFileReference(checkpointPath(chatId))
        if (
          installed.identity.dev !== prepared.identity.dev ||
          installed.identity.ino !== prepared.identity.ino ||
          installed.identity.size !== prepared.identity.size ||
          installed.identity.mtimeNs !== prepared.identity.mtimeNs
        )
          throw new Error('Installed checkpoint identity mismatch')
        // Rename changes ctime on supported filesystems. Pin the verified
        // installed inode's post-rename fingerprint for the barrier/retry.
        installedCheckpoint = installed
      }
      if (rotated) {
        await options.descriptorCache!.awaitDirectoryMutation(baseDir)
        options.beforeSourceMutation?.(chatId)
        if (
          !canWrite() ||
          preparations.get(chatId) !== job ||
          states.get(chatId) !== state ||
          state.tombstoned ||
          fs.existsSync(tombstonePath(chatId)) ||
          (preparationEpochs.get(chatId) ?? 0) !== epoch ||
          !checkpointReferenceIsCurrent(source.journal) ||
          !checkpointReferenceIsCurrent(installedCheckpoint!)
        )
          return 'superseded'
        options.descriptorCache!.retireSealedSync(chatId)
        fs.unlinkSync(sealedPath(chatId))
        options.descriptorCache!.completeSealedUnlink(chatId)
        removeSetAside(chatId)
        noteDebt?.(chatId, { directory: baseDir })
        preparationEpochs.set(chatId, epoch + 1)
        captureEpochs.set(chatId, (captureEpochs.get(chatId) ?? 0) + 1)
        rotatedSources.delete(chatId)
        // Preserve active accounting without reading or parsing its payload.
        const sealedAccounting = rotatedAccounting.get(chatId)!
        state.journalEntries -= sealedAccounting.entries
        state.journalBytes -= sealedAccounting.bytes
        rotatedAccounting.delete(chatId)
        checkpointsWritten += 1
        checkpointBytesWritten += prepared.identity.size
        return 'checkpointed'
      }
      fsyncDirectory()
      checkpointsWritten += 1
      checkpointBytesWritten += prepared.identity.size
      options.descriptorCache?.retireSync([chatId])
      fs.unlinkSync(journalPath(chatId))
      removeSetAside(chatId)
      // As in `checkpoint`: the adopted checkpoint is on the disk already.
      if (noteDebt) noteDebt(chatId, { directory: baseDir })
      else fsyncDirectory()
      acknowledgeJournalBarrier(chatId)
      state.journalEntries = 0
      state.journalBytes = 0
      state.dirtySinceMs = null
      state.lastAppendAtMs = null
      return 'checkpointed'
    } catch (error) {
      if (preparations.get(chatId) !== job) return 'superseded'
      // A failed directory barrier leaves a renamed but not yet adopted
      // checkpoint. Preserve sealed custody and re-pin only the verified
      // installed inode; the retry replays duplicate sealed batches safely.
      if (
        rotated &&
        installedCheckpoint &&
        (preparationEpochs.get(chatId) ?? 0) === epoch &&
        checkpointReferenceIsCurrent(installedCheckpoint) &&
        checkpointReferenceIsCurrent(source.journal)
      ) {
        rotatedSources.set(chatId, { ...source, checkpoint: installedCheckpoint })
      }
      throw error
    } finally {
      if (preparations.get(chatId) === job) preparations.delete(chatId)
      job.release()
    }
  }

  let deferredIdleCursor: MapIterator<[string, RuntimeState]> | undefined
  const checkpointIdleDeferred = async (nowMs = now()): Promise<number> => {
    assertWritable()
    let count = 0
    // References only, and admission refuses saturation immediately. No
    // pending records or snapshots accumulate behind an occupied worker.
    const jobs: Promise<void>[] = []
    // Round-robin metadata scan bounds each maintenance pass as well as the
    // process pool. An occupied heavy chat cannot retain an unbounded list of
    // rejected promises, or always take the first admission on the next pass.
    for (let scanned = 0; scanned < 8; scanned += 1) {
      deferredIdleCursor ??= states.entries()
      const next = deferredIdleCursor.next()
      if (next.done) {
        deferredIdleCursor = undefined
        break
      }
      const [chatId, state] = next.value
      if (
        state.tombstoned ||
        state.journalEntries === 0 ||
        state.lastAppendAtMs === null ||
        state.dirtySinceMs === null ||
        (nowMs - state.lastAppendAtMs < idleCheckpointMs &&
          nowMs - state.dirtySinceMs < maxUncheckpointedMs)
      )
        continue
      jobs.push(
        checkpointDeferred(chatId)
          .then((result) => {
            if (result === 'checkpointed') count += 1
          })
          .catch((error: unknown) => {
            console.error(`[incremental-chat] deferred checkpoint skipped ${chatId}`, error)
          })
      )
    }
    await Promise.all(jobs)
    return count
  }

  const checkpointIdle = (nowMs = now()): number => {
    assertWritable()
    let count = 0
    for (const chatId of knownChatIds()) {
      // One corrupt/gapped chat must not abort the sweep for every chat after
      // it. A revision gap (or any loadState/checkpoint fault) throws here, and
      // an unguarded loop then leaves every later chat's journal uncompacted —
      // so a single chat left broken by an interrupted write silently stalls
      // compaction corpus-wide and the journals grow unbounded across boots.
      // Skip the offending chat, keep sweeping the healthy ones.
      try {
        const state = loadState(chatId)
        if (
          state.tombstoned ||
          state.journalEntries === 0 ||
          state.lastAppendAtMs === null ||
          state.dirtySinceMs === null
        ) {
          continue
        }
        if (
          nowMs - state.lastAppendAtMs >= idleCheckpointMs ||
          nowMs - state.dirtySinceMs >= maxUncheckpointedMs
        ) {
          if (checkpoint(chatId, 'idle')) count += 1
        }
      } catch (error) {
        console.error(`[incremental-chat] idle checkpoint skipped ${chatId}`, error)
      }
    }
    return count
  }

  const checkpointAll = (reason: IncrementalChatCheckpointReason = 'shutdown'): number => {
    assertWritable()
    let preparationCleanupFailure: unknown
    try {
      cancelCheckpointPreparations()
    } catch (error) {
      // Preparations were fenced before cleanup. An optional temp unlink
      // failure must not skip the pre-existing D1 drain or healthy checkpoints.
      preparationCleanupFailure = error
    }
    // A shutdown/manual sweep must not leave D1 appends riding the kernel:
    // settle the deferred flushes first, then supersede them with checkpoints.
    drainDeferredDurability()
    let count = 0
    for (const chatId of knownChatIds()) {
      // Same corpus-wide-stall hazard as checkpointIdle: one broken chat must
      // not abort the shutdown sweep and strand every later chat's journal.
      try {
        if (checkpoint(chatId, reason)) count += 1
      } catch (error) {
        console.error(`[incremental-chat] shutdown checkpoint skipped ${chatId}`, error)
      }
    }
    if (preparationCleanupFailure) throw preparationCleanupFailure
    return count
  }

  const deleteChat = (chatId: string): void => {
    cancelCheckpointPreparations(chatId)
    options.beforeSourceMutation?.(chatId)
    assertWritable()
    assertChatId(chatId)
    atomicWrite(tombstonePath(chatId), '')
    options.descriptorCache?.retireSync([chatId])
    forgetChainDamage(chatId)
    for (const filePath of [
      journalPath(chatId),
      sealedPath(chatId),
      setAsidePath(chatId),
      checkpointPath(chatId)
    ]) {
      try {
        fs.unlinkSync(filePath)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    fsyncDirectory()
    states.set(chatId, {
      headRevision: null,
      journalEntries: 0,
      journalBytes: 0,
      dirtySinceMs: null,
      lastAppendAtMs: null,
      tombstoned: true
    })
  }

  const purge = (chatId: string): void => {
    cancelCheckpointPreparations(chatId)
    options.beforeSourceMutation?.(chatId)
    assertWritable()
    assertChatId(chatId)
    options.descriptorCache?.retireSync([chatId])
    forgetChainDamage(chatId)
    for (const filePath of [
      journalPath(chatId),
      sealedPath(chatId),
      setAsidePath(chatId),
      checkpointPath(chatId),
      tombstonePath(chatId)
    ]) {
      try {
        fs.unlinkSync(filePath)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    fsyncDirectory()
    states.delete(chatId)
  }

  const clear = (): void => {
    assertWritable()
    for (const chatId of captureEpochs.keys())
      captureEpochs.set(chatId, captureEpochs.get(chatId)! + 1)
    options.descriptorCache?.retireSync()
    cancelCheckpointPreparations()
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      fs.unlinkSync(path.join(baseDir, entry.name))
    }
    try {
      fs.rmdirSync(baseDir)
    } catch (error: unknown) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw error
      }
    }
    states.clear()
    brokenChains.clear()
    unmovedSetAside.clear()
  }

  const stats = (): IncrementalChatJournalStats => ({
    appends,
    deferredAppends,
    deferredFsyncFailures,
    immediateFsyncFailures,
    unsyncedAppends,
    drainedDeferredFsyncs,
    mutationBytesWritten,
    checkpointsWritten,
    checkpointsFromMemory,
    forcedSynchronousCheckpoints,
    checkpointBytesWritten,
    replayedBatches,
    skippedDuplicateBatches,
    tornTailsRecovered,
    tornTailsTruncated,
    tornTailBytesTruncated,
    corruptSegmentRejects,
    tombstoneRejects,
    segmentsSetAside,
    checkpointsReadAsAbsent
  })

  return {
    initialize,
    captureSource,
    rotateForPreparation,
    append,
    replay,
    pendingReplayState,
    replaceAuthoritativeCheckpoint,
    checkpoint,
    setHeadRecordResolver: (resolve) => {
      headRecordResolver = resolve
    },
    checkpointIdle,
    checkpointDeferred,
    checkpointIdleDeferred,
    cancelCheckpointPreparations,
    checkpointAll,
    drainDeferredDurability,
    awaitDeferredDurability,
    delete: deleteChat,
    purge,
    clear,
    stats
  }
}
