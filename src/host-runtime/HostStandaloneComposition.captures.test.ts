/**
 * Independent Threads M4 slice 13f2 (design §23.17, tests 2, 4 and 6 at the
 * composition): once the seed has switched, captures read the five
 * record-derived families from the public window index, over the real
 * standalone composition, a real `HostProfileDomainStore` profile and the
 * composition's own runtime.
 *
 * 2. after the switch a snapshot's five families equal what an index seeded
 *    with the same committed files publishes, in its order; the other
 *    families and a non-owned projector warning are today's; a transactional
 *    persist and a feeder mark after the switch reach the snapshot; before
 *    the switch the snapshot is the donor's (negative control);
 * 4. a legacy command window after the switch publishes no owned effect and
 *    still publishes a workspace; before the switch it publishes the thread;
 * 6. the reconciler after the switch does not republish donor drift on an
 *    owned family, still reconciles a non-owned drift, and its baseline
 *    advances; before the switch it publishes the owned drift.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * A hold on the delta journal's group fsync (the composition builds its own
 * runtime, so the store's `groupFsync` seam is out of reach): while set, a
 * `FileHandle.sync()` on the journal waits on it, so a feed group stays
 * appended but not durable for as long as a test needs.
 */
const journalHold = vi.hoisted(() => ({
  promise: null as Promise<void> | null,
  /** Journal syncs that found the hold set. */
  held: 0
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args)
    if (!String(args[0]).endsWith('host-deltas.journal.jsonl')) return handle
    const sync = handle.sync.bind(handle)
    handle.sync = async () => {
      if (journalHold.promise) {
        journalHold.held += 1
        await journalHold.promise
      }
      return sync()
    }
    return handle
  }
  return { ...actual, open }
})

import {
  HOST_PROTOCOL_MAX_COLLECTION,
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostAuthenticatedClientIdentity,
  type HostCommand,
  type HostDeltaEnvelope,
  type HostSnapshot,
  type HostThreadProjection,
  type HostWarningProjection,
  type HostWorkspaceProjection
} from '../shared/hostProtocol'
import type { AppStoreHostAuthorityExecutorResult } from './AppStoreHostAuthority'
import type { HostAuthorityCallContext } from './HostAuthority'
import { HOST_DELTA_JOURNAL_FILENAME } from './HostDeltaStore'
import { HostProfileDomainStore, type HostThreadRecordWrittenKind } from './HostProfileDomainStore'
import {
  HostPublicWindowIndex,
  hostPublicWindowOwnsEffect,
  type HostPublicWindowWire
} from './HostPublicWindowIndex'
import {
  createHostStandaloneComposition,
  type HostStandaloneComposition,
  type HostStandaloneCompositionInput,
  type HostStandaloneThreadRecordTransactionInput
} from './HostStandaloneComposition'
import type { HostThreadRecordModelled } from './HostThreadRecordEffectModel'
import { modelHostThreadRecordFile, type HostThreadRecordModelInput } from './HostThreadRecordModel'
import { prepareHostThreadRecord } from './HostThreadRecordPrepare'
import {
  createHostThreadRecordCommitPort,
  type HostThreadRecordCommitPort
} from './HostThreadRecordTransaction'
import { publishHostThreadRecordTransfer } from './HostThreadRecordTransfer'

const NOW_MS = 1_760_000_000_000
const NOW_ISO = new Date(NOW_MS).toISOString()
const BOOT_EPOCH = 'e'.repeat(64)
const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()
const TIMEOUT = 20_000

const ACTOR: HostActorIdentity = {
  actorId: 'actor-1',
  clientId: 'client-1',
  clientClass: 'desktop'
}
const CLIENT: HostAuthenticatedClientIdentity = {
  clientId: 'client-1',
  clientClass: 'desktop',
  clientVersion: '1.0.0'
}
const CONTEXT: HostAuthorityCallContext = { actor: ACTOR, client: CLIENT }

const roots: string[] = []
afterEach(() => {
  journalHold.promise = null
  journalHold.held = 0
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

type Deferred = { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Resolves 'pending' when the promise has not settled within a short grace period. */
async function settledWithin<T>(promise: Promise<T>, ms = 100): Promise<T | 'pending'> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type LooseRecord = Record<string, unknown>

function run(runId: string, startedAt: number) {
  return {
    runId,
    provider: 'codex',
    status: 'success',
    startedAt: iso(startedAt),
    endedAt: iso(startedAt + 1)
  }
}

function threadRecord(
  appChatId: string,
  runCount: number,
  from: number,
  overrides: LooseRecord = {}
) {
  return {
    appChatId,
    scope: 'global',
    title: `Thread ${appChatId}`,
    provider: 'codex',
    archived: false,
    createdAt: 10,
    messages: [],
    runs: Array.from({ length: runCount }, (_, i) => run(`${appChatId}-${i}`, from + i)),
    updatedAt: 20,
    ...overrides
  }
}

function command(
  name: HostCommand['name'],
  commandId: string,
  target: Record<string, string>,
  args: Record<string, unknown> = {}
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId,
    idempotencyKey: `${commandId}-key`,
    actor: ACTOR,
    name,
    target,
    arguments: args,
    issuedAt: NOW_ISO
  }
}

function describeDelta(envelope: HostDeltaEnvelope): string {
  return `${envelope.kind}:${envelope.family}:${envelope.entityId}`
}

const donorThread = (id: string, title = `Donor ${id}`): HostThreadProjection => ({
  id,
  workspaceId: null,
  title,
  chatKind: 'single',
  archived: false,
  pinned: false,
  updatedAt: 1,
  messageCount: 0
})

const workspaceRow = (id: string, pinned = false): HostWorkspaceProjection => ({
  id,
  name: `Workspace ${id}`,
  path: `/tmp/${id}`,
  pinned,
  updatedAt: 1
})

const warningRow = (warningId: string, message: string): HostWarningProjection => ({
  warningId,
  severity: 'warning',
  code: warningId.split(':')[0]!,
  message,
  at: 5
})

/** More workspaces than the collection bound: the projector caps and warns. */
function manyWorkspaces(): HostWorkspaceProjection[] {
  return Array.from({ length: HOST_PROTOCOL_MAX_COLLECTION + 1 }, (_, i) =>
    workspaceRow(`ws-${String(i).padStart(4, '0')}`)
  )
}

/** The donor's mutable families: the executor and the tests replace arrays. */
interface Donor {
  threads: HostThreadProjection[]
  workspaces: HostWorkspaceProjection[]
  warnings: HostWarningProjection[]
}

interface Profile {
  profilePath: string
  runtimePath: string
  store: HostProfileDomainStore
  records: HostThreadRecordCommitPort
  hooked: Array<{ threadId: string; kind: HostThreadRecordWrittenKind }>
  composition: { current: HostStandaloneComposition | null }
  seedReads: string[]
  /** When set, every seed read awaits it first. */
  seedHold: { promise: Promise<void> | null }
  donor: Donor
  executorCalls: HostCommand[]
  /** What the legacy executor answers; the default retitles the target thread and names ws-1. */
  executorResult: { current: (command: HostCommand) => AppStoreHostAuthorityExecutorResult }
  base: Omit<HostStandaloneCompositionInput, 'threadRecordTransaction'>
  transactionInput(
    seed?: HostStandaloneThreadRecordTransactionInput['seed']
  ): HostStandaloneThreadRecordTransactionInput
  seedModel: NonNullable<NonNullable<HostStandaloneThreadRecordTransactionInput['seed']>['model']>
  /** Persists a record at revision 0 through the store, before the composition exists. */
  persist(threadId: string, runCount: number, from: number): void
  /** Publishes a transfer of the thread at the next revision and returns the persist command. */
  persistCommandFor(commandId: string, threadId: string, title: string): HostCommand
  /** The committed files' models, as the index would be seeded with them. */
  models(threadIds: readonly string[]): HostThreadRecordModelled[]
  /** Feed groups written to the journal (durable or not), with their row counts. */
  feedGroups(): Array<{ commandId: string; count: number }>
}

function profile(): Profile {
  const profilePath = mkdtempSync(join(tmpdir(), 'host-standalone-captures-'))
  roots.push(profilePath)
  const runtimePath = join(profilePath, 'host-data')
  const hooked: Profile['hooked'] = []
  const composition: Profile['composition'] = { current: null }
  const store = new HostProfileDomainStore({
    profilePath,
    authority: { assertProfileAuthority: () => undefined },
    now: () => NOW_MS,
    onThreadRecordWritten: (threadId, kind) => {
      hooked.push({ threadId, kind })
      composition.current?.markThreadRecord?.(threadId, kind)
    }
  })
  const records = createHostThreadRecordCommitPort({
    store,
    profilePath,
    beginTicket: async () => ({ finish: () => undefined, fail: () => undefined })
  })
  const seedReads: string[] = []
  const seedHold: Profile['seedHold'] = { promise: null }
  const donor: Donor = { threads: [], workspaces: [], warnings: [] }
  const executorCalls: HostCommand[] = []
  const executorResult: Profile['executorResult'] = {
    current: (cmd) => {
      const threadId = cmd.target.threadId as string
      donor.threads = donor.threads.map((row) =>
        row.id === threadId ? { ...row, title: `Selected ${cmd.commandId}` } : row
      )
      return {
        status: 'succeeded',
        resultSummary: 'selected',
        resultRef: { kind: 'workspace', workspaceId: 'ws-1' }
      }
    }
  }
  const base: Profile['base'] = {
    runtimePath,
    lease: { assertHeld: () => undefined },
    host: { hostId: 'standalone-host', hostVersion: '1.0.0' },
    hostCapabilityOffer: ['bootstrap', 'snapshot', 'deltas', 'commands', 'receipts', 'health'],
    bootEpochFactory: () => BOOT_EPOCH,
    now: () => NOW_ISO,
    snapshotDonor: () => ({
      health: { hostStatus: 'ok', connectionPhase: 'live', supervised: false, freshness: 'live' },
      workspaces: donor.workspaces,
      threads: donor.threads,
      runs: [],
      missions: [],
      rounds: [],
      participants: [],
      providers: [],
      questions: [],
      approvals: [],
      schedules: [],
      usage: { availability: 'unavailable' },
      artifacts: [],
      warnings: donor.warnings
    }),
    authorityEvaluator: () => ({ decision: 'allowed' }),
    commandExecutor: async (cmd) => {
      executorCalls.push(cmd)
      return executorResult.current(cmd)
    },
    healthProvider: () => ({
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: false,
      freshness: 'live'
    })
  }
  const seedModel: Profile['seedModel'] = async (input: HostThreadRecordModelInput) => {
    seedReads.push(input.threadId)
    if (seedHold.promise) await seedHold.promise
    return modelHostThreadRecordFile(input)
  }
  return {
    profilePath,
    runtimePath,
    store,
    records,
    hooked,
    composition,
    seedReads,
    seedHold,
    donor,
    executorCalls,
    executorResult,
    base,
    seedModel,
    transactionInput: (seed) => ({
      profilePath,
      records,
      prepare: async (input) => prepareHostThreadRecord(input),
      model: async (input: HostThreadRecordModelInput) => modelHostThreadRecordFile(input),
      now: () => NOW_MS,
      ...(seed ? { seed } : {})
    }),
    persist: (threadId, runCount, from) => {
      store.persistThreadRecord({
        threadId,
        record: threadRecord(threadId, runCount, from),
        expectedRevision: 0
      })
    },
    persistCommandFor: (commandId, threadId, title) => {
      const expectedRevision = store.threadRecordState(threadId)!.revision
      const descriptor = publishHostThreadRecordTransfer({
        profilePath,
        transferId: `transfer-${commandId}`,
        record: threadRecord(threadId, 0, 0, {
          persistenceRevision: expectedRevision + 1,
          title
        })
      })
      return command(
        'thread.record.persist',
        commandId,
        { threadId },
        { ...descriptor, expectedRevision }
      )
    },
    feedGroups: () => {
      const journal = join(runtimePath, HOST_DELTA_JOURNAL_FILENAME)
      if (!existsSync(journal)) return []
      return readFileSync(journal, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { op: string; commandId?: string; count?: number })
        .filter((event) => event.op === 'group' && event.commandId?.startsWith('feed:'))
        .map((event) => ({ commandId: event.commandId!, count: event.count ?? 0 }))
    },
    models: (threadIds) =>
      threadIds.map((threadId) => {
        const model = modelHostThreadRecordFile({ profilePath, threadId })
        if (model.kind !== 'modelled' || model.effects.kind !== 'modelled') {
          throw new Error(`expected a modelled record for ${threadId}`)
        }
        return model.effects
      })
  }
}

/** What an index seeded with every committed model publishes: the oracle for a snapshot. */
function expectedWire(models: readonly HostThreadRecordModelled[]): HostPublicWindowWire {
  const index = new HostPublicWindowIndex()
  index.seed(
    models.map((model) => ({ kind: 'model' as const, model })),
    { generatedAt: NOW_ISO }
  )
  return index.wire()
}

function wireValues<T>(wire: HostPublicWindowWire, family: string): T[] {
  return [...(wire.get(family as never)?.values() ?? [])] as T[]
}

/**
 * The record-derived families of a snapshot, as the wire keys them. The
 * warnings are the wire's plus the projector's non-owned ones, so they are
 * asserted separately.
 */
function recordDerivedFamilies(snapshot: HostSnapshot) {
  return {
    thread: snapshot.threads,
    run: snapshot.runs,
    round: snapshot.rounds,
    participant: snapshot.participants,
    warning: snapshot.warnings.filter((warning) =>
      hostPublicWindowOwnsEffect('warning', warning.warningId)
    )
  }
}

function wireFamilies(wire: HostPublicWindowWire) {
  return {
    thread: wireValues(wire, 'thread'),
    run: wireValues(wire, 'run'),
    round: wireValues(wire, 'round'),
    participant: wireValues(wire, 'participant'),
    warning: wireValues(wire, 'warning')
  }
}

async function snapshotOf(composition: HostStandaloneComposition): Promise<HostSnapshot> {
  const result = await composition.authority.snapshot(CONTEXT)
  if (!result.ok) throw new Error(`snapshot ${result.error}`)
  return result.value
}

/** Records every delivered delta; `since(mark)` reads what landed after a mark. */
function watchDeltas(composition: HostStandaloneComposition): {
  delivered: string[]
  mark: () => number
  since: (mark: number) => string[]
  stop: () => void
} {
  const delivered: string[] = []
  const stop = composition.subscribeDeltas((event) => {
    delivered.push(describeDelta(event.record.envelope))
  })
  return {
    delivered,
    mark: () => delivered.length,
    since: (mark) => delivered.slice(mark),
    stop
  }
}

async function switchOver(
  composition: HostStandaloneComposition
): Promise<{ generation: number; cursor: number }> {
  const outcome = await composition.startPublicWindowSeed!().seeded
  expect(outcome.kind).toBe('switched')
  if (outcome.kind !== 'switched') throw new Error(outcome.reason)
  return outcome.position
}

describe('HostStandaloneComposition: captures read the public window index (M4 slice 13f2)', () => {
  it(
    '2. after the switch a snapshot’s five families equal the seeded index’s wire; the rest is today’s; before the switch it is the donor’s',
    async () => {
      const p = profile()
      p.persist('a', 2, 0)
      p.persist('b', 1, 100)
      p.persist('c', 0, 0)
      p.donor.threads = [donorThread('donor-only'), donorThread('a', 'Stale donor copy of a')]
      p.donor.workspaces = manyWorkspaces()
      p.donor.warnings = [warningRow('projection_windowed:runs', 'from the donor')]
      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput({ model: p.seedModel })
      })
      p.composition.current = composition
      const watch = watchDeltas(composition)
      try {
        // Before the switch: the donor's families, its warnings, today's cap.
        const before = await snapshotOf(composition)
        expect(before.threads.map((row) => row.id)).toEqual(['a', 'donor-only'])
        expect(before.threads.find((row) => row.id === 'a')?.title).toBe('Stale donor copy of a')
        expect(before.runs).toEqual([])
        expect(before.workspaces).toHaveLength(HOST_PROTOCOL_MAX_COLLECTION)
        expect(before.warnings.map((w) => `${w.warningId}=${w.message}`)).toEqual([
          expect.stringMatching(/^projection_truncated:workspaces=/),
          'projection_windowed:runs=from the donor'
        ])

        const position = await switchOver(composition)
        expect(p.seedReads).toEqual(['a', 'b', 'c'])

        // After the switch: the wire, exactly and in its order.
        const after = await snapshotOf(composition)
        const wire = expectedWire(p.models(['a', 'b', 'c']))
        expect(recordDerivedFamilies(after)).toEqual(wireFamilies(wire))
        expect(after.threads.map((row) => row.id)).toEqual(['a', 'b', 'c'])
        expect(after.threads.find((row) => row.id === 'a')?.title).toBe('Thread a')
        expect(after.runs.map((row) => row.runId).sort()).toEqual(['a-0', 'a-1', 'b-0'])
        expect(after.threads.find((row) => row.id === 'donor-only')).toBeUndefined()
        // Today's other families, and the projector's non-owned warning survives.
        expect(after.workspaces).toEqual(before.workspaces)
        expect(after.warnings.map((w) => w.warningId)).toEqual(['projection_truncated:workspaces'])
        expect(after).toMatchObject({
          generation: position.generation,
          cursor: composition.getPosition().cursor,
          freshness: 'live',
          generatedAt: NOW_ISO
        })
        expect(after.generation).toBe(before.generation + 1)

        // A transactional persist after the switch reaches the next snapshot.
        const mark = watch.mark()
        const persisted = await composition.authority.command(
          CONTEXT,
          p.persistCommandFor('cmd-txn', 'a', 'Persisted a')
        )
        expect(persisted).toMatchObject({
          ok: true,
          value: { status: 'succeeded', resultSummary: 'thread_record_persisted' }
        })
        expect(watch.since(mark)).toContain('upsert:thread:a')
        const afterPersist = await snapshotOf(composition)
        expect(afterPersist.threads.find((row) => row.id === 'a')?.title).toBe('Persisted a')
        expect(recordDerivedFamilies(afterPersist)).toEqual(
          wireFamilies(expectedWire(p.models(['a', 'b', 'c'])))
        )
        expect(afterPersist.cursor).toBe(composition.getPosition().cursor)

        // A feeder mark after the switch (a store write outside the transaction) too.
        const markFeed = watch.mark()
        p.persist('d', 1, 200)
        expect(p.hooked.at(-1)).toEqual({ threadId: 'd', kind: 'record' })
        await vi.waitFor(() => expect(watch.since(markFeed)).toContain('upsert:thread:d'))
        const afterFeed = await snapshotOf(composition)
        expect(afterFeed.threads.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd'])
        expect(recordDerivedFamilies(afterFeed)).toEqual(
          wireFamilies(expectedWire(p.models(['a', 'b', 'c', 'd'])))
        )
      } finally {
        watch.stop()
        await composition.shutdown()
      }
    },
    TIMEOUT
  )

  it(
    '2. without a seed the index publishes from the start, and a snapshot reads it at once',
    async () => {
      const p = profile()
      p.persist('a', 1, 0)
      p.donor.threads = [donorThread('donor-only')]
      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput()
      })
      p.composition.current = composition
      try {
        // The index holds nothing yet: the seed is the only bulk load. A
        // persist feeds it, and the snapshot then shows exactly that.
        const persisted = await composition.authority.command(
          CONTEXT,
          p.persistCommandFor('cmd-txn', 'a', 'Persisted a')
        )
        expect(persisted).toMatchObject({ ok: true, value: { status: 'succeeded' } })
        const snapshot = await snapshotOf(composition)
        expect(snapshot.threads.map((row) => row.id)).toEqual(['a'])
        expect(snapshot.threads[0]?.title).toBe('Persisted a')
        expect(recordDerivedFamilies(snapshot)).toEqual(wireFamilies(expectedWire(p.models(['a']))))
      } finally {
        await composition.shutdown()
      }
    },
    TIMEOUT
  )

  it(
    '4. a legacy command window after the switch publishes no owned effect and still publishes the workspace; before it publishes the thread',
    async () => {
      const p = profile()
      p.persist('a', 1, 0)
      p.donor.threads = [donorThread('a', 'Donor copy of a')]
      p.donor.workspaces = [workspaceRow('ws-1')]
      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput({ model: p.seedModel })
      })
      p.composition.current = composition
      const watch = watchDeltas(composition)
      try {
        // Hold the seed so the first window runs before the switch.
        const hold = deferred()
        p.seedHold.promise = hold.promise
        const { seeded } = composition.startPublicWindowSeed!()
        await vi.waitFor(() => expect(p.seedReads.length).toBeGreaterThanOrEqual(1))

        const markBefore = watch.mark()
        const before = await composition.authority.command(
          CONTEXT,
          command('thread.select', 'sel-before', { threadId: 'a' })
        )
        expect(before).toMatchObject({ ok: true, value: { status: 'succeeded' } })
        expect(watch.since(markBefore)).toEqual(['upsert:workspace:ws-1', 'upsert:thread:a'])

        p.seedHold.promise = null
        hold.resolve()
        expect((await seeded).kind).toBe('switched')

        const markAfter = watch.mark()
        const positionAfterSwitch = composition.getPosition()
        const after = await composition.authority.command(
          CONTEXT,
          command('thread.select', 'sel-after', { threadId: 'a' })
        )
        expect(after).toMatchObject({ ok: true, value: { status: 'succeeded' } })
        expect(p.executorCalls.map((cmd) => cmd.commandId)).toEqual(['sel-before', 'sel-after'])
        expect(watch.since(markAfter)).toEqual(['upsert:workspace:ws-1'])
        expect(composition.getPosition().cursor).toBe(positionAfterSwitch.cursor + 1)

        // An all-owned window publishes nothing at all.
        p.executorResult.current = (cmd) => {
          p.donor.threads = p.donor.threads.map((row) => ({
            ...row,
            title: `Only ${cmd.commandId}`
          }))
          return { status: 'succeeded', resultSummary: 'selected' }
        }
        const markOwned = watch.mark()
        const position = composition.getPosition()
        const owned = await composition.authority.command(
          CONTEXT,
          command('thread.select', 'sel-owned', { threadId: 'a' })
        )
        expect(owned).toMatchObject({
          ok: true,
          value: { status: 'succeeded', generation: position.generation, cursor: position.cursor }
        })
        expect(watch.since(markOwned)).toEqual([])
        expect(composition.getPosition()).toEqual(position)
        // The snapshot never saw the donor's retitles: the index is the authority.
        const snapshot = await snapshotOf(composition)
        expect(snapshot.threads.map((row) => `${row.id}=${row.title}`)).toEqual(['a=Thread a'])
      } finally {
        watch.stop()
        await composition.shutdown()
      }
    },
    TIMEOUT
  )

  it(
    '6. the reconciler after the switch republishes no owned drift, reconciles a non-owned one, and its baseline advances; before the switch it publishes the owned drift',
    async () => {
      const p = profile()
      p.persist('a', 1, 0)
      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput({ model: p.seedModel })
      })
      p.composition.current = composition
      const watch = watchDeltas(composition)
      try {
        const hold = deferred()
        p.seedHold.promise = hold.promise
        const { seeded } = composition.startPublicWindowSeed!()
        await vi.waitFor(() => expect(p.seedReads.length).toBeGreaterThanOrEqual(1))

        // Before the switch: donor drift on threads is the reconciler's to publish.
        await composition.startProjectionReconciliation()
        p.donor.threads = [donorThread('drift')]
        const markBefore = watch.mark()
        await expect(composition.reconcileProjection()).resolves.toMatchObject({
          kind: 'published',
          count: 1
        })
        expect(watch.since(markBefore)).toEqual(['upsert:thread:drift'])

        p.seedHold.promise = null
        hold.resolve()
        expect((await seeded).kind).toBe('switched')
        // The reset rebases the baseline onto the index-backed capture.
        await expect(composition.reconcileProjection()).resolves.toMatchObject({
          kind: 'rebased',
          reason: 'generation_changed'
        })

        // After: owned drift is invisible; a workspace drift is still reconciled.
        p.donor.threads = [donorThread('drift', 'Drifted again'), donorThread('drift-2')]
        p.donor.workspaces = [workspaceRow('ws-1')]
        const markAfter = watch.mark()
        await expect(composition.reconcileProjection()).resolves.toMatchObject({
          kind: 'published',
          count: 1
        })
        expect(watch.since(markAfter)).toEqual(['upsert:workspace:ws-1'])

        // The baseline advanced: nothing owned is held back for a later pass.
        const markSettled = watch.mark()
        await expect(composition.reconcileProjection()).resolves.toMatchObject({
          kind: 'unchanged'
        })
        expect(watch.since(markSettled)).toEqual([])
        expect(watch.delivered.filter((row) => row.includes(':thread:drift'))).toHaveLength(1)
        expect(watch.delivered).not.toContain('upsert:thread:drift-2')
        expect(watch.delivered).not.toContain('tombstone:thread:drift')
        const snapshot = await snapshotOf(composition)
        expect(snapshot.threads.map((row) => row.id)).toEqual(['a'])
      } finally {
        watch.stop()
        await composition.shutdown()
      }
    },
    TIMEOUT
  )

  it(
    '6. a feed group appended but not durable at the reconciler’s stamp is in the wire it captures, and is never republished as reconciler drift',
    async () => {
      const p = profile()
      p.persist('a', 1, 0)
      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput({ model: p.seedModel })
      })
      p.composition.current = composition
      const watch = watchDeltas(composition)
      const hold = deferred()
      try {
        expect((await composition.startPublicWindowSeed!().seeded).kind).toBe('switched')
        // The baseline is captured with nothing pending.
        await composition.startProjectionReconciliation()
        const baseline = composition.getPosition()
        expect((await composition.reconcileProjection()).kind).toBe('unchanged')

        // A store write outside the transaction marks the feeder; its drain
        // commits the index and appends its group, whose fsync now waits.
        journalHold.promise = hold.promise
        const mark = watch.mark()
        p.persist('d', 1, 200)
        await vi.waitFor(() => expect(journalHold.held).toBeGreaterThanOrEqual(1))
        expect(p.feedGroups().at(-1)).toMatchObject({ count: 2 })
        const group = p.feedGroups().at(-1)!
        // Appended, not durable: the durable head is still the baseline.
        expect(composition.getPosition()).toEqual(baseline)
        expect(watch.since(mark)).toEqual([])

        // The pass stamps at the durable head (before the group), reads the
        // wire (which the index committed before appending), then waits for
        // durability: it cannot resolve while the fsync is held.
        const pass = composition.reconcileProjection()
        expect(await settledWithin(pass)).toBe('pending')

        journalHold.promise = null
        hold.resolve()
        const result = await pass
        // The group is beyond the stamp, and the capture ahead of the journal
        // the baseline follows: the diff holds the thread and its run, both
        // owned, so nothing is published and the baseline advances.
        expect(result).toEqual({ kind: 'unchanged', position: baseline })
        await vi.waitFor(() =>
          expect(composition.getPosition().cursor).toBe(baseline.cursor + group.count)
        )
        expect(watch.since(mark)).toEqual(['upsert:thread:d', 'upsert:run:d-0'])
        expect(watch.delivered.filter((row) => row === 'upsert:thread:d')).toHaveLength(1)

        // Settled: the next pass advances through the group and finds no drift.
        await expect(composition.reconcileProjection()).resolves.toEqual({
          kind: 'unchanged',
          position: { generation: baseline.generation, cursor: baseline.cursor + group.count }
        })
        expect(watch.since(mark)).toEqual(['upsert:thread:d', 'upsert:run:d-0'])
        const snapshot = await snapshotOf(composition)
        expect(snapshot.threads.map((row) => row.id)).toEqual(['a', 'd'])
      } finally {
        journalHold.promise = null
        hold.resolve()
        watch.stop()
        await composition.shutdown()
      }
    },
    TIMEOUT
  )
})
