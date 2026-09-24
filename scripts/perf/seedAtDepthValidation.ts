import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChatJournal, type ChatJournalStats } from '../../src/main/store/chatJournal'
import { deriveChatRecordMutation } from '../../src/main/store/ChatRecordMutation'
import { createIncrementalChatJournal } from '../../src/main/store/IncrementalChatJournal'
import type { ChatMessage, ChatRecord } from '../../src/main/store/types'

const require = createRequire(import.meta.url)
const { FIXTURE_GENERATOR_VERSION, generatePerfFixture } = require('./fixtureGenerator.cjs')

/** Production compact trigger in chatJournal.ts — duplicated so the pin is a field. */
export const SNAPSHOT_BYTE_THRESHOLD_BYTES = 16 * 1024 * 1024

/**
 * Generator flags used for the diagnostic 27k-depth measurement.
 * `lean: true` is load-bearing provenance: this is NOT the evidentiary launch
 * shape (non-lean, ~45.17 MiB). Both clear 16 MiB; the figures are not interchangeable.
 */
export const DIAGNOSTIC_GENERATOR_FLAGS = Object.freeze({
  workload: 'large_history' as const,
  seed: 42,
  lean: true,
  scaleDown: 1
})

/** Seeded-tail cumulative CHAT_JOURNAL_STAT_FIELDS may not be cited. */
export const SEEDED_PREFIX_NOT_COMPARABLE = 'seeded_prefix_not_comparable' as const

/** Last-save fields that may be compared. bytesWritten is descriptive only. */
export const PER_SAVE_EQUALITY_FIELDS = ['appends', 'linesWritten', 'snapshotsWritten'] as const

export const PER_SAVE_DESCRIPTIVE_FIELDS = ['bytesWritten'] as const

export const UNDER_THRESHOLD_MESSAGE_COUNT = 8
export const ABOVE_THRESHOLD_CONSTRUCTION_SAVES = 3
export const INFEASIBLE_CONSTRUCTION_WALK_SAVES = 27_000

/** Stable ISO length so journal-line arithmetic does not depend on Date.now(). */
const PINNED_SAVED_AT = '2026-09-18T00:00:00.000Z'

export function journalLineBytes(record: ChatRecord): number {
  return Buffer.byteLength(JSON.stringify({ savedAt: PINNED_SAVED_AT, record }) + '\n', 'utf8')
}

/** Smallest save count that trips the 16 MiB byte ceiling. */
export function constructionSavesToTripByteThreshold(record: ChatRecord): number {
  const line = journalLineBytes(record)
  if (line <= 0) throw new Error('journal line bytes must be positive')
  return Math.floor(SNAPSHOT_BYTE_THRESHOLD_BYTES / line) + 1
}

const CHAT_JOURNAL_SOURCE = fileURLToPath(
  new URL('../../src/main/store/chatJournal.ts', import.meta.url)
)

export type PerSaveDelta = {
  appends: number
  linesWritten: number
  snapshotsWritten: number
  bytesWritten: number
}

export type CumulativeJournalStats = Pick<
  ChatJournalStats,
  'appends' | 'linesWritten' | 'snapshotsWritten' | 'bytesWritten'
>

export type ChatJournalRegimeReport = {
  recordBytes: number
  journalLineBytes: number
  exceedsSnapshotByteThreshold: boolean
  messages: number
  accumulatedRuns: number
  linkedRoundIds: number
  activeRuns: number
  construction: {
    saves: number
    lastSaveDelta: PerSaveDelta
    cumulative: CumulativeJournalStats
  }
  seededTail: {
    lastSaveDelta: PerSaveDelta
    cumulative: typeof SEEDED_PREFIX_NOT_COMPARABLE
  }
  perSaveLastEqual: boolean
}

export type PersistBarrierReport = {
  checkpointsWritten: number
  checkpointBytes: number
  mutationBytesWritten: number
  tailOperationTypes: string[]
  checkpointRuns: number
  checkpointLinkedRoundIds: number
  checkpointActiveRuns: number
}

export type SeedAtDepthValidationReport = {
  generatorFlags: {
    workload: 'large_history'
    seed: number
    lean: true
    scaleDown: number
  }
  fixtureGeneratorVersion: number
  evidentiaryLaunchMustBeNonLean: true
  snapshotByteThresholdBytes: number
  aboveThreshold: ChatJournalRegimeReport
  belowThreshold: ChatJournalRegimeReport
  persistBarrier: PersistBarrierReport
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function toPersistedRecord(chat: ChatRecord & { _perfMeta?: unknown }): ChatRecord {
  const { _perfMeta: _ignored, ...persisted } = chat
  void _ignored
  return persisted as ChatRecord
}

function recordBytesOf(record: ChatRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

function observeRuns(record: ChatRecord): {
  accumulatedRuns: number
  linkedRoundIds: number
  activeRuns: number
} {
  const runs = record.runs ?? []
  return {
    accumulatedRuns: runs.length,
    linkedRoundIds: new Set(runs.map((run) => run.ensembleRoundId)).size,
    activeRuns: runs.filter((run) => run.status === 'running').length
  }
}

function pickCumulative(stats: ChatJournalStats): CumulativeJournalStats {
  return {
    appends: stats.appends,
    linesWritten: stats.linesWritten,
    snapshotsWritten: stats.snapshotsWritten,
    bytesWritten: stats.bytesWritten
  }
}

function deltaStats(before: ChatJournalStats, after: ChatJournalStats): PerSaveDelta {
  return {
    appends: after.appends - before.appends,
    linesWritten: after.linesWritten - before.linesWritten,
    snapshotsWritten: after.snapshotsWritten - before.snapshotsWritten,
    bytesWritten: after.bytesWritten - before.bytesWritten
  }
}

export function perSaveLastEqual(left: PerSaveDelta, right: PerSaveDelta): boolean {
  return PER_SAVE_EQUALITY_FIELDS.every((field) => left[field] === right[field])
}

function withBoundedTail(record: ChatRecord): ChatRecord {
  const next = cloneRecord(record)
  const tail: ChatMessage = {
    id: `${record.appChatId}-m-tail`,
    role: 'user',
    content: 'T',
    timestamp: new Date(Number(record.updatedAt) + 1000).toISOString()
  }
  next.messages = [...record.messages, tail]
  next.updatedAt = Number(record.updatedAt) + 1000
  next.persistenceRevision = (record.persistenceRevision ?? 1) + 1
  return next
}

function shrinkMessages(record: ChatRecord, messageCount: number): ChatRecord {
  const next = cloneRecord(record)
  next.messages = record.messages.slice(0, messageCount)
  return next
}

function measureChatJournalRegime(options: {
  record: ChatRecord
  constructionSaves: number
  root: string
  label: string
}): ChatJournalRegimeReport {
  const { record, constructionSaves, root, label } = options
  const tailed = withBoundedTail(record)
  const constructionDir = join(root, `${label}-construction`)
  const seededDir = join(root, `${label}-seeded`)
  const construction = createChatJournal(constructionDir)
  const seeded = createChatJournal(seededDir)

  let constructionBeforeLast = construction.stats()
  for (let i = 0; i < constructionSaves; i += 1) {
    constructionBeforeLast = construction.stats()
    construction.append(record.appChatId, record)
  }
  const constructionLast = deltaStats(constructionBeforeLast, construction.stats())

  seeded.append(record.appChatId, record)
  const afterSeed = seeded.stats()
  seeded.append(record.appChatId, tailed)
  const seededLast = deltaStats(afterSeed, seeded.stats())

  const bytes = recordBytesOf(record)
  const lineBytes = journalLineBytes(record)
  const runs = observeRuns(record)
  return {
    recordBytes: bytes,
    journalLineBytes: lineBytes,
    exceedsSnapshotByteThreshold: bytes > SNAPSHOT_BYTE_THRESHOLD_BYTES,
    messages: record.messages.length,
    accumulatedRuns: runs.accumulatedRuns,
    linkedRoundIds: runs.linkedRoundIds,
    activeRuns: runs.activeRuns,
    construction: {
      saves: constructionSaves,
      lastSaveDelta: constructionLast,
      cumulative: pickCumulative(construction.stats())
    },
    seededTail: {
      lastSaveDelta: seededLast,
      cumulative: SEEDED_PREFIX_NOT_COMPARABLE
    },
    perSaveLastEqual: perSaveLastEqual(constructionLast, seededLast)
  }
}

function measurePersistBarrier(record: ChatRecord, root: string): PersistBarrierReport {
  const dir = join(root, 'persist-barrier')
  const journal = createIncrementalChatJournal(dir)
  const tailed = withBoundedTail(record)
  const batch = deriveChatRecordMutation(record, tailed)
  journal.initialize(record.appChatId, record)
  const afterSeed = journal.stats()
  journal.append(batch)
  const afterTail = journal.stats()
  const checkpointPath = join(dir, `${record.appChatId}.checkpoint.json`)
  const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as {
    record: ChatRecord
  }
  const checkpointRuns = observeRuns(checkpoint.record)
  return {
    checkpointsWritten: afterSeed.checkpointsWritten,
    checkpointBytes: afterSeed.checkpointBytesWritten,
    mutationBytesWritten: afterTail.mutationBytesWritten - afterSeed.mutationBytesWritten,
    tailOperationTypes: batch.operations.map((operation) => operation.type),
    checkpointRuns: checkpointRuns.accumulatedRuns,
    checkpointLinkedRoundIds: checkpointRuns.linkedRoundIds,
    checkpointActiveRuns: checkpointRuns.activeRuns
  }
}

export function productionSnapshotByteThresholdSourcePin(): string {
  return readFileSync(CHAT_JOURNAL_SOURCE, 'utf8')
}

let cachedReport: SeedAtDepthValidationReport | undefined

export function resetSeedAtDepthValidationCacheForTests(): void {
  cachedReport = undefined
}

export function runSeedAtDepthValidation(): SeedAtDepthValidationReport {
  if (cachedReport) return cachedReport

  const root = mkdtempSync(join(tmpdir(), 'seed-at-depth-'))
  try {
    const fixture = generatePerfFixture({ ...DIAGNOSTIC_GENERATOR_FLAGS })
    const seeded = toPersistedRecord(fixture.chats[0])
    const underThreshold = shrinkMessages(seeded, UNDER_THRESHOLD_MESSAGE_COUNT)
    const belowConstructionSaves = constructionSavesToTripByteThreshold(underThreshold)
    if (belowConstructionSaves <= 2) {
      throw new Error(
        'under-threshold control is invalid: seed+1 would also trip SNAPSHOT_BYTE_THRESHOLD'
      )
    }

    cachedReport = {
      generatorFlags: {
        workload: DIAGNOSTIC_GENERATOR_FLAGS.workload,
        seed: DIAGNOSTIC_GENERATOR_FLAGS.seed,
        lean: DIAGNOSTIC_GENERATOR_FLAGS.lean,
        scaleDown: DIAGNOSTIC_GENERATOR_FLAGS.scaleDown
      },
      fixtureGeneratorVersion: FIXTURE_GENERATOR_VERSION,
      evidentiaryLaunchMustBeNonLean: true,
      snapshotByteThresholdBytes: SNAPSHOT_BYTE_THRESHOLD_BYTES,
      aboveThreshold: measureChatJournalRegime({
        record: seeded,
        constructionSaves: ABOVE_THRESHOLD_CONSTRUCTION_SAVES,
        root,
        label: 'above'
      }),
      belowThreshold: measureChatJournalRegime({
        record: underThreshold,
        constructionSaves: belowConstructionSaves,
        root,
        label: 'below'
      }),
      persistBarrier: measurePersistBarrier(seeded, root)
    }
    return cachedReport
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
