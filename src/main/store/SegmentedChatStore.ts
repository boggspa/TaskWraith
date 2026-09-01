import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'
import {
  applyChatRecordMutation,
  CHAT_RECORD_MUTATION_FORMAT,
  CHAT_RECORD_MUTATION_VERSION,
  deriveChatRecordMutationWithProjection,
  type AuthoredChatTranscriptMutation,
  type ChatRecordMutationBatch,
  type ChatRecordMutationOperation
} from './ChatRecordMutation'
import type { ChatRecord } from './types'

/**
 * Stage 3 — the ADR §5.1 segmented dual-read chat store (chat store v2).
 *
 * Layout lives on a SIBLING VERSIONED ROOT (`<userData>/chat-store-v2/`),
 * following the `chat-journal-v2` precedent. It must never drop directories
 * or non-*.json files inside `chats/`: the Host scanner
 * (`HostProfileDomainStore.sweepChatRecords`) throws
 * 'Unsafe chat directory entry' on anything in `chats/` that is not a plain
 * ChatRecord JSON file, so the segmented artifacts get their own root.
 *
 * Per chat:
 *   - `<chatId>.manifest.json`   — formatVersion, authority, revision,
 *                                  segment list, compaction generation,
 *                                  content hashes (atomic write);
 *   - `<chatId>.snapshot.json`   — atomic compact snapshot (full ChatRecord);
 *   - `<chatId>.segment-<n>.jsonl` — append-only framed JSON mutation
 *                                  segments (rotating, fsync'd);
 *   - `<chatId>.archive-<n>.jsonl` — compacted closed segments (never on the
 *                                  hot rewrite path);
 *   - `<chatId>.quarantine-<n>.jsonl` — corrupt segments isolated for
 *                                  forensics;
 *   - `<chatId>.tombstone`       — deletion marker.
 *
 * DARK (ADR §11.4): `TASKWRAITH_CHAT_STORE_V2=1` opts in; the default build is
 * inert — no segment writes, no v2 reads, legacy behavior byte-for-byte.
 *
 * Authority split (the Stage 2 journal-mirror discipline): the legacy
 * `chats/<id>.json` whole-record write stays authoritative while the flag is
 * off, and every save mirrors onto this store. Reads prefer healthy v2
 * segments and fail closed to the legacy record on any v2 defect — disabling
 * the flag fully restores legacy behavior with no data loss. Lifecycle
 * operations (purge/clear/re-anchor after an erasure truncation) stay
 * writable even with the flag off, so a later disable can never leave an
 * erased transcript recoverable in stale v2 segments.
 *
 * Full-history assembly (`readFull`) is part of the store interface so
 * exports, forks, audit, compaction and recovery keep a complete-transcript
 * path; paging (Stage 1a) never becomes the only read mode.
 */

export const CHAT_STORE_V2_MANIFEST_FORMAT = 'taskwraith-chat-store-v2-manifest' as const
export const CHAT_STORE_V2_MANIFEST_VERSION = 1 as const
export const CHAT_STORE_V2_SNAPSHOT_FORMAT = 'taskwraith-chat-store-v2-snapshot' as const
export const CHAT_STORE_V2_SNAPSHOT_VERSION = 1 as const
/** Feature flag name for ADR §11.4 opt-in. */
export const CHAT_STORE_V2_ENV_FLAG = 'TASKWRAITH_CHAT_STORE_V2'

const DEFAULT_MAX_SEGMENT_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_SEGMENT_ENTRIES = 4_096
const DEFAULT_MAX_SEGMENT_READ_BYTES = 256 * 1024 * 1024
const DEFAULT_IDLE_COMPACTION_MS = 15_000
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

/** Off unless `TASKWRAITH_CHAT_STORE_V2=1` (ADR §11.4 — default off). */
export function isSegmentedChatStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env[CHAT_STORE_V2_ENV_FLAG] ?? '').trim() === '1'
}

export interface SegmentedChatSegmentRef {
  fileName: string
  generation: number
  startRevision: number
  endRevision: number
  bytes: number
  sha256: string
}

export interface SegmentedChatManifest {
  format: typeof CHAT_STORE_V2_MANIFEST_FORMAT
  version: typeof CHAT_STORE_V2_MANIFEST_VERSION
  chatId: string
  /**
   * 'v1' while the legacy chats/*.json record remains the write authority
   * (the S2 dark-write state). The feature flag governs reads; this bit
   * records cutover state for the future S3/S4 transitions.
   */
  authority: 'v1'
  persistenceRevision: number
  compactionGeneration: number
  snapshot: { fileName: string; revision: number; bytes: number; sha256: string } | null
  segments: SegmentedChatSegmentRef[]
  archives: { fileName: string; bytes: number; sha256: string }[]
  quarantined: { fileName: string; reason: string }[]
  updatedAt: string
}

export interface SegmentedChatSnapshot {
  format: typeof CHAT_STORE_V2_SNAPSHOT_FORMAT
  version: typeof CHAT_STORE_V2_SNAPSHOT_VERSION
  chatId: string
  revision: number
  savedAt: string
  record: ChatRecord
}

export interface SegmentedChatMirrorResult {
  seeded: boolean
  mutationBytes: number
}

export interface SegmentedChatReadResult {
  record: ChatRecord
  revision: number
  appliedBatches: number
  skippedDuplicateBatches: number
  malformedTailSkips: number
  quarantinedThisRead: number
}

export interface SegmentedChatStoreStats {
  seeds: number
  mirrorSaves: number
  mutationBatchesAppended: number
  mutationBytesAppended: number
  baselineRepairs: number
  segmentRotations: number
  compactions: number
  purges: number
  clears: number
  readAttempts: number
  readHits: number
  readMisses: number
  malformedTailSkips: number
  quarantinedSegments: number
  failures: number
}

export interface SegmentedChatStore {
  /**
   * Sideband mirror of one legacy whole-record save. Returns null (and does
   * nothing) while the feature flag is off. Throws when the store is
   * read-only under the legacy writer gate; callers degrade to
   * legacy-only persistence and the next save re-anchors the baseline.
   */
  mirrorSave(
    previous: ChatRecord | null,
    next: ChatRecord,
    authoredTranscript?: AuthoredChatTranscriptMutation
  ): SegmentedChatMirrorResult | null
  /** Full-history assembly. null = v2 unavailable/unhealthy (fall back to v1). */
  readFull(chatId: string): SegmentedChatReadResult | null
  /** Cheap health probe: v2 has a loadable baseline for this chat. */
  prefersV2(chatId: string): boolean
  /** Re-anchor the v2 baseline on the authoritative record (erasure truncation). */
  replaceAuthoritative(chatId: string, record: ChatRecord): void
  /** Compact: snapshot at the assembled revision, segments retired to archive. */
  checkpoint(chatId: string): boolean
  checkpointIdle(nowMs?: number): number
  checkpointAll(): number
  purge(chatId: string): void
  clear(): void
  stats(): SegmentedChatStoreStats
}

export interface SegmentedChatStoreOptions {
  /** Feature flag (ADR §11.4). Defaults to `isSegmentedChatStoreEnabled`. */
  enabled?: () => boolean
  /** Authority gate; false is strictly read-only. Independent of the flag so
   * lifecycle purge/clear stay available after a flag disable. */
  canWrite?: () => boolean
  /**
   * Authority for read-path side effects (torn-tail trim, quarantine renames).
   * Defaults to `canWrite`; the Host-owned read-only import invariant keeps
   * these strictly legacy-admitted in production (same split as Stage 2).
   */
  canRepairOnRead?: () => boolean
  now?: () => number
  maxSegmentBytes?: number
  maxSegmentEntries?: number
  maxSegmentReadBytes?: number
  idleCompactionMs?: number
}

interface RuntimeState {
  headRevision: number | null
  generation: number
  segmentPath: string
  segmentStartRevision: number
  segmentEntries: number
  segmentBytes: number
  dirtySinceMs: number | null
  lastAppendAtMs: number | null
  tombstoned: boolean
  /** False once a read observed a corrupt/missing manifest mid-process; the
   * next mirror re-anchors instead of appending behind a broken baseline. */
  manifestHealthy: boolean
}

interface ParsedSegment {
  batches: ChatRecordMutationBatch[]
  bytes: number
  torn: boolean
  validContent: string
}

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

function validManifest(value: unknown, chatId: string): value is SegmentedChatManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<SegmentedChatManifest>
  const validSegmentRef = (ref: unknown): boolean => {
    if (!ref || typeof ref !== 'object') return false
    const segment = ref as Partial<SegmentedChatSegmentRef>
    return (
      typeof segment.fileName === 'string' &&
      nonNegativeInteger(segment.generation) &&
      nonNegativeInteger(segment.startRevision) &&
      nonNegativeInteger(segment.endRevision) &&
      nonNegativeInteger(segment.bytes) &&
      typeof segment.sha256 === 'string'
    )
  }
  return (
    manifest.format === CHAT_STORE_V2_MANIFEST_FORMAT &&
    manifest.version === CHAT_STORE_V2_MANIFEST_VERSION &&
    manifest.chatId === chatId &&
    (manifest.authority === 'v1' || manifest.authority === 'v2') &&
    nonNegativeInteger(manifest.persistenceRevision) &&
    nonNegativeInteger(manifest.compactionGeneration) &&
    typeof manifest.updatedAt === 'string' &&
    Array.isArray(manifest.segments) &&
    manifest.segments.every(validSegmentRef) &&
    Array.isArray(manifest.archives) &&
    Array.isArray(manifest.quarantined) &&
    (manifest.snapshot === null ||
      (!!manifest.snapshot &&
        typeof manifest.snapshot.fileName === 'string' &&
        nonNegativeInteger(manifest.snapshot.revision) &&
        nonNegativeInteger(manifest.snapshot.bytes) &&
        typeof manifest.snapshot.sha256 === 'string'))
  )
}

function validSnapshot(value: unknown, chatId: string): value is SegmentedChatSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<SegmentedChatSnapshot>
  return (
    snapshot.format === CHAT_STORE_V2_SNAPSHOT_FORMAT &&
    snapshot.version === CHAT_STORE_V2_SNAPSHOT_VERSION &&
    snapshot.chatId === chatId &&
    nonNegativeInteger(snapshot.revision) &&
    typeof snapshot.savedAt === 'string' &&
    !!snapshot.record &&
    typeof snapshot.record === 'object' &&
    snapshot.record.appChatId === chatId &&
    recordRevision(snapshot.record) === snapshot.revision
  )
}

export function createSegmentedChatStore(
  baseDir: string,
  options: SegmentedChatStoreOptions = {}
): SegmentedChatStore {
  const now = options.now ?? Date.now
  const enabled = (): boolean => {
    try {
      return options.enabled?.() ?? isSegmentedChatStoreEnabled()
    } catch {
      return false
    }
  }
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
    if (!canWrite()) throw new Error('Segmented chat store is read-only')
  }
  const maxSegmentBytes = positiveInteger(options.maxSegmentBytes, DEFAULT_MAX_SEGMENT_BYTES)
  const maxSegmentEntries = positiveInteger(options.maxSegmentEntries, DEFAULT_MAX_SEGMENT_ENTRIES)
  const maxSegmentReadBytes = positiveInteger(
    options.maxSegmentReadBytes,
    DEFAULT_MAX_SEGMENT_READ_BYTES
  )
  const idleCompactionMs = positiveInteger(options.idleCompactionMs, DEFAULT_IDLE_COMPACTION_MS)
  const states = new Map<string, RuntimeState>()
  const baselineVerifiedChatIds = new Set<string>()
  const lastPersistedRevisionByChatId = new Map<string, number>()
  let writeSequence = 0
  let seeds = 0
  let mirrorSaves = 0
  let mutationBatchesAppended = 0
  let mutationBytesAppended = 0
  let baselineRepairs = 0
  let segmentRotations = 0
  let compactions = 0
  let purges = 0
  let clears = 0
  let readAttempts = 0
  let readHits = 0
  let readMisses = 0
  let malformedTailSkips = 0
  let quarantinedSegments = 0
  let failures = 0
  if (canWrite()) fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })

  const assertChatId = (chatId: string): void => {
    if (!CHAT_ID_PATTERN.test(chatId)) throw new Error(`Unsafe chat id: ${chatId}`)
  }

  const manifestPath = (chatId: string): string => path.join(baseDir, `${chatId}.manifest.json`)
  const snapshotPath = (chatId: string): string => path.join(baseDir, `${chatId}.snapshot.json`)
  const segmentPath = (chatId: string, generation: number): string =>
    path.join(baseDir, `${chatId}.segment-${generation}.jsonl`)
  const tombstonePath = (chatId: string): string => path.join(baseDir, `${chatId}.tombstone`)

  const sha256Hex = (filePath: string): string => {
    const data = fs.readFileSync(filePath)
    return createHash('sha256').update(data).digest('hex')
  }

  const fsyncDirectory = (): void => {
    let fd: number | null = null
    try {
      fd = fs.openSync(baseDir, 'r')
      fs.fsyncSync(fd)
    } catch {
      // Directory fsync is not available on every supported platform. The
      // file itself remains fsynced and reads are still fail-closed.
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

  const readManifest = (chatId: string): SegmentedChatManifest | null => {
    let raw: string
    try {
      raw = fs.readFileSync(manifestPath(chatId), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Chat store v2 manifest for ${chatId} is corrupt`)
    }
    if (!validManifest(parsed, chatId)) {
      throw new Error(`Chat store v2 manifest for ${chatId} has an invalid shape`)
    }
    return parsed
  }

  const readSnapshot = (chatId: string): SegmentedChatSnapshot | null => {
    let raw: string
    try {
      raw = fs.readFileSync(snapshotPath(chatId), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Chat store v2 snapshot for ${chatId} is corrupt`)
    }
    if (!validSnapshot(parsed, chatId)) {
      throw new Error(`Chat store v2 snapshot for ${chatId} has an invalid shape`)
    }
    return parsed
  }

  const parseSegmentGeneration = (fileName: string): number | null => {
    const match = /\.segment-(\d+)\.jsonl$/.exec(fileName)
    if (!match) return null
    const generation = Number(match[1])
    return Number.isSafeInteger(generation) ? generation : null
  }

  const listSegmentFileNames = (chatId: string): string[] => {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(baseDir)
    } catch {
      return []
    }
    const prefix = `${chatId}.segment-`
    return entries.filter(
      (entry) =>
        entry.startsWith(prefix) && entry.endsWith('.jsonl') && entry.length > prefix.length
    )
  }

  /** Manifest-listed segments plus any unlisted segment files (crash between
   * rotation and manifest publication, or first appends before any rotation),
   * in generation order. Duplicates collapse by file name. */
  const orderedSegmentFileNames = (
    chatId: string,
    manifest: SegmentedChatManifest | null
  ): string[] => {
    const names = new Set<string>()
    for (const ref of manifest?.segments ?? []) names.add(ref.fileName)
    for (const fileName of listSegmentFileNames(chatId)) names.add(fileName)
    return [...names].sort((a, b) => {
      const ga = parseSegmentGeneration(a) ?? -1
      const gb = parseSegmentGeneration(b) ?? -1
      return ga - gb || a.localeCompare(b)
    })
  }

  const nextGeneration = (chatId: string, manifest: SegmentedChatManifest | null): number => {
    let generation = 0
    for (const ref of manifest?.segments ?? []) {
      generation = Math.max(generation, ref.generation + 1)
    }
    for (const fileName of listSegmentFileNames(chatId)) {
      const parsed = parseSegmentGeneration(fileName)
      if (parsed !== null) generation = Math.max(generation, parsed + 1)
    }
    return generation
  }

  const parseSegment = (chatId: string, filePath: string): ParsedSegment => {
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { batches: [], bytes: 0, torn: false, validContent: '' }
      }
      throw error
    }
    if (stat.size > maxSegmentReadBytes) {
      throw new Error(`Chat store v2 segment for ${chatId} exceeds ${maxSegmentReadBytes} bytes`)
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

  const removeTranscriptSegments = (chatId: string): void => {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(baseDir)
    } catch {
      return
    }
    for (const entry of entries) {
      const isTranscriptArtifact =
        entry.startsWith(`${chatId}.segment-`) ||
        entry.startsWith(`${chatId}.archive-`) ||
        entry.startsWith(`${chatId}.quarantine-`)
      if (!isTranscriptArtifact) continue
      try {
        fs.unlinkSync(path.join(baseDir, entry))
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    fsyncDirectory()
  }

  const writeSnapshot = (
    chatId: string,
    record: ChatRecord,
    revision: number
  ): { fileName: string; revision: number; bytes: number; sha256: string } => {
    const snapshot: SegmentedChatSnapshot = {
      format: CHAT_STORE_V2_SNAPSHOT_FORMAT,
      version: CHAT_STORE_V2_SNAPSHOT_VERSION,
      chatId,
      revision,
      savedAt: new Date(now()).toISOString(),
      record: cloneRecord(record)
    }
    const data = JSON.stringify(snapshot)
    atomicWrite(snapshotPath(chatId), data)
    return {
      fileName: `${chatId}.snapshot.json`,
      revision,
      bytes: Buffer.byteLength(data, 'utf8'),
      sha256: sha256Hex(snapshotPath(chatId))
    }
  }

  const freshManifest = (chatId: string): SegmentedChatManifest => ({
    format: CHAT_STORE_V2_MANIFEST_FORMAT,
    version: CHAT_STORE_V2_MANIFEST_VERSION,
    chatId,
    authority: 'v1',
    persistenceRevision: 0,
    compactionGeneration: 0,
    snapshot: null,
    segments: [],
    archives: [],
    quarantined: [],
    updatedAt: new Date(now()).toISOString()
  })

  const writeManifest = (chatId: string, manifest: SegmentedChatManifest): number => {
    return atomicWrite(manifestPath(chatId), JSON.stringify(manifest))
  }

  /** Publish snapshot + fresh manifest and reset the active segment. Used by
   * seed and re-anchor. Destroys every existing transcript segment: those
   * bytes are superseded by (or erased before) the new snapshot. */
  const publishSnapshot = (chatId: string, record: ChatRecord): void => {
    assertWritable()
    assertChatId(chatId)
    if (record.appChatId !== chatId) throw new Error('Chat store v2 identity mismatch')
    removeTranscriptSegments(chatId)
    const revision = recordRevision(record)
    const snapshot = writeSnapshot(chatId, record, revision)
    const manifest = freshManifest(chatId)
    manifest.persistenceRevision = revision
    manifest.snapshot = snapshot
    manifest.updatedAt = new Date(now()).toISOString()
    writeManifest(chatId, manifest)
    const generation = nextGeneration(chatId, manifest)
    states.set(chatId, {
      headRevision: revision,
      generation,
      segmentPath: segmentPath(chatId, generation),
      segmentStartRevision: revision,
      segmentEntries: 0,
      segmentBytes: 0,
      dirtySinceMs: null,
      lastAppendAtMs: null,
      tombstoned: false,
      manifestHealthy: true
    })
    baselineVerifiedChatIds.add(chatId)
    lastPersistedRevisionByChatId.set(chatId, revision)
  }

  const loadState = (chatId: string): RuntimeState => {
    assertChatId(chatId)
    const existing = states.get(chatId)
    if (existing) return existing
    const tombstoned = fs.existsSync(tombstonePath(chatId))
    let manifest: SegmentedChatManifest | null = null
    if (!tombstoned) {
      try {
        manifest = readManifest(chatId)
      } catch {
        manifest = null
      }
    }
    let snapshotRevision: number | null = null
    if (manifest?.snapshot) {
      try {
        const snapshot = readSnapshot(chatId)
        // Crash-after-snapshot adoption (compaction window): the snapshot
        // file may lead the manifest's recorded revision; the snapshot bytes
        // are the ground truth, and any older segments replay as duplicates.
        snapshotRevision = snapshot
          ? Math.max(snapshot.revision, manifest.persistenceRevision)
          : null
      } catch {
        snapshotRevision = null
      }
    }
    const headRevision = manifest ? (manifest.snapshot ? snapshotRevision : null) : null
    const generation = nextGeneration(chatId, manifest)
    let segmentEntries = 0
    let segmentBytes = 0
    let dirtySinceMs: number | null = null
    let lastAppendAtMs: number | null = null
    const ordered = orderedSegmentFileNames(chatId, manifest)
    if (ordered.length > 0) {
      const parsed = parseSegment(chatId, path.join(baseDir, ordered[ordered.length - 1]))
      segmentEntries = parsed.batches.length
      segmentBytes = parsed.bytes
      const firstSavedAt = parsed.batches[0]?.savedAt
      const lastSavedAt = parsed.batches.at(-1)?.savedAt
      const firstMs = firstSavedAt ? Date.parse(firstSavedAt) : Number.NaN
      const lastMs = lastSavedAt ? Date.parse(lastSavedAt) : Number.NaN
      dirtySinceMs = parsed.batches.length > 0 ? (Number.isFinite(firstMs) ? firstMs : now()) : null
      lastAppendAtMs = parsed.batches.length > 0 ? (Number.isFinite(lastMs) ? lastMs : now()) : null
    }
    const state: RuntimeState = {
      headRevision,
      generation,
      segmentPath: segmentPath(chatId, generation),
      segmentStartRevision: headRevision ?? 0,
      segmentEntries,
      segmentBytes,
      dirtySinceMs,
      lastAppendAtMs,
      tombstoned,
      manifestHealthy: manifest !== null
    }
    states.set(chatId, state)
    return state
  }

  const ensureBaseline = (chatId: string, previous: ChatRecord): void => {
    if (baselineVerifiedChatIds.has(chatId)) {
      const state = states.get(chatId)
      // A read that observed a corrupt manifest invalidated the baseline; the
      // verified marker alone can no longer vouch for the durable head.
      if (state && !state.manifestHealthy) {
        publishSnapshot(chatId, previous)
        baselineRepairs += 1
        return
      }
      // The verified marker does not prove the segment head by itself: a
      // legacy write that bypassed the mirror (flag-off window, Host queue
      // direct write, erasure truncation) can advance the authoritative
      // record between two mirror saves. One in-memory revision compare
      // re-anchors the baseline without a disk read.
      if (lastPersistedRevisionByChatId.get(chatId) !== recordRevision(previous)) {
        publishSnapshot(chatId, previous)
        baselineRepairs += 1
      }
      return
    }
    const state = loadState(chatId)
    if (state.headRevision === null || state.headRevision !== recordRevision(previous)) {
      publishSnapshot(chatId, previous)
      baselineRepairs += 1
      return
    }
    baselineVerifiedChatIds.add(chatId)
    lastPersistedRevisionByChatId.set(chatId, recordRevision(previous))
  }

  const rotate = (chatId: string, state: RuntimeState): void => {
    let stat: fs.Stats | null = null
    try {
      stat = fs.statSync(state.segmentPath)
    } catch {
      stat = null
    }
    if (stat && stat.size > 0) {
      const manifest = readManifest(chatId) ?? freshManifest(chatId)
      const ref: SegmentedChatSegmentRef = {
        fileName: path.basename(state.segmentPath),
        generation: state.generation,
        startRevision: state.segmentStartRevision,
        endRevision: state.headRevision ?? state.segmentStartRevision,
        bytes: stat.size,
        sha256: sha256Hex(state.segmentPath)
      }
      manifest.segments.push(ref)
      manifest.persistenceRevision = state.headRevision ?? manifest.persistenceRevision
      manifest.updatedAt = new Date(now()).toISOString()
      writeManifest(chatId, manifest)
      segmentRotations += 1
    }
    state.generation += 1
    state.segmentPath = segmentPath(chatId, state.generation)
    state.segmentStartRevision = state.headRevision ?? state.segmentStartRevision
    state.segmentEntries = 0
    state.segmentBytes = 0
  }

  const miss = (): null => {
    readMisses += 1
    return null
  }

  const mirrorSave = (
    previous: ChatRecord | null,
    next: ChatRecord,
    authoredTranscript?: AuthoredChatTranscriptMutation
  ): SegmentedChatMirrorResult | null => {
    if (!enabled()) return null
    if (!canWrite()) throw new Error('Segmented chat store is read-only')
    try {
      mirrorSaves += 1
      const chatId = next.appChatId
      assertChatId(chatId)
      if (!previous || previous.appChatId !== chatId) {
        publishSnapshot(chatId, next)
        seeds += 1
        return { seeded: true, mutationBytes: 0 }
      }
      ensureBaseline(chatId, previous)
      const derived = deriveChatRecordMutationWithProjection(
        previous,
        next,
        authoredTranscript ? { authoredTranscript } : {}
      )
      const { batch } = derived
      const state = states.get(chatId)
      if (!state) throw new Error(`Chat store v2 has no state for ${chatId}`)
      if (state.segmentEntries >= maxSegmentEntries || state.segmentBytes >= maxSegmentBytes) {
        rotate(chatId, state)
      }
      const line = `${JSON.stringify(batch)}\n`
      const bytes = appendLine(state.segmentPath, line)
      state.headRevision = batch.revision
      state.segmentEntries += 1
      state.segmentBytes += bytes
      state.dirtySinceMs ??= now()
      state.lastAppendAtMs = now()
      mutationBatchesAppended += 1
      mutationBytesAppended += bytes
      lastPersistedRevisionByChatId.set(chatId, batch.revision)
      return { seeded: false, mutationBytes: bytes }
    } catch (error) {
      failures += 1
      // The legacy path may still advance after this sideband failure. Force
      // the next mirror to re-establish its baseline instead of retrying
      // forever against a segment head that is now behind.
      baselineVerifiedChatIds.delete(next.appChatId)
      lastPersistedRevisionByChatId.delete(next.appChatId)
      console.error('[chat-store-v2] mirror failed', error)
      throw error
    }
  }

  const quarantineSegment = (chatId: string, fileName: string, reason: string): void => {
    if (!canRepair()) return
    const source = path.join(baseDir, fileName)
    let number = 1
    try {
      for (const entry of fs.readdirSync(baseDir)) {
        const match = new RegExp(`^${chatId}\\.quarantine-(\\d+)\\.jsonl$`).exec(entry)
        if (match) number = Math.max(number, Number(match[1]) + 1)
      }
    } catch {
      /* empty dir scan */
    }
    const target = path.join(baseDir, `${chatId}.quarantine-${number}.jsonl`)
    fs.renameSync(source, target)
    fsyncDirectory()
    const manifest = readManifest(chatId)
    if (manifest) {
      manifest.segments = manifest.segments.filter((ref) => ref.fileName !== fileName)
      manifest.quarantined.push({ fileName: path.basename(target), reason })
      manifest.updatedAt = new Date(now()).toISOString()
      writeManifest(chatId, manifest)
    }
    quarantinedSegments += 1
  }

  const readFull = (chatId: string): SegmentedChatReadResult | null => {
    if (!enabled()) return null
    assertChatId(chatId)
    readAttempts += 1
    try {
      if (fs.existsSync(tombstonePath(chatId))) return null
      const manifest = readManifest(chatId)
      if (!manifest) return miss()
      const snapshot = readSnapshot(chatId)
      if (!snapshot) return miss()
      let revision = snapshot.revision
      let record = cloneRecord(snapshot.record)
      let appliedBatches = 0
      let skippedDuplicateBatches = 0
      let malformedTailSkipsThisRead = 0
      let quarantinedThisRead = 0
      const ordered = orderedSegmentFileNames(chatId, manifest)
      for (let index = 0; index < ordered.length; index += 1) {
        const parsed = parseSegment(chatId, path.join(baseDir, ordered[index]))
        const isLast = index === ordered.length - 1
        let stopped = false
        for (const batch of parsed.batches) {
          const head = revision
          if (batch.revision <= head) {
            skippedDuplicateBatches += 1
            continue
          }
          if (batch.baseRevision !== head) {
            // Revision gap: superseded/orphaned remainder. Never merge across
            // versions silently (ADR §5.3); stop applying this and later
            // segments — the legacy dual-read side decides authority.
            stopped = true
            break
          }
          record = applyChatRecordMutation(record, batch)
          revision = batch.revision
          appliedBatches += 1
        }
        if (stopped) break
        if (parsed.torn) {
          if (isLast) {
            // Truncated final line: skip the tail, retain prior good records.
            malformedTailSkips += 1
            malformedTailSkipsThisRead += 1
          } else {
            // Corrupt closed segment: isolate for forensics, load only the
            // earlier good segments.
            try {
              quarantineSegment(chatId, ordered[index], 'corrupt segment line')
              quarantinedThisRead += 1
            } catch (quarantineError) {
              console.error(
                `[chat-store-v2] failed to quarantine segment ${ordered[index]} for ${chatId}`,
                quarantineError
              )
            }
            break
          }
        }
      }
      readHits += 1
      return {
        record,
        revision,
        appliedBatches,
        skippedDuplicateBatches,
        malformedTailSkips: malformedTailSkipsThisRead,
        quarantinedThisRead
      }
    } catch (error) {
      // Mark the baseline unhealthy so the next mirror re-anchors instead of
      // appending behind a manifest the read just proved unreadable.
      const state = states.get(chatId)
      if (state) state.manifestHealthy = false
      console.error(
        `[chat-store-v2] read failed for ${chatId}; failing closed to the legacy record`,
        error
      )
      return miss()
    }
  }

  const prefersV2 = (chatId: string): boolean => {
    if (!enabled()) return false
    try {
      if (fs.existsSync(tombstonePath(chatId))) return false
      const manifest = readManifest(chatId)
      if (!manifest || !manifest.snapshot) return false
      return fs.existsSync(snapshotPath(chatId))
    } catch {
      return false
    }
  }

  const replaceAuthoritative = (chatId: string, record: ChatRecord): void => {
    publishSnapshot(chatId, record)
  }

  const checkpoint = (chatId: string): boolean => {
    if (!enabled()) return false
    assertWritable()
    assertChatId(chatId)
    const read = readFull(chatId)
    if (!read) return false
    const snapshot = writeSnapshot(chatId, read.record, read.revision)
    const manifest = readManifest(chatId) ?? freshManifest(chatId)
    const compactionGeneration = manifest.compactionGeneration + 1
    const archives = [...manifest.archives]
    let archiveNumber = 1
    for (const entry of archives) {
      const match = new RegExp(`^${chatId}\\.archive-(\\d+)\\.jsonl$`).exec(entry.fileName)
      if (match) archiveNumber = Math.max(archiveNumber, Number(match[1]) + 1)
    }
    const segmentNames = orderedSegmentFileNames(chatId, manifest)
    for (const fileName of segmentNames) {
      const target = path.join(baseDir, `${chatId}.archive-${archiveNumber}.jsonl`)
      archiveNumber += 1
      fs.renameSync(path.join(baseDir, fileName), target)
      fsyncDirectory()
      let bytes = 0
      try {
        bytes = fs.statSync(target).size
      } catch {
        bytes = 0
      }
      archives.push({
        fileName: path.basename(target),
        bytes,
        sha256: sha256Hex(target)
      })
    }
    const nextManifest: SegmentedChatManifest = {
      format: CHAT_STORE_V2_MANIFEST_FORMAT,
      version: CHAT_STORE_V2_MANIFEST_VERSION,
      chatId,
      authority: 'v1',
      persistenceRevision: read.revision,
      compactionGeneration,
      snapshot,
      segments: [],
      archives,
      quarantined: manifest.quarantined,
      updatedAt: new Date(now()).toISOString()
    }
    writeManifest(chatId, nextManifest)
    states.set(chatId, {
      headRevision: read.revision,
      generation: nextGeneration(chatId, nextManifest),
      segmentPath: segmentPath(chatId, nextGeneration(chatId, nextManifest)),
      segmentStartRevision: read.revision,
      segmentEntries: 0,
      segmentBytes: 0,
      dirtySinceMs: null,
      lastAppendAtMs: null,
      tombstoned: false,
      manifestHealthy: true
    })
    compactions += 1
    return true
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
      for (const marker of ['.manifest.json', '.snapshot.json', '.tombstone']) {
        if (!entry.endsWith(marker)) continue
        const chatId = entry.slice(0, -marker.length)
        if (CHAT_ID_PATTERN.test(chatId)) ids.add(chatId)
      }
      const segmentMatch = /^(.+?)\.segment-(\d+)\.jsonl$/.exec(entry)
      if (segmentMatch && CHAT_ID_PATTERN.test(segmentMatch[1])) ids.add(segmentMatch[1])
    }
    return ids
  }

  const checkpointIdle = (nowMs = now()): number => {
    if (!enabled()) return 0
    assertWritable()
    let count = 0
    for (const chatId of knownChatIds()) {
      const state = loadState(chatId)
      if (state.tombstoned || state.segmentEntries === 0) continue
      if (
        state.lastAppendAtMs !== null &&
        state.dirtySinceMs !== null &&
        (nowMs - state.lastAppendAtMs >= idleCompactionMs ||
          nowMs - state.dirtySinceMs >= idleCompactionMs)
      ) {
        if (checkpoint(chatId)) count += 1
      }
    }
    return count
  }

  const checkpointAll = (): number => {
    if (!enabled()) return 0
    assertWritable()
    let count = 0
    for (const chatId of knownChatIds()) {
      const state = loadState(chatId)
      if (state.tombstoned || state.segmentEntries === 0) continue
      if (checkpoint(chatId)) count += 1
    }
    return count
  }

  const purge = (chatId: string): void => {
    assertWritable()
    assertChatId(chatId)
    for (const filePath of [manifestPath(chatId), snapshotPath(chatId), tombstonePath(chatId)]) {
      try {
        fs.unlinkSync(filePath)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    removeTranscriptSegments(chatId)
    states.delete(chatId)
    baselineVerifiedChatIds.delete(chatId)
    lastPersistedRevisionByChatId.delete(chatId)
    purges += 1
  }

  const clear = (): void => {
    assertWritable()
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
    baselineVerifiedChatIds.clear()
    lastPersistedRevisionByChatId.clear()
    clears += 1
  }

  const stats = (): SegmentedChatStoreStats => ({
    seeds,
    mirrorSaves,
    mutationBatchesAppended,
    mutationBytesAppended,
    baselineRepairs,
    segmentRotations,
    compactions,
    purges,
    clears,
    readAttempts,
    readHits,
    readMisses,
    malformedTailSkips,
    quarantinedSegments,
    failures
  })

  return {
    mirrorSave,
    readFull,
    prefersV2,
    replaceAuthoritative,
    checkpoint,
    checkpointIdle,
    checkpointAll,
    purge,
    clear,
    stats
  }
}
