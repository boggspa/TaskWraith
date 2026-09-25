/**
 * Differential tests for the public window index (Independent Threads M4,
 * slice 13d, contract items 1 and 3): with an unbounded band, the rewritten
 * index and a frozen verbatim copy of the old one agree on every prepare's
 * effects, `complete`, `refill` and `ignored`, and on `wire()` with its key
 * order, over random sequences of models, deletes, older revisions, cut
 * models, seeds, commits and aborts. An abort leaves the index as it was.
 *
 * Declared out of scope: duplicate round ids tied on live and recency across
 * threads (the old code broke the tie by insertion order, the new by thread
 * id). Round ids here are unique per thread, or shared with a recency unique
 * to the thread's slot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HostDomainEffectDto } from './HostDomainDeltaPublisher'
import type { HostProfileThread } from './HostProfileDomainStore'
import {
  HostPublicWindowIndex,
  type HostPublicWindowChange,
  type HostPublicWindowIgnored,
  type HostPublicWindowModelChange,
  type HostPublicWindowPublication,
  type HostPublicWindowWire
} from './HostPublicWindowIndex'
import { HostPublicWindowIndex as ReferenceWindowIndex } from './HostPublicWindowIndex.reference.testutil'
import {
  modelHostThreadRecordEffects,
  type HostThreadRecordModelled
} from './HostThreadRecordEffectModel'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()
/** A band no sequence here can exhaust: every candidate is kept. */
const UNBOUNDED = 1_000_000_000
const FAMILIES = ['thread', 'run', 'round', 'participant', 'warning'] as const

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function modelOf(thread: Record<string, unknown>): HostThreadRecordModelled {
  const model = modelHostThreadRecordEffects({
    scope: 'global',
    title: 'Thread',
    provider: 'codex',
    archived: false,
    createdAt: 1,
    updatedAt: T0,
    persistenceRevision: 1,
    messages: [],
    runs: [],
    ...thread
  } as unknown as HostProfileThread)
  if (model.kind !== 'modelled') throw new Error('expected a modelled thread')
  return model
}

function run(runId: string, startedAt: number, extra: Record<string, unknown> = {}) {
  return {
    runId,
    provider: 'codex',
    status: 'success',
    startedAt: iso(startedAt),
    endedAt: iso(startedAt + 1),
    ...extra
  }
}

function ensemble(
  roundId: string,
  status: string,
  seats: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {}
) {
  return {
    chatKind: 'ensemble',
    ensemble: {
      orchestrationMode: 'sequential',
      fanoutPolicy: 'all',
      participants: seats,
      activeRound: {
        roundId,
        status,
        participants: [{ participantId: seats[0]!.id, runId: `${roundId}-seat` }],
        ...extra
      }
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0 + 86_400_000)
})
afterEach(() => {
  vi.useRealTimers()
})

// ── comparison ──────────────────────────────────────────────────────────────

/** Structural equality as `toEqual` sees it (undefined-valued keys are absent), fast. */
function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left)) {
    const other = right as readonly unknown[]
    if (left.length !== other.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!same(left[index], other[index])) return false
    }
    return true
  }
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keysA = Object.keys(a).filter((key) => a[key] !== undefined)
  const keysB = Object.keys(b).filter((key) => b[key] !== undefined)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!same(a[key], b[key])) return false
  }
  return true
}

/** Equal, with vitest's diff on a mismatch. */
function expectSame(actual: unknown, expected: unknown): void {
  if (!same(actual, expected)) expect(actual).toEqual(expected)
}

type WireEntries = Record<string, readonly (readonly [string, unknown])[]>

/** Every family's rows as `[id, row]` entries, in the wire's key order. */
function entriesOf(wire: HostPublicWindowWire): WireEntries {
  return Object.fromEntries(
    [...wire].map(([family, rows]) => [family, [...rows.entries()]] as const)
  )
}

interface Outcome {
  readonly effects: readonly HostDomainEffectDto[]
  readonly complete: boolean
  readonly refill: readonly string[]
  readonly ignored: readonly HostPublicWindowIgnored[]
}

function outcomeOf(transaction: Outcome): Outcome {
  return {
    effects: transaction.effects,
    complete: transaction.complete,
    refill: transaction.refill,
    ignored: transaction.ignored
  }
}

/** The new index and the frozen reference, driven in lockstep. */
class Pair {
  readonly fresh = new HostPublicWindowIndex({ band: UNBOUNDED })
  readonly reference = new ReferenceWindowIndex({ band: UNBOUNDED })

  seed(models: readonly HostPublicWindowModelChange[], publication: HostPublicWindowPublication) {
    const fresh = this.fresh.seed(models, publication)
    const reference = this.reference.seed(models, publication)
    expectSame(fresh, reference)
    this.expectWireSame()
    return fresh
  }

  prepare(changes: readonly HostPublicWindowChange[], publication: HostPublicWindowPublication) {
    const fresh = this.fresh.prepare(changes, publication)
    const reference = this.reference.prepare(changes, publication)
    expectSame(outcomeOf(fresh), outcomeOf(reference))
    return { fresh, reference }
  }

  /** Commit or abort both, then compare the wires (rows and key order). */
  settle(prepared: ReturnType<Pair['prepare']>, commit: boolean): void {
    if (commit) {
      prepared.fresh.commit()
      prepared.reference.commit()
    } else {
      prepared.fresh.abort()
      prepared.reference.abort()
    }
    this.expectWireSame()
  }

  expectWireSame(): void {
    const fresh = this.fresh.wire()
    const reference = this.reference.wire()
    expect([...fresh.keys()].sort()).toEqual([...reference.keys()].sort())
    for (const family of FAMILIES) {
      expectSame([...fresh.get(family)!.entries()], [...reference.get(family)!.entries()])
    }
  }
}

// ── random worlds ───────────────────────────────────────────────────────────

interface WorldOptions {
  readonly slots: number
  readonly steps: number
  /** Changes per prepare, inclusive. */
  readonly batch: readonly [number, number]
  readonly runs: readonly [number, number]
  readonly seats: readonly [number, number]
  readonly ensembleRate: number
  readonly liveRate: number
  /** A leaked thread preview, or a leaked run warning: the privacy scan refuses the row. */
  readonly privacyRate: number
  /** A padded run id no diff can key. */
  readonly unsafeRate: number
  /** A run id from a pool shared across threads. */
  readonly sharedRunRate: number
  /** A round id from a pool shared across threads, its recency unique to the slot. */
  readonly sharedRoundRate: number
  /** `updatedAt: -1`: the decoder omits the thread row. */
  readonly omitThreadRate: number
  /** A duplicate seat id: the decoder omits the participant. */
  readonly omitSeatRate: number
  readonly cutRate: number
  readonly olderRate: number
  readonly deleteRate: number
  /** A change for a thread this incarnation deleted. */
  readonly deadRate: number
  readonly abortRate: number
  /** How often a pending refill is answered with the full model. */
  readonly refillRate: number
  readonly seedEvery: number
  /** Seed the whole world before the first step. */
  readonly seedFirst: boolean
}

interface Seen {
  threadsOver2000: number
  participantsOver2000: number
  roundsOver1800: number
  runsWindowed: number
  liveRounds: number
  completedRounds: number
  privacyWithheld: number
  unsafeWithheld: number
  sharedRunWithheld: number
  sharedRoundWithheld: number
  omittedThreads: number
  omittedParticipants: number
  older: number
  deleted: number
  deletes: number
  cut: number
  incomplete: number
  refilled: number
  multiChange: number
  aborts: number
  commits: number
  seeds: number
  seedTwoModels: number
  seedIgnored: number
}

function freshSeen(): Seen {
  return {
    threadsOver2000: 0,
    participantsOver2000: 0,
    roundsOver1800: 0,
    runsWindowed: 0,
    liveRounds: 0,
    completedRounds: 0,
    privacyWithheld: 0,
    unsafeWithheld: 0,
    sharedRunWithheld: 0,
    sharedRoundWithheld: 0,
    omittedThreads: 0,
    omittedParticipants: 0,
    older: 0,
    deleted: 0,
    deletes: 0,
    cut: 0,
    incomplete: 0,
    refilled: 0,
    multiChange: 0,
    aborts: 0,
    commits: 0,
    seeds: 0,
    seedTwoModels: 0,
    seedIgnored: 0
  }
}

/** A model with its candidates cut short of its share of the window. */
function cutModel(
  r: () => number,
  model: HostThreadRecordModelled
): HostThreadRecordModelled | null {
  const share = Math.min(model.runs.total, 1_800)
  if (share < 1) return null
  // Keeping none is a cut with no floor: neither index names it for refill.
  const keep = Math.floor(r() * share)
  return { ...model, runs: { ...model.runs, candidates: model.runs.candidates.slice(0, keep) } }
}

class World {
  private readonly r: () => number
  private readonly options: WorldOptions
  readonly seen: Seen
  /** Each slot's live thread id, and every id it has buried. */
  private readonly deaths = new Map<number, number>()
  private readonly dead: string[] = []
  private readonly revisions = new Map<string, number>()
  /** The full model of every live thread, as last built. */
  private readonly full = new Map<string, HostPublicWindowModelChange>()
  private readonly pending = new Set<string>()
  private clock = 0

  constructor(seed: number, options: WorldOptions, seen: Seen) {
    this.r = mulberry32(seed)
    this.options = options
    this.seen = seen
  }

  private int(min: number, max: number): number {
    return min + Math.floor(this.r() * (max - min + 1))
  }

  private idOf(slot: number): string {
    const count = this.deaths.get(slot) ?? 0
    return count === 0
      ? `t-${String(slot).padStart(4, '0')}`
      : `t-${String(slot).padStart(4, '0')}.${count}`
  }

  private slotOf(threadId: string): number {
    return Number(threadId.slice(2, 6))
  }

  /** A model of the thread at the given revision; sometimes cut. */
  private model(threadId: string, revision: number): HostPublicWindowModelChange {
    const { r, options } = this
    const slot = this.slotOf(threadId)
    this.clock += 1
    const clock = this.clock
    const ensembleThread = r() < options.ensembleRate
    const live = r() < options.liveRate
    const leakedThread = r() < options.privacyRate
    const sharedRound = ensembleThread && r() < options.sharedRoundRate
    const roundId = sharedRound
      ? `shared-round-${this.int(0, 3)}`
      : `round-${threadId}-${this.int(0, 2)}`
    const seatCount = this.int(options.seats[0], options.seats[1])
    const seats = Array.from({ length: seatCount }, (_, order) => ({
      id: `p${order}`,
      provider: 'codex',
      role: 'worker',
      order,
      enabled: true
    }))
    if (ensembleThread && r() < options.omitSeatRate) {
      seats.push({ id: 'p0', provider: 'codex', role: 'worker', order: seatCount, enabled: true })
    }
    const base = this.int(0, 60) * 1_000
    const runCount = this.int(options.runs[0], options.runs[1])
    const usedShared = new Set<string>()
    const runs = Array.from({ length: runCount }, (_, index) => {
      let runId = `${threadId}-run-${index}`
      const draw = r()
      if (draw < options.sharedRunRate) {
        const shared = `shared-run-${this.int(0, 5)}`
        if (!usedShared.has(shared)) {
          usedShared.add(shared)
          runId = shared
        }
      } else if (draw < options.sharedRunRate + options.unsafeRate) {
        runId = ` padded-${threadId}-${index}`
        this.seen.unsafeWithheld += 1
      }
      const leakedRun = r() < options.privacyRate
      return run(runId, base + index * 100, {
        status: leakedRun ? 'failed' : r() < 0.15 ? 'running' : 'success',
        ...(r() < 0.2 ? { endedAt: undefined } : {}),
        ...(r() < 0.1 ? { provider: undefined } : {}),
        ...(ensembleThread && r() < 0.5 ? { ensembleRoundId: roundId } : {}),
        ...(leakedRun ? { warningSummaries: ['token ghp_abc'] } : {})
      })
    })
    const built = modelOf({
      appChatId: threadId,
      title: `Thread ${threadId} r${revision} c${clock}`,
      persistenceRevision: revision,
      updatedAt: r() < options.omitThreadRate ? -1 : T0 + clock,
      provider: r() < 0.1 ? '' : 'codex',
      ...(leakedThread
        ? { messages: [{ id: 'm', role: 'user', content: 'token ghp_abc', timestamp: iso(0) }] }
        : {}),
      ...(ensembleThread
        ? ensemble(roundId, live ? 'running' : 'completed', seats, {
            startedAt: iso(sharedRound ? slot + 1 : base),
            ...(!live && !sharedRound && r() < 0.5 ? { endedAt: iso(base + 500) } : {})
          })
        : {}),
      runs
    })
    const full: HostPublicWindowModelChange = { kind: 'model', model: built }
    this.full.set(threadId, full)
    if (r() < options.cutRate) {
      const cut = cutModel(r, built)
      if (cut) {
        this.seen.cut += 1
        return { kind: 'model', model: cut }
      }
    }
    return full
  }

  private nextRevision(threadId: string, older: boolean): number {
    const current = this.revisions.get(threadId) ?? 0
    if (older && current >= 2) return current - 1
    const next = this.r() < 0.1 && current > 0 ? current : current + 1
    this.revisions.set(threadId, next)
    return next
  }

  private delete(slot: number): HostPublicWindowChange {
    const threadId = this.idOf(slot)
    this.deaths.set(slot, (this.deaths.get(slot) ?? 0) + 1)
    this.dead.push(threadId)
    this.full.delete(threadId)
    this.pending.delete(threadId)
    this.seen.deletes += 1
    return { kind: 'delete', threadId }
  }

  roll(): number {
    return this.r()
  }

  /** The next batch of changes, and how many answer a pending refill. */
  step(): { changes: HostPublicWindowChange[]; answered: number } {
    const { r, options } = this
    const changes: HostPublicWindowChange[] = []
    let answered = 0
    for (const threadId of [...this.pending]) {
      if (r() < options.refillRate) {
        const full = this.full.get(threadId)
        if (full) {
          changes.push(full)
          answered += 1
        }
        this.pending.delete(threadId)
      }
    }
    const count = this.int(options.batch[0], options.batch[1])
    for (let index = 0; index < count; index += 1) {
      if (this.dead.length > 0 && r() < options.deadRate) {
        const threadId = this.dead[Math.floor(r() * this.dead.length)]!
        changes.push(
          r() < 0.3 ? { kind: 'delete', threadId } : this.model(threadId, this.int(1, 9))
        )
        continue
      }
      const slot = this.int(0, options.slots - 1)
      const threadId = this.idOf(slot)
      if (this.full.has(threadId) && r() < options.deleteRate) {
        changes.push(this.delete(slot))
        continue
      }
      const older = this.full.has(threadId) && r() < options.olderRate
      changes.push(this.model(threadId, this.nextRevision(threadId, older)))
    }
    return { changes, answered }
  }

  /** Every live thread's full model, some cut, with a stale duplicate and a dead thread. */
  seedModels(): HostPublicWindowModelChange[] {
    const { r } = this
    const models: HostPublicWindowModelChange[] = []
    for (const full of this.full.values()) {
      const cut = r() < this.options.cutRate ? cutModel(r, full.model) : null
      if (cut) {
        this.seen.cut += 1
        models.push({ kind: 'model', model: cut })
      } else {
        models.push(full)
      }
    }
    if (models.length > 0) {
      // Two models of one thread, the older one first or last.
      const at = Math.floor(r() * models.length)
      const newer = models[at]!
      const older = this.model(
        newer.model.threadId,
        Math.max(1, newer.model.projection.revision - 1)
      )
      // Keep the full map on the newer model.
      this.full.set(newer.model.threadId, newer)
      models.splice(r() < 0.5 ? at : at + 1, 0, older)
      this.seen.seedTwoModels += 1
    }
    if (this.dead.length > 0 && r() < 0.8) {
      models.push(this.model(this.dead[Math.floor(r() * this.dead.length)]!, 1))
    }
    return models
  }

  /** Learn from a committed outcome. */
  committed(outcome: Outcome): void {
    for (const threadId of outcome.refill) this.pending.add(threadId)
  }

  /** Initial models for every slot. */
  populate(): HostPublicWindowModelChange[] {
    return Array.from({ length: this.options.slots }, (_, slot) =>
      this.model(this.idOf(slot), this.nextRevision(this.idOf(slot), false))
    )
  }
}

const WITHHELD = 'projection_rows_withheld'
const OMITTED = 'projection_rows_omitted'
const TRUNCATED = 'projection_truncated'
const WINDOWED = 'projection_windowed'

/** What the committed wire shows, for the coverage counters. */
function observe(wire: HostPublicWindowWire, seen: Seen): void {
  const warnings = wire.get('warning')!
  if (warnings.has(`${TRUNCATED}:threads`)) seen.threadsOver2000 += 1
  if (warnings.has(`${TRUNCATED}:participants`)) seen.participantsOver2000 += 1
  if (warnings.has(`${WINDOWED}:rounds`)) seen.roundsOver1800 += 1
  if (warnings.has(`${WINDOWED}:runs`)) seen.runsWindowed += 1
  if (warnings.has(`${WITHHELD}:threads`)) seen.privacyWithheld += 1
  if (warnings.has(`${WITHHELD}:runs`)) seen.sharedRunWithheld += 1
  if (warnings.has(`${WITHHELD}:rounds`)) seen.sharedRoundWithheld += 1
  if (warnings.has(`${OMITTED}:threads`)) seen.omittedThreads += 1
  if (warnings.has(`${OMITTED}:participants`)) seen.omittedParticipants += 1
  let live = 0
  let completed = 0
  for (const row of wire.get('round')!.values()) {
    if ((row as { status: string }).status === 'running') live += 1
    else completed += 1
  }
  if (live > 0) seen.liveRounds += 1
  if (completed > 0) seen.completedRounds += 1
}

/**
 * Drive both indexes through a world: each step is prepared on both, its
 * outcome compared, then committed or aborted on both. An aborted prepare is
 * prepared again and must repeat itself, with the wire untouched (item 3).
 */
function drive(seed: number, options: WorldOptions, seen: Seen): void {
  const world = new World(seed, options, seen)
  const pair = new Pair()
  let step = 0
  const publication = (): HostPublicWindowPublication => ({ generatedAt: iso(step * 1_000) })
  if (options.seedFirst) {
    const result = pair.seed(world.populate(), publication())
    seen.seeds += 1
    world.committed({ ...result, effects: [] })
    observe(pair.fresh.wire(), seen)
  }
  for (step = 1; step <= options.steps; step += 1) {
    if (options.seedEvery > 0 && step % options.seedEvery === 0) {
      const result = pair.seed(world.seedModels(), publication())
      seen.seeds += 1
      if (result.ignored.length > 0) seen.seedIgnored += 1
      world.committed({ ...result, effects: [] })
      observe(pair.fresh.wire(), seen)
      continue
    }
    const { changes, answered } = world.step()
    if (changes.length > 1) seen.multiChange += 1
    const prepared = pair.prepare(changes, publication())
    const outcome = outcomeOf(prepared.fresh)
    for (const ignored of outcome.ignored) {
      if (ignored.reason === 'older') seen.older += 1
      else seen.deleted += 1
    }
    if (!outcome.complete) seen.incomplete += 1
    if (world.roll() < options.abortRate) {
      // Item 3: the wire survives a prepare and abort, and the same prepare repeats itself.
      const before = entriesOf(pair.fresh.wire())
      pair.settle(prepared, false)
      seen.aborts += 1
      expectSame(entriesOf(pair.fresh.wire()), before)
      const again = pair.prepare(changes, publication())
      expectSame(outcomeOf(again.fresh), outcome)
      pair.settle(again, false)
      expectSame(entriesOf(pair.fresh.wire()), before)
      continue
    }
    pair.settle(prepared, true)
    seen.commits += 1
    seen.refilled += answered
    world.committed(outcome)
    observe(pair.fresh.wire(), seen)
  }
}

const SMALL: WorldOptions = {
  slots: 12,
  steps: 220,
  batch: [1, 8],
  runs: [0, 30],
  seats: [1, 4],
  ensembleRate: 0.6,
  liveRate: 0.5,
  privacyRate: 0.04,
  unsafeRate: 0.05,
  sharedRunRate: 0.08,
  sharedRoundRate: 0.25,
  omitThreadRate: 0.05,
  omitSeatRate: 0.15,
  cutRate: 0.1,
  olderRate: 0.15,
  deleteRate: 0.12,
  deadRate: 0.05,
  abortRate: 0.2,
  refillRate: 0.6,
  seedEvery: 45,
  seedFirst: false
}

const HEAVY: WorldOptions = {
  ...SMALL,
  slots: 6,
  steps: 90,
  batch: [1, 3],
  runs: [100, 700],
  cutRate: 0.2,
  seedEvery: 30,
  seedFirst: true
}

const WIDE: WorldOptions = {
  ...SMALL,
  slots: 2_300,
  steps: 70,
  batch: [1, 32],
  runs: [0, 4],
  seats: [1, 2],
  ensembleRate: 0.92,
  cutRate: 0.03,
  seedEvery: 35,
  seedFirst: true
}

describe('HostPublicWindowIndex against the frozen reference (unbounded band)', () => {
  it('agrees on small busy worlds: every path in mixed batches, seeds and aborts', () => {
    const seen = freshSeen()
    for (let seed = 1; seed <= 8; seed += 1) drive(seed * 101, SMALL, seen)
    for (const key of [
      'liveRounds',
      'completedRounds',
      'privacyWithheld',
      'sharedRunWithheld',
      'sharedRoundWithheld',
      'omittedThreads',
      'omittedParticipants',
      'older',
      'deleted',
      'deletes',
      'cut',
      'incomplete',
      'refilled',
      'multiChange',
      'aborts',
      'commits',
      'seeds',
      'seedTwoModels',
      'seedIgnored'
    ] as const) {
      expect(seen[key], key).toBeGreaterThan(0)
    }
  }, 60_000)

  it('agrees on heavy threads: the run window fills, cut models and refills', () => {
    const seen = freshSeen()
    for (let seed = 1; seed <= 3; seed += 1) drive(seed * 7_919, HEAVY, seen)
    for (const key of [
      'runsWindowed',
      'cut',
      'incomplete',
      'refilled',
      'aborts',
      'seeds'
    ] as const) {
      expect(seen[key], key).toBeGreaterThan(0)
    }
    expect(seen.unsafeWithheld + seen.sharedRunWithheld).toBeGreaterThan(0)
  }, 60_000)

  it('agrees past the caps: over 2,000 threads and participants, over 1,800 rounds', () => {
    const seen = freshSeen()
    drive(31_337, WIDE, seen)
    for (const key of [
      'threadsOver2000',
      'participantsOver2000',
      'roundsOver1800',
      'runsWindowed',
      'liveRounds',
      'completedRounds',
      'older',
      'deleted',
      'multiChange',
      'aborts',
      'seeds',
      'seedTwoModels'
    ] as const) {
      expect(seen[key], key).toBeGreaterThan(0)
    }
  }, 60_000)

  it('withholds unsafe ids the same way', () => {
    const pair = new Pair()
    const publication = { generatedAt: iso(0) }
    pair.seed(
      [{ kind: 'model', model: modelOf({ appChatId: 'a', runs: [run('a-0', 0)] }) }],
      publication
    )
    const padded = pair.prepare(
      [
        {
          kind: 'model',
          model: modelOf({ appChatId: 'b', runs: [run(' padded', 5), run('b-1', 6)] })
        }
      ],
      publication
    )
    expect(
      padded.fresh.effects.map((effect) => `${effect.kind}:${effect.family}:${effect.entityId}`)
    ).toEqual(['upsert:thread:b', 'upsert:run:b-1', `upsert:warning:${WITHHELD}:runs`])
    pair.settle(padded, true)
    expect(pair.fresh.wire().get('run')!.has(' padded')).toBe(false)
  })

  it('counts rows sharing an id within a thread, and forgets them when they go', () => {
    // No record gives these: the projection drops a duplicate seat. The index
    // still counts one as withheld, as the projector would.
    const pair = new Pair()
    const publication = { generatedAt: iso(0) }
    const seated = (id: string, revision: number) =>
      modelOf({
        appChatId: id,
        persistenceRevision: revision,
        ...ensemble(`round-${id}`, 'completed', [
          { id: 'p0', provider: 'codex', role: 'worker', order: 0, enabled: true }
        ])
      })
    const doubled = (model: HostThreadRecordModelled): HostThreadRecordModelled => ({
      ...model,
      participants: {
        ...model.participants,
        // The second copy differs, so which row wins is visible: the first.
        rows: [
          ...model.participants.rows,
          ...model.participants.rows.map((row) => ({ ...row, role: 'reviewer' }))
        ]
      }
    })
    const x = seated('x', 1)
    expect(x.participants.rows.length).toBeGreaterThan(0)
    pair.seed([{ kind: 'model', model: doubled(x) }], publication)
    expect(pair.fresh.wire().get('warning')!.has(`${WITHHELD}:participants`)).toBe(true)
    const [first] = [...pair.fresh.wire().get('participant')!.values()] as { role: string }[]
    expect(first!.role).not.toBe('reviewer')
    const later = pair.prepare([{ kind: 'model', model: doubled(seated('y', 1)) }], publication)
    pair.settle(later, true)
    const cleared = pair.prepare([{ kind: 'model', model: seated('x', 2) }], publication)
    pair.settle(cleared, true)
    const gone = pair.prepare([{ kind: 'model', model: seated('y', 2) }], publication)
    expect(
      gone.fresh.effects.some(
        (effect) => effect.kind === 'tombstone' && effect.entityId === `${WITHHELD}:participants`
      )
    ).toBe(true)
    pair.settle(gone, true)
  })

  it('leaves the index as it was after an abort: the same prepare repeats itself', () => {
    const pair = new Pair()
    const publication = { generatedAt: iso(0) }
    const a = modelOf({ appChatId: 'a', persistenceRevision: 2, runs: [run('a-0', 0)] })
    const b = modelOf({
      appChatId: 'b',
      ...ensemble('round-b', 'running', [
        { id: 'p0', provider: 'codex', role: 'worker', order: 0, enabled: true }
      ]),
      runs: [run('b-0', 5, { status: 'running', endedAt: undefined, ensembleRoundId: 'round-b' })]
    })
    pair.seed([{ kind: 'model', model: a }], publication)
    const before = entriesOf(pair.fresh.wire())
    const changes: HostPublicWindowChange[] = [
      { kind: 'model', model: b },
      { kind: 'model', model: modelOf({ appChatId: 'a', persistenceRevision: 1 }) },
      { kind: 'delete', threadId: 'c' },
      { kind: 'model', model: modelOf({ appChatId: 'c' }) }
    ]
    const first = pair.prepare(changes, publication)
    const outcome = outcomeOf(first.fresh)
    expect(outcome.ignored).toEqual([
      { threadId: 'a', reason: 'older' },
      { threadId: 'c', reason: 'deleted' }
    ])
    expect(outcome.effects.length).toBeGreaterThan(0)
    pair.settle(first, false)
    expectSame(entriesOf(pair.fresh.wire()), before)
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const again = pair.prepare(changes, publication)
      expectSame(outcomeOf(again.fresh), outcome)
      pair.settle(again, false)
      expectSame(entriesOf(pair.fresh.wire()), before)
    }
    // And the same prepare, committed, lands what the aborted one showed.
    const committed = pair.prepare(changes, publication)
    expectSame(outcomeOf(committed.fresh), outcome)
    pair.settle(committed, true)
    expect(pair.fresh.wire().get('thread')!.get('b')).toMatchObject({ activeRoundId: 'round-b' })
    expect(pair.fresh.wire().get('thread')!.has('c')).toBe(false)
  })

  it('refuses a prepare or seed while a transaction is open, on both', () => {
    const pair = new Pair()
    const publication = { generatedAt: iso(0) }
    const open = pair.prepare([{ kind: 'model', model: modelOf({ appChatId: 'a' }) }], publication)
    for (const index of [pair.fresh, pair.reference]) {
      expect(() => index.prepare([], publication)).toThrow('transaction open')
      expect(() => index.seed([], publication)).toThrow('transaction open')
    }
    pair.settle(open, false)
    expect(() => open.fresh.commit()).toThrow('already settled')
    expect(() => open.reference.commit()).toThrow('already settled')
    const next = pair.prepare([{ kind: 'model', model: modelOf({ appChatId: 'a' }) }], publication)
    pair.settle(next, true)
    expect(() => next.fresh.abort()).toThrow('already settled')
    expect([...pair.fresh.wire().get('thread')!.keys()]).toEqual(['a'])
  })
})
