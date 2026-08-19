import * as fs from 'fs'
import * as path from 'path'
import {
  applyChatRecordMutation,
  CHAT_RECORD_MUTATION_FORMAT,
  CHAT_RECORD_MUTATION_VERSION,
  type ChatRecordMutationBatch,
  type ChatRecordMutationOperation
} from './ChatRecordMutation'
import type { ChatRecord } from './types'

export const INCREMENTAL_CHAT_CHECKPOINT_FORMAT = 'taskwraith-chat-checkpoint' as const
export const INCREMENTAL_CHAT_CHECKPOINT_VERSION = 1 as const

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

export interface IncrementalChatJournalStats {
  appends: number
  deferredAppends: number
  deferredFsyncFailures: number
  drainedDeferredFsyncs: number
  mutationBytesWritten: number
  checkpointsWritten: number
  checkpointBytesWritten: number
  replayedBatches: number
  skippedDuplicateBatches: number
  tornTailsRecovered: number
  tombstoneRejects: number
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

export interface IncrementalChatJournal {
  initialize(chatId: string, record: ChatRecord): void
  append(batch: ChatRecordMutationBatch, options?: IncrementalChatAppendOptions): void
  replay(chatId: string): IncrementalChatReplayResult
  replaceAuthoritativeCheckpoint(chatId: string, record: ChatRecord): void
  checkpoint(chatId: string, reason: IncrementalChatCheckpointReason): boolean
  checkpointIdle(nowMs?: number): number
  checkpointAll(reason?: IncrementalChatCheckpointReason): number
  /** Synchronously fsync every journal file with an unsettled deferred flush. */
  drainDeferredDurability(): number
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

const DEFAULT_MAX_JOURNAL_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_JOURNAL_ENTRIES = 1_000
const DEFAULT_IDLE_CHECKPOINT_MS = 15_000
const DEFAULT_MAX_UNCHECKPOINTED_MS = 2 * 60 * 1000
const DEFAULT_MAX_JOURNAL_READ_BYTES = 256 * 1024 * 1024
const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/
const MUTATION_OPERATION_TYPES = new Set<ChatRecordMutationOperation['type']>([
  'record_patch',
  'messages_splice',
  'message_content_append',
  'message_put',
  'message_patch',
  'tool_activities_presence',
  'tool_activities_splice',
  'tool_activity_put',
  'runs_splice',
  'run_put'
])
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

function cloneRecord(record: ChatRecord): ChatRecord {
  return JSON.parse(JSON.stringify(record)) as ChatRecord
}

function validMutationBatch(value: unknown, chatId: string): value is ChatRecordMutationBatch {
  if (!value || typeof value !== 'object') return false
  const batch = value as Partial<ChatRecordMutationBatch>
  return (
    batch.format === CHAT_RECORD_MUTATION_FORMAT &&
    batch.version === CHAT_RECORD_MUTATION_VERSION &&
    batch.chatId === chatId &&
    nonNegativeInteger(batch.baseRevision) &&
    nonNegativeInteger(batch.revision) &&
    batch.revision > batch.baseRevision &&
    typeof batch.savedAt === 'string' &&
    Array.isArray(batch.operations) &&
    batch.operations.every(
      (operation) =>
        !!operation &&
        typeof operation === 'object' &&
        MUTATION_OPERATION_TYPES.has((operation as ChatRecordMutationOperation).type)
    )
  )
}

function validCheckpoint(value: unknown, chatId: string): value is IncrementalChatCheckpoint {
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
  const scheduleFsync =
    options.scheduleFsync ?? ((fd, done) => fs.fsync(fd, (error) => done(error)))
  let writeSequence = 0
  let appends = 0
  let deferredAppends = 0
  let deferredFsyncFailures = 0
  let drainedDeferredFsyncs = 0
  let mutationBytesWritten = 0
  let checkpointsWritten = 0
  let checkpointBytesWritten = 0
  let replayedBatches = 0
  let skippedDuplicateBatches = 0
  let tornTailsRecovered = 0
  let tombstoneRejects = 0

  /** Unsettled deferred flushes, by journal file. An entry's fd is closed by
   * its own completion callback exactly once; draining marks entries settled
   * and flushes via a fresh fd, so the two paths never race on a handle. */
  interface PendingDeferredFsync {
    fd: number
    settled: boolean
  }
  const pendingDeferredByPath = new Map<string, Set<PendingDeferredFsync>>()
  const fsyncEscalatedChatIds = new Set<string>()
  let pendingDeferredCount = 0
  /** Backpressure bound: an unbounded queue in front of fsync is how this
   * layer once produced a 44 GB artifact. Saturation falls back to sync. */
  const MAX_PENDING_DEFERRED_FSYNCS = 64

  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })

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

  const atomicWrite = (filePath: string, data: string): number => {
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    const tempPath = path.join(
      baseDir,
      `.${path.basename(filePath)}.${process.pid}.${writeSequence++}.tmp`
    )
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

  const appendLine = (filePath: string, line: string): number => {
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    const fd = fs.openSync(filePath, 'a', 0o600)
    try {
      fs.writeSync(fd, line)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    return Buffer.byteLength(line, 'utf8')
  }

  /** D1 append: the write is synchronous (ordering + same-process visibility
   * unchanged); only the disk flush leaves the caller's critical path. */
  const appendLineDeferred = (filePath: string, line: string, chatId: string): number => {
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    const fd = fs.openSync(filePath, 'a', 0o600)
    let entries = pendingDeferredByPath.get(filePath)
    if (!entries) {
      entries = new Set()
      pendingDeferredByPath.set(filePath, entries)
    }
    const entry: PendingDeferredFsync = { fd, settled: false }
    try {
      fs.writeSync(fd, line)
      entries.add(entry)
      pendingDeferredCount += 1
      scheduleFsync(fd, (error) => {
        const wasSettled = entry.settled
        if (!wasSettled) {
          entry.settled = true
          entries!.delete(entry)
          pendingDeferredCount -= 1
        }
        try {
          fs.closeSync(fd)
        } catch {
          /* already closed handles are the only expected failure here */
        }
        if (!wasSettled && error) {
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
      } finally {
        fs.closeSync(fd)
      }
      void error
    }
    return Buffer.byteLength(line, 'utf8')
  }

  const drainDeferredDurability = (): number => {
    let drained = 0
    for (const [filePath, entries] of pendingDeferredByPath) {
      const unsettled = [...entries].filter((entry) => !entry.settled)
      if (unsettled.length === 0) continue
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
      for (const entry of unsettled) {
        entry.settled = true
        entries.delete(entry)
        pendingDeferredCount -= 1
        drained += 1
      }
    }
    drainedDeferredFsyncs += drained
    return drained
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
      throw new Error(`Incremental chat checkpoint for ${chatId} is corrupt`)
    }
    if (!validCheckpoint(parsed, chatId)) {
      throw new Error(`Incremental chat checkpoint for ${chatId} has an invalid shape`)
    }
    return parsed
  }

  const parseJournal = (chatId: string): ParsedJournal => {
    const filePath = journalPath(chatId)
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

  const recoverTornTail = (chatId: string, parsed: ParsedJournal): void => {
    if (!parsed.torn) return
    if (parsed.validContent) atomicWrite(journalPath(chatId), parsed.validContent)
    else {
      try {
        fs.unlinkSync(journalPath(chatId))
        fsyncDirectory()
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    parsed.bytes = Buffer.byteLength(parsed.validContent, 'utf8')
    tornTailsRecovered += 1
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
    const parsed = tombstoned
      ? { batches: [], bytes: 0, torn: false, validContent: '' }
      : parseJournal(chatId)
    recoverTornTail(chatId, parsed)
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
      record: cloneRecord(record)
    }
    const bytes = atomicWrite(checkpointPath(chatId), JSON.stringify(checkpoint))
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
    const parsed = parseJournal(chatId)
    recoverTornTail(chatId, parsed)
    let record = cloneRecord(checkpoint.record)
    let appliedBatches = 0
    let skippedBatches = 0
    for (const batch of parsed.batches) {
      const revision = recordRevision(record)
      if (batch.revision <= revision) {
        skippedBatches += 1
        continue
      }
      record = applyChatRecordMutation(record, batch)
      appliedBatches += 1
    }
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
      recoveredTornTail: parsed.torn
    }
  }

  const checkpoint = (chatId: string, reason: IncrementalChatCheckpointReason): boolean => {
    assertChatId(chatId)
    const state = loadState(chatId)
    if (state.tombstoned || state.journalEntries === 0) return false
    const replayed = replay(chatId)
    if (!replayed.record || replayed.revision === null) return false
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
    try {
      fs.unlinkSync(journalPath(chatId))
      fsyncDirectory()
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    state.headRevision = replayed.revision
    state.journalEntries = 0
    state.journalBytes = 0
    state.dirtySinceMs = null
    state.lastAppendAtMs = null
    return true
  }

  const replaceAuthoritativeCheckpoint = (chatId: string, record: ChatRecord): void => {
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
      record: cloneRecord(record)
    }
    const bytes = atomicWrite(checkpointPath(chatId), JSON.stringify(nextCheckpoint))
    checkpointsWritten += 1
    checkpointBytesWritten += bytes
    try {
      fs.unlinkSync(journalPath(chatId))
      fsyncDirectory()
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    state.headRevision = revision
    state.journalEntries = 0
    state.journalBytes = 0
    state.dirtySinceMs = null
    state.lastAppendAtMs = null
  }

  const append = (
    batch: ChatRecordMutationBatch,
    appendOptions?: IncrementalChatAppendOptions
  ): void => {
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
    // A deferred request escalates to sync for exactly one append after a
    // failed deferred flush (re-establishing durable ground before deferring
    // again), and whenever the pending set is saturated (backpressure).
    const deferred =
      appendOptions?.durability === 'deferred' &&
      !fsyncEscalatedChatIds.delete(batch.chatId) &&
      pendingDeferredCount < MAX_PENDING_DEFERRED_FSYNCS
    const line = `${JSON.stringify(batch)}\n`
    const bytes = deferred
      ? appendLineDeferred(journalPath(batch.chatId), line, batch.chatId)
      : appendLine(journalPath(batch.chatId), line)
    if (deferred) deferredAppends += 1
    appends += 1
    mutationBytesWritten += bytes
    state.headRevision = batch.revision
    state.journalEntries += 1
    state.journalBytes += bytes
    state.dirtySinceMs ??= now()
    state.lastAppendAtMs = now()

    if (
      state.journalEntries >= maxJournalEntries ||
      state.journalBytes >= maxJournalBytes ||
      (state.dirtySinceMs !== null && now() - state.dirtySinceMs >= maxUncheckpointedMs)
    ) {
      checkpoint(batch.chatId, 'bounded')
    }
  }

  const knownChatIds = (): Set<string> => {
    const ids = new Set(states.keys())
    let entries: string[] = []
    try {
      entries = fs.readdirSync(baseDir)
    } catch {
      return ids
    }
    for (const entry of entries) {
      for (const suffix of ['.checkpoint.json', '.mutations.jsonl', '.tombstone']) {
        if (!entry.endsWith(suffix)) continue
        const chatId = entry.slice(0, -suffix.length)
        if (CHAT_ID_PATTERN.test(chatId)) ids.add(chatId)
      }
    }
    return ids
  }

  const checkpointIdle = (nowMs = now()): number => {
    let count = 0
    for (const chatId of knownChatIds()) {
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
    }
    return count
  }

  const checkpointAll = (reason: IncrementalChatCheckpointReason = 'shutdown'): number => {
    // A shutdown/manual sweep must not leave D1 appends riding the kernel:
    // settle the deferred flushes first, then supersede them with checkpoints.
    drainDeferredDurability()
    let count = 0
    for (const chatId of knownChatIds()) {
      if (checkpoint(chatId, reason)) count += 1
    }
    return count
  }

  const deleteChat = (chatId: string): void => {
    assertChatId(chatId)
    atomicWrite(tombstonePath(chatId), '')
    for (const filePath of [journalPath(chatId), checkpointPath(chatId)]) {
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
    assertChatId(chatId)
    for (const filePath of [journalPath(chatId), checkpointPath(chatId), tombstonePath(chatId)]) {
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
  }

  const stats = (): IncrementalChatJournalStats => ({
    appends,
    deferredAppends,
    deferredFsyncFailures,
    drainedDeferredFsyncs,
    mutationBytesWritten,
    checkpointsWritten,
    checkpointBytesWritten,
    replayedBatches,
    skippedDuplicateBatches,
    tornTailsRecovered,
    tombstoneRejects
  })

  return {
    initialize,
    append,
    replay,
    replaceAuthoritativeCheckpoint,
    checkpoint,
    checkpointIdle,
    checkpointAll,
    drainDeferredDurability,
    delete: deleteChat,
    purge,
    clear,
    stats
  }
}
