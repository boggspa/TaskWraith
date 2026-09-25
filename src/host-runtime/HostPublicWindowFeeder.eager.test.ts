/**
 * Independent Threads M4 slice 13c2 (design §23.8, tests 1–5): the run port
 * feeds the public window index through an eager model of the record the
 * write published. The store's `onThreadRecordWritten` hook is wired to a
 * real `HostPublicWindowFeeder` the way the production server wires it
 * (through a ref filled once the feeder exists), over a real
 * `HostPublicWindowIndex`, a real `HostDeltaStore` in a temp data directory
 * and a serial publication lock. Nothing is stubbed away: the only seams
 * record port calls and can hold the publication lock.
 *
 * 1. each run-port write (`appendTranscript`, `updateRun`, `recordRunTool`)
 *    through the real store lands in `wire()` as the thread's current rows,
 *    with no worker model asked;
 * 2. equivalence: the record the hook passes models, through
 *    `modelHostThreadRecordEffects`, exactly what `modelHostThreadRecordFile`
 *    reads back from the file the same write produced, for every writer kind
 *    on a thread with seats, a live round and round-member runs;
 * 3. coalescing: 50 run-port writes between drains compute 50 eager models
 *    and publish one group holding the latest;
 * 4. the pending entry holds the model and never the record: a structural
 *    walk from the feeder never meets the written record, its transcript or
 *    its runs, and the record is garbage-collectable while its model is still
 *    pending;
 * 5. a record whose model throws counts a failure, drops that thread's
 *    pending entry, and the other threads in the drain still publish.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'

import { afterEach, describe, expect, it } from 'vitest'

import type { HostRunProjection, HostThreadProjection } from '../shared/hostProtocol'
import { HOST_DELTA_JOURNAL_FILENAME, HostDeltaStore } from './HostDeltaStore'
import {
  HOST_PROFILE_CHATS_DIRECTORY,
  HostProfileDomainStore,
  type HostProfileThread,
  type HostThreadRecordWrittenKind
} from './HostProfileDomainStore'
import {
  HostPublicWindowFeeder,
  type HostPublicWindowFeederOptions
} from './HostPublicWindowFeeder'
import { HostPublicWindowIndex } from './HostPublicWindowIndex'
import {
  modelHostThreadRecordEffects,
  type HostThreadRecordModelled
} from './HostThreadRecordEffectModel'
import { modelHostThreadRecordFile, type HostThreadRecordFileModel } from './HostThreadRecordModel'
import {
  decodeHostThreadRecordTransferBody,
  publishHostThreadRecordTransfer,
  verifyHostThreadRecordTransfer
} from './HostThreadRecordTransfer'

const NOW = 1_760_000_000_000
const NOW_ISO = new Date(NOW).toISOString()
const STARTED_AT = NOW_ISO
const ENDED_AT = new Date(NOW + 1_000).toISOString()

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

interface Hooked {
  threadId: string
  kind: HostThreadRecordWrittenKind
  /** The record the hook received; absent when the harness does not retain records. */
  thread: HostProfileThread | undefined
}

interface Harness {
  profilePath: string
  store: HostProfileDomainStore
  deltas: HostDeltaStore
  index: HostPublicWindowIndex
  feeder: HostPublicWindowFeeder
  /** Every hook call the store made, in order. */
  hooked: Hooked[]
  /** Every port call the feeder made, in order. */
  events: string[]
  /** Thread ids the feeder asked the (13c1) file model for, in order. */
  modelled: string[]
  /** When set, the publication lock waits on it before admitting work. */
  holdLock: { promise: Promise<void> | null }
  journalFeedGroups(): string[]
  wireIds(family: 'thread' | 'run'): string[]
  wireThread(threadId: string): HostThreadProjection | null
  wireRun(runId: string): HostRunProjection | null
  chatPath(threadId: string): string
  /** The 13c1 worker model of the thread's committed file, which must be modelled, not refused. */
  fileModel(threadId: string): ModelledFile
}

interface ModelledFile {
  readonly kind: 'modelled'
  readonly revision: number
  readonly effects: HostThreadRecordModelled
}

function harness(options: { retainRecords?: boolean } = {}): Harness {
  const retainRecords = options.retainRecords ?? true
  const profilePath = mkdtempSync(join(tmpdir(), 'host-public-window-feeder-eager-'))
  roots.push(profilePath)
  const dataDir = join(profilePath, 'host-data')
  mkdirSync(dataDir)
  const hooked: Hooked[] = []
  const events: string[] = []
  const modelled: string[] = []
  const holdLock: Harness['holdLock'] = { promise: null }
  const feederRef: { current: HostPublicWindowFeeder | null } = { current: null }
  let sequence = 0
  const store = new HostProfileDomainStore({
    profilePath,
    authority: { assertProfileAuthority: () => undefined },
    now: () => NOW,
    idFactory: () => `thread-${String(++sequence).padStart(3, '0')}`,
    // The production server's shape: forward through a ref filled later.
    onThreadRecordWritten: (threadId, kind, thread) => {
      hooked.push({ threadId, kind, thread: retainRecords ? thread : undefined })
      feederRef.current?.mark(threadId, kind, thread)
    }
  })
  const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
  const deltas = new HostDeltaStore({ dataDir, now: () => NOW_ISO, compactAfterRecords: 100_000 })
  const index = new HostPublicWindowIndex()
  let tail: Promise<unknown> = Promise.resolve()
  const publicationLock: HostPublicWindowFeederOptions['publicationLock'] = <T>(
    work: () => Promise<T> | T
  ): Promise<T> => {
    const run = tail.then(async () => {
      events.push('lock:requested')
      if (holdLock.promise) await holdLock.promise
      events.push('lock:enter')
      try {
        return await work()
      } finally {
        events.push('lock:exit')
      }
    })
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
  const feeder = new HostPublicWindowFeeder({
    index: {
      prepare: (changes, publication) => {
        events.push(`index:prepare(${changes.map((c) => c.kind).join(',')})`)
        return index.prepare(changes, publication)
      }
    },
    publicationLock,
    deltas: {
      appendGroup: (input) => {
        events.push(`deltas:appendGroup(${input.commandId})`)
        return deltas.appendGroup(input)
      },
      awaitDurable: () => {
        events.push('deltas:awaitDurable')
        return deltas.awaitDurable()
      },
      getPosition: () => deltas.getPosition(),
      releaseGroup: (commandId) => {
        events.push(`deltas:releaseGroup(${commandId})`)
        return deltas.releaseGroup(commandId)
      }
    },
    model: async (threadId) => {
      events.push(`model(${threadId})`)
      modelled.push(threadId)
      return modelHostThreadRecordFile({ profilePath, threadId })
    },
    now: () => NOW
  })
  feederRef.current = feeder
  const chatPath = (threadId: string): string =>
    join(profilePath, HOST_PROFILE_CHATS_DIRECTORY, `${threadId}.json`)
  return {
    profilePath,
    store,
    deltas,
    index,
    feeder,
    hooked,
    events,
    modelled,
    holdLock,
    journalFeedGroups: () => {
      if (!existsSync(journal)) return []
      return readFileSync(journal, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { op: string; commandId?: string })
        .filter((event) => event.op === 'group' && event.commandId?.startsWith('feed:'))
        .map((event) => event.commandId!)
    },
    wireIds: (family) => [...(index.wire().get(family)?.keys() ?? [])].sort(),
    wireThread: (threadId) =>
      (index.wire().get('thread')?.get(threadId) as HostThreadProjection | undefined) ?? null,
    wireRun: (runId) =>
      (index.wire().get('run')?.get(runId) as HostRunProjection | undefined) ?? null,
    chatPath,
    fileModel: (threadId) => {
      const model: HostThreadRecordFileModel = modelHostThreadRecordFile({ profilePath, threadId })
      if (model.kind !== 'modelled') throw new Error(`file model of ${threadId} is ${model.kind}`)
      if (model.effects.kind !== 'modelled') throw new Error(`file model of ${threadId} is refused`)
      return { kind: 'modelled', revision: model.revision, effects: model.effects }
    }
  }
}

/** A configured single-provider thread; the feeder has drained its setup writes. */
async function seedSingle(h: Harness, title: string): Promise<string> {
  const created = h.store.createThread({ scope: 'global', title })
  const threadId = created.appChatId
  h.store.configureThread({ threadId, providerId: 'codex', modelId: 'gpt-5-codex' })
  await h.feeder.idle()
  expect(h.wireIds('thread')).toContain(threadId)
  return threadId
}

interface EnsembleSeed {
  threadId: string
  roundId: string
  seatIds: [string, string]
  /** The run the first seat's round participant names, a member of the round. */
  seatRunId: string
}

/**
 * An ensemble thread with two seats, a live round whose first seat holds a
 * running run, and that run marked as the round's member. Every family the
 * effect model produces (thread, round, participants, runs) is populated.
 */
function seedEnsembleRecord(h: Harness, title: string): EnsembleSeed {
  const created = h.store.createThread({ scope: 'global', title })
  const threadId = created.appChatId
  h.store.configureThread({ threadId, providerId: 'codex', modelId: 'gpt-5-codex' })
  const ensembled = h.store.setThreadKind({ threadId, targetKind: 'ensemble' })
  const ensemble = ensembled.ensemble as {
    participants: Array<{ id: string; provider: string }>
  }
  expect(ensemble.participants.length).toBeGreaterThanOrEqual(2)
  const [seat1, seat2] = ensemble.participants as [
    { id: string; provider: string },
    { id: string; provider: string }
  ]
  const roundId = `round-${threadId}`
  const seatRunId = `run-${threadId}-seat-1`
  h.store.persistThreadRecord({
    threadId,
    expectedRevision: ensembled.persistenceRevision ?? 0,
    record: {
      ...ensembled,
      ensemble: {
        ...ensemble,
        activeRound: {
          roundId,
          status: 'running',
          startedAt: STARTED_AT,
          activeParticipantId: seat1.id,
          participants: [
            {
              participantId: seat1.id,
              provider: seat1.provider,
              status: 'running',
              runId: seatRunId
            },
            { participantId: seat2.id, provider: seat2.provider, status: 'pending' }
          ]
        }
      },
      runs: [
        {
          runId: seatRunId,
          provider: seat1.provider,
          status: 'running',
          phase: 'streaming',
          startedAt: STARTED_AT,
          ensembleRoundId: roundId
        }
      ]
    }
  })
  return { threadId, roundId, seatIds: [seat1.id, seat2.id], seatRunId }
}

function publishTransfer(profilePath: string, transferId: string, record: unknown) {
  const descriptor = publishHostThreadRecordTransfer({ profilePath, transferId, record })
  const verified = verifyHostThreadRecordTransfer({ profilePath, descriptor })
  return { descriptor, verified, record: decodeHostThreadRecordTransferBody(verified.body) }
}

/** A run whose catalogue summary throws: `runDiff` is read only after the model's guarded projection. */
function poisonedRun(runId: string): Record<string, unknown> {
  const run: Record<string, unknown> = {
    runId,
    provider: 'codex',
    status: 'completed',
    startedAt: STARTED_AT,
    endedAt: ENDED_AT
  }
  Object.defineProperty(run, 'runDiff', {
    enumerable: true,
    get() {
      throw new Error('poisoned run diff')
    }
  })
  return run
}

/**
 * Every object reachable from `root` through own properties, Map entries and
 * Set values (functions and typed arrays are not descended), plus the thread
 * ids of every modelled effect model met on the way.
 */
function reachableFrom(root: object): { visited: Set<object>; modelledFor: string[] } {
  const visited = new Set<object>()
  const modelledFor: string[] = []
  const queue: object[] = [root]
  while (queue.length > 0) {
    const node = queue.pop()!
    if (visited.has(node)) continue
    visited.add(node)
    if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) continue
    const record = node as Record<string, unknown>
    if (
      record.kind === 'modelled' &&
      typeof record.threadId === 'string' &&
      'projection' in record
    ) {
      modelledFor.push(record.threadId)
    }
    const children: unknown[] = []
    if (node instanceof Map) {
      for (const [key, value] of node) children.push(key, value)
    } else if (node instanceof Set) {
      for (const value of node) children.push(value)
    }
    for (const name of Object.getOwnPropertyNames(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, name)
      if (descriptor && 'value' in descriptor) children.push(descriptor.value)
    }
    for (const child of children) {
      if (child !== null && typeof child === 'object' && !visited.has(child)) queue.push(child)
    }
  }
  return { visited, modelledFor }
}

/** The parts of a record the pending entry must never reach: the record, its transcript and its runs. */
function recordParts(thread: HostProfileThread): object[] {
  const parts: object[] = [thread, thread.messages, ...thread.messages]
  if (thread.runs) parts.push(thread.runs, ...thread.runs)
  expect(parts.length).toBeGreaterThan(3)
  return parts
}

/** The write happens in its own frame so nothing on the caller's stack keeps the record alive. */
function writeAndForget(
  h: Harness,
  threadId: string
): { thread: WeakRef<object>; messages: WeakRef<object> } {
  const written = h.store.appendTranscript({ threadId, role: 'user', content: 'forgettable' })
  expect(h.hooked.at(-1)).toMatchObject({ threadId, kind: 'run', thread: undefined })
  return { thread: new WeakRef(written), messages: new WeakRef(written.messages) }
}

describe('HostPublicWindowFeeder: eager models from the run port (M4 slice 13c2)', () => {
  describe('1. each run-port write through the real store lands in wire()', () => {
    it('appendTranscript, updateRun and recordRunTool land as the thread’s current rows, without a worker model', async () => {
      const h = harness()
      const threadId = await seedSingle(h, 'Streaming')
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
      const before = h.feeder.counters()
      h.events.length = 0

      // appendTranscript: the thread row's message count follows the transcript.
      const appended = h.store.appendTranscript({ threadId, role: 'user', content: 'hello' })
      expect(h.hooked.at(-1)).toMatchObject({ threadId, kind: 'run' })
      expect(h.hooked.at(-1)!.thread).toBe(appended)
      await h.feeder.idle()
      expect(h.wireThread(threadId)?.messageCount).toBe(1)
      expect(h.wireThread(threadId)).toMatchObject(h.fileModel(threadId).effects.thread)
      expect(h.journalFeedGroups()).toEqual(['feed:1', 'feed:2'])

      // updateRun: the run row appears, live.
      h.store.updateRun({
        threadId,
        runId: 'run-1',
        status: 'running',
        provider: 'codex',
        phase: 'streaming',
        startedAt: STARTED_AT
      })
      expect(h.hooked.at(-1)).toMatchObject({ threadId, kind: 'run' })
      await h.feeder.idle()
      expect(h.wireIds('run')).toEqual(['run-1'])
      expect(h.wireRun('run-1')?.providerOutcome).toBe('running')
      expect(h.journalFeedGroups()).toEqual(['feed:1', 'feed:2', 'feed:3'])

      // recordRunTool: modelled and drained; the run row is the file model's row.
      h.store.recordRunTool({
        threadId,
        runId: 'run-1',
        toolId: 'tool-1',
        toolName: 'Edit',
        phase: 'started'
      })
      expect(h.hooked.at(-1)).toMatchObject({ threadId, kind: 'run' })
      await h.feeder.idle()
      const modelledRuns = h.fileModel(threadId).effects.runs.candidates
      expect(modelledRuns).toHaveLength(1)
      expect(h.wireRun('run-1')).toEqual(modelledRuns[0]!.row)

      // The run ends: the row follows.
      h.store.updateRun({ threadId, runId: 'run-1', status: 'completed', endedAt: ENDED_AT })
      await h.feeder.idle()
      expect(h.wireRun('run-1')?.providerOutcome).toBe('completed')
      expect(h.wireRun('run-1')).toEqual(h.fileModel(threadId).effects.runs.candidates[0]!.row)
      // The tool write changed nothing on the wire: its drain committed the
      // index, spent no group (feed:4's number is consumed), and the end landed as feed:5.
      expect(h.journalFeedGroups()).toEqual(['feed:1', 'feed:2', 'feed:3', 'feed:5'])

      // Four run-port writes: four eager models, no file model, no worker request.
      const runWrites = h.hooked.filter((entry) => entry.kind === 'run')
      expect(runWrites).toHaveLength(4)
      expect(h.feeder.counters().eager - before.eager).toBe(4)
      expect(h.modelled).toEqual([])
      expect(h.events.filter((event) => event.startsWith('model('))).toEqual([])
      expect(h.events.filter((event) => event === 'index:prepare(model)').length).toBe(4)
      expect(h.feeder.counters()).toMatchObject({ failures: 0, refused: 0, ignored: 0 })
      expect(h.feeder.stopped).toBeNull()
    })

    it('every group a run-port write spends is released once durable, after the lock', async () => {
      const h = harness()
      const threadId = await seedSingle(h, 'Ordered')
      h.events.length = 0
      h.store.appendTranscript({ threadId, role: 'user', content: 'one' })
      await h.feeder.idle()
      expect(h.events).toEqual([
        'lock:requested',
        'lock:enter',
        'index:prepare(model)',
        'deltas:appendGroup(feed:2)',
        'lock:exit',
        'deltas:awaitDurable',
        'deltas:releaseGroup(feed:2)'
      ])
      expect(h.deltas.findGroup('feed:2')).toBeNull()
    })
  })

  describe('2. equivalence: the eager model is the file model of the same write', () => {
    it('for every writer kind, on a thread with seats, a live round and a round-member run', async () => {
      const h = harness()
      const seed = seedEnsembleRecord(h, 'Rich')
      const { threadId, roundId, seatRunId } = seed
      // Round-trip a legacy adopt as well: a persist whose record arrives as a verified artifact.
      const compared: string[] = []
      const compare = (label: string): HostThreadRecordModelled => {
        const entry = h.hooked.at(-1)!
        expect(entry.threadId).toBe(threadId)
        expect(entry.thread).toBeDefined()
        const eager = modelHostThreadRecordEffects(entry.thread!)
        const file = h.fileModel(threadId)
        expect(eager.kind).toBe('modelled')
        // The same function over the same object: revision and effects, deep-equal.
        expect({
          kind: 'modelled',
          revision: entry.thread!.persistenceRevision,
          effects: eager
        }).toEqual(file)
        compared.push(`${label}:${entry.kind}`)
        return eager as HostThreadRecordModelled
      }

      // The setup writers ran inside the seed; the last of them is the persist that added the round.
      expect(h.hooked.map((entry) => entry.kind)).toEqual(['record', 'record', 'record', 'record'])
      const persisted = compare('persist')
      expect(persisted.round?.roundId).toBe(roundId)
      expect(persisted.participants.rows.map((row) => row.id).sort()).toEqual(
        [...seed.seatIds].sort()
      )
      expect(persisted.runs.candidates.map((candidate) => candidate.runId)).toEqual([seatRunId])
      expect(persisted.runs.candidates[0]!.roundMember).toBe(true)

      h.store.appendTranscript({ threadId, runId: seatRunId, role: 'assistant', content: 'seat 1' })
      compare('appendTranscript')
      h.store.updateRun({
        threadId,
        runId: seatRunId,
        status: 'running',
        phase: 'streaming',
        usage: { inputTokens: 12, outputTokens: 34 }
      })
      compare('updateRun')
      h.store.recordRunTool({
        threadId,
        runId: seatRunId,
        toolId: 'tool-1',
        toolName: 'Edit',
        phase: 'started'
      })
      compare('recordRunTool')
      h.store.updateRun({ threadId, runId: seatRunId, status: 'completed', endedAt: ENDED_AT })
      const completed = compare('updateRun')
      expect(completed.runs.candidates[0]!.row.providerOutcome).toBe('completed')
      h.store.archiveThread(threadId, true)
      const archived = compare('archiveThread')
      expect(archived.thread.archived).toBe(true)

      const current = h.store.getThread(threadId)!
      const transfer = publishTransfer(h.profilePath, 'adopt-rich', {
        ...current,
        persistenceRevision: (current.persistenceRevision ?? 0) + 1,
        title: 'Rich, adopted'
      })
      h.store.persistThreadRecord({
        threadId,
        record: transfer.record,
        expectedRevision: current.persistenceRevision ?? 0,
        verifiedTransfer: {
          path: transfer.verified.path,
          identity: transfer.verified.identity,
          byteLength: transfer.descriptor.byteLength
        }
      })
      const adopted = compare('adopt')
      expect(adopted.thread.title).toBe('Rich, adopted')

      expect(compared).toEqual([
        'persist:record',
        'appendTranscript:run',
        'updateRun:run',
        'recordRunTool:run',
        'updateRun:run',
        'archiveThread:record',
        'adopt:record'
      ])
      // Each of those wrote once, and every write was modelled at mark.
      expect(h.hooked).toHaveLength(4 + 6)
      expect(h.feeder.counters().eager).toBe(h.hooked.length)

      // And what the feeder published is the last file model's rows.
      await h.feeder.idle()
      expect(h.modelled).toEqual([])
      const last = h.fileModel(threadId).effects
      expect(h.wireThread(threadId)).toMatchObject({ ...last.thread, activeRoundId: roundId })
      expect(h.wireRun(seatRunId)).toEqual(last.runs.candidates[0]!.row)
      expect(h.wireIds('run')).toEqual([seatRunId])
      expect(h.feeder.counters()).toMatchObject({ failures: 0, refused: 0 })
    })
  })

  describe('3. coalescing', () => {
    it('50 run-port writes between drains compute 50 eager models and publish one group holding the latest', async () => {
      const h = harness()
      const threadId = await seedSingle(h, 'Busy')
      const before = h.feeder.counters()
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
      h.modelled.length = 0
      h.hooked.length = 0

      const runIds: string[] = []
      for (let i = 1; i <= 25; i += 1) {
        const runId = `run-${String(i).padStart(2, '0')}`
        runIds.push(runId)
        h.store.updateRun({
          threadId,
          runId,
          status: 'running',
          provider: 'codex',
          phase: 'streaming',
          startedAt: STARTED_AT
        })
        h.store.appendTranscript({ threadId, runId, role: 'assistant', content: `chunk ${i}` })
      }
      expect(h.hooked).toHaveLength(50)
      expect(h.hooked.every((entry) => entry.kind === 'run')).toBe(true)
      // Every write was modelled synchronously, at mark, before the first drain.
      const marked = h.feeder.counters()
      expect(marked.eager - before.eager).toBe(50)
      expect(marked.eagerMs).toBeGreaterThan(before.eagerMs)
      expect(marked.drained).toBe(before.drained)

      await h.feeder.idle()
      expect(h.modelled).toEqual([])
      expect(h.journalFeedGroups()).toEqual(['feed:1', 'feed:2'])
      expect(h.feeder.counters().drained - before.drained).toBe(1)
      // The one group holds the latest model: every run, and the whole transcript.
      expect(h.wireIds('run')).toEqual([...runIds].sort())
      expect(h.wireThread(threadId)?.messageCount).toBe(25)
      expect(h.wireThread(threadId)).toMatchObject(h.fileModel(threadId).effects.thread)
      expect(h.feeder.counters()).toMatchObject({ failures: 0, refused: 0, ignored: 0 })
    })

    it('writes arriving during a drain are modelled at mark and drained next', async () => {
      const h = harness()
      const threadId = await seedSingle(h, 'Held')
      const hold = deferred()
      h.holdLock.promise = hold.promise
      h.store.appendTranscript({ threadId, role: 'user', content: 'first' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(h.events.at(-1)).toBe('lock:requested')
      const eagerBefore = h.feeder.counters().eager
      for (let i = 0; i < 5; i += 1) {
        h.store.appendTranscript({ threadId, role: 'user', content: `held ${i}` })
      }
      expect(h.feeder.counters().eager - eagerBefore).toBe(5)
      h.holdLock.promise = null
      hold.resolve()
      await h.feeder.idle()
      expect(h.journalFeedGroups()).toEqual(['feed:1', 'feed:2', 'feed:3'])
      expect(h.wireThread(threadId)?.messageCount).toBe(6)
      expect(h.modelled).toEqual([])
    })
  })

  describe('4. the pending entry holds the model, not the record', () => {
    it('a structural walk from the feeder meets the thread’s model but never the record, its transcript or its runs', async () => {
      const h = harness()
      const threadId = await seedSingle(h, 'Retained')
      h.store.updateRun({
        threadId,
        runId: 'run-1',
        status: 'running',
        provider: 'codex',
        phase: 'streaming',
        startedAt: STARTED_AT
      })
      await h.feeder.idle()
      // A run-port write: the pending entry now sits in the feeder until the drain's first turn.
      const written = h.store.appendTranscript({
        threadId,
        runId: 'run-1',
        role: 'assistant',
        content: 'x'
      })
      expect(h.hooked.at(-1)!.thread).toBe(written)
      const parts = recordParts(written)
      const walk = reachableFrom(h.feeder)
      // Positive control: the walk reached the retained model of this very thread.
      expect(walk.modelledFor).toContain(threadId)
      expect(walk.visited.size).toBeGreaterThan(parts.length)
      // Negative: none of the record's objects is reachable from the feeder.
      expect(parts.filter((part) => walk.visited.has(part))).toEqual([])
      // Control for the walk itself: the same objects ARE reachable from a holder that retains them.
      const holder = reachableFrom({ hooked: h.hooked })
      expect(parts.filter((part) => holder.visited.has(part))).toEqual(parts)
      await h.feeder.idle()
      expect(h.wireThread(threadId)?.messageCount).toBe(1)
    })

    it('the record is garbage-collectable while its model is still pending under a held lock', async () => {
      v8.setFlagsFromString('--expose_gc')
      const gc = vm.runInNewContext('gc') as () => void
      expect(typeof gc).toBe('function')
      const h = harness({ retainRecords: false })
      const threadId = await seedSingle(h, 'Collectable')
      const hold = deferred()
      h.holdLock.promise = hold.promise
      const refs = writeAndForget(h, threadId)
      expect(refs.thread.deref()).toBeDefined()
      expect(refs.messages.deref()).toBeDefined()
      // The drain took the entry and is waiting for the lock: the model is
      // live in the drain, and a WeakRef's target survives the job it was
      // created in, so wait a macrotask before collecting.
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(h.events.at(-1)).toBe('lock:requested')
      gc()
      await new Promise((resolve) => setTimeout(resolve, 0))
      gc()
      expect(refs.thread.deref()).toBeUndefined()
      expect(refs.messages.deref()).toBeUndefined()
      // The model, not the record, is what publishes.
      h.holdLock.promise = null
      hold.resolve()
      await h.feeder.idle()
      expect(h.wireThread(threadId)?.messageCount).toBe(1)
      expect(h.wireThread(threadId)).toMatchObject(h.fileModel(threadId).effects.thread)
    })
  })

  describe('5. a throwing model', () => {
    it('counts a failure, drops that thread’s pending entry, and the other threads still publish', async () => {
      const h = harness()
      const fragile = await seedSingle(h, 'Fragile')
      const sturdy = await seedSingle(h, 'Sturdy')
      const before = h.feeder.counters()
      h.events.length = 0

      // Both threads have a good pending model; then a record whose model throws replaces Fragile's.
      const goodFragile = h.store.appendTranscript({
        threadId: fragile,
        role: 'user',
        content: 'a'
      })
      h.store.appendTranscript({ threadId: sturdy, role: 'user', content: 'b' })
      const poisoned = {
        ...goodFragile,
        persistenceRevision: (goodFragile.persistenceRevision ?? 0) + 1,
        runs: [poisonedRun('run-poison')]
      } as unknown as HostProfileThread
      expect(() => modelHostThreadRecordEffects(poisoned)).toThrow('poisoned run diff')
      h.feeder.mark(fragile, 'run', poisoned)
      const marked = h.feeder.counters()
      expect(marked.failures - before.failures).toBe(1)
      expect(marked.eager - before.eager).toBe(2)

      await h.feeder.idle()
      expect(h.feeder.stopped).toBeNull()
      // Sturdy landed; Fragile's pending entry (its good write included) was dropped.
      expect(h.wireThread(sturdy)?.messageCount).toBe(1)
      expect(h.wireThread(fragile)?.messageCount).toBe(0)
      expect(h.wireIds('run')).toEqual([])
      expect(h.events.filter((event) => event.startsWith('model('))).toEqual([])
      expect(h.feeder.counters()).toMatchObject({
        failures: before.failures + 1,
        drained: before.drained + 1,
        refused: 0
      })

      // The next write of Fragile marks it again and lands with the whole transcript.
      h.store.appendTranscript({ threadId: fragile, role: 'user', content: 'c' })
      await h.feeder.idle()
      expect(h.wireThread(fragile)?.messageCount).toBe(2)
      expect(h.wireThread(fragile)).toMatchObject(h.fileModel(fragile).effects.thread)
      expect(h.feeder.counters().failures).toBe(before.failures + 1)
    })

    it('a throwing model with nothing else pending publishes nothing and spends no group', async () => {
      const h = harness()
      const threadId = await seedSingle(h, 'Alone')
      const groups = h.journalFeedGroups()
      expect(groups).toEqual(['feed:1'])
      const current = h.store.getThread(threadId)!
      const poisoned = {
        ...current,
        persistenceRevision: (current.persistenceRevision ?? 0) + 1,
        runs: [poisonedRun('run-poison')]
      } as unknown as HostProfileThread
      h.events.length = 0
      h.feeder.mark(threadId, 'run', poisoned)
      expect(h.feeder.counters()).toMatchObject({ failures: 1, eager: 2 })
      await h.feeder.idle()
      expect(h.events).toEqual([])
      expect(h.journalFeedGroups()).toEqual(groups)
      expect(h.wireIds('run')).toEqual([])
      expect(h.feeder.stopped).toBeNull()
    })

    it('an eager model the projection refuses is counted at drain, skipped, and spends no group', async () => {
      const h = harness()
      const threadId = await seedSingle(h, 'Refused')
      const sturdy = await seedSingle(h, 'Sturdy')
      const groups = h.journalFeedGroups()
      const current = h.store.getThread(threadId)!
      // A latest run status the catalogue cannot hold: the donor projection throws, the model refuses.
      const refused = {
        ...current,
        persistenceRevision: (current.persistenceRevision ?? 0) + 1,
        runs: [{ runId: 'run-1', provider: 'codex', status: 's'.repeat(70), startedAt: STARTED_AT }]
      } as unknown as HostProfileThread
      expect(modelHostThreadRecordEffects(refused).kind).toBe('refused')
      const before = h.feeder.counters()
      h.feeder.mark(threadId, 'run', refused)
      h.store.appendTranscript({ threadId: sturdy, role: 'user', content: 'still fine' })
      expect(h.feeder.counters().eager - before.eager).toBe(2)
      await h.feeder.idle()
      expect(h.feeder.counters()).toMatchObject({
        refused: before.refused + 1,
        failures: before.failures,
        drained: before.drained + 1
      })
      expect(h.wireIds('run')).toEqual([])
      expect(h.wireThread(sturdy)?.messageCount).toBe(1)
      expect(h.journalFeedGroups()).toEqual([...groups, `feed:${groups.length + 1}`])
      expect(h.feeder.stopped).toBeNull()
    })
  })
})
