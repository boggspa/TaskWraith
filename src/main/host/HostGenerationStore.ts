/**
 * Durable Host generation + cursor position store (Host Arc Wave 2A).
 *
 * Crash-safe bounded journal + checkpoint under an injected data directory.
 * Generation is bumped on discontinuity/reset; cursor is strictly monotonic
 * only within a single generation. Reopen recovers generation, last cursor,
 * and explicit recovery warnings without inventing missing state.
 *
 * Uses Host protocol position types narrowly. Does not own delta payloads,
 * receipts, control server, or composition-root wiring.
 */

import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import type { HostCursor, HostCursorPosition, HostGeneration } from '../../shared/hostProtocol'

export const HOST_GENERATION_STORE_SCHEMA_VERSION = 1 as const
export const HOST_GENERATION_CHECKPOINT_FILENAME = 'host-generation.checkpoint.json'
export const HOST_GENERATION_JOURNAL_FILENAME = 'host-generation.journal.jsonl'

export const DEFAULT_HOST_GENERATION_COMPACT_AFTER_RECORDS = 64

export type HostGenerationRecoveryState =
  | 'clean'
  | 'recovered-truncated-tail'
  | 'recovered-corrupt-interior'
  | 'degraded-checkpoint'

export interface HostGenerationState extends HostCursorPosition {
  schemaVersion: typeof HOST_GENERATION_STORE_SCHEMA_VERSION
  updatedAt: string
  /** Durable reason for the most recent generation reset, if any. */
  lastResetReason?: string
  recoveryState: HostGenerationRecoveryState
  recoveryWarnings: string[]
}

export interface HostGenerationStoreOptions {
  /** Injected Host data directory. Required — no Electron app path lookup. */
  dataDir: string
  compactAfterRecords?: number
  /** Initial generation when no durable state exists. Defaults to 1. */
  initialGeneration?: HostGeneration
  now?: () => string
  log?: (line: string) => void
}

interface CheckpointDocument {
  schemaVersion: typeof HOST_GENERATION_STORE_SCHEMA_VERSION
  updatedAt: string
  generation: HostGeneration
  cursor: HostCursor
  lastResetReason?: string
}

type JournalEvent =
  | {
      op: 'advance'
      generation: HostGeneration
      previousCursor: HostCursor
      cursor: HostCursor
      at: string
    }
  | {
      op: 'reset'
      previousGeneration: HostGeneration
      generation: HostGeneration
      reason?: string
      at: string
    }
  | {
      op: 'seed'
      generation: HostGeneration
      cursor: HostCursor
      at: string
    }

export type HostGenerationAdvanceResult =
  | { kind: 'advanced'; state: HostGenerationState }
  | {
      kind: 'rejected'
      reason: 'generation_mismatch' | 'previous_cursor_mismatch'
      state: HostGenerationState
    }

export type HostGenerationResetResult = { kind: 'reset'; state: HostGenerationState }

export class HostGenerationStore {
  private readonly dataDir: string
  private readonly checkpointPath: string
  private readonly journalPath: string
  private readonly compactAfterRecords: number
  private readonly initialGeneration: HostGeneration
  private readonly now: () => string
  private readonly log: (line: string) => void

  private generation: HostGeneration = 1
  private cursor: HostCursor = 0
  private lastResetReason?: string
  private recoveryState: HostGenerationRecoveryState = 'clean'
  private recoveryWarnings: string[] = []
  private journalRecordCount = 0
  private seeded = false

  constructor(options: HostGenerationStoreOptions) {
    if (!options.dataDir || typeof options.dataDir !== 'string') {
      throw new Error('HostGenerationStore requires an injected dataDir')
    }
    this.dataDir = options.dataDir
    this.checkpointPath = join(this.dataDir, HOST_GENERATION_CHECKPOINT_FILENAME)
    this.journalPath = join(this.dataDir, HOST_GENERATION_JOURNAL_FILENAME)
    this.compactAfterRecords = Math.max(
      1,
      options.compactAfterRecords ?? DEFAULT_HOST_GENERATION_COMPACT_AFTER_RECORDS
    )
    this.initialGeneration = Math.max(1, Math.floor(options.initialGeneration ?? 1))
    this.now = options.now ?? (() => new Date().toISOString())
    this.log = options.log ?? (() => {})
    this.reopen()
  }

  /** Re-read checkpoint + journal from disk. Truncated tails do not invent state. */
  reopen(): void {
    this.generation = this.initialGeneration
    this.cursor = 0
    this.lastResetReason = undefined
    this.recoveryState = 'clean'
    this.recoveryWarnings = []
    this.journalRecordCount = 0
    this.seeded = false

    const checkpoint = this.readCheckpoint()
    if (checkpoint) {
      this.generation = checkpoint.generation
      this.cursor = checkpoint.cursor
      this.lastResetReason = checkpoint.lastResetReason
      this.seeded = true
    }

    const journal = this.readJournal()
    for (const event of journal.events) {
      this.journalRecordCount += 1
      this.applyJournalEvent(event)
      this.seeded = true
    }

    if (journal.truncatedTail) {
      this.noteRecovery('recovered-truncated-tail', 'dropped truncated journal tail')
    }
    if (journal.corruptInterior) {
      this.noteRecovery('recovered-corrupt-interior', 'skipped corrupt interior journal record(s)')
    }
    if (checkpoint === null && (existsSync(this.checkpointPath) || journal.degradedCheckpoint)) {
      this.noteRecovery(
        'degraded-checkpoint',
        'checkpoint missing or unreadable; rebuilt from journal when present'
      )
    }

    if (!this.seeded) {
      // First open: durable seed so restart observes the same initial position.
      const at = this.now()
      this.appendJournalEvent({
        op: 'seed',
        generation: this.generation,
        cursor: this.cursor,
        at
      })
      this.seeded = true
      this.maybeCompact()
    }
  }

  getState(): HostGenerationState {
    return {
      schemaVersion: HOST_GENERATION_STORE_SCHEMA_VERSION,
      generation: this.generation,
      cursor: this.cursor,
      updatedAt: this.now(),
      ...(this.lastResetReason ? { lastResetReason: this.lastResetReason } : {}),
      recoveryState: this.recoveryState,
      recoveryWarnings: [...this.recoveryWarnings]
    }
  }

  getPosition(): HostCursorPosition {
    return { generation: this.generation, cursor: this.cursor }
  }

  /**
   * Advance cursor by exactly one within the current generation.
   * Callers must supply the expected previous cursor (and generation) so a
   * stale writer cannot invent a discontinuous chain.
   */
  advance(expected: HostCursorPosition): HostGenerationAdvanceResult {
    const generation = assertNonNegativeInt(expected.generation, 'generation')
    const previousCursor = assertNonNegativeInt(expected.cursor, 'cursor')

    if (generation !== this.generation) {
      return {
        kind: 'rejected',
        reason: 'generation_mismatch',
        state: this.getState()
      }
    }
    if (previousCursor !== this.cursor) {
      return {
        kind: 'rejected',
        reason: 'previous_cursor_mismatch',
        state: this.getState()
      }
    }

    const nextCursor = this.cursor + 1
    const at = this.now()
    this.cursor = nextCursor
    this.appendJournalEvent({
      op: 'advance',
      generation: this.generation,
      previousCursor,
      cursor: nextCursor,
      at
    })
    this.maybeCompact()
    return { kind: 'advanced', state: this.getState() }
  }

  /**
   * Durable generation discontinuity: bump generation, reset cursor to 0.
   * Cursor is not monotonic across this boundary.
   */
  resetGeneration(reason?: string): HostGenerationResetResult {
    const previousGeneration = this.generation
    const nextGeneration = this.generation + 1
    const at = this.now()
    this.generation = nextGeneration
    this.cursor = 0
    this.lastResetReason = reason ? truncateText(reason, 500) : undefined
    this.appendJournalEvent({
      op: 'reset',
      previousGeneration,
      generation: nextGeneration,
      ...(this.lastResetReason ? { reason: this.lastResetReason } : {}),
      at
    })
    this.maybeCompact()
    return { kind: 'reset', state: this.getState() }
  }

  /** Force compaction of journal into checkpoint. */
  compact(): void {
    this.writeCheckpointAndResetJournal()
  }

  private applyJournalEvent(event: JournalEvent): void {
    if (event.op === 'seed') {
      this.generation = event.generation
      this.cursor = event.cursor
      return
    }
    if (event.op === 'advance') {
      // Only apply if it continues the recovered chain; skip inventing gaps.
      if (event.generation === this.generation && event.previousCursor === this.cursor) {
        this.cursor = event.cursor
      } else if (event.generation === this.generation && event.cursor === this.cursor) {
        // Exact duplicate advance — idempotent no-op.
      } else {
        this.log(
          `[HostGenerationStore] skipped discontinuous advance gen=${event.generation} cursor=${event.cursor}`
        )
        this.noteRecovery(
          'recovered-corrupt-interior',
          `skipped discontinuous advance at cursor ${event.cursor}`
        )
      }
      return
    }
    if (event.op === 'reset') {
      this.generation = event.generation
      this.cursor = 0
      this.lastResetReason = event.reason
    }
  }

  private noteRecovery(state: HostGenerationRecoveryState, warning: string): void {
    if (this.recoveryState === 'clean' || severity(state) >= severity(this.recoveryState)) {
      this.recoveryState = state
    }
    if (!this.recoveryWarnings.includes(warning)) {
      this.recoveryWarnings.push(warning)
    }
    this.log(`[HostGenerationStore] ${warning}`)
  }

  private maybeCompact(): void {
    if (this.journalRecordCount >= this.compactAfterRecords) {
      this.writeCheckpointAndResetJournal()
    }
  }

  private writeCheckpointAndResetJournal(): void {
    const doc: CheckpointDocument = {
      schemaVersion: HOST_GENERATION_STORE_SCHEMA_VERSION,
      updatedAt: this.now(),
      generation: this.generation,
      cursor: this.cursor,
      ...(this.lastResetReason ? { lastResetReason: this.lastResetReason } : {})
    }

    mkdirSync(this.dataDir, { recursive: true })
    const tmpPath = `${this.checkpointPath}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(tmpPath, `${JSON.stringify(doc)}\n`, { encoding: 'utf8', mode: 0o600 })
    const fd = openSync(tmpPath, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmpPath, this.checkpointPath)

    try {
      if (existsSync(this.journalPath)) {
        unlinkSync(this.journalPath)
      }
    } catch (err) {
      this.log(
        `[HostGenerationStore] journal reset failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    this.journalRecordCount = 0
  }

  private appendJournalEvent(event: JournalEvent): void {
    mkdirSync(this.dataDir, { recursive: true })
    const line = `${JSON.stringify(event)}\n`
    const descriptor = openSync(this.journalPath, 'a', 0o600)
    try {
      appendFileSync(descriptor, line, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    this.journalRecordCount += 1
  }

  private readCheckpoint(): CheckpointDocument | null {
    if (!existsSync(this.checkpointPath)) return null
    try {
      const raw = readFileSync(this.checkpointPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.log('[HostGenerationStore] checkpoint malformed (not an object)')
        return null
      }
      const doc = parsed as Partial<CheckpointDocument>
      if (doc.schemaVersion !== HOST_GENERATION_STORE_SCHEMA_VERSION) {
        this.log('[HostGenerationStore] checkpoint schema mismatch')
        return null
      }
      if (!isNonNegativeInt(doc.generation) || !isNonNegativeInt(doc.cursor)) {
        this.log('[HostGenerationStore] checkpoint generation/cursor invalid')
        return null
      }
      if (doc.generation < 1) {
        this.log('[HostGenerationStore] checkpoint generation below 1')
        return null
      }
      return {
        schemaVersion: HOST_GENERATION_STORE_SCHEMA_VERSION,
        updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : this.now(),
        generation: doc.generation,
        cursor: doc.cursor,
        ...(typeof doc.lastResetReason === 'string'
          ? { lastResetReason: truncateText(doc.lastResetReason, 500) }
          : {})
      }
    } catch (err) {
      this.log(
        `[HostGenerationStore] checkpoint load failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return null
    }
  }

  private readJournal(): {
    events: JournalEvent[]
    truncatedTail: boolean
    corruptInterior: boolean
    degradedCheckpoint: boolean
  } {
    if (!existsSync(this.journalPath)) {
      return { events: [], truncatedTail: false, corruptInterior: false, degradedCheckpoint: false }
    }
    let source: string
    try {
      source = readFileSync(this.journalPath, 'utf8')
    } catch (err) {
      this.log(
        `[HostGenerationStore] journal read failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return { events: [], truncatedTail: false, corruptInterior: false, degradedCheckpoint: true }
    }

    const events: JournalEvent[] = []
    let truncatedTail = false
    let corruptInterior = false
    const lines = source.split('\n')
    const endsWithNewline = source.endsWith('\n')
    const lastContentIndex = endsWithNewline ? lines.length - 2 : lines.length - 1

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line) continue
      try {
        const event = parseJournalEvent(line)
        if (event) events.push(event)
        else corruptInterior = true
      } catch {
        if (index === lastContentIndex && !endsWithNewline) {
          truncatedTail = true
          break
        }
        corruptInterior = true
        this.log(`[HostGenerationStore] skipped corrupt journal line at index ${index}`)
      }
    }
    return { events, truncatedTail, corruptInterior, degradedCheckpoint: false }
  }
}

function severity(state: HostGenerationRecoveryState): number {
  switch (state) {
    case 'clean':
      return 0
    case 'recovered-truncated-tail':
      return 1
    case 'recovered-corrupt-interior':
      return 2
    case 'degraded-checkpoint':
      return 3
    default:
      return 0
  }
}

function parseJournalEvent(line: string): JournalEvent | null {
  const parsed: unknown = JSON.parse(line)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const value = parsed as Record<string, unknown>
  if (value.op === 'seed') {
    if (!isNonNegativeInt(value.generation) || !isNonNegativeInt(value.cursor)) return null
    if (value.generation < 1) return null
    return {
      op: 'seed',
      generation: value.generation,
      cursor: value.cursor,
      at: typeof value.at === 'string' ? value.at : ''
    }
  }
  if (value.op === 'advance') {
    if (
      !isNonNegativeInt(value.generation) ||
      !isNonNegativeInt(value.previousCursor) ||
      !isNonNegativeInt(value.cursor)
    ) {
      return null
    }
    return {
      op: 'advance',
      generation: value.generation,
      previousCursor: value.previousCursor,
      cursor: value.cursor,
      at: typeof value.at === 'string' ? value.at : ''
    }
  }
  if (value.op === 'reset') {
    if (!isNonNegativeInt(value.previousGeneration) || !isNonNegativeInt(value.generation)) {
      return null
    }
    if (value.generation < 1) return null
    return {
      op: 'reset',
      previousGeneration: value.previousGeneration,
      generation: value.generation,
      ...(typeof value.reason === 'string' ? { reason: truncateText(value.reason, 500) } : {}),
      at: typeof value.at === 'string' ? value.at : ''
    }
  }
  return null
}

function isNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && Number.isFinite(value)
  )
}

function assertNonNegativeInt(value: number, field: string): number {
  if (!isNonNegativeInt(value)) {
    throw new Error(`HostGenerationStore: ${field} must be a non-negative integer`)
  }
  return value
}

function truncateText(value: string, max: number): string {
  const trimmed = String(value).trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max)
}
