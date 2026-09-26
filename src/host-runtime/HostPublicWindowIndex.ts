/**
 * The public window over thread record models (Independent Threads M4,
 * slice 5).
 *
 * Runs and rounds are published through global windows of 1,800 rows, and a
 * round lists only its member runs inside the run window. One thread's record
 * cannot decide either, so the transactional persist needs one authority that
 * holds every thread's model and answers for the capped families. This module
 * is that authority's specification: from the models of every thread, the
 * five families the profile projection derives from records (threads, runs,
 * rounds, participants and their warnings), exactly as the donor builds them
 * once its catalogue window has settled.
 *
 * - Runs: every thread's candidates merged in the catalogue's order, the first
 *   1,800.
 * - Rounds: every thread's round; past 1,800, live rounds first, then the most
 *   recent, then the round id. A round carries its seats' run ids and its
 *   member runs inside the run window.
 * - Threads: a thread's row names its round only while that round is running
 *   and inside the round window.
 * - Warnings: omitted participants, and the windowed rounds and runs.
 *
 * Wired since slice 12 (the transaction) and 13c (the feeder); incremental
 * since slice 13d.
 */

import {
  HOST_PROTOCOL_MAX_COLLECTION,
  HOST_WARNING_PROJECTION_WINDOWED,
  type HostWarningProjection
} from '../shared/hostProtocol'
import type { HostDomainEffectDto } from './HostDomainDeltaPublisher'
import {
  HOST_PROFILE_ROUND_PROJECTION_LIMIT,
  HOST_PROFILE_RUN_PROJECTION_LIMIT,
  type HostProfileDomainSnapshotFamilies
} from './HostProfileDomainProjection'
import {
  diffHostEntityFamily,
  hostProjectionUnchanged,
  hostSnapshotEntityId
} from './HostSnapshotDomainEffectDiff'
import {
  hostProjectionRowsOmittedWarning,
  hostProjectionTruncatedWarning,
  inspectHostSnapshotPrivacy,
  projectHostSnapshotRow,
  type HostRecordDerivedFamily
} from './HostSnapshotProjector'
import {
  compareHostThreadRecordRuns,
  hostThreadRecordRoundRow,
  hostThreadRecordThreadRow,
  type HostThreadRecordModelled,
  type HostThreadRecordParticipants,
  type HostThreadRecordRound,
  type HostThreadRecordRunCandidate,
  type HostThreadRecordThreadRow
} from './HostThreadRecordEffectModel'

/** The families the profile projection derives from thread records. */
export type HostPublicWindowFamilies = Pick<
  HostProfileDomainSnapshotFamilies,
  'threads' | 'runs' | 'rounds' | 'participants' | 'warnings'
>

export interface HostPublicRunWindowEntry {
  readonly threadId: string
  readonly candidate: HostThreadRecordRunCandidate
}

interface MergeHead {
  readonly threadId: string
  readonly candidates: readonly HostThreadRecordRunCandidate[]
  index: number
}

function headBefore(left: MergeHead, right: MergeHead): boolean {
  const a = left.candidates[left.index]!
  const b = right.candidates[right.index]!
  return (
    compareHostThreadRecordRuns(
      { threadId: left.threadId, rank: a.rank, ordinal: a.ordinal },
      { threadId: right.threadId, rank: b.rank, ordinal: b.ordinal }
    ) < 0
  )
}

/**
 * The run window: every thread's candidates merged in the catalogue's order,
 * at most `limit`. Each model's candidates are already in that order, so this
 * is a heap merge over the threads' heads.
 */
export function hostPublicRunWindow(
  models: readonly HostThreadRecordModelled[],
  limit: number = HOST_PROFILE_RUN_PROJECTION_LIMIT
): HostPublicRunWindowEntry[] {
  const heap: MergeHead[] = []
  const push = (head: MergeHead): void => {
    heap.push(head)
    let child = heap.length - 1
    while (child > 0) {
      const parent = (child - 1) >> 1
      if (!headBefore(heap[child]!, heap[parent]!)) break
      ;[heap[child], heap[parent]] = [heap[parent]!, heap[child]!]
      child = parent
    }
  }
  const pop = (): MergeHead => {
    const top = heap[0]!
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      let parent = 0
      for (;;) {
        const left = parent * 2 + 1
        const right = left + 1
        let first = parent
        if (left < heap.length && headBefore(heap[left]!, heap[first]!)) first = left
        if (right < heap.length && headBefore(heap[right]!, heap[first]!)) first = right
        if (first === parent) break
        ;[heap[parent], heap[first]] = [heap[first]!, heap[parent]!]
        parent = first
      }
    }
    return top
  }
  for (const model of models) {
    if (model.runs.candidates.length > 0) {
      push({ threadId: model.threadId, candidates: model.runs.candidates, index: 0 })
    }
  }
  const window: HostPublicRunWindowEntry[] = []
  while (window.length < limit && heap.length > 0) {
    const head = pop()
    window.push({ threadId: head.threadId, candidate: head.candidates[head.index]! })
    head.index += 1
    if (head.index < head.candidates.length) push(head)
  }
  return window
}

/**
 * The five record-derived families from every thread's model, in the
 * profile projection's order: threads, participants and (up to the window)
 * rounds in thread order, runs in window order. `complete` is false while a
 * thread's candidates are not all known, as a window still loading.
 */
export function assembleHostPublicWindowFamilies(
  models: readonly HostThreadRecordModelled[],
  options: { readonly complete?: boolean } = {}
): HostPublicWindowFamilies {
  return assembleFromWindow(models, hostPublicRunWindow(models), options.complete ?? true)
}

function assembleFromWindow(
  models: readonly HostThreadRecordModelled[],
  window: readonly HostPublicRunWindowEntry[],
  complete: boolean
): HostPublicWindowFamilies {
  const windowed = new Map<string, Set<string>>()
  for (const entry of window) {
    const runIds = windowed.get(entry.threadId) ?? new Set<string>()
    runIds.add(entry.candidate.runId)
    windowed.set(entry.threadId, runIds)
  }
  const rounds = models.flatMap((model) => {
    if (!model.round) return []
    const inWindow = windowed.get(model.threadId)
    const members = inWindow
      ? model.runs.candidates
          .filter((candidate) => candidate.roundMember && inWindow.has(candidate.runId))
          .map((candidate) => candidate.runId)
      : []
    return [{ model, round: model.round, row: hostThreadRecordRoundRow(model.round, members) }]
  })

  const warnings: HostWarningProjection[] = []
  const omitted = models.reduce((count, model) => count + model.participants.omitted, 0)
  if (omitted > 0) {
    warnings.push({
      warningId: 'projection_rows_omitted:participants',
      severity: 'warning',
      code: 'projection_rows_omitted',
      message: `family participants omitted ${omitted} decoder-invalid row${omitted === 1 ? '' : 's'}`,
      at: models.reduce((latest, model) => Math.max(latest, model.participants.warningAt), 0)
    })
  }
  let selected = rounds
  if (rounds.length > HOST_PROFILE_ROUND_PROJECTION_LIMIT) {
    selected = [...rounds]
      .sort((left, right) => {
        if (left.round.live !== right.round.live) return left.round.live ? -1 : 1
        if (left.round.recency !== right.round.recency) {
          return right.round.recency - left.round.recency
        }
        return left.row.roundId.localeCompare(right.row.roundId)
      })
      .slice(0, HOST_PROFILE_ROUND_PROJECTION_LIMIT)
    warnings.push({
      warningId: `${HOST_WARNING_PROJECTION_WINDOWED}:rounds`,
      severity: 'warning',
      code: HOST_WARNING_PROJECTION_WINDOWED,
      message:
        `family rounds intentionally windowed from ${rounds.length} to ` +
        `${HOST_PROFILE_ROUND_PROJECTION_LIMIT}; live rows precede recent terminal rows`,
      at: rounds.reduce((latest, entry) => Math.max(latest, entry.round.recency), 0)
    })
  }
  const total = models.reduce((count, model) => count + model.runs.total, 0)
  if (!complete || total > HOST_PROFILE_RUN_PROJECTION_LIMIT) {
    warnings.push({
      warningId: `${HOST_WARNING_PROJECTION_WINDOWED}:runs`,
      severity: 'warning',
      code: HOST_WARNING_PROJECTION_WINDOWED,
      message:
        `family runs ${complete ? 'intentionally windowed' : 'still loading'} from ${total} to ` +
        `${HOST_PROFILE_RUN_PROJECTION_LIMIT}; possibly-live rows precede recent terminal rows`,
      at: window.reduce((latest, entry) => Math.max(latest, entry.candidate.recency), 0)
    })
  }
  const included = new Set(selected.map((entry) => entry.model.threadId))
  return {
    threads: models.map((model) => hostThreadRecordThreadRow(model, included.has(model.threadId))),
    runs: window.map((entry) => entry.candidate.row),
    rounds: selected.map((entry) => entry.row),
    participants: models.flatMap((model) => [...model.participants.rows]),
    warnings
  }
}

// ── the index ───────────────────────────────────────────────────────────────

/**
 * Run candidates the index keeps past the run window, across every thread
 * (slice 13d; it was 128 per thread). A change that frees more slots than
 * the kept candidates can fill leaves the window short until the thread
 * holding the first dropped candidate is modelled again.
 */
export const HOST_PUBLIC_WINDOW_BAND = HOST_PROFILE_RUN_PROJECTION_LIMIT

/** The code of the warning that counts rows the index withheld. */
export const HOST_WARNING_PROJECTION_WITHHELD = 'projection_rows_withheld'

const OWNED_DELTA_FAMILIES: ReadonlySet<string> = new Set(['thread', 'run', 'round', 'participant'])
const OWNED_WARNING_FAMILIES: ReadonlySet<string> = new Set([
  'threads',
  'runs',
  'rounds',
  'participants',
  'warnings'
])

/**
 * Whether an effect belongs to the index once it publishes (slice 13f2):
 * every row of the four record-derived families, and every warning the
 * index or the projector raises for the five families, whose id ends with
 * `:<family>`. Legacy captures and the reconciler drop these after the
 * switch; the index's groups are their only publisher.
 */
export function hostPublicWindowOwnsEffect(family: string, entityId: string): boolean {
  if (OWNED_DELTA_FAMILIES.has(family)) return true
  if (family !== 'warning') return false
  const separator = entityId.lastIndexOf(':')
  return separator >= 0 && OWNED_WARNING_FAMILIES.has(entityId.slice(separator + 1))
}

/** A thread's model, read from its committed record. */
export interface HostPublicWindowModelChange {
  readonly kind: 'model'
  readonly model: HostThreadRecordModelled
}

/**
 * A committed delete. It is final for the incarnation, as the scope ledger
 * closes the thread's lane: nothing for the thread lands after it.
 */
export interface HostPublicWindowDeleteChange {
  readonly kind: 'delete'
  readonly threadId: string
}

/**
 * A thread modelled again to fill a short window (slice 13e): its committed
 * file read in the worker. It lands only at the revision the index holds
 * (SF-3), so it can never roll a thread forward past a persist still
 * publishing, or back.
 */
export interface HostPublicWindowRefillChange {
  readonly kind: 'refill'
  readonly model: HostThreadRecordModelled
}

export type HostPublicWindowChange =
  | HostPublicWindowModelChange
  | HostPublicWindowDeleteChange
  | HostPublicWindowRefillChange

export interface HostPublicWindowPublication {
  /** The publication's time: the `at` of the index's own warnings. */
  readonly generatedAt: string
}

/**
 * A change the index set aside: a model older than the one it holds,
 * anything for a thread deleted in this incarnation, or a refill at any
 * revision but the one it holds.
 */
export interface HostPublicWindowIgnored {
  readonly threadId: string
  readonly reason: 'older' | 'deleted' | 'stale-refill'
}

/**
 * Prepared changes: their effects against what the index last published,
 * held until the caller commits them (once their group is durable) or
 * aborts. Nothing published changes until `commit()`, and no other
 * transaction can be prepared while this one is open.
 */
export interface HostPublicWindowTransaction {
  /** Wire effects for the record-derived families, in the snapshot diff's order. */
  readonly effects: readonly HostDomainEffectDto[]
  /** False while the run window is short of runs it should hold. */
  readonly complete: boolean
  /** Threads whose kept candidates ran out: model each again to fill the window. */
  readonly refill: readonly string[]
  readonly ignored: readonly HostPublicWindowIgnored[]
  commit(): void
  abort(): void
}

/** Published wire rows by delta family and entity id. */
export type HostPublicWindowWire = ReadonlyMap<
  HostPublicWindowDeltaFamily,
  ReadonlyMap<string, unknown>
>

/** What the index holds: for the bench and the band bound. */
export interface HostPublicWindowDiagnostics {
  readonly threads: number
  /** Run candidates kept across every thread: at most 1,800 plus the band. */
  readonly keptRuns: number
  /** Threads with candidates the index dropped. */
  readonly trimmedThreads: number
}

type HostPublicWindowDeltaFamily = 'thread' | 'run' | 'round' | 'participant' | 'warning'

/** The projector's family and the delta family, in the projector's and the diff's order. */
const WIRE_FAMILIES: readonly (readonly [HostRecordDerivedFamily, HostPublicWindowDeltaFamily])[] =
  [
    ['threads', 'thread'],
    ['runs', 'run'],
    ['rounds', 'round'],
    ['participants', 'participant'],
    ['warnings', 'warning']
  ]

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function projectorAt(generatedAt: string): number {
  const parsed = Date.parse(generatedAt)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
}

/** The warning that counts a family's rows the index withheld. */
export function hostPublicRowsWithheldWarning(
  family: string,
  count: number,
  at: number
): HostWarningProjection {
  return {
    warningId: `${HOST_WARNING_PROJECTION_WITHHELD}:${family}`,
    severity: 'warning',
    code: HOST_WARNING_PROJECTION_WITHHELD,
    message: `family ${family} withheld ${count} row${count === 1 ? '' : 's'} no snapshot can carry`,
    at
  }
}

/**
 * The thread a run, round or participant row belongs to. Thread rows are one
 * per thread and warnings the index's own, so neither can share an id.
 */
function rowThreadId(row: object): string {
  const value = (row as { threadId?: unknown }).threadId
  return typeof value === 'string' ? value : ''
}

/**
 * A run's place in the catalogue order. The thread id is held as its UTF-8
 * bytes, one char per byte, so plain string order is SQLite's BINARY order
 * and no comparison allocates.
 */
interface RunPlace {
  readonly active: 0 | 1
  readonly recency: number
  readonly threadKey: string
  readonly ordinal: number
}

interface KeptRun extends RunPlace {
  readonly threadId: string
  /** The candidate; once kept, with its catalogue summary dropped. */
  readonly candidate: HostThreadRecordRunCandidate
}

function compareRunPlaces(left: RunPlace, right: RunPlace): number {
  if (left.active !== right.active) return left.active === 1 ? -1 : 1
  if (left.recency !== right.recency) return left.recency > right.recency ? -1 : 1
  if (left.threadKey !== right.threadKey) return left.threadKey < right.threadKey ? -1 : 1
  return left.ordinal - right.ordinal
}

function threadKeyOf(threadId: string): string {
  return Buffer.from(threadId, 'utf8').toString('latin1')
}

function placeOf(run: RunPlace): RunPlace {
  return {
    active: run.active,
    recency: run.recency,
    threadKey: run.threadKey,
    ordinal: run.ordinal
  }
}

/** The summary every kept candidate carries: the index never reads it. */
const DROPPED_SUMMARY: Readonly<Record<string, unknown>> = Object.freeze({})

/** A model's candidates as runs to merge; only those kept are copied (`keptCopy`). */
function keptRunsOf(model: HostThreadRecordModelled, threadKey: string): KeptRun[] {
  return model.runs.candidates.map((candidate) => ({
    threadId: model.threadId,
    threadKey,
    active: candidate.rank.active,
    recency: candidate.rank.recency,
    ordinal: candidate.ordinal,
    candidate
  }))
}

/** The run as kept: its candidate's catalogue summary dropped. */
function keptCopy(run: KeptRun): KeptRun {
  const candidate = run.candidate
  if (candidate.summary === DROPPED_SUMMARY || !('summary' in candidate)) return run
  if (candidate.summary === undefined) return run
  return { ...run, candidate: { ...candidate, summary: DROPPED_SUMMARY } }
}

/**
 * What the index keeps of a thread: never its catalogue projection, and its
 * run candidates only in the one kept array.
 */
interface ThreadEntry {
  readonly threadId: string
  readonly threadKey: string
  readonly revision: number
  readonly thread: HostThreadRecordThreadRow
  readonly round: HostThreadRecordRound | null
  readonly participants: HostThreadRecordParticipants
  readonly runsTotal: number
  /**
   * A model with fewer candidates than its share of the window: its unknown
   * runs rank after its last candidate, so nothing past that can be placed.
   */
  readonly cutFloor: RunPlace | null
  /** The first candidate the index dropped: nothing from it on can be placed. */
  readonly dropped: RunPlace | null
}

/** Whether a model holds fewer candidates than its thread's share of the window. */
function modelIsCut(model: HostThreadRecordModelled): boolean {
  return (
    model.runs.candidates.length < Math.min(model.runs.total, HOST_PROFILE_RUN_PROJECTION_LIMIT)
  )
}

function entryOf(model: HostThreadRecordModelled, threadKey: string): ThreadEntry {
  const revision = model.projection.revision
  const candidates = model.runs.candidates
  const last = candidates[candidates.length - 1]
  return {
    threadId: model.threadId,
    threadKey,
    revision,
    thread: model.thread,
    round: model.round,
    participants: model.participants,
    runsTotal: model.runs.total,
    cutFloor:
      last !== undefined && modelIsCut(model)
        ? {
            active: last.rank.active,
            recency: last.rank.recency,
            threadKey,
            ordinal: last.ordinal
          }
        : null,
    dropped: null
  }
}

/** Why a change is set aside, or null to apply it. */
function staleness(
  change: HostPublicWindowChange,
  held: ThreadEntry | undefined,
  deleted: boolean
): HostPublicWindowIgnored['reason'] | null {
  // A delete is final for the incarnation: a refill or a late model read
  // before it, or after it from a source that still lists the thread, never
  // brings the thread back.
  if (deleted) return 'deleted'
  if (change.kind === 'refill') {
    return held?.revision === change.model.projection.revision ? null : 'stale-refill'
  }
  if (
    change.kind === 'model' &&
    held !== undefined &&
    held.revision > change.model.projection.revision
  ) {
    return 'older'
  }
  return null
}

interface WireRow {
  /** The row as published, or null where the projector omits it. */
  readonly wire: unknown
  readonly privacyClean: boolean
  /** The row's entity id, or null where no diff can key it (or it is withheld or omitted). */
  readonly entityId: string | null
}

function buildWireRow(
  family: HostRecordDerivedFamily,
  deltaFamily: HostPublicWindowDeltaFamily,
  row: object
): WireRow {
  const wire = projectHostSnapshotRow(family, row)
  const privacyClean = inspectHostSnapshotPrivacy(row).ok
  let entityId: string | null = null
  if (privacyClean && wire !== null) {
    const identity = hostSnapshotEntityId(deltaFamily, wire)
    if (identity.ok) entityId = identity.entityId
  }
  return { wire, privacyClean, entityId }
}

interface SourcedRow {
  readonly row: WireRow
  /** The source row's own thread id: the tie-break between rows sharing an id. */
  readonly rowThreadId: string
}

/** A thread's rows in a capped family, as the projector counts them. */
interface Contribution {
  readonly omitted: number
  /** Rows the privacy scan refused, and rows no diff can key. */
  readonly withheld: number
  readonly rows: readonly { readonly entityId: string; readonly wire: unknown }[]
}

function contributionOf(rows: readonly SourcedRow[]): Contribution {
  let omitted = 0
  let withheld = 0
  const valid: { entityId: string; wire: unknown }[] = []
  for (const { row } of rows) {
    if (!row.privacyClean) withheld += 1
    else if (row.wire === null) omitted += 1
    else if (row.entityId === null) withheld += 1
    else valid.push({ entityId: row.entityId, wire: row.wire })
  }
  return { omitted, withheld, rows: valid }
}

/**
 * The projector over a family small enough to settle whole on every
 * prepare (runs, rounds, warnings): omitted, withheld and duplicate rows
 * counted, the rest by id with the lowest thread's row of a shared id, up to
 * the collection bound.
 */
function settleFamily(
  family: HostRecordDerivedFamily,
  rows: readonly SourcedRow[],
  at: number,
  own: HostWarningProjection[]
): { entityId: string; wire: unknown }[] {
  const valid: { entityId: string; threadId: string; wire: unknown }[] = []
  let omitted = 0
  let withheld = 0
  for (const { row, rowThreadId: owner } of rows) {
    if (!row.privacyClean) withheld += 1
    else if (row.wire === null) omitted += 1
    else if (row.entityId === null) withheld += 1
    else valid.push({ entityId: row.entityId, threadId: owner, wire: row.wire })
  }
  if (omitted > 0) own.push(hostProjectionRowsOmittedWarning(family, omitted, at))
  valid.sort(
    (left, right) =>
      compareIds(left.entityId, right.entityId) || compareIds(left.threadId, right.threadId)
  )
  const unique = valid.filter(
    (entry, index) => index === 0 || entry.entityId !== valid[index - 1]!.entityId
  )
  withheld += valid.length - unique.length
  if (withheld > 0) own.push(hostPublicRowsWithheldWarning(family, withheld, at))
  if (unique.length > HOST_PROTOCOL_MAX_COLLECTION) {
    own.push(hostProjectionTruncatedWarning(family, unique.length, at))
    unique.length = HOST_PROTOCOL_MAX_COLLECTION
  }
  return unique
}

/** The first index whose id sorts after `id`. */
function upperBound(ids: readonly string[], id: string): number {
  let low = 0
  let high = ids.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (ids[middle]! <= id) low = middle + 1
    else high = middle
  }
  return low
}

/** The first index whose id sorts at or after `id`. */
function lowerBound(ids: readonly string[], id: string): number {
  let low = 0
  let high = ids.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (ids[middle]! < id) low = middle + 1
    else high = middle
  }
  return low
}

type Journal = (undo: () => void) => void

/**
 * A row of an id. A participant's id carries its thread and a thread row
 * carries none, so rows sharing an id come from one thread, or (from models
 * no record gives) threads whose rows claim one id: the lower thread id wins,
 * where the donor fell back on the order threads were listed.
 */
interface Holder {
  readonly threadId: string
  readonly order: number
  readonly wire: unknown
}

function holderBefore(left: Holder, right: Holder): boolean {
  return (compareIds(left.threadId, right.threadId) || left.order - right.order) < 0
}

/**
 * A family with a row or more per thread and no window of its own (threads,
 * participants): kept as each thread's contribution, the rows of each id in
 * tie-break order, and the distinct ids sorted, so a change touches only its
 * own ids and those it moves across the collection bound.
 */
class CappedFamily {
  private readonly contributions = new Map<string, Contribution>()
  private readonly groups = new Map<string, Holder[]>()
  private ids: string[] = []
  private bulk = false
  omitted = 0
  withheld = 0
  duplicates = 0
  private readonly touched = new Set<string>()
  private boundaryBefore: string | null = null

  constructor(
    readonly family: HostRecordDerivedFamily,
    private readonly journal: Journal
  ) {}

  get distinct(): number {
    return this.ids.length
  }

  /** Start a prepare: what was published is the committed state. */
  begin(): void {
    this.touched.clear()
    this.boundaryBefore = this.boundary()
  }

  /** Add many threads to an empty family, sorting the ids once. */
  startBulk(): void {
    this.bulk = true
  }

  endBulk(): void {
    this.bulk = false
    this.ids.sort(compareIds)
  }

  set(threadId: string, next: Contribution | undefined): void {
    const prior = this.contributions.get(threadId)
    if (prior === next) return
    if (prior !== undefined) this.withdraw(threadId, prior)
    if (next === undefined) this.contributions.delete(threadId)
    else {
      this.contributions.set(threadId, next)
      this.add(threadId, next)
    }
    this.journal(() => this.set(threadId, prior))
  }

  /** The published rows, in id order: for a seed. */
  materialize(): Map<string, unknown> {
    const rows = new Map<string, unknown>()
    const count = Math.min(this.ids.length, HOST_PROTOCOL_MAX_COLLECTION)
    for (let index = 0; index < count; index += 1) {
      const id = this.ids[index]!
      rows.set(id, this.groups.get(id)![0]!.wire)
    }
    return rows
  }

  /**
   * The published rows that change: every touched id, and every id the
   * change moved across the collection bound, with its row after (or
   * undefined where it leaves).
   */
  changes(published: ReadonlyMap<string, unknown>): Map<string, unknown> {
    const after = this.boundary()
    const candidates = new Set(this.touched)
    const before = this.boundaryBefore
    if (before !== null || after !== null) {
      // An untouched id changes side only between the two boundaries.
      const low =
        before === null ? after! : after === null ? before : before < after ? before : after
      const high = before === null || after === null ? null : before < after ? after : before
      for (let index = upperBound(this.ids, low); index < this.ids.length; index += 1) {
        const id = this.ids[index]!
        if (high !== null && id > high) break
        candidates.add(id)
      }
    }
    const changes = new Map<string, unknown>()
    for (const id of candidates) {
      const group = this.groups.get(id)
      const next =
        group !== undefined && (after === null || id <= after) ? group[0]!.wire : undefined
      if (published.get(id) !== next) changes.set(id, next)
    }
    return changes
  }

  private boundary(): string | null {
    return this.ids.length > HOST_PROTOCOL_MAX_COLLECTION
      ? this.ids[HOST_PROTOCOL_MAX_COLLECTION - 1]!
      : null
  }

  private withdraw(threadId: string, contribution: Contribution): void {
    this.omitted -= contribution.omitted
    this.withheld -= contribution.withheld
    contribution.rows.forEach((row, order) => {
      const group = this.groups.get(row.entityId)!
      const at = group.findIndex((holder) => holder.threadId === threadId && holder.order === order)
      group.splice(at, 1)
      this.touched.add(row.entityId)
      if (group.length > 0) {
        this.duplicates -= 1
        return
      }
      this.groups.delete(row.entityId)
      this.ids.splice(lowerBound(this.ids, row.entityId), 1)
    })
  }

  private add(threadId: string, contribution: Contribution): void {
    this.omitted += contribution.omitted
    this.withheld += contribution.withheld
    contribution.rows.forEach((row, order) => {
      const holder: Holder = { threadId, order, wire: row.wire }
      this.touched.add(row.entityId)
      const group = this.groups.get(row.entityId)
      if (group === undefined) {
        this.groups.set(row.entityId, [holder])
        if (this.bulk) this.ids.push(row.entityId)
        else this.ids.splice(lowerBound(this.ids, row.entityId), 0, row.entityId)
        return
      }
      let at = group.length
      while (at > 0 && holderBefore(holder, group[at - 1]!)) at -= 1
      group.splice(at, 0, holder)
      this.duplicates += 1
    })
  }
}

/** The largest of a multiset of numbers, 0 when empty, as the donor's reduce from 0. */
class CountedMax {
  private readonly counts = new Map<number, number>()
  private cached: number | null = 0

  add(value: number): void {
    this.counts.set(value, (this.counts.get(value) ?? 0) + 1)
    if (this.cached !== null && value > this.cached) this.cached = value
  }

  remove(value: number): void {
    const count = this.counts.get(value)!
    if (count > 1) {
      this.counts.set(value, count - 1)
      return
    }
    this.counts.delete(value)
    if (value === this.cached) this.cached = null
  }

  value(): number {
    if (this.cached === null) {
      let latest = 0
      for (const value of this.counts.keys()) latest = Math.max(latest, value)
      this.cached = latest
    }
    return this.cached
  }
}

interface RoundSlot {
  readonly threadId: string
  readonly round: HostThreadRecordRound
}

const roundCollator = new Intl.Collator()

/**
 * The round window's order: live rounds first, then the most recent, then
 * the round id (`localeCompare`, as the donor), then the thread id where the
 * donor fell back on the order threads were listed.
 */
function compareRoundSlots(left: RoundSlot, right: RoundSlot): number {
  if (left.round.live !== right.round.live) return left.round.live ? -1 : 1
  if (left.round.recency !== right.round.recency) {
    return right.round.recency - left.round.recency
  }
  return (
    roundCollator.compare(left.round.roundId, right.round.roundId) ||
    compareIds(left.threadId, right.threadId)
  )
}

interface Scalars {
  runsTotal: number
  omittedParticipants: number
  /** Every kept run candidate, in catalogue order: at most 1,800 plus the band after a prepare. */
  kept: readonly KeptRun[]
  /** At or below every thread's first dropped candidate, while any thread has one. */
  trimFloor: RunPlace | null
}

type Updates = Map<HostPublicWindowDeltaFamily, Map<string, unknown>>

/**
 * The single authority for the families a thread record derives: it holds
 * every thread's model, the run and round windows over them, and the wire
 * rows it last published, and turns changes into the effects a
 * before-and-after snapshot diff would publish for those families.
 *
 * It never refuses. A change older than the model it holds, or for a thread
 * deleted in this incarnation, is set aside. A row no snapshot can carry is
 * withheld and counted: one that fails the privacy scan, one whose id no
 * diff can key, and all but the lowest thread's of rows sharing an id. The
 * index's own warnings (the projector's, and the withheld count) are
 * republished only when they change beyond their time. Snapshots of these
 * families are served from `wire()`, which never holds a withheld row.
 *
 * Since slice 13d a prepare costs what its changes touch, not what the
 * index holds: the run candidates are one array of at most 1,800 plus the
 * band, the threads and participants families are kept sorted by id, and
 * the rest (runs, rounds, warnings: 1,800 rows at most) are settled whole
 * from cached rows. A prepare mutates under an undo journal; abort replays
 * it.
 */
export class HostPublicWindowIndex {
  private entries = new Map<string, ThreadEntry>()
  private readonly deleted = new Set<string>()
  private readonly threadKeys = new Map<string, string>()
  private published = new Map<HostPublicWindowDeltaFamily, Map<string, unknown>>(
    WIRE_FAMILIES.map(([, family]) => [family, new Map<string, unknown>()])
  )
  private view: HostPublicWindowWire | null = null
  private open: object | null = null
  private readonly keep: number
  private undo: (() => void)[] | null = null
  private readonly journal: Journal = (undo) => {
    this.undo?.push(undo)
  }

  private scalars: Scalars = { runsTotal: 0, omittedParticipants: 0, kept: [], trimFloor: null }
  /** Threads whose cut floor stands (a cut model none of whose candidates were dropped). */
  private cut = new Set<string>()
  private trimmedThreads = 0
  private roundOrder: RoundSlot[] = []
  private readonly roundSlots = new Map<string, RoundSlot>()
  private roundRecency = new CountedMax()
  private warningAt = new CountedMax()
  /** Threads whose round the committed round window holds. */
  private selected = new Set<string>()
  private threads = new CappedFamily('threads', this.journal)
  private participants = new CappedFamily('participants', this.journal)

  /** Run and participant rows, by the row. */
  private readonly rows = new WeakMap<object, WireRow>()
  /** Thread rows, by the model's thread row: without, and with, the round it names. */
  private readonly threadRows = new WeakMap<object, WireRow>()
  private readonly activeThreadRows = new WeakMap<
    object,
    { readonly activeRoundId: string; readonly row: WireRow }
  >()
  /** Round rows, by the model's round and the member runs the window gives it. */
  private readonly roundRows = new WeakMap<object, { members: string; row: WireRow }>()
  private readonly participantContributions = new WeakMap<object, Contribution>()

  constructor(options: { readonly band?: number } = {}) {
    const band = options.band ?? HOST_PUBLIC_WINDOW_BAND
    if (!Number.isSafeInteger(band) || band < 1) {
      throw new TypeError('HostPublicWindowIndex needs a band of at least one candidate')
    }
    this.keep = Math.min(HOST_PROFILE_RUN_PROJECTION_LIMIT + band, Number.MAX_SAFE_INTEGER)
  }

  /**
   * The wire rows the index last published, each family in id order: what a
   * snapshot of these families serves. A withheld row is never among them.
   */
  wire(): HostPublicWindowWire {
    if (this.view === null) {
      this.view = new Map(
        [...this.published].map(([family, rows]) => [
          family,
          new Map([...rows].sort(([left], [right]) => compareIds(left, right)))
        ])
      )
    }
    return this.view
  }

  diagnostics(): HostPublicWindowDiagnostics {
    return {
      threads: this.entries.size,
      keptRuns: this.scalars.kept.length,
      trimmedThreads: this.trimmedThreads
    }
  }

  /**
   * Replace every thread at once, publishing nothing: the state a client's
   * next snapshot starts from. A model with fewer candidates than its share
   * of the window counts as cut, and the window may start short. It forgets
   * no delete, and of two models of one thread keeps the newer: what it sets
   * aside it reports, as `prepare` does.
   */
  seed(
    models: readonly HostPublicWindowModelChange[],
    publication: HostPublicWindowPublication
  ): {
    readonly complete: boolean
    readonly refill: readonly string[]
    readonly ignored: readonly HostPublicWindowIgnored[]
  } {
    this.assertClosed()
    const accepted = new Map<string, HostThreadRecordModelled>()
    const revisions = new Map<string, ThreadEntry>()
    const ignored: HostPublicWindowIgnored[] = []
    for (const change of models) {
      const threadId = change.model.threadId
      const reason = staleness(change, revisions.get(threadId), this.deleted.has(threadId))
      if (reason !== null) {
        ignored.push({ threadId, reason })
        continue
      }
      accepted.set(threadId, change.model)
      revisions.set(threadId, entryOf(change.model, ''))
    }

    this.entries = new Map()
    this.scalars = { runsTotal: 0, omittedParticipants: 0, kept: [], trimFloor: null }
    this.cut = new Set()
    this.trimmedThreads = 0
    this.roundOrder = []
    this.roundSlots.clear()
    this.roundRecency = new CountedMax()
    this.warningAt = new CountedMax()
    this.selected = new Set()
    this.threads = new CappedFamily('threads', this.journal)
    this.participants = new CappedFamily('participants', this.journal)

    this.participants.startBulk()
    const slots: RoundSlot[] = []
    for (const [threadId, model] of accepted) {
      this.replaceThread(threadId, model, slots)
    }
    this.participants.endBulk()
    this.roundOrder = slots.sort(compareRoundSlots)
    this.rebuildKept(accepted)

    const settled = this.settle(new Set(accepted.keys()), publication, true)
    const published = this.published
    this.published = new Map(
      WIRE_FAMILIES.map(([, family]) => {
        if (family === 'thread') return [family, this.threads.materialize()]
        if (family === 'participant') return [family, this.participants.materialize()]
        const rows = new Map(published.get(family)!)
        for (const [id, row] of settled.updates.get(family)!) {
          if (row === undefined) rows.delete(id)
          else rows.set(id, row)
        }
        return [family, rows]
      })
    )
    this.selected = settled.selected
    this.view = null
    return { complete: settled.complete, refill: settled.refill, ignored }
  }

  /** Prepare changes, in order, as one transaction. */
  prepare(
    changes: readonly HostPublicWindowChange[],
    publication: HostPublicWindowPublication
  ): HostPublicWindowTransaction {
    this.assertClosed()
    const undo: (() => void)[] = []
    this.undo = undo
    this.threads.begin()
    this.participants.begin()
    let settled: ReturnType<HostPublicWindowIndex['settle']>
    const ignored: HostPublicWindowIgnored[] = []
    try {
      const changed = new Map<string, HostThreadRecordModelled | null>()
      for (const change of changes) {
        const threadId = change.kind === 'delete' ? change.threadId : change.model.threadId
        const reason = staleness(change, this.entries.get(threadId), this.deleted.has(threadId))
        if (reason !== null) {
          ignored.push({ threadId, reason })
          continue
        }
        if (change.kind !== 'delete') {
          this.replaceThread(threadId, change.model, null)
          changed.set(threadId, change.model)
        } else {
          this.replaceThread(threadId, null, null)
          this.deleted.add(threadId)
          this.journal(() => this.deleted.delete(threadId))
          changed.set(threadId, null)
        }
      }
      this.rebuildKept(changed)
      settled = this.settle(new Set(changed.keys()), publication, false)
    } catch (error) {
      this.undo = null
      this.rollback(undo)
      throw error
    }
    this.undo = null

    const effects: HostDomainEffectDto[] = []
    for (const [, family] of WIRE_FAMILIES) {
      const updates = settled.updates.get(family)!
      if (updates.size === 0) continue
      const published = this.published.get(family)!
      const before = new Map<string, unknown>()
      const after = new Map<string, unknown>()
      for (const [id, row] of updates) {
        const prior = published.get(id)
        if (prior !== undefined) before.set(id, prior)
        if (row !== undefined) after.set(id, row)
      }
      effects.push(...diffHostEntityFamily(family, before, after))
    }

    const token = {}
    this.open = token
    const settle = (): void => {
      if (this.open !== token) throw new Error('HostPublicWindowIndex transaction already settled')
      this.open = null
    }
    return {
      effects,
      complete: settled.complete,
      refill: settled.refill,
      ignored,
      commit: () => {
        settle()
        for (const [family, updates] of settled.updates) {
          const rows = this.published.get(family)!
          for (const [id, row] of updates) {
            if (row === undefined) rows.delete(id)
            else rows.set(id, row)
          }
        }
        this.selected = settled.selected
        this.view = null
      },
      abort: () => {
        settle()
        this.rollback(undo)
      }
    }
  }

  private assertClosed(): void {
    if (this.open !== null) throw new Error('HostPublicWindowIndex has a transaction open')
  }

  private rollback(undo: readonly (() => void)[]): void {
    for (let index = undo.length - 1; index >= 0; index -= 1) undo[index]!()
  }

  private assign<K extends keyof Scalars>(key: K, value: Scalars[K]): void {
    const prior = this.scalars[key]
    if (prior === value) return
    this.scalars[key] = value
    this.journal(() => {
      this.scalars[key] = prior
    })
  }

  private threadKey(threadId: string): string {
    let key = this.threadKeys.get(threadId)
    if (key === undefined) {
      key = threadKeyOf(threadId)
      this.threadKeys.set(threadId, key)
    }
    return key
  }

  private putEntry(threadId: string, entry: ThreadEntry | undefined): void {
    const prior = this.entries.get(threadId)
    if (prior === entry) return
    if (prior?.dropped) this.trimmedThreads -= 1
    if (entry?.dropped) this.trimmedThreads += 1
    if (entry === undefined) this.entries.delete(threadId)
    else this.entries.set(threadId, entry)
    if (entry !== undefined && entry.cutFloor !== null && entry.dropped === null) {
      this.cut.add(threadId)
    } else {
      this.cut.delete(threadId)
    }
    this.journal(() => this.putEntry(threadId, prior))
  }

  /** Put or take a thread's round in the round order; `bulk` collects them unsorted. */
  private putRound(
    threadId: string,
    round: HostThreadRecordRound | null,
    bulk: RoundSlot[] | null
  ): void {
    const prior = this.roundSlots.get(threadId)
    if (prior?.round === round || (prior === undefined && round === null)) return
    if (prior !== undefined) {
      this.roundSlots.delete(threadId)
      this.roundRecency.remove(prior.round.recency)
      let low = 0
      let high = this.roundOrder.length
      while (low < high) {
        const middle = (low + high) >> 1
        if (compareRoundSlots(this.roundOrder[middle]!, prior) < 0) low = middle + 1
        else high = middle
      }
      this.roundOrder.splice(low, 1)
    }
    if (round !== null) {
      const slot: RoundSlot = { threadId, round }
      this.roundSlots.set(threadId, slot)
      this.roundRecency.add(round.recency)
      if (bulk !== null) bulk.push(slot)
      else {
        let low = 0
        let high = this.roundOrder.length
        while (low < high) {
          const middle = (low + high) >> 1
          if (compareRoundSlots(this.roundOrder[middle]!, slot) < 0) low = middle + 1
          else high = middle
        }
        this.roundOrder.splice(low, 0, slot)
      }
    }
    this.journal(() => this.putRound(threadId, prior?.round ?? null, null))
  }

  private putWarningAt(prior: number | null, next: number | null): void {
    if (prior !== null) this.warningAt.remove(prior)
    if (next !== null) this.warningAt.add(next)
    this.journal(() => this.putWarningAt(next, prior))
  }

  /** Everything but the kept runs and the thread row: those wait for the window. */
  private replaceThread(
    threadId: string,
    model: HostThreadRecordModelled | null,
    bulkRounds: RoundSlot[] | null
  ): void {
    const prior = this.entries.get(threadId)
    const entry = model === null ? undefined : entryOf(model, this.threadKey(threadId))
    this.putRound(threadId, entry?.round ?? null, bulkRounds)
    this.assign(
      'runsTotal',
      this.scalars.runsTotal - (prior?.runsTotal ?? 0) + (entry?.runsTotal ?? 0)
    )
    this.assign(
      'omittedParticipants',
      this.scalars.omittedParticipants -
        (prior?.participants.omitted ?? 0) +
        (entry?.participants.omitted ?? 0)
    )
    this.putWarningAt(prior?.participants.warningAt ?? null, entry?.participants.warningAt ?? null)
    this.participants.set(
      threadId,
      entry === undefined ? undefined : this.participantContribution(entry.participants)
    )
    if (entry === undefined) this.threads.set(threadId, undefined)
    this.putEntry(threadId, entry)
  }

  /**
   * The kept candidates without the changed threads', merged with their new
   * ones, cut to 1,800 plus the band. Each thread the cut reaches records
   * its first dropped candidate.
   */
  private rebuildKept(changed: ReadonlyMap<string, HostThreadRecordModelled | null>): void {
    const kept = this.scalars.kept
    const base = changed.size === 0 ? kept : kept.filter((run) => !changed.has(run.threadId))
    const lists: { runs: readonly KeptRun[]; index: number; base: boolean }[] = []
    if (base.length > 0) lists.push({ runs: base, index: 0, base: true })
    for (const [threadId, model] of changed) {
      if (model === null || model.runs.candidates.length === 0) continue
      lists.push({ runs: keptRunsOf(model, this.threadKey(threadId)), index: 0, base: false })
    }

    const before = (
      left: { runs: readonly KeptRun[]; index: number },
      right: { runs: readonly KeptRun[]; index: number }
    ): boolean => compareRunPlaces(left.runs[left.index]!, right.runs[right.index]!) < 0
    const heap = lists.slice()
    const down = (start: number): void => {
      let parent = start
      for (;;) {
        const left = parent * 2 + 1
        const right = left + 1
        let first = parent
        if (left < heap.length && before(heap[left]!, heap[first]!)) first = left
        if (right < heap.length && before(heap[right]!, heap[first]!)) first = right
        if (first === parent) return
        ;[heap[parent], heap[first]] = [heap[first]!, heap[parent]!]
        parent = first
      }
    }
    for (let index = (heap.length >> 1) - 1; index >= 0; index -= 1) down(index)
    const next: KeptRun[] = []
    while (next.length < this.keep && heap.length > 0) {
      const head = heap[0]!
      next.push(head.base ? head.runs[head.index]! : keptCopy(head.runs[head.index]!))
      head.index += 1
      if (head.index >= head.runs.length) {
        const last = heap.pop()!
        if (heap.length === 0) break
        heap[0] = last
      }
      down(0)
    }

    const lowest: { place: RunPlace | null } = { place: null }
    const drop = (run: KeptRun): void => {
      const entry = this.entries.get(run.threadId)!
      if (entry.dropped !== null && compareRunPlaces(entry.dropped, run) <= 0) return
      const place = placeOf(run)
      this.putEntry(run.threadId, { ...entry, dropped: place })
      if (lowest.place === null || compareRunPlaces(place, lowest.place) < 0) lowest.place = place
    }
    for (const list of lists) {
      if (list.index >= list.runs.length) continue
      if (!list.base) {
        drop(list.runs[list.index]!)
        continue
      }
      const seen = new Set<string>()
      for (let index = list.index; index < list.runs.length; index += 1) {
        const run = list.runs[index]!
        if (seen.has(run.threadId)) continue
        seen.add(run.threadId)
        drop(run)
      }
    }
    this.assign('kept', next)
    if (lowest.place !== null) {
      const floor = this.scalars.trimFloor
      if (floor === null || compareRunPlaces(lowest.place, floor) < 0) {
        this.assign('trimFloor', lowest.place)
      }
    }
    if (this.trimmedThreads === 0 && this.scalars.trimFloor !== null) {
      this.assign('trimFloor', null)
    }
  }

  /** The thread holding the lowest dropped candidate: a scan, off the common path. */
  private lowestDropped(): { place: RunPlace; threadId: string } | null {
    let lowest: { place: RunPlace; threadId: string } | null = null
    for (const [threadId, entry] of this.entries) {
      if (entry.dropped === null) continue
      if (lowest === null || compareRunPlaces(entry.dropped, lowest.place) < 0) {
        lowest = { place: entry.dropped, threadId }
      }
    }
    return lowest
  }

  /**
   * The run window over the kept candidates. It stops, short, at the first
   * run past the lowest floor: a cut model's last candidate (exclusive) or a
   * dropped candidate (inclusive), naming that thread for refill.
   */
  private walk(): { window: KeptRun[]; exhausted: string | null } {
    let cut: { place: RunPlace; threadId: string } | null = null
    for (const threadId of this.cut) {
      const floor = this.entries.get(threadId)!.cutFloor!
      if (cut === null || compareRunPlaces(floor, cut.place) < 0) cut = { place: floor, threadId }
    }
    type Floor = { readonly place: RunPlace; readonly threadId: string }
    // The trimmed floors: a lower bound, made exact by one scan when a run reaches it.
    const trimmed: { bound: RunPlace | null; exact: Floor | null } = {
      bound: this.trimmedThreads > 0 ? this.scalars.trimFloor : null,
      exact: null
    }
    const exact = (): Floor => {
      if (trimmed.exact === null) {
        trimmed.exact = this.lowestDropped()!
        this.assign('trimFloor', trimmed.exact.place)
        trimmed.bound = trimmed.exact.place
      }
      return trimmed.exact
    }
    const window: KeptRun[] = []
    for (const run of this.scalars.kept) {
      if (window.length >= HOST_PROFILE_RUN_PROJECTION_LIMIT) break
      const pastCut = cut !== null && compareRunPlaces(run, cut.place) > 0
      const pastDropped =
        trimmed.bound !== null &&
        compareRunPlaces(run, trimmed.bound) >= 0 &&
        compareRunPlaces(run, exact().place) >= 0
      if (pastCut || pastDropped) {
        return {
          window,
          exhausted: this.lowerFloor(pastCut ? cut : null, pastDropped ? exact() : null)
        }
      }
      window.push(run)
    }
    if (window.length < HOST_PROFILE_RUN_PROJECTION_LIMIT) {
      const owner = this.lowerFloor(cut, this.trimmedThreads > 0 ? exact() : null)
      if (owner !== null) return { window, exhausted: owner }
    }
    return { window, exhausted: null }
  }

  private lowerFloor(
    cut: { place: RunPlace; threadId: string } | null,
    dropped: { place: RunPlace; threadId: string } | null
  ): string | null {
    if (cut === null) return dropped?.threadId ?? null
    if (dropped === null) return cut.threadId
    return compareRunPlaces(cut.place, dropped.place) <= 0 ? cut.threadId : dropped.threadId
  }

  /**
   * The window, the round window, and the published rows that change: the
   * threads the changes touched and those the round window moved.
   */
  private settle(
    changed: ReadonlySet<string>,
    publication: HostPublicWindowPublication,
    seeding: boolean
  ): {
    complete: boolean
    refill: readonly string[]
    selected: Set<string>
    updates: Updates
  } {
    const { window, exhausted } = this.walk()
    const complete = exhausted === null
    const at = projectorAt(publication.generatedAt)
    const own: HostWarningProjection[] = []
    const updates: Updates = new Map()

    // The round window, and the thread rows it names a round in.
    const rounds =
      this.roundOrder.length > HOST_PROFILE_ROUND_PROJECTION_LIMIT
        ? this.roundOrder.slice(0, HOST_PROFILE_ROUND_PROJECTION_LIMIT)
        : this.roundOrder
    const selected = new Set(rounds.map((slot) => slot.threadId))
    const rethread = new Set<string>()
    for (const threadId of changed) rethread.add(threadId)
    for (const threadId of selected) if (!this.selected.has(threadId)) rethread.add(threadId)
    for (const threadId of this.selected) if (!selected.has(threadId)) rethread.add(threadId)
    if (seeding) this.threads.startBulk()
    for (const threadId of rethread) {
      const entry = this.entries.get(threadId)
      if (entry === undefined) continue
      this.threads.set(threadId, this.threadContribution(entry, selected.has(threadId)))
    }
    if (seeding) this.threads.endBulk()

    // Threads.
    this.cappedWarnings(this.threads, at, own)
    if (!seeding) updates.set('thread', this.threads.changes(this.published.get('thread')!))

    // Runs, and the members each round carries.
    const members = new Map<string, string[]>()
    const runRows: SourcedRow[] = []
    let runsAt = 0
    for (const run of window) {
      const candidate = run.candidate
      runsAt = Math.max(runsAt, candidate.recency)
      if (candidate.roundMember) {
        const list = members.get(run.threadId)
        if (list === undefined) members.set(run.threadId, [candidate.runId])
        else list.push(candidate.runId)
      }
      let row = this.rows.get(candidate.row)
      if (row === undefined) {
        row = buildWireRow('runs', 'run', candidate.row)
        this.rows.set(candidate.row, row)
      }
      runRows.push({ row, rowThreadId: rowThreadId(candidate.row) })
    }
    updates.set('run', this.wholeFamily('run', settleFamily('runs', runRows, at, own)))

    // Rounds.
    const roundRows: SourcedRow[] = rounds.map((slot) => {
      const runIds = members.get(slot.threadId) ?? []
      const key = runIds.join('\u0000')
      const cached = this.roundRows.get(slot.round)
      if (cached && cached.members === key) {
        return { row: cached.row, rowThreadId: rowThreadId(slot.round.row) }
      }
      const source = hostThreadRecordRoundRow(slot.round, runIds)
      const row = buildWireRow('rounds', 'round', source)
      this.roundRows.set(slot.round, { members: key, row })
      return { row, rowThreadId: rowThreadId(source) }
    })
    updates.set('round', this.wholeFamily('round', settleFamily('rounds', roundRows, at, own)))

    // Participants.
    this.cappedWarnings(this.participants, at, own)
    if (!seeding) {
      updates.set('participant', this.participants.changes(this.published.get('participant')!))
    }

    // The donor's warnings, then the warnings family as the projector settles it.
    const donor: HostWarningProjection[] = []
    const omitted = this.scalars.omittedParticipants
    if (omitted > 0) {
      donor.push({
        warningId: 'projection_rows_omitted:participants',
        severity: 'warning',
        code: 'projection_rows_omitted',
        message: `family participants omitted ${omitted} decoder-invalid row${omitted === 1 ? '' : 's'}`,
        at: this.warningAt.value()
      })
    }
    if (this.roundOrder.length > HOST_PROFILE_ROUND_PROJECTION_LIMIT) {
      donor.push({
        warningId: `${HOST_WARNING_PROJECTION_WINDOWED}:rounds`,
        severity: 'warning',
        code: HOST_WARNING_PROJECTION_WINDOWED,
        message:
          `family rounds intentionally windowed from ${this.roundOrder.length} to ` +
          `${HOST_PROFILE_ROUND_PROJECTION_LIMIT}; live rows precede recent terminal rows`,
        at: this.roundRecency.value()
      })
    }
    const total = this.scalars.runsTotal
    if (!complete || total > HOST_PROFILE_RUN_PROJECTION_LIMIT) {
      donor.push({
        warningId: `${HOST_WARNING_PROJECTION_WINDOWED}:runs`,
        severity: 'warning',
        code: HOST_WARNING_PROJECTION_WINDOWED,
        message:
          `family runs ${complete ? 'intentionally windowed' : 'still loading'} from ${total} to ` +
          `${HOST_PROFILE_RUN_PROJECTION_LIMIT}; possibly-live rows precede recent terminal rows`,
        at: runsAt
      })
    }
    const donorRows = donor.map((warning) => ({
      row: buildWireRow('warnings', 'warning', warning),
      rowThreadId: rowThreadId(warning)
    }))
    const donorWarnings = settleFamily('warnings', donorRows, at, own).map(
      (entry) => entry.wire as HostWarningProjection
    )

    // Donor warnings and the index's own, in warning id order: at most three
    // donor warnings and three per family, far inside the projector's re-cap.
    // They never share an id: the one candidate, omitted participants, fails
    // the same decoder in the donor as in the projector.
    const warnings = new Map<string, unknown>(
      [...donorWarnings, ...own]
        .sort((left, right) => compareIds(left.warningId, right.warningId))
        .map((warning) => [warning.warningId, warning])
    )
    // The index's own warnings change only when they say something new: their
    // time is the publication's, not news.
    const priorWarnings = this.published.get('warning')!
    for (const warning of own) {
      const prior = priorWarnings.get(warning.warningId) as HostWarningProjection | undefined
      if (prior && hostProjectionUnchanged('warning', { ...prior, at: 0 }, { ...warning, at: 0 })) {
        warnings.set(warning.warningId, prior)
      }
    }
    updates.set('warning', this.wholeChanges('warning', warnings))

    return { complete, refill: exhausted === null ? [] : [exhausted], selected, updates }
  }

  private cappedWarnings(family: CappedFamily, at: number, own: HostWarningProjection[]): void {
    if (family.omitted > 0) {
      own.push(hostProjectionRowsOmittedWarning(family.family, family.omitted, at))
    }
    const withheld = family.withheld + family.duplicates
    if (withheld > 0) own.push(hostPublicRowsWithheldWarning(family.family, withheld, at))
    if (family.distinct > HOST_PROTOCOL_MAX_COLLECTION) {
      own.push(hostProjectionTruncatedWarning(family.family, family.distinct, at))
    }
  }

  private wholeFamily(
    family: HostPublicWindowDeltaFamily,
    unique: readonly { entityId: string; wire: unknown }[]
  ): Map<string, unknown> {
    return this.wholeChanges(family, new Map(unique.map((entry) => [entry.entityId, entry.wire])))
  }

  /** A family settled whole: its rows that differ from the published ones. */
  private wholeChanges(
    family: HostPublicWindowDeltaFamily,
    next: ReadonlyMap<string, unknown>
  ): Map<string, unknown> {
    const published = this.published.get(family)!
    const changes = new Map<string, unknown>()
    for (const [id, row] of next) if (published.get(id) !== row) changes.set(id, row)
    for (const id of published.keys()) if (!next.has(id)) changes.set(id, undefined)
    return changes
  }

  private threadContribution(entry: ThreadEntry, roundInWindow: boolean): Contribution {
    const round = entry.round
    if (roundInWindow && round?.live) {
      const cached = this.activeThreadRows.get(entry.thread)
      if (cached && cached.activeRoundId === round.roundId) {
        return contributionOf([{ row: cached.row, rowThreadId: rowThreadId(entry.thread) }])
      }
      const source = { ...entry.thread, activeRoundId: round.roundId }
      const row = buildWireRow('threads', 'thread', source)
      this.activeThreadRows.set(entry.thread, { activeRoundId: round.roundId, row })
      return contributionOf([{ row, rowThreadId: rowThreadId(source) }])
    }
    let row = this.threadRows.get(entry.thread)
    if (row === undefined) {
      row = buildWireRow('threads', 'thread', entry.thread)
      this.threadRows.set(entry.thread, row)
    }
    return contributionOf([{ row, rowThreadId: rowThreadId(entry.thread) }])
  }

  private participantContribution(participants: HostThreadRecordParticipants): Contribution {
    const cached = this.participantContributions.get(participants)
    if (cached) return cached
    const contribution = contributionOf(
      participants.rows.map((source) => {
        let row = this.rows.get(source)
        if (row === undefined) {
          row = buildWireRow('participants', 'participant', source)
          this.rows.set(source, row)
        }
        return { row, rowThreadId: rowThreadId(source) }
      })
    )
    this.participantContributions.set(participants, contribution)
    return contribution
  }
}
