/**
 * Golden benchmark for the runs-family re-projection.
 *
 * Observed 2026-10-07 on the shipped 1.9.8 build (572 threads, 16,334 runs):
 * after a Host restart the journal carried 1,533 run upserts within 12 ms,
 * and for seven minutes the `projection_windowed:runs` warning alternated
 * between "still loading" and "intentionally windowed" on nearly every
 * publication (88 warning upserts). 1.9.8 predates the public window index's
 * seed (M4 slice 13f1) and switch (13f2), so everything it published came
 * from the LEGACY publisher: `HostProjectionReconciler` capturing the donor
 * projection once a second and diffing whole snapshots. At HEAD the index
 * publishes the five record-derived families once seeded, and the legacy
 * path remains for the rest and until the seed switches.
 *
 * This file pins, at the commit it was added, the structural goldens of both
 * publishers over a synthetic profile of the observed shape (effects by
 * family and kind, warnings, completeness), and reports wall time and bytes
 * as output rather than asserting them. The numbers it prints are the
 * baseline the perf record `.local-only/perf/2026-10-07-runs-reprojection.md`
 * quotes; re-run it after the refactor and compare.
 *
 * Axes: "per publication" means one reconciler tick (legacy) or one index
 * prepare (HEAD). The 16k-run shape is the observed profile (runs spread over
 * ~570 threads); the 10k-run shape is one thread at Chris's real scale.
 *
 * Safe beside the live app: it writes only a mkdtemp directory of its own and
 * removes only that directory.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createEmptyHostSnapshot,
  HOST_PROTOCOL_VERSION,
  type HostDeltaEnvelope,
  type HostHealthProjection,
  type HostSnapshot
} from '../shared/hostProtocol'
import {
  projectHostCatalogueThread,
  hostCatalogueThreadSummary
} from './HostCatalogueThreadProjection'
import { HostDeltaStore } from './HostDeltaStore'
import { validateHostDomainEffectBatch, type HostDomainEffectDto } from './HostDomainDeltaPublisher'
import type {
  HostCatalogueRunWindow,
  HostProfileDomainStore,
  HostProfileRun,
  HostProfileThread,
  HostProfileThreadSummary
} from './HostProfileDomainStore'
import {
  HOST_PROFILE_RUN_PROJECTION_LIMIT,
  HOST_PROFILE_RUN_WINDOW_WARNING_MESSAGE,
  projectHostProfileDomainSnapshot
} from './HostProfileDomainProjection'
import {
  hostPublicRunWindow,
  HostPublicWindowIndex,
  type HostPublicWindowTransaction
} from './HostPublicWindowIndex'
import { HostProjectionReconciler } from './HostProjectionReconciler'
import { diffHostSnapshotDomainEffects } from './HostSnapshotDomainEffectDiff'
import { projectHostSnapshot } from './HostSnapshotProjector'
import {
  modelHostThreadRecordEffects,
  type HostThreadRecordModelled
} from './HostThreadRecordEffectModel'

// ── fixture ─────────────────────────────────────────────────────────────────

const T0 = Date.parse('2026-10-01T00:00:00.000Z')
const NOW = T0 + 6 * 86_400_000
const NOW_ISO = new Date(NOW).toISOString()
const iso = (at: number): string => new Date(at).toISOString()

const THREADS = 570
const RUNS = 16_000
const LIVE_THREADS = 6
const ENSEMBLE_EVERY = 25
const SINGLE_THREAD_RUNS = 10_000
const SAMPLES = 5
const TIMEOUT = 120_000

const HEALTH: HostHealthProjection = {
  hostStatus: 'ok',
  connectionPhase: 'live',
  supervised: true,
  freshness: 'live'
}
const EMPTY = createEmptyHostSnapshot({ generation: 1, cursor: 0 })
const WINDOWED_RUNS = 'projection_windowed:runs'

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

function hex(random: () => number, length: number): string {
  let out = ''
  while (out.length < length) out += Math.floor(random() * 16).toString(16)
  return out
}

function uuid(random: () => number): string {
  return `${hex(random, 8)}-${hex(random, 4)}-4${hex(random, 3)}-a${hex(random, 3)}-${hex(random, 12)}`
}

const PROVIDERS = ['codex', 'claude', 'antigravity', 'kimi'] as const
const MODELS = ['gpt-6.1-sol', 'claude-opus-5-5', 'gemini-3.1-pro-high', 'kimi-k3'] as const

interface SyntheticRun {
  runId: string
  provider: string
  status: string
  startedAt: string
  endedAt?: string
  requestedModel: string
  usage: { inputTokens: number; outputTokens: number }
  ensembleRoundId?: string
}

function syntheticRun(random: () => number, startedAt: number, live: boolean): SyntheticRun {
  const provider = PROVIDERS[Math.floor(random() * PROVIDERS.length)]!
  const model = MODELS[Math.floor(random() * MODELS.length)]!
  const roll = random()
  const status = live ? 'running' : roll < 0.84 ? 'success' : roll < 0.93 ? 'failed' : 'cancelled'
  const durationMs = 5_000 + Math.floor(random() * 120_000)
  return {
    runId: `${provider}-${startedAt}-${hex(random, 11)}`,
    provider,
    status,
    startedAt: iso(startedAt),
    ...(live ? {} : { endedAt: iso(startedAt + durationMs) }),
    requestedModel: model,
    usage: {
      inputTokens: Math.floor(random() * 40_000),
      outputTokens: Math.floor(random() * 4_000)
    }
  }
}

function record(thread: Record<string, unknown>): HostProfileThread {
  return {
    scope: 'global',
    title: 'Thread',
    provider: 'codex',
    archived: false,
    createdAt: T0,
    updatedAt: NOW,
    persistenceRevision: 1,
    messages: [],
    runs: [],
    ...thread
  } as unknown as HostProfileThread
}

function ensembleOf(roundId: string, live: boolean, seatRunId: string): Record<string, unknown> {
  return {
    chatKind: 'ensemble',
    ensemble: {
      orchestrationMode: 'sequential',
      fanoutPolicy: 'all',
      participants: [
        { id: 'p1', provider: 'codex', role: 'worker', order: 0, enabled: true },
        { id: 'p2', provider: 'claude', role: 'worker', order: 1, enabled: true }
      ],
      activeRound: {
        roundId,
        status: live ? 'running' : 'completed',
        participants: [{ participantId: 'p1', runId: seatRunId }],
        startedAt: NOW_ISO,
        ...(live ? { activeParticipantId: 'p1' } : { completedAt: NOW_ISO })
      }
    }
  }
}

interface Profile {
  readonly records: HostProfileThread[]
  readonly liveThreadIds: string[]
}

/**
 * ~570 threads sharing ~16k runs with the observed skew (the busiest thread
 * holds a few hundred runs, most hold a handful); the first LIVE_THREADS
 * threads each end on a running run; every 25th thread is an Ensemble with a
 * round, live where the thread is.
 */
function buildProfile(seed: number): Profile {
  const random = mulberry32(seed)
  const threadIds = Array.from({ length: THREADS }, () => uuid(random))
  const runsByThread = threadIds.map((): number[] => [])
  // Every thread has at least one run; the rest are drawn with a square skew.
  for (let index = 0; index < THREADS; index += 1) runsByThread[index]!.push(0)
  for (let count = THREADS; count < RUNS; count += 1) {
    const draw = random()
    runsByThread[Math.floor(THREADS * draw * draw)]!.push(0)
  }
  const records: HostProfileThread[] = []
  const liveThreadIds: string[] = []
  for (let index = 0; index < THREADS; index += 1) {
    const appChatId = threadIds[index]!
    const count = runsByThread[index]!.length
    const live = index < LIVE_THREADS
    // Older threads end further back; a thread's runs are spaced out before its end.
    const endAt =
      NOW - Math.floor((index / THREADS) * 5 * 86_400_000) - Math.floor(random() * 3_600_000)
    const runs: SyntheticRun[] = []
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      const startedAt = endAt - (count - ordinal) * (60_000 + Math.floor(random() * 240_000))
      runs.push(syntheticRun(random, startedAt, live && ordinal === count - 1))
    }
    const ensemble = index % ENSEMBLE_EVERY === 0
    const roundId = `round-${hex(random, 8)}`
    if (ensemble) {
      for (const run of runs.slice(-2)) run.ensembleRoundId = roundId
    }
    records.push(
      record({
        appChatId,
        title: `Thread ${index}`,
        provider: runs[runs.length - 1]!.provider,
        updatedAt: endAt,
        createdAt: endAt - count * 300_000,
        runs,
        ...(ensemble ? ensembleOf(roundId, live, runs[runs.length - 1]!.runId) : {})
      })
    )
    if (live) liveThreadIds.push(appChatId)
  }
  return { records, liveThreadIds }
}

/** One thread at Chris's real scale: 10,000 runs, the last three live. */
function buildSingleThread(seed: number): HostProfileThread {
  const random = mulberry32(seed)
  const runs: SyntheticRun[] = []
  for (let ordinal = 0; ordinal < SINGLE_THREAD_RUNS; ordinal += 1) {
    const startedAt = NOW - (SINGLE_THREAD_RUNS - ordinal) * 90_000
    runs.push(syntheticRun(random, startedAt, ordinal >= SINGLE_THREAD_RUNS - 3))
  }
  return record({ appChatId: uuid(random), title: 'Chonk', updatedAt: NOW, runs })
}

function modelOf(thread: HostProfileThread): HostThreadRecordModelled {
  const model = modelHostThreadRecordEffects(thread)
  if (model.kind !== 'modelled') throw new Error('expected a modelled thread')
  return model
}

function summaryOf(thread: HostProfileThread): HostProfileThreadSummary {
  return hostCatalogueThreadSummary(projectHostCatalogueThread(thread))
}

/** A record after a persist that changed nothing but its stamp and revision. */
function heartbeat(thread: HostProfileThread): HostProfileThread {
  return {
    ...thread,
    updatedAt: thread.updatedAt + 1_000,
    persistenceRevision: (thread.persistenceRevision ?? 1) + 1
  } as HostProfileThread
}

/** A record after a persist that appended one running run. */
function withNewRun(thread: HostProfileThread, seed: number): HostProfileThread {
  const random = mulberry32(seed)
  const runs = [...(thread.runs ?? []), syntheticRun(random, NOW + 60_000, true)]
  return {
    ...thread,
    updatedAt: NOW + 60_000,
    persistenceRevision: (thread.persistenceRevision ?? 1) + 1,
    runs
  } as unknown as HostProfileThread
}

// ── the legacy publisher (what 1.9.8 runs) ──────────────────────────────────

/**
 * The catalogue's 1,800-run window as `ThreadCatalogueHostRunWindow.snapshot`
 * serves it: the first 1,800 runs in catalogue order (the same order
 * `hostPublicRunWindow` merges), each as its stored run summary.
 */
function catalogueWindow(
  models: readonly HostThreadRecordModelled[],
  options: { complete: boolean; empty?: boolean }
): HostCatalogueRunWindow {
  const total = models.reduce((count, model) => count + model.runs.total, 0)
  if (options.empty) return { entries: [], total, complete: options.complete }
  return {
    entries: hostPublicRunWindow(models).map((entry) => ({
      chatId: entry.threadId,
      run: entry.candidate.summary as unknown as HostProfileRun
    })),
    total,
    complete: options.complete
  }
}

function legacyStore(
  summaries: readonly HostProfileThreadSummary[],
  window: HostCatalogueRunWindow
): HostProfileDomainStore {
  return {
    listWorkspaces: () => [],
    listThreadSummaries: () => summaries,
    listRunSummaries: () => window
  } as unknown as HostProfileDomainStore
}

/** One reconciler capture: donor projection, then the snapshot projector. */
function legacyCapture(store: HostProfileDomainStore): {
  snapshot: HostSnapshot
  donorMs: number
  projectorMs: number
} {
  const t0 = performance.now()
  const families = projectHostProfileDomainSnapshot({ store, health: HEALTH, providers: [] })
  const t1 = performance.now()
  const projected = projectHostSnapshot({
    ...families,
    position: { generation: 1, cursor: 1, freshness: 'live', generatedAt: NOW_ISO },
    recovery: EMPTY.recovery
  })
  const t2 = performance.now()
  if (!projected.ok) throw new Error(projected.error)
  return { snapshot: projected.value, donorMs: t1 - t0, projectorMs: t2 - t1 }
}

function legacyDiff(before: HostSnapshot, after: HostSnapshot): HostDomainEffectDto[] {
  const diff = diffHostSnapshotDomainEffects(before, after)
  if (diff.kind !== 'effects') throw new Error(`diff ${diff.kind}: ${diff.reason}`)
  return [...diff.effects]
}

// ── measurement ─────────────────────────────────────────────────────────────

type Counts = Record<string, number>

function countEffects(effects: readonly HostDomainEffectDto[]): Counts {
  const counts: Counts = {}
  for (const effect of effects) {
    const key = `${effect.family}:${effect.kind}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function warningsIn(effects: readonly HostDomainEffectDto[]): string[] {
  return effects
    .filter((effect) => effect.family === 'warning')
    .map((effect) => {
      const payload = effect.payload as { message?: string } | undefined
      return `${effect.kind} ${effect.entityId}: ${payload?.message ?? ''}`
    })
}

/** Run ids whose candidate is possibly live, across the given models. */
function activeRunIds(models: readonly HostThreadRecordModelled[]): Set<string> {
  return new Set(
    models.flatMap((model) =>
      model.runs.candidates
        .filter((candidate) => candidate.rank.active === 1)
        .map((candidate) => candidate.runId)
    )
  )
}

/** Invariant: no run leaves the window while it is live. */
function expectNoLiveTombstone(
  effects: readonly HostDomainEffectDto[],
  models: readonly HostThreadRecordModelled[]
): void {
  const active = activeRunIds(models)
  const tombstoned = effects
    .filter((effect) => effect.family === 'run' && effect.kind === 'tombstone')
    .map((effect) => effect.entityId)
  expect(tombstoned.length).toBeGreaterThan(0)
  expect(tombstoned.filter((runId) => active.has(runId))).toEqual([])
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[sorted.length >> 1]!
}

function timed<T>(work: () => T, samples = SAMPLES): { result: T; ms: number } {
  const durations: number[] = []
  let result!: T
  for (let sample = 0; sample < samples; sample += 1) {
    const start = performance.now()
    result = work()
    durations.push(performance.now() - start)
  }
  return { result, ms: median(durations) }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** The frame `HostLocalServer.broadcastDelta` writes per envelope, per client. */
function socketFrameBytes(envelope: HostDeltaEnvelope): number {
  return (
    jsonBytes({
      type: 'event',
      transportVersion: 1,
      event: 'deltas',
      sequence: 1,
      payload: {
        type: 'host.deltas',
        protocolVersion: HOST_PROTOCOL_VERSION,
        result: {
          kind: 'deltas',
          generation: envelope.generation,
          fromCursor: envelope.previousCursor,
          toCursor: envelope.cursor,
          deltas: [envelope]
        }
      }
    }) + 1
  )
}

interface Published {
  readonly envelopes: number
  /** Envelope bytes as the journal retains them. */
  readonly journalBytes: number
  /** Bytes written to ONE delta-capable client socket for the group. */
  readonly socketBytes: number
}

/** Append the effects as one group to a real delta store in the temp dir and size them. */
async function publish(
  deltas: HostDeltaStore,
  commandId: string,
  effects: readonly HostDomainEffectDto[]
): Promise<Published> {
  if (effects.length === 0) return { envelopes: 0, journalBytes: 0, socketBytes: 0 }
  const validated = validateHostDomainEffectBatch(effects)
  if (!validated.ok) throw new Error(`effects invalid: ${JSON.stringify(validated.failures[0])}`)
  const before = deltas.getPosition().cursor
  const appended = deltas.appendGroup({
    commandId,
    effects: validated.prepared.map(({ input }) => input)
  })
  if (appended.kind !== 'appended') throw new Error(`append ${appended.kind}`)
  // Readers stop at the durable head: a group is invisible until its fsync.
  await deltas.awaitDurable()
  const after = deltas.getPosition().cursor
  let journalBytes = 0
  let socketBytes = 0
  for (let cursor = before + 1; cursor <= after; cursor += 1) {
    const stored = deltas.getByCursor(cursor)
    if (!stored) continue
    journalBytes += stored.retainedBytes
    socketBytes += socketFrameBytes(stored.envelope)
  }
  return { envelopes: after - before, journalBytes, socketBytes }
}

interface Row {
  readonly path: 'legacy' | 'index'
  readonly publication: string
  readonly ms: number
  readonly detail: string
}

const rows: Row[] = []
function report(path: Row['path'], publication: string, ms: number, detail: string): void {
  rows.push({ path, publication, ms, detail })
}

function table(): string {
  const lines = ['', 'runs-family re-projection goldens (median of ' + SAMPLES + ' samples)', '']
  lines.push('path   | publication                          | ms      | detail')
  lines.push('-------|--------------------------------------|---------|-------')
  for (const row of rows) {
    lines.push(
      `${row.path.padEnd(6)} | ${row.publication.padEnd(36)} | ${row.ms.toFixed(1).padStart(7)} | ${row.detail}`
    )
  }
  return lines.join('\n')
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('runs-family re-projection goldens', () => {
  let dataDir: string
  let deltas: HostDeltaStore
  let profile: Profile
  let models: HostThreadRecordModelled[]
  let summaries: HostProfileThreadSummary[]
  let liveRecord: HostProfileThread
  let liveModelIndex: number

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-runs-reprojection-golden-'))
    deltas = new HostDeltaStore({ dataDir, now: () => NOW_ISO, compactAfterRecords: 1_000_000 })
    profile = buildProfile(7)
    const built = timed(() => profile.records.map(modelOf), 1)
    models = built.result
    summaries = profile.records.map(summaryOf)
    liveModelIndex = profile.records.findIndex(
      (thread) => thread.appChatId === profile.liveThreadIds[0]
    )
    liveRecord = profile.records[liveModelIndex]!
    const total = models.reduce((count, model) => count + model.runs.total, 0)
    const busiest = Math.max(...models.map((model) => model.runs.total))
    const active = models.reduce(
      (count, model) => count + model.runs.candidates.filter((c) => c.rank.active === 1).length,
      0
    )
    report(
      'index',
      'model every thread (boot seed read)',
      built.ms,
      `${models.length} threads, ${total} runs, busiest ${busiest}, ${active} live`
    )
  }, TIMEOUT)

  afterAll(() => {
    console.log(table())
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  })

  it(
    'fixture has the observed shape',
    () => {
      const total = models.reduce((count, model) => count + model.runs.total, 0)
      expect(models).toHaveLength(THREADS)
      expect(total).toBe(RUNS)
      expect(total).toBeGreaterThan(HOST_PROFILE_RUN_PROJECTION_LIMIT)
      // No thread is cut: the index's refill never fires for this shape.
      expect(models.every((model) => model.runs.candidates.length === model.runs.total)).toBe(true)
      const window = hostPublicRunWindow(models)
      expect(window).toHaveLength(HOST_PROFILE_RUN_PROJECTION_LIMIT)
      // Invariant: possibly-live rows precede every terminal row in the window.
      const firstTerminal = window.findIndex((entry) => entry.candidate.rank.active === 0)
      expect(window.slice(firstTerminal).every((entry) => entry.candidate.rank.active === 0)).toBe(
        true
      )
      expect(firstTerminal).toBe(LIVE_THREADS)
    },
    TIMEOUT
  )

  describe('legacy publisher (1.9.8): reconciler tick = donor + projector + snapshot diff', () => {
    it(
      'boot replay: the first loaded window republishes the whole window to clients already holding it',
      async () => {
        // At reconciler start the catalogue window has not refreshed yet.
        const loading = legacyCapture(
          legacyStore(summaries, catalogueWindow(models, { complete: false, empty: true }))
        )
        const loaded = timed(() =>
          legacyCapture(legacyStore(summaries, catalogueWindow(models, { complete: true })))
        )
        const diff = timed(() => legacyDiff(loading.snapshot, loaded.result.snapshot))
        const counts = countEffects(diff.result)
        const published = await publish(deltas, 'legacy:boot', diff.result)
        report(
          'legacy',
          'boot: empty window -> loaded window',
          loaded.result.donorMs + loaded.result.projectorMs + diff.ms,
          `donor ${loaded.result.donorMs.toFixed(1)} + projector ${loaded.result.projectorMs.toFixed(1)} + diff ${diff.ms.toFixed(1)} ms; ` +
            `${JSON.stringify(counts)}; journal ${published.journalBytes} B, socket ${published.socketBytes} B/client; ` +
            `snapshot ${jsonBytes(loaded.result.snapshot)} B`
        )
        expect(counts['run:upsert']).toBe(HOST_PROFILE_RUN_PROJECTION_LIMIT)
        expect(counts['run:tombstone']).toBeUndefined()
        // The warning's text is the same loading or loaded; its time moved
        // from the empty window's 0 to the newest row's.
        expect(counts['warning:upsert']).toBe(1)
        expect(warningsIn(diff.result)[0]).toContain(HOST_PROFILE_RUN_WINDOW_WARNING_MESSAGE)
        expect(loading.snapshot.warnings.map((w) => w.message)).toEqual([
          HOST_PROFILE_RUN_WINDOW_WARNING_MESSAGE
        ])
      },
      TIMEOUT
    )

    it(
      'boot through the reconciler: the loaded window is the baseline, so a connected client receives nothing; a new run is published on its first loaded pass',
      async () => {
        const loading = legacyCapture(
          legacyStore(summaries, catalogueWindow(models, { complete: false, empty: true }))
        ).snapshot
        const loaded = legacyCapture(
          legacyStore(summaries, catalogueWindow(models, { complete: true }))
        ).snapshot
        const changed = withNewRun(liveRecord, 11)
        const withRun = legacyCapture(
          legacyStore(
            summaries.map((summary, index) =>
              index === liveModelIndex ? summaryOf(changed) : summary
            ),
            catalogueWindow(
              models.map((model, index) => (index === liveModelIndex ? modelOf(changed) : model)),
              { complete: true }
            )
          )
        ).snapshot
        let current = { snapshot: loading, complete: false }
        const passes: HostDomainEffectDto[][] = []
        const reconciler = new HostProjectionReconciler({
          captureSnapshot: () => current.snapshot,
          captureComplete: () => current.complete,
          fetchDeltas: () => {
            throw new Error('captures share one position')
          },
          publishEffects: (effects) => {
            passes.push([...effects])
            return {
              kind: 'published',
              position: { generation: 1, cursor: 1 },
              count: 0,
              results: []
            }
          },
          schedule: () => null,
          cancelScheduled: () => undefined
        })
        await reconciler.start()
        expect(await reconciler.reconcileNow()).toMatchObject({ reason: 'capture_incomplete' })
        current = { snapshot: loaded, complete: true }
        const start = performance.now()
        expect(await reconciler.reconcileNow()).toMatchObject({ kind: 'initialized' })
        const initializedMs = performance.now() - start
        expect(await reconciler.reconcileNow()).toMatchObject({ kind: 'unchanged' })
        expect(passes).toEqual([])
        const published = await publish(deltas, 'legacy:boot-reconciler', passes.flat())
        report(
          'legacy',
          'boot via reconciler (loading -> loaded)',
          initializedMs,
          `${JSON.stringify(countEffects(passes.flat()))}; journal ${published.journalBytes} B, socket ${published.socketBytes} B/client`
        )

        current = { snapshot: withRun, complete: true }
        expect(await reconciler.reconcileNow()).toMatchObject({ kind: 'published' })
        const newRunId = changed.runs![changed.runs!.length - 1]!.runId
        expect(passes).toHaveLength(1)
        expect(countEffects(passes[0]!)['run:upsert']).toBe(1)
        expect(passes[0]!.some((e) => e.family === 'run' && e.entityId === newRunId)).toBe(true)
        await reconciler.stop()
      },
      TIMEOUT
    )

    it(
      'steady tick: nothing changed costs a full capture and a double decode, publishes nothing',
      () => {
        const store = legacyStore(summaries, catalogueWindow(models, { complete: true }))
        const before = legacyCapture(store).snapshot
        const after = timed(() => legacyCapture(store))
        const diff = timed(() => legacyDiff(before, after.result.snapshot))
        report(
          'legacy',
          'steady tick (no change)',
          after.result.donorMs + after.result.projectorMs + diff.ms,
          `donor ${after.result.donorMs.toFixed(1)} + projector ${after.result.projectorMs.toFixed(1)} + diff ${diff.ms.toFixed(1)} ms; ${diff.result.length} effects`
        )
        expect(diff.result).toHaveLength(0)
        expect(after.result.snapshot.warnings.map((w) => w.warningId)).toEqual([WINDOWED_RUNS])
      },
      TIMEOUT
    )

    it(
      'completeness flap: the same rows under complete=false publish nothing',
      async () => {
        const complete = legacyCapture(
          legacyStore(summaries, catalogueWindow(models, { complete: true }))
        ).snapshot
        const refreshing = legacyCapture(
          legacyStore(summaries, catalogueWindow(models, { complete: false }))
        ).snapshot
        const toLoading = legacyDiff(complete, refreshing)
        const toComplete = legacyDiff(refreshing, complete)
        const published = await publish(deltas, 'legacy:flap', [...toLoading, ...toComplete])
        report(
          'legacy',
          'flap: complete -> refreshing -> complete',
          0,
          `${JSON.stringify(countEffects([...toLoading, ...toComplete]))}; journal ${published.journalBytes} B, socket ${published.socketBytes} B/client`
        )
        // Before the stable text: one warning upsert per flip, "still loading"
        // then "intentionally windowed" (88 in seven minutes on 1.9.8).
        expect(toLoading).toEqual([])
        expect(toComplete).toEqual([])
        expect(refreshing.warnings).toEqual(complete.warnings)
        // The run rows themselves are identical across the flip.
        expect(refreshing.runs).toEqual(complete.runs)
      },
      TIMEOUT
    )

    it(
      'one new live run: the window shifts by one row',
      async () => {
        const before = legacyCapture(
          legacyStore(summaries, catalogueWindow(models, { complete: true }))
        ).snapshot
        const changed = withNewRun(liveRecord, 11)
        const nextModels = models.map((model, index) =>
          index === liveModelIndex ? modelOf(changed) : model
        )
        const nextSummaries = summaries.map((summary, index) =>
          index === liveModelIndex ? summaryOf(changed) : summary
        )
        const after = legacyCapture(
          legacyStore(nextSummaries, catalogueWindow(nextModels, { complete: true }))
        ).snapshot
        const effects = legacyDiff(before, after)
        const counts = countEffects(effects)
        const published = await publish(deltas, 'legacy:new-run', effects)
        report(
          'legacy',
          'one new live run',
          0,
          `${JSON.stringify(counts)}; journal ${published.journalBytes} B, socket ${published.socketBytes} B/client`
        )
        expect(counts['run:upsert']).toBe(1)
        expect(counts['run:tombstone']).toBe(1)
        expectNoLiveTombstone(effects, nextModels)
        // The legacy diff still compares a warning's time, which the new run
        // moved; the text no longer carries the total (16000 -> 16001).
        expect(counts['warning:upsert']).toBe(1)
        expect(warningsIn(effects)[0]).toContain(HOST_PROFILE_RUN_WINDOW_WARNING_MESSAGE)
      },
      TIMEOUT
    )

    it(
      '10k-run single thread: the donor sorts the catalogue window, the projector decodes 1,800 rows',
      () => {
        const chonk = buildSingleThread(3)
        const model = timed(() => modelOf(chonk), 1)
        const store = legacyStore(
          [summaryOf(chonk)],
          catalogueWindow([model.result], { complete: true })
        )
        const capture = timed(() => legacyCapture(store))
        report(
          'legacy',
          '10k-run thread: capture',
          capture.result.donorMs + capture.result.projectorMs,
          `donor ${capture.result.donorMs.toFixed(1)} + projector ${capture.result.projectorMs.toFixed(1)} ms; model ${model.ms.toFixed(1)} ms; ` +
            `${capture.result.snapshot.runs.length} runs, ${jsonBytes(capture.result.snapshot)} B snapshot`
        )
        expect(model.result.runs.total).toBe(SINGLE_THREAD_RUNS)
        expect(model.result.runs.candidates).toHaveLength(HOST_PROFILE_RUN_PROJECTION_LIMIT)
        expect(capture.result.snapshot.runs).toHaveLength(HOST_PROFILE_RUN_PROJECTION_LIMIT)
        expect(capture.result.snapshot.warnings.map((w) => w.message)).toEqual([
          HOST_PROFILE_RUN_WINDOW_WARNING_MESSAGE
        ])
      },
      TIMEOUT
    )
  })

  describe('public window index (HEAD, once seeded): publication = one prepare', () => {
    let index: HostPublicWindowIndex

    async function prepare(
      label: string,
      changes: Parameters<HostPublicWindowIndex['prepare']>[0]
    ): Promise<{ transaction: HostPublicWindowTransaction; ms: number }> {
      const start = performance.now()
      const transaction = index.prepare(changes, { generatedAt: NOW_ISO })
      const ms = performance.now() - start
      const counts = countEffects(transaction.effects)
      const published = await publish(deltas, `index:${label}`, transaction.effects)
      report(
        'index',
        label,
        ms,
        `${JSON.stringify(counts)}; complete=${transaction.complete} refill=${transaction.refill.length}; ` +
          `journal ${published.journalBytes} B, socket ${published.socketBytes} B/client`
      )
      transaction.commit()
      return { transaction, ms }
    }

    beforeAll(() => {
      index = new HostPublicWindowIndex()
      const seeded = timed(
        () =>
          index.seed(
            models.map((model) => ({ kind: 'model' as const, model })),
            { generatedAt: NOW_ISO }
          ),
        1
      )
      const wire = index.wire()
      report(
        'index',
        'seed (restart: publishes nothing)',
        seeded.ms,
        `complete=${seeded.result.complete}; wire runs ${wire.get('run')!.size}, threads ${wire.get('thread')!.size}; ` +
          `re-snapshot ${jsonBytes([...wire.values()].map((rows) => [...rows.values()]))} B/client`
      )
      expect(seeded.result.complete).toBe(true)
      expect(seeded.result.refill).toEqual([])
    }, TIMEOUT)

    it(
      'heartbeat persist of a live thread publishes no run rows and no warning',
      async () => {
        const { transaction } = await prepare('heartbeat persist (live thread)', [
          { kind: 'model', model: modelOf(heartbeat(liveRecord)) }
        ])
        const counts = countEffects(transaction.effects)
        expect(counts['run:upsert']).toBeUndefined()
        expect(counts['run:tombstone']).toBeUndefined()
        expect(counts['warning:upsert']).toBeUndefined()
        expect(counts['thread:upsert']).toBe(1)
        expect(transaction.complete).toBe(true)
      },
      TIMEOUT
    )

    it(
      'one new live run enters the window on the same publication and displaces one tail row',
      async () => {
        const changed = withNewRun(heartbeat(liveRecord), 13)
        const { transaction } = await prepare('one new live run', [
          { kind: 'model', model: modelOf(changed) }
        ])
        const counts = countEffects(transaction.effects)
        const newRunId = changed.runs![changed.runs!.length - 1]!.runId
        expect(counts['run:upsert']).toBe(1)
        expect(counts['run:tombstone']).toBe(1)
        expectNoLiveTombstone(transaction.effects, [
          ...models.filter((_, at) => at !== liveModelIndex),
          modelOf(changed)
        ])
        // The warning says nothing new: before, its text carried the total
        // (16000 -> 16001) and its time moved, one upsert per new run.
        expect(counts['warning:upsert']).toBeUndefined()
        expect(transaction.complete).toBe(true)
        expect(transaction.refill).toEqual([])
        expect(transaction.effects.some((e) => e.family === 'run' && e.entityId === newRunId)).toBe(
          true
        )
        expect(index.wire().get('warning')!.get(WINDOWED_RUNS)).toMatchObject({
          message: HOST_PROFILE_RUN_WINDOW_WARNING_MESSAGE
        })
        // The live row stays in the window after commit.
        expect(index.wire().get('run')!.has(newRunId)).toBe(true)
      },
      TIMEOUT
    )

    it(
      'a cold thread persisting one new run costs the same shape',
      async () => {
        const cold = profile.records[THREADS - 1]!
        const coldModel = modelOf(withNewRun(cold, 17))
        const { transaction } = await prepare('cold thread, one new live run', [
          { kind: 'model', model: coldModel }
        ])
        const counts = countEffects(transaction.effects)
        expect(counts['run:upsert']).toBe(1)
        expect(counts['run:tombstone']).toBe(1)
        expectNoLiveTombstone(transaction.effects, [...models.slice(0, THREADS - 1), coldModel])
        expect(counts['warning:upsert']).toBeUndefined()
        expect(transaction.complete).toBe(true)
      },
      TIMEOUT
    )

    it(
      '10k-run single thread: model and prepare',
      () => {
        const chonk = buildSingleThread(5)
        const model = timed(() => modelOf(chonk), 1)
        const single = new HostPublicWindowIndex()
        const seeded = timed(
          () => single.seed([{ kind: 'model', model: model.result }], { generatedAt: NOW_ISO }),
          1
        )
        const persisted = modelOf(withNewRun(chonk, 19))
        const prepared = timed(() => {
          const transaction = single.prepare([{ kind: 'model', model: persisted }], {
            generatedAt: NOW_ISO
          })
          transaction.abort()
          return transaction
        }, 3)
        report(
          'index',
          '10k-run thread: model + seed + prepare',
          model.ms + seeded.ms + prepared.ms,
          `model ${model.ms.toFixed(1)} + seed ${seeded.ms.toFixed(1)} + prepare ${prepared.ms.toFixed(1)} ms; ` +
            `${JSON.stringify(countEffects(prepared.result.effects))}; complete=${prepared.result.complete}`
        )
        expect(model.result.runs.candidates).toHaveLength(HOST_PROFILE_RUN_PROJECTION_LIMIT)
        // A single thread holding more than the window is cut by construction;
        // its window is complete because every row it can place is its own.
        expect(seeded.result.complete).toBe(true)
        expect(countEffects(prepared.result.effects)['run:upsert']).toBe(1)
      },
      TIMEOUT
    )
  })
})
