/**
 * Durable, host-owned revision store for the Studio companion.
 *
 * The Electron main process owns all project state; companions are stateless
 * projections. Every committed edit appends one journal line (fdatasync per
 * commit) and bumps a monotonic revision. Mutations must present the exact
 * current revision as baseRevision; anything else is rejected as stale_base
 * with the current revision attached so the caller can rebase — the host
 * never merges.
 *
 * Recovery loads the snapshot, then replays strictly newer journal lines. A
 * torn trailing line is discarded with a warning and the store immediately
 * re-compacts so on-disk state is self-consistent again. Compaction keeps the
 * journal bounded: a fat journal with no snapshot is a known startup-latency
 * spiral elsewhere in this codebase and is deliberately impossible here.
 */
import * as fsPromises from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  STUDIO_TIME_ZERO,
  StudioTimeError,
  studioTimeAdd,
  studioTimeCompare,
  studioTimeFromWire,
  studioTimeIsFrameAligned,
  studioTimeSub,
  type StudioRationalTime
} from './StudioRationalTime'
import type { StudioEditOp, StudioInsertRangeOp } from './StudioProtocol'

export const STUDIO_DOCUMENT_FORMAT_VERSION = 1
export const STUDIO_DEFAULT_TRACK_ID = 'V1'
export const STUDIO_SNAPSHOT_FILENAME = 'studio-project.snapshot.json'
export const STUDIO_JOURNAL_FILENAME = 'studio-project.journal.jsonl'
export const STUDIO_SNAPSHOT_FORMAT = 'taskwraith-studio-snapshot'
export const STUDIO_JOURNAL_FORMAT = 'taskwraith-studio-journal'

export interface StudioClipItem {
  itemId: string
  assetId: string
  sourceIn: StudioRationalTime
  /** Exclusive end of the source range. */
  sourceOut: StudioRationalTime
  /** Sequence position of the item start. */
  position: StudioRationalTime
  /** Sequence duration; equals sourceOut - sourceIn at identity speed. */
  duration: StudioRationalTime
}

export interface StudioTrack {
  trackId: string
  kind: 'video' | 'audio'
  /** Sorted by position; never overlapping. */
  items: StudioClipItem[]
}

export interface StudioDocument {
  formatVersion: typeof STUDIO_DOCUMENT_FORMAT_VERSION
  tracks: StudioTrack[]
}

export function createEmptyStudioDocument(): StudioDocument {
  return { formatVersion: STUDIO_DOCUMENT_FORMAT_VERSION, tracks: [] }
}

export type StudioEditErrorCode =
  | 'invalid_params'
  | 'invalid_op'
  | 'insertion_inside_item'
  | 'duplicate_item'
  | 'unrepresentable_time'
  | 'misaligned_time'

export class StudioEditError extends Error {
  readonly code: StudioEditErrorCode

  constructor(code: StudioEditErrorCode, message: string) {
    super(message)
    this.name = 'StudioEditError'
    this.code = code
  }
}

export class StudioStoreCorruptError extends Error {
  readonly reason: 'snapshot_unreadable'

  constructor(reason: 'snapshot_unreadable', message: string) {
    super(message)
    this.name = 'StudioStoreCorruptError'
    this.reason = reason
  }
}

function readOpTime(value: unknown, context: string): StudioRationalTime {
  try {
    return studioTimeFromWire(value, context)
  } catch (error) {
    if (error instanceof StudioTimeError) {
      const code = error.code === 'unrepresentable_time' ? 'unrepresentable_time' : 'invalid_params'
      throw new StudioEditError(code, error.message)
    }
    throw error
  }
}

function requireNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StudioEditError('invalid_params', `${context} must be a non-empty string`)
  }
  return value
}

function exactTime(compute: () => StudioRationalTime, context: string): StudioRationalTime {
  try {
    return compute()
  } catch (error) {
    if (error instanceof StudioTimeError) {
      throw new StudioEditError('unrepresentable_time', `${context}: ${error.message}`)
    }
    throw error
  }
}

function applyInsertRange(document: StudioDocument, op: StudioInsertRangeOp): StudioDocument {
  const itemId = requireNonEmptyString(op.itemId, 'insert_range.itemId')
  const assetId = requireNonEmptyString(op.assetId, 'insert_range.assetId')
  const trackId =
    op.trackId === undefined
      ? STUDIO_DEFAULT_TRACK_ID
      : requireNonEmptyString(op.trackId, 'insert_range.trackId')

  const sourceIn = readOpTime(op.sourceIn, 'insert_range.sourceIn')
  const sourceOut = readOpTime(op.sourceOut, 'insert_range.sourceOut')
  const at = readOpTime(op.at, 'insert_range.at')

  if (studioTimeCompare(sourceIn, STUDIO_TIME_ZERO) < 0) {
    throw new StudioEditError('invalid_op', 'insert_range.sourceIn must not be negative')
  }
  if (studioTimeCompare(sourceOut, sourceIn) <= 0) {
    throw new StudioEditError(
      'invalid_op',
      'insert_range source range must be non-empty (sourceOut > sourceIn)'
    )
  }
  if (studioTimeCompare(at, STUDIO_TIME_ZERO) < 0) {
    throw new StudioEditError('invalid_op', 'insert_range.at must not be negative')
  }

  if (op.assetFrameRate !== undefined) {
    const frameRate = readOpTime(op.assetFrameRate, 'insert_range.assetFrameRate')
    if (studioTimeCompare(frameRate, STUDIO_TIME_ZERO) <= 0) {
      throw new StudioEditError('invalid_params', 'insert_range.assetFrameRate must be positive')
    }
    if (
      !studioTimeIsFrameAligned(sourceIn, frameRate) ||
      !studioTimeIsFrameAligned(sourceOut, frameRate)
    ) {
      throw new StudioEditError(
        'misaligned_time',
        'insert_range source range must land exactly on frame boundaries of assetFrameRate'
      )
    }
  }

  const duration = exactTime(() => studioTimeSub(sourceOut, sourceIn), 'insert_range duration')

  for (const track of document.tracks) {
    if (track.items.some((item) => item.itemId === itemId)) {
      throw new StudioEditError(
        'duplicate_item',
        `item id "${itemId}" already exists in the document`
      )
    }
  }

  const existingTrack = document.tracks.find((track) => track.trackId === trackId)
  const targetItems = existingTrack ? existingTrack.items : []

  for (const item of targetItems) {
    const itemEnd = exactTime(() => studioTimeAdd(item.position, item.duration), 'ripple bound')
    if (studioTimeCompare(item.position, at) < 0 && studioTimeCompare(at, itemEnd) < 0) {
      throw new StudioEditError(
        'insertion_inside_item',
        `insertion point falls inside item "${item.itemId}"; split is not supported by insert_range`
      )
    }
  }

  const insertedItem: StudioClipItem = {
    itemId,
    assetId,
    sourceIn,
    sourceOut,
    position: at,
    duration
  }

  const rippledItems = targetItems.map((item) =>
    studioTimeCompare(item.position, at) >= 0
      ? {
          ...item,
          position: exactTime(() => studioTimeAdd(item.position, duration), 'ripple shift')
        }
      : item
  )
  const nextItems = [...rippledItems, insertedItem].sort((a, b) =>
    studioTimeCompare(a.position, b.position)
  )

  for (let index = 1; index < nextItems.length; index += 1) {
    const previous = nextItems[index - 1]
    const previousEnd = exactTime(
      () => studioTimeAdd(previous.position, previous.duration),
      'overlap check'
    )
    if (studioTimeCompare(previousEnd, nextItems[index].position) > 0) {
      throw new StudioEditError(
        'invalid_op',
        'internal overlap invariant violated after insert_range'
      )
    }
  }

  const nextTrack: StudioTrack = existingTrack
    ? { ...existingTrack, items: nextItems }
    : { trackId, kind: 'video', items: nextItems }

  const nextTracks = existingTrack
    ? document.tracks.map((track) => (track.trackId === trackId ? nextTrack : track))
    : [...document.tracks, nextTrack]

  return { ...document, tracks: nextTracks }
}

/** Pure, deterministic op application; journal replay depends on this staying total. */
export function applyStudioEditOp(document: StudioDocument, op: StudioEditOp): StudioDocument {
  if (typeof op !== 'object' || op === null) {
    throw new StudioEditError('invalid_op', 'edit op must be an object')
  }
  switch (op.type) {
    case 'insert_range':
      return applyInsertRange(document, op)
    default:
      throw new StudioEditError(
        'invalid_op',
        `unknown edit op type "${String((op as { type?: unknown }).type)}"`
      )
  }
}

export interface StudioStoreRecovery {
  revision: number
  replayedJournalOps: number
  skippedStaleJournalLines: number
  discardedJournalLines: number
  warnings: string[]
}

export type StudioApplyEditOutcome =
  | { ok: true; revision: number }
  | {
      ok: false
      code: StudioEditErrorCode | 'stale_base'
      message: string
      currentRevision: number
    }

export interface StudioRevisionStoreOptions {
  /** Compact once this many ops accumulate in the journal. */
  compactEveryOps?: number
  /** Compact once the journal grows past this many bytes. */
  compactWhenJournalBytes?: number
}

interface StudioJournalLine {
  format: typeof STUDIO_JOURNAL_FORMAT
  v: 1
  revision: number
  committedAtIso: string
  op: StudioEditOp
}

interface StudioSnapshotFile {
  format: typeof STUDIO_SNAPSHOT_FORMAT
  v: 1
  revision: number
  document: StudioDocument
}

const DEFAULT_COMPACT_EVERY_OPS = 256
const DEFAULT_COMPACT_JOURNAL_BYTES = 4 * 1024 * 1024

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function parseSnapshotFile(raw: string, path: string): StudioSnapshotFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new StudioStoreCorruptError('snapshot_unreadable', `${path}: ${detail}`)
  }
  const candidate = parsed as Partial<StudioSnapshotFile> | null
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    candidate.format !== STUDIO_SNAPSHOT_FORMAT ||
    candidate.v !== 1 ||
    typeof candidate.revision !== 'number' ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 0 ||
    typeof candidate.document !== 'object' ||
    candidate.document === null ||
    candidate.document.formatVersion !== STUDIO_DOCUMENT_FORMAT_VERSION ||
    !Array.isArray(candidate.document.tracks)
  ) {
    throw new StudioStoreCorruptError('snapshot_unreadable', `${path}: snapshot shape is invalid`)
  }
  return candidate as StudioSnapshotFile
}

function isJournalLineShape(value: unknown): value is StudioJournalLine {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<StudioJournalLine>
  return (
    candidate.format === STUDIO_JOURNAL_FORMAT &&
    candidate.v === 1 &&
    typeof candidate.revision === 'number' &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision > 0 &&
    typeof candidate.op === 'object' &&
    candidate.op !== null
  )
}

export class StudioRevisionStore {
  private document: StudioDocument
  private currentRevision: number
  private journalOpsSinceSnapshot: number
  private journalBytesSinceSnapshot: number
  private journalHandle: fsPromises.FileHandle | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly snapshotPath: string
  private readonly journalPath: string
  private readonly compactEveryOps: number
  private readonly compactWhenJournalBytes: number
  readonly recovery: StudioStoreRecovery

  private constructor(init: {
    directory: string
    document: StudioDocument
    revision: number
    journalOpsSinceSnapshot: number
    journalBytesSinceSnapshot: number
    recovery: StudioStoreRecovery
    options: StudioRevisionStoreOptions
  }) {
    this.snapshotPath = nodePath.join(init.directory, STUDIO_SNAPSHOT_FILENAME)
    this.journalPath = nodePath.join(init.directory, STUDIO_JOURNAL_FILENAME)
    this.document = init.document
    this.currentRevision = init.revision
    this.journalOpsSinceSnapshot = init.journalOpsSinceSnapshot
    this.journalBytesSinceSnapshot = init.journalBytesSinceSnapshot
    this.recovery = init.recovery
    this.compactEveryOps = Math.max(1, init.options.compactEveryOps ?? DEFAULT_COMPACT_EVERY_OPS)
    this.compactWhenJournalBytes = Math.max(
      1,
      init.options.compactWhenJournalBytes ?? DEFAULT_COMPACT_JOURNAL_BYTES
    )
  }

  static async open(
    directory: string,
    options: StudioRevisionStoreOptions = {}
  ): Promise<StudioRevisionStore> {
    await fsPromises.mkdir(directory, { recursive: true })
    const snapshotPath = nodePath.join(directory, STUDIO_SNAPSHOT_FILENAME)
    const journalPath = nodePath.join(directory, STUDIO_JOURNAL_FILENAME)

    let document = createEmptyStudioDocument()
    let revision = 0
    const warnings: string[] = []

    let snapshotRaw: string | null = null
    try {
      snapshotRaw = await fsPromises.readFile(snapshotPath, 'utf8')
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    if (snapshotRaw !== null) {
      const snapshot = parseSnapshotFile(snapshotRaw, snapshotPath)
      document = snapshot.document
      revision = snapshot.revision
    }

    let journalRaw: string | null = null
    try {
      journalRaw = await fsPromises.readFile(journalPath, 'utf8')
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }

    let replayedJournalOps = 0
    let skippedStaleJournalLines = 0
    let discardedJournalLines = 0
    let journalBytesSinceSnapshot = 0

    if (journalRaw !== null && journalRaw.length > 0) {
      const rawLines = journalRaw.split('\n')
      const lines: { text: string; index: number }[] = []
      for (let index = 0; index < rawLines.length; index += 1) {
        const text = rawLines[index].trim()
        if (text.length > 0) lines.push({ text, index })
      }
      const endedWithLineFeed = journalRaw.endsWith('\n')
      for (let cursor = 0; cursor < lines.length; cursor += 1) {
        const { text, index } = lines[cursor]
        const isFinalLine = cursor === lines.length - 1
        const remaining = lines.length - cursor - 1
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          if (isFinalLine && !endedWithLineFeed) {
            warnings.push(`journal line ${index + 1} was torn mid-write and has been discarded`)
            discardedJournalLines += 1
            break
          }
          warnings.push(
            `journal line ${index + 1} is unreadable; discarded it and ${remaining} following line(s)`
          )
          discardedJournalLines += remaining + 1
          break
        }
        if (!isJournalLineShape(parsed)) {
          warnings.push(
            `journal line ${index + 1} has an invalid shape; discarded it and ${remaining} following line(s)`
          )
          discardedJournalLines += remaining + 1
          break
        }
        if (parsed.revision <= revision) {
          skippedStaleJournalLines += 1
          continue
        }
        if (parsed.revision !== revision + 1) {
          warnings.push(
            `journal line ${index + 1} jumps from revision ${revision} to ${parsed.revision}; discarded it and ${remaining} following line(s)`
          )
          discardedJournalLines += remaining + 1
          break
        }
        try {
          document = applyStudioEditOp(document, parsed.op)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          warnings.push(
            `journal line ${index + 1} no longer applies (${detail}); discarded it and ${remaining} following line(s)`
          )
          discardedJournalLines += remaining + 1
          break
        }
        revision = parsed.revision
        replayedJournalOps += 1
        journalBytesSinceSnapshot += Buffer.byteLength(text) + 1
      }
    }

    const store = new StudioRevisionStore({
      directory,
      document,
      revision,
      journalOpsSinceSnapshot: replayedJournalOps,
      journalBytesSinceSnapshot,
      recovery: {
        revision,
        replayedJournalOps,
        skippedStaleJournalLines,
        discardedJournalLines,
        warnings
      },
      options
    })

    if (discardedJournalLines > 0 || skippedStaleJournalLines > 0) {
      await store.enqueue(async () => {
        await store.compactLocked()
      })
      warnings.push('store re-compacted after recovery so disk state matches memory')
    }

    return store
  }

  get revision(): number {
    return this.currentRevision
  }

  /** Deep copy; callers can never mutate host-owned state through it. */
  getDocument(): StudioDocument {
    return structuredClone(this.document)
  }

  applyEdit(baseRevision: number, op: StudioEditOp): Promise<StudioApplyEditOutcome> {
    return this.enqueue(async () => {
      if (this.closed) {
        throw new Error('StudioRevisionStore is closed')
      }
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
        return {
          ok: false as const,
          code: 'invalid_params' as const,
          message: 'baseRevision must be a non-negative safe integer',
          currentRevision: this.currentRevision
        }
      }
      if (baseRevision !== this.currentRevision) {
        return {
          ok: false as const,
          code: 'stale_base' as const,
          message: `base revision ${baseRevision} is stale; current revision is ${this.currentRevision}`,
          currentRevision: this.currentRevision
        }
      }
      let nextDocument: StudioDocument
      try {
        nextDocument = applyStudioEditOp(this.document, op)
      } catch (error) {
        if (error instanceof StudioEditError) {
          return {
            ok: false as const,
            code: error.code,
            message: error.message,
            currentRevision: this.currentRevision
          }
        }
        throw error
      }
      const line: StudioJournalLine = {
        format: STUDIO_JOURNAL_FORMAT,
        v: 1,
        revision: this.currentRevision + 1,
        committedAtIso: new Date().toISOString(),
        op: structuredClone(op)
      }
      const serialised = `${JSON.stringify(line)}\n`
      const handle = await this.journalFileHandle()
      await handle.appendFile(serialised, 'utf8')
      await handle.datasync()
      this.document = nextDocument
      this.currentRevision += 1
      this.journalOpsSinceSnapshot += 1
      this.journalBytesSinceSnapshot += Buffer.byteLength(serialised)
      if (
        this.journalOpsSinceSnapshot >= this.compactEveryOps ||
        this.journalBytesSinceSnapshot >= this.compactWhenJournalBytes
      ) {
        await this.compactLocked()
      }
      return { ok: true as const, revision: this.currentRevision }
    })
  }

  close(): Promise<void> {
    return this.enqueue(async () => {
      this.closed = true
      if (this.journalHandle !== null) {
        await this.journalHandle.close()
        this.journalHandle = null
      }
    })
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.queue.then(job)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async journalFileHandle(): Promise<fsPromises.FileHandle> {
    if (this.journalHandle === null) {
      this.journalHandle = await fsPromises.open(this.journalPath, 'a')
    }
    return this.journalHandle
  }

  /** Only call from inside the write queue. */
  private async compactLocked(): Promise<void> {
    const snapshot: StudioSnapshotFile = {
      format: STUDIO_SNAPSHOT_FORMAT,
      v: 1,
      revision: this.currentRevision,
      document: this.document
    }
    const temporaryPath = `${this.snapshotPath}.tmp-${process.pid}-${Date.now()}`
    const handle = await fsPromises.open(temporaryPath, 'w')
    try {
      await handle.writeFile(JSON.stringify(snapshot, null, 2), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fsPromises.rename(temporaryPath, this.snapshotPath)
    if (this.journalHandle !== null) {
      await this.journalHandle.close()
      this.journalHandle = null
    }
    await fsPromises.writeFile(this.journalPath, '', 'utf8')
    this.journalOpsSinceSnapshot = 0
    this.journalBytesSinceSnapshot = 0
  }
}
