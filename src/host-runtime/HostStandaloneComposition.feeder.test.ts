/**
 * Independent Threads M4 slice 13c1 (design §23.6, tests 2, 3 and 8 at the
 * composition): the standalone composition builds the public window feeder
 * over the transaction's index, publication lock and runtime deltas, and
 * exposes `markThreadRecord`, which the store's `onThreadRecordWritten` hook
 * reaches through a ref set once the composition exists.
 *
 * Flag on: a setup-style write through the real store lands in the runtime's
 * delta store as one `feed:<n>` group whose anchor is released once durable;
 * a delete lands tombstones through a second group; shutdown closes the
 * feeder after the drain in flight. Flag off: no feeder, no `markThreadRecord`,
 * and a hooked write publishes nothing.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HostDeltaEnvelope } from '../shared/hostProtocol'
import { HOST_DELTA_JOURNAL_FILENAME } from './HostDeltaStore'
import { HostProfileDomainStore, type HostThreadRecordWrittenKind } from './HostProfileDomainStore'
import { HostRuntimeBootstrap } from './HostRuntimeBootstrap'
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
import { HOST_TRANSACTION_LOG_FILENAME } from './HostTransactionLog'

const NOW_MS = 1_760_000_000_000
const NOW_ISO = new Date(NOW_MS).toISOString()
const BOOT_EPOCH = 'd'.repeat(64)

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

interface Profile {
  profilePath: string
  runtimePath: string
  store: HostProfileDomainStore
  records: HostThreadRecordCommitPort
  /** What the store hook forwarded, in order. */
  hooked: Array<{ threadId: string; kind: HostThreadRecordWrittenKind }>
  /** The composition the hook forwards to; set by the test once built. */
  composition: { current: HostStandaloneComposition | null }
  /** Model requests the composition made, in order. */
  modelled: string[]
  /** When set, every model awaits it first. */
  modelHold: { promise: Promise<void> | null }
  base: Omit<HostStandaloneCompositionInput, 'threadRecordTransaction'>
  transactionInput(): NonNullable<HostStandaloneCompositionInput['threadRecordTransaction']>
  groupLines(prefix: string): string[]
}

function profile(): Profile {
  const profilePath = mkdtempSync(join(tmpdir(), 'host-standalone-feeder-'))
  roots.push(profilePath)
  const runtimePath = join(profilePath, 'host-data')
  const hooked: Profile['hooked'] = []
  const composition: Profile['composition'] = { current: null }
  let sequence = 0
  const store = new HostProfileDomainStore({
    profilePath,
    authority: { assertProfileAuthority: () => undefined },
    now: () => NOW_MS,
    idFactory: () => `thread-${++sequence}`,
    // The production server's shape: forward through a ref the composition fills.
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
  const modelHold: Profile['modelHold'] = { promise: null }
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
    modelHold,
    base,
    transactionInput: () => ({
      profilePath,
      records,
      prepare: async (input) => prepareHostThreadRecord(input),
      model: async (input: HostThreadRecordModelInput) => {
        modelled.push(input.threadId)
        if (modelHold.promise) await modelHold.promise
        return modelHostThreadRecordFile(input)
      },
      now: () => NOW_MS
    }),
    groupLines: (prefix) => {
      if (!existsSync(journal)) return []
      return readFileSync(journal, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { op: string; commandId?: string })
        .filter((event) => event.op === 'group' && event.commandId?.startsWith(prefix))
        .map((event) => event.commandId!)
    }
  }
}

function describeDelta(envelope: HostDeltaEnvelope): string {
  return `${envelope.kind}:${envelope.family}:${envelope.entityId}`
}

describe('HostStandaloneComposition: the public window feeder (M4 slice 13c1)', () => {
  it('flag on: a setup write through the hooked store lands in the deltas as one feed group, released once durable', async () => {
    const p = profile()
    const composition = createHostStandaloneComposition({
      ...p.base,
      threadRecordTransaction: p.transactionInput()
    })
    p.composition.current = composition
    expect(typeof composition.markThreadRecord).toBe('function')
    const delivered: string[] = []
    const unsubscribe = composition.subscribeDeltas((event) => {
      delivered.push(describeDelta(event.record.envelope))
    })
    let feedLinesBeforeShutdown: string[]
    let positionBeforeShutdown: ReturnType<typeof composition.getPosition>
    let threadId: string
    try {
      // Setup-style writes: create, then configure. Both reach the hook as `record`.
      const created = p.store.createThread({ scope: 'global', title: 'Fed' })
      threadId = created.appChatId
      p.store.configureThread({ threadId, providerId: 'codex', title: 'Fed and configured' })
      expect(p.hooked).toEqual([
        { threadId, kind: 'record' },
        { threadId, kind: 'record' }
      ])
      await vi.waitFor(() => expect(delivered).toContain(`upsert:thread:${threadId}`))
      // The model ran in the composition's seam (the worker in production), once per drain.
      await vi.waitFor(() => expect(p.modelled.length).toBeGreaterThan(0))
      // Let a second drain, if any, settle before counting.
      await new Promise((resolve) => setTimeout(resolve, 50))
      feedLinesBeforeShutdown = p.groupLines('feed:')
      positionBeforeShutdown = composition.getPosition()
    } finally {
      unsubscribe()
      await composition.shutdown()
    }
    expect(p.modelled.every((id) => id === threadId)).toBe(true)
    expect(p.modelled.length).toBeGreaterThanOrEqual(1)
    expect(p.modelled.length).toBeLessThanOrEqual(2)
    // One group per drain, feed-numbered, and the position is past them.
    expect(feedLinesBeforeShutdown!.length).toBe(p.modelled.length)
    expect(feedLinesBeforeShutdown![0]).toBe('feed:1')
    expect(positionBeforeShutdown!.cursor).toBeGreaterThan(0)
    expect(delivered.length).toBeGreaterThan(0)
    expect(delivered).toContain(`upsert:thread:${threadId}`)

    // Reopened: the records are durable at their cursors, and the group's
    // anchor was released (a feed has no receipt), unlike a transaction's.
    const reopened = new HostRuntimeBootstrap({ hostDataDir: p.runtimePath })
    expect(reopened.deltaStore.getPosition()).toEqual(positionBeforeShutdown!)
    for (const commandId of feedLinesBeforeShutdown!) {
      expect(reopened.deltaStore.findGroup(commandId)).toBeNull()
    }
    const stored: string[] = []
    for (let cursor = 1; cursor <= positionBeforeShutdown!.cursor; cursor += 1) {
      const record = reopened.deltaStore.getByCursor(cursor)
      expect(record).not.toBeNull()
      stored.push(describeDelta(record!.envelope))
    }
    expect(stored).toContain(`upsert:thread:${threadId}`)
    const threadRow = reopened.deltaStore.getByCursor(
      stored.lastIndexOf(`upsert:thread:${threadId}`) + 1
    )!.envelope.payload as { title?: string }
    expect(threadRow.title).toBe('Fed and configured')
  })

  it('flag on: a delete through the hooked store removes the thread’s rows through a feed group', async () => {
    const p = profile()
    const composition = createHostStandaloneComposition({
      ...p.base,
      threadRecordTransaction: p.transactionInput()
    })
    p.composition.current = composition
    const delivered: string[] = []
    const unsubscribe = composition.subscribeDeltas((event) => {
      delivered.push(describeDelta(event.record.envelope))
    })
    let feedLines: string[]
    let threadId: string
    try {
      const created = p.store.createThread({ scope: 'global', title: 'Doomed' })
      threadId = created.appChatId
      await vi.waitFor(() => expect(delivered).toContain(`upsert:thread:${threadId}`))
      const revision = p.store.threadRecordState(threadId)!.revision
      expect(p.store.deleteThreadRecord({ threadId, expectedRevision: revision })).toBe(true)
      expect(p.hooked.at(-1)).toEqual({ threadId, kind: 'deleted' })
      await vi.waitFor(() => expect(delivered).toContain(`tombstone:thread:${threadId}`))
      feedLines = p.groupLines('feed:')
    } finally {
      unsubscribe()
      await composition.shutdown()
    }
    expect(feedLines!).toEqual(['feed:1', 'feed:2'])
    expect(delivered.filter((d) => d === `tombstone:thread:${threadId}`)).toHaveLength(1)
    // The delete asked for no model.
    expect(p.modelled).toEqual([threadId])
  })

  it('flag on: shutdown closes the feeder after the drain in flight, and refuses marks after it', async () => {
    const p = profile()
    const composition = createHostStandaloneComposition({
      ...p.base,
      threadRecordTransaction: p.transactionInput()
    })
    p.composition.current = composition
    const hold = deferred()
    p.modelHold.promise = hold.promise
    const created = p.store.createThread({ scope: 'global', title: 'Held' })
    const threadId = created.appChatId
    await vi.waitFor(() => expect(p.modelled).toEqual([threadId]))

    let stopped = false
    const stopping = composition.shutdown().then(() => {
      stopped = true
    })
    // Shutdown waits for the feed in flight before flushing the stores.
    expect(await settledWithin(stopping)).toBe('pending')
    expect(stopped).toBe(false)
    p.modelHold.promise = null
    hold.resolve()
    await stopping
    expect(stopped).toBe(true)

    // The held feed landed and is durable in the reopened runtime.
    const reopened = new HostRuntimeBootstrap({ hostDataDir: p.runtimePath })
    const position = reopened.deltaStore.getPosition()
    expect(position.cursor).toBeGreaterThan(0)
    const stored: string[] = []
    for (let cursor = 1; cursor <= position.cursor; cursor += 1) {
      stored.push(describeDelta(reopened.deltaStore.getByCursor(cursor)!.envelope))
    }
    expect(stored).toContain(`upsert:thread:${threadId}`)

    // After shutdown the hook still forwards, and the closed feeder takes nothing.
    p.store.configureThread({ threadId, title: 'After shutdown' })
    expect(p.hooked.at(-1)).toEqual({ threadId, kind: 'record' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(p.modelled).toEqual([threadId])
  })

  it('flag off: no feeder, no markThreadRecord, and a hooked write publishes nothing', async () => {
    const p = profile()
    const composition = createHostStandaloneComposition({ ...p.base })
    p.composition.current = composition
    expect(composition.markThreadRecord).toBeUndefined()
    const delivered: string[] = []
    const unsubscribe = composition.subscribeDeltas((event) => {
      delivered.push(describeDelta(event.record.envelope))
    })
    let position: ReturnType<typeof composition.getPosition>
    try {
      const created = p.store.createThread({ scope: 'global', title: 'Unfed' })
      p.store.configureThread({ threadId: created.appChatId, title: 'Still unfed' })
      expect(p.hooked).toHaveLength(2)
      await new Promise((resolve) => setTimeout(resolve, 50))
      position = composition.getPosition()
    } finally {
      unsubscribe()
      await composition.shutdown()
    }
    expect(p.modelled).toEqual([])
    expect(delivered).toEqual([])
    expect(position!.cursor).toBe(0)
    expect(p.groupLines('feed:')).toEqual([])
    expect(existsSync(join(p.runtimePath, HOST_TRANSACTION_LOG_FILENAME))).toBe(false)
    const listing = readdirSync(p.runtimePath)
    expect(listing.length).toBeGreaterThan(0)
    expect(listing).not.toContain(HOST_TRANSACTION_LOG_FILENAME)
  })
})
