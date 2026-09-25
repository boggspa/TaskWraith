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
  encodeHostParticipantEntityId,
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
  hostSnapshotEntityId,
  type HostSnapshotCollectionFamily,
  type HostSnapshotDomainEffectDiffIncoherenceReason
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

export type HostPublicWindowChange =
  | { readonly kind: 'model'; readonly model: HostThreadRecordModelled }
  | { readonly kind: 'delete'; readonly threadId: string }

export interface HostPublicWindowPublication {
  /** The publication's time: the `at` of the projector's own warnings. */
  readonly generatedAt: string
}

export type HostPublicWindowResult =
  | {
      readonly kind: 'effects'
      /** Wire effects for the record-derived families, in the snapshot diff's order. */
      readonly effects: readonly HostDomainEffectDto[]
      /** False while the run window is short of runs it should hold. */
      readonly complete: boolean
      /** Threads whose kept candidates ran out: model each again to fill the window. */
      readonly refill: readonly string[]
    }
  | {
      /** Nothing changed: publishing would fail as the snapshot diff fails. */
      readonly kind: 'refused'
      readonly reason: 'privacy_failed' | HostSnapshotDomainEffectDiffIncoherenceReason
      readonly detail: string
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
  readonly window: readonly HostPublicRunWindowEntry[]
  readonly families: HostPublicWindowFamilies
  readonly wire: Map<HostPublicWindowDeltaFamily, Map<string, unknown>>
  readonly complete: boolean
  readonly refill: readonly string[]
}

type ComputeFailure = Extract<HostPublicWindowResult, { kind: 'refused' }>

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function projectorAt(generatedAt: string): number {
  const parsed = Date.parse(generatedAt)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
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
 * rows it last published, and turns each thread's change into the effects a
 * before-and-after snapshot diff would publish for those families.
 *
 * A change is all or nothing: one that would fail the snapshot's privacy scan,
 * or index an entity twice or under an unsafe id, is refused and leaves the
 * index as it was. The projector's own warnings are republished only when
 * they change beyond their time. Unwired in this slice.
 */
export class HostPublicWindowIndex {
  private entries = new Map<string, ThreadEntry>()
  private current: HostPublicWindowFamilies = {
    threads: [],
    runs: [],
    rounds: [],
    participants: [],
    warnings: []
  }
  private published = new Map<HostPublicWindowDeltaFamily, Map<string, unknown>>(
    WIRE_FAMILIES.map(([, family]) => [family, new Map<string, unknown>()])
  )
  private readonly band: number
  /** Run and participant rows, by the row. */
  private readonly rows = new WeakMap<object, WireRow>()
  /** Thread rows, by the model's thread row: without and with its active round. */
  private readonly threadRows = new WeakMap<object, WireRow>()
  private readonly activeThreadRows = new WeakMap<object, WireRow>()
  /** Round rows, by the model's round and the run ids the row carries. */
  private readonly roundRows = new WeakMap<object, { runIds: string; row: WireRow }>()

  constructor(options: { readonly band?: number } = {}) {
    const band = options.band ?? HOST_PUBLIC_WINDOW_BAND
    if (!Number.isSafeInteger(band) || band < 1) {
      throw new TypeError('HostPublicWindowIndex needs a band of at least one candidate')
    }
    this.band = band
  }

  /** The donor families for a snapshot, as the profile projection would build them. */
  families(): HostPublicWindowFamilies {
    return this.current
  }

  /** The wire rows the index last published. */
  wire(): HostPublicWindowWire {
    return this.published
  }

  /**
   * Replace every thread at once, publishing nothing: the state a client's
   * next snapshot starts from.
   */
  seed(
    models: readonly HostThreadRecordModelled[],
    publication: HostPublicWindowPublication
  ):
    | Exclude<HostPublicWindowResult, { kind: 'effects' }>
    | {
        readonly kind: 'seeded'
        readonly complete: boolean
        readonly refill: readonly string[]
      } {
    const entries = new Map<string, ThreadEntry>()
    for (const model of models) entries.set(model.threadId, { model, truncated: false })
    const computed = this.compute(entries, publication)
    if ('kind' in computed) return computed
    this.commit(computed)
    return { kind: 'seeded', complete: computed.complete, refill: computed.refill }
  }

  /** Apply one thread's new model, or its deletion. */
  apply(
    change: HostPublicWindowChange,
    publication: HostPublicWindowPublication
  ): HostPublicWindowResult {
    const entries = new Map(this.entries)
    if (change.kind === 'model') {
      entries.set(change.model.threadId, { model: change.model, truncated: false })
    } else {
      entries.delete(change.threadId)
    }
    const computed = this.compute(entries, publication)
    if ('kind' in computed) return computed
    const effects: HostDomainEffectDto[] = []
    for (const [, family] of WIRE_FAMILIES) {
      effects.push(
        ...diffHostEntityFamily(family, this.published.get(family)!, computed.wire.get(family)!)
      )
    }
    this.commit(computed)
    return { kind: 'effects', effects, complete: computed.complete, refill: computed.refill }
  }

  private commit(computed: Computed): void {
    // A short window keeps every candidate it was given until its refills
    // complete it: trimming a refilled thread back to its band would exhaust
    // it again a band later.
    this.entries = computed.complete ? this.trimmed(computed) : computed.entries
    this.current = computed.families
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
    publication: HostPublicWindowPublication
  ): Computed | ComputeFailure {
    const { window, exhausted } = keptRunWindow(entries)
    const complete = exhausted === null
    const models = [...entries.values()].map((entry) => entry.model)
    const families = assembleFromWindow(models, window, complete)
    const at = projectorAt(publication.generatedAt)
    const projector: HostWarningProjection[] = []
    const wire = new Map<HostPublicWindowDeltaFamily, Map<string, unknown>>()
    let donorWarnings: unknown[] = []

    for (const [family, deltaFamily] of WIRE_FAMILIES) {
      const valid: { sortId: string; wire: unknown }[] = []
      let omitted = 0
      const rows = families[family] as readonly object[]
      for (let index = 0; index < rows.length; index += 1) {
        const projected = this.project(family, rows[index]!, models[index], entries)
        if (!projected.privacyClean) {
          return {
            kind: 'refused',
            reason: 'privacy_failed',
            detail: `privacy sentinel in ${family}`
          }
        }
        if (projected.wire === null) {
          omitted += 1
          continue
        }
        valid.push({ sortId: this.sortId(family, projected.wire), wire: projected.wire })
      }
      if (omitted > 0) projector.push(hostProjectionRowsOmittedWarning(family, omitted, at))
      // The projector sorts each family by id and keeps the first rows up to the bound.
      valid.sort((left, right) => compareIds(left.sortId, right.sortId))
      if (valid.length > HOST_PROTOCOL_MAX_COLLECTION) {
        projector.push(hostProjectionTruncatedWarning(family, valid.length, at))
        valid.length = HOST_PROTOCOL_MAX_COLLECTION
      }
      if (family === 'warnings') {
        donorWarnings = valid.map((entry) => entry.wire)
        continue
      }
      const indexed = this.index(
        deltaFamily,
        valid.map((entry) => entry.wire)
      )
      if ('kind' in indexed) return indexed
      wire.set(deltaFamily, indexed)
    }

    // Donor warnings and the projector's own, merged in warning id order. The
    // projector re-caps the merge, but here it holds at most three donor
    // warnings and two per family.
    const merged = [...(donorWarnings as HostWarningProjection[]), ...projector].sort(
      (left, right) => compareIds(left.warningId, right.warningId)
    )
    const warnings = this.index('warning', merged)
    if ('kind' in warnings) return warnings
    // A projector warning changes only when it says something new: its time is
    // the publication's, not news.
    const published = this.published.get('warning')!
    for (const warning of projector) {
      const prior = published.get(warning.warningId) as HostWarningProjection | undefined
      if (prior && hostProjectionUnchanged('warning', { ...prior, at: 0 }, { ...warning, at: 0 })) {
        warnings.set(warning.warningId, prior)
      }
    }
    wire.set('warning', warnings)

    return {
      entries,
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
      const cache = 'activeRoundId' in row ? this.activeThreadRows : this.threadRows
      const cached = cache.get(model!.thread)
      if (cached) return cached
      const built = build()
      cache.set(model!.thread, built)
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

  private sortId(family: HostRecordDerivedFamily, wire: unknown): string {
    const row = wire as Record<string, unknown>
    switch (family) {
      case 'threads':
        return row.id as string
      case 'runs':
        return row.runId as string
      case 'rounds':
        return row.roundId as string
      case 'participants': {
        const identity = encodeHostParticipantEntityId(row.threadId, row.id)
        return identity.ok ? identity.value : (row.id as string)
      }
      case 'warnings':
        return row.warningId as string
    }
  }

  /** The family's rows by entity id, refusing what the snapshot diff cannot index. */
  private index(
    family: HostSnapshotCollectionFamily,
    rows: readonly unknown[]
  ): Map<string, unknown> | ComputeFailure {
    const indexed = new Map<string, unknown>()
    for (const row of rows) {
      const identity = hostSnapshotEntityId(family, row)
      if (!identity.ok) return { kind: 'refused', reason: identity.reason, detail: identity.detail }
      if (indexed.has(identity.entityId)) {
        return {
          kind: 'refused',
          reason: 'duplicate_entity_id',
          detail: `${family} duplicate entityId "${identity.entityId}"`
        }
      }
      indexed.set(identity.entityId, row)
    }
    return indexed
  }
}
