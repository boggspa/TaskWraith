import * as fs from 'fs'
import * as path from 'path'
import { createHash, randomUUID } from 'crypto'
import { TextDecoder } from 'util'
import type { ThreadDurabilityPort, ThreadDurabilitySyncOutcome } from './ThreadDurabilityDebt'
import type { UsageRecord } from './types'
import {
  UsageJournalBackgroundSync,
  type UsageJournalBackgroundSyncOptions,
  type UsageJournalBackgroundSyncSnapshot
} from './UsageJournalBackgroundSync'
import { partitionUsageRecordsForRotation } from './usageRotation'

const DEFAULT_COMPACT_AFTER_RECORDS = 256
const DEFAULT_COMPACT_AFTER_BYTES = 1024 * 1024
const DEFAULT_COMPACT_AFTER_MS = 24 * 60 * 60 * 1000
const DEFAULT_COMPACTION_DELAY_MS = 2_500
const LOCK_STALE_AFTER_MS = 10 * 60 * 1000
const MAX_STABLE_READ_ATTEMPTS = 3
const MAX_COMPACTION_RETRY_ATTEMPTS = 6
const COMPACTION_RETRY_BASE_MS = 1_000
const COMPACTION_RETRY_MAX_MS = 30_000
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

type DurableReadStatus = 'ok' | 'missing' | 'error'
type JournalReadStatus = DurableReadStatus | 'malformed'

export type UsageJournalReadTextFile = (filePath: string) => string

export interface UsageJournalStoreOptions {
  checkpointPath: string
  journalPath: string
  archivePath: string
  compactAfterRecords?: number
  compactAfterBytes?: number
  compactAfterMs?: number
  compactionDelayMs?: number
  now?: () => number
  logger?: Pick<Console, 'error' | 'warn'>
  /** Dynamic legacy-writer authority. False makes construction and reads strictly no-repair. */
  canWrite?: () => boolean
  /** Dependency seam for deterministic read-failure/race tests. */
  readTextFile?: UsageJournalReadTextFile
  /** Dependency seam for a deterministic source-name swap at retirement. */
  beforeRetireRename?: (filePath: string) => void
  /** Test-only crash seam after a source is isolated but before it is unlinked. */
  afterRetireRename?: (filePath: string, retiredPath: string) => void
  /** Test-only crash seam for history-mutation recovery boundaries. */
  afterHistoryMutationStep?: (
    step: 'intent-prepared' | 'checkpoint' | 'journals' | 'archive' | 'verified' | 'completed'
  ) => void
  /**
   * Barrier durability: appends and compactions write without a sync on the
   * calling thread and leave their syncs to the port, off it. Without it
   * every write syncs where it is made.
   */
  unsynced?: UsageJournalUnsyncedOptions
}

export interface UsageJournalUnsyncedOptions {
  /** The barrier layer's port: every sync it makes runs off the event loop. */
  port: Pick<ThreadDurabilityPort, 'syncFile' | 'syncDirectory'>
  /** The background rounds' spacing, clock and timer; the production ones when omitted. */
  rounds?: Omit<UsageJournalBackgroundSyncOptions, 'port'>
}

export interface UsageJournalUnsyncedSnapshot {
  /** Records appended without a sync, to the live journal or, when it was locked, as a spill. */
  appends: number
  spills: number
  /** The rounds that sync what appends left owing. */
  background: UsageJournalBackgroundSyncSnapshot
  /**
   * Compactions run off the event loop: started, completed, stopped by a
   * history deletion before they finished, and failed.
   */
  compactions: { started: number; completed: number; stopped: number; failed: number }
}

export type UsageHistoryMutationKind = 'global' | 'workspace' | 'chat' | 'truncate'

export type UsageHistoryMutationInput = {
  operationId: string
  kind: UsageHistoryMutationKind
  workspaceId?: string
  chatIds: readonly string[]
  runIds: readonly string[]
}

export interface UsageHistoryMutationHold {
  /** Opaque process-local capability. Callers must not persist this token. */
  readonly token: string
  readonly operationId: string
}

export interface UsageHistoryPurgeReport {
  removedRecords: number
  rewrittenArtifacts: number
  removedArtifacts: number
}

interface UsageHistoryMutationIntent {
  schemaVersion: 1
  operationId: string
  kind: UsageHistoryMutationKind
  createdAt: string
  updatedAt: string
  workspaceId?: string
  chatIds: string[]
  runIds: string[]
  status: 'prepared' | 'completed'
}

interface UsageJournalLock {
  token: string
  filePath: string
}

/** A compaction running off the event loop, and whether a history purge took its lock over. */
interface BackgroundCompaction {
  lock: UsageJournalLock
  takenOver: boolean
}

interface JournalReadResult {
  status: JournalReadStatus
  records: UsageRecord[]
  malformedLines: number
  rawBytes?: Buffer
  identity?: RegularFileIdentity
  error?: unknown
}

interface CheckpointReadResult {
  status: DurableReadStatus
  records: UsageRecord[]
  version: string | null
  error?: unknown
}

interface ArtifactListResult {
  status: 'ok' | 'error'
  paths: string[]
  error?: unknown
}

interface RegularFileIdentity {
  dev: number
  ino: number
}

interface RegularFileSnapshot {
  bytes: Buffer
  identity: RegularFileIdentity
  /** Present only when the stats before and after the read agree on content shape. */
  fingerprint?: UsageFileFingerprint
}

/**
 * Everything a stat says about a regular file's content: identity plus size
 * and both timestamps. Equal fingerprints mean the bytes read last time are
 * the bytes on disk now — an in-place append grows `size`, a compaction's
 * atomic rename changes `ino`, and any rewrite moves `mtimeMs`/`ctimeMs`.
 */
interface UsageFileFingerprint extends RegularFileIdentity {
  size: number
  mtimeMs: number
  ctimeMs: number
}

function usageFileFingerprint(stat: fs.Stats, filePath: string): UsageFileFingerprint {
  return {
    ...regularFileIdentity(stat, filePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  }
}

function sameUsageFileFingerprint(
  left: UsageFileFingerprint,
  right: UsageFileFingerprint
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

class UnsafeUsageStorePathError extends Error {
  readonly code = 'UNSAFE_USAGE_STORE_PATH'

  constructor(filePath: string, reason: string) {
    super(`Unsafe usage-store path ${filePath}: ${reason}`)
    this.name = 'UnsafeUsageStorePathError'
  }
}

export class UsageJournalStoreReadOnlyError extends Error {
  constructor() {
    super('Usage journal mutation is unavailable after Host ownership.')
    this.name = 'UsageJournalStoreReadOnlyError'
  }
}

/**
 * Durable usage persistence with a cheap completion-path write.
 *
 * usage.json is an atomic checkpoint retained for backwards compatibility.
 * Completed records first land in an fsync'd O_APPEND journal. Compaction is
 * thresholded and delayed so the main process does not read and pretty-rewrite
 * the full history on every completed run.
 *
 * Compaction claims the live journal by rename, appends expired records to the
 * archive, commits a new checkpoint, and only then removes claimed inputs.
 * Replaying checkpoint + journal artifacts is therefore safe across every
 * crash boundary. UsageRecord.id is the idempotency key.
 *
 * Under barrier durability (`unsynced`) an append writes without a sync, and
 * a background round pays what it left owing, at most once a second
 * (`UsageJournalBackgroundSync`). A power cut then costs the records appended
 * since the last round, and a torn last line reads as the records before it,
 * as it does after a crash mid-append. Compaction keeps its order and moves
 * its syncs off the event loop (`compactInBackground`). History deletion is
 * the user's and syncs itself as before.
 */
export class UsageJournalStore {
  private readonly checkpointPath: string
  private readonly journalPath: string
  private readonly archivePath: string
  private readonly lockPath: string
  private readonly historyMutationIntentPath: string
  private readonly compactAfterRecords: number
  private readonly compactAfterBytes: number
  private readonly compactAfterMs: number
  private readonly compactionDelayMs: number
  private readonly now: () => number
  private readonly logger: Pick<Console, 'error' | 'warn'>
  private readonly canWrite: () => boolean
  private readonly readFileBytes: (filePath: string) => Buffer
  private readonly beforeRetireRename?: (filePath: string) => void
  private readonly afterRetireRename?: (filePath: string, retiredPath: string) => void
  private readonly afterHistoryMutationStep?: UsageJournalStoreOptions['afterHistoryMutationStep']
  private readonly activeHistoryMutationHolds = new Map<string, string>()
  private pendingAppendCount = 0
  private uncheckpointedSinceMs: number | null | undefined
  private compactionTimer: ReturnType<typeof setTimeout> | null = null
  private ageCompactionTimer: ReturnType<typeof setTimeout> | null = null
  private ageCompactionDueAtMs: number | null = null
  private compactionRetryTimer: ReturnType<typeof setTimeout> | null = null
  private compactionRetryAttempt = 0
  private readonly preservedCorruptCheckpointVersions = new Set<string>()
  /** Barrier durability's port and background rounds; null when every write syncs itself. */
  private readonly unsynced: {
    port: UsageJournalUnsyncedOptions['port']
    background: UsageJournalBackgroundSync
  } | null
  private backgroundCompaction: Promise<boolean> | null = null
  private runningCompaction: BackgroundCompaction | null = null
  private readonly unsyncedCounts = {
    appends: 0,
    spills: 0,
    compactions: { started: 0, completed: 0, stopped: 0, failed: 0 }
  }

  constructor(options: UsageJournalStoreOptions) {
    const managedDirectory = path.resolve(path.dirname(options.journalPath))
    if (
      path.resolve(path.dirname(options.checkpointPath)) !== managedDirectory ||
      path.resolve(path.dirname(options.archivePath)) !== managedDirectory
    ) {
      throw new Error('Usage checkpoint, journal, and archive must share one managed directory.')
    }
    if (
      new Set([
        path.basename(options.checkpointPath),
        path.basename(options.journalPath),
        path.basename(options.archivePath)
      ]).size !== 3
    ) {
      throw new Error('Usage checkpoint, journal, and archive names must be distinct.')
    }
    this.checkpointPath = options.checkpointPath
    this.journalPath = options.journalPath
    this.archivePath = options.archivePath
    this.lockPath = `${options.journalPath}.lock`
    this.historyMutationIntentPath = `${options.journalPath}.history-mutation-v1.json`
    this.compactAfterRecords = Math.max(
      1,
      options.compactAfterRecords ?? DEFAULT_COMPACT_AFTER_RECORDS
    )
    this.compactAfterBytes = Math.max(1, options.compactAfterBytes ?? DEFAULT_COMPACT_AFTER_BYTES)
    this.compactAfterMs = Math.max(1, options.compactAfterMs ?? DEFAULT_COMPACT_AFTER_MS)
    this.compactionDelayMs = Math.max(0, options.compactionDelayMs ?? DEFAULT_COMPACTION_DELAY_MS)
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? console
    this.canWrite = options.canWrite ?? (() => true)
    this.readFileBytes = options.readTextFile
      ? (filePath) => Buffer.from(options.readTextFile!(filePath), 'utf8')
      : readRegularFileBytesNoFollow
    this.beforeRetireRename = options.beforeRetireRename
    this.afterRetireRename = options.afterRetireRename
    this.afterHistoryMutationStep = options.afterHistoryMutationStep
    // Startup recovery syncs where it writes, as without barrier durability.
    this.unsynced = null
    if (this.isWritable()) {
      try {
        const recoveryLock = this.tryAcquireLock()
        if (recoveryLock) {
          try {
            this.recoverRetiredUsageArtifactsStrict()
          } finally {
            this.releaseLock(recoveryLock)
          }
        }
      } catch (error) {
        // A strict history purge retries this cleanup and refuses to verify while
        // an unsafe managed retirement remains. Ordinary startup keeps the
        // original evidence and reports the condition instead of deleting an
        // ambiguous filesystem object.
        this.logger.warn('Failed to recover a retired usage artifact', error)
      }
    }
    if (options.unsynced) {
      this.unsynced = {
        port: options.unsynced.port,
        background: new UsageJournalBackgroundSync({
          ...options.unsynced.rounds,
          port: options.unsynced.port
        })
      }
    }
  }

  /**
   * Raise the durable usage-history admission fence before any external
   * history sink is allowed to quiesce. The outer deletion operation id binds
   * crash recovery to one exact frozen scope; a different pending operation
   * can never borrow or replace it.
   */
  beginHistoryMutation(input: UsageHistoryMutationInput): UsageHistoryMutationHold {
    this.assertWritable()
    const requested = normalizeUsageHistoryMutationIntent({
      schemaVersion: 1,
      ...input,
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      status: 'prepared'
    })
    const existing = this.readHistoryMutationIntent()
    if (existing && !sameUsageHistoryMutationScope(existing, requested)) {
      throw new Error(
        `Usage history mutation ${existing.operationId} is still pending for a different scope.`
      )
    }
    if (!existing) {
      writeFileAtomically(this.historyMutationIntentPath, JSON.stringify(requested))
      this.afterHistoryMutationStep?.('intent-prepared')
    }
    const token = randomUUID()
    this.activeHistoryMutationHolds.set(token, requested.operationId)
    return Object.freeze({ token, operationId: requested.operationId })
  }

  /**
   * Remove every record owned by the frozen scope across the hot checkpoint,
   * live/claimed/spill journals, and archive. The durable inner intent remains
   * until `endHistoryMutation`, so a crash after this returns cannot reopen the
   * append gate before the outer history transaction commits.
   */
  purgeHistoryStrict(hold: UsageHistoryMutationHold): UsageHistoryPurgeReport {
    this.assertWritable()
    const intent = this.requireActiveHistoryMutationHold(hold)
    return this.purgeHistoryIntentStrict(intent)
  }

  /**
   * Release a process-local hold. The durable fence is retired only after a
   * verified purge and after the last in-process holder ends it.
   */
  endHistoryMutation(hold: UsageHistoryMutationHold): boolean {
    this.assertWritable()
    if (this.activeHistoryMutationHolds.get(hold.token) !== hold.operationId) return false
    this.activeHistoryMutationHolds.delete(hold.token)
    if ([...this.activeHistoryMutationHolds.values()].includes(hold.operationId)) return true
    const intent = this.readHistoryMutationIntent()
    if (!intent || intent.operationId !== hold.operationId) return false
    if (intent.status !== 'completed') return true
    const lock = this.takeOverCompactionLock() ?? this.tryAcquireLock()
    if (!lock) {
      throw new Error('Completed usage history mutation could not acquire the retirement lock.')
    }
    try {
      removeRegularFileStrict(
        this.historyMutationIntentPath,
        this.beforeRetireRename,
        this.afterRetireRename
      )
    } finally {
      this.releaseLock(lock)
    }
    return true
  }

  /**
   * Startup repair for the narrow crash window after the outer transaction
   * committed but before its usage hold was released. Prepared intents are
   * completed idempotently before retirement; completed intents are reverified.
   */
  recoverPendingHistoryMutationStrict(): UsageHistoryPurgeReport | null {
    this.assertWritable()
    const intent = this.readHistoryMutationIntent()
    if (!intent) return null
    const token = randomUUID()
    this.activeHistoryMutationHolds.set(token, intent.operationId)
    const hold: UsageHistoryMutationHold = { token, operationId: intent.operationId }
    try {
      const report = this.purgeHistoryStrict(hold)
      if (!this.endHistoryMutation(hold)) {
        throw new Error('Recovered usage history mutation hold could not be released.')
      }
      return report
    } catch (error) {
      this.activeHistoryMutationHolds.delete(token)
      throw error
    }
  }

  getRecords(): UsageRecord[] {
    const pendingHistoryMutation = this.readHistoryMutationIntent()
    let records: UsageRecord[] = []
    let artifactPaths: string[] = []
    let journalRecordCount = 0
    let journalReadFailed = false
    let stable = false

    for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
      const checkpointBefore = this.readCheckpoint()
      const artifactList = this.listJournalArtifacts(true)
      artifactPaths = artifactList.paths
      const journalReads = artifactPaths.map((filePath) => this.readJournal(filePath))
      const checkpointAfter = this.readCheckpoint()
      const journalRecords = journalReads.flatMap((result) => result.records)
      journalRecordCount = journalRecords.length
      journalReadFailed = journalReads.some((result) => result.status !== 'ok')
      records = dedupeAndSortUsageRecords([...checkpointAfter.records, ...journalRecords])

      const checkpointStable =
        checkpointBefore.version !== null && checkpointBefore.version === checkpointAfter.version
      const everyJournalReadSucceeded = journalReads.every((result) => result.status === 'ok')
      stable = artifactList.status === 'ok' && checkpointStable && everyJournalReadSucceeded
      if (stable) break
    }

    if (!stable) {
      this.logger.warn(
        `Usage snapshot did not stabilize after ${MAX_STABLE_READ_ATTEMPTS} attempts; returning the latest replayable view`
      )
    }

    if (this.isWritable()) {
      this.noteUncheckpointedArtifacts(artifactPaths)
      if (artifactPaths.length > 0) this.scheduleAgeCompaction()
      if (
        journalRecordCount >= this.compactAfterRecords ||
        artifactPaths.some((filePath) => safeRegularFileSize(filePath) >= this.compactAfterBytes) ||
        artifactPaths.some((filePath) => filePath !== this.journalPath) ||
        journalReadFailed ||
        this.compactionAgeDue()
      ) {
        this.scheduleCompaction()
      }
    }

    const effectiveHistoryMutation = this.readHistoryMutationIntent() ?? pendingHistoryMutation
    return effectiveHistoryMutation
      ? records.filter(
          (record) => !usageRecordMatchesHistoryMutation(record, effectiveHistoryMutation)
        )
      : records
  }

  append(record: UsageRecord): void {
    this.assertWritable()
    this.assertUsageRecordHistoryMutationAllowed(record)
    this.assertAppendTargetsSafe()
    this.refreshUncheckpointedSince()
    const ageCompactionDue = this.compactionAgeDue()
    const serialized = `\n${JSON.stringify(record)}`
    const lock = this.tryAcquireLock()
    let wroteSpill = false

    if (lock) {
      try {
        try {
          // Recheck after acquiring the cross-instance append/compaction lock.
          // A history prepare may have landed while this caller was acquiring it.
          this.assertUsageRecordHistoryMutationAllowed(record)
          if (this.writesUnsynced()) this.appendUnsynced(serialized)
          else durableAppend(this.journalPath, serialized)
        } catch (error) {
          // The append may have torn before it failed. A complete immutable
          // spill with the same id is safe because replay dedupes by id.
          if (error instanceof UnsafeUsageStorePathError) throw error
          this.assertUsageRecordHistoryMutationAllowed(record)
          this.writeSpill(record)
          wroteSpill = true
          this.logger.warn('Usage journal append failed; persisted a spill record instead', error)
        }
      } finally {
        this.releaseLock(lock)
      }
    } else {
      // A second instance may be compacting. Never wait on the Electron main
      // thread: write one immutable record that a later compaction can claim.
      this.assertUsageRecordHistoryMutationAllowed(record)
      this.writeSpill(record)
      wroteSpill = true
    }

    this.pendingAppendCount += 1
    if (this.uncheckpointedSinceMs == null) this.uncheckpointedSinceMs = this.now()
    this.scheduleAgeCompaction()
    if (
      wroteSpill ||
      this.pendingAppendCount >= this.compactAfterRecords ||
      safeRegularFileSize(this.journalPath) >= this.compactAfterBytes ||
      ageCompactionDue
    ) {
      this.scheduleCompaction()
    }
  }

  /**
   * Checkpoint all currently claimed journal inputs. Returns false when the
   * lock, archive, or checkpoint could not be committed; replayable inputs are
   * retained on every failure.
   */
  compact(nowMs = this.now()): boolean {
    this.assertWritable()
    if (this.writesUnsynced()) {
      throw new Error('Under barrier durability the usage journal compacts off the event loop.')
    }
    if (this.readHistoryMutationIntent()) return false
    const compacted = this.compactOnce(nowMs)
    if (compacted) this.finishSuccessfulCompaction()
    else this.scheduleCompactionRetry()
    return compacted
  }

  private compactOnce(nowMs: number): boolean {
    const lock = this.tryAcquireLock()
    if (!lock) return false

    let claimedInputs: string[] = []
    try {
      this.assertManagedDataTargetsSafe()
      const claimedLive = this.claimLiveJournal()
      const artifactList = this.listJournalArtifacts(false)
      if (artifactList.status === 'error') throw artifactList.error
      claimedInputs = artifactList.paths
      if (claimedLive && !claimedInputs.includes(claimedLive)) claimedInputs.push(claimedLive)

      const checkpoint = this.readCheckpoint({ lockHeld: true })
      if (checkpoint.status === 'error') throw checkpoint.error
      const journalReads = claimedInputs.map((filePath) => this.readJournal(filePath))
      const unreadableJournal = journalReads.find(
        (result) => result.status !== 'ok' && result.status !== 'malformed'
      )
      if (unreadableJournal) throw unreadableJournal.error ?? new Error('Usage journal disappeared')
      for (let index = 0; index < journalReads.length; index += 1) {
        const journalRead = journalReads[index]
        if (journalRead.status === 'malformed') {
          if (!journalRead.rawBytes)
            throw new Error('Malformed usage journal has no forensic bytes')
          this.quarantineJournalArtifact(claimedInputs[index], journalRead.rawBytes)
        }
      }
      const journalRecords = journalReads.flatMap((result) => result.records)
      const checkpointBeforeCommit = this.readCheckpoint({ lockHeld: true })
      if (checkpointBeforeCommit.status === 'error') throw checkpointBeforeCommit.error
      if (checkpointBeforeCommit.version !== checkpoint.version) {
        throw new Error('Usage checkpoint changed during compaction')
      }
      const records = dedupeAndSortUsageRecords([...checkpoint.records, ...journalRecords])
      const { keep, rotate } = partitionUsageRecordsForRotation(records, nowMs)

      if (claimedInputs.length === 0 && rotate.length === 0) {
        return true
      }

      if (rotate.length > 0) appendArchiveDurably(this.archivePath, rotate)
      writeCheckpointAtomically(this.checkpointPath, keep)

      for (let index = 0; index < claimedInputs.length; index += 1) {
        const filePath = claimedInputs[index]
        const identity = journalReads[index]?.identity
        try {
          if (!identity) {
            throw new UnsafeUsageStorePathError(filePath, 'missing read identity at cleanup')
          }
          retireRegularFileNoFollow(
            filePath,
            identity,
            this.beforeRetireRename,
            this.afterRetireRename
          )
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) {
            // The checkpoint already contains the record. Leaving an input
            // behind causes only a deduped replay on the next read.
            this.logger.warn(`Failed to remove compacted usage journal ${filePath}`, error)
          }
        }
      }
      fsyncDirectoryBestEffort(path.dirname(this.journalPath))
      return true
    } catch (error) {
      this.logger.error('Failed to compact usage journal; replayable inputs were retained', error)
      return false
    } finally {
      this.releaseLock(lock)
    }
  }

  /**
   * Barrier durability's compaction: the steps of `compact` in its order,
   * with each sync made off the event loop through the port, at its
   * background class, and waited for before the step that relies on it.
   * Nothing is renamed or removed whose bytes are not synced: the inputs are
   * synced before the live journal is claimed, a quarantined copy and the new
   * checkpoint before they take their names, the archive before the
   * checkpoint drops the records it took, and the inputs are removed only once
   * the checkpoint that holds their records is durable under its name.
   *
   * It holds the journal lock from its first step to its last, so an append
   * meanwhile spills, and the spill waits for the next compaction. A history
   * purge in this process takes the lock over, and the compaction stops at
   * its next step; so does a deletion prepared meanwhile. Either way it leaves
   * what a crash at that step would, which replay reads and the next
   * compaction finishes. Without barrier durability this is `compact`.
   */
  compactInBackground(nowMs = this.now()): Promise<boolean> {
    this.assertWritable()
    if (!this.writesUnsynced()) return Promise.resolve(this.compact(nowMs))
    if (this.backgroundCompaction) return this.backgroundCompaction
    if (this.readHistoryMutationIntent()) return Promise.resolve(false)
    this.unsyncedCounts.compactions.started += 1
    const spillsBefore = this.unsyncedCounts.spills
    const compacting = this.compactUnsyncedOnce(nowMs).then((compacted) => {
      this.backgroundCompaction = null
      if (!compacted) {
        this.scheduleCompactionRetry()
        return compacted
      }
      this.finishSuccessfulCompaction()
      // An append that found the lock taken meanwhile spilled: compact it next.
      if (this.unsyncedCounts.spills !== spillsBefore) this.scheduleCompaction()
      return compacted
    })
    this.backgroundCompaction = compacting
    return compacting
  }

  private async compactUnsyncedOnce(nowMs: number): Promise<boolean> {
    const lock = this.tryAcquireLock()
    if (!lock) {
      this.unsyncedCounts.compactions.failed += 1
      return false
    }
    const run: BackgroundCompaction = { lock, takenOver: false }
    this.runningCompaction = run
    const directory = path.dirname(this.journalPath)
    const port = this.unsynced!.port
    const syncFile = (filePath: string): Promise<ThreadDurabilitySyncOutcome> =>
      port.syncFile(filePath, { background: true })
    const syncDirectory = (): Promise<ThreadDurabilitySyncOutcome> =>
      port.syncDirectory(directory, { background: true })
    // Temps written and not yet renamed: removed if it stops before they are.
    const temps = new Map<string, RegularFileIdentity>()
    let outcome: 'completed' | 'stopped' | 'failed' = 'failed'
    const stopped = (): boolean => {
      if (!run.takenOver && this.isWritable() && !this.readHistoryMutationIntent()) return false
      outcome = 'stopped'
      return true
    }
    // Writes the content under a temp name and syncs it, then gives it its
    // name and syncs that.
    const commit = async (filePath: string, content: string | Buffer): Promise<boolean> => {
      const temp = writeTempFileUnsynced(filePath, content)
      temps.set(temp.path, temp.identity)
      await syncFile(temp.path)
      if (stopped()) return false
      assertRegularFileOrMissing(filePath)
      fs.renameSync(temp.path, filePath)
      temps.delete(temp.path)
      await syncDirectory()
      return !stopped()
    }

    try {
      this.assertManagedDataTargetsSafe()
      // The inputs are what is replayable now, every one of them synced
      // before any is moved. A spill written meanwhile is not among them.
      const listed = this.listJournalArtifacts(true)
      if (listed.status === 'error') throw listed.error
      await Promise.all(listed.paths.map(syncFile))
      if (stopped()) return false
      const claimedInputs: string[] = []
      for (const filePath of listed.paths) {
        if (filePath !== this.journalPath) {
          claimedInputs.push(filePath)
          continue
        }
        const claimedLive = this.claimLiveJournal()
        if (claimedLive) claimedInputs.push(claimedLive)
      }

      const checkpoint = this.readCheckpoint({ lockHeld: true })
      if (checkpoint.status === 'error') throw checkpoint.error
      const journalReads = claimedInputs.map((filePath) => this.readJournal(filePath))
      const unreadableJournal = journalReads.find(
        (result) => result.status !== 'ok' && result.status !== 'malformed'
      )
      if (unreadableJournal) throw unreadableJournal.error ?? new Error('Usage journal disappeared')
      for (let index = 0; index < journalReads.length; index += 1) {
        const journalRead = journalReads[index]
        if (journalRead.status !== 'malformed') continue
        if (!journalRead.rawBytes) throw new Error('Malformed usage journal has no forensic bytes')
        const quarantinePath = this.quarantinePathFor(claimedInputs[index], journalRead.rawBytes)
        if (quarantinePath && !(await commit(quarantinePath, journalRead.rawBytes))) return false
      }
      const journalRecords = journalReads.flatMap((result) => result.records)
      const checkpointBeforeCommit = this.readCheckpoint({ lockHeld: true })
      if (checkpointBeforeCommit.status === 'error') throw checkpointBeforeCommit.error
      if (checkpointBeforeCommit.version !== checkpoint.version) {
        throw new Error('Usage checkpoint changed during compaction')
      }
      const records = dedupeAndSortUsageRecords([...checkpoint.records, ...journalRecords])
      const { keep, rotate } = partitionUsageRecordsForRotation(records, nowMs)

      if (claimedInputs.length === 0 && rotate.length === 0) {
        outcome = 'completed'
        return true
      }

      if (rotate.length > 0) {
        const archive = appendArchiveDurably(this.archivePath, rotate, false)
        if (archive.appended) {
          await syncFile(this.archivePath)
          if (archive.created) await syncDirectory()
          if (stopped()) return false
        }
      }
      if (!(await commit(this.checkpointPath, JSON.stringify(keep)))) return false

      for (let index = 0; index < claimedInputs.length; index += 1) {
        const filePath = claimedInputs[index]
        const identity = journalReads[index]?.identity
        try {
          if (!identity) {
            throw new UnsafeUsageStorePathError(filePath, 'missing read identity at cleanup')
          }
          retireRegularFileNoFollow(
            filePath,
            identity,
            this.beforeRetireRename,
            this.afterRetireRename,
            false
          )
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) {
            // The checkpoint already contains the record. Leaving an input
            // behind causes only a deduped replay on the next read.
            this.logger.warn(`Failed to remove compacted usage journal ${filePath}`, error)
          }
        }
      }
      await syncDirectory()
      outcome = 'completed'
      return true
    } catch (error) {
      this.logger.error('Failed to compact usage journal; replayable inputs were retained', error)
      return false
    } finally {
      // A purge that took the lock over sweeps temps itself.
      if (!run.takenOver) {
        for (const [tempPath, identity] of temps) {
          try {
            retireRegularFileNoFollow(tempPath, identity, undefined, undefined, false)
          } catch {
            // A stale temp is safer than deleting an unverified replacement.
          }
        }
      }
      if (this.runningCompaction === run) this.runningCompaction = null
      this.unsyncedCounts.compactions[outcome] += 1
      if (!run.takenOver) this.releaseLock(lock)
    }
  }

  /**
   * Quit under barrier durability: pay what the usage log owes within
   * `budgetMs`. Every append after it syncs where it is made.
   */
  async settleAtQuit(budgetMs: number): Promise<void> {
    if (!this.unsynced) return
    await this.unsynced.background.settle(budgetMs)
  }

  /** Barrier durability's counters; null without it. */
  unsyncedSnapshot(): UsageJournalUnsyncedSnapshot | null {
    if (!this.unsynced) return null
    return {
      appends: this.unsyncedCounts.appends,
      spills: this.unsyncedCounts.spills,
      background: this.unsynced.background.snapshot(),
      compactions: { ...this.unsyncedCounts.compactions }
    }
  }

  dispose(): void {
    if (this.compactionTimer) clearTimeout(this.compactionTimer)
    if (this.ageCompactionTimer) clearTimeout(this.ageCompactionTimer)
    if (this.compactionRetryTimer) clearTimeout(this.compactionRetryTimer)
    this.compactionTimer = null
    this.ageCompactionTimer = null
    this.compactionRetryTimer = null
    this.unsynced?.background.dispose()
  }

  /** Whether a write leaves its syncs to the port: barrier durability, until quit settles it. */
  private writesUnsynced(): boolean {
    return this.unsynced !== null && !this.unsynced.background.settled
  }

  /** An append under barrier durability: written without a sync, and owed to the background. */
  private appendUnsynced(serialized: string): void {
    const created = durableAppend(this.journalPath, serialized, false)
    this.unsyncedCounts.appends += 1
    this.unsynced!.background.owe({
      files: [this.journalPath],
      directories: created ? [path.dirname(this.journalPath)] : []
    })
  }

  /** A timer's compaction: off the event loop under barrier durability. */
  private runScheduledCompaction(): void {
    if (!this.writesUnsynced()) {
      this.compact()
      return
    }
    void this.compactInBackground()
  }

  /**
   * A history purge, or its end, in this process while a background
   * compaction holds the journal lock: the purge takes the lock over, and the
   * compaction stops at its next step, leaving what a crash there would.
   */
  private takeOverCompactionLock(): UsageJournalLock | null {
    const run = this.runningCompaction
    if (!run || run.takenOver) return null
    run.takenOver = true
    return run.lock
  }

  private isWritable(): boolean {
    try {
      return this.canWrite() === true
    } catch {
      return false
    }
  }

  private assertWritable(): void {
    if (!this.isWritable()) throw new UsageJournalStoreReadOnlyError()
  }

  private readHistoryMutationIntent(): UsageHistoryMutationIntent | null {
    let snapshot: RegularFileSnapshot
    try {
      snapshot = readRegularFileSnapshotNoFollow(this.historyMutationIntentPath)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    }
    return normalizeUsageHistoryMutationIntent(JSON.parse(decodeUtf8Fatal(snapshot.bytes)))
  }

  private requireActiveHistoryMutationHold(
    hold: UsageHistoryMutationHold
  ): UsageHistoryMutationIntent {
    if (this.activeHistoryMutationHolds.get(hold.token) !== hold.operationId) {
      throw new Error('Usage history mutation hold is not active in this process.')
    }
    const intent = this.readHistoryMutationIntent()
    if (!intent || intent.operationId !== hold.operationId) {
      throw new Error('Usage history mutation hold does not match the durable intent.')
    }
    return intent
  }

  private assertUsageRecordHistoryMutationAllowed(record: UsageRecord): void {
    const intent = this.readHistoryMutationIntent()
    if (intent && usageRecordMatchesHistoryMutation(record, intent)) {
      throw new Error(
        `Usage append is blocked while history mutation ${intent.operationId} is pending.`
      )
    }
  }

  private purgeHistoryIntentStrict(
    expectedIntent: UsageHistoryMutationIntent
  ): UsageHistoryPurgeReport {
    const lock = this.takeOverCompactionLock() ?? this.tryAcquireLock()
    if (!lock) {
      throw new Error('Usage history mutation could not acquire the journal lock.')
    }
    const report: UsageHistoryPurgeReport = {
      removedRecords: 0,
      rewrittenArtifacts: 0,
      removedArtifacts: 0
    }
    try {
      const intent = this.readHistoryMutationIntent()
      if (!intent || !sameUsageHistoryMutationScope(intent, expectedIntent)) {
        throw new Error('Usage history mutation scope changed before strict purge.')
      }
      this.assertManagedDataTargetsSafe()
      this.recoverRetiredUsageArtifactsStrict()
      this.removeUncommittedUsageTempsStrict(report)

      if (intent.kind === 'global') {
        this.removeUsageArtifactStrict(this.checkpointPath, report)
      } else {
        this.rewriteCheckpointForHistoryStrict(intent, report)
      }
      this.afterHistoryMutationStep?.('checkpoint')

      // A writer that had already entered its spill fallback before durable
      // prepare may finish during the first enumeration. Re-enumerate and
      // verify under the journal lock so every committed artifact is swept.
      for (let pass = 0; pass < MAX_STABLE_READ_ATTEMPTS; pass += 1) {
        const artifactList = this.listJournalArtifacts(true)
        if (artifactList.status === 'error') throw artifactList.error
        for (const filePath of artifactList.paths) {
          if (intent.kind === 'global') this.removeUsageArtifactStrict(filePath, report)
          else this.rewriteLineArtifactForHistoryStrict(filePath, intent, report)
        }
        if (!this.journalArtifactsContainHistoryScope(intent)) break
        if (pass === MAX_STABLE_READ_ATTEMPTS - 1) {
          throw new Error('Usage journal history scope remained after repeated strict sweeps.')
        }
      }
      this.removeUncommittedUsageTempsStrict(report)
      this.afterHistoryMutationStep?.('journals')

      if (intent.kind === 'global') {
        this.removeUsageArtifactStrict(this.archivePath, report)
      } else {
        this.rewriteLineArtifactForHistoryStrict(this.archivePath, intent, report)
      }
      for (const artifact of this.listUsageForensicArtifactsStrict()) {
        if (intent.kind === 'global') {
          this.removeUsageArtifactStrict(artifact.filePath, report)
        } else {
          // Quarantine artifacts exist because at least one source line could
          // not be replayed. Strict parsing therefore normally fails here,
          // retaining both deletion intents rather than claiming that raw
          // prompt/response bytes were removed when ownership is unknowable.
          this.rewriteForensicArtifactForHistoryStrict(artifact, intent, report)
        }
      }
      this.afterHistoryMutationStep?.('archive')

      this.verifyHistoryMutationStrict(intent)
      this.afterHistoryMutationStep?.('verified')
      const completed: UsageHistoryMutationIntent = {
        ...intent,
        status: 'completed',
        updatedAt: new Date(this.now()).toISOString()
      }
      writeFileAtomically(this.historyMutationIntentPath, JSON.stringify(completed))
      this.afterHistoryMutationStep?.('completed')
      this.finishSuccessfulCompaction()
      return report
    } finally {
      this.releaseLock(lock)
    }
  }

  private rewriteCheckpointForHistoryStrict(
    intent: UsageHistoryMutationIntent,
    report: UsageHistoryPurgeReport,
    filePath = this.checkpointPath
  ): void {
    let snapshot: RegularFileSnapshot
    try {
      snapshot = readRegularFileSnapshotNoFollow(filePath)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    const parsed: unknown = JSON.parse(decodeUtf8Fatal(snapshot.bytes))
    if (!Array.isArray(parsed) || !parsed.every(isUsageRecordLike)) {
      throw new Error(
        `Usage checkpoint artifact ${filePath} is invalid; scoped history purge cannot prove privacy or preserve siblings.`
      )
    }
    const records = parsed as UsageRecord[]
    const retained = records.filter((record) => !usageRecordMatchesHistoryMutation(record, intent))
    const removed = records.length - retained.length
    if (removed === 0) return
    report.removedRecords += removed
    if (retained.length === 0) {
      retireRegularFileNoFollow(
        filePath,
        snapshot.identity,
        this.beforeRetireRename,
        this.afterRetireRename
      )
      report.removedArtifacts += 1
      return
    }
    writeCheckpointAtomically(filePath, retained)
    report.rewrittenArtifacts += 1
  }

  private rewriteLineArtifactForHistoryStrict(
    filePath: string,
    intent: UsageHistoryMutationIntent,
    report: UsageHistoryPurgeReport
  ): void {
    let snapshot: RegularFileSnapshot
    try {
      snapshot = readRegularFileSnapshotNoFollow(filePath)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    const records = parseUsageLineArtifactStrict(snapshot.bytes, filePath)
    const retained = records.filter((record) => !usageRecordMatchesHistoryMutation(record, intent))
    const removed = records.length - retained.length
    if (removed === 0) return
    report.removedRecords += removed
    if (retained.length === 0) {
      retireRegularFileNoFollow(
        filePath,
        snapshot.identity,
        this.beforeRetireRename,
        this.afterRetireRename
      )
      report.removedArtifacts += 1
      return
    }
    writeFileAtomically(
      filePath,
      `${retained.map((record) => JSON.stringify(record)).join('\n')}\n`
    )
    report.rewrittenArtifacts += 1
  }

  private removeUsageArtifactStrict(filePath: string, report: UsageHistoryPurgeReport): void {
    let snapshot: RegularFileSnapshot
    try {
      snapshot = readRegularFileSnapshotNoFollow(filePath)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    report.removedRecords += countUsageRecordsBestEffort(snapshot.bytes, filePath)
    retireRegularFileNoFollow(
      filePath,
      snapshot.identity,
      this.beforeRetireRename,
      this.afterRetireRename
    )
    report.removedArtifacts += 1
  }

  private rewriteForensicArtifactForHistoryStrict(
    artifact: { filePath: string; format: 'checkpoint' | 'journal' },
    intent: UsageHistoryMutationIntent,
    report: UsageHistoryPurgeReport
  ): void {
    const snapshot = readRegularFileSnapshotNoFollow(artifact.filePath)
    let records: UsageRecord[]
    let serialize: (retained: UsageRecord[]) => string
    let replacementPath: (content: Buffer) => string
    if (artifact.format === 'checkpoint') {
      const parsed: unknown = JSON.parse(decodeUtf8Fatal(snapshot.bytes))
      if (!Array.isArray(parsed) || !parsed.every(isUsageRecordLike)) {
        throw new Error(
          `Usage checkpoint artifact ${artifact.filePath} is invalid; scoped history purge cannot prove privacy or preserve siblings.`
        )
      }
      records = parsed as UsageRecord[]
      serialize = (retained) => JSON.stringify(retained)
      const prefix = `${path.basename(this.checkpointPath)}.corrupt-`
      const suffix = path.basename(artifact.filePath).slice(prefix.length)
      // Current backups are timestamp + digest. Before UsageJournalStore,
      // AppStore.readJson preserved corrupt usage.json bytes as a bare
      // timestamp suffix. Accept that exact legacy shape for deletion, then
      // migrate any retained sibling rows to the digest-stamped invariant.
      const timestampDigest = /^(\d+)-[0-9a-f]{64}$/i.exec(suffix)
      const legacyTimestamp = /^\d+$/.test(suffix) ? suffix : null
      const timestamp = timestampDigest?.[1] ?? legacyTimestamp
      if (!timestamp) {
        throw new Error(
          `Usage checkpoint forensic artifact has an invalid name: ${artifact.filePath}`
        )
      }
      replacementPath = (content) =>
        `${this.checkpointPath}.corrupt-${timestamp}-${digestBytes(content)}`
    } else {
      records = parseUsageLineArtifactStrict(snapshot.bytes, artifact.filePath)
      serialize = (retained) => `${retained.map((record) => JSON.stringify(record)).join('\n')}\n`
      replacementPath = (content) => `${this.journalPath}.quarantine-${digestBytes(content)}.jsonl`
    }
    const retained = records.filter((record) => !usageRecordMatchesHistoryMutation(record, intent))
    const removed = records.length - retained.length
    if (removed === 0) return
    report.removedRecords += removed
    if (retained.length === 0) {
      retireRegularFileNoFollow(
        artifact.filePath,
        snapshot.identity,
        this.beforeRetireRename,
        this.afterRetireRename
      )
      report.removedArtifacts += 1
      return
    }
    const content = Buffer.from(serialize(retained), 'utf8')
    const nextPath = replacementPath(content)
    const existing = assertRegularFileOrMissing(nextPath)
    if (existing) {
      if (!readRegularFileBytesNoFollow(nextPath).equals(content)) {
        throw new Error(`Usage forensic replacement digest collision for ${artifact.filePath}.`)
      }
    } else {
      writeFileAtomically(nextPath, content)
    }
    retireRegularFileNoFollow(
      artifact.filePath,
      snapshot.identity,
      this.beforeRetireRename,
      this.afterRetireRename
    )
    report.rewrittenArtifacts += 1
  }

  /**
   * Finish a logically committed unlink that was interrupted after its source
   * inode moved into the private retirement directory. The directory name is
   * deliberately a narrow, store-owned allowlist; contents must be exactly one
   * non-linked regular `artifact`, otherwise recovery fails closed.
   */
  private recoverRetiredUsageArtifactsStrict(): void {
    const directory = path.dirname(this.journalPath)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    const retirementSuffix =
      /\.retire-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    for (const entry of entries) {
      if (!entry.name.startsWith('.') || !retirementSuffix.test(entry.name)) continue
      const originalName = entry.name.slice(1).replace(retirementSuffix, '')
      if (!this.isManagedUsageArtifactName(originalName)) continue
      const retirementDirectory = path.join(directory, entry.name)
      const directoryStat = fs.lstatSync(retirementDirectory)
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new UnsafeUsageStorePathError(
          retirementDirectory,
          'managed retirement is not a directory'
        )
      }
      const uid = typeof process.getuid === 'function' ? process.getuid() : null
      if (
        process.platform !== 'win32' &&
        ((uid !== null && directoryStat.uid !== uid) || (directoryStat.mode & 0o077) !== 0)
      ) {
        throw new UnsafeUsageStorePathError(
          retirementDirectory,
          'managed retirement ownership or mode is unsafe'
        )
      }
      const children = fs.readdirSync(retirementDirectory)
      if (children.length === 0) {
        fs.rmdirSync(retirementDirectory)
        fsyncDirectoryBestEffort(directory)
        continue
      }
      if (children.length !== 1 || children[0] !== 'artifact') {
        throw new UnsafeUsageStorePathError(
          retirementDirectory,
          'managed retirement contents are ambiguous'
        )
      }
      const retiredPath = path.join(retirementDirectory, 'artifact')
      assertRegularFile(retiredPath)
      fs.unlinkSync(retiredPath)
      fs.rmdirSync(retirementDirectory)
      fsyncDirectoryBestEffort(directory)
    }
  }

  private isManagedUsageArtifactName(name: string): boolean {
    const checkpointName = path.basename(this.checkpointPath)
    const journalName = path.basename(this.journalPath)
    const archiveName = path.basename(this.archivePath)
    if (
      name === checkpointName ||
      name === journalName ||
      name === archiveName ||
      name === path.basename(this.lockPath) ||
      name === path.basename(this.historyMutationIntentPath)
    ) {
      return true
    }
    if (name.startsWith(`${journalName}.claimed-`) || name.startsWith(`${journalName}.spill-`)) {
      return true
    }
    if (
      name.startsWith(`${checkpointName}.corrupt-`) &&
      /^(?:\d+|\d+-[0-9a-f]{64})$/i.test(name.slice(`${checkpointName}.corrupt-`.length))
    ) {
      return true
    }
    if (
      name.startsWith(`${journalName}.quarantine-`) &&
      /^[0-9a-f]{64}\.jsonl$/i.test(name.slice(`${journalName}.quarantine-`.length))
    ) {
      return true
    }
    const currentTemp =
      /\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i
    if (
      [checkpointName, journalName, archiveName].some(
        (prefix) => name.startsWith(`${prefix}.`) && currentTemp.test(name)
      )
    ) {
      return true
    }
    return (
      name.startsWith(`${checkpointName}.`) &&
      /^\d+\.\d+\.tmp$/.test(name.slice(`${checkpointName}.`.length))
    )
  }

  private removeUncommittedUsageTempsStrict(report: UsageHistoryPurgeReport): void {
    const directory = path.dirname(this.journalPath)
    const managedPrefixes = [
      `${path.basename(this.checkpointPath)}.`,
      `${path.basename(this.journalPath)}.`,
      `${path.basename(this.archivePath)}.`
    ]
    const legacyCheckpointTempPrefix = `${path.basename(this.checkpointPath)}.`
    let names: string[]
    try {
      names = fs.readdirSync(directory)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    for (const name of names) {
      const isCurrentAtomicTemp =
        managedPrefixes.some((prefix) => name.startsWith(prefix)) &&
        /\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(
          name
        )
      // Legacy AppStore.writeJson used usage.json.<pid>.<timestamp>.tmp. Keep
      // this intentionally checkpoint-specific so similarly named unrelated
      // userData files cannot enter the destructive allowlist.
      const isLegacyCheckpointTemp =
        name.startsWith(legacyCheckpointTempPrefix) &&
        /^\d+\.\d+\.tmp$/.test(name.slice(legacyCheckpointTempPrefix.length))
      if (!isCurrentAtomicTemp && !isLegacyCheckpointTemp) {
        continue
      }
      this.removeUsageArtifactStrict(path.join(directory, name), report)
    }
  }

  private listUsageForensicArtifactsStrict(): Array<{
    filePath: string
    format: 'checkpoint' | 'journal'
  }> {
    const directory = path.dirname(this.journalPath)
    const checkpointPrefix = `${path.basename(this.checkpointPath)}.corrupt-`
    const quarantinePrefix = `${path.basename(this.journalPath)}.quarantine-`
    let names: string[]
    try {
      names = fs.readdirSync(directory)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return []
      throw error
    }
    const artifacts: Array<{
      filePath: string
      format: 'checkpoint' | 'journal'
    }> = []
    for (const name of names) {
      if (name.endsWith('.tmp')) continue
      if (
        name.startsWith(checkpointPrefix) &&
        /^(?:\d+|\d+-[0-9a-f]{64})$/i.test(name.slice(checkpointPrefix.length))
      ) {
        artifacts.push({ filePath: path.join(directory, name), format: 'checkpoint' })
      } else if (
        name.startsWith(quarantinePrefix) &&
        /^[0-9a-f]{64}\.jsonl$/i.test(name.slice(quarantinePrefix.length))
      ) {
        artifacts.push({ filePath: path.join(directory, name), format: 'journal' })
      }
    }
    return artifacts.sort((left, right) => left.filePath.localeCompare(right.filePath))
  }

  private journalArtifactsContainHistoryScope(intent: UsageHistoryMutationIntent): boolean {
    const artifactList = this.listJournalArtifacts(true)
    if (artifactList.status === 'error') throw artifactList.error
    return artifactList.paths.some((filePath) => {
      const snapshot = readRegularFileSnapshotNoFollow(filePath)
      return parseUsageLineArtifactStrict(snapshot.bytes, filePath).some((record) =>
        usageRecordMatchesHistoryMutation(record, intent)
      )
    })
  }

  private verifyHistoryMutationStrict(intent: UsageHistoryMutationIntent): void {
    this.recoverRetiredUsageArtifactsStrict()
    if (intent.kind === 'global') {
      const journalArtifacts = this.listJournalArtifacts(true)
      if (journalArtifacts.status === 'error') throw journalArtifacts.error
      if (
        assertRegularFileOrMissing(this.checkpointPath) ||
        assertRegularFileOrMissing(this.archivePath) ||
        journalArtifacts.paths.length > 0 ||
        this.listUsageForensicArtifactsStrict().length > 0
      ) {
        throw new Error('Global usage history remained after strict purge.')
      }
      return
    }
    const checkpoint = assertRegularFileOrMissing(this.checkpointPath)
    if (checkpoint) {
      const parsed: unknown = JSON.parse(
        decodeUtf8Fatal(readRegularFileBytesNoFollow(this.checkpointPath))
      )
      if (
        !Array.isArray(parsed) ||
        !parsed.every(isUsageRecordLike) ||
        (parsed as UsageRecord[]).some((record) =>
          usageRecordMatchesHistoryMutation(record, intent)
        )
      ) {
        throw new Error('Scoped usage history remained in the checkpoint.')
      }
    }
    if (this.journalArtifactsContainHistoryScope(intent)) {
      throw new Error('Scoped usage history remained in a journal artifact.')
    }
    const archive = assertRegularFileOrMissing(this.archivePath)
    if (
      archive &&
      parseUsageLineArtifactStrict(
        readRegularFileBytesNoFollow(this.archivePath),
        this.archivePath
      ).some((record) => usageRecordMatchesHistoryMutation(record, intent))
    ) {
      throw new Error('Scoped usage history remained in the archive.')
    }
    for (const artifact of this.listUsageForensicArtifactsStrict()) {
      if (artifact.format === 'checkpoint') {
        const parsed: unknown = JSON.parse(
          decodeUtf8Fatal(readRegularFileBytesNoFollow(artifact.filePath))
        )
        if (
          !Array.isArray(parsed) ||
          !parsed.every(isUsageRecordLike) ||
          (parsed as UsageRecord[]).some((record) =>
            usageRecordMatchesHistoryMutation(record, intent)
          )
        ) {
          throw new Error('Scoped usage history could not be disproved in a corrupt backup.')
        }
      } else if (
        parseUsageLineArtifactStrict(
          readRegularFileBytesNoFollow(artifact.filePath),
          artifact.filePath
        ).some((record) => usageRecordMatchesHistoryMutation(record, intent))
      ) {
        throw new Error('Scoped usage history remained in a quarantine artifact.')
      }
    }
  }

  private scheduleCompaction(): void {
    if (!this.isWritable()) return
    if (this.compactionTimer) return
    if (
      !this.compactionRetryTimer &&
      this.compactionRetryAttempt >= MAX_COMPACTION_RETRY_ATTEMPTS
    ) {
      this.compactionRetryAttempt = 0
    }
    this.compactionTimer = setTimeout(() => {
      this.compactionTimer = null
      if (!this.isWritable()) return
      this.runScheduledCompaction()
    }, this.compactionDelayMs)
    this.compactionTimer.unref?.()
  }

  private scheduleAgeCompaction(): void {
    if (!this.isWritable()) return
    if (this.uncheckpointedSinceMs == null) return
    const dueAtMs = this.uncheckpointedSinceMs + this.compactAfterMs
    if (
      this.ageCompactionTimer &&
      this.ageCompactionDueAtMs !== null &&
      this.ageCompactionDueAtMs <= dueAtMs
    ) {
      return
    }
    if (this.ageCompactionTimer) clearTimeout(this.ageCompactionTimer)
    this.ageCompactionDueAtMs = dueAtMs
    const delayMs = Math.max(0, dueAtMs - this.now())
    this.ageCompactionTimer = setTimeout(() => {
      this.ageCompactionTimer = null
      this.ageCompactionDueAtMs = null
      if (!this.isWritable()) return
      this.runScheduledCompaction()
    }, delayMs)
    this.ageCompactionTimer.unref?.()
  }

  private scheduleCompactionRetry(): void {
    if (!this.isWritable()) return
    if (this.compactionRetryTimer || this.compactionRetryAttempt >= MAX_COMPACTION_RETRY_ATTEMPTS) {
      return
    }
    const delayMs = Math.min(
      COMPACTION_RETRY_BASE_MS * 2 ** this.compactionRetryAttempt,
      COMPACTION_RETRY_MAX_MS
    )
    this.compactionRetryAttempt += 1
    this.compactionRetryTimer = setTimeout(() => {
      this.compactionRetryTimer = null
      if (!this.isWritable()) return
      this.runScheduledCompaction()
    }, delayMs)
    this.compactionRetryTimer.unref?.()
  }

  private finishSuccessfulCompaction(): void {
    this.pendingAppendCount = 0
    this.uncheckpointedSinceMs = null
    this.compactionRetryAttempt = 0
    if (this.compactionTimer) clearTimeout(this.compactionTimer)
    if (this.ageCompactionTimer) clearTimeout(this.ageCompactionTimer)
    if (this.compactionRetryTimer) clearTimeout(this.compactionRetryTimer)
    this.compactionTimer = null
    this.ageCompactionTimer = null
    this.ageCompactionDueAtMs = null
    this.compactionRetryTimer = null
  }

  private compactionAgeDue(): boolean {
    return (
      this.uncheckpointedSinceMs !== null &&
      this.uncheckpointedSinceMs !== undefined &&
      this.now() - this.uncheckpointedSinceMs >= this.compactAfterMs
    )
  }

  private refreshUncheckpointedSince(): void {
    if (this.uncheckpointedSinceMs != null) return
    const artifacts = this.listJournalArtifacts(true)
    if (artifacts.status === 'error') throw artifacts.error
    this.noteUncheckpointedArtifacts(artifacts.paths)
  }

  private noteUncheckpointedArtifacts(filePaths: string[]): void {
    const artifactMtimes = filePaths
      .map((filePath) => safeRegularFileStartTime(filePath))
      .filter((mtimeMs): mtimeMs is number => mtimeMs !== null)
    if (artifactMtimes.length === 0) return
    const oldest = Math.min(...artifactMtimes)
    this.uncheckpointedSinceMs =
      this.uncheckpointedSinceMs == null ? oldest : Math.min(this.uncheckpointedSinceMs, oldest)
  }

  /**
   * The checkpoint as parsed last time, keyed on the stat fingerprint of the
   * bytes it came from. `getRecords()` reads the checkpoint TWICE per stable
   * attempt (its version brackets the journal reads), and the renderer asks
   * for usage on every thread select, every `usage-changed` push after a run
   * records usage, and on a 90s poll — each of which cost a full read, two
   * digests and a parse of the whole file on the main thread (7.6MB / 11.6k
   * records ≈ 30ms on the live profile, plus the allocation churn). A stat
   * is enough to know the file has not changed: the cache serves then, and
   * any append, compaction, history mutation or foreign rewrite misses it.
   */
  private checkpointParseCache: {
    fingerprint: UsageFileFingerprint
    records: UsageRecord[]
    version: string
  } | null = null

  private readCheckpointFromCache(): CheckpointReadResult | null {
    const cached = this.checkpointParseCache
    if (!cached) return null
    let stat: fs.Stats
    try {
      stat = assertRegularFile(this.checkpointPath)
    } catch {
      // Missing, replaced by a non-file, or unreadable: the full read reports it.
      return null
    }
    let current: UsageFileFingerprint
    try {
      current = usageFileFingerprint(stat, this.checkpointPath)
    } catch {
      return null
    }
    if (!sameUsageFileFingerprint(cached.fingerprint, current)) return null
    // A fresh array each time: callers spread or filter it, and the cached
    // one must never become someone's scratch space.
    return { status: 'ok', records: cached.records.slice(), version: cached.version }
  }

  private readCheckpoint(options: { lockHeld?: boolean } = {}): CheckpointReadResult {
    // Compaction and history mutation read under the lock to prove the
    // checkpoint generation before they commit over it. Those reads are rare
    // and must stay byte-exact, so they never take the cache; they refresh it.
    const cached = options.lockHeld ? null : this.readCheckpointFromCache()
    if (cached) return cached
    this.checkpointParseCache = null
    let snapshot: RegularFileSnapshot
    try {
      snapshot = this.readSnapshot(this.checkpointPath)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        return { status: 'missing', records: [], version: 'missing' }
      }
      this.logger.error(`Failed to read usage checkpoint ${this.checkpointPath}`, error)
      return { status: 'error', records: [], version: null, error }
    }
    const rawBytes = snapshot.bytes

    const version = digestBytes(rawBytes)
    try {
      const raw = decodeUtf8Fatal(rawBytes)
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('Usage checkpoint root must be an array')
      const records = parsed as UsageRecord[]
      if (snapshot.fingerprint) {
        this.checkpointParseCache = { fingerprint: snapshot.fingerprint, records, version }
      }
      return { status: 'ok', records: records.slice(), version }
    } catch (error) {
      this.logger.error(`Failed to parse usage checkpoint ${this.checkpointPath}`, error)
      if (this.isWritable() && !this.preservedCorruptCheckpointVersions.has(version)) {
        const preserveWhileLocked = (): void => {
          // A history intent is the privacy authority. Never mint a new
          // forensic copy behind its sweep; when this process owns the usage
          // lock, a concurrently prepared deletion must wait to enumerate
          // until after the backup is published and the lock is released.
          if (this.readHistoryMutationIntent()) return
          if (preserveCorruptContentBestEffort(this.checkpointPath, rawBytes, this.now())) {
            this.preservedCorruptCheckpointVersions.add(version)
          }
        }
        if (options.lockHeld) {
          preserveWhileLocked()
        } else {
          const lock = this.tryAcquireLock()
          if (lock) {
            try {
              preserveWhileLocked()
            } finally {
              this.releaseLock(lock)
            }
          }
        }
      }
      return { status: 'error', records: [], version, error }
    }
  }

  private readJournal(filePath: string): JournalReadResult {
    try {
      const snapshot = this.readSnapshot(filePath)
      const rawBytes = snapshot.bytes
      const records: UsageRecord[] = []
      let malformedLines = 0
      for (const lineBytes of splitByteLines(rawBytes)) {
        if (lineBytes.length === 0) continue
        let line: string
        try {
          line = decodeUtf8Fatal(lineBytes)
        } catch {
          malformedLines += 1
          continue
        }
        if (!line.trim()) continue
        try {
          const parsed: unknown = JSON.parse(line)
          if (isUsageRecordLike(parsed)) records.push(parsed as UsageRecord)
          else malformedLines += 1
        } catch {
          // A process can die during an append. Each new append begins with a
          // newline, so a torn fragment cannot consume the following record.
          malformedLines += 1
        }
      }
      if (malformedLines > 0) {
        this.logger.warn(
          `Ignored ${malformedLines} malformed line(s) while replaying usage journal ${filePath}`
        )
      }
      if (malformedLines > 0) {
        return {
          status: 'malformed',
          records,
          malformedLines,
          rawBytes,
          identity: snapshot.identity,
          error: new Error(`Usage journal contains ${malformedLines} malformed line(s)`)
        }
      }
      return { status: 'ok', records, malformedLines, identity: snapshot.identity }
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        return { status: 'missing', records: [], malformedLines: 0, error }
      }
      this.logger.error(`Failed to read usage journal ${filePath}`, error)
      return { status: 'error', records: [], malformedLines: 0, error }
    }
  }

  private listJournalArtifacts(includeLive: boolean): ArtifactListResult {
    const directory = path.dirname(this.journalPath)
    const basename = path.basename(this.journalPath)
    try {
      const paths = fs
        .readdirSync(directory)
        .filter(
          (name) =>
            !name.endsWith('.tmp') &&
            ((includeLive && name === basename) ||
              name.startsWith(`${basename}.claimed-`) ||
              name.startsWith(`${basename}.spill-`))
        )
        .sort()
        .map((name) => path.join(directory, name))
      return { status: 'ok', paths }
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return { status: 'ok', paths: [] }
      this.logger.error(`Failed to enumerate usage journals in ${directory}`, error)
      return { status: 'error', paths: [], error }
    }
  }

  private readSnapshot(filePath: string): RegularFileSnapshot {
    const before = assertRegularFile(filePath)
    const identity = regularFileIdentity(before, filePath)
    const bytes = this.readFileBytes(filePath)
    const after = assertRegularFile(filePath)
    assertSameRegularFileIdentity(filePath, identity, after)
    // A fingerprint vouches for the bytes only when nothing moved during the
    // read; a write landing mid-read leaves the snapshot uncacheable.
    const fingerprintBefore = usageFileFingerprint(before, filePath)
    const fingerprint = sameUsageFileFingerprint(
      fingerprintBefore,
      usageFileFingerprint(after, filePath)
    )
      ? fingerprintBefore
      : undefined
    return { bytes, identity, fingerprint }
  }

  private assertAppendTargetsSafe(): void {
    assertRegularFileOrMissing(this.journalPath)
    assertRegularFileOrMissing(this.lockPath)
  }

  private assertManagedDataTargetsSafe(): void {
    assertRegularFileOrMissing(this.checkpointPath)
    assertRegularFileOrMissing(this.journalPath)
    assertRegularFileOrMissing(this.archivePath)
  }

  private quarantineJournalArtifact(sourcePath: string, rawBytes: Buffer): void {
    const quarantinePath = this.quarantinePathFor(sourcePath, rawBytes)
    if (quarantinePath) writeFileAtomically(quarantinePath, rawBytes)
  }

  /** Where a malformed input's bytes are kept; null when the same bytes are there already. */
  private quarantinePathFor(sourcePath: string, rawBytes: Buffer): string | null {
    const digest = digestBytes(rawBytes)
    const quarantinePath = `${this.journalPath}.quarantine-${digest}.jsonl`
    const existing = assertRegularFileOrMissing(quarantinePath)
    if (existing) {
      const existingBytes = readRegularFileBytesNoFollow(quarantinePath)
      if (!existingBytes.equals(rawBytes)) {
        throw new Error(`Usage journal quarantine digest collision for ${sourcePath}`)
      }
      return null
    }
    return quarantinePath
  }

  private claimLiveJournal(): string | null {
    const claimedPath = `${this.journalPath}.claimed-${process.pid}-${randomUUID()}`
    try {
      assertRegularFileOrMissing(this.journalPath)
      fs.renameSync(this.journalPath, claimedPath)
      assertRegularFile(claimedPath)
      return claimedPath
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }

  private writeSpill(record: UsageRecord): void {
    const spillPath = `${this.journalPath}.spill-${process.pid}-${randomUUID()}`
    if (!this.writesUnsynced()) {
      writeFileAtomically(spillPath, `${JSON.stringify(record)}\n`)
      return
    }
    // Complete under its name, as a spill always is, and owed to the background.
    const temp = writeTempFileUnsynced(spillPath, `${JSON.stringify(record)}\n`)
    try {
      assertRegularFileOrMissing(spillPath)
      fs.renameSync(temp.path, spillPath)
    } catch (error) {
      try {
        retireRegularFileNoFollow(temp.path, temp.identity, undefined, undefined, false)
      } catch {
        // A stale temp is safer than deleting an unverified replacement.
      }
      throw error
    }
    this.unsyncedCounts.appends += 1
    this.unsyncedCounts.spills += 1
    this.unsynced!.background.owe({ files: [spillPath], directories: [path.dirname(spillPath)] })
  }

  private tryAcquireLock(): UsageJournalLock | null {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID()
      let descriptor: number | null = null
      let createdLock = false
      let createdLockIdentity: RegularFileIdentity | null = null
      try {
        assertRegularFileOrMissing(this.lockPath)
        descriptor = openRegularFileNoFollow(
          this.lockPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600
        )
        createdLock = true
        createdLockIdentity = regularFileIdentity(fs.fstatSync(descriptor), this.lockPath)
        fs.writeFileSync(
          descriptor,
          JSON.stringify({ token, pid: process.pid, createdAt: this.now() }),
          'utf8'
        )
        fs.closeSync(descriptor)
        return { token, filePath: this.lockPath }
      } catch (error) {
        if (descriptor !== null) {
          try {
            fs.closeSync(descriptor)
          } catch {
            // Preserve the lock acquisition error.
          }
        }
        if (createdLock && createdLockIdentity) {
          try {
            retireRegularFileNoFollow(this.lockPath, createdLockIdentity, this.beforeRetireRename)
          } catch {
            // A stale lock degrades subsequent appends to durable spills.
          }
        }
        if (error instanceof UnsafeUsageStorePathError) throw error
        if (!isNodeError(error, 'EEXIST')) {
          this.logger.warn('Failed to acquire usage journal lock', error)
          return null
        }
        if (attempt === 0 && this.removeStaleLock()) continue
        return null
      }
    }
    return null
  }

  private removeStaleLock(): boolean {
    try {
      const stat = assertRegularFile(this.lockPath)
      if (this.now() - stat.mtimeMs < LOCK_STALE_AFTER_MS) return false
      const unsynced = this.writesUnsynced()
      retireRegularFileNoFollow(
        this.lockPath,
        regularFileIdentity(stat, this.lockPath),
        this.beforeRetireRename,
        undefined,
        !unsynced
      )
      if (unsynced) {
        this.unsynced!.background.owe({ directories: [path.dirname(this.lockPath)] })
      }
      return true
    } catch (error) {
      return isNodeError(error, 'ENOENT')
    }
  }

  private releaseLock(lock: UsageJournalLock): void {
    try {
      const snapshot = readRegularFileSnapshotNoFollow(lock.filePath)
      const parsed = JSON.parse(decodeUtf8Fatal(snapshot.bytes)) as {
        token?: unknown
      }
      if (parsed.token === lock.token) {
        // The lock's name leaving its folder is owed to the background like any other.
        const unsynced = this.writesUnsynced()
        retireRegularFileNoFollow(
          lock.filePath,
          snapshot.identity,
          this.beforeRetireRename,
          undefined,
          !unsynced
        )
        if (unsynced) {
          this.unsynced!.background.owe({ directories: [path.dirname(lock.filePath)] })
        }
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        this.logger.warn('Failed to release usage journal lock', error)
      }
    }
  }
}

function normalizeUsageHistoryMutationIntent(value: unknown): UsageHistoryMutationIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Usage history mutation intent is not an object.')
  }
  const record = value as Partial<UsageHistoryMutationIntent>
  const kinds = new Set<UsageHistoryMutationKind>(['global', 'workspace', 'chat', 'truncate'])
  const statuses = new Set<UsageHistoryMutationIntent['status']>(['prepared', 'completed'])
  const identifiers = (items: unknown, label: string): string[] => {
    if (!Array.isArray(items)) throw new Error(`Usage history mutation ${label} is not an array.`)
    const result = [...new Set(items)]
    if (
      result.some(
        (item) => typeof item !== 'string' || !item || item.length > 4096 || item !== item.trim()
      )
    ) {
      throw new Error(`Usage history mutation ${label} contains an unsafe identifier.`)
    }
    return (result as string[]).sort()
  }
  if (
    record.schemaVersion !== 1 ||
    typeof record.operationId !== 'string' ||
    !record.operationId ||
    record.operationId.length > 128 ||
    !kinds.has(record.kind as UsageHistoryMutationKind) ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    !statuses.has(record.status as UsageHistoryMutationIntent['status'])
  ) {
    throw new Error('Usage history mutation intent header is invalid.')
  }
  const kind = record.kind as UsageHistoryMutationKind
  if (
    (kind === 'workspace' &&
      (typeof record.workspaceId !== 'string' ||
        !record.workspaceId ||
        record.workspaceId !== record.workspaceId.trim() ||
        record.workspaceId.length > 4096)) ||
    (kind !== 'workspace' && record.workspaceId !== undefined)
  ) {
    throw new Error('Usage history mutation workspace scope is invalid.')
  }
  const chatIds = identifiers(record.chatIds, 'chat ids')
  const runIds = identifiers(record.runIds, 'run ids')
  if ((kind === 'chat' || kind === 'truncate') && chatIds.length === 0) {
    throw new Error('Scoped usage history mutation has no chat owner.')
  }
  return {
    schemaVersion: 1,
    operationId: record.operationId,
    kind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(kind === 'workspace' ? { workspaceId: record.workspaceId as string } : {}),
    chatIds,
    runIds,
    status: record.status as UsageHistoryMutationIntent['status']
  }
}

function sameUsageHistoryMutationScope(
  left: UsageHistoryMutationIntent,
  right: UsageHistoryMutationIntent
): boolean {
  return (
    left.operationId === right.operationId &&
    left.kind === right.kind &&
    left.workspaceId === right.workspaceId &&
    JSON.stringify(left.chatIds) === JSON.stringify(right.chatIds) &&
    JSON.stringify(left.runIds) === JSON.stringify(right.runIds)
  )
}

function usageRecordMatchesHistoryMutation(
  record: UsageRecord,
  intent: UsageHistoryMutationIntent
): boolean {
  if (intent.kind === 'global') return true
  if (intent.kind === 'workspace' && record.workspaceId === intent.workspaceId) return true
  return intent.chatIds.includes(record.chatId) || intent.runIds.includes(record.runId)
}

function parseUsageLineArtifactStrict(rawBytes: Buffer, filePath: string): UsageRecord[] {
  const records: UsageRecord[] = []
  for (const lineBytes of splitByteLines(rawBytes)) {
    if (lineBytes.length === 0) continue
    const line = decodeUtf8Fatal(lineBytes)
    if (!line.trim()) continue
    const parsed: unknown = JSON.parse(line)
    if (!isUsageRecordLike(parsed)) {
      throw new Error(`Usage history artifact ${filePath} contains an invalid record.`)
    }
    records.push(parsed)
  }
  return records
}

function countUsageRecordsBestEffort(rawBytes: Buffer, filePath: string): number {
  try {
    const parsed: unknown = JSON.parse(decodeUtf8Fatal(rawBytes))
    if (Array.isArray(parsed)) return parsed.filter(isUsageRecordLike).length
  } catch {
    // JSONL is handled below.
  }
  try {
    return parseUsageLineArtifactStrict(rawBytes, filePath).length
  } catch {
    return 0
  }
}

function removeRegularFileStrict(
  filePath: string,
  beforeRename?: (filePath: string) => void,
  afterRename?: (filePath: string, retiredPath: string) => void
): void {
  let snapshot: RegularFileSnapshot
  try {
    snapshot = readRegularFileSnapshotNoFollow(filePath)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  retireRegularFileNoFollow(filePath, snapshot.identity, beforeRename, afterRename)
}

function isUsageRecordLike(value: unknown): value is UsageRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as { id?: unknown; timestamp?: unknown }
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.timestamp === 'number'
  )
}

function dedupeAndSortUsageRecords(records: UsageRecord[]): UsageRecord[] {
  const deduped: UsageRecord[] = []
  const seenIds = new Set<string>()
  for (const record of records) {
    const id = typeof record?.id === 'string' ? record.id : ''
    if (id && seenIds.has(id)) continue
    if (id) seenIds.add(id)
    deduped.push(record)
  }
  return deduped.sort((left, right) => {
    const leftTimestamp = Number.isFinite(left?.timestamp)
      ? left.timestamp
      : Number.POSITIVE_INFINITY
    const rightTimestamp = Number.isFinite(right?.timestamp)
      ? right.timestamp
      : Number.POSITIVE_INFINITY
    return leftTimestamp - rightTimestamp
  })
}

/**
 * Appends, and syncs the file and, when it made the file, its folder. With
 * `sync` false it only writes, for barrier durability's caller to sync off
 * the event loop. Returns whether it made the file.
 */
function durableAppend(filePath: string, content: string, sync = true): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const existed = assertRegularFileOrMissing(filePath) !== null
  const descriptor = openRegularFileNoFollow(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
    0o600
  )
  try {
    fs.writeFileSync(descriptor, content, 'utf8')
    if (sync) fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  if (!existed && sync) fsyncDirectoryBestEffort(path.dirname(filePath))
  return !existed
}

/** As `durableAppend`, for the records the archive does not hold yet: whether it appended and whether it made the file. */
function appendArchiveDurably(
  filePath: string,
  records: UsageRecord[],
  sync = true
): { appended: boolean; created: boolean } {
  if (records.length === 0) return { appended: false, created: false }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const existingIds = readArchiveRecordIds(filePath)
  const recordsToAppend = records.filter((record) => !existingIds.has(record.id))
  if (recordsToAppend.length === 0) return { appended: false, created: false }
  const existed = assertRegularFileOrMissing(filePath) !== null
  const descriptor = openRegularFileNoFollow(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
    0o600
  )
  try {
    fs.writeFileSync(
      descriptor,
      recordsToAppend.map((record) => `\n${JSON.stringify(record)}`).join(''),
      'utf8'
    )
    if (sync) fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  if (!existed && sync) fsyncDirectoryBestEffort(path.dirname(filePath))
  return { appended: true, created: !existed }
}

function readArchiveRecordIds(filePath: string): Set<string> {
  let snapshot: RegularFileSnapshot
  try {
    snapshot = readRegularFileSnapshotNoFollow(filePath)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return new Set()
    throw error
  }

  const ids = new Set<string>()
  for (const lineBytes of splitByteLines(snapshot.bytes)) {
    if (lineBytes.length === 0) continue
    let line: string
    try {
      line = decodeUtf8Fatal(lineBytes)
    } catch {
      continue
    }
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isUsageRecordLike(parsed)) ids.add(parsed.id)
    } catch {
      // A previously torn archive row is not durable evidence that its id was
      // committed. Each append starts on a new line, so valid neighbours remain
      // independently replayable for idempotency checks.
    }
  }
  return ids
}

function writeCheckpointAtomically(filePath: string, records: UsageRecord[]): void {
  writeFileAtomically(filePath, JSON.stringify(records))
}

function writeFileAtomically(filePath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  assertRegularFileOrMissing(filePath)
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | null = null
  let tempIdentity: RegularFileIdentity | null = null
  try {
    descriptor = openRegularFileNoFollow(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    )
    tempIdentity = regularFileIdentity(fs.fstatSync(descriptor), tempPath)
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    assertRegularFileOrMissing(filePath)
    fs.renameSync(tempPath, filePath)
    fsyncDirectoryBestEffort(path.dirname(filePath))
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Preserve the original failure.
      }
    }
    if (tempIdentity) {
      try {
        retireRegularFileNoFollow(tempPath, tempIdentity)
      } catch {
        // A stale temp is safer than deleting an unverified replacement.
      }
    }
    throw error
  }
}

/**
 * `writeFileAtomically` up to its rename, without its sync: the content under
 * a temp name of the same shape, for barrier durability's caller to sync off
 * the event loop before it renames it.
 */
function writeTempFileUnsynced(
  filePath: string,
  content: string | Buffer
): { path: string; identity: RegularFileIdentity } {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  assertRegularFileOrMissing(filePath)
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | null = null
  let tempIdentity: RegularFileIdentity | null = null
  try {
    descriptor = openRegularFileNoFollow(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    )
    tempIdentity = regularFileIdentity(fs.fstatSync(descriptor), tempPath)
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.closeSync(descriptor)
    descriptor = null
    return { path: tempPath, identity: tempIdentity }
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Preserve the original failure.
      }
    }
    if (tempIdentity) {
      try {
        retireRegularFileNoFollow(tempPath, tempIdentity, undefined, undefined, false)
      } catch {
        // A stale temp is safer than deleting an unverified replacement.
      }
    }
    throw error
  }
}

function preserveCorruptContentBestEffort(
  filePath: string,
  content: string | Buffer,
  nowMs: number
): boolean {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  const backupPath = `${filePath}.corrupt-${nowMs}-${digestBytes(bytes)}`
  try {
    const existing = assertRegularFileOrMissing(backupPath)
    if (existing && readRegularFileBytesNoFollow(backupPath).equals(bytes)) return true
    if (existing) throw new Error(`Usage checkpoint backup digest collision for ${filePath}`)
    writeFileAtomically(backupPath, bytes)
    return true
  } catch {
    // Preserve the original read failure.
    return false
  }
}

function safeRegularFileSize(filePath: string): number {
  try {
    return assertRegularFile(filePath).size
  } catch {
    return 0
  }
}

function safeRegularFileStartTime(filePath: string): number | null {
  try {
    const stat = assertRegularFile(filePath)
    const birthtimeMs =
      Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
    return Math.min(stat.mtimeMs, birthtimeMs)
  } catch {
    return null
  }
}

function digestBytes(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function assertRegularFileOrMissing(filePath: string): fs.Stats | null {
  try {
    return assertRegularFile(filePath)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
}

function assertRegularFile(filePath: string): fs.Stats {
  const stat = fs.lstatSync(filePath)
  if (stat.isSymbolicLink()) throw new UnsafeUsageStorePathError(filePath, 'symbolic link')
  if (!stat.isFile()) throw new UnsafeUsageStorePathError(filePath, 'not a regular file')
  if (stat.nlink !== 1) {
    throw new UnsafeUsageStorePathError(filePath, `unexpected hard-link count ${stat.nlink}`)
  }
  return stat
}

function regularFileIdentity(stat: fs.Stats, filePath: string): RegularFileIdentity {
  if (!Number.isFinite(stat.dev) || !Number.isFinite(stat.ino) || stat.ino === 0) {
    throw new UnsafeUsageStorePathError(filePath, 'stable filesystem identity unavailable')
  }
  return { dev: stat.dev, ino: stat.ino }
}

function assertSameRegularFileIdentity(
  filePath: string,
  expected: RegularFileIdentity,
  actual: fs.Stats
): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new UnsafeUsageStorePathError(filePath, 'path changed after secure open')
  }
}

function openRegularFileNoFollow(filePath: string, flags: number, mode?: number): number {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
  let descriptor: number
  try {
    descriptor = fs.openSync(filePath, flags | noFollow, mode)
  } catch (error) {
    if (isNodeError(error, 'ELOOP')) {
      throw new UnsafeUsageStorePathError(filePath, 'symbolic link')
    }
    throw error
  }
  try {
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile()) throw new UnsafeUsageStorePathError(filePath, 'not a regular file')
    if (opened.nlink !== 1) {
      throw new UnsafeUsageStorePathError(filePath, `unexpected hard-link count ${opened.nlink}`)
    }
    const named = assertRegularFile(filePath)
    if (
      opened.dev !== named.dev ||
      (opened.ino !== 0 && named.ino !== 0 && opened.ino !== named.ino)
    ) {
      throw new UnsafeUsageStorePathError(filePath, 'path changed while opening')
    }
    return descriptor
  } catch (error) {
    try {
      fs.closeSync(descriptor)
    } catch {
      // Preserve the validation error.
    }
    throw error
  }
}

function readRegularFileSnapshotNoFollow(filePath: string): RegularFileSnapshot {
  assertRegularFile(filePath)
  const descriptor = openRegularFileNoFollow(filePath, fs.constants.O_RDONLY)
  try {
    const bytes = fs.readFileSync(descriptor)
    const openedAfterRead = fs.fstatSync(descriptor)
    if (!openedAfterRead.isFile() || openedAfterRead.nlink !== 1) {
      throw new UnsafeUsageStorePathError(filePath, 'opened file changed while reading')
    }
    const identity = regularFileIdentity(openedAfterRead, filePath)
    const namedAfterRead = assertRegularFile(filePath)
    assertSameRegularFileIdentity(filePath, identity, namedAfterRead)
    return { bytes, identity }
  } finally {
    fs.closeSync(descriptor)
  }
}

function readRegularFileBytesNoFollow(filePath: string): Buffer {
  return readRegularFileSnapshotNoFollow(filePath).bytes
}

function decodeUtf8Fatal(value: Buffer): string {
  return FATAL_UTF8_DECODER.decode(value)
}

function splitByteLines(value: Buffer): Buffer[] {
  const lines: Buffer[] = []
  let lineStart = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0x0a) continue
    lines.push(value.subarray(lineStart, index))
    lineStart = index + 1
  }
  lines.push(value.subarray(lineStart))
  return lines
}

/** `syncParent` false leaves the folder's sync to barrier durability's caller. */
function retireRegularFileNoFollow(
  filePath: string,
  expectedIdentity: RegularFileIdentity,
  beforeRename?: (filePath: string) => void,
  afterRename?: (filePath: string, retiredPath: string) => void,
  syncParent = true
): void {
  const parentDirectory = path.dirname(filePath)
  const retirementDirectory = path.join(
    parentDirectory,
    `.${path.basename(filePath)}.retire-${process.pid}-${randomUUID()}`
  )
  const retiredPath = path.join(retirementDirectory, 'artifact')
  let moved = false

  fs.mkdirSync(retirementDirectory, { mode: 0o700 })
  try {
    const retirementStat = fs.lstatSync(retirementDirectory)
    if (retirementStat.isSymbolicLink() || !retirementStat.isDirectory()) {
      throw new UnsafeUsageStorePathError(retirementDirectory, 'unsafe retirement directory')
    }

    const sourceBeforeRename = assertRegularFile(filePath)
    assertSameRegularFileIdentity(filePath, expectedIdentity, sourceBeforeRename)
    beforeRename?.(filePath)
    fs.renameSync(filePath, retiredPath)
    moved = true
    afterRename?.(filePath, retiredPath)

    // The rename is the destructive boundary for the attacker-writable source
    // name. Validate the inode now resident in our freshly-created private
    // directory; a swapped path is retained there and is never unlinked.
    const retired = assertRegularFile(retiredPath)
    assertSameRegularFileIdentity(filePath, expectedIdentity, retired)
    fs.unlinkSync(retiredPath)
    moved = false
    fs.rmdirSync(retirementDirectory)
    if (syncParent) fsyncDirectoryBestEffort(parentDirectory)
  } catch (error) {
    if (!moved) {
      try {
        fs.rmdirSync(retirementDirectory)
      } catch {
        // Preserve any unexpected entry rather than recursively deleting it.
      }
    }
    throw error
  }
}

function fsyncDirectoryBestEffort(directoryPath: string): void {
  if (process.platform === 'win32') return
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(directoryPath, 'r')
    fs.fsyncSync(descriptor)
  } catch {
    // Windows and some filesystems reject directory fsync.
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Best effort only.
      }
    }
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
  )
}
