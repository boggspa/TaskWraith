/**
 * Band tests for the public window index (Independent Threads M4, slice 13d,
 * contract item 2). The band is global: the index keeps at most 1,800 + band
 * run candidates across every thread. For bands 1, 7, 128 and the default,
 * over busy random sequences fed side by side to an unbounded frozen
 * reference:
 * - whenever a prepare reports complete, the committed wire equals the
 *   reference's;
 * - a short window never tombstones a run the reference still holds;
 * - `diagnostics().keptRuns` never exceeds 1,800 + band;
 * - refills complete within a bounded number of rounds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HOST_WARNING_PROJECTION_WINDOWED } from '../shared/hostProtocol'
import { HOST_PROFILE_RUN_WINDOW_WARNING_MESSAGE } from './HostProfileDomainProjection'
import type { HostProfileThread } from './HostProfileDomainStore'
import {
  HostPublicWindowIndex,
  type HostPublicWindowModelChange,
  type HostPublicWindowWire
} from './HostPublicWindowIndex'
import {
  HostPublicWindowIndex as ReferenceWindowIndex,
  type HostPublicWindowChange
} from './HostPublicWindowIndex.reference.testutil'
import {
  modelHostThreadRecordEffects,
  type HostThreadRecordModelled
} from './HostThreadRecordEffectModel'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()
const UNBOUNDED = 1_000_000_000
const RUN_WINDOW = 1_800
const DEFAULT_BAND = 1_800
const FAMILIES = ['thread', 'run', 'round', 'participant', 'warning'] as const
const WINDOWED_RUNS = `${HOST_WARNING_PROJECTION_WINDOWED}:runs`

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

function ensemble(roundId: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    chatKind: 'ensemble',
    ensemble: {
      orchestrationMode: 'sequential',
      fanoutPolicy: 'all',
      participants: [{ id: 'p1', provider: 'codex', role: 'worker', order: 0, enabled: true }],
      activeRound: {
        roundId,
        status,
        participants: [{ participantId: 'p1', runId: `${roundId}-seat` }],
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

/**
 * Comparable wire: rows by family and id, warnings without their time (a
 * warning keeps its time until it says something new), and the runs window
 * warning in the stable text the frozen reference predates (it still writes
 * the running total and the loading flavour).
 */
function comparable(wire: HostPublicWindowWire): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    FAMILIES.map((family) => [
      family,
      Object.fromEntries(
        [...wire.get(family)!].map(([id, row]) => [
          id,
          family !== 'warning'
            ? row
            : {
                ...(row as Record<string, unknown>),
                ...(id === WINDOWED_RUNS
                  ? { message: HOST_PROFILE_RUN_WINDOW_WARNING_MESSAGE }
                  : {}),
                at: 0
              }
        ])
      )
    ])
  )
}

interface Step {
  readonly change: HostPublicWindowChange
  readonly generatedAt: string
  /** Every thread's full model once the change is made. */
  readonly models: ReadonlyMap<string, HostPublicWindowModelChange>
}

/**
 * A deleted thread never comes back in the incarnation, so a slot whose
 * thread is deleted goes on as a new thread under a fresh id.
 */
function lives() {
  const deaths = new Map<string, number>()
  const id = (slot: string): string => {
    const count = deaths.get(slot) ?? 0
    return count === 0 ? slot : `${slot}.${count}`
  }
  return {
    id,
    delete: (slot: string): HostPublicWindowChange => {
      const threadId = id(slot)
      deaths.set(slot, (deaths.get(slot) ?? 0) + 1)
      return { kind: 'delete', threadId }
    }
  }
}

/**
 * Threads whose runs accumulate past the run window: new runs outrank older
 * ones, running ones finish, some are pruned, and whole threads are deleted
 * and begin again. Windows fill, displace one another and free anything from
 * one slot to hundreds.
 */
function busySteps(r: () => number, stepCount: number, slots: readonly string[]): Step[] {
  const runsByThread = new Map<string, Record<string, unknown>[]>()
  const models = new Map<string, HostPublicWindowModelChange>()
  const threads = lives()
  const steps: Step[] = []
  let clock = 0
  for (let step = 0; step < stepCount; step += 1) {
    const slot = slots[Math.floor(r() * slots.length)]!
    const threadId = threads.id(slot)
    let change: HostPublicWindowChange
    if (models.has(threadId) && r() < 0.2) {
      runsByThread.delete(threadId)
      models.delete(threadId)
      change = threads.delete(slot)
    } else {
      let runs = (runsByThread.get(threadId) ?? []).map((stored) =>
        stored.status === 'running' && r() < 0.5
          ? { ...stored, status: 'success', endedAt: stored.startedAt }
          : stored
      )
      // A pruning change only frees slots; any other adds runs above the rest.
      const pruning = runs.length > 0 && r() < 0.4
      if (pruning) {
        const pruned = 1 + Math.floor(r() * 150)
        for (let count = 0; count < pruned && runs.length > 0; count += 1) {
          runs = runs.filter((_, index) => index !== Math.floor(r() * runs.length))
        }
      }
      const added = pruning ? 0 : Math.floor(r() * 900)
      for (let count = 0; count < added; count += 1) {
        clock += 1 + Math.floor(r() * 3)
        runs.push(
          run(`${threadId}-${step}-${count}`, clock * 1_000, {
            ...(r() < 0.05 ? { status: 'running', endedAt: undefined } : {}),
            ...(r() < 0.5 ? { ensembleRoundId: `round-${threadId}` } : {})
          })
        )
      }
      runsByThread.set(threadId, runs)
      const model = modelOf({
        appChatId: threadId,
        updatedAt: T0 + step,
        // Two ensembles, so displacement also changes their rounds' members.
        ...(slot === 'a' || slot === 'c'
          ? ensemble(`round-${threadId}`, r() < 0.7 ? 'running' : 'completed')
          : {}),
        runs
      })
      const modelled: HostPublicWindowModelChange = { kind: 'model', model }
      change = modelled
      models.set(threadId, modelled)
    }
    steps.push({ change, generatedAt: iso(step * 60_000), models: new Map(models) })
  }
  return steps
}

interface Totals {
  steps: number
  complete: number
  short: number
  refills: number
  /** Refill rounds before a step's window completed, at most. */
  longestRefill: number
  tombstones: number
}

/**
 * Feed the steps to a banded index and, side by side, to the unbounded
 * reference. A short window is committed and its refills answered from the
 * step's full models, each as its own transaction on both indexes.
 */
function driveBand(steps: readonly Step[], band: number | undefined, totals: Totals): void {
  const fresh =
    band === undefined ? new HostPublicWindowIndex() : new HostPublicWindowIndex({ band })
  const kept = RUN_WINDOW + (band ?? DEFAULT_BAND)
  const reference = new ReferenceWindowIndex({ band: UNBOUNDED })
  const feedReference = (changes: readonly HostPublicWindowChange[], generatedAt: string) => {
    const transaction = reference.prepare(changes, { generatedAt })
    expect(transaction).toMatchObject({ complete: true, refill: [], ignored: [] })
    transaction.commit()
    return transaction
  }
  for (const step of steps) {
    totals.steps += 1
    const publication = { generatedAt: step.generatedAt }
    feedReference([step.change], step.generatedAt)
    const held = reference.wire().get('run')!
    let transaction = fresh.prepare([step.change], publication)
    let rounds = 0
    for (;;) {
      expect(transaction.ignored).toEqual([])
      // (b) A short window never retracts a run the reference still holds.
      const retracted = transaction.effects
        .filter((effect) => effect.family === 'run' && effect.kind === 'tombstone')
        .map((effect) => effect.entityId)
      totals.tombstones += retracted.length
      expect(retracted.filter((runId) => held.has(runId))).toEqual([])
      const { complete, refill } = transaction
      transaction.commit()
      // (c) The kept candidates stay inside the global band.
      const diagnostics = fresh.diagnostics()
      expect(diagnostics.keptRuns).toBeLessThanOrEqual(kept)
      expect(diagnostics.threads).toBe(step.models.size)
      if (complete) {
        expect(refill).toEqual([])
        // (a) Complete means exact.
        expect(comparable(fresh.wire())).toEqual(comparable(reference.wire()))
        totals.complete += 1
        break
      }
      totals.short += 1
      expect(refill.length).toBeGreaterThan(0)
      const models = refill.map((threadId) => {
        const model = step.models.get(threadId)
        if (!model) throw new Error(`refill names ${threadId}, which no longer exists`)
        return model
      })
      totals.refills += models.length
      // The reference sees the same models again: nothing changes for it.
      expect(feedReference(models, step.generatedAt).effects).toEqual([])
      transaction = fresh.prepare(models, publication)
      // (d) Refills complete.
      rounds += 1
      expect(rounds).toBeLessThan(40)
    }
    totals.longestRefill = Math.max(totals.longestRefill, rounds)
  }
}

describe('HostPublicWindowIndex with a global band', () => {
  let built: Step[][] | null = null
  /** Built under the fake clock, once, and shared by every band. */
  const stepSets = (): Step[][] =>
    (built ??= Array.from({ length: 5 }, (_, index) =>
      busySteps(mulberry32((index + 1) * 7_919), 16, ['a', 'b', 'c', 'd'])
    ))

  for (const band of [1, 7, 128, undefined] as const) {
    it(`band ${band ?? 'default'}: complete means exact, short retracts nothing held, kept runs stay bounded`, () => {
      const totals: Totals = {
        steps: 0,
        complete: 0,
        short: 0,
        refills: 0,
        longestRefill: 0,
        tombstones: 0
      }
      for (const steps of stepSets()) driveBand(steps, band, totals)
      expect(totals.steps).toBe(stepSets().length * 16)
      expect(totals.complete).toBe(totals.steps)
      expect(totals.tombstones).toBeGreaterThan(0)
      if (band !== undefined && band <= 7) {
        // Small bands run short; every short window was refilled to completion.
        expect(totals.short).toBeGreaterThan(0)
        expect(totals.refills).toBeGreaterThan(0)
      }
    }, 120_000)
  }

  it('keeps a bounded memory shape at scale: 3,000 threads of 40 runs', () => {
    const index = new HostPublicWindowIndex()
    const models = Array.from({ length: 3_000 }, (_, t) => ({
      kind: 'model' as const,
      model: modelOf({
        appChatId: `t-${String(t).padStart(4, '0')}`,
        runs: Array.from({ length: 40 }, (_, n) => run(`t-${t}-${n}`, (t * 40 + n) % 977))
      })
    }))
    const seeded = index.seed(models, { generatedAt: iso(0) })
    expect(seeded).toEqual({ complete: true, refill: [], ignored: [] })
    expect(index.wire().get('run')!.size).toBe(RUN_WINDOW)
    const diagnostics = index.diagnostics()
    expect(diagnostics.threads).toBe(3_000)
    expect(diagnostics.keptRuns).toBeLessThanOrEqual(RUN_WINDOW + DEFAULT_BAND)
    expect(diagnostics.keptRuns).toBeGreaterThanOrEqual(RUN_WINDOW)
    expect(diagnostics.trimmedThreads).toBeGreaterThan(0)
    expect(diagnostics.trimmedThreads).toBeLessThanOrEqual(3_000)
  }, 60_000)

  it('exposes diagnostics that count threads and kept run candidates', () => {
    const index = new HostPublicWindowIndex({ band: 7 })
    expect(index.diagnostics()).toEqual({ threads: 0, keptRuns: 0, trimmedThreads: 0 })
    index.seed(
      [
        { kind: 'model', model: modelOf({ appChatId: 'a', runs: [run('a-0', 0), run('a-1', 1)] }) },
        { kind: 'model', model: modelOf({ appChatId: 'b' }) }
      ],
      { generatedAt: iso(0) }
    )
    expect(index.diagnostics()).toEqual({ threads: 2, keptRuns: 2, trimmedThreads: 0 })
    const transaction = index.prepare([{ kind: 'delete', threadId: 'a' }], { generatedAt: iso(1) })
    transaction.commit()
    expect(index.diagnostics()).toEqual({ threads: 1, keptRuns: 0, trimmedThreads: 0 })
  })
})
