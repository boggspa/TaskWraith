/**
 * Independent Threads M4 slice 12b (design §22.2, tests §22.5 item 3): the
 * standalone composition wires the transactional persist over real stores.
 *
 * Flag on: one persist goes through the authority's public command entry with
 * the in-process `prepareHostThreadRecord` as `prepare`, over a real
 * `HostProfileDomainStore` profile and the composition's own runtime. The
 * chat file is replaced with the transfer's bytes, the receipt succeeds at the
 * group's end, and exactly one group and one manifest entry exist.
 *
 * Flag off (no `threadRecordTransaction` input): the persist takes today's
 * path and no `host-transactions.jsonl` is ever created.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostAuthenticatedClientIdentity,
  type HostCommand
} from '../shared/hostProtocol'
import type { ThreadCatalogueProjection } from '../shared/threadCatalogueTypes'
import type { HostAuthorityCallContext } from './HostAuthority'
import { HOST_DELTA_JOURNAL_FILENAME } from './HostDeltaStore'
import { HostProfileDomainStore } from './HostProfileDomainStore'
import { HostProfileRecordCommandExecutor } from './HostProfileRecordCommandExecutor'
import { HostRuntimeBootstrap } from './HostRuntimeBootstrap'
import {
  createHostStandaloneComposition,
  type HostStandaloneCompositionInput
} from './HostStandaloneComposition'
import { prepareHostThreadRecord } from './HostThreadRecordPrepare'
import {
  createHostThreadRecordCommitPort,
  type HostThreadRecordCommitPort
} from './HostThreadRecordTransaction'
import {
  hostThreadRecordTransferDirectory,
  hostThreadRecordTransferPath,
  publishHostThreadRecordTransfer
} from './HostThreadRecordTransfer'
import { HOST_TRANSACTION_LOG_FILENAME, HostTransactionLog } from './HostTransactionLog'

const NOW_MS = 1_760_000_000_000
const NOW_ISO = new Date(NOW_MS).toISOString()
const BOOT_EPOCH = 'c'.repeat(64)
const THREAD_ID = 'thread-1'
const TRANSFER_ID = 'transfer-1'

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
  while (roots.length > 0) {
    const root = roots.pop()!
    expect(root).not.toBe(tmpdir())
    expect(root.startsWith(`${tmpdir()}${sep}host-standalone-txn-`)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})

type LooseRecord = Record<string, unknown>

function baseRecord(overrides: LooseRecord = {}): LooseRecord {
  return {
    appChatId: THREAD_ID,
    scope: 'global',
    title: 'Base',
    archived: false,
    createdAt: 10,
    messages: [
      { id: 'm1', role: 'user', content: 'hello there', timestamp: '2026-09-01T00:00:00.000Z' },
      { id: 'm2', role: 'assistant', content: 'general', timestamp: '2026-09-01T00:00:01.000Z' }
    ],
    runs: [
      {
        runId: `run-${THREAD_ID}`,
        provider: 'codex',
        status: 'success',
        startedAt: '2026-09-01T00:00:00.000Z',
        endedAt: '2026-09-01T00:00:01.000Z'
      }
    ],
    updatedAt: 20,
    ...overrides
  }
}

interface Ticket {
  threadId: string
  projection: ThreadCatalogueProjection
  finished: number
  failed: number
}

interface Profile {
  profilePath: string
  runtimePath: string
  chatPath: string
  store: HostProfileDomainStore
  records: HostThreadRecordCommitPort
  tickets: Ticket[]
  executorCalls: HostCommand[]
  base: Omit<HostStandaloneCompositionInput, 'threadRecordTransaction'>
  publish(
    record: LooseRecord,
    transferId?: string
  ): {
    descriptor: { transferId: string; sha256: string; byteLength: number }
    bytes: Buffer
  }
  transferListing(): string[]
  groupLines(commandId: string): number
}

function profile(): Profile {
  const profilePath = mkdtempSync(join(tmpdir(), 'host-standalone-txn-'))
  roots.push(profilePath)
  const runtimePath = join(profilePath, 'host-data')
  const store = new HostProfileDomainStore({
    profilePath,
    authority: { assertProfileAuthority: () => undefined },
    now: () => NOW_MS
  })
  const tickets: Ticket[] = []
  const records = createHostThreadRecordCommitPort({
    store,
    profilePath,
    beginTicket: async (threadId, projection) => {
      const ticket: Ticket = { threadId, projection, finished: 0, failed: 0 }
      tickets.push(ticket)
      return {
        finish: () => {
          ticket.finished += 1
        },
        fail: () => {
          ticket.failed += 1
        }
      }
    }
  })
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
    commandExecutor: (command) => {
      executorCalls.push(command)
      return { status: 'succeeded', resultSummary: 'legacy-persisted' }
    },
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
    chatPath: join(profilePath, 'chats', `${THREAD_ID}.json`),
    store,
    records,
    tickets,
    executorCalls,
    base,
    publish: (record, transferId = TRANSFER_ID) => {
      const descriptor = publishHostThreadRecordTransfer({ profilePath, transferId, record })
      const bytes = readFileSync(hostThreadRecordTransferPath(profilePath, transferId))
      return { descriptor, bytes }
    },
    transferListing: () => {
      const directory = hostThreadRecordTransferDirectory(profilePath)
      return existsSync(directory) ? readdirSync(directory).sort() : []
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
    }
  }
}

function persistCommand(
  commandId: string,
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
    target: { threadId: THREAD_ID },
    arguments: { ...descriptor, expectedRevision },
    issuedAt: NOW_ISO
  }
}

describe('HostStandaloneComposition: transactional persist wiring (M4 slice 12b)', () => {
  it('flag off: carries exact commit evidence from the real executor through receipt lookup and restart', async () => {
    const p = profile()
    p.store.persistThreadRecord({ threadId: THREAD_ID, record: baseRecord(), expectedRevision: 0 })
    const { descriptor } = p.publish(baseRecord({ persistenceRevision: 1 }))
    const executor = new HostProfileRecordCommandExecutor({
      profilePath: p.profilePath,
      store: p.store
    })
    const composition = createHostStandaloneComposition({
      ...p.base,
      commandExecutor: (command) => executor.execute(command)
    })
    const expected = { revision: 1, source: 'verified-transfer', sha256: descriptor.sha256 }
    const command = persistCommand('11111111-1111-4111-8111-111111111111', descriptor, 0)
    try {
      expect(await composition.authority.command(CONTEXT, command)).toMatchObject({
        ok: true,
        value: { status: 'succeeded', threadRecordCommit: expected }
      })
      expect(
        await composition.authority.receipt(CONTEXT, { commandId: command.commandId })
      ).toMatchObject({ ok: true, outcome: 'found', receipt: { threadRecordCommit: expected } })
      expect(await composition.authority.command(CONTEXT, command)).toMatchObject({
        ok: true,
        value: { status: 'succeeded', threadRecordCommit: expected }
      })
    } finally {
      await composition.shutdown()
    }
    const reopened = new HostRuntimeBootstrap({ hostDataDir: p.runtimePath })
    expect(reopened.receiptStore.getByCommandId(command.commandId, ACTOR)).toMatchObject({
      kind: 'found',
      receipt: { threadRecordCommit: expected }
    })
  })

  it('flag on: a persist through the public command entry commits the transfer, publishes one group and succeeds at its end', async () => {
    const p = profile()
    p.store.persistThreadRecord({ threadId: THREAD_ID, record: baseRecord(), expectedRevision: 0 })
    const before = readFileSync(p.chatPath)
    // Stamped ahead of its CAS base: adopted as sent, so the chat file is the transfer's bytes.
    const { descriptor, bytes } = p.publish(
      baseRecord({ persistenceRevision: 1, title: 'Stamped 1' })
    )
    expect(bytes.equals(before)).toBe(false)

    const composition = createHostStandaloneComposition({
      ...p.base,
      threadRecordTransaction: {
        profilePath: p.profilePath,
        records: p.records,
        prepare: async (input) => prepareHostThreadRecord(input)
      }
    })
    let result: Awaited<ReturnType<typeof composition.authority.command>>
    let positionAfter: ReturnType<typeof composition.getPosition>
    let groupLinesBeforeShutdown: number
    try {
      result = await composition.authority.command(
        CONTEXT,
        persistCommand('cmd-txn-1', descriptor, 0)
      )
      positionAfter = composition.getPosition()
      // Shutdown compacts the journal into its checkpoint: count the line now.
      groupLinesBeforeShutdown = p.groupLines('cmd-txn-1')
    } finally {
      await composition.shutdown()
    }

    expect(result).toMatchObject({
      ok: true,
      value: { status: 'succeeded', resultSummary: 'thread_record_persisted' }
    })
    if (!result.ok) throw new Error('unreachable')
    expect(result.value).not.toHaveProperty('threadRecordCommit')
    expect(p.executorCalls).toEqual([])

    // The chat file is the transfer's bytes; the artifact is gone.
    expect(readFileSync(p.chatPath).equals(bytes)).toBe(true)
    expect(p.transferListing()).toEqual([])
    expect(p.store.threadRecordState(THREAD_ID)?.revision).toBe(1)

    // The ticket finished; the manifest holds prepare then published.
    expect(p.tickets).toHaveLength(1)
    expect(p.tickets[0]).toMatchObject({ threadId: THREAD_ID, finished: 1, failed: 0 })
    expect(existsSync(join(p.runtimePath, HOST_TRANSACTION_LOG_FILENAME))).toBe(true)
    const entry = HostTransactionLog.open({ dataDir: p.runtimePath }).get('cmd-txn-1')
    expect(entry?.prepare).toMatchObject({
      kind: 'prepare',
      commandId: 'cmd-txn-1',
      threadId: THREAD_ID,
      epoch: { hostIncarnation: BOOT_EPOCH, deleteCounter: 0 },
      expectedRevision: 0,
      resultingRevision: 1
    })
    expect(entry?.terminal?.kind).toBe('published')

    // One group, and the receipt at its end, with its class.
    const reopened = new HostRuntimeBootstrap({ hostDataDir: p.runtimePath })
    const group = reopened.deltaStore.findGroup('cmd-txn-1')
    expect(group).not.toBeNull()
    expect(group?.count).toBeGreaterThan(0)
    expect(group?.durable).toBe(true)
    expect(groupLinesBeforeShutdown!).toBe(1)
    const end = { generation: group!.end.generation, cursor: group!.end.cursor }
    expect(end.cursor).toBeGreaterThan(0)
    expect({ generation: result.value.generation, cursor: result.value.cursor }).toEqual(end)
    expect({ generation: positionAfter!.generation, cursor: positionAfter!.cursor }).toEqual(end)
    expect(entry?.terminal).toMatchObject({ kind: 'published', position: end })
    const found = reopened.receiptStore.getByCommandId('cmd-txn-1', ACTOR)
    expect(found.kind).toBe('found')
    if (found.kind !== 'found') return
    expect(found.receipt).toMatchObject({
      status: 'succeeded',
      resultSummary: 'thread_record_persisted',
      commandClass: 'txn-record-persist',
      generation: end.generation,
      cursor: end.cursor
    })
  })

  it('flag on: a revision conflict fails the receipt with no group, no commit and the artifact removed', async () => {
    const p = profile()
    p.store.persistThreadRecord({ threadId: THREAD_ID, record: baseRecord(), expectedRevision: 0 })
    const before = readFileSync(p.chatPath)
    const { descriptor } = p.publish(baseRecord({ title: 'Conflicting' }))

    const composition = createHostStandaloneComposition({
      ...p.base,
      threadRecordTransaction: {
        profilePath: p.profilePath,
        records: p.records,
        prepare: async (input) => prepareHostThreadRecord(input)
      }
    })
    let result: Awaited<ReturnType<typeof composition.authority.command>>
    try {
      // The record is at revision 0; a CAS base of 5 cannot match.
      result = await composition.authority.command(
        CONTEXT,
        persistCommand('cmd-conflict', descriptor, 5)
      )
    } finally {
      await composition.shutdown()
    }

    expect(result).toMatchObject({
      ok: true,
      value: { status: 'failed', errorCode: 'thread_record_revision_conflict' }
    })
    expect(p.executorCalls).toEqual([])
    expect(readFileSync(p.chatPath).equals(before)).toBe(true)
    expect(p.transferListing()).toEqual([])
    expect(p.tickets).toEqual([])
    expect(p.groupLines('cmd-conflict')).toBe(0)
    const reopened = new HostRuntimeBootstrap({ hostDataDir: p.runtimePath })
    expect(reopened.deltaStore.findGroup('cmd-conflict')).toBeNull()
    const found = reopened.receiptStore.getByCommandId('cmd-conflict', ACTOR)
    expect(found.kind).toBe('found')
    if (found.kind !== 'found') return
    expect(found.receipt).toMatchObject({
      status: 'failed',
      errorCode: 'thread_record_revision_conflict',
      commandClass: 'txn-record-persist'
    })
  })

  it('flag on: shutdown closes the lanes, so a persist queued behind a holder fails host_shutting_down', async () => {
    const p = profile()
    p.store.persistThreadRecord({ threadId: THREAD_ID, record: baseRecord(), expectedRevision: 0 })
    const first = p.publish(
      baseRecord({ persistenceRevision: 1, title: 'First' }),
      'transfer-first'
    )
    const second = p.publish(
      baseRecord({ persistenceRevision: 2, title: 'Second' }),
      'transfer-second'
    )
    let releaseFirst: () => void = () => undefined
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let prepared = 0
    const before = readFileSync(p.chatPath)
    const composition = createHostStandaloneComposition({
      ...p.base,
      threadRecordTransaction: {
        profilePath: p.profilePath,
        records: p.records,
        prepare: async (input) => {
          prepared += 1
          if (input.descriptor.transferId === 'transfer-first') await firstHeld
          return prepareHostThreadRecord(input)
        }
      }
    })
    const running = composition.authority.command(
      CONTEXT,
      persistCommand('cmd-held', first.descriptor, 0)
    )
    await vi.waitFor(() => expect(prepared).toBe(1))
    const queued = composition.authority.command(
      CONTEXT,
      persistCommand('cmd-queued', second.descriptor, 1)
    )
    // Let the queued persist reach the lane before shutdown starts.
    await new Promise((resolve) => setTimeout(resolve, 20))
    let heldSettled = false
    void running.then(() => {
      heldSettled = true
    })
    let stopped = false
    const stopping = composition.shutdown().then(() => {
      stopped = true
    })
    // Shutdown waits for the transaction in flight before flushing the stores.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stopped).toBe(false)
    releaseFirst()
    const [held, refused] = await Promise.all([running, queued])
    await stopping
    expect(heldSettled).toBe(true)
    // The holder, still in prepare, aborts cleanly at the closed gate: its
    // record is untouched. The queued writer is refused and never prepared.
    expect(held).toMatchObject({
      ok: true,
      value: { status: 'failed', errorCode: 'host_shutting_down' }
    })
    expect(readFileSync(p.chatPath).equals(before)).toBe(true)
    expect(refused).toMatchObject({
      ok: true,
      value: { status: 'failed', errorCode: 'host_shutting_down' }
    })
    expect(prepared).toBe(1)
  })

  it('flag off: the persist takes today’s path and no host-transactions.jsonl is ever created', async () => {
    const p = profile()
    p.store.persistThreadRecord({ threadId: THREAD_ID, record: baseRecord(), expectedRevision: 0 })
    const before = readFileSync(p.chatPath)
    const { descriptor } = p.publish(baseRecord({ persistenceRevision: 1, title: 'Stamped 1' }))

    const composition = createHostStandaloneComposition({ ...p.base })
    let result: Awaited<ReturnType<typeof composition.authority.command>>
    try {
      result = await composition.authority.command(
        CONTEXT,
        persistCommand('cmd-legacy-1', descriptor, 0)
      )
    } finally {
      await composition.shutdown()
    }

    expect(result).toMatchObject({
      ok: true,
      value: { status: 'succeeded', resultSummary: 'legacy-persisted' }
    })
    expect(p.executorCalls.map((command) => command.commandId)).toEqual(['cmd-legacy-1'])
    // The stub executor wrote nothing; the transaction never ran either.
    expect(readFileSync(p.chatPath).equals(before)).toBe(true)
    expect(p.tickets).toEqual([])
    expect(existsSync(join(p.runtimePath, HOST_TRANSACTION_LOG_FILENAME))).toBe(false)
    const listing = readdirSync(p.runtimePath)
    expect(listing.length).toBeGreaterThan(0)
    expect(listing).not.toContain(HOST_TRANSACTION_LOG_FILENAME)
    const reopened = new HostRuntimeBootstrap({ hostDataDir: p.runtimePath })
    const found = reopened.receiptStore.getByCommandId('cmd-legacy-1', ACTOR)
    expect(found.kind).toBe('found')
    if (found.kind !== 'found') return
    expect(found.receipt.status).toBe('succeeded')
    expect(found.receipt).not.toHaveProperty('commandClass')
  })
})
