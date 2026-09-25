/**
 * Independent Threads M4 slice 12b (design §22.3, tests §22.5 items 1 and 2):
 * the authority's class routing for `thread.record.persist` and the delete's
 * lane closure.
 *
 * Item 1 uses a fake transaction: the authority's job is to record the class
 * at `begin`, capture the admit-time epoch, hand the persist to the
 * transaction with the command's descriptor, and answer each outcome from the
 * stored receipt. Item 2 uses a REAL scope ledger with a fake transaction that
 * takes the lane exactly as the real one does, so the delete's `slot.deleted()`
 * is observed through the ledger's own refusals.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostAuthenticatedClientIdentity,
  type HostCommand
} from '../shared/hostProtocol'
import {
  AppStoreHostAuthority,
  createHostStandaloneAuthorityActivationPermit,
  type AppStoreHostAuthorityExecutorResult,
  type AppStoreHostAuthorityPorts,
  type AppStoreHostAuthoritySnapshotDonorFamilies
} from './AppStoreHostAuthority'
import type { HostAuthorityCallContext } from './HostAuthority'
import type { HostCommandReceiptRecord } from './HostCommandReceiptStore'
import { HostRuntimeBootstrap } from './HostRuntimeBootstrap'
import {
  createHostScopeLedger,
  HOST_SCOPE_DELETED_ERROR_CODE,
  HOST_SCOPE_EPOCH_STALE_ERROR_CODE,
  hostThreadScope,
  type HostScopeLedger,
  type HostScopeRefusal
} from './HostScopeLedger'
import type {
  HostThreadRecordTransactionInput,
  HostThreadRecordTransactionOutcome
} from './HostThreadRecordTransaction'

const NOW = '2026-09-25T10:00:00.000Z'
const INCARNATION = 'b'.repeat(64)
const THREAD_ID = 'thread-txn'

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

/** The planned port shape (§22.3); adapt here if the landed name differs. */
type TransactionPort = NonNullable<AppStoreHostAuthorityPorts['threadRecordTransaction']>
type Legacy = () => Promise<unknown>

function donorFamilies(): AppStoreHostAuthoritySnapshotDonorFamilies {
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
    warnings: []
  }
}

function command(
  name: HostCommand['name'],
  commandId: string,
  args: Record<string, unknown>,
  threadId = THREAD_ID
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId,
    idempotencyKey: `${commandId}-key`,
    actor: ACTOR,
    name,
    target: { threadId },
    arguments: args,
    issuedAt: NOW
  }
}

const PERSIST_ARGS = {
  transferId: 'transfer-1',
  sha256: 'a'.repeat(64),
  byteLength: 42,
  expectedRevision: 3
}

function persist(commandId: string, threadId = THREAD_ID): HostCommand {
  return command('thread.record.persist', commandId, PERSIST_ARGS, threadId)
}

function del(commandId: string, threadId = THREAD_ID): HostCommand {
  return command('thread.record.delete', commandId, { expectedRevision: 0 }, threadId)
}

function select(commandId: string): HostCommand {
  return command('thread.select', commandId, {})
}

/** Polls until `condition` holds; fails loudly rather than asserting on a guess. */
async function waitFor(condition: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

type Deferred = { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

interface Execution {
  input: HostThreadRecordTransactionInput
  /** The stored receipt as the transaction first saw it. */
  receiptAtExecute: HostCommandReceiptRecord | null
  legacy: Legacy
}

describe('AppStoreHostAuthority: transactional persist routing (M4 slice 12b)', () => {
  let hostDataDir: string
  let runtime: HostRuntimeBootstrap
  let ledger: HostScopeLedger
  let executorCalls: HostCommand[]
  let executorResult: (command: HostCommand) => AppStoreHostAuthorityExecutorResult
  let executorReceipts: Array<HostCommandReceiptRecord | null>
  let ports: AppStoreHostAuthorityPorts

  beforeEach(() => {
    hostDataDir = mkdtempSync(join(tmpdir(), 'appstore-host-auth-txn-'))
    runtime = new HostRuntimeBootstrap({
      hostDataDir,
      delta: { now: () => NOW },
      receipts: { now: () => NOW }
    })
    ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
    executorCalls = []
    executorReceipts = []
    executorResult = () => ({ status: 'succeeded', resultSummary: 'legacy-persisted' })
    ports = {
      runtime,
      snapshotDonor: () => donorFamilies(),
      authorityEvaluator: () => ({ decision: 'allowed', reason: 'test allow' }),
      commandExecutor: (cmd) => {
        executorCalls.push(cmd)
        executorReceipts.push(stored(cmd.commandId))
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
    rmSync(hostDataDir, { recursive: true, force: true })
  })

  function stored(commandId: string): HostCommandReceiptRecord | null {
    const found = runtime.receiptStore.getByCommandId(commandId, ACTOR)
    return found.kind === 'found' ? found.receipt : null
  }

  function open(overrides: Partial<AppStoreHostAuthorityPorts> = {}): AppStoreHostAuthority {
    const permit = createHostStandaloneAuthorityActivationPermit({ assertHeld: () => undefined })
    return new AppStoreHostAuthority({
      mode: 'standalone',
      activationPermit: permit,
      now: () => NOW,
      ports: {
        ...ports,
        // The transaction port requires a fence (M4 slice 13a); these tests
        // are about routing, so an unfenced pass-through stands in.
        ...(overrides.threadRecordTransaction && !overrides.fence
          ? { fence: <T>(_label: string, operation: () => Promise<T>) => operation() }
          : {}),
        ...overrides
      }
    })
  }

  function position(): { generation: number; cursor: number } {
    const current = runtime.getPosition()
    return { generation: current.generation, cursor: current.cursor }
  }

  function succeed(commandId: string): HostThreadRecordTransactionOutcome {
    const at = position()
    runtime.receiptStore.complete({
      commandId,
      status: 'succeeded',
      completedAt: NOW,
      resultSummary: 'thread_record_persisted',
      position: at
    })
    return { kind: 'succeeded', position: at, publishedRecord: 'durable', refill: [], ignored: [] }
  }

  function failWith(commandId: string, errorCode: string): HostThreadRecordTransactionOutcome {
    runtime.receiptStore.complete({ commandId, status: 'failed', completedAt: NOW, errorCode })
    return { kind: 'failed', errorCode }
  }

  /** A transaction that records what it was handed and answers as told. */
  function fakeTransaction(
    behave: (
      input: HostThreadRecordTransactionInput,
      legacy: Legacy
    ) => Promise<HostThreadRecordTransactionOutcome>
  ): { port: TransactionPort; executions: Execution[]; creates: number; available: boolean } {
    const executions: Execution[] = []
    const self = {
      creates: 0,
      available: true,
      executions,
      port: {
        ledger,
        available: () => self.available,
        create: (legacy: Legacy) => {
          self.creates += 1
          return {
            execute: async (input: HostThreadRecordTransactionInput) => {
              executions.push({ input, receiptAtExecute: stored(input.commandId), legacy })
              return behave(input, legacy)
            }
          }
        }
      } as TransactionPort
    }
    return self
  }

  describe('item 1: the persist begins with its class and routes to the transaction', () => {
    it('begins txn-record-persist, hands the command descriptor and the admit-time epoch over, and never runs the legacy executor', async () => {
      const fake = fakeTransaction(async (input) => succeed(input.commandId))
      const authority = open({ threadRecordTransaction: fake.port })

      const result = await authority.command(CONTEXT, persist('p-1'))

      expect(result).toMatchObject({
        ok: true,
        value: { status: 'succeeded', resultSummary: 'thread_record_persisted' }
      })
      expect(fake.executions).toHaveLength(1)
      const execution = fake.executions[0]!
      expect(execution.input).toEqual({
        commandId: 'p-1',
        threadId: THREAD_ID,
        descriptor: {
          transferId: PERSIST_ARGS.transferId,
          sha256: PERSIST_ARGS.sha256,
          byteLength: PERSIST_ARGS.byteLength
        },
        expectedRevision: PERSIST_ARGS.expectedRevision,
        epoch: ledger.view(hostThreadScope(THREAD_ID)).epoch
      })
      expect(execution.input.epoch).toEqual({ hostIncarnation: INCARNATION, deleteCounter: 0 })
      // The class was durable at begin: the transaction found it on a pending receipt.
      expect(execution.receiptAtExecute).toMatchObject({
        status: 'pending',
        commandClass: 'txn-record-persist',
        commandName: 'thread.record.persist'
      })
      expect(stored('p-1')).toMatchObject({
        status: 'succeeded',
        commandClass: 'txn-record-persist'
      })
      expect(executorCalls).toEqual([])
    })

    it('binds one transaction per persist over the legacy executor', async () => {
      const fake = fakeTransaction(async (input) => succeed(input.commandId))
      const authority = open({ threadRecordTransaction: fake.port })
      await authority.command(CONTEXT, persist('p-a'))
      await authority.command(CONTEXT, persist('p-b'))
      expect(fake.executions.map((e) => e.input.commandId)).toEqual(['p-a', 'p-b'])
      expect(fake.creates).toBeGreaterThanOrEqual(1)
      for (const execution of fake.executions) expect(execution.legacy).toBeTypeOf('function')
    })

    it.each([
      [
        'succeeded',
        (commandId: string) => succeed(commandId),
        { ok: true, value: { status: 'succeeded', resultSummary: 'thread_record_persisted' } }
      ],
      [
        'failed',
        (commandId: string) => failWith(commandId, 'thread_record_revision_conflict'),
        { ok: true, value: { status: 'failed', errorCode: 'thread_record_revision_conflict' } }
      ],
      [
        'indeterminate',
        (commandId: string): HostThreadRecordTransactionOutcome => {
          runtime.receiptStore.markIndeterminate({
            commandId,
            position: position(),
            errorCode: 'transaction_commit_indeterminate'
          })
          return { kind: 'indeterminate', reason: 'rename_indeterminate' }
        },
        {
          ok: true,
          value: { status: 'indeterminate', errorCode: 'transaction_commit_indeterminate' }
        }
      ]
    ] as const)('answers a %s outcome from the stored receipt', async (kind, behave, answer) => {
      const fake = fakeTransaction(async (input) => behave(input.commandId))
      const authority = open({ threadRecordTransaction: fake.port })

      const result = await authority.command(CONTEXT, persist(`p-${kind}`))

      expect(result).toMatchObject(answer)
      if (!result.ok) throw new Error('unreachable')
      const record = stored(`p-${kind}`)
      expect(record).not.toBeNull()
      expect(record?.commandClass).toBe('txn-record-persist')
      expect({ generation: result.value.generation, cursor: result.value.cursor }).toEqual({
        generation: record?.generation,
        cursor: record?.cursor
      })
      expect(fake.executions).toHaveLength(1)
      expect(executorCalls).toEqual([])
    })

    it('answers fail-stopped as host_unavailable and leaves the receipt pending', async () => {
      const fake = fakeTransaction(async () => ({ kind: 'fail-stopped', detail: 'journal' }))
      const authority = open({ threadRecordTransaction: fake.port })

      const result = await authority.command(CONTEXT, persist('p-fs'))

      expect(result).toEqual({ ok: false, error: 'host_unavailable' })
      expect(fake.executions).toHaveLength(1)
      expect(stored('p-fs')).toMatchObject({
        status: 'pending',
        commandClass: 'txn-record-persist'
      })
      expect(executorCalls).toEqual([])
    })

    it('a legacy outcome ran the legacy path once, which completed the receipt itself', async () => {
      const fake = fakeTransaction(async (_input, legacy) => ({
        kind: 'legacy',
        result: await legacy()
      }))
      const authority = open({ threadRecordTransaction: fake.port })

      const result = await authority.command(CONTEXT, persist('p-legacy'))

      expect(result).toMatchObject({
        ok: true,
        value: { status: 'succeeded', resultSummary: 'legacy-persisted' }
      })
      expect(fake.executions).toHaveLength(1)
      expect(executorCalls.map((cmd) => cmd.commandId)).toEqual(['p-legacy'])
      // The receipt was still open when the legacy executor ran; the legacy
      // path's completion is the one the answer projects.
      expect(executorReceipts).toHaveLength(1)
      expect(executorReceipts[0]?.status).toBe('pending')
      expect(stored('p-legacy')).toMatchObject({
        status: 'succeeded',
        resultSummary: 'legacy-persisted'
      })
    })

    it('other commands begin with no class and take the legacy executor, even with the transaction wired', async () => {
      const fake = fakeTransaction(async (input) => succeed(input.commandId))
      const authority = open({ threadRecordTransaction: fake.port })

      const selected = await authority.command(CONTEXT, select('s-1'))

      expect(selected).toMatchObject({ ok: true, value: { status: 'succeeded' } })
      expect(executorCalls.map((cmd) => cmd.commandId)).toEqual(['s-1'])
      expect(fake.executions).toEqual([])
      const record = stored('s-1')
      expect(record?.status).toBe('succeeded')
      expect(record).not.toHaveProperty('commandClass')
    })

    it('the persist with the transaction absent begins with no class and takes the legacy executor', async () => {
      const authority = open()

      const result = await authority.command(CONTEXT, persist('p-off'))

      expect(result).toMatchObject({
        ok: true,
        value: { status: 'succeeded', resultSummary: 'legacy-persisted' }
      })
      expect(executorCalls.map((cmd) => cmd.commandId)).toEqual(['p-off'])
      const record = stored('p-off')
      expect(record?.status).toBe('succeeded')
      expect(record).not.toHaveProperty('commandClass')
    })

    it('a transaction that reports unavailable (fail-stopped manifest) sends the persist down the legacy path with no class', async () => {
      // Landed beyond §22.3: `available()` on the port. Off, the persist runs
      // exactly as with the transaction absent, until the Host restarts.
      const fake = fakeTransaction(async (input) => succeed(input.commandId))
      fake.available = false
      const authority = open({ threadRecordTransaction: fake.port })

      const result = await authority.command(CONTEXT, persist('p-unavailable'))

      expect(result).toMatchObject({
        ok: true,
        value: { status: 'succeeded', resultSummary: 'legacy-persisted' }
      })
      expect(fake.executions).toEqual([])
      expect(executorCalls.map((cmd) => cmd.commandId)).toEqual(['p-unavailable'])
      const record = stored('p-unavailable')
      expect(record?.status).toBe('succeeded')
      expect(record).not.toHaveProperty('commandClass')
    })

    it('a denied persist still records the class at begin and never reaches the transaction', async () => {
      const fake = fakeTransaction(async (input) => succeed(input.commandId))
      const authority = open({
        threadRecordTransaction: fake.port,
        authorityEvaluator: () => ({ decision: 'denied', reason: 'no' })
      })

      const result = await authority.command(CONTEXT, persist('p-denied'))

      expect(result).toMatchObject({ ok: true, value: { status: 'denied' } })
      expect(stored('p-denied')).toMatchObject({
        status: 'denied',
        commandClass: 'txn-record-persist'
      })
      expect(fake.executions).toEqual([])
      expect(executorCalls).toEqual([])
    })
  })

  describe('item 2: the delete closes the lane', () => {
    let refusals: Array<{ commandId: string; reason: HostScopeRefusal }>
    let holds: Map<string, Promise<void>>
    let deleteResult: AppStoreHostAuthorityExecutorResult

    beforeEach(() => {
      refusals = []
      holds = new Map()
      deleteResult = { status: 'succeeded', resultSummary: 'thread_record_deleted' }
      executorResult = (cmd) =>
        cmd.name === 'thread.record.delete'
          ? deleteResult
          : { status: 'succeeded', resultSummary: 'legacy-persisted' }
    })

    /** A transaction that takes the lane as the real one does (§21.2 step 1). */
    function laneTransaction(): ReturnType<typeof fakeTransaction> {
      return fakeTransaction(async (input) => {
        const acquired = await ledger.acquire(hostThreadScope(input.threadId), {
          owner: input.commandId,
          epoch: input.epoch
        })
        if (!acquired.ok) {
          refusals.push({ commandId: input.commandId, reason: acquired.reason })
          const errorCode =
            acquired.reason === 'epoch_stale'
              ? HOST_SCOPE_EPOCH_STALE_ERROR_CODE
              : acquired.reason === 'deleted'
                ? HOST_SCOPE_DELETED_ERROR_CODE
                : 'host_shutting_down'
          return failWith(input.commandId, errorCode)
        }
        try {
          const hold = holds.get(input.commandId)
          if (hold) await hold
          return succeed(input.commandId)
        } finally {
          acquired.slot.release()
        }
      })
    }

    function lane(threadId = THREAD_ID): ReturnType<HostScopeLedger['view']> {
      return ledger.view(hostThreadScope(threadId))
    }

    function deleteCalls(): HostCommand[] {
      return executorCalls.filter((cmd) => cmd.name === 'thread.record.delete')
    }

    it('a committed delete closes the lane, so a later persist fails thread_record_gone', async () => {
      const fake = laneTransaction()
      const authority = open({ threadRecordTransaction: fake.port })

      const deleted = await authority.command(CONTEXT, del('d-1'))
      expect(deleted).toMatchObject({
        ok: true,
        value: { status: 'succeeded', resultSummary: 'thread_record_deleted' }
      })
      expect(deleteCalls().map((cmd) => cmd.commandId)).toEqual(['d-1'])
      const record = stored('d-1')
      expect(record?.status).toBe('succeeded')
      expect(record).not.toHaveProperty('commandClass')
      expect(lane()).toMatchObject({
        deleted: true,
        owner: null,
        waiting: 0,
        epoch: { hostIncarnation: INCARNATION, deleteCounter: 1 }
      })

      const later = await authority.command(CONTEXT, persist('p-after'))
      expect(later).toMatchObject({
        ok: true,
        value: { status: 'failed', errorCode: HOST_SCOPE_DELETED_ERROR_CODE }
      })
      expect(refusals).toEqual([{ commandId: 'p-after', reason: 'deleted' }])
      expect(stored('p-after')).toMatchObject({
        status: 'failed',
        errorCode: 'thread_record_gone',
        commandClass: 'txn-record-persist'
      })
    })

    it('a persist admitted before the delete and queued behind it fails thread_record_epoch_stale', async () => {
      const fake = laneTransaction()
      const authority = open({ threadRecordTransaction: fake.port })
      const hold = deferred()
      holds.set('p-first', hold.promise)
      const scope = hostThreadScope(THREAD_ID)

      const first = authority.command(CONTEXT, persist('p-first'))
      await waitFor(
        () => ledger.view(scope).owner === 'p-first',
        'the first persist to hold the lane'
      )

      const remove = authority.command(CONTEXT, del('d-mid'))
      await waitFor(() => ledger.view(scope).waiting === 1, 'the delete to queue behind it')
      expect(deleteCalls()).toEqual([])

      // Admitted while the delete waits: its epoch is the pre-delete epoch.
      const second = authority.command(CONTEXT, persist('p-second'))
      await waitFor(() => ledger.view(scope).waiting === 2, 'the second persist to queue')
      expect(fake.executions.map((e) => e.input.commandId)).toEqual(['p-first', 'p-second'])
      expect(fake.executions[1]!.input.epoch).toEqual({
        hostIncarnation: INCARNATION,
        deleteCounter: 0
      })

      hold.resolve()
      const [firstResult, removeResult, secondResult] = await Promise.all([first, remove, second])

      expect(firstResult).toMatchObject({ ok: true, value: { status: 'succeeded' } })
      expect(removeResult).toMatchObject({
        ok: true,
        value: { status: 'succeeded', resultSummary: 'thread_record_deleted' }
      })
      expect(secondResult).toMatchObject({
        ok: true,
        value: { status: 'failed', errorCode: HOST_SCOPE_EPOCH_STALE_ERROR_CODE }
      })
      expect(deleteCalls().map((cmd) => cmd.commandId)).toEqual(['d-mid'])
      expect(refusals).toEqual([{ commandId: 'p-second', reason: 'epoch_stale' }])
      expect(stored('p-second')).toMatchObject({
        status: 'failed',
        errorCode: 'thread_record_epoch_stale',
        commandClass: 'txn-record-persist'
      })
      expect(lane()).toMatchObject({ deleted: true, owner: null, waiting: 0 })
      expect(lane().epoch.deleteCounter).toBe(1)
    })

    it('a second delete succeeds with thread_record_already_absent without running the executor again', async () => {
      const fake = laneTransaction()
      const authority = open({ threadRecordTransaction: fake.port })

      await authority.command(CONTEXT, del('d-1'))
      const again = await authority.command(CONTEXT, del('d-2'))

      expect(again).toMatchObject({
        ok: true,
        value: { status: 'succeeded', resultSummary: 'thread_record_already_absent' }
      })
      expect(deleteCalls().map((cmd) => cmd.commandId)).toEqual(['d-1'])
      expect(stored('d-2')).toMatchObject({
        status: 'succeeded',
        resultSummary: 'thread_record_already_absent'
      })
      expect(lane()).toMatchObject({ deleted: true, owner: null, waiting: 0 })
      expect(lane().epoch.deleteCounter).toBe(1)
    })

    it('a delete on a closed ledger fails host_shutting_down before the executor', async () => {
      const fake = laneTransaction()
      const authority = open({ threadRecordTransaction: fake.port })
      ledger.close()

      const result = await authority.command(CONTEXT, del('d-closed'))

      expect(result).toMatchObject({
        ok: true,
        value: { status: 'failed', errorCode: 'host_shutting_down' }
      })
      expect(deleteCalls()).toEqual([])
      expect(stored('d-closed')?.status).toBe('failed')
      expect(lane().deleted).toBe(false)
    })

    it.each([
      ['failed', { status: 'failed', errorCode: 'thread_record_delete_failed' }],
      ['already absent', { status: 'succeeded', resultSummary: 'thread_record_already_absent' }]
    ] as const)(
      'a delete the legacy path answers %s leaves the lane open for a later persist',
      async (_label, answer) => {
        deleteResult = answer
        const fake = laneTransaction()
        const authority = open({ threadRecordTransaction: fake.port })

        const removed = await authority.command(CONTEXT, del('d-soft'))
        expect(removed).toMatchObject({ ok: true, value: answer })
        expect(deleteCalls().map((cmd) => cmd.commandId)).toEqual(['d-soft'])
        expect(lane()).toMatchObject({ deleted: false, owner: null, waiting: 0 })
        expect(lane().epoch.deleteCounter).toBe(0)

        const later = await authority.command(CONTEXT, persist('p-later'))
        expect(later).toMatchObject({
          ok: true,
          value: { status: 'succeeded', resultSummary: 'thread_record_persisted' }
        })
        expect(refusals).toEqual([])
        expect(fake.executions.map((e) => e.input.commandId)).toEqual(['p-later'])
      }
    )

    it('a delete of one thread leaves another thread’s lane untouched', async () => {
      const fake = laneTransaction()
      const authority = open({ threadRecordTransaction: fake.port })

      await authority.command(CONTEXT, del('d-other', 'thread-other'))
      expect(lane('thread-other').deleted).toBe(true)

      const result = await authority.command(CONTEXT, persist('p-this'))
      expect(result).toMatchObject({ ok: true, value: { status: 'succeeded' } })
      expect(refusals).toEqual([])
      expect(lane().deleted).toBe(false)
    })
  })

  describe('lock order: a laned command takes its lane before the projection queue', () => {
    /** A serial projection queue whose current holder the test can see and hold. */
    function heldQueue(): {
      run: NonNullable<AppStoreHostAuthorityPorts['runProjectionOperation']>
      entered: string[]
    } {
      let tail: Promise<unknown> = Promise.resolve()
      const entered: string[] = []
      const run: NonNullable<AppStoreHostAuthorityPorts['runProjectionOperation']> = (
        operation,
        label
      ) => {
        const next = tail.then(() => {
          entered.push(label ?? '<none>')
          return operation()
        })
        tail = next.then(
          () => undefined,
          () => undefined
        )
        return next
      }
      return { run, entered }
    }

    /** thread.select's executor blocks until released: it holds the queue. */
    function blockingSelect(): { release(): void; started: () => boolean } {
      const gate = deferred()
      let started = false
      const inner = ports.commandExecutor
      ports = {
        ...ports,
        commandExecutor: async (cmd, context) => {
          if (cmd.name === 'thread.select') {
            started = true
            await gate.promise
          }
          return inner(cmd, context)
        }
      }
      return { release: () => gate.resolve(), started: () => started }
    }

    it('a transactional persist never waits on a held projection queue', async () => {
      const queue = heldQueue()
      const blocker = blockingSelect()
      const fake = fakeTransaction(async (input) => succeed(input.commandId))
      const authority = open({
        runProjectionOperation: queue.run,
        threadRecordTransaction: fake.port
      })
      const holding = authority.command(CONTEXT, select('s-hold'))
      await waitFor(blocker.started, 'the select to hold the queue')
      const persisted = await authority.command(CONTEXT, persist('p-free'))
      expect(persisted).toMatchObject({ ok: true, value: { status: 'succeeded' } })
      expect(fake.executions).toHaveLength(1)
      blocker.release()
      await holding
    })

    it('a delete takes its lane while the queue is held, and enters the queue after', async () => {
      const queue = heldQueue()
      const blocker = blockingSelect()
      const fake = fakeTransaction(async (input) => succeed(input.commandId))
      const authority = open({
        runProjectionOperation: queue.run,
        threadRecordTransaction: fake.port
      })
      const holding = authority.command(CONTEXT, select('s-hold'))
      await waitFor(blocker.started, 'the select to hold the queue')
      const deleting = authority.command(CONTEXT, del('d-order'))
      await waitFor(
        () => ledger.view(hostThreadScope(THREAD_ID)).owner === 'd-order',
        'the delete to hold its lane'
      )
      expect(executorCalls.filter((cmd) => cmd.name === 'thread.record.delete')).toEqual([])
      blocker.release()
      await holding
      await deleting
      expect(executorCalls.map((cmd) => cmd.commandId)).toEqual(['s-hold', 'd-order'])
      expect(queue.entered.length).toBeGreaterThan(1)
    })

    it('the unsupported fallback runs under the lane, then in the projection queue', async () => {
      const queue = heldQueue()
      const blocker = blockingSelect()
      let legacyDone = false
      const fake = fakeTransaction(async (_input, legacy) => {
        await legacy()
        legacyDone = true
        return { kind: 'legacy', result: undefined }
      })
      const authority = open({
        runProjectionOperation: queue.run,
        threadRecordTransaction: fake.port
      })
      const holding = authority.command(CONTEXT, select('s-hold'))
      await waitFor(blocker.started, 'the select to hold the queue')
      const persisting = authority.command(CONTEXT, persist('p-legacy'))
      await waitFor(() => fake.executions.length === 1, 'the transaction to start')
      await new Promise((resolve) => setTimeout(resolve, 20))
      // Its legacy window waits for the queue.
      expect(legacyDone).toBe(false)
      // The select is still blocked inside its window, so nothing has run yet.
      expect(executorCalls).toEqual([])
      blocker.release()
      await holding
      await persisting
      expect(legacyDone).toBe(true)
      expect(executorCalls.map((cmd) => cmd.commandId)).toEqual(['s-hold', 'p-legacy'])
    })
  })
})
