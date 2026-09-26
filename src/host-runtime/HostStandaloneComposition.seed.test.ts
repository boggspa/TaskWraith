/**
 * Independent Threads M4 slice 13f1 (design §23.15, tests 6–8 at the
 * composition): the public window seed and the switch, over the real
 * standalone composition, a real `HostProfileDomainStore` profile and the
 * composition's own runtime, with the in-process prepare and file model as
 * the transaction's and the seed's seams.
 *
 * 6. with `seed` configured: before the switch a persist takes the legacy
 *    path (no transactional group, receipt from legacy); `seeded` gives
 *    exactly one generation reset; after the switch a persist is
 *    transactional with a group; a persist holding the gate delays the
 *    switch until it settles; `startPublicWindowSeed` is idempotent;
 *    enumeration is `chats/*.json` with valid ids, largest first;
 * 7. more than 3 abandoned ids: no switch, and persists stay legacy (exactly
 *    3 still switches); no compiled entry and no seam abandons at once;
 *    shutdown mid-seed aborts it;
 * 8. without `seed`, the persist is transactional at once and there is no
 *    `startPublicWindowSeed` (the existing suites cover the rest).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostAuthenticatedClientIdentity,
  type HostCommand,
  type HostDeltaEnvelope
} from '../shared/hostProtocol'
import type { HostAuthorityCallContext } from './HostAuthority'
import { HOST_DELTA_JOURNAL_FILENAME } from './HostDeltaStore'
import {
  HOST_PROFILE_CHATS_DIRECTORY,
  HostProfileDomainStore,
  type HostThreadRecordWrittenKind
} from './HostProfileDomainStore'
import { HOST_PUBLIC_WINDOW_FEED_BATCH } from './HostPublicWindowFeeder'
import { HostRuntimeBootstrap } from './HostRuntimeBootstrap'
import {
  createHostStandaloneComposition,
  HOST_PUBLIC_WINDOW_SEED_ABANDON_LIMIT,
  type HostPublicWindowSeedOutcome,
  type HostStandaloneComposition,
  type HostStandaloneCompositionInput,
  type HostStandaloneThreadRecordTransactionInput
} from './HostStandaloneComposition'
import { modelHostThreadRecordFile, type HostThreadRecordModelInput } from './HostThreadRecordModel'
import { prepareHostThreadRecord } from './HostThreadRecordPrepare'
import {
  createHostThreadRecordCommitPort,
  type HostThreadRecordCommitPort
} from './HostThreadRecordTransaction'
import { publishHostThreadRecordTransfer } from './HostThreadRecordTransfer'
import { HostTransactionLog } from './HostTransactionLog'

const NOW_MS = 1_760_000_000_000
const NOW_ISO = new Date(NOW_MS).toISOString()
const BOOT_EPOCH = 'f'.repeat(64)
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
async function settledWithin<T>(promise: Promise<T>, ms = 50): Promise<T | 'pending'> {
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

function persistCommand(
  commandId: string,
  threadId: string,
  descriptor: { transferId: string; sha256: string; byteLength: number },
  expectedRevision: number
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId,
    idempotencyKey: `${commandId}-key`,
    actor: ACTOR,
    name: 'thread.record.persist',
    target: { threadId },
    arguments: { ...descriptor, expectedRevision },
    issuedAt: NOW_ISO
  }
}

function describeDelta(envelope: HostDeltaEnvelope): string {
  return `${envelope.kind}:${envelope.family}:${envelope.entityId}`
}

interface Profile {
  profilePath: string
  runtimePath: string
  store: HostProfileDomainStore
  records: HostThreadRecordCommitPort
  hooked: Array<{ threadId: string; kind: HostThreadRecordWrittenKind }>
  composition: { current: HostStandaloneComposition | null }
  /** Live feeder model requests through the transaction's seam, in order. */
  modelled: string[]
  /** Seed model requests through the seed's seam, in order. */
  seedReads: string[]
  /** Threads whose seed read throws while listed. */
  failing: Set<string>
  /** When set, every seed read awaits it first. */
  seedHold: { promise: Promise<void> | null }
  /** When set, the legacy executor awaits it first: it holds the gate's observer. */
  legacyHold: { promise: Promise<void> | null }
  /** Commands the legacy executor ran, in order. */
  executorCalls: HostCommand[]
  base: Omit<HostStandaloneCompositionInput, 'threadRecordTransaction'>
  transactionInput(
    seed?: HostStandaloneThreadRecordTransactionInput['seed']
  ): HostStandaloneThreadRecordTransactionInput
  /** The seed seam, for `seed: { model }`. */
  seedModel: NonNullable<NonNullable<HostStandaloneThreadRecordTransactionInput['seed']>['model']>
  /** Persists a record at revision 0 through the store, before the composition exists. */
  persist(threadId: string, runCount: number, from: number): void
  /** Publishes a transfer of the thread at the next revision and returns the persist command. */
  persistCommandFor(commandId: string, threadId: string, title: string): HostCommand
  groupLines(commandId: string): number
  chatPath(name: string): string
}

function profile(): Profile {
  const profilePath = mkdtempSync(join(tmpdir(), 'host-standalone-seed-'))
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
  const modelled: string[] = []
  const seedReads: string[] = []
  const failing = new Set<string>()
  const seedHold: Profile['seedHold'] = { promise: null }
  const legacyHold: Profile['legacyHold'] = { promise: null }
  const executorCalls: HostCommand[] = []
  const journal = join(runtimePath, HOST_DELTA_JOURNAL_FILENAME)
  const base: Profile['base'] = {
    runtimePath,
    lease: { assertHeld: () => undefined },
    host: { hostId: 'standalone-host', hostVersion: '1.0.0' },
    hostCapabilityOffer: ['bootstrap', 'snapshot', 'deltas', 'commands', 'receipts', 'health'],
    bootEpochFactory: () => BOOT_EPOCH,
    now: () => NOW_ISO,
    snapshotDonor: () => ({
      health: { hostStatus: 'ok', connectionPhase: 'live', supervised: false, freshness: 'live' },
      workspaces: [],
      threads: [],
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
      warnings: []
    }),
    authorityEvaluator: () => ({ decision: 'allowed' }),
    commandExecutor: async (command) => {
      executorCalls.push(command)
      if (legacyHold.promise) await legacyHold.promise
      return { status: 'succeeded', resultSummary: 'legacy' }
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
    if (failing.has(input.threadId)) throw new Error('injected seed worker failure')
    return modelHostThreadRecordFile(input)
  }
  const chatPath = (name: string) => join(profilePath, HOST_PROFILE_CHATS_DIRECTORY, name)
  return {
    profilePath,
    runtimePath,
    store,
    records,
    hooked,
    composition,
    modelled,
    seedReads,
    failing,
    seedHold,
    legacyHold,
    executorCalls,
    base,
    seedModel,
    transactionInput: (seed) => ({
      profilePath,
      records,
      prepare: async (input) => prepareHostThreadRecord(input),
      model: async (input: HostThreadRecordModelInput) => {
        modelled.push(input.threadId)
        return modelHostThreadRecordFile(input)
      },
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
      return persistCommand(commandId, threadId, descriptor, expectedRevision)
    },
    groupLines: (commandId) => {
      if (!existsSync(journal)) return 0
      return readFileSync(journal, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .filter((line) => {
          const event = JSON.parse(line) as { op: string; commandId?: string }
          return event.op === 'group' && event.commandId === commandId
        }).length
    },
    chatPath
  }
}

/** Counts generation resets delivered to a subscriber. */
function watchResets(composition: HostStandaloneComposition): {
  resets: () => number
  delivered: string[]
  stop: () => void
} {
  const delivered: string[] = []
  let resets = 0
  const stop = composition.subscribeDeltas((event) => {
    delivered.push(describeDelta(event.record.envelope))
    if (event.record.envelope.kind === 'generation-reset') resets += 1
  })
  return { resets: () => resets, delivered, stop }
}

const legacyReceipt = { ok: true, value: { status: 'succeeded', resultSummary: 'legacy' } }
const transactionalReceipt = {
  ok: true,
  value: { status: 'succeeded', resultSummary: 'thread_record_persisted' }
}

describe('HostStandaloneComposition: the public window seed and switch (M4 slice 13f1)', () => {
  it(
    '6. before the switch a persist is legacy; seeded gives one generation reset; after it a persist is transactional; the seed is idempotent and reads chats/*.json with valid ids, largest first',
    async () => {
      const p = profile()
      // Sizes descend a > b > c > d; two files the enumeration must skip.
      p.persist('a', 100, 0)
      p.persist('b', 10, 1_000)
      p.persist('c', 1, 2_000)
      p.persist('d', 0, 0)
      writeFileSync(p.chatPath(' padded.json'), readFileSync(p.chatPath('c.json')), { mode: 0o600 })
      writeFileSync(p.chatPath('notes.txt'), '{}', { mode: 0o600 })

      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput({ model: p.seedModel })
      })
      p.composition.current = composition
      expect(typeof composition.startPublicWindowSeed).toBe('function')
      const watch = watchResets(composition)
      const generationBefore = composition.getPosition().generation
      let outcome: HostPublicWindowSeedOutcome
      let legacyGroups: number
      let transactionalGroups: number
      try {
        const hold = deferred()
        p.seedHold.promise = hold.promise
        const started = composition.startPublicWindowSeed!()
        const again = composition.startPublicWindowSeed!()
        expect(again.seeded).toBe(started.seeded)
        await vi.waitFor(() => expect(p.seedReads.length).toBeGreaterThanOrEqual(1))
        expect(await settledWithin(started.seeded)).toBe('pending')

        // Before the switch: the legacy path, through the stub executor.
        const legacy = await composition.authority.command(
          CONTEXT,
          p.persistCommandFor('cmd-legacy', 'd', 'Legacy d')
        )
        expect(legacy).toMatchObject(legacyReceipt)
        expect(p.executorCalls.map((command) => command.commandId)).toEqual(['cmd-legacy'])
        legacyGroups = p.groupLines('cmd-legacy')
        expect(legacyGroups).toBe(0)
        expect(watch.resets()).toBe(0)
        expect(await settledWithin(started.seeded)).toBe('pending')

        p.seedHold.promise = null
        hold.resolve()
        outcome = await started.seeded
        expect(outcome.kind).toBe('switched')
        if (outcome.kind !== 'switched') return
        expect(outcome.report).toEqual({
          requested: 4,
          modelled: 4,
          absent: 0,
          invalid: 0,
          refused: 0,
          retried: 0,
          abandoned: [],
          aborted: false,
          ms: expect.any(Number)
        })
        // Largest first; the padded id and the non-json file never read.
        expect(p.seedReads).toEqual(['a', 'b', 'c', 'd'])
        // Exactly one generation reset, and the outcome names it.
        expect(watch.resets()).toBe(1)
        expect(outcome.position).toEqual({ generation: generationBefore + 1, cursor: 1 })
        expect(composition.getPosition()).toEqual(outcome.position)
        expect(watch.delivered.filter((row) => row.startsWith('generation-reset:'))).toHaveLength(1)
        // Idempotent: the same seed, the same outcome, no second reset or read.
        expect(await again.seeded).toBe(outcome)
        expect(await composition.startPublicWindowSeed!().seeded).toBe(outcome)
        expect(watch.resets()).toBe(1)
        expect(p.seedReads).toHaveLength(4)

        // After the switch: transactional, with a group.
        const transactional = await composition.authority.command(
          CONTEXT,
          p.persistCommandFor('cmd-txn', 'd', 'Transactional d')
        )
        expect(transactional).toMatchObject(transactionalReceipt)
        expect(p.executorCalls.map((command) => command.commandId)).toEqual(['cmd-legacy'])
        transactionalGroups = p.groupLines('cmd-txn')
        expect(transactionalGroups).toBe(1)
        expect(p.store.threadRecordState('d')?.revision).toBe(1)
        expect(watch.delivered).toContain('upsert:thread:d')
        expect(watch.resets()).toBe(1)
        expect(composition.getPosition().generation).toBe(generationBefore + 1)
        expect(composition.getPosition().cursor).toBeGreaterThan(1)
      } finally {
        watch.stop()
        await composition.shutdown()
      }

      // Receipts: the legacy one without a class, the transactional one with
      // its class; the manifest holds only the transactional persist.
      const reopened = new HostRuntimeBootstrap({ hostDataDir: p.runtimePath })
      const legacyFound = reopened.receiptStore.getByCommandId('cmd-legacy', ACTOR)
      expect(legacyFound.kind).toBe('found')
      if (legacyFound.kind === 'found') {
        expect(legacyFound.receipt.status).toBe('succeeded')
        expect(legacyFound.receipt).not.toHaveProperty('commandClass')
      }
      const transactionalFound = reopened.receiptStore.getByCommandId('cmd-txn', ACTOR)
      expect(transactionalFound.kind).toBe('found')
      if (transactionalFound.kind === 'found') {
        expect(transactionalFound.receipt).toMatchObject({
          status: 'succeeded',
          resultSummary: 'thread_record_persisted',
          commandClass: 'txn-record-persist'
        })
      }
      const log = HostTransactionLog.open({ dataDir: p.runtimePath })
      expect(log.get('cmd-legacy') ?? null).toBeNull()
      expect(log.get('cmd-txn')?.terminal?.kind).toBe('published')
    },
    TIMEOUT
  )

  it(
    '6. a persist holding the gate delays the switch until it settles',
    async () => {
      const p = profile()
      p.persist('a', 3, 0)
      p.persist('b', 2, 100)
      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput({ model: p.seedModel })
      })
      p.composition.current = composition
      const watch = watchResets(composition)
      const order: string[] = []
      try {
        // Hold the seed's reads so the persist is admitted before the switch.
        const seedHold = deferred()
        p.seedHold.promise = seedHold.promise
        const { seeded } = composition.startPublicWindowSeed!()
        void seeded.then(() => order.push('switched'))
        await vi.waitFor(() => expect(p.seedReads.length).toBeGreaterThanOrEqual(1))

        // The persist is legacy (the switch has not happened) and holds the
        // gate for as long as its executor runs.
        const legacyHold = deferred()
        p.legacyHold.promise = legacyHold.promise
        const persisting = composition.authority.command(
          CONTEXT,
          p.persistCommandFor('cmd-held', 'a', 'Held a')
        )
        void persisting.then(() => order.push('persisted'))
        await vi.waitFor(() => expect(p.executorCalls).toHaveLength(1))

        // The seed completes its reads, but the exclusive switch waits for
        // the holder.
        p.seedHold.promise = null
        seedHold.resolve()
        expect(await settledWithin(seeded, 150)).toBe('pending')
        expect(watch.resets()).toBe(0)
        expect(await settledWithin(persisting)).toBe('pending')

        p.legacyHold.promise = null
        legacyHold.resolve()
        expect(await persisting).toMatchObject(legacyReceipt)
        const outcome = await seeded
        expect(outcome.kind).toBe('switched')
        expect(order).toEqual(['persisted', 'switched'])
        expect(watch.resets()).toBe(1)

        // Once switched, the next persist is transactional.
        const transactional = await composition.authority.command(
          CONTEXT,
          p.persistCommandFor('cmd-after', 'b', 'After the switch b')
        )
        expect(transactional).toMatchObject(transactionalReceipt)
        expect(p.groupLines('cmd-after')).toBe(1)
        expect(p.executorCalls.map((command) => command.commandId)).toEqual(['cmd-held'])
      } finally {
        watch.stop()
        await composition.shutdown()
      }
    },
    TIMEOUT
  )

  it(
    `7. more than ${HOST_PUBLIC_WINDOW_SEED_ABANDON_LIMIT} abandoned ids: no switch, and persists stay legacy`,
    async () => {
      expect(HOST_PUBLIC_WINDOW_SEED_ABANDON_LIMIT).toBe(3)
      const p = profile()
      for (const threadId of ['a', 'b', 'c', 'd', 'e']) p.persist(threadId, 1, 0)
      for (const threadId of ['a', 'b', 'c', 'd']) p.failing.add(threadId)
      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput({ model: p.seedModel })
      })
      p.composition.current = composition
      const watch = watchResets(composition)
      const generationBefore = composition.getPosition().generation
      try {
        const { seeded } = composition.startPublicWindowSeed!()
        const outcome = await seeded
        expect(outcome.kind).toBe('abandoned')
        if (outcome.kind !== 'abandoned') return
        expect(typeof outcome.reason).toBe('string')
        expect(outcome.reason.length).toBeGreaterThan(0)
        expect(outcome.report).toMatchObject({
          requested: 5,
          modelled: 1,
          retried: 4,
          aborted: false
        })
        expect([...outcome.report!.abandoned].sort()).toEqual(['a', 'b', 'c', 'd'])
        // Each failing thread read twice, the good one once.
        expect(p.seedReads.filter((id) => id === 'e')).toHaveLength(1)
        for (const threadId of ['a', 'b', 'c', 'd']) {
          expect(p.seedReads.filter((id) => id === threadId)).toHaveLength(2)
        }
        expect(watch.resets()).toBe(0)
        expect(composition.getPosition().generation).toBe(generationBefore)
        // The same outcome again, no second attempt.
        expect(await composition.startPublicWindowSeed!().seeded).toBe(outcome)
        expect(p.seedReads).toHaveLength(9)

        // Persists stay legacy for the incarnation.
        const result = await composition.authority.command(
          CONTEXT,
          p.persistCommandFor('cmd-still-legacy', 'e', 'Still legacy e')
        )
        expect(result).toMatchObject(legacyReceipt)
        expect(p.executorCalls.map((command) => command.commandId)).toEqual(['cmd-still-legacy'])
        expect(p.groupLines('cmd-still-legacy')).toBe(0)
        expect(watch.resets()).toBe(0)
      } finally {
        watch.stop()
        await composition.shutdown()
      }
    },
    TIMEOUT
  )

  it(
    `7. exactly ${HOST_PUBLIC_WINDOW_SEED_ABANDON_LIMIT} abandoned ids still switch`,
    async () => {
      const p = profile()
      for (const threadId of ['a', 'b', 'c', 'd', 'e']) p.persist(threadId, 1, 0)
      for (const threadId of ['a', 'b', 'c']) p.failing.add(threadId)
      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput({ model: p.seedModel })
      })
      p.composition.current = composition
      const watch = watchResets(composition)
      try {
        const outcome = await composition.startPublicWindowSeed!().seeded
        expect(outcome.kind).toBe('switched')
        if (outcome.kind !== 'switched') return
        expect([...outcome.report.abandoned].sort()).toEqual(['a', 'b', 'c'])
        expect(outcome.report).toMatchObject({ requested: 5, modelled: 2, retried: 3 })
        expect(watch.resets()).toBe(1)
        const result = await composition.authority.command(
          CONTEXT,
          p.persistCommandFor('cmd-txn', 'd', 'Transactional d')
        )
        expect(result).toMatchObject(transactionalReceipt)
        expect(p.groupLines('cmd-txn')).toBe(1)
        expect(p.executorCalls).toEqual([])
      } finally {
        watch.stop()
        await composition.shutdown()
      }
    },
    TIMEOUT
  )

  it(
    '7. no compiled entry and no model seam: abandoned at once with no report, and persists stay legacy',
    async () => {
      // The pool looks for the compiled sibling of the worker module; in the
      // source tree it does not exist.
      expect(existsSync(join(__dirname, 'HostThreadRecordTransferWorkerEntry.js'))).toBe(false)
      const p = profile()
      p.persist('a', 1, 0)
      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput({})
      })
      p.composition.current = composition
      const watch = watchResets(composition)
      try {
        const outcome = await settledWithin(composition.startPublicWindowSeed!().seeded, 500)
        expect(outcome).toMatchObject({ kind: 'abandoned', report: null })
        expect((outcome as { reason: string }).reason.length).toBeGreaterThan(0)
        expect(watch.resets()).toBe(0)
        expect(p.seedReads).toEqual([])
        const result = await composition.authority.command(
          CONTEXT,
          p.persistCommandFor('cmd-legacy', 'a', 'Legacy a')
        )
        expect(result).toMatchObject(legacyReceipt)
        expect(p.groupLines('cmd-legacy')).toBe(0)
      } finally {
        watch.stop()
        await composition.shutdown()
      }
    },
    TIMEOUT
  )

  it(
    '7. shutdown mid-seed aborts the seed: abandoned with an aborted report, no switch, no further reads',
    async () => {
      const p = profile()
      const ids = Array.from(
        { length: HOST_PUBLIC_WINDOW_FEED_BATCH + 2 },
        (_, i) => `t-${String(i).padStart(2, '0')}`
      )
      for (const threadId of ids) p.persist(threadId, 1, 0)
      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput({ model: p.seedModel })
      })
      p.composition.current = composition
      const watch = watchResets(composition)
      const hold = deferred()
      p.seedHold.promise = hold.promise
      const { seeded } = composition.startPublicWindowSeed!()
      await vi.waitFor(() => expect(p.seedReads).toHaveLength(HOST_PUBLIC_WINDOW_FEED_BATCH))
      expect(await settledWithin(seeded)).toBe('pending')

      let stopped = false
      const stopping = composition.shutdown().then(() => {
        stopped = true
      })
      // Shutdown waits for the seed read in flight, as it does for any feed.
      expect(await settledWithin(stopping)).toBe('pending')
      expect(stopped).toBe(false)
      p.seedHold.promise = null
      hold.resolve()
      await stopping
      watch.stop()
      const outcome = await settledWithin(seeded, 500)
      expect(outcome).toMatchObject({ kind: 'abandoned', report: { aborted: true } })
      expect((outcome as { report: { requested: number } }).report.requested).toBe(ids.length)
      expect(watch.resets()).toBe(0)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(p.seedReads).toHaveLength(HOST_PUBLIC_WINDOW_FEED_BATCH)
      expect(p.executorCalls).toEqual([])
    },
    TIMEOUT
  )

  it(
    '8. without seed config there is no startPublicWindowSeed and a persist is transactional at once',
    async () => {
      const p = profile()
      p.persist('a', 1, 0)
      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput()
      })
      p.composition.current = composition
      const watch = watchResets(composition)
      try {
        expect(composition.startPublicWindowSeed).toBeUndefined()
        const result = await composition.authority.command(
          CONTEXT,
          p.persistCommandFor('cmd-txn', 'a', 'Transactional a')
        )
        expect(result).toMatchObject(transactionalReceipt)
        expect(p.groupLines('cmd-txn')).toBe(1)
        expect(p.executorCalls).toEqual([])
        expect(p.seedReads).toEqual([])
        expect(watch.resets()).toBe(0)
      } finally {
        watch.stop()
        await composition.shutdown()
      }
    },
    TIMEOUT
  )
})
