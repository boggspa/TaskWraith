/**
 * Independent Threads M4 slice 13e (design §23.12, test 6 at the
 * composition): a transactional persist whose outcome names a refill reaches
 * the feeder through the composition, and the window completes.
 *
 * With the default band (1,800) and the model's candidate cap (1,800), no
 * single model change can leave a full window short on its own: a change
 * touches at most 1,800 kept candidates and the index keeps 3,600. So the
 * short window is built first through the feeder's own path, over the real
 * composition: two deletes in one drain free every kept run, the exhausted
 * thread's refill read fails twice (the `model` seam throws) and the feeder
 * abandons it. The window stays short, and the index still names the
 * thread. A persist of another thread through the public command entry then
 * reports that refill in its outcome; the composition hands it to
 * `feeder.refill`, the seam now succeeds, and the refill lands as a feed
 * group that clears the `still loading` warning.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  HOST_WARNING_PROJECTION_WINDOWED,
  type HostActorIdentity,
  type HostAuthenticatedClientIdentity,
  type HostCommand,
  type HostDeltaEnvelope
} from '../shared/hostProtocol'
import type { HostAuthorityCallContext } from './HostAuthority'
import { HostProfileDomainStore, type HostThreadRecordWrittenKind } from './HostProfileDomainStore'
import {
  createHostStandaloneComposition,
  type HostStandaloneComposition,
  type HostStandaloneCompositionInput
} from './HostStandaloneComposition'
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
const WINDOWED_RUNS = `${HOST_WARNING_PROJECTION_WINDOWED}:runs`

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
  /** Feeder model requests the composition made through the seam, in order. */
  modelled: string[]
  /** Threads whose model read throws while listed. */
  failing: Set<string>
  base: Omit<HostStandaloneCompositionInput, 'threadRecordTransaction'>
  transactionInput(): NonNullable<HostStandaloneCompositionInput['threadRecordTransaction']>
}

function profile(): Profile {
  const profilePath = mkdtempSync(join(tmpdir(), 'host-standalone-refill-'))
  roots.push(profilePath)
  const runtimePath = join(profilePath, 'host-data')
  const hooked: Profile['hooked'] = []
  const composition: Profile['composition'] = { current: null }
  const store = new HostProfileDomainStore({
    profilePath,
    authority: { assertProfileAuthority: () => undefined },
    now: () => NOW_MS,
    // The production server's shape: forward through a ref the composition
    // fills. Without the record, every write is modelled from its file
    // through the seam below, so every read is observable.
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
  const failing = new Set<string>()
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
    commandExecutor: () => ({ status: 'succeeded', resultSummary: 'legacy' }),
    healthProvider: () => ({
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: false,
      freshness: 'live'
    })
  }
  return {
    profilePath,
    runtimePath,
    store,
    records,
    hooked,
    composition,
    modelled,
    failing,
    base,
    transactionInput: () => ({
      profilePath,
      records,
      prepare: async (input) => prepareHostThreadRecord(input),
      model: async (input: HostThreadRecordModelInput) => {
        modelled.push(input.threadId)
        if (failing.has(input.threadId)) throw new Error('injected worker failure')
        return modelHostThreadRecordFile(input)
      },
      now: () => NOW_MS
    })
  }
}

describe('HostStandaloneComposition: persist refills reach the feeder (M4 slice 13e, test 6)', () => {
  it('a persist whose outcome names a refill reaches feeder.refill, and the window completes', async () => {
    const p = profile()
    const composition = createHostStandaloneComposition({
      ...p.base,
      threadRecordTransaction: p.transactionInput()
    })
    p.composition.current = composition
    const delivered: string[] = []
    const warnings: string[] = []
    const unsubscribe = composition.subscribeDeltas((event) => {
      delivered.push(describeDelta(event.record.envelope))
      if (
        event.record.envelope.entityId === WINDOWED_RUNS &&
        event.record.envelope.kind === 'upsert'
      ) {
        warnings.push((event.record.envelope.payload as { message: string }).message)
      }
    })
    const reads = (threadId: string) => p.modelled.filter((id) => id === threadId).length
    try {
      // `a`: 100 old runs, all outside the 3,600 the index keeps once `b` and
      // `c` hold 1,800 newer runs each. `d`: no runs, the thread to persist.
      p.store.persistThreadRecord({
        threadId: 'a',
        record: threadRecord('a', 100, 0),
        expectedRevision: 0
      })
      p.store.persistThreadRecord({
        threadId: 'b',
        record: threadRecord('b', 1_800, 10_000),
        expectedRevision: 0
      })
      p.store.persistThreadRecord({
        threadId: 'c',
        record: threadRecord('c', 1_800, 20_000),
        expectedRevision: 0
      })
      p.store.persistThreadRecord({
        threadId: 'd',
        record: threadRecord('d', 0, 0),
        expectedRevision: 0
      })
      for (const threadId of ['a', 'b', 'c', 'd']) {
        await vi.waitFor(() => expect(delivered).toContain(`upsert:thread:${threadId}`), {
          timeout: 10_000
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(delivered.filter((row) => row.startsWith('upsert:run:a-'))).toHaveLength(0)
      expect(delivered.filter((row) => row.startsWith('upsert:run:'))).toHaveLength(1_800)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('intentionally windowed')
      const readsBefore = reads('a')

      // Two deletes in one drain free every kept run. The absorb read of `a`
      // fails, the short window is published, the retry fails, `a` is abandoned.
      p.failing.add('a')
      const revisionOf = (threadId: string) => p.store.threadRecordState(threadId)!.revision
      expect(p.store.deleteThreadRecord({ threadId: 'b', expectedRevision: revisionOf('b') })).toBe(
        true
      )
      expect(p.store.deleteThreadRecord({ threadId: 'c', expectedRevision: revisionOf('c') })).toBe(
        true
      )
      await vi.waitFor(() => expect(warnings.at(-1)).toContain('still loading'), {
        timeout: 10_000
      })
      await vi.waitFor(() => expect(reads('a')).toBe(readsBefore + 2), { timeout: 10_000 })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(reads('a')).toBe(readsBefore + 2)
      expect(delivered.filter((row) => row.startsWith('upsert:run:a-'))).toHaveLength(0)
      expect(delivered).toContain('tombstone:thread:b')
      expect(delivered).toContain('tombstone:thread:c')

      // A persist of `d` through the public command entry: the index still
      // names `a`, the persist cannot read under the gate, and the composition
      // hands the outcome's refill to the feeder, whose read now succeeds.
      p.failing.delete('a')
      const expectedRevision = revisionOf('d')
      const descriptor = publishHostThreadRecordTransfer({
        profilePath: p.profilePath,
        transferId: 'transfer-d',
        record: threadRecord('d', 0, 0, {
          persistenceRevision: expectedRevision + 1,
          title: 'Persisted d'
        })
      })
      const result = await composition.authority.command(
        CONTEXT,
        persistCommand('cmd-persist-d', 'd', descriptor, expectedRevision)
      )
      expect(result).toMatchObject({
        ok: true,
        value: { status: 'succeeded', resultSummary: 'thread_record_persisted' }
      })
      await vi.waitFor(() => expect(delivered).toContain(`tombstone:warning:${WINDOWED_RUNS}`), {
        timeout: 10_000
      })
      await new Promise((resolve) => setTimeout(resolve, 50))

      // One refill read, after the persist; all of `a`'s runs on the wire; the
      // still-loading warning gone: 100 runs need no window.
      expect(reads('a')).toBe(readsBefore + 3)
      expect(delivered.filter((row) => row.startsWith('upsert:run:a-'))).toHaveLength(100)
      expect(delivered.at(-1)).not.toContain('still loading')
      // The persist's own group carried `d`'s row with the window still
      // short; the refill's feed group, with `a`'s runs, follows it.
      const persistIndex = delivered.indexOf(
        'upsert:thread:d',
        delivered.indexOf('tombstone:thread:c')
      )
      expect(persistIndex).toBeGreaterThan(-1)
      expect(
        delivered.slice(persistIndex).filter((row) => row.startsWith('upsert:run:a-'))
      ).toHaveLength(100)
      expect(
        delivered.slice(persistIndex).indexOf(`tombstone:warning:${WINDOWED_RUNS}`)
      ).toBeGreaterThan(0)
      expect(delivered.slice(0, persistIndex + 1)).not.toContain(
        `tombstone:warning:${WINDOWED_RUNS}`
      )
      // `d` itself was never read again for the refill: only its persist modelled it.
      expect(reads('d')).toBe(1)
    } finally {
      unsubscribe()
      await composition.shutdown()
    }
  }, 60_000)
})
