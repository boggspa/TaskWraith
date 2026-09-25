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
 * Unwired in this slice.
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
  type HostThreadRecordRunCandidate
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
 * Candidates each thread keeps past its runs in the run window. A change that
 * frees more slots than a thread's band can fill leaves the window short until
 * that thread is modelled again.
 */
export const HOST_PUBLIC_WINDOW_BAND = 128

/** The code of the warning that counts rows the index withheld. */
export const HOST_WARNING_PROJECTION_WITHHELD = 'projection_rows_withheld'

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

export type HostPublicWindowChange = HostPublicWindowModelChange | HostPublicWindowDeleteChange

export interface HostPublicWindowPublication {
  /** The publication's time: the `at` of the index's own warnings. */
  readonly generatedAt: string
}

/**
 * A change the index set aside: a model older than the one it holds, or
 * anything for a thread deleted in this incarnation.
 */
export interface HostPublicWindowIgnored {
  readonly threadId: string
  readonly reason: 'older' | 'deleted'
}

/**
 * Prepared changes: their effects against what the index last published,
 * held until the caller commits them (once their group is durable) or
 * aborts. Nothing changes until `commit()`, and no other transaction can be
 * prepared while this one is open.
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

interface ThreadEntry {
  /** The thread's model, its candidates cut to those the index keeps. */
  readonly model: HostThreadRecordModelled
  /** Whether candidates past the kept ones exist. */
  readonly truncated: boolean
}

interface WireRow {
  /** The row as published, or null where the projector omits it. */
  readonly wire: unknown
  readonly privacyClean: boolean
}

interface Computed {
  readonly entries: Map<string, ThreadEntry>
  /** Every thread this incarnation deleted. */
  readonly deleted: Set<string>
  readonly window: readonly HostPublicRunWindowEntry[]
  readonly families: HostPublicWindowFamilies
  readonly wire: Map<HostPublicWindowDeltaFamily, Map<string, unknown>>
  readonly complete: boolean
  readonly refill: readonly string[]
}

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

/** Whether a model holds fewer candidates than its thread's share of the window. */
function modelIsCut(model: HostThreadRecordModelled): boolean {
  return (
    model.runs.candidates.length < Math.min(model.runs.total, HOST_PROFILE_RUN_PROJECTION_LIMIT)
  )
}

function entryOf(change: HostPublicWindowModelChange): ThreadEntry {
  return { model: change.model, truncated: modelIsCut(change.model) }
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
  if (
    change.kind === 'model' &&
    held !== undefined &&
    held.model.projection.revision > change.model.projection.revision
  ) {
    return 'older'
  }
  return null
}

/**
 * The thread a run, round or participant row belongs to. Thread rows are one
 * per thread and warnings the index's own, so neither can share an id.
 */
function rowThreadId(row: object): string {
  const value = (row as { threadId?: unknown }).threadId
  return typeof value === 'string' ? value : ''
}

/** The model with its candidates cut and their catalogue summaries dropped. */
function keptModel(
  model: HostThreadRecordModelled,
  candidates: readonly HostThreadRecordRunCandidate[]
): HostThreadRecordModelled {
  return {
    ...model,
    runs: {
      total: model.runs.total,
      candidates: candidates.map((candidate) =>
        'summary' in candidate && candidate.summary !== undefined
          ? { ...candidate, summary: {} }
          : candidate
      )
    }
  }
}

/**
 * The run window over the kept candidates. A thread whose kept candidates
 * are cut ranks its unknown runs below its last kept one, so once the merge
 * takes that run nothing after it can be placed: the window stops short and
 * the thread must be modelled again.
 */
function keptRunWindow(entries: ReadonlyMap<string, ThreadEntry>): {
  window: HostPublicRunWindowEntry[]
  exhausted: string | null
} {
  const models = [...entries.values()].map((entry) => entry.model)
  const window = hostPublicRunWindow(models)
  if (window.length === 0) return { window, exhausted: null }
  const taken = new Map<string, number>()
  for (let index = 0; index < window.length; index += 1) {
    const threadId = window[index]!.threadId
    const count = (taken.get(threadId) ?? 0) + 1
    taken.set(threadId, count)
    const entry = entries.get(threadId)!
    if (
      entry.truncated &&
      count === entry.model.runs.candidates.length &&
      index + 1 < HOST_PROFILE_RUN_PROJECTION_LIMIT
    ) {
      return { window: window.slice(0, index + 1), exhausted: threadId }
    }
  }
  return { window, exhausted: null }
}

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
 * Unwired in this slice.
 */
export class HostPublicWindowIndex {
  private entries = new Map<string, ThreadEntry>()
  private deleted = new Set<string>()
  private published = new Map<HostPublicWindowDeltaFamily, Map<string, unknown>>(
    WIRE_FAMILIES.map(([, family]) => [family, new Map<string, unknown>()])
  )
  private open: object | null = null
  private readonly band: number
  /** Run and participant rows, by the row. */
  private readonly rows = new WeakMap<object, WireRow>()
  /** Thread rows, by the model's thread row: without, and with, the round it names. */
  private readonly threadRows = new WeakMap<object, WireRow>()
  private readonly activeThreadRows = new WeakMap<
    object,
    { readonly activeRoundId: string; readonly row: WireRow }
  >()
  /** Round rows, by the model's round and the run ids the row carries. */
  private readonly roundRows = new WeakMap<object, { runIds: string; row: WireRow }>()

  constructor(options: { readonly band?: number } = {}) {
    const band = options.band ?? HOST_PUBLIC_WINDOW_BAND
    if (!Number.isSafeInteger(band) || band < 1) {
      throw new TypeError('HostPublicWindowIndex needs a band of at least one candidate')
    }
    this.band = band
  }

  /**
   * The wire rows the index last published: what a snapshot of these
   * families serves. A withheld row is never among them.
   */
  wire(): HostPublicWindowWire {
    return this.published
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
    const entries = new Map<string, ThreadEntry>()
    const ignored: HostPublicWindowIgnored[] = []
    for (const change of models) {
      const threadId = change.model.threadId
      const reason = staleness(change, entries.get(threadId), this.deleted.has(threadId))
      if (reason === null) entries.set(threadId, entryOf(change))
      else ignored.push({ threadId, reason })
    }
    const computed = this.compute(entries, new Set(this.deleted), publication)
    this.commit(computed)
    return { complete: computed.complete, refill: computed.refill, ignored }
  }

  /** Prepare changes, in order, as one transaction. */
  prepare(
    changes: readonly HostPublicWindowChange[],
    publication: HostPublicWindowPublication
  ): HostPublicWindowTransaction {
    this.assertClosed()
    const entries = new Map(this.entries)
    const deleted = new Set(this.deleted)
    const ignored: HostPublicWindowIgnored[] = []
    for (const change of changes) {
      const threadId = change.kind === 'model' ? change.model.threadId : change.threadId
      const reason = staleness(change, entries.get(threadId), deleted.has(threadId))
      if (reason !== null) {
        ignored.push({ threadId, reason })
      } else if (change.kind === 'model') {
        entries.set(threadId, entryOf(change))
      } else {
        entries.delete(threadId)
        deleted.add(threadId)
      }
    }
    const computed = this.compute(entries, deleted, publication)
    const effects: HostDomainEffectDto[] = []
    for (const [, family] of WIRE_FAMILIES) {
      effects.push(
        ...diffHostEntityFamily(family, this.published.get(family)!, computed.wire.get(family)!)
      )
    }
    const token = {}
    this.open = token
    const settle = (): void => {
      if (this.open !== token) throw new Error('HostPublicWindowIndex transaction already settled')
      this.open = null
    }
    return {
      effects,
      complete: computed.complete,
      refill: computed.refill,
      ignored,
      commit: () => {
        settle()
        this.commit(computed)
      },
      abort: settle
    }
  }

  private assertClosed(): void {
    if (this.open !== null) throw new Error('HostPublicWindowIndex has a transaction open')
  }

  private commit(computed: Computed): void {
    // A short window keeps every candidate it was given until its refills
    // complete it: trimming a refilled thread back to its band would exhaust
    // it again a band later.
    this.entries = computed.complete ? this.trimmed(computed) : computed.entries
    this.deleted = computed.deleted
    this.published = computed.wire
  }

  /** Each thread cut to its windowed candidates and its band. */
  private trimmed(computed: Computed): Map<string, ThreadEntry> {
    const taken = new Map<string, number>()
    for (const entry of computed.window) {
      taken.set(entry.threadId, (taken.get(entry.threadId) ?? 0) + 1)
    }
    const entries = new Map<string, ThreadEntry>()
    for (const [threadId, entry] of computed.entries) {
      const candidates = entry.model.runs.candidates
      const keep = Math.min(candidates.length, (taken.get(threadId) ?? 0) + this.band)
      entries.set(threadId, {
        model:
          keep === candidates.length && entry.model === this.entries.get(threadId)?.model
            ? entry.model
            : keptModel(entry.model, candidates.slice(0, keep)),
        truncated: entry.truncated || keep < candidates.length
      })
    }
    return entries
  }

  private compute(
    entries: Map<string, ThreadEntry>,
    deleted: Set<string>,
    publication: HostPublicWindowPublication
  ): Computed {
    const { window, exhausted } = keptRunWindow(entries)
    const complete = exhausted === null
    const models = [...entries.values()].map((entry) => entry.model)
    const families = assembleFromWindow(models, window, complete)
    const at = projectorAt(publication.generatedAt)
    // The projector's warnings and the withheld counts: stamped with the publication.
    const own: HostWarningProjection[] = []
    const wire = new Map<HostPublicWindowDeltaFamily, Map<string, unknown>>()
    let donorWarnings: HostWarningProjection[] = []

    for (const [family, deltaFamily] of WIRE_FAMILIES) {
      const valid: { entityId: string; threadId: string; wire: unknown }[] = []
      let omitted = 0
      let withheld = 0
      const rows = families[family] as readonly object[]
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!
        const projected = this.project(family, row, models[index], entries)
        if (!projected.privacyClean) {
          withheld += 1
          continue
        }
        if (projected.wire === null) {
          omitted += 1
          continue
        }
        const identity = hostSnapshotEntityId(deltaFamily, projected.wire)
        if (!identity.ok) {
          withheld += 1
          continue
        }
        valid.push({
          entityId: identity.entityId,
          threadId: rowThreadId(row),
          wire: projected.wire
        })
      }
      if (omitted > 0) own.push(hostProjectionRowsOmittedWarning(family, omitted, at))
      // The projector sorts each family by id and keeps the first rows up to
      // the bound. Of rows sharing an id, the lowest thread's is kept.
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
      if (family === 'warnings') {
        donorWarnings = unique.map((entry) => entry.wire as HostWarningProjection)
        continue
      }
      wire.set(deltaFamily, new Map(unique.map((entry) => [entry.entityId, entry.wire])))
    }

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
    const published = this.published.get('warning')!
    for (const warning of own) {
      const prior = published.get(warning.warningId) as HostWarningProjection | undefined
      if (prior && hostProjectionUnchanged('warning', { ...prior, at: 0 }, { ...warning, at: 0 })) {
        warnings.set(warning.warningId, prior)
      }
    }
    wire.set('warning', warnings)

    return {
      entries,
      deleted,
      window,
      families,
      wire,
      complete,
      refill: exhausted === null ? [] : [exhausted]
    }
  }

  /**
   * The row's wire form and privacy, cached against what the row is built
   * from: a thread row by its model's row (threads are listed in model
   * order), a round by its model's round and carried run ids, anything else
   * by the row itself.
   */
  private project(
    family: HostRecordDerivedFamily,
    row: object,
    model: HostThreadRecordModelled | undefined,
    entries: ReadonlyMap<string, ThreadEntry>
  ): WireRow {
    const build = (): WireRow => ({
      wire: projectHostSnapshotRow(family, row),
      privacyClean: inspectHostSnapshotPrivacy(row).ok
    })
    if (family === 'warnings') return build()
    if (family === 'threads') {
      // A model can keep its thread row while its round changes, so the row
      // naming a round is cached against the round it names.
      const activeRoundId = (row as { activeRoundId?: string }).activeRoundId
      if (activeRoundId !== undefined) {
        const cached = this.activeThreadRows.get(model!.thread)
        if (cached && cached.activeRoundId === activeRoundId) return cached.row
        const built = build()
        this.activeThreadRows.set(model!.thread, { activeRoundId, row: built })
        return built
      }
      const cached = this.threadRows.get(model!.thread)
      if (cached) return cached
      const built = build()
      this.threadRows.set(model!.thread, built)
      return built
    }
    if (family === 'rounds') {
      const round = entries.get((row as { threadId: string }).threadId)!.model.round!
      const runIds = (row as { providerRunIds: readonly string[] }).providerRunIds.join('\u0000')
      const cached = this.roundRows.get(round)
      if (cached && cached.runIds === runIds) return cached.row
      const built = build()
      this.roundRows.set(round, { runIds, row: built })
      return built
    }
    const cached = this.rows.get(row)
    if (cached) return cached
    const built = build()
    this.rows.set(row, built)
    return built
  }
}
