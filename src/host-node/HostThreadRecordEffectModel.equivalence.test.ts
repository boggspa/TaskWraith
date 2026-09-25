/**
 * The thread record effect model against the donor pipeline (Independent
 * Threads M4, slice 4).
 *
 * The donor is what the Host shows once a persist settles: the mirror holds
 * the projection the store's publication observed, and the run window holds
 * the catalogue's first 1,800 run summaries. The model sees only the thread
 * the publication received. Both are driven through a real profile store, so
 * the committed thread includes the store's repairs and stamps.
 *
 * The fast tier replays seeded records against a reference catalogue read
 * from the files the store wrote. The slow tier indexes the same files with
 * the real decoder and SQLite index, which proves the reference.
 *
 * The public window index (slice 5) is driven change by change against the
 * same donor: after each persist or delete, a client that applied its effects
 * holds the donor's settled snapshot, and the effects are the legacy snapshot
 * diff's.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { projectHostProfileDomainSnapshot } from '../host-runtime/HostProfileDomainProjection'
import {
  HOST_PROFILE_CHATS_DIRECTORY,
  HostProfileDomainStore,
  type HostCatalogueRunWindow,
  type HostProfileRun,
  type HostProfileThread
} from '../host-runtime/HostProfileDomainStore'
import { scopeHostMutationObservationFamilies } from '../host-runtime/HostMutationObservationScope'
import { projectHostSnapshot } from '../host-runtime/HostSnapshotProjector'
import {
  modelHostThreadRecordEffects,
  type HostThreadRecordModelled
} from '../host-runtime/HostThreadRecordEffectModel'
import type { HostDomainEffectDto } from '../host-runtime/HostDomainDeltaPublisher'
import {
  assembleHostPublicWindowFamilies,
  HOST_WARNING_PROJECTION_WITHHELD,
  hostPublicRunWindow,
  HostPublicWindowIndex,
  type HostPublicWindowChange
} from '../host-runtime/HostPublicWindowIndex'
import {
  diffHostSnapshotDomainEffects,
  hostSnapshotEntityId
} from '../host-runtime/HostSnapshotDomainEffectDiff'
import {
  decodeHostThreadRecordTransferBody,
  publishHostThreadRecordTransfer,
  verifyHostThreadRecordTransfer
} from '../host-runtime/HostThreadRecordTransfer'
import type { ThreadCatalogueMirror } from '../host-shared/thread-catalogue/ThreadCatalogueMirror'
import type { ThreadCatalogueProjection } from '../host-shared/thread-catalogue/ThreadCatalogue'
import { projectThreadCatalogueRecord } from '../main/store/ThreadCatalogueFromRecord'
import { normalizeCatalogueChatRecord } from '../main/store/ThreadCatalogueNormalize'
import { projectThreadCatalogueRunSummary } from '../main/store/ThreadCatalogueRunSummary'
import { ThreadCatalogueWorkerService } from '../main/store/ThreadCatalogueWorkerService'
import {
  HOST_WARNING_PROJECTION_WINDOWED,
  type HostHealthProjection,
  type HostSnapshot
} from '../shared/hostProtocol'
import { hostCatalogueSummaries, projectHostCatalogueThread } from './ThreadCatalogueHostMirror'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const NOW = T0 + 86_400_000
const WINDOW = 1_800
const HEALTH: HostHealthProjection = {
  hostStatus: 'ok',
  connectionPhase: 'live',
  supervised: true,
  freshness: 'live'
}
const POSITION = {
  generation: 1,
  cursor: 7,
  freshness: 'live' as const,
  generatedAt: '2026-01-02T00:00:00.000Z'
}
const RECOVERY = { reopenStatus: 'clean' as const }

const temporaryPaths: string[] = []
function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  while (temporaryPaths.length > 0) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

// ── seeded records ──────────────────────────────────────────────────────────

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
type Rand = () => number
const pick = <T>(r: Rand, values: readonly T[]): T => values[Math.floor(r() * values.length)]!
const chance = (r: Rand, p: number): boolean => r() < p
const int = (r: Rand, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()

const ASTRAL = String.fromCodePoint(0x1f600)
// Above the surrogates, so UTF-16 and UTF-8 order it differently against ASTRAL
// (U+FFFF itself is no filename on APFS).
const FULLWIDTH_A = String.fromCharCode(0xff21)
const CJK = String.fromCharCode(0x4e00)
const BELL = String.fromCharCode(7)
const THREAD_IDS = [
  'chat-a',
  'chat-b',
  'Chat-C',
  'z',
  `e${String.fromCharCode(0xe9)}`,
  `x${ASTRAL}`,
  `x${FULLWIDTH_A}`,
  'chat-10'
]
const TIMES: (string | undefined)[] = [
  undefined,
  iso(0),
  iso(1_000),
  iso(1_000),
  iso(60_000),
  '1969-12-31T23:59:59.000Z',
  'not a date',
  '2026-01-01',
  '2026-01-01T00:00:00'
]
const STATUSES: (string | undefined)[] = [
  undefined,
  'running',
  'Running',
  'starting',
  'queued',
  'success',
  'succeeded',
  'completed',
  'failed',
  'Error',
  'cancelled',
  'canceled',
  'success_with_warnings',
  'weird'
]

function seededRun(r: Rand, runId: string, last: boolean): Record<string, unknown> {
  const run: Record<string, unknown> = { runId }
  const set = (key: string, value: unknown): void => {
    if (value !== undefined) run[key] = value
  }
  set(
    'provider',
    pick(r, ['codex', 'claude', 'ollama', '', undefined, ...(last ? [] : [5, 'p'.repeat(130)])])
  )
  set('status', pick(r, STATUSES))
  set('startedAt', pick(r, TIMES))
  set('endedAt', pick(r, TIMES))
  set('requestedModel', pick(r, ['gpt-5', '', undefined, { tier: 'x' }, 'm'.repeat(600)]))
  set('errorCode', pick(r, [undefined, undefined, 'provider_failed', 'provider_setup_unavailable']))
  set('warningSummaries', pick(r, [undefined, [], ['boom'], ['first', 'second']]))
  set(
    'usage',
    pick(r, [
      undefined,
      { inputTokens: 5, outputTokens: 7 },
      { inputTokens: 0 },
      { cacheReadTokens: 3, estimatedCostUsd: 0.5 }
    ])
  )
  set('ensembleRoundId', pick(r, [undefined, undefined, 'round-1', 'round-2']))
  set('phase', pick(r, [undefined, 'streaming']))
  if (chance(r, 0.2)) run.providerThreadId = pick(r, ['pt-1', CJK.repeat(512)])
  if (chance(r, 0.2)) run.providerSessionId = 'ps-1'
  if (chance(r, 0.1)) run.actualModel = CJK.repeat(512)
  if (chance(r, 0.1))
    run.runDiff = { createdFiles: [{ path: 'a' }, { path: 'a' }], modifiedFiles: [{ path: 'b' }] }
  if (chance(r, 0.1) && run.provider === 'ollama') run.stats = { ollamaMemoryPeakRssGb: 1.5 }
  if (chance(r, 0.1)) run.exitCode = pick(r, [0, 1, -0])
  if (chance(r, 0.1)) run.cancelled = true
  return run
}

function seededEnsemble(r: Rand): Record<string, unknown> {
  const seats = Array.from({ length: int(r, 0, 4) }, (_, index) => {
    if (chance(r, 0.15)) return { id: pick(r, ['', 'p1']), provider: 5 }
    const seat: Record<string, unknown> = {
      id: pick(r, ['p1', 'p2', 'p3', 'p1']),
      provider: pick(r, ['codex', 'claude']),
      role: pick(r, ['worker', 'boss']),
      order: index,
      enabled: chance(r, 0.8)
    }
    if (chance(r, 0.4)) seat.model = 'm1'
    if (chance(r, 0.3)) seat.reasoningEffort = 'high'
    if (chance(r, 0.3)) seat.permissionPresetId = pick(r, ['plan', 'default'])
    if (chance(r, 0.2)) seat.stageRole = 'plan'
    return seat
  })
  const ensemble: Record<string, unknown> = {
    orchestrationMode: pick(r, ['sequential', 'turn_bound', undefined]),
    fanoutPolicy: pick(r, ['all', 'single', undefined]),
    participants: seats
  }
  if (chance(r, 0.8)) {
    const round: Record<string, unknown> = {
      status: pick(r, ['running', 'active', 'Running', 'completed', 'failed', 'cancelled', 'weird'])
    }
    if (chance(r, 0.9)) round[chance(r, 0.8) ? 'roundId' : 'id'] = pick(r, ['round-1', 'round-2'])
    round.participants = Array.from({ length: int(r, 0, 3) }, () => {
      const seat: Record<string, unknown> = { participantId: pick(r, ['p1', 'p2', 'p3']) }
      if (chance(r, 0.6)) seat.runId = pick(r, ['seat-run-1', 'seat-run-2', 'run-0'])
      if (chance(r, 0.6)) seat.status = pick(r, ['running', 'done', 's'.repeat(80)])
      return seat
    })
    if (chance(r, 0.5)) round.activeParticipantId = pick(r, ['p1', 'p2'])
    if (chance(r, 0.4)) round.startedAt = pick(r, TIMES)
    if (chance(r, 0.4)) round.endedAt = pick(r, TIMES)
    if (chance(r, 0.1)) round.orchestrationMode = 'm'.repeat(300)
    if (chance(r, 0.3)) round.continuationHops = int(r, 0, 3)
    ensemble.activeRound = round
  }
  return ensemble
}

function seededRecord(r: Rand, appChatId: string, runCount: number): Record<string, unknown> {
  const record: Record<string, unknown> = {
    appChatId,
    title: pick(r, ['Chat', 'T'.repeat(200), `Emoji ${ASTRAL}`]),
    updatedAt: pick(r, [1, T0, T0 + 5_000]),
    messages: Array.from({ length: int(r, 0, 4) }, (_, index) => ({
      id: `m${index}`,
      role: pick(r, ['user', 'assistant', 'system', 'tool', 'error']),
      content: pick(r, ['hello', '', 'x'.repeat(1_100), `ring${BELL}`, 'reply']),
      timestamp: pick(r, [iso(index), 'later'])
    }))
  }
  // Fields the store's decoder repairs: scope, runs, createdAt, archived.
  const scope = pick(r, ['global', 'workspace', 'repair-to-workspace', 'absent'])
  if (scope === 'global') record.scope = 'global'
  if (scope === 'workspace' || scope === 'repair-to-workspace') {
    if (scope === 'workspace') record.scope = 'workspace'
    else if (chance(r, 0.5)) record.scope = 'global'
    record.workspaceId = 'ws-1'
    record.workspacePath = '/workspace/one'
  }
  const runs = Array.from({ length: runCount }, (_, index) =>
    seededRun(r, `run-${index}`, index === runCount - 1)
  )
  if (runs.length > 0 || chance(r, 0.7)) record.runs = runs
  const createdAt = pick(r, [1, T0, -1, 'x', undefined])
  if (createdAt !== undefined) record.createdAt = createdAt
  const archived = pick(r, [true, false, undefined, 'yes'])
  if (archived !== undefined) record.archived = archived
  if (chance(r, 0.3)) record.persistenceRevision = pick(r, [0, 9, -1, 1.5])
  if (chance(r, 0.5)) record.provider = pick(r, ['codex', 'claude', ''])
  if (chance(r, 0.3)) record.pinned = pick(r, [true, false])
  if (chance(r, 0.3)) record.workflowMode = pick(r, ['plan', 'normal'])
  if (chance(r, 0.4))
    record.providerMetadata = pick(r, [
      { selectedModelType: 'gpt-5', reasoningEffort: 'high', permissionPresetId: 'read_only' },
      { permissionPresetId: 'workspace_write' },
      {}
    ])
  if (chance(r, 0.5)) {
    record.chatKind = 'ensemble'
    record.ensemble = seededEnsemble(r)
  }
  if (chance(r, 0.15))
    record.activeGoal = {
      id: 'goal-1',
      objective: pick(r, ['ship it', 'o'.repeat(2_100)]),
      status: pick(r, ['active', 'paused']),
      mode: 'autonomous',
      runtimeLedger: {
        startedAt: iso(0),
        intervals: [{ status: 'active', startedAt: iso(0) }]
      }
    }
  if (chance(r, 0.1)) record.externalProviderThreadImport = { nativeResumeAllowed: false }
  // Fields the catalogue projection refuses.
  if (chance(r, 0.04)) record.parentChatId = pick(r, ['', 'p'.repeat(300)])
  if (chance(r, 0.04) && runs.length > 0) runs[runs.length - 1]!.status = 's'.repeat(70)
  // A credential-shaped preview fails the whole projector input.
  if (chance(r, 0.02))
    (record.messages as Record<string, unknown>[]).push({
      id: 'leak',
      role: 'user',
      content: 'ghp_secret',
      timestamp: 'now'
    })
  return record
}

// ── the donor harness ───────────────────────────────────────────────────────

interface Profile {
  readonly path: string
  readonly store: HostProfileDomainStore
  /** The mirror's rows, in the order the mirror first saw each thread. */
  readonly mirrorRows: Map<string, ThreadCatalogueProjection>
  /** The thread each successful publication received. */
  readonly committed: Map<string, HostProfileThread>
  /** The thread the last publication received, committed or not. */
  lastPublished: HostProfileThread | null
  runWindow: HostCatalogueRunWindow | null
}

function openProfile(): Profile {
  const path = temporaryDirectory('thread-record-effect-model-')
  const profile: Profile = {
    path,
    mirrorRows: new Map(),
    committed: new Map(),
    lastPublished: null,
    runWindow: null,
    store: undefined as unknown as HostProfileDomainStore
  }
  const mirror = {
    projections: () => [...profile.mirrorRows.values()]
  } as unknown as ThreadCatalogueMirror
  ;(profile as { store: HostProfileDomainStore }).store = new HostProfileDomainStore({
    profilePath: path,
    authority: { assertProfileAuthority: () => {} },
    now: () => NOW,
    threadSummarySource: () => hostCatalogueSummaries(mirror),
    runSummarySource: () => profile.runWindow ?? { entries: [], total: 0, complete: true },
    // As HostNodeProductionServer publishes: project before the write, and
    // let the mirror observe the projection once the write lands.
    beginThreadPublication: (thread) => {
      profile.lastPublished = thread
      const projection = projectHostCatalogueThread(thread)
      return {
        commit: () => {
          profile.mirrorRows.set(thread.appChatId, projection)
          profile.committed.set(thread.appChatId, thread)
        },
        abort: () => {}
      }
    }
  })
  return profile
}

type PersistOutcome = 'committed' | 'refused' | 'invalid'

function persistNew(profile: Profile, record: Record<string, unknown>): PersistOutcome {
  expect(profile.committed.has(record.appChatId as string)).toBe(false)
  return persistRecord(profile, record)
}

/** Persist over the thread's committed revision, as a client's save does. */
function persistRecord(profile: Profile, record: Record<string, unknown>): PersistOutcome {
  const threadId = record.appChatId as string
  profile.lastPublished = null
  try {
    profile.store.persistThreadRecord({
      threadId,
      record,
      expectedRevision: profile.committed.get(threadId)?.persistenceRevision ?? 0
    })
    return 'committed'
  } catch (error) {
    if ((error as Error).message === 'Host thread metadata projection is invalid') return 'refused'
    expect(profile.lastPublished).toBeNull()
    return 'invalid'
  }
}

/** Delete an idle thread through the store; the mirror observes it gone. */
function deleteThread(profile: Profile, threadId: string): boolean {
  try {
    const deleted = profile.store.deleteThreadRecord({
      threadId,
      expectedRevision: profile.committed.get(threadId)!.persistenceRevision ?? 0
    })
    expect(deleted).toBe(true)
  } catch (error) {
    if ((error as Error).message === 'Thread is active') return false
    throw error
  }
  profile.mirrorRows.delete(threadId)
  profile.committed.delete(threadId)
  return true
}

/**
 * Publish a record already in the store's canonical shape as its persist
 * would, without the write's fsyncs: for tests about the windows, not about
 * what the store commits.
 */
function publishCanonical(profile: Profile, thread: Record<string, unknown>): void {
  const committed = {
    persistenceRevision: 0,
    updatedAt: NOW,
    ...thread
  } as unknown as HostProfileThread
  writeFileSync(
    join(profile.path, HOST_PROFILE_CHATS_DIRECTORY, `${committed.appChatId}.json`),
    JSON.stringify(committed)
  )
  profile.mirrorRows.set(committed.appChatId, projectHostCatalogueThread(committed))
  profile.committed.set(committed.appChatId, committed)
}

/** Remove a thread published by publishCanonical, as its deletion would. */
function unpublish(profile: Profile, threadId: string): void {
  rmSync(join(profile.path, HOST_PROFILE_CHATS_DIRECTORY, `${threadId}.json`))
  profile.mirrorRows.delete(threadId)
  profile.committed.delete(threadId)
}

// ── the reference catalogue (what the decoder and index store) ───────────────

interface IndexedRun {
  readonly threadId: string
  readonly ordinal: number
  readonly runId: string
  readonly summary: Record<string, unknown>
  readonly rank: { active: 0 | 1; recency: number }
}

/** threadCatalogueDecoder's preview() rank before slice 4, then run_summary_order's coercion. */
function referenceRank(record: Record<string, unknown>): { active: 0 | 1; recency: number } {
  const result: Record<string, unknown> = {}
  if (typeof record.runId === 'string') {
    const ended = Date.parse(String(record.endedAt ?? ''))
    const started = Date.parse(String(record.startedAt ?? ''))
    result.catalogueActive =
      !['completed', 'success', 'succeeded', 'failed', 'error', 'cancelled', 'canceled'].includes(
        String(record.status ?? '').toLowerCase()
      ) && !Number.isFinite(ended)
    result.catalogueRecency = Number.isFinite(ended)
      ? ended
      : Number.isFinite(started)
        ? started
        : 0
  }
  const preview = JSON.parse(JSON.stringify(result)) as Record<string, unknown>
  return {
    active: preview.catalogueActive === true ? 1 : 0,
    recency: Number.isFinite(preview.catalogueRecency) ? (preview.catalogueRecency as number) : 0
  }
}

/** The runs the catalogue indexes for one thread file. */
function referenceIndexedRuns(profile: Profile, threadId: string): IndexedRun[] {
  const raw = JSON.parse(
    readFileSync(join(profile.path, HOST_PROFILE_CHATS_DIRECTORY, `${threadId}.json`), 'utf8')
  )
  const chat = normalizeCatalogueChatRecord(raw, () => undefined, 'reference-runtime')
  return (chat.runs ?? []).map((run, ordinal) => {
    const summary = JSON.parse(JSON.stringify(projectThreadCatalogueRunSummary(run)))
    return { threadId, ordinal, runId: summary.runId, summary, rank: referenceRank(summary) }
  })
}

/** ORDER BY active DESC, recency DESC, chat_id (BINARY), ordinal. */
function referenceOrder(left: IndexedRun, right: IndexedRun): number {
  if (left.rank.active !== right.rank.active) return right.rank.active - left.rank.active
  if (left.rank.recency !== right.rank.recency)
    return left.rank.recency > right.rank.recency ? -1 : 1
  const chats = Buffer.compare(Buffer.from(left.threadId), Buffer.from(right.threadId))
  return chats !== 0 ? chats : left.ordinal - right.ordinal
}

// ── the model side ──────────────────────────────────────────────────────────

interface WindowKey {
  readonly threadId: string
  readonly runId: string
}

/** The run window from the models alone: every thread's candidates, merged. */
function modelWindow(models: readonly HostThreadRecordModelled[]): WindowKey[] {
  return hostPublicRunWindow(models).map((entry) => ({
    threadId: entry.threadId,
    runId: entry.candidate.runId
  }))
}

type Families = ReturnType<typeof projectHostProfileDomainSnapshot>
type ModelledFamilies = Pick<Families, 'threads' | 'runs' | 'rounds' | 'participants' | 'warnings'>

function donorFamilies(profile: Profile): Families {
  return projectHostProfileDomainSnapshot({ store: profile.store, health: HEALTH, providers: [] })
}

/** The wire snapshot of the five families the models decide, the rest held empty. */
function wire(families: ModelledFamilies) {
  return projectHostSnapshot({
    health: HEALTH,
    workspaces: [],
    providers: [],
    missions: [],
    questions: [],
    approvals: [],
    schedules: [],
    artifacts: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    threads: families.threads,
    runs: families.runs,
    rounds: families.rounds,
    participants: families.participants,
    warnings: families.warnings,
    position: POSITION,
    recovery: RECOVERY
  })
}

function modelsOf(profile: Profile): HostThreadRecordModelled[] {
  return [...profile.mirrorRows.keys()].map((threadId) => {
    const model = modelHostThreadRecordEffects(profile.committed.get(threadId)!)
    if (model.kind !== 'modelled') throw new Error(`committed thread ${threadId} was refused`)
    return model
  })
}

/**
 * Settle the donor on the reference catalogue and compare every family and
 * the wire snapshot with the models' assembly. Returns the models.
 */
function expectEquivalent(profile: Profile): HostThreadRecordModelled[] {
  const models = modelsOf(profile)
  const indexed = models.flatMap((model) => referenceIndexedRuns(profile, model.threadId))
  for (const model of models) {
    const reference = indexed.filter((run) => run.threadId === model.threadId)
    expect(model.runs.total).toBe(reference.length)
    const byOrdinal = new Map(reference.map((run) => [run.ordinal, run]))
    for (const candidate of model.runs.candidates) {
      const expected = byOrdinal.get(candidate.ordinal)!
      expect(JSON.stringify(candidate.summary)).toBe(JSON.stringify(expected.summary))
      expect(candidate.rank).toEqual(expected.rank)
      expect(candidate.runId).toBe(expected.runId)
    }
  }
  const catalogueWindow = [...indexed].sort(referenceOrder).slice(0, WINDOW)
  const window = modelWindow(models)
  expect(window).toEqual(
    catalogueWindow.map((run) => ({ threadId: run.threadId, runId: run.runId }))
  )
  profile.runWindow = {
    entries: catalogueWindow.map((run) => ({
      chatId: run.threadId,
      run: run.summary as unknown as HostProfileRun
    })),
    total: indexed.length,
    complete: true
  }
  const donor = donorFamilies(profile)
  const assembled = assembleHostPublicWindowFamilies(models)
  for (const family of ['threads', 'runs', 'rounds', 'participants', 'warnings'] as const) {
    expect(JSON.stringify(assembled[family]), family).toBe(JSON.stringify(donor[family]))
  }
  expect(wire(assembled)).toEqual(wire(donor))
  return models
}

// ── fast tier ───────────────────────────────────────────────────────────────

describe('thread record effect model ≡ donor pipeline (reference catalogue)', () => {
  it('matches the settled donor over seeded profiles, including repaired and refused records', () => {
    let committed = 0
    let refused = 0
    let repaired = 0
    let privacyFailures = 0
    for (let seed = 1; seed <= 200; seed += 1) {
      const r = mulberry32(seed)
      const profile = openProfile()
      const ids = [...THREAD_IDS].sort(() => r() - 0.5).slice(0, int(r, 1, 6))
      for (const id of ids) {
        const record = seededRecord(r, id, int(r, 0, 7))
        const outcome = persistNew(profile, record)
        if (outcome === 'refused') {
          refused += 1
          // The publication threw before the write: the model refuses the same thread.
          expect(modelHostThreadRecordEffects(profile.lastPublished!)).toMatchObject({
            kind: 'refused',
            threadId: id,
            errorCode: 'thread_record_persist_failed'
          })
          continue
        }
        expect(outcome).toBe('committed')
        committed += 1
        const thread = profile.committed.get(id)!
        // No verified transfer: a normal write stamps the store's clock.
        expect(thread.updatedAt).toBe(NOW)
        if (record.runs === undefined || record.createdAt !== thread.createdAt) repaired += 1
      }
      if (profile.mirrorRows.size === 0) continue
      const models = expectEquivalent(profile)
      if (!wire(assembleHostPublicWindowFamilies(models)).ok) privacyFailures += 1
    }
    // The corpus reaches every class it claims to.
    expect(committed).toBeGreaterThan(500)
    expect(refused).toBeGreaterThan(20)
    expect(repaired).toBeGreaterThan(200)
    expect(privacyFailures).toBeGreaterThan(3)
  }, 120_000)

  it('matches across the run window: other threads’ runs displace a thread’s, and its round loses them', () => {
    const r = mulberry32(99)
    const profile = openProfile()
    for (const [index, id] of ['heavy-a', 'heavy-b', 'heavy-c'].entries()) {
      const runs = Array.from({ length: 700 }, (_, ordinal) => ({
        runId: `run-${ordinal}`,
        provider: 'codex',
        status: pick(r, ['success', 'failed', 'running']),
        startedAt: iso(ordinal * 3 + index),
        ...(chance(r, 0.8) ? { endedAt: iso(ordinal * 3 + index + 1) } : {}),
        ...(chance(r, 0.5) ? { ensembleRoundId: 'round-1' } : {})
      }))
      expect(
        persistNew(profile, {
          appChatId: id,
          scope: 'global',
          title: id,
          updatedAt: T0,
          createdAt: 1,
          archived: false,
          chatKind: 'ensemble',
          ensemble: {
            orchestrationMode: 'sequential',
            fanoutPolicy: 'all',
            participants: [
              { id: 'p1', provider: 'codex', role: 'worker', order: 0, enabled: true }
            ],
            activeRound: {
              roundId: 'round-1',
              status: 'running',
              participants: [{ participantId: 'p1', runId: 'seat-run' }]
            }
          },
          messages: [],
          runs
        })
      ).toBe('committed')
    }
    const models = expectEquivalent(profile)
    const window = modelWindow(models)
    const perThread = models.map(
      (model) => window.filter((key) => key.threadId === model.threadId).length
    )
    expect(perThread.reduce((sum, count) => sum + count, 0)).toBe(WINDOW)
    expect(Math.min(...perThread)).toBeLessThan(700)
    const donor = donorFamilies(profile)
    let displaced = 0
    for (const model of models) {
      const round = donor.rounds.find((row) => row.threadId === model.threadId)!
      const inWindow = new Set(
        window.filter((key) => key.threadId === model.threadId).map((key) => key.runId)
      )
      const members = model.runs.candidates.filter((candidate) => candidate.roundMember)
      displaced += members.filter((candidate) => !inWindow.has(candidate.runId)).length
      // The round carries its seat's run and exactly its windowed members.
      expect(round.providerRunIds).toEqual(
        [
          'seat-run',
          ...members
            .filter((candidate) => inWindow.has(candidate.runId))
            .map((candidate) => candidate.runId)
        ].sort()
      )
    }
    expect(displaced).toBeGreaterThan(0)
  })

  it('matches the round window: more live rounds than it holds drops one, and its activeRoundId', () => {
    const profile = openProfile()
    mkdirSync(join(profile.path, HOST_PROFILE_CHATS_DIRECTORY), { recursive: true })
    // 1,801 live rounds and two terminal ones.
    const live = (index: number): boolean => index % 1_000 !== 1
    for (let index = 0; index < WINDOW + 3; index += 1) {
      publishCanonical(profile, {
        appChatId: `round-thread-${String(index).padStart(4, '0')}`,
        scope: 'global',
        title: 'Round thread',
        updatedAt: T0,
        createdAt: 1,
        archived: false,
        chatKind: 'ensemble',
        ensemble: {
          orchestrationMode: 'sequential',
          fanoutPolicy: 'all',
          participants: [{ id: 'p1', provider: 'codex', role: 'worker', order: 0, enabled: true }],
          activeRound: {
            roundId: `round-${index}`,
            status: live(index) ? 'running' : 'completed',
            startedAt: iso(index % 50),
            participants: [{ participantId: 'p1' }]
          }
        },
        messages: [],
        runs: live(index) ? [{ runId: `r-${index}`, status: 'running', startedAt: iso(0) }] : []
      })
    }
    const models = expectEquivalent(profile)
    expect(models.filter((model) => model.round?.live)).toHaveLength(WINDOW + 1)
    const donor = donorFamilies(profile)
    expect(donor.warnings.map((warning) => warning.warningId)).toContain(
      `${HOST_WARNING_PROJECTION_WINDOWED}:rounds`
    )
    // The live round the window drops leaves its thread without activeRoundId.
    expect(donor.threads.filter((row) => row.activeRoundId === undefined)).toHaveLength(3)
  }, 60_000)

  it('is the persist’s view once the legacy capture is scoped to its thread', () => {
    const profile = openProfile()
    const r = mulberry32(5)
    for (const id of ['chat-a', 'chat-b']) persistNew(profile, seededRecord(r, id, 4))
    const models = expectEquivalent(profile)
    const donor = donorFamilies(profile)
    const scope = {
      threadIds: new Set(['chat-b']),
      workspaceIds: new Set<string>(),
      providerIds: new Set<string>(),
      questionIds: new Set<string>(),
      approvalIds: new Set<string>(),
      channelIds: new Set<string>(),
      includeAllWorkspaces: false,
      useFullSnapshot: false
    }
    const scoped = scopeHostMutationObservationFamilies(donor, scope)
    const assembled = assembleHostPublicWindowFamilies(models)
    const own = <T extends { threadId?: string; id?: string }>(rows: readonly T[]) =>
      rows.filter((row) => (row.threadId ?? row.id) === 'chat-b')
    expect(scoped.threads).toEqual(own(assembled.threads))
    expect(scoped.runs).toEqual(own(assembled.runs))
    expect(scoped.rounds).toEqual(own(assembled.rounds))
    expect(scoped.participants).toEqual(own(assembled.participants))
    // The scoped capture keeps every donor warning: its only global content.
    expect(scoped.warnings).toEqual(assembled.warnings)
  })

  it('declares the worker’s re-projection: on a start-time tie it presents the earlier run', () => {
    const profile = openProfile()
    const record = {
      appChatId: 'tie',
      scope: 'global',
      title: 'Tie',
      updatedAt: T0,
      createdAt: 1,
      archived: false,
      chatKind: 'ensemble',
      ensemble: {
        orchestrationMode: 'sequential',
        fanoutPolicy: 'all',
        participants: [{ id: 'p1', provider: 'codex', role: 'worker', order: 0, enabled: true }],
        activeRound: {
          roundId: 'round-1',
          status: 'active',
          participants: [{ participantId: 'p1' }]
        }
      },
      messages: [],
      runs: [
        { runId: 'first', provider: 'codex', status: 'running', startedAt: iso(0) },
        {
          runId: 'second',
          provider: 'codex',
          status: 'success',
          startedAt: iso(0),
          endedAt: iso(5)
        }
      ]
    }
    expect(persistNew(profile, record)).toBe('committed')
    const [model] = expectEquivalent(profile)
    // The Host's projection presents the later run: the round is not live.
    expect(model!.projection.summary.presentation?.status).toBe('success')
    expect(model!.round?.live).toBe(false)
    // Once the catalogue re-indexes the file, the mirror holds the worker's
    // projection, which presents the earlier run: the round turns live.
    const worker = projectThreadCatalogueRecord(
      JSON.parse(readFileSync(join(profile.path, HOST_PROFILE_CHATS_DIRECTORY, 'tie.json'), 'utf8'))
    )
    expect(worker.summary.presentation?.status).toBe('running')
    profile.mirrorRows.set('tie', worker)
    const reindexed = donorFamilies(profile)
    expect(reindexed.rounds.map((row) => row.status)).toEqual(['running'])
    expect(reindexed.threads[0]).toMatchObject({ activeRoundId: 'round-1' })
  })

  it('models the committed thread, not the client’s record: repairs and the store’s stamp', () => {
    const profile = openProfile()
    const record = {
      appChatId: 'chat-a',
      title: 'Legacy',
      scope: 'global',
      workspaceId: 'ws-1',
      workspacePath: '/workspace/one',
      updatedAt: T0,
      archived: 'yes',
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: iso(0) }]
    }
    expect(persistNew(profile, record)).toBe('committed')
    const thread = profile.committed.get('chat-a')!
    expect(thread).toMatchObject({
      scope: 'workspace',
      archived: false,
      runs: [],
      createdAt: 0,
      updatedAt: NOW
    })
    expectEquivalent(profile)
    const fromClient = modelHostThreadRecordEffects(record as unknown as HostProfileThread)
    const fromCommitted = modelHostThreadRecordEffects(thread)
    expect(fromClient.kind === 'modelled' && fromClient.thread).not.toEqual(
      fromCommitted.kind === 'modelled' && fromCommitted.thread
    )
  })

  it('models an adopted transfer: the record is published as sent, with its own stamp', () => {
    const profile = openProfile()
    const created = profile.store.createThread({ scope: 'global', title: 'Adopted' })
    const next = {
      ...created,
      title: 'Adopted edit',
      persistenceRevision: 1,
      updatedAt: T0 + 123,
      runs: [
        {
          runId: 'run-1',
          provider: 'codex',
          status: 'success',
          startedAt: iso(0),
          endedAt: iso(9)
        },
        { runId: 'run-2', provider: 'codex', status: 'running', startedAt: iso(10) }
      ],
      messages: [{ id: 'm1', role: 'assistant', content: 'done', timestamp: iso(9) }]
    }
    const descriptor = publishHostThreadRecordTransfer({
      profilePath: profile.path,
      transferId: 'adopt-1',
      record: next
    })
    const verified = verifyHostThreadRecordTransfer({ profilePath: profile.path, descriptor })
    profile.store.persistThreadRecord({
      threadId: created.appChatId,
      record: decodeHostThreadRecordTransferBody(verified.body),
      expectedRevision: 0,
      verifiedTransfer: {
        path: verified.path,
        identity: verified.identity,
        byteLength: descriptor.byteLength
      }
    })
    const thread = profile.committed.get(created.appChatId)!
    expect(thread).toMatchObject({
      title: 'Adopted edit',
      persistenceRevision: 1,
      updatedAt: T0 + 123
    })
    const [model] = expectEquivalent(profile)
    expect(model!.runs.candidates.map((candidate) => candidate.runId)).toEqual(['run-2', 'run-1'])
  })
})

// ── the public window index, change by change (slice 5) ───────────────────────

type ClientState = Map<string, Map<string, unknown>>

const DELTA_FAMILIES = [
  ['threads', 'thread'],
  ['runs', 'run'],
  ['rounds', 'round'],
  ['participants', 'participant'],
  ['warnings', 'warning']
] as const

/** What a client holds after a snapshot: the five families by entity id. */
function snapshotState(snapshot: HostSnapshot): ClientState {
  return new Map(
    DELTA_FAMILIES.map(([family, delta]) => [
      delta,
      new Map(
        (snapshot[family] as readonly unknown[]).map((row) => {
          const identity = hostSnapshotEntityId(delta, row)
          if (!identity.ok) throw new Error(identity.detail)
          return [identity.entityId, row]
        })
      )
    ])
  )
}

function applyEffects(state: ClientState, effects: readonly HostDomainEffectDto[]): ClientState {
  const next: ClientState = new Map([...state].map(([family, rows]) => [family, new Map(rows)]))
  for (const effect of effects) {
    const rows = next.get(effect.family)!
    if (effect.kind === 'upsert') rows.set(effect.entityId, effect.payload)
    else rows.delete(effect.entityId)
  }
  return next
}

function fromIndex(index: HostPublicWindowIndex): ClientState {
  return new Map([...index.wire()].map(([family, rows]) => [family, new Map(rows)]))
}

/** The donor's wire snapshot once its catalogue settles on the profile's files. */
function settledSnapshot(profile: Profile) {
  expectEquivalent(profile)
  return wire(donorFamilies(profile))
}

interface Published {
  /** The donor snapshot the client's state equals, or null where none does. */
  readonly snapshot: HostSnapshot | null
  readonly client: ClientState
}

function initiallyPublished(profile: Profile): Published {
  const snapshot = settledSnapshot(profile)
  if (!snapshot.ok) throw new Error(snapshot.error)
  return { snapshot: snapshot.value, client: snapshotState(snapshot.value) }
}

function modelChange(profile: Profile, threadId: string): HostPublicWindowChange {
  const model = modelHostThreadRecordEffects(profile.committed.get(threadId)!)
  if (model.kind !== 'modelled') throw new Error(`committed thread ${threadId} was refused`)
  return { kind: 'model', model }
}

/**
 * A committed delete. The scope ledger closes the thread's lane for the
 * incarnation, so nothing writes the thread again.
 */
function deleteChange(threadId: string): HostPublicWindowChange {
  return { kind: 'delete', threadId }
}

const PUBLICATION = { generatedAt: POSITION.generatedAt }

/**
 * A short window is what the donor shows while its catalogue has indexed
 * only those runs: the same rows, members and still-loading warning.
 */
function expectLoadingDonor(
  profile: Profile,
  index: HostPublicWindowIndex,
  client: ClientState
): void {
  const indexed = new Map(
    [...profile.mirrorRows.keys()]
      .flatMap((threadId) => referenceIndexedRuns(profile, threadId))
      .map((run) => [run.runId, run])
  )
  const settled = profile.runWindow
  profile.runWindow = {
    entries: [...index.wire().get('run')!.keys()]
      .map((runId) => indexed.get(runId)!)
      .sort(referenceOrder)
      .map((run) => ({ chatId: run.threadId, run: run.summary as unknown as HostProfileRun })),
    total: indexed.size,
    complete: false
  }
  const loading = wire(donorFamilies(profile))
  profile.runWindow = settled
  if (!loading.ok) throw new Error(loading.error)
  expect(client).toEqual(snapshotState(loading.value))
  expect(client.get('warning')!.get(`${HOST_WARNING_PROJECTION_WINDOWED}:runs`)).toMatchObject({
    message: expect.stringContaining('still loading')
  })
}

/**
 * Apply one change, answering each refill from the committed records, and
 * check it against the donor: a client that applies the effects holds the
 * donor's settled snapshot.
 * - `absorb`: a short window is aborted and prepared again with the named
 *   threads modelled, so one transaction diffs once, and its effects are
 *   exactly the legacy snapshot diff's;
 * - `publish-short`: each short window is committed, checked against the
 *   donor's still-loading view, and refilled in its own transaction; without
 *   a refill the effects are exactly the legacy diff's.
 */
function publishChange(
  profile: Profile,
  index: HostPublicWindowIndex,
  change: HostPublicWindowChange,
  prior: Published,
  mode: 'absorb' | 'publish-short' = 'absorb'
): { published: Published; effects: HostDomainEffectDto[]; refills: number; exact: boolean } {
  const next = settledSnapshot(profile)
  if (!next.ok) throw new Error(next.error)
  const effects: HostDomainEffectDto[] = []
  let client = prior.client
  let refills = 0
  if (mode === 'absorb') {
    const changes = [change]
    let transaction = index.prepare(changes, PUBLICATION)
    while (!transaction.complete) {
      transaction.abort()
      expect(transaction.refill).toHaveLength(1)
      refills += 1
      expect(refills).toBeLessThan(20)
      changes.push(modelChange(profile, transaction.refill[0]!))
      transaction = index.prepare(changes, PUBLICATION)
    }
    expect(transaction.ignored).toEqual([])
    effects.push(...transaction.effects)
    client = applyEffects(client, transaction.effects)
    transaction.commit()
  } else {
    let transaction = index.prepare([change], PUBLICATION)
    for (;;) {
      expect(transaction.ignored).toEqual([])
      effects.push(...transaction.effects)
      client = applyEffects(client, transaction.effects)
      transaction.commit()
      if (transaction.complete) break
      expectLoadingDonor(profile, index, client)
      expect(transaction.refill).toHaveLength(1)
      refills += 1
      expect(refills).toBeLessThan(20)
      transaction = index.prepare([modelChange(profile, transaction.refill[0]!)], PUBLICATION)
    }
  }
  expect(client).toEqual(snapshotState(next.value))
  const exact = prior.snapshot !== null && (mode === 'absorb' || refills === 0)
  if (exact) {
    const legacy = diffHostSnapshotDomainEffects(prior.snapshot, next.value)
    if (legacy.kind !== 'effects') throw new Error(`legacy diff ${legacy.kind}`)
    expect(JSON.stringify(effects)).toBe(JSON.stringify(legacy.effects))
  }
  return { published: { snapshot: next.value, client }, effects, refills, exact }
}

/** The seeded record with its run and round ids its thread's own. */
function ownIds(record: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const own = (value: unknown): unknown => (typeof value === 'string' ? `${prefix}${value}` : value)
  const owned: Record<string, unknown> = { ...record }
  if (Array.isArray(record.runs)) {
    owned.runs = (record.runs as Record<string, unknown>[]).map((run) => ({
      ...run,
      runId: own(run.runId),
      ...('ensembleRoundId' in run ? { ensembleRoundId: own(run.ensembleRoundId) } : {})
    }))
  }
  const ensemble = record.ensemble as Record<string, unknown> | undefined
  const round = ensemble?.activeRound as Record<string, unknown> | undefined
  if (ensemble && round) {
    owned.ensemble = {
      ...ensemble,
      activeRound: {
        ...round,
        ...('roundId' in round ? { roundId: own(round.roundId) } : {}),
        ...('id' in round ? { id: own(round.id) } : {}),
        participants: (round.participants as Record<string, unknown>[]).map((seat) =>
          'runId' in seat ? { ...seat, runId: own(seat.runId) } : seat
        )
      }
    }
  }
  return owned
}

function heavyEnsemble(appChatId: string, runs: number, at: (ordinal: number) => number) {
  return {
    appChatId,
    scope: 'global',
    title: appChatId,
    updatedAt: T0,
    createdAt: 1,
    archived: false,
    chatKind: 'ensemble',
    ensemble: {
      orchestrationMode: 'sequential',
      fanoutPolicy: 'all',
      participants: [{ id: 'p1', provider: 'codex', role: 'worker', order: 0, enabled: true }],
      activeRound: {
        roundId: `${appChatId}-round`,
        status: 'running',
        participants: [{ participantId: 'p1', runId: `${appChatId}-seat` }]
      }
    },
    messages: [],
    runs: Array.from({ length: runs }, (_, ordinal) => ({
      runId: `${appChatId}-run-${ordinal}`,
      provider: 'codex',
      status: 'success',
      startedAt: iso(at(ordinal)),
      endedAt: iso(at(ordinal) + 1),
      ...(ordinal % 2 === 0 ? { ensembleRoundId: `${appChatId}-round` } : {})
    }))
  }
}

describe('public window index ≡ donor, change by change', () => {
  it('publishes each persist and delete as the legacy snapshot diff does over the donor', () => {
    const tally = { changes: 0, exact: 0, deletes: 0, withheld: 0 }
    for (let seed = 1; seed <= 40; seed += 1) {
      const r = mulberry32(seed * 131)
      const profile = openProfile()
      const index = new HostPublicWindowIndex({ band: 2 })
      let published = initiallyPublished(profile)
      const publish = (change: HostPublicWindowChange): void => {
        const outcome = publishChange(profile, index, change, published)
        published = outcome.published
        tally.changes += 1
        if (outcome.exact) tally.exact += 1
      }
      // A deleted thread never comes back in the incarnation, so its slot
      // goes on as a new thread under a fresh id.
      const deaths = new Map<number, number>()
      const life = (slot: number): number => deaths.get(slot) ?? 0
      for (let step = 0; step < 10; step += 1) {
        const slot = int(r, 0, THREAD_IDS.length - 1)
        const threadId = life(slot) === 0 ? THREAD_IDS[slot]! : `${THREAD_IDS[slot]!}.${life(slot)}`
        const committed = profile.committed.get(threadId)
        if (committed && chance(r, 0.25)) {
          if (!deleteThread(profile, threadId)) {
            // Its runs finish first: the client saves them settled, then deletes.
            const runs = (committed.runs ?? []).map((run) => ({
              ...run,
              status: 'completed',
              endedAt: iso(0)
            }))
            expect(persistRecord(profile, { ...committed, runs })).toBe('committed')
            publish(modelChange(profile, threadId))
            expect(deleteThread(profile, threadId)).toBe(true)
          }
          publish(deleteChange(threadId))
          deaths.set(slot, life(slot) + 1)
          tally.deletes += 1
          continue
        }
        const record = ownIds(seededRecord(r, threadId, int(r, 0, 30)), `t${slot}.${life(slot)}-`)
        if (persistRecord(profile, record) !== 'committed') continue
        if (!settledSnapshot(profile).ok) {
          // The donor's snapshot fails its privacy scan, and with it every
          // donor publication. The index withholds the thread's row, counts
          // it, and publishes the rest. The client then saves again without
          // the credential-shaped message.
          const transaction = index.prepare([modelChange(profile, threadId)], PUBLICATION)
          expect(transaction.complete).toBe(true)
          expect(transaction.effects).toContainEqual(
            expect.objectContaining({
              kind: 'upsert',
              family: 'warning',
              entityId: `${HOST_WARNING_PROJECTION_WITHHELD}:threads`
            })
          )
          expect(
            transaction.effects.some(
              (effect) =>
                effect.family === 'thread' &&
                effect.entityId === threadId &&
                effect.kind === 'upsert'
            )
          ).toBe(false)
          published = {
            snapshot: null,
            client: applyEffects(published.client, transaction.effects)
          }
          transaction.commit()
          tally.withheld += 1
          const messages = (record.messages as { content: string }[]).filter(
            (message) => message.content !== 'ghp_secret'
          )
          expect(persistRecord(profile, { ...record, messages })).toBe('committed')
        }
        publish(modelChange(profile, threadId))
      }
    }
    // The sequences reach what they are meant to prove.
    expect(tally.changes).toBeGreaterThan(250)
    // Only the save after a withheld row has no donor snapshot to diff from.
    expect(tally.exact).toBe(tally.changes - tally.withheld)
    expect(tally.deletes).toBeGreaterThan(20)
    expect(tally.withheld).toBeGreaterThan(2)
  }, 120_000)

  it.each(['publish-short', 'absorb'] as const)(
    'publishes displacement: newer runs push a round’s members out, and a delete refills them (%s)',
    (mode) => {
      const profile = openProfile()
      mkdirSync(join(profile.path, HOST_PROFILE_CHATS_DIRECTORY), { recursive: true })
      const index = new HostPublicWindowIndex({ band: 16 })
      let published = initiallyPublished(profile)
      const shrunk = (before: Published, effects: readonly HostDomainEffectDto[]) =>
        effects.filter((effect) => {
          if (effect.family !== 'round' || effect.kind !== 'upsert') return false
          const prior = before.client.get('round')!.get(effect.entityId) as
            | { providerRunIds: string[] }
            | undefined
          const next = effect.payload as { providerRunIds: string[] }
          return prior !== undefined && next.providerRunIds.length < prior.providerRunIds.length
        }).length
      // Three ensembles of 700 interleaved runs: the third pushes out the
      // oldest 100 of each, and the first two rounds lose members.
      for (const [offset, id] of ['heavy-a', 'heavy-b', 'heavy-c'].entries()) {
        publishCanonical(
          profile,
          heavyEnsemble(id, 700, (ordinal) => ordinal * 3 + offset)
        )
        const before = published
        const outcome = publishChange(profile, index, modelChange(profile, id), before, mode)
        expect(outcome.refills).toBe(0)
        published = outcome.published
        if (id === 'heavy-c') expect(shrunk(before, outcome.effects)).toBe(2)
      }
      expect(published.client.get('run')!.size).toBe(WINDOW)
      // A fourth thread's 300 newer runs push 100 more out of each.
      publishCanonical(
        profile,
        heavyEnsemble('light', 300, (ordinal) => 10_000 + ordinal)
      )
      const before = published
      const pushed = publishChange(profile, index, modelChange(profile, 'light'), before, mode)
      expect(pushed.refills).toBe(0)
      expect(shrunk(before, pushed.effects)).toBe(3)
      expect(
        pushed.effects.filter((effect) => effect.family === 'run' && effect.kind === 'tombstone')
      ).toHaveLength(300)
      published = pushed.published
      // Deleting it frees 300 slots, more than each thread's band: every heavy
      // thread is modelled again, and no run a client holds is retracted.
      unpublish(profile, 'light')
      const freed = publishChange(profile, index, deleteChange('light'), published, mode)
      expect(freed.refills).toBe(3)
      expect(freed.exact).toBe(mode === 'absorb')
      const retracted = freed.effects
        .filter((effect) => effect.family === 'run' && effect.kind === 'tombstone')
        .map((effect) => effect.entityId)
      expect(retracted).toHaveLength(300)
      expect(retracted.every((runId) => runId.startsWith('light-'))).toBe(true)
      expect(freed.published.client.get('run')!.size).toBe(WINDOW)
      // Deleting a second leaves 1,400 runs, all inside the window: the short
      // window still loads, then the warning goes.
      unpublish(profile, 'heavy-b')
      const emptied = publishChange(profile, index, deleteChange('heavy-b'), freed.published, mode)
      expect(emptied.refills).toBe(2)
      expect(emptied.published.client.get('run')!.size).toBe(1_400)
      expect(
        emptied.published.client.get('warning')!.has(`${HOST_WARNING_PROJECTION_WINDOWED}:runs`)
      ).toBe(false)
    },
    60_000
  )

  it('publishes the windows’ bounds: at exactly 1,800 neither warns, and a live round moves in', () => {
    const profile = openProfile()
    mkdirSync(join(profile.path, HOST_PROFILE_CHATS_DIRECTORY), { recursive: true })
    // 1,801 live rounds with one running run each, and two terminal rounds.
    const live = (index: number): boolean => index % 1_000 !== 1
    const id = (index: number): string => `round-thread-${String(index).padStart(4, '0')}`
    for (let index = 0; index < WINDOW + 3; index += 1) {
      publishCanonical(profile, {
        ...heavyEnsemble(id(index), 0, () => 0),
        ensemble: {
          orchestrationMode: 'sequential',
          fanoutPolicy: 'all',
          participants: [{ id: 'p1', provider: 'codex', role: 'worker', order: 0, enabled: true }],
          activeRound: {
            roundId: `round-${index}`,
            status: live(index) ? 'running' : 'completed',
            startedAt: iso(index % 50),
            participants: [{ participantId: 'p1' }]
          }
        },
        runs: live(index)
          ? [{ runId: `r-${index}`, provider: 'codex', status: 'running', startedAt: iso(0) }]
          : []
      })
    }
    const index = new HostPublicWindowIndex()
    expect(
      index.seed(
        modelsOf(profile).map((model) => ({ kind: 'model' as const, model })),
        PUBLICATION
      )
    ).toMatchObject({ complete: true, refill: [] })
    let published = initiallyPublished(profile)
    expect(fromIndex(index)).toEqual(published.client)
    const warningIds = () => [...published.client.get('warning')!.keys()]
    expect(warningIds()).toEqual([
      `${HOST_WARNING_PROJECTION_WINDOWED}:rounds`,
      `${HOST_WARNING_PROJECTION_WINDOWED}:runs`
    ])
    const outside = [...published.client.get('thread')!.values()].filter(
      (row) => (row as { activeRoundId?: string }).activeRoundId === undefined
    ) as { id: string }[]
    expect(outside).toHaveLength(3)
    // One live thread goes: 1,800 runs fit, and the round window takes in the
    // live round it dropped, naming it on a thread that did not change.
    unpublish(profile, id(0))
    const first = publishChange(profile, index, deleteChange(id(0)), published)
    published = first.published
    expect(warningIds()).toEqual([`${HOST_WARNING_PROJECTION_WINDOWED}:rounds`])
    const named = first.effects.filter(
      (effect) =>
        effect.family === 'thread' &&
        effect.kind === 'upsert' &&
        (effect.payload as { activeRoundId?: string }).activeRoundId !== undefined
    )
    expect(named).toHaveLength(1)
    // The two terminal threads go: exactly 1,800 rounds, no window.
    for (const terminal of [id(1), id(1_001)]) {
      unpublish(profile, terminal)
      published = publishChange(profile, index, deleteChange(terminal), published).published
    }
    expect(warningIds()).toEqual([])
  }, 120_000)
})

// ── slow tier: the real decoder and index ───────────────────────────────────

describe('thread record effect model ≡ the real catalogue index', () => {
  let directory: string
  let decoderPath: string
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'thread-record-effect-catalogue-'))
    decoderPath = join(directory, 'decoder.cjs')
    await build({
      entryPoints: [
        fileURLToPath(new URL('../main/workers/threadCatalogueDecoder.ts', import.meta.url))
      ],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: decoderPath,
      logLevel: 'silent'
    })
  })
  afterAll(() =>
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  )

  async function indexed(profile: Profile, threadIds: readonly string[]) {
    const service = new ThreadCatalogueWorkerService({
      reader: { profilePath: profile.path, runtimeInstanceId: 'runtime', segmented: false },
      decoderPath,
      writer: 'desktop',
      writerId: 'owner',
      writerLifecycle: () => 'active'
    })
    await service.refreshInventory()
    const outcomes = new Map<string, boolean>()
    for (const threadId of threadIds) {
      outcomes.set(
        threadId,
        await service.ensureIndexed(threadId, 'metadata').then(
          (entry) => entry !== null,
          () => false
        )
      )
    }
    const entries: Array<{ chatId: string; run: Record<string, unknown> }> = []
    let total = 0
    let offset: number | null = 0
    while (offset !== null) {
      const page = service.database.hostRunPage(offset)
      entries.push(
        ...page.entries.map((entry) => ({
          chatId: entry.chatId,
          run: entry.run as Record<string, unknown>
        }))
      )
      total = page.total
      offset = page.next
    }
    const sqlite = (
      service.database as unknown as {
        database: { prepare(sql: string): { all(): Array<Record<string, unknown>> } }
      }
    ).database
    const ranks = sqlite
      .prepare(
        `SELECT r.chat_id,r.ordinal,r.active,r.recency FROM run_summary_order r
         JOIN current_generations c ON c.chat_id=r.chat_id AND c.generation=r.generation`
      )
      .all()
    return { service, outcomes, entries, total, ranks }
  }

  it('reproduces the indexed run rows, their rank and the window, and the donor over them', async () => {
    const profile = openProfile()
    const r = mulberry32(2_026)
    const ids = [...THREAD_IDS]
    for (const id of ids) persistNew(profile, seededRecord(r, id, int(r, 2, 9)))
    // Displacement: one thread's runs outnumber the window.
    persistNew(profile, {
      appChatId: 'heavy',
      scope: 'global',
      title: 'Heavy',
      updatedAt: T0,
      createdAt: 1,
      archived: false,
      messages: [],
      runs: Array.from({ length: WINDOW + 40 }, (_, ordinal) => ({
        runId: `heavy-${ordinal}`,
        provider: 'codex',
        status: ordinal % 11 === 0 ? 'running' : 'success',
        startedAt: iso(ordinal * 2),
        endedAt: iso(ordinal * 2 + 1)
      }))
    })
    const models = modelsOf(profile)
    const { service, outcomes, entries, total, ranks } = await indexed(profile, [
      ...profile.mirrorRows.keys()
    ])
    try {
      for (const model of models) expect(outcomes.get(model.threadId), model.threadId).toBe(true)
      expect(total).toBe(models.reduce((sum, model) => sum + model.runs.total, 0))
      // The rank the index stores is the model's, for every run of every thread.
      const rankOf = new Map(ranks.map((row) => [`${row.chat_id}\u0000${row.ordinal}`, row]))
      for (const model of models) {
        for (const candidate of model.runs.candidates) {
          const row = rankOf.get(`${model.threadId}\u0000${candidate.ordinal}`)!
          expect({ active: row.active, recency: row.recency }).toEqual(candidate.rank)
        }
      }
      // The index's pages are the models' merged candidates, object for object.
      const window = modelWindow(models)
      expect(entries.map((entry) => ({ threadId: entry.chatId, runId: entry.run.runId }))).toEqual(
        window
      )
      const byKey = new Map(
        models.flatMap((model) =>
          model.runs.candidates.map((candidate) => [
            `${model.threadId}\u0000${candidate.runId}`,
            candidate
          ])
        )
      )
      for (const entry of entries) {
        expect(JSON.stringify(entry.run)).toBe(
          JSON.stringify(byKey.get(`${entry.chatId}\u0000${entry.run.runId}`)!.summary)
        )
      }
      // And the donor over the real window equals the models' assembly.
      profile.runWindow = {
        entries: entries.map((entry) => ({
          chatId: entry.chatId,
          run: entry.run as unknown as HostProfileRun
        })),
        total,
        complete: true
      }
      const donor = donorFamilies(profile)
      const assembled = assembleHostPublicWindowFamilies(models)
      for (const family of ['threads', 'runs', 'rounds', 'participants', 'warnings'] as const) {
        expect(JSON.stringify(assembled[family]), family).toBe(JSON.stringify(donor[family]))
      }
    } finally {
      await service.dispose()
    }
  }, 120_000)

  it('declares the record the catalogue cannot normalise: the index keeps no rows, the model describes it', async () => {
    const profile = openProfile()
    expect(
      persistNew(profile, {
        appChatId: 'unindexable',
        scope: 'global',
        title: 'Unindexable',
        updatedAt: T0,
        createdAt: 1,
        archived: false,
        chatKind: 'ensemble',
        ensemble: {
          participants: [],
          activeRound: { roundId: 'round-1', status: 'running', participants: 'none' }
        },
        messages: [],
        runs: [
          {
            runId: 'run-1',
            provider: 'codex',
            status: 'success',
            startedAt: iso(0),
            endedAt: iso(1)
          }
        ]
      })
    ).toBe('committed')
    const [model] = modelsOf(profile)
    expect(model!.runs.candidates.map((candidate) => candidate.runId)).toEqual(['run-1'])
    const { service, outcomes, entries, total } = await indexed(profile, ['unindexable'])
    try {
      expect(outcomes.get('unindexable')).toBe(false)
      expect(entries).toEqual([])
      expect(total).toBe(0)
    } finally {
      await service.dispose()
    }
  }, 60_000)
})
