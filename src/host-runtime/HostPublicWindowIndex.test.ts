import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HOST_WARNING_PROJECTION_WINDOWED } from '../shared/hostProtocol'
import type { HostDomainEffectDto } from './HostDomainDeltaPublisher'
import type { HostProfileThread } from './HostProfileDomainStore'
import {
  assembleHostPublicWindowFamilies,
  hostPublicRunWindow,
  HostPublicWindowIndex,
  type HostPublicWindowChange,
  type HostPublicWindowWire
} from './HostPublicWindowIndex'
import { hostSnapshotEntityId } from './HostSnapshotDomainEffectDiff'
import { projectHostSnapshot } from './HostSnapshotProjector'
import {
  compareHostThreadRecordRuns,
  modelHostThreadRecordEffects,
  type HostThreadRecordModelled
} from './HostThreadRecordEffectModel'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()

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

describe('hostPublicRunWindow', () => {
  it('equals sorting every candidate in catalogue order, for any mix of threads', () => {
    const ids = [
      'a',
      'b',
      'B',
      `x${String.fromCodePoint(0x1f600)}`,
      `x${String.fromCharCode(0xff21)}`
    ]
    for (let seed = 1; seed <= 60; seed += 1) {
      const r = mulberry32(seed)
      const models = ids.slice(0, 1 + Math.floor(r() * ids.length)).map((appChatId) =>
        modelOf({
          appChatId,
          runs: Array.from({ length: Math.floor(r() * 40) }, (_, index) =>
            run(`run-${index}`, Math.floor(r() * 5) * 1_000, {
              status: r() < 0.2 ? 'running' : 'success',
              ...(r() < 0.3 ? { endedAt: undefined } : {})
            })
          )
        })
      )
      const limit = 1 + Math.floor(r() * 120)
      const expected = models
        .flatMap((model) =>
          model.runs.candidates.map((candidate) => ({ ...candidate, threadId: model.threadId }))
        )
        .sort(compareHostThreadRecordRuns)
        .slice(0, limit)
        .map((candidate) => `${candidate.threadId}/${candidate.runId}`)
      expect(
        hostPublicRunWindow(models, limit).map(
          (entry) => `${entry.threadId}/${entry.candidate.runId}`
        )
      ).toEqual(expected)
    }
  })

  it('is empty without candidates and stops at the limit', () => {
    expect(hostPublicRunWindow([])).toEqual([])
    expect(hostPublicRunWindow([modelOf({ appChatId: 'a' })])).toEqual([])
    const model = modelOf({ appChatId: 'a', runs: [run('r1', 0), run('r2', 5)] })
    expect(hostPublicRunWindow([model], 1).map((entry) => entry.candidate.runId)).toEqual(['r2'])
  })
})

describe('assembleHostPublicWindowFamilies', () => {
  it('lists families in thread order and runs in window order', () => {
    const models = [
      modelOf({ appChatId: 'b', runs: [run('b1', 0)] }),
      modelOf({ appChatId: 'a', runs: [run('a1', 5)] })
    ]
    const families = assembleHostPublicWindowFamilies(models)
    expect(families.threads.map((row) => row.id)).toEqual(['b', 'a'])
    expect(families.runs.map((row) => row.runId)).toEqual(['a1', 'b1'])
    expect(families.warnings).toEqual([])
  })

  it('gives a round its seats’ runs and its members inside the run window', () => {
    const member = run('member', 10, { ensembleRoundId: 'round-1' })
    const displaced = run('displaced', 1, { ensembleRoundId: 'round-1' })
    const own = modelOf({
      appChatId: 'own',
      ...ensemble('round-1', 'completed'),
      runs: [member, displaced]
    })
    const other = modelOf({
      appChatId: 'other',
      runs: Array.from({ length: 1_799 }, (_, index) => run(`o-${index}`, 5))
    })
    const families = assembleHostPublicWindowFamilies([own, other])
    expect(families.runs).toHaveLength(1_800)
    expect(families.runs.map((row) => row.runId)).not.toContain('displaced')
    expect(families.rounds).toEqual([
      expect.objectContaining({ roundId: 'round-1', providerRunIds: ['member', 'round-1-seat'] })
    ])
    expect(families.warnings.map((warning) => warning.warningId)).toEqual([
      `${HOST_WARNING_PROJECTION_WINDOWED}:runs`
    ])
    expect(families.warnings[0]).toMatchObject({
      message:
        'family runs intentionally windowed from 1801 to 1800; possibly-live rows precede recent terminal rows',
      at: T0 + 11
    })
  })

  it('reports a window still loading while candidates are incomplete', () => {
    const families = assembleHostPublicWindowFamilies(
      [modelOf({ appChatId: 'a', runs: [run('r', 0)] })],
      {
        complete: false
      }
    )
    expect(families.warnings).toEqual([
      expect.objectContaining({
        warningId: `${HOST_WARNING_PROJECTION_WINDOWED}:runs`,
        message:
          'family runs still loading from 1 to 1800; possibly-live rows precede recent terminal rows',
        at: T0 + 1
      })
    ])
  })

  it('names a running round on its thread only inside the round window', () => {
    const live = (index: number) =>
      modelOf({
        appChatId: `t-${String(index).padStart(4, '0')}`,
        ...ensemble(`round-${index}`, 'running', { startedAt: iso(index % 3 === 0 ? 0 : 1_000) }),
        runs: [run(`r-${index}`, 0, { status: 'running', endedAt: undefined })]
      })
    const models = Array.from({ length: 1_801 }, (_, index) => live(index))
    models.push(
      modelOf({
        appChatId: 'done',
        ...ensemble('round-done', 'completed', { endedAt: iso(9_000) })
      })
    )
    const families = assembleHostPublicWindowFamilies(models)
    expect(families.rounds).toHaveLength(1_800)
    // Live before terminal, then recent, then by round id: two rounds fall out.
    const kept = new Set(families.rounds.map((row) => row.roundId))
    expect(kept.has('round-done')).toBe(false)
    const dropped = models
      .filter((model) => model.round && !kept.has(model.round.roundId))
      .map((model) => model.round!.roundId)
    // Of the 601 live rounds tied at the earlier start, the last by round id goes.
    expect(dropped).toEqual(['round-999', 'round-done'])
    expect(families.threads.find((row) => row.id === 't-0999')).not.toHaveProperty('activeRoundId')
    expect(families.threads.find((row) => row.id === 't-0001')).toMatchObject({
      activeRoundId: 'round-1'
    })
    expect(
      families.warnings.find((warning) => warning.warningId.endsWith(':rounds'))
    ).toMatchObject({
      message:
        'family rounds intentionally windowed from 1802 to 1800; live rows precede recent terminal rows',
      at: T0 + 9_000
    })
  })

  it('sums omitted participants across threads at the latest thread stamp', () => {
    const seats = (updatedAt: number) =>
      modelOf({
        appChatId: `seats-${updatedAt}`,
        updatedAt,
        chatKind: 'ensemble',
        ensemble: {
          participants: [
            { id: 'p1', provider: 'codex', role: 'worker', order: 0, enabled: true },
            { id: 'p1', provider: 'codex', role: 'worker', order: 1, enabled: true }
          ]
        }
      })
    const families = assembleHostPublicWindowFamilies([seats(T0 + 5), seats(T0 + 9)])
    expect(families.participants).toHaveLength(2)
    expect(families.warnings).toEqual([
      {
        warningId: 'projection_rows_omitted:participants',
        severity: 'warning',
        code: 'projection_rows_omitted',
        message: 'family participants omitted 2 decoder-invalid rows',
        at: T0 + 9
      }
    ])
  })
})

// ── the incremental index ───────────────────────────────────────────────────

type ClientState = Map<string, Map<string, unknown>>
const FAMILIES = ['thread', 'run', 'round', 'participant', 'warning'] as const
const PROJECTOR_WARNING = /^projection_(rows_omitted|truncated):/

function emptyClient(): ClientState {
  return new Map(FAMILIES.map((family) => [family, new Map<string, unknown>()]))
}

function applyEffects(state: ClientState, effects: readonly HostDomainEffectDto[]): ClientState {
  const next: ClientState = new Map([...state].map(([family, rows]) => [family, new Map(rows)]))
  for (const effect of effects) {
    const rows = next.get(effect.family as string)!
    if (effect.kind === 'upsert') rows.set(effect.entityId, effect.payload)
    else rows.delete(effect.entityId)
  }
  return next
}

function fromWire(wire: HostPublicWindowWire): ClientState {
  return new Map([...wire].map(([family, rows]) => [family, new Map(rows)]))
}

/** The snapshot a fresh projection of every full model publishes, by family and entity id. */
function freshClient(
  models: readonly HostThreadRecordModelled[],
  generatedAt: string
): ClientState {
  const projected = projectHostSnapshot({
    health: { hostStatus: 'ok', connectionPhase: 'live', supervised: true, freshness: 'live' },
    workspaces: [],
    providers: [],
    missions: [],
    questions: [],
    approvals: [],
    schedules: [],
    artifacts: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    ...assembleHostPublicWindowFamilies(models),
    position: { generation: 1, cursor: 1, freshness: 'live', generatedAt },
    recovery: { reopenStatus: 'clean' }
  })
  if (!projected.ok) throw new Error(projected.error)
  const byFamily = {
    thread: projected.value.threads,
    run: projected.value.runs,
    round: projected.value.rounds,
    participant: projected.value.participants,
    warning: projected.value.warnings
  }
  return new Map(
    FAMILIES.map((family) => [
      family,
      new Map(
        (byFamily[family] as readonly unknown[]).map((row) => {
          const identity = hostSnapshotEntityId(family, row)
          if (!identity.ok) throw new Error(identity.detail)
          return [identity.entityId, row]
        })
      )
    ])
  )
}

/** Comparable state: the projector's own warnings carry the publication's time. */
function comparable(state: ClientState): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    [...state].map(([family, rows]) => [
      family,
      Object.fromEntries(
        [...rows].map(([id, row]) => [
          id,
          family === 'warning' && PROJECTOR_WARNING.test(id)
            ? { ...(row as Record<string, unknown>), at: 0 }
            : row
        ])
      )
    ])
  )
}

function randomModel(r: () => number, appChatId: string, step: number): HostThreadRecordModelled {
  const runCount = Math.floor(r() * 30)
  const base = Math.floor(r() * 50) * 1_000
  const ensembleThread = r() < 0.5
  return modelOf({
    appChatId,
    updatedAt: r() < 0.05 ? -1 : T0 + step,
    provider: r() < 0.1 ? '' : 'codex',
    ...(ensembleThread
      ? ensemble(`round-${appChatId}-${Math.floor(r() * 3)}`, r() < 0.5 ? 'running' : 'completed', {
          startedAt: iso(base)
        })
      : {}),
    runs: Array.from({ length: runCount }, (_, index) =>
      run(`${appChatId}-run-${index}`, base + index * 100, {
        status: r() < 0.15 ? 'running' : 'success',
        ...(r() < 0.2 ? { endedAt: undefined } : {}),
        ...(r() < 0.1 ? { provider: undefined } : {}),
        ...(ensembleThread && r() < 0.5 ? { ensembleRoundId: `round-${appChatId}-0` } : {})
      })
    )
  })
}

interface Step {
  readonly change: HostPublicWindowChange
  readonly generatedAt: string
  /** Every thread's full model once the change is made. */
  readonly models: ReadonlyMap<string, HostThreadRecordModelled>
}

function masked(family: string, entityId: string, row: unknown): unknown {
  return family === 'warning' && PROJECTOR_WARNING.test(entityId)
    ? { ...(row as Record<string, unknown>), at: 0 }
    : row
}

/** Effects come in the snapshot diff's order and each one changes something. */
function expectMinimalEffects(before: ClientState, effects: readonly HostDomainEffectDto[]): void {
  let lastFamily = -1
  let lastId = ''
  for (const effect of effects) {
    const family = FAMILIES.indexOf(effect.family as (typeof FAMILIES)[number])
    expect(family).toBeGreaterThanOrEqual(lastFamily)
    if (family === lastFamily) expect(effect.entityId > lastId).toBe(true)
    lastFamily = family
    lastId = effect.entityId
    const prior = before.get(effect.family)!.get(effect.entityId)
    if (effect.kind === 'tombstone') {
      expect(prior).toBeDefined()
    } else if (prior !== undefined) {
      expect(masked(effect.family, effect.entityId, effect.payload)).not.toEqual(
        masked(effect.family, effect.entityId, prior)
      )
    }
  }
}

/**
 * Apply each step, answer every refill, and after each step compare what a
 * client holds with a fresh projection of every thread's full model.
 */
function replay(
  steps: readonly Step[],
  index: HostPublicWindowIndex,
  seen?: { omitted: number; activeRound: number; roundMembers: number; deletes: number }
): { refills: number; displaced: number; shrunk: number } {
  let client = emptyClient()
  let refills = 0
  let displaced = 0
  let shrunk = 0
  for (const step of steps) {
    const publication = { generatedAt: step.generatedAt }
    let result = index.apply(step.change, publication)
    let guard = 0
    for (;;) {
      if (result.kind !== 'effects') throw new Error(`refused: ${result.detail}`)
      expectMinimalEffects(client, result.effects)
      const before = client
      client = applyEffects(client, result.effects)
      expect(comparable(client)).toEqual(comparable(fromWire(index.wire())))
      displaced += result.effects.filter(
        (effect) =>
          effect.kind === 'tombstone' &&
          effect.family === 'run' &&
          [...step.models.values()].some((model) =>
            model.runs.candidates.some((candidate) => candidate.runId === effect.entityId)
          ) &&
          before.get('run')!.has(effect.entityId)
      ).length
      // Rounds whose members another thread's runs pushed out.
      shrunk += result.effects.filter((effect) => {
        if (effect.family !== 'round' || effect.kind !== 'upsert') return false
        const prior = before.get('round')!.get(effect.entityId) as
          | { providerRunIds: string[] }
          | undefined
        const next = (effect.payload as { providerRunIds: string[] }).providerRunIds
        return prior !== undefined && prior.providerRunIds.some((runId) => !next.includes(runId))
      }).length
      if (result.complete) {
        expect(result.refill).toEqual([])
        break
      }
      // A short window names a thread to model again; doing so completes it.
      expect(result.refill.length).toBeGreaterThan(0)
      expect(
        index.wire().get('warning')!.get(`${HOST_WARNING_PROJECTION_WINDOWED}:runs`)
      ).toMatchObject({
        message: expect.stringContaining('still loading')
      })
      for (const threadId of result.refill) {
        refills += 1
        result = index.apply({ kind: 'model', model: step.models.get(threadId)! }, publication)
      }
      guard += 1
      expect(guard).toBeLessThan(20)
    }
    // Any order of the full models projects the same snapshot.
    const reference = [...step.models.values()].reverse()
    expect(comparable(client)).toEqual(comparable(freshClient(reference, step.generatedAt)))
    if (seen) {
      if (step.change.kind === 'delete') seen.deletes += 1
      const warnings = client.get('warning')!
      if ([...warnings.keys()].some((id) => id.startsWith('projection_rows_omitted:')))
        seen.omitted += 1
      if ([...client.get('thread')!.values()].some((row) => 'activeRoundId' in (row as object))) {
        seen.activeRound += 1
      }
      if (
        [...client.get('round')!.values()].some((row) =>
          (row as { providerRunIds: string[] }).providerRunIds.some((id) => !id.endsWith('-seat'))
        )
      ) {
        seen.roundMembers += 1
      }
    }
  }
  return { refills, displaced, shrunk }
}

/**
 * Four threads whose runs accumulate past the run window: new runs outrank
 * older ones, running ones finish (falling back to when they started), some
 * are pruned, and whole threads are deleted and begin again. Windows fill,
 * displace one another and free anything from one slot to hundreds.
 */
function busySteps(r: () => number): Step[] {
  const runsByThread = new Map<string, Record<string, unknown>[]>()
  const models = new Map<string, HostThreadRecordModelled>()
  const steps: Step[] = []
  let clock = 0
  for (let step = 0; step < 14; step += 1) {
    const threadId = ['a', 'b', 'c', 'd'][Math.floor(r() * 4)]!
    let change: HostPublicWindowChange
    if (models.has(threadId) && r() < 0.2) {
      runsByThread.delete(threadId)
      models.delete(threadId)
      change = { kind: 'delete', threadId }
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
        ...(threadId === 'a' || threadId === 'c'
          ? ensemble(`round-${threadId}`, r() < 0.7 ? 'running' : 'completed')
          : {}),
        runs
      })
      models.set(threadId, model)
      change = { kind: 'model', model }
    }
    steps.push({ change, generatedAt: iso(step * 60_000), models: new Map(models) })
  }
  return steps
}

describe('HostPublicWindowIndex', () => {
  it('publishes what a fresh projection shows, change by change', () => {
    const seen = { omitted: 0, activeRound: 0, roundMembers: 0, deletes: 0 }
    for (let seed = 1; seed <= 25; seed += 1) {
      const r = mulberry32(seed)
      const models = new Map<string, HostThreadRecordModelled>()
      const ids = ['a', 'b', 'B', 'c', 'd', 'e']
      const steps: Step[] = []
      for (let step = 0; step < 40; step += 1) {
        const threadId = ids[Math.floor(r() * ids.length)]!
        const change: HostPublicWindowChange =
          r() < 0.2
            ? { kind: 'delete', threadId }
            : { kind: 'model', model: randomModel(r, threadId, step) }
        if (change.kind === 'delete') models.delete(threadId)
        else models.set(threadId, change.model)
        steps.push({ change, generatedAt: iso(step * 60_000), models: new Map(models) })
      }
      const final = replay(steps, new HostPublicWindowIndex(), seen)
      expect(final.refills).toBe(0)
    }
    // The sequences reach the paths they are meant to prove.
    expect(seen.omitted).toBeGreaterThan(0)
    expect(seen.activeRound).toBeGreaterThan(0)
    expect(seen.roundMembers).toBeGreaterThan(0)
    expect(seen.deletes).toBeGreaterThan(0)
  })

  it('keeps a full run window through displacement and refills, whatever the band', () => {
    const totals = new Map<number, { refills: number; displaced: number; shrunk: number }>()
    for (let seed = 1; seed <= 4; seed += 1) {
      const steps = busySteps(mulberry32(seed * 7_919))
      for (const band of [1, 7, 128]) {
        const replayed = replay(steps, new HostPublicWindowIndex({ band }))
        const total = totals.get(band) ?? { refills: 0, displaced: 0, shrunk: 0 }
        totals.set(band, {
          refills: total.refills + replayed.refills,
          displaced: total.displaced + replayed.displaced,
          shrunk: total.shrunk + replayed.shrunk
        })
      }
    }
    for (const [, total] of totals) {
      expect(total.refills).toBeGreaterThan(0)
      expect(total.displaced).toBeGreaterThan(0)
      expect(total.shrunk).toBeGreaterThan(0)
    }
  }, 120_000)

  it('pushes out another thread’s runs and brings them back from its band', () => {
    const index = new HostPublicWindowIndex({ band: 5 })
    const generatedAt = iso(0)
    const older = modelOf({
      appChatId: 'older',
      runs: Array.from({ length: 10 }, (_, i) => run(`older-${i}`, i))
    })
    const newer = modelOf({
      appChatId: 'newer',
      runs: Array.from({ length: 1_796 }, (_, i) => run(`newer-${i}`, 1_000 + i))
    })
    index.seed([older, newer], { generatedAt })
    expect(index.wire().get('run')!.size).toBe(1_800)
    // The window held the older thread's four newest; four more new runs push them out.
    const busier = modelOf({
      appChatId: 'newer',
      runs: Array.from({ length: 1_800 }, (_, i) => run(`newer-${i}`, 1_000 + i))
    })
    const pushed = index.apply({ kind: 'model', model: busier }, { generatedAt })
    expect(pushed).toMatchObject({ kind: 'effects', complete: true, refill: [] })
    if (pushed.kind !== 'effects') return
    const runEffects = pushed.effects.filter((effect) => effect.family === 'run')
    expect(
      runEffects.filter((effect) => effect.kind === 'tombstone').map((effect) => effect.entityId)
    ).toEqual(['older-6', 'older-7', 'older-8', 'older-9'])
    expect(
      runEffects.filter((effect) => effect.kind === 'upsert').map((effect) => effect.entityId)
    ).toEqual(['newer-1796', 'newer-1797', 'newer-1798', 'newer-1799'])
    // Deleting it frees 1,800 slots: the older thread's band covers five, then
    // the window is short until the older thread is modelled again.
    const freed = index.apply({ kind: 'delete', threadId: 'newer' }, { generatedAt })
    expect(freed).toMatchObject({ kind: 'effects', complete: false, refill: ['older'] })
    if (freed.kind !== 'effects') return
    expect(index.wire().get('run')!.size).toBe(5)
    expect(
      index.wire().get('warning')!.get(`${HOST_WARNING_PROJECTION_WINDOWED}:runs`)
    ).toMatchObject({
      message: expect.stringContaining('still loading')
    })
    const refilled = index.apply({ kind: 'model', model: older }, { generatedAt })
    expect(refilled).toMatchObject({ kind: 'effects', complete: true, refill: [] })
    expect(index.wire().get('run')!.size).toBe(10)
    expect(index.wire().get('warning')!.has(`${HOST_WARNING_PROJECTION_WINDOWED}:runs`)).toBe(false)
  })

  it('refills each exhausted thread once, and retracts no run a client holds', () => {
    const index = new HostPublicWindowIndex({ band: 16 })
    const generatedAt = iso(0)
    // Three threads of 700 interleaved runs, and 300 newer runs above them all.
    const heavy = new Map(
      ['a', 'b', 'c'].map((id, offset) => [
        id,
        modelOf({
          appChatId: id,
          runs: Array.from({ length: 700 }, (_, n) => run(`${id}-${n}`, n * 3 + offset))
        })
      ])
    )
    const light = modelOf({
      appChatId: 'light',
      runs: Array.from({ length: 300 }, (_, n) => run(`light-${n}`, 10_000 + n))
    })
    index.seed([...heavy.values(), light], { generatedAt })
    // Deleting the newer runs frees 300 slots; each thread's band holds 16.
    let result = index.apply({ kind: 'delete', threadId: 'light' }, { generatedAt })
    const refilled: string[] = []
    const retracted: string[] = []
    for (;;) {
      if (result.kind !== 'effects') throw new Error('refused')
      for (const effect of result.effects) {
        if (effect.family === 'run' && effect.kind === 'tombstone') retracted.push(effect.entityId)
      }
      if (result.complete) break
      refilled.push(...result.refill)
      result = index.apply({ kind: 'model', model: heavy.get(result.refill[0]!)! }, { generatedAt })
    }
    expect(refilled).toEqual(['c', 'b', 'a'])
    expect(retracted).toHaveLength(300)
    expect(retracted.every((runId) => runId.startsWith('light-'))).toBe(true)
    expect(index.wire().get('run')!.size).toBe(1_800)
  })

  it('republishes the projector’s own warning only when it says something new', () => {
    const index = new HostPublicWindowIndex()
    const invalid = (id: string) => modelOf({ appChatId: id, updatedAt: -1 })
    index.seed([invalid('a')], { generatedAt: iso(0) })
    expect(index.wire().get('warning')!.get('projection_rows_omitted:threads')).toMatchObject({
      message: 'family threads omitted 1 decoder-invalid row',
      at: T0
    })
    const later = index.apply(
      { kind: 'model', model: modelOf({ appChatId: 'b' }) },
      { generatedAt: iso(5_000) }
    )
    if (later.kind !== 'effects') throw new Error('refused')
    expect(
      later.effects.map((effect) => `${effect.kind}:${effect.family}:${effect.entityId}`)
    ).toEqual(['upsert:thread:b'])
    const more = index.apply({ kind: 'model', model: invalid('c') }, { generatedAt: iso(9_000) })
    if (more.kind !== 'effects') throw new Error('refused')
    expect(more.effects).toEqual([
      {
        kind: 'upsert',
        family: 'warning',
        entityId: 'projection_rows_omitted:threads',
        payload: expect.objectContaining({
          message: 'family threads omitted 2 decoder-invalid rows',
          at: T0 + 9_000
        })
      }
    ])
  })

  it('caps threads at the collection bound by id, as the projector does', () => {
    const index = new HostPublicWindowIndex()
    const ids = Array.from({ length: 2_000 }, (_, i) => `t-${String(i).padStart(4, '0')}`)
    // Listed newest first, so the bound keeps rows by id, not by position.
    const models = ids.map((appChatId) => modelOf({ appChatId })).reverse()
    index.seed(models, { generatedAt: iso(0) })
    expect(index.wire().get('thread')!.size).toBe(2_000)
    expect(index.wire().get('warning')!.size).toBe(0)
    const added = index.apply(
      { kind: 'model', model: modelOf({ appChatId: 't-2000' }) },
      { generatedAt: iso(1) }
    )
    if (added.kind !== 'effects') throw new Error('refused')
    expect(added.effects).toEqual([
      {
        kind: 'upsert',
        family: 'warning',
        entityId: 'projection_truncated:threads',
        payload: expect.objectContaining({
          message: 'family threads truncated from 2001 to 2000 (dropped 1)'
        })
      }
    ])
    const deleted = index.apply({ kind: 'delete', threadId: 't-0000' }, { generatedAt: iso(2) })
    if (deleted.kind !== 'effects') throw new Error('refused')
    expect(
      deleted.effects.map((effect) => `${effect.kind}:${effect.family}:${effect.entityId}`)
    ).toEqual([
      'tombstone:thread:t-0000',
      'upsert:thread:t-2000',
      'tombstone:warning:projection_truncated:threads'
    ])
  })

  it('caps participants across threads by their entity id', () => {
    const index = new HostPublicWindowIndex()
    // 41 threads of 50 seats, listed last first: the bound drops the last thread's.
    const models = Array.from({ length: 41 }, (_, t) =>
      modelOf({
        appChatId: `t-${String(t).padStart(2, '0')}`,
        chatKind: 'ensemble',
        ensemble: {
          orchestrationMode: 'sequential',
          fanoutPolicy: 'all',
          participants: Array.from({ length: 50 }, (_, order) => ({
            id: `p${order}`,
            provider: 'codex',
            role: 'worker',
            order,
            enabled: true
          }))
        }
      })
    ).reverse()
    index.seed(models, { generatedAt: iso(0) })
    const participants = [...index.wire().get('participant')!.values()] as { threadId: string }[]
    expect(participants).toHaveLength(2_000)
    expect(participants.filter((row) => row.threadId === 't-40')).toHaveLength(0)
    expect(index.wire().get('warning')!.get('projection_truncated:participants')).toMatchObject({
      message: 'family participants truncated from 2050 to 2000 (dropped 50)'
    })
  })

  it('moves a live round into the round window when another leaves it', () => {
    const index = new HostPublicWindowIndex()
    const models = Array.from({ length: 1_801 }, (_, i) =>
      modelOf({
        appChatId: `t-${String(i).padStart(4, '0')}`,
        ...ensemble(`round-${i}`, 'running', { startedAt: iso(0) }),
        runs: [run(`r-${i}`, 0, { status: 'running', endedAt: undefined })]
      })
    )
    index.seed(models, { generatedAt: iso(0) })
    // Every round is live and started together: the window drops the last by round id.
    expect(index.wire().get('round')!.has('round-999')).toBe(false)
    expect(index.wire().get('thread')!.get('t-0999')).not.toHaveProperty('activeRoundId')
    expect(index.wire().get('thread')!.get('t-0998')).toMatchObject({ activeRoundId: 'round-998' })
    const deleted = index.apply({ kind: 'delete', threadId: 't-0000' }, { generatedAt: iso(1) })
    if (deleted.kind !== 'effects') throw new Error('refused')
    expect(
      deleted.effects
        .filter((effect) => effect.family !== 'participant')
        .map((effect) => `${effect.kind}:${effect.family}:${effect.entityId}`)
    ).toEqual([
      'tombstone:thread:t-0000',
      'upsert:thread:t-0999',
      'tombstone:run:r-0',
      'upsert:run:r-1800',
      'tombstone:round:round-0',
      'upsert:round:round-999',
      `tombstone:warning:${HOST_WARNING_PROJECTION_WINDOWED}:rounds`,
      `tombstone:warning:${HOST_WARNING_PROJECTION_WINDOWED}:runs`
    ])
    expect(index.wire().get('thread')!.get('t-0999')).toMatchObject({ activeRoundId: 'round-999' })
  })

  it('completes a window whose last slot is a trimmed thread’s last kept run', () => {
    const index = new HostPublicWindowIndex({ band: 5 })
    const generatedAt = iso(0)
    const older = modelOf({
      appChatId: 'older',
      runs: Array.from({ length: 10 }, (_, i) => run(`older-${i}`, i))
    })
    const newer = (count: number) =>
      modelOf({
        appChatId: 'newer',
        runs: Array.from({ length: count }, (_, i) => run(`newer-${i}`, 1_000 + i))
      })
    // The window holds the older thread's four newest; it keeps nine.
    index.seed([older, newer(1_796)], { generatedAt })
    // Five fewer newer runs: the ninth fills the window's last slot exactly.
    const result = index.apply({ kind: 'model', model: newer(1_791) }, { generatedAt })
    expect(result).toMatchObject({ kind: 'effects', complete: true, refill: [] })
    expect(index.wire().get('run')!.size).toBe(1_800)
    expect(index.wire().get('run')!.has('older-1')).toBe(true)
    expect(index.wire().get('run')!.has('older-0')).toBe(false)
  })

  it('stamps its own warnings as the projector does, whatever the publication’s time', () => {
    for (const [generatedAt, at] of [
      ['1969-12-31T23:59:59.000Z', 0],
      ['not a date', 0],
      [iso(1_500), T0 + 1_500]
    ] as const) {
      const index = new HostPublicWindowIndex()
      index.seed([modelOf({ appChatId: 'a', updatedAt: -1 })], { generatedAt })
      expect(index.wire().get('warning')!.get('projection_rows_omitted:threads')).toMatchObject({
        at
      })
    }
  })

  it('refuses a change that would fail the privacy scan, and keeps what it published', () => {
    const index = new HostPublicWindowIndex()
    index.seed([modelOf({ appChatId: 'a', runs: [run('r1', 0)] })], { generatedAt: iso(0) })
    const before = comparable(fromWire(index.wire()))
    const leaked = modelOf({
      appChatId: 'b',
      messages: [{ id: 'm', role: 'user', content: 'token ghp_abc', timestamp: iso(0) }]
    })
    expect(index.apply({ kind: 'model', model: leaked }, { generatedAt: iso(1) })).toMatchObject({
      kind: 'refused',
      reason: 'privacy_failed'
    })
    expect(comparable(fromWire(index.wire()))).toEqual(before)
    expect(index.families().threads.map((row) => row.id)).toEqual(['a'])
    // A seed is all or nothing too.
    expect(index.seed([leaked], { generatedAt: iso(2) })).toMatchObject({
      kind: 'refused',
      reason: 'privacy_failed'
    })
    expect(comparable(fromWire(index.wire()))).toEqual(before)
    // A clean seed replaces every thread and publishes nothing.
    expect(index.seed([modelOf({ appChatId: 'c' })], { generatedAt: iso(3) })).toEqual({
      kind: 'seeded',
      complete: true,
      refill: []
    })
    expect([...index.wire().get('thread')!.keys()]).toEqual(['c'])
    expect(index.wire().get('run')!.size).toBe(0)
  })

  it('refuses what the snapshot diff cannot index: a run id two threads share, or an unsafe one', () => {
    const index = new HostPublicWindowIndex()
    index.seed([modelOf({ appChatId: 'a', runs: [run('shared', 0)] })], { generatedAt: iso(0) })
    const before = comparable(fromWire(index.wire()))
    expect(
      index.apply(
        { kind: 'model', model: modelOf({ appChatId: 'b', runs: [run('shared', 5)] }) },
        { generatedAt: iso(1) }
      )
    ).toMatchObject({ kind: 'refused', reason: 'duplicate_entity_id' })
    // The projector publishes a padded run id, but no diff can key it.
    expect(
      index.apply(
        { kind: 'model', model: modelOf({ appChatId: 'c', runs: [run(' padded', 5)] }) },
        { generatedAt: iso(1) }
      )
    ).toMatchObject({ kind: 'refused', reason: 'unsafe_entity_id' })
    expect(comparable(fromWire(index.wire()))).toEqual(before)
    expect(index.families().threads.map((row) => row.id)).toEqual(['a'])
  })

  it('stops a short window at the exhausted thread, publishing nothing it would retract', () => {
    const index = new HostPublicWindowIndex({ band: 2 })
    const generatedAt = iso(0)
    const spread = (id: string, count: number, from: number) =>
      modelOf({
        appChatId: id,
        runs: Array.from({ length: count }, (_, i) => run(`${id}-${i}`, from + i))
      })
    // x keeps its newest seven of 1,900; y's ten are older than all of x's.
    const x = spread('x', 1_900, 100)
    index.seed([x, spread('y', 10, 0), spread('z', 1_795, 10_000)], { generatedAt })
    const short = index.apply({ kind: 'delete', threadId: 'z' }, { generatedAt })
    expect(short).toMatchObject({ kind: 'effects', complete: false, refill: ['x'] })
    expect([...index.wire().get('run')!.keys()].sort()).toEqual(
      Array.from({ length: 7 }, (_, i) => `x-${1_893 + i}`)
    )
    const refilled = index.apply({ kind: 'model', model: x }, { generatedAt })
    if (refilled.kind !== 'effects') throw new Error('refused')
    expect(refilled.complete).toBe(true)
    expect(
      refilled.effects.filter((effect) => effect.family === 'run' && effect.kind === 'tombstone')
    ).toEqual([])
    expect(index.wire().get('run')!.size).toBe(1_800)
    expect(index.wire().get('run')!.has('y-9')).toBe(false)
  })

  it('needs a band of at least one candidate', () => {
    expect(() => new HostPublicWindowIndex({ band: 0 })).toThrow(TypeError)
    expect(() => new HostPublicWindowIndex({ band: 1.5 })).toThrow(TypeError)
  })
})
