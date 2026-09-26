/**
 * Independent Threads M4 slice 13f2 (design §23.17): the authority's
 * `recordDerived` port, over a real runtime and a fake index side whose
 * `active()` the test flips.
 *
 * 1. `hostPublicWindowOwnsEffect` over every family and warning id shape;
 * 2. a snapshot while active splices the five families from `wire()`, in
 *    its order, keeps the other families as today, keeps a non-owned
 *    projector warning, and drops the donor's record-derived ones; inactive
 *    (and without the port) the snapshot is unchanged;
 * 3. a snapshot taken while a feed group is appended but not durable
 *    resolves only once it is durable; replaying `since(stamp)` onto it
 *    gives `wire()`; a reset from `durable()` recaptures once, and only once;
 * 4. a legacy command window publishes no owned effect while active and
 *    still publishes the other families; inactive it publishes the five
 *    families as today; an all-owned batch publishes nothing;
 * 5. a queued start whose before-capture preceded the switch publishes no
 *    owned effect after it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HOST_PROTOCOL_MAX_COLLECTION,
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostAuthenticatedClientIdentity,
  type HostCommand,
  type HostParticipantProjection,
  type HostRoundProjection,
  type HostRunProjection,
  type HostSnapshot,
  type HostThreadProjection,
  type HostWarningProjection,
  type HostWorkspaceProjection
} from '../shared/hostProtocol'
import { applyHostSnapshotDeltas } from '../shared/hostSnapshotApply'
import {
  AppStoreHostAuthority,
  createHostStandaloneAuthorityActivationPermit,
  type AppStoreHostAuthorityExecutorResult,
  type AppStoreHostAuthorityPorts,
  type AppStoreHostAuthoritySnapshotDonorFamilies
} from './AppStoreHostAuthority'
import type { HostAuthorityCallContext } from './HostAuthority'
import { fingerprintHostCommand } from './HostCommandFingerprint'
import type { HostCommandReceiptRecord } from './HostCommandReceiptStore'
import type { HostDeltaDurabilityResult } from './HostDeltaStore'
import { hostPublicWindowOwnsEffect, type HostPublicWindowWire } from './HostPublicWindowIndex'
import { HostRuntimeBootstrap } from './HostRuntimeBootstrap'
import { createHostScopeLedger, type HostScopeLedger } from './HostScopeLedger'
import type {
  HostThreadRecordTransactionInput,
  HostThreadRecordTransactionOutcome
} from './HostThreadRecordTransaction'

const NOW = '2026-09-26T09:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const INCARNATION = 'c'.repeat(64)
const TIMEOUT = 10_000

const ACTOR: HostActorIdentity = {
  actorId: 'actor-a',
  clientId: 'client-a',
  clientClass: 'desktop'
}
const CLIENT: HostAuthenticatedClientIdentity = {
  clientId: 'client-a',
  clientClass: 'desktop',
  clientVersion: '1.9.9'
}
const CONTEXT: HostAuthorityCallContext = { actor: ACTOR, client: CLIENT }

type RecordDerivedPort = NonNullable<AppStoreHostAuthorityPorts['recordDerived']>
type TransactionPort = NonNullable<AppStoreHostAuthorityPorts['threadRecordTransaction']>

type Deferred = { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Resolves 'pending' when the promise has not settled within a short grace period. */
async function settledWithin<T>(promise: Promise<T>, ms = 80): Promise<T | 'pending'> {
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

// ── rows ────────────────────────────────────────────────────────────────────

const threadRow = (id: string, title = `Thread ${id}`): HostThreadProjection => ({
  id,
  workspaceId: null,
  title,
  chatKind: 'single',
  archived: false,
  pinned: false,
  updatedAt: 10,
  messageCount: 1
})

const runRow = (runId: string, threadId: string): HostRunProjection => ({
  runId,
  threadId,
  providerId: 'codex',
  providerOutcome: 'completed',
  startedAt: 10,
  endedAt: 11
})

const roundRow = (roundId: string, threadId: string): HostRoundProjection => ({
  roundId,
  threadId,
  status: 'completed',
  startedAt: 10,
  endedAt: 11,
  participantIds: [],
  providerRunIds: []
})

const participantRow = (id: string, threadId: string): HostParticipantProjection => ({
  id,
  threadId,
  providerId: 'codex',
  role: 'worker',
  order: 0,
  enabled: true,
  active: false
})

const warningRow = (warningId: string, message: string): HostWarningProjection => ({
  warningId,
  severity: 'warning',
  code: warningId.split(':')[0]!,
  message,
  at: 5
})

const workspaceRow = (id: string, pinned = false): HostWorkspaceProjection => ({
  id,
  name: `Workspace ${id}`,
  path: `/tmp/${id}`,
  pinned,
  updatedAt: 1
})

/** More workspaces than the collection bound: the projector caps and warns. */
function manyWorkspaces(): HostWorkspaceProjection[] {
  return Array.from({ length: HOST_PROTOCOL_MAX_COLLECTION + 1 }, (_, i) =>
    workspaceRow(`ws-${String(i).padStart(4, '0')}`)
  )
}

interface WireRows {
  threads?: HostThreadProjection[]
  runs?: HostRunProjection[]
  rounds?: HostRoundProjection[]
  participants?: HostParticipantProjection[]
  warnings?: HostWarningProjection[]
}

/** A wire as the index serves it: each family a Map in id order. */
function wireOf(rows: WireRows): HostPublicWindowWire {
  const byId = <T>(items: readonly T[] | undefined, id: (row: T) => string) =>
    new Map(
      [...(items ?? [])]
        .sort((left, right) => (id(left) < id(right) ? -1 : id(left) > id(right) ? 1 : 0))
        .map((row) => [id(row), row as unknown])
    )
  return new Map<string, ReadonlyMap<string, unknown>>([
    ['thread', byId(rows.threads, (row) => row.id)],
    ['run', byId(rows.runs, (row) => row.runId)],
    ['round', byId(rows.rounds, (row) => row.roundId)],
    ['participant', byId(rows.participants, (row) => row.id)],
    ['warning', byId(rows.warnings, (row) => row.warningId)]
  ]) as HostPublicWindowWire
}

function wireValues<T>(wire: HostPublicWindowWire, family: string): T[] {
  return [...(wire.get(family as never)?.values() ?? [])] as T[]
}

function donorFamilies(
  overrides: Partial<AppStoreHostAuthoritySnapshotDonorFamilies> = {}
): AppStoreHostAuthoritySnapshotDonorFamilies {
  return {
    health: { hostStatus: 'ok', connectionPhase: 'live', supervised: true, freshness: 'live' },
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
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings: [],
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
    issuedAt: NOW
  }
}

const OWNED_WARNING_IDS = [
  'projection_windowed:runs',
  'projection_windowed:rounds',
  'projection_rows_omitted:participants',
  'projection_rows_withheld:threads',
  'projection_truncated:warnings',
  'a:b:threads'
]
const NOT_OWNED_WARNING_IDS = [
  'projection_truncated:workspaces',
  'projection_truncated:approvals',
  'host_degraded',
  'threads',
  'runs:',
  'projection_windowed:run',
  'projection_windowed:thread',
  'projection_windowed:runs:extra'
]

describe('hostPublicWindowOwnsEffect (M4 slice 13f2, test 1)', () => {
  it.each(['thread', 'run', 'round', 'participant'])(
    'owns every row of the %s family',
    (family) => {
      expect(hostPublicWindowOwnsEffect(family, 'any')).toBe(true)
      expect(hostPublicWindowOwnsEffect(family, 'projection_truncated:workspaces')).toBe(true)
      expect(hostPublicWindowOwnsEffect(family, '')).toBe(true)
    }
  )

  it.each([
    'workspace',
    'mission',
    'provider',
    'routing',
    'question',
    'approval',
    'schedule',
    'usage',
    'artifact',
    'channel',
    'recovery',
    'health',
    'snapshot-meta',
    'threads',
    'warnings'
  ])('owns nothing in the %s family, whatever the id', (family) => {
    expect(hostPublicWindowOwnsEffect(family, 'projection_windowed:runs')).toBe(false)
    expect(hostPublicWindowOwnsEffect(family, 'thread-1')).toBe(false)
  })

  it.each(OWNED_WARNING_IDS)('owns the warning %s', (warningId) => {
    expect(hostPublicWindowOwnsEffect('warning', warningId)).toBe(true)
  })

  it.each(NOT_OWNED_WARNING_IDS)('does not own the warning %s', (warningId) => {
    expect(hostPublicWindowOwnsEffect('warning', warningId)).toBe(false)
  })
})

describe('AppStoreHostAuthority: captures read the public window index (M4 slice 13f2)', () => {
  let hostDataDir: string
  let runtime: HostRuntimeBootstrap
  let ledger: HostScopeLedger
  /** When set, group durability (the journal fsync) waits on it. */
  let fsyncHold: { promise: Promise<void> | null }
  let donor: AppStoreHostAuthoritySnapshotDonorFamilies
  let executorCalls: HostCommand[]
  let executorResult: (command: HostCommand) => AppStoreHostAuthorityExecutorResult
  let ports: AppStoreHostAuthorityPorts

  beforeEach(() => {
    hostDataDir = mkdtempSync(join(tmpdir(), 'appstore-host-auth-record-derived-'))
    fsyncHold = { promise: null }
    runtime = new HostRuntimeBootstrap({
      hostDataDir,
      delta: {
        now: () => NOW,
        groupFsync: async () => {
          if (fsyncHold.promise) await fsyncHold.promise
        }
      },
      receipts: { now: () => NOW }
    })
    ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    donor = donorFamilies()
    executorCalls = []
    executorResult = () => ({ status: 'succeeded', resultSummary: 'legacy' })
    ports = {
      runtime,
      snapshotDonor: () => donor,
      authorityEvaluator: () => ({ decision: 'allowed', reason: 'test allow' }),
      commandExecutor: (cmd) => {
        executorCalls.push(cmd)
        return executorResult(cmd)
      },
      healthProvider: () => ({
        hostStatus: 'ok',
        connectionPhase: 'live',
        supervised: true,
        freshness: 'live'
      }),
      onShutdown: () => undefined
    }
  })

  afterEach(() => {
    fsyncHold.promise = null
    rmSync(hostDataDir, { recursive: true, force: true })
  })

  /** A transaction that never runs: the port is wired so recordDerived may be. */
  function transactionPort(): TransactionPort {
    return {
      ledger,
      available: () => true,
      create: () => ({
        execute: async (
          _input: HostThreadRecordTransactionInput
        ): Promise<HostThreadRecordTransactionOutcome> => {
          throw new Error('no persist runs in this suite')
        }
      })
    } as TransactionPort
  }

  interface FakeRecordDerived {
    port: RecordDerivedPort
    active: boolean
    wire: HostPublicWindowWire
    reads: number
    durables: number
    /** Answers `durable()` in order; the store's own answer once exhausted. */
    durableAnswers: HostDeltaDurabilityResult[]
  }

  function recordDerived(wire: HostPublicWindowWire, active = true): FakeRecordDerived {
    const self: FakeRecordDerived = {
      active,
      wire,
      reads: 0,
      durables: 0,
      durableAnswers: [],
      port: {
        active: () => self.active,
        read: async () => {
          self.reads += 1
          return self.wire
        },
        durable: async () => {
          self.durables += 1
          const scripted = self.durableAnswers.shift()
          if (scripted) return scripted
          return runtime.deltaStore.awaitDurable()
        }
      }
    }
    return self
  }

  function open(overrides: Partial<AppStoreHostAuthorityPorts> = {}): AppStoreHostAuthority {
    const permit = createHostStandaloneAuthorityActivationPermit({ assertHeld: () => undefined })
    return new AppStoreHostAuthority({
      mode: 'standalone',
      activationPermit: permit,
      now: () => NOW,
      ports: {
        ...ports,
        threadRecordTransaction: transactionPort(),
        fence: <T>(_label: string, operation: () => Promise<T>) => operation(),
        ...overrides
      }
    })
  }

  function stored(commandId: string): HostCommandReceiptRecord | null {
    const found = runtime.receiptStore.getByCommandId(commandId, ACTOR)
    return found.kind === 'found' ? found.receipt : null
  }

  async function snapshotOf(authority: AppStoreHostAuthority): Promise<HostSnapshot> {
    const result = await authority.snapshot(CONTEXT)
    if (!result.ok) throw new Error(`snapshot ${result.error}`)
    return result.value
  }

  /** Every journalled delta of the current generation, oldest first. */
  function journalled(): string[] {
    const since = runtime.deltaStore.since({
      generation: runtime.getPosition().generation,
      cursor: 0
    })
    if (since.kind !== 'deltas') throw new Error(`unexpected ${since.kind}`)
    return since.deltas.map((delta) => `${delta.kind}:${delta.family}:${delta.entityId}`)
  }

  const describeWarnings = (snapshot: HostSnapshot): string[] =>
    snapshot.warnings.map((warning) => `${warning.warningId}=${warning.message}`)

  describe('2. the snapshot', () => {
    const wire = () =>
      wireOf({
        threads: [threadRow('b'), threadRow('a')],
        runs: [runRow('run-2', 'b'), runRow('run-1', 'a')],
        rounds: [roundRow('round-1', 'b')],
        participants: [participantRow('seat-1', 'b')],
        warnings: [warningRow('projection_windowed:runs', 'from the index')]
      })

    beforeEach(() => {
      donor = donorFamilies({
        workspaces: manyWorkspaces(),
        threads: [threadRow('donor-only'), threadRow('a', 'Stale donor copy of a')],
        runs: [runRow('donor-run', 'donor-only')],
        rounds: [roundRow('donor-round', 'donor-only')],
        participants: [participantRow('donor-seat', 'donor-only')],
        warnings: [
          warningRow('projection_windowed:runs', 'from the donor'),
          warningRow('projection_rows_omitted:participants', 'from the donor')
        ]
      })
    })

    it(
      'while active, the five families are the wire rows in wire order, the rest is today’s, a non-owned projector warning survives',
      async () => {
        const source = recordDerived(wire())
        const authority = open({ recordDerived: source.port })

        const snapshot = await snapshotOf(authority)

        expect(snapshot.threads).toEqual(wireValues(source.wire, 'thread'))
        expect(snapshot.threads.map((row) => row.id)).toEqual(['a', 'b'])
        expect(snapshot.runs).toEqual(wireValues(source.wire, 'run'))
        expect(snapshot.runs.map((row) => row.runId)).toEqual(['run-1', 'run-2'])
        expect(snapshot.rounds).toEqual(wireValues(source.wire, 'round'))
        expect(snapshot.participants).toEqual(wireValues(source.wire, 'participant'))
        // Today's other families: the workspaces capped at the bound.
        expect(snapshot.workspaces).toHaveLength(HOST_PROTOCOL_MAX_COLLECTION)
        expect(snapshot.workspaces[0]!.id).toBe('ws-0000')
        // The projector's own (non-owned) warning, then the wire's, by id; the
        // donor's record-derived warnings are gone.
        expect(describeWarnings(snapshot)).toEqual([
          `projection_truncated:workspaces=${
            snapshot.warnings.find((w) => w.warningId === 'projection_truncated:workspaces')!
              .message
          }`,
          'projection_windowed:runs=from the index'
        ])
        expect(snapshot.warnings[0]).toMatchObject({
          code: 'projection_truncated',
          at: NOW_MS
        })
        expect(snapshot.threads.find((row) => row.id === 'donor-only')).toBeUndefined()
        expect(snapshot).toMatchObject({
          generation: runtime.getPosition().generation,
          cursor: runtime.getPosition().cursor,
          freshness: 'live',
          generatedAt: NOW
        })
        expect(source.reads).toBe(1)
        expect(source.durables).toBe(1)
      },
      TIMEOUT
    )

    it(
      'while inactive the snapshot is unchanged: donor families, donor warnings, no read (negative control)',
      async () => {
        const source = recordDerived(wire(), false)
        const authority = open({ recordDerived: source.port })

        const snapshot = await snapshotOf(authority)

        expect(snapshot.threads.map((row) => row.id)).toEqual(['a', 'donor-only'])
        expect(snapshot.threads.find((row) => row.id === 'a')?.title).toBe('Stale donor copy of a')
        expect(snapshot.runs.map((row) => row.runId)).toEqual(['donor-run'])
        expect(snapshot.rounds.map((row) => row.roundId)).toEqual(['donor-round'])
        expect(snapshot.participants.map((row) => row.id)).toEqual(['donor-seat'])
        expect(snapshot.workspaces).toHaveLength(HOST_PROTOCOL_MAX_COLLECTION)
        expect(
          snapshot.warnings.map((warning) => `${warning.warningId}=${warning.message}`)
        ).toEqual([
          'projection_rows_omitted:participants=from the donor',
          expect.stringMatching(/^projection_truncated:workspaces=/),
          'projection_windowed:runs=from the donor'
        ])
        expect(source.reads).toBe(0)
        expect(source.durables).toBe(0)
      },
      TIMEOUT
    )

    it(
      'without the port the snapshot equals the inactive one (test 7)',
      async () => {
        const inactive = await snapshotOf(
          open({ recordDerived: recordDerived(wire(), false).port })
        )
        const absent = await snapshotOf(open())
        expect(absent).toEqual(inactive)
      },
      TIMEOUT
    )

    it(
      'a read that throws is host_unavailable, never a donor snapshot',
      async () => {
        const source = recordDerived(wire())
        source.port = {
          ...source.port,
          read: async () => {
            throw new Error('publication lock closed')
          }
        }
        const authority = open({ recordDerived: source.port })
        await expect(authority.snapshot(CONTEXT)).resolves.toEqual({
          ok: false,
          error: 'host_unavailable'
        })
      },
      TIMEOUT
    )
  })

  describe('3. the stamp and durability', () => {
    it(
      'a snapshot taken while a feed group is appended but not durable resolves only once it is; since(stamp) replayed onto it gives wire()',
      async () => {
        const hold = deferred()
        fsyncHold.promise = hold.promise
        const appended = runtime.deltaStore.appendGroup({
          commandId: 'feed:1',
          effects: [
            { kind: 'upsert', family: 'thread', entityId: 'a', payload: threadRow('a') },
            { kind: 'upsert', family: 'run', entityId: 'run-1', payload: runRow('run-1', 'a') }
          ]
        })
        expect(appended.kind).toBe('appended')
        const durableHead = runtime.getPosition()
        expect(durableHead.cursor).toBe(0)
        expect(runtime.deltaStore.getAppendedPosition().cursor).toBe(2)

        // The index committed before its group appended: the wire holds the rows.
        const source = recordDerived(
          wireOf({ threads: [threadRow('a')], runs: [runRow('run-1', 'a')] })
        )
        const authority = open({ recordDerived: source.port })
        const pending = authority.snapshot(CONTEXT)
        expect(await settledWithin(pending)).toBe('pending')
        expect(source.reads).toBe(1)
        expect(source.durables).toBe(1)

        fsyncHold.promise = null
        hold.resolve()
        const result = await pending
        if (!result.ok) throw new Error(`snapshot ${result.error}`)
        const snapshot = result.value
        expect(runtime.getPosition().cursor).toBe(2)
        // Stamped at the durable head at capture: the group is past the stamp.
        expect(snapshot.generation).toBe(durableHead.generation)
        expect(snapshot.cursor).toBe(durableHead.cursor)
        expect(snapshot.threads).toEqual(wireValues(source.wire, 'thread'))
        expect(snapshot.runs).toEqual(wireValues(source.wire, 'run'))

        // A client replaying from the stamp ends at the wire.
        const since = runtime.deltaStore.since({
          generation: snapshot.generation,
          cursor: snapshot.cursor
        })
        if (since.kind !== 'deltas') throw new Error(`unexpected ${since.kind}`)
        expect(since.deltas.map((delta) => `${delta.family}:${delta.entityId}`)).toEqual([
          'thread:a',
          'run:run-1'
        ])
        const replayed = applyHostSnapshotDeltas(snapshot, since.deltas)
        expect(['applied', 'unchanged']).toContain(replayed.outcome)
        if (replayed.outcome !== 'applied' && replayed.outcome !== 'unchanged') return
        expect(replayed.cursor).toBe(2)
        expect(replayed.snapshot.threads).toEqual(wireValues(source.wire, 'thread'))
        expect(replayed.snapshot.runs).toEqual(wireValues(source.wire, 'run'))
        expect(source.reads).toBe(1)
      },
      TIMEOUT
    )

    it(
      'a reset reported by durable() recaptures once; a second reset returns the capture anyway',
      async () => {
        const source = recordDerived(wireOf({ threads: [threadRow('a')] }))
        const authority = open({ recordDerived: source.port })
        const position = runtime.getPosition()
        const reset: HostDeltaDurabilityResult = {
          kind: 'reset',
          position: { generation: position.generation + 1, cursor: 1 },
          detail: 'group durability failed'
        }

        source.durableAnswers = [reset, { kind: 'durable', position }]
        const once = await snapshotOf(authority)
        expect(once.threads).toEqual(wireValues(source.wire, 'thread'))
        expect(source.reads).toBe(2)
        expect(source.durables).toBe(2)

        source.durableAnswers = [reset, { ...reset }]
        const twice = await snapshotOf(authority)
        expect(twice.threads).toEqual(wireValues(source.wire, 'thread'))
        expect(source.reads).toBe(4)
        expect(source.durables).toBe(4)
      },
      TIMEOUT
    )

    it(
      'a snapshot while nothing is pending resolves without waiting',
      async () => {
        const source = recordDerived(wireOf({ threads: [threadRow('a')] }))
        const authority = open({ recordDerived: source.port })
        const hold = deferred()
        fsyncHold.promise = hold.promise
        // Nothing appended: durability is immediate even with the fsync held.
        const result = await settledWithin(authority.snapshot(CONTEXT), 500)
        expect(result).not.toBe('pending')
        expect(result).toMatchObject({ ok: true })
        fsyncHold.promise = null
        hold.resolve()
      },
      TIMEOUT
    )
  })

  describe('4b. a command window leaves the five families to the index (RR-6)', () => {
    /**
     * After the switch nothing projects the five families from records, so a
     * window must not fail on its own thread's record-derived row. The donor's
     * row for the target carries a credential-like value the projector refuses
     * (`inspectHostSnapshotPrivacy`): only the strip keeps it out of the capture.
     */
    beforeEach(() => {
      donor = donorFamilies({
        workspaces: [workspaceRow('ws-1')],
        threads: [threadRow('thread-1', 'token ghp_0123456789abcdef in the title')]
      })
      executorResult = () => ({
        status: 'succeeded',
        resultSummary: 'selected',
        resultRef: { kind: 'workspace', workspaceId: 'ws-1' }
      })
    })

    it(
      'while active the window succeeds despite the refused thread row, and the workspace still publishes',
      async () => {
        const source = recordDerived(wireOf({ threads: [threadRow('thread-1')] }))
        const authority = open({ recordDerived: source.port })

        const result = await authority.command(
          CONTEXT,
          command('thread.select', 'sel-refused-active', { threadId: 'thread-1' })
        )

        expect(result).toMatchObject({ ok: true, value: { status: 'succeeded' } })
        expect(executorCalls.map((cmd) => cmd.commandId)).toEqual(['sel-refused-active'])
        expect(journalled()).toEqual(['upsert:workspace:ws-1'])
        expect(stored('sel-refused-active')).toMatchObject({ status: 'succeeded', cursor: 1 })
      },
      TIMEOUT
    )

    it(
      'while inactive the same window does not succeed: the refused row fails its capture as today (negative control)',
      async () => {
        const source = recordDerived(wireOf({ threads: [threadRow('thread-1')] }), false)
        const authority = open({ recordDerived: source.port })

        const result = await authority.command(
          CONTEXT,
          command('thread.select', 'sel-refused-inactive', { threadId: 'thread-1' })
        )

        // The before-capture refuses the row, so the executor never runs and
        // the receipt fails closed at the current position.
        expect(result).toMatchObject({
          ok: true,
          value: { status: 'failed', errorCode: 'pre_execution_before_snapshot_capture_failed' }
        })
        expect(executorCalls).toEqual([])
        expect(stored('sel-refused-inactive')).toMatchObject({ status: 'failed', cursor: 0 })
        expect(journalled()).toEqual([])
      },
      TIMEOUT
    )
  })

  describe('4. a legacy command window', () => {
    /**
     * thread.select on thread-1: the executor retitles the thread in the donor
     * and names a workspace in its result, so the window observes a thread
     * change (owned) and a workspace row entering scope (not owned).
     */
    function selectingExecutor(): void {
      executorResult = (cmd) => {
        const threadId = cmd.target.threadId as string
        donor = {
          ...donor,
          threads: donor.threads.map((row) =>
            row.id === threadId ? { ...row, title: `Selected ${cmd.commandId}` } : row
          )
        }
        return {
          status: 'succeeded',
          resultSummary: 'selected',
          resultRef: { kind: 'workspace', workspaceId: 'ws-1' }
        }
      }
    }

    beforeEach(() => {
      donor = donorFamilies({
        workspaces: [workspaceRow('ws-1')],
        threads: [threadRow('thread-1')],
        runs: [runRow('run-1', 'thread-1')]
      })
      selectingExecutor()
    })

    it(
      'while active it publishes no owned effect and still publishes the workspace',
      async () => {
        const source = recordDerived(wireOf({ threads: [threadRow('thread-1')] }))
        const authority = open({ recordDerived: source.port })

        const result = await authority.command(
          CONTEXT,
          command('thread.select', 'sel-active', { threadId: 'thread-1' })
        )

        expect(result).toMatchObject({ ok: true, value: { status: 'succeeded' } })
        expect(executorCalls.map((cmd) => cmd.commandId)).toEqual(['sel-active'])
        expect(journalled()).toEqual(['upsert:workspace:ws-1'])
        expect(stored('sel-active')).toMatchObject({
          status: 'succeeded',
          generation: runtime.getPosition().generation,
          cursor: 1
        })
        // The window never asked the index for anything.
        expect(source.reads).toBe(0)
      },
      TIMEOUT
    )

    it(
      'while inactive it publishes the five families as today (negative control)',
      async () => {
        const source = recordDerived(wireOf({ threads: [threadRow('thread-1')] }), false)
        const authority = open({ recordDerived: source.port })

        const result = await authority.command(
          CONTEXT,
          command('thread.select', 'sel-inactive', { threadId: 'thread-1' })
        )

        expect(result).toMatchObject({ ok: true, value: { status: 'succeeded' } })
        expect(journalled()).toEqual(['upsert:workspace:ws-1', 'upsert:thread:thread-1'])
        expect(source.reads).toBe(0)
      },
      TIMEOUT
    )

    it(
      'a window whose before-capture was inactive and whose publication is active drops the owned tombstones it would have carried',
      async () => {
        const source = recordDerived(wireOf({ threads: [threadRow('thread-1')] }), false)
        const authority = open({ recordDerived: source.port })
        // The switch lands between the captures: the after-donor is emptied,
        // so the raw diff would tombstone the thread and its run.
        executorResult = () => {
          source.active = true
          return {
            status: 'succeeded',
            resultSummary: 'selected',
            resultRef: { kind: 'workspace', workspaceId: 'ws-1' }
          }
        }

        const result = await authority.command(
          CONTEXT,
          command('thread.select', 'sel-straddle', { threadId: 'thread-1' })
        )

        expect(result).toMatchObject({ ok: true, value: { status: 'succeeded' } })
        expect(journalled()).toEqual(['upsert:workspace:ws-1'])
      },
      TIMEOUT
    )

    it(
      'an all-owned batch publishes nothing: the position stands and the receipt still succeeds',
      async () => {
        const source = recordDerived(wireOf({ threads: [threadRow('thread-1')] }))
        const authority = open({ recordDerived: source.port })
        executorResult = (cmd) => {
          donor = {
            ...donor,
            threads: donor.threads.map((row) => ({ ...row, title: `Only ${cmd.commandId}` }))
          }
          return { status: 'succeeded', resultSummary: 'selected' }
        }
        const before = runtime.getPosition()

        const result = await authority.command(
          CONTEXT,
          command('thread.select', 'sel-owned-only', { threadId: 'thread-1' })
        )

        expect(result).toMatchObject({ ok: true, value: { status: 'succeeded' } })
        expect(runtime.getPosition()).toEqual(before)
        expect(journalled()).toEqual([])
        expect(stored('sel-owned-only')).toMatchObject({
          status: 'succeeded',
          generation: before.generation,
          cursor: before.cursor
        })
      },
      TIMEOUT
    )

    it(
      'the same all-owned batch is published while inactive (negative control)',
      async () => {
        const source = recordDerived(wireOf({ threads: [threadRow('thread-1')] }), false)
        const authority = open({ recordDerived: source.port })
        executorResult = (cmd) => {
          donor = {
            ...donor,
            threads: donor.threads.map((row) => ({ ...row, title: `Only ${cmd.commandId}` }))
          }
          return { status: 'succeeded', resultSummary: 'selected' }
        }

        await authority.command(
          CONTEXT,
          command('thread.select', 'sel-owned-inactive', { threadId: 'thread-1' })
        )

        expect(journalled()).toEqual(['upsert:thread:thread-1'])
      },
      TIMEOUT
    )
  })

  describe('5. a queued start straddling the switch', () => {
    /** Drives one composer.send from the ack to the settled dispatch. */
    async function queuedStart(
      authority: AppStoreHostAuthority,
      source: FakeRecordDerived,
      commandId: string,
      switchBeforeSettle: boolean
    ): Promise<void> {
      const send = command('composer.send', commandId, { threadId: 'thread-1' }, { text: 'hello' })
      const acked = await authority.command(CONTEXT, send)
      expect(acked).toMatchObject({ ok: true, value: { status: 'pending', phase: 'queued' } })
      const fingerprint = fingerprintHostCommand(send).fingerprint
      authority.handleQueuedStartStarting({
        commandId,
        threadId: 'thread-1',
        fingerprint,
        phase: 'starting',
        executionClaimCursor: { coverageEpoch: 'a'.repeat(64), sequence: 1 },
        startedEvidence: false,
        terminalOutcome: null
      })
      // The dispatch persisted the run and the prompt: the donor now shows them.
      donor = {
        ...donor,
        threads: [{ ...threadRow('thread-1'), messageCount: 2, updatedAt: 20 }],
        runs: [{ ...runRow(commandId, 'thread-1'), providerOutcome: 'running' }]
      }
      authority.handleQueuedStartStarted({
        commandId,
        threadId: 'thread-1',
        fingerprint,
        phase: 'started',
        startedEvidence: true,
        terminalOutcome: null
      })
      if (switchBeforeSettle) source.active = true
      authority.handleQueuedStartDispatchSettled(commandId, { status: 'succeeded' })
      await authority.drainQueuedStartPublication()
    }

    beforeEach(() => {
      donor = donorFamilies({
        workspaces: [workspaceRow('ws-1')],
        threads: [threadRow('thread-1')]
      })
    })

    it(
      'a start registered before the switch publishes no owned effect after it',
      async () => {
        const source = recordDerived(wireOf({ threads: [threadRow('thread-1')] }), false)
        const authority = open({
          recordDerived: source.port,
          queuedComposerSend: () => ({ status: 'succeeded', resultSummary: 'run_queued' })
        })

        await queuedStart(authority, source, 'send-straddle', true)

        expect(journalled()).toEqual([])
        expect(runtime.getPosition().cursor).toBe(0)
        const receipt = stored('send-straddle')
        expect(receipt).not.toBeNull()
        expect(receipt?.status).not.toBe('pending')
      },
      TIMEOUT
    )

    it(
      'that start still completes as a started run: the index carries its rows',
      async () => {
        const source = recordDerived(wireOf({ threads: [threadRow('thread-1')] }), false)
        const authority = open({
          recordDerived: source.port,
          queuedComposerSend: () => ({ status: 'succeeded', resultSummary: 'run_queued' })
        })

        await queuedStart(authority, source, 'send-straddle-ok', true)

        expect(stored('send-straddle-ok')).toMatchObject({ status: 'succeeded', phase: 'started' })
      },
      TIMEOUT
    )

    it(
      'a start entirely after the switch publishes no owned effect and still completes as a started run',
      async () => {
        const source = recordDerived(wireOf({ threads: [threadRow('thread-1')] }), true)
        const authority = open({
          recordDerived: source.port,
          queuedComposerSend: () => ({ status: 'succeeded', resultSummary: 'run_queued' })
        })

        await queuedStart(authority, source, 'send-after', false)

        expect(journalled()).toEqual([])
        expect(stored('send-after')).toMatchObject({ status: 'succeeded', phase: 'started' })
      },
      TIMEOUT
    )

    it(
      'a start entirely before the switch publishes its run and thread as today (negative control)',
      async () => {
        const source = recordDerived(wireOf({ threads: [threadRow('thread-1')] }), false)
        const authority = open({
          recordDerived: source.port,
          queuedComposerSend: () => ({ status: 'succeeded', resultSummary: 'run_queued' })
        })

        await queuedStart(authority, source, 'send-legacy', false)

        expect(journalled().sort()).toEqual(
          ['upsert:run:send-legacy', 'upsert:thread:thread-1'].sort()
        )
        expect(stored('send-legacy')).toMatchObject({ status: 'succeeded', phase: 'started' })
      },
      TIMEOUT
    )
  })
})
