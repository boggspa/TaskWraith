import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHostProductionAuthorityEvaluator } from '../../host-runtime/HostProductionAuthorityEvaluator'

import {
  HOST_THREAD_RECORD_TRANSFER_DIRECTORY,
  consumeHostThreadRecordTransfer
} from '../../host-runtime/HostThreadRecordTransfer'
import type {
  HostActorIdentity,
  HostClientClass,
  HostCommand,
  HostCommandReceipt,
  HostReceiptStatus
} from '../../shared/hostProtocol'
import {
  HOST_PROTOCOL_VERSION,
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  TASKWRAITH_DESKTOP_HOST_CAPABILITIES,
  decodeHostCommand
} from '../../shared/hostProtocol'
import type { ChatRecord } from '../store/types'
import {
  HostThreadRecordPersistClient,
  HostThreadRecordPersistError,
  classifyHostPersistRejection,
  createDesktopHostThreadRecordPersistClient,
  type HostPersistenceDiagnosticOptions,
  type HostPersistenceObservation,
  type HostThreadRecordPersistBrokerPort,
  type HostThreadRecordPersistInput,
  type HostThreadRecordTransferPort
} from './HostThreadRecordPersistCommand'

/**
 * Captures exactly what the PRODUCTION factory composes. Hand-writing an actor
 * here would reproduce the blind spot this suite exists to close: every earlier
 * test injected its own actor, so the factory's real identity was never once
 * run through the real authority gate.
 */
const hoisted = vi.hoisted(() => ({
  brokerOptions: [] as Array<{
    client: { clientId: string; clientClass: string; clientVersion: string }
    actor: { actorId: string; clientId: string; clientClass: string }
    capabilities: readonly string[] | undefined
  }>,
  submitted: [] as Array<Record<string, unknown>>
}))

vi.mock('./HostProjectionBroker', () => ({
  createHostProjectionBroker: (options: {
    client: { clientId: string; clientClass: string; clientVersion: string }
    actor: { actorId: string; clientId: string; clientClass: string }
    capabilities?: readonly string[]
  }) => {
    hoisted.brokerOptions.push({
      client: options.client,
      actor: options.actor,
      capabilities: options.capabilities
    })
    return {
      submitCommand: async (command: Record<string, unknown>) => {
        hoisted.submitted.push(command)
        return {
          ok: true,
          receipt: {
            type: 'host.receipt',
            protocolVersion: command.protocolVersion,
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            name: command.name,
            actor: command.actor,
            authority: 'allow',
            status: 'succeeded',
            commandFingerprint: 'f'.repeat(64),
            generation: 1,
            cursor: 1,
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z'
          }
        }
      },
      lookupReceipt: async () => ({ ok: false, error: 'not used by these tests' }),
      snapshot: async () => ({ ok: false, error: 'not used by these tests' }),
      deltasSince: async () => ({ ok: false, error: 'not used by these tests' }),
      close: () => {}
    }
  }
}))

const PROFILE = '/tmp/tw-persist-profile'

const temporaryProfiles: string[] = []

afterEach(() => {
  for (const profile of temporaryProfiles.splice(0)) {
    rmSync(profile, { recursive: true, force: true })
  }
})

function createRealProfile(): string {
  const profile = mkdtempSync(join(tmpdir(), 'tw-persist-'))
  temporaryProfiles.push(profile)
  return profile
}

function chatRecord(overrides: Record<string, unknown> = {}): ChatRecord {
  return { id: 'chat-1', title: 'Round', messages: [], ...overrides } as unknown as ChatRecord
}

function receiptFor(
  command: HostCommand,
  status: HostReceiptStatus,
  extra: Partial<HostCommandReceipt> = {}
): HostCommandReceipt {
  return {
    type: 'host.receipt',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    name: command.name,
    actor: { ...command.actor },
    authority: 'allow',
    status,
    commandFingerprint: 'f'.repeat(64),
    generation: 1,
    cursor: 1,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    ...extra
  } as HostCommandReceipt
}

/** Records every submitted command and replays a scripted receipt sequence. */
function scriptedBroker(
  script: (command: HostCommand) => Array<HostCommandReceipt | { error: string }>
): HostThreadRecordPersistBrokerPort & { commands: HostCommand[] } {
  const commands: HostCommand[] = []
  const queues = new Map<string, Array<HostCommandReceipt | { error: string }>>()
  const next = (commandId: string) => {
    const queue = queues.get(commandId)
    if (!queue || queue.length === 0) throw new Error(`no scripted receipt for ${commandId}`)
    return queue.length === 1 ? queue[0] : queue.shift()!
  }
  return {
    commands,
    submitCommand: async (command) => {
      commands.push(command)
      queues.set(command.commandId, script(command))
      const value = next(command.commandId)
      return 'error' in value ? { ok: false, error: value.error } : { ok: true, receipt: value }
    },
    lookupReceipt: async (commandId) => {
      const value = next(commandId)
      return 'error' in value ? { ok: false, error: value.error } : { ok: true, receipt: value }
    }
  }
}

function fakeTransfer(
  overrides: Partial<HostThreadRecordTransferPort> = {}
): HostThreadRecordTransferPort & { published: string[]; removed: string[] } {
  const published: string[] = []
  const removed: string[] = []
  return {
    published,
    removed,
    publish: (input) => {
      published.push(input.transferId)
      return { transferId: input.transferId, sha256: 'a'.repeat(64), byteLength: 42 }
    },
    remove: (input) => {
      removed.push(input.transferId)
      return true
    },
    ...overrides
  } as HostThreadRecordTransferPort & { published: string[]; removed: string[] }
}

function createClient(
  broker: HostThreadRecordPersistBrokerPort,
  options: {
    transfer?: HostThreadRecordTransferPort
    profilePath?: string
    nowMs?: () => number
    onPersisted?: (input: HostThreadRecordPersistInput, receipt: HostCommandReceipt) => void
    recoverConflict?: (
      input: HostThreadRecordPersistInput,
      error: HostThreadRecordPersistError,
      attempt: number
    ) => HostThreadRecordPersistInput | null
    maxConflictRetries?: number
  } = {}
): HostThreadRecordPersistClient {
  let id = 0
  return new HostThreadRecordPersistClient({
    broker,
    profilePath: options.profilePath ?? PROFILE,
    transfer: options.transfer ?? fakeTransfer(),
    createId: () => `id-${++id}`,
    wait: async () => {},
    pollIntervalMs: 25,
    timeoutMs: 100,
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(options.onPersisted ? { onPersisted: options.onPersisted } : {}),
    ...(options.recoverConflict ? { recoverConflict: options.recoverConflict } : {}),
    ...(options.maxConflictRetries !== undefined
      ? { maxConflictRetries: options.maxConflictRetries }
      : {})
  })
}

describe('HostThreadRecordPersistClient command shape', () => {
  it('submits a descriptor-only thread.record.persist that the protocol accepts', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const transfer = fakeTransfer()
    const client = createClient(broker, { transfer })

    await client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 3 })

    const [command] = broker.commands
    expect(command.name).toBe('thread.record.persist')
    expect(command.target).toEqual({ threadId: 'chat-1' })
    expect(command.arguments).toEqual({
      transferId: 'id-1',
      sha256: 'a'.repeat(64),
      byteLength: 42,
      expectedRevision: 3
    })
    // The record itself must never ride the bounded control frame.
    expect(JSON.stringify(command.arguments)).not.toContain('messages')
    // Decoded by the real protocol validator, not merely shaped by hand.
    expect(decodeHostCommand(command).ok).toBe(true)
  })

  it('passes through the digest publish returned instead of recomputing it', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const transfer = fakeTransfer({
      publish: (input) => ({ transferId: input.transferId, sha256: 'b'.repeat(64), byteLength: 7 })
    })
    const client = createClient(broker, { transfer })

    await client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })

    expect(broker.commands[0].arguments).toMatchObject({ sha256: 'b'.repeat(64), byteLength: 7 })
  })

  it('generates transfer ids valid under BOTH the wire and artifact bounds', async () => {
    // hostProtocol forbids dots and allows up to 512 chars; the artifact layer
    // allows dots but stops at 128. Only the intersection is safe.
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = new HostThreadRecordPersistClient({
      broker,
      profilePath: PROFILE,
      transfer: fakeTransfer(),
      wait: async () => {}
    })

    await client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })

    const transferId = (broker.commands[0].arguments as { transferId: string }).transferId
    expect(transferId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
    expect(transferId.length).toBeLessThanOrEqual(128)
    expect(transferId).not.toContain('.')
  })

  it('refuses a generated id that only one layer would accept', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = new HostThreadRecordPersistClient({
      broker,
      profilePath: PROFILE,
      transfer: fakeTransfer(),
      createId: () => 'has.a.dot',
      wait: async () => {}
    })

    await expect(
      client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('HostThreadRecordPersistClient failure paths', () => {
  it.each([
    ['a missing chat id', { chatId: '', record: chatRecord(), expectedRevision: 0 }],
    ['a non-object record', { chatId: 'chat-1', record: null, expectedRevision: 0 }],
    ['a negative revision', { chatId: 'chat-1', record: chatRecord(), expectedRevision: -1 }],
    ['a fractional revision', { chatId: 'chat-1', record: chatRecord(), expectedRevision: 1.5 }]
  ])('rejects %s before publishing anything', async (_label, input) => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const transfer = fakeTransfer()
    const client = createClient(broker, { transfer })

    await expect(
      client.persist(input as unknown as Parameters<typeof client.persist>[0])
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(transfer.published).toEqual([])
    expect(broker.commands).toEqual([])
  })

  it('surfaces an artifact publish failure as a typed error', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const transfer = fakeTransfer({
      publish: () => {
        throw new Error('disk full')
      }
    })
    const client = createClient(broker, { transfer })

    await expect(
      client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    ).rejects.toMatchObject({ code: 'artifact_publish_failed' })
    expect(broker.commands).toEqual([])
  })

  it('surfaces a broker outage as host_unavailable', async () => {
    const broker = scriptedBroker(() => [{ error: 'socket closed' }])
    const client = createClient(broker)

    await expect(
      client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    ).rejects.toMatchObject({ code: 'host_unavailable' })
  })

  it('surfaces a never-settling receipt as host_timeout', async () => {
    let clock = 0
    const broker = scriptedBroker((command) => [receiptFor(command, 'pending')])
    const client = createClient(broker, { nowMs: () => (clock += 60) })

    await expect(
      client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    ).rejects.toMatchObject({ code: 'host_timeout' })
  })

  it('classifies a revision mismatch as a retryable conflict and keeps the raw code', async () => {
    const broker = scriptedBroker((command) => [
      receiptFor(command, 'failed', {
        errorCode: 'thread_record_revision_mismatch',
        errorMessage: 'Thread persistence revision mismatch'
      })
    ])
    const client = createClient(broker)

    await expect(
      client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 2 })
    ).rejects.toMatchObject({
      code: 'revision_conflict',
      hostErrorCode: 'thread_record_revision_mismatch'
    })
  })

  it('names a body-free revision conflict instead of exposing a generic failed status', async () => {
    const broker = scriptedBroker((command) => [
      receiptFor(command, 'failed', { errorCode: 'thread_record_revision_conflict' })
    ])
    const client = createClient(broker)

    await expect(
      client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 2 })
    ).rejects.toMatchObject({
      code: 'revision_conflict',
      message: 'Host record persistence revision conflicted.'
    })
  })

  it('classifies an unrelated rejection as host_rejected rather than a conflict', () => {
    const rejection = classifyHostPersistRejection({
      errorCode: 'authority_denied',
      errorMessage: 'Desktop actor required'
    } as unknown as HostCommandReceipt)
    expect(rejection).toEqual({ code: 'host_rejected', hostErrorCode: 'authority_denied' })
  })

  it('names snapshot truncation and diff-position incoherence independently', async () => {
    const before = createClient(
      scriptedBroker((command) => [
        receiptFor(command, 'failed', {
          errorCode: 'pre_execution_before_projection_truncated'
        })
      ])
    )
    await expect(
      before.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    ).rejects.toMatchObject({
      message:
        'Host record persistence was blocked because its command-scoped snapshot was truncated before execution.'
    })

    const after = createClient(
      scriptedBroker((command) => [
        receiptFor(command, 'indeterminate', {
          errorCode: 'observation_diff_cursor_mismatch'
        })
      ])
    )
    await expect(
      after.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    ).rejects.toMatchObject({
      message:
        'Host record persistence executed, but its before/after snapshot position changed; the result is indeterminate.'
    })
  })

  it('rejects a receipt belonging to another command', async () => {
    const broker = scriptedBroker((command) => [
      receiptFor(command, 'succeeded', { commandId: 'someone-elses-command' })
    ])
    const client = createClient(broker)

    await expect(
      client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    ).rejects.toMatchObject({ code: 'invalid_host_receipt' })
  })

  it('removes the staged artifact when the command fails, so nothing leaks', async () => {
    const broker = scriptedBroker(() => [{ error: 'socket closed' }, { error: 'still down' }])
    const transfer = fakeTransfer()
    const client = createClient(broker, { transfer })

    await expect(
      client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    ).rejects.toBeInstanceOf(HostThreadRecordPersistError)

    expect(transfer.published).toEqual(['id-1'])
    expect(transfer.removed).toEqual(['id-1'])
  })

  it('leaves the artifact in place on success — the Host consumes and removes it', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const transfer = fakeTransfer()
    const client = createClient(broker, { transfer })

    await client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })

    expect(transfer.removed).toEqual([])
  })

  it('acknowledges the exact persisted input without letting bookkeeping overturn success', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const onPersisted = vi.fn(() => {
      throw new Error('local bookkeeping failed')
    })
    const client = createClient(broker, { onPersisted })
    const input = { chatId: 'chat-1', record: chatRecord(), expectedRevision: 3 }

    await expect(client.persist(input)).resolves.toMatchObject({ status: 'succeeded' })
    expect(onPersisted).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ status: 'succeeded' })
    )
  })
})

describe('enqueue / drain durability barrier', () => {
  it('accepts a synchronous enqueue and settles it at the barrier', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = createClient(broker)

    client.enqueue({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    expect(client.pending('chat-1')).toBe(1)

    await expect(client.drain('chat-1')).resolves.toBeUndefined()
    expect(client.pending('chat-1')).toBe(0)
    expect(broker.commands).toHaveLength(1)
  })

  it('rethrows the first failure at the barrier instead of losing the write silently', async () => {
    const broker = scriptedBroker(() => [{ error: 'socket closed' }, { error: 'still down' }])
    const client = createClient(broker)

    client.enqueue({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })

    await expect(client.drain('chat-1')).rejects.toMatchObject({ code: 'host_unavailable' })
  })

  it('never throws from enqueue itself, even for invalid input', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = createClient(broker)

    expect(() =>
      client.enqueue({
        chatId: 'chat-1',
        record: null as unknown as ChatRecord,
        expectedRevision: 0
      })
    ).not.toThrow()

    await expect(client.drain('chat-1')).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('coalesces only same-revision snapshots while an earlier entry is in flight', async () => {
    const deferred: { release: () => void } = { release: () => {} }
    const gate = new Promise<void>((resolve) => {
      deferred.release = resolve
    })
    let first = true
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const slowBroker: HostThreadRecordPersistBrokerPort & { commands: HostCommand[] } = {
      commands: broker.commands,
      submitCommand: async (command) => {
        if (first) {
          first = false
          await gate
        }
        return broker.submitCommand(command)
      },
      lookupReceipt: (commandId) => broker.lookupReceipt(commandId)
    }
    const client = createClient(slowBroker)

    client.enqueue({ chatId: 'chat-1', record: chatRecord({ title: 'A' }), expectedRevision: 0 })
    client.enqueue({ chatId: 'chat-1', record: chatRecord({ title: 'B' }), expectedRevision: 0 })
    client.enqueue({ chatId: 'chat-1', record: chatRecord({ title: 'C' }), expectedRevision: 0 })
    deferred.release()
    await client.drain('chat-1')

    // Entry 1 was already in flight; B was superseded by C, so exactly two land.
    expect(slowBroker.commands).toHaveLength(2)
  })

  it('preserves a FIFO chain when queued snapshots depend on different revisions', async () => {
    const deferred: { release: () => void } = { release: () => {} }
    const gate = new Promise<void>((resolve) => {
      deferred.release = resolve
    })
    let first = true
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const slowBroker: HostThreadRecordPersistBrokerPort & { commands: HostCommand[] } = {
      commands: broker.commands,
      submitCommand: async (command) => {
        if (first) {
          first = false
          await gate
        }
        return broker.submitCommand(command)
      },
      lookupReceipt: (commandId) => broker.lookupReceipt(commandId)
    }
    const client = createClient(slowBroker)

    client.enqueue({ chatId: 'chat-1', record: chatRecord({ title: 'A' }), expectedRevision: 0 })
    client.enqueue({ chatId: 'chat-1', record: chatRecord({ title: 'B' }), expectedRevision: 1 })
    client.enqueue({ chatId: 'chat-1', record: chatRecord({ title: 'C' }), expectedRevision: 2 })
    deferred.release()
    await client.drain('chat-1')

    expect(slowBroker.commands.map((command) => command.arguments.expectedRevision)).toEqual([
      0, 1, 2
    ])
  })

  it('rebases a revision conflict inside the save lane before the barrier observes it', async () => {
    let attempts = 0
    const broker = scriptedBroker((command) =>
      attempts++ === 0
        ? [receiptFor(command, 'failed', { errorCode: 'thread_record_revision_conflict' })]
        : [receiptFor(command, 'succeeded')]
    )
    const recoverConflict = vi.fn((input: HostThreadRecordPersistInput) => ({
      ...input,
      expectedRevision: 4,
      record: chatRecord({ title: 'Rebased', persistenceRevision: 5 })
    }))
    const client = createClient(broker, { recoverConflict })

    client.enqueue({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 3 })
    await expect(client.drain('chat-1')).resolves.toBeUndefined()

    expect(recoverConflict).toHaveBeenCalledTimes(1)
    expect(broker.commands.map((command) => command.arguments.expectedRevision)).toEqual([3, 4])
  })

  it('drops queued successors from the failed revision chain before immediate recovery', async () => {
    let attempts = 0
    const broker = scriptedBroker((command) =>
      attempts++ === 0
        ? [receiptFor(command, 'failed', { errorCode: 'thread_record_revision_conflict' })]
        : [receiptFor(command, 'succeeded')]
    )
    const recoverConflict = vi.fn((input: HostThreadRecordPersistInput) => ({
      ...input,
      expectedRevision: 10,
      record: chatRecord({ title: 'Accumulated latest intent', persistenceRevision: 11 })
    }))
    const client = createClient(broker, { recoverConflict })

    client.enqueue({ chatId: 'chat-1', record: chatRecord({ title: 'A' }), expectedRevision: 0 })
    client.enqueue({ chatId: 'chat-1', record: chatRecord({ title: 'B' }), expectedRevision: 1 })
    client.enqueue({ chatId: 'chat-1', record: chatRecord({ title: 'C' }), expectedRevision: 2 })
    await client.drain('chat-1')

    expect(broker.commands.map((command) => command.arguments.expectedRevision)).toEqual([0, 10])
  })

  it('bounds immediate conflict recovery attempts inside the lane', async () => {
    const broker = scriptedBroker((command) => [
      receiptFor(command, 'failed', { errorCode: 'thread_record_revision_conflict' })
    ])
    const recoverConflict = vi.fn((input: HostThreadRecordPersistInput) => ({
      ...input,
      expectedRevision: input.expectedRevision + 1
    }))
    const client = createClient(broker, { recoverConflict, maxConflictRetries: 2 })

    client.enqueue({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    await expect(client.drain('chat-1')).rejects.toMatchObject({ code: 'revision_conflict' })

    expect(recoverConflict).toHaveBeenCalledTimes(2)
    expect(broker.commands).toHaveLength(3)
  })

  it('keeps separate chats independent, and drainAll surfaces a failure', async () => {
    const broker = scriptedBroker((command) =>
      command.target.threadId === 'chat-bad'
        ? [receiptFor(command, 'failed', { errorCode: 'authority_denied' })]
        : [receiptFor(command, 'succeeded')]
    )
    const client = createClient(broker)

    client.enqueue({ chatId: 'chat-ok', record: chatRecord(), expectedRevision: 0 })
    client.enqueue({ chatId: 'chat-bad', record: chatRecord(), expectedRevision: 0 })

    await expect(client.drain('chat-ok')).resolves.toBeUndefined()
    await expect(client.drainAll()).rejects.toMatchObject({ code: 'host_rejected' })
  })

  it('drains a chat that was never enqueued without throwing', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    await expect(createClient(broker).drain('unknown-chat')).resolves.toBeUndefined()
  })

  it('recovers after a failed barrier so later work still persists', async () => {
    let fail = true
    const broker = scriptedBroker((command) =>
      fail
        ? [{ error: 'socket closed' }, { error: 'still down' }]
        : [receiptFor(command, 'succeeded')]
    )
    const client = createClient(broker)

    client.enqueue({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    await expect(client.drain('chat-1')).rejects.toBeInstanceOf(HostThreadRecordPersistError)

    fail = false
    client.enqueue({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 1 })
    await expect(client.drain('chat-1')).resolves.toBeUndefined()
  })
})

describe('integration with the landed transfer primitive', () => {
  it('publishes a real artifact the Host consumer can verify and decode', async () => {
    const profile = createRealProfile()
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = new HostThreadRecordPersistClient({
      broker,
      profilePath: profile,
      createId: () => 'real-transfer-1',
      wait: async () => {}
    })
    const record = chatRecord({
      ensemble: { participants: [{ id: 'p1', order: 0, enabled: true }] },
      unknownFutureField: { keep: 'me' }
    })

    await client.persist({ chatId: 'chat-1', record, expectedRevision: 0 })

    const args = broker.commands[0].arguments as {
      transferId: string
      sha256: string
      byteLength: number
    }
    // The artifact is owner-only and still present: the Host removes it on consume.
    const artifact = join(
      profile,
      HOST_THREAD_RECORD_TRANSFER_DIRECTORY,
      'real-transfer-1.record.json'
    )
    if (process.platform !== 'win32') {
      // NTFS reports 0666; owner-only on Windows is ACL-enforced, not octal.
      expect(statSync(artifact).mode & 0o777).toBe(0o600)
    }

    const consumed = consumeHostThreadRecordTransfer({
      profilePath: profile,
      descriptor: args
    })
    expect(consumed.record).toEqual(record)
    expect(consumed.removed).toBe(true)
    expect(readdirSync(join(profile, HOST_THREAD_RECORD_TRANSFER_DIRECTORY))).toEqual([])
  })

  it('removes the real artifact when the command fails', async () => {
    const profile = createRealProfile()
    const broker = scriptedBroker(() => [{ error: 'socket closed' }, { error: 'still down' }])
    const client = new HostThreadRecordPersistClient({
      broker,
      profilePath: profile,
      createId: () => 'real-transfer-2',
      wait: async () => {}
    })

    await expect(
      client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    ).rejects.toBeInstanceOf(HostThreadRecordPersistError)

    expect(readdirSync(join(profile, HOST_THREAD_RECORD_TRANSFER_DIRECTORY))).toEqual([])
  })
})

describe('client construction', () => {
  it('refuses a missing broker or profile path', () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    expect(
      () =>
        new HostThreadRecordPersistClient({
          broker: undefined as unknown as HostThreadRecordPersistBrokerPort,
          profilePath: PROFILE
        })
    ).toThrow(/requires a Host broker/)
    expect(() => new HostThreadRecordPersistClient({ broker, profilePath: '' })).toThrow(
      /requires a profile path/
    )
  })

  it('uses a desktop actor class so the Host can restrict this command', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = createClient(broker)

    await client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })

    expect(broker.commands[0].actor.clientClass).toBe('desktop')
  })
})

describe('deleteRecord', () => {
  function namesOf(commands: HostCommand[]): string[] {
    return commands.map((command) => command.name)
  }

  it('submits a descriptor-free thread.record.delete the protocol accepts', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = createClient(broker)

    await client.deleteRecord({ chatId: 'chat-1', expectedRevision: 4 })

    const [command] = broker.commands
    expect(command.name).toBe('thread.record.delete')
    expect(command.target).toEqual({ threadId: 'chat-1' })
    // The wire contract is exactly { expectedRevision }; threadId rides the target.
    expect(command.arguments).toEqual({ expectedRevision: 4 })
    expect(decodeHostCommand(command).ok).toBe(true)
  })

  it('NEVER submits a QUEUED persist after a delete — a resurrected chat is silent corruption', async () => {
    // enqueue() starts work synchronously, so a lone enqueue is already
    // SUBMITTED. A genuinely queued entry requires one persist in flight ahead
    // of it — that is the real window where a save can outlive a delete.
    const deferred: { release: () => void } = { release: () => {} }
    const gate = new Promise<void>((resolve) => {
      deferred.release = resolve
    })
    let gateFirst = true
    const base = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const broker: HostThreadRecordPersistBrokerPort & { commands: HostCommand[] } = {
      commands: base.commands,
      submitCommand: async (command) => {
        if (gateFirst && command.name === 'thread.record.persist') {
          gateFirst = false
          await gate
        }
        return base.submitCommand(command)
      },
      lookupReceipt: (commandId) => base.lookupReceipt(commandId)
    }
    const client = createClient(broker)

    client.enqueue({ chatId: 'chat-1', record: chatRecord({ title: 'A' }), expectedRevision: 0 })
    await Promise.resolve()
    // B is genuinely queued behind the in-flight A and has NOT been submitted.
    client.enqueue({ chatId: 'chat-1', record: chatRecord({ title: 'B' }), expectedRevision: 0 })

    const deleting = client.deleteRecord({ chatId: 'chat-1', expectedRevision: 0 })
    deferred.release()
    await deleting
    await client.drain('chat-1')

    // A was already submitted and cannot be recalled; B must never appear.
    expect(namesOf(broker.commands)).toEqual(['thread.record.persist', 'thread.record.delete'])
  })

  it('supersedes a persist enqueued WHILE the delete is in flight', async () => {
    const deferred: { release: () => void } = { release: () => {} }
    const gate = new Promise<void>((resolve) => {
      deferred.release = resolve
    })
    const base = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const broker: HostThreadRecordPersistBrokerPort & { commands: HostCommand[] } = {
      commands: base.commands,
      submitCommand: async (command) => {
        if (command.name === 'thread.record.delete') await gate
        return base.submitCommand(command)
      },
      lookupReceipt: (commandId) => base.lookupReceipt(commandId)
    }
    const client = createClient(broker)

    const deleting = client.deleteRecord({ chatId: 'chat-1', expectedRevision: 0 })
    client.enqueue({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    deferred.release()
    await deleting
    await client.drain('chat-1')

    expect(namesOf(broker.commands)).toEqual(['thread.record.delete'])
  })

  it('lets an ALREADY-SUBMITTED persist settle, then deletes last', async () => {
    // An in-flight command cannot be un-submitted, so the only correct ordering
    // is persist-then-delete: the final durable state is still "deleted".
    const deferred: { release: () => void } = { release: () => {} }
    const gate = new Promise<void>((resolve) => {
      deferred.release = resolve
    })
    const base = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const broker: HostThreadRecordPersistBrokerPort & { commands: HostCommand[] } = {
      commands: base.commands,
      submitCommand: async (command) => {
        if (command.name === 'thread.record.persist') await gate
        return base.submitCommand(command)
      },
      lookupReceipt: (commandId) => base.lookupReceipt(commandId)
    }
    const client = createClient(broker)

    client.enqueue({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    await Promise.resolve()
    const deleting = client.deleteRecord({ chatId: 'chat-1', expectedRevision: 0 })
    deferred.release()
    await deleting

    expect(namesOf(broker.commands)).toEqual(['thread.record.persist', 'thread.record.delete'])
  })

  it('does not resurface a superseded persist failure — the record is gone anyway', async () => {
    let failPersist = true
    const base = scriptedBroker((command) =>
      command.name === 'thread.record.persist' && failPersist
        ? [receiptFor(command, 'failed', { errorCode: 'host_write_failed' })]
        : [receiptFor(command, 'succeeded')]
    )
    const client = createClient(base)

    client.enqueue({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    await Promise.resolve()
    failPersist = false
    await client.deleteRecord({ chatId: 'chat-1', expectedRevision: 0 })

    await expect(client.drain('chat-1')).resolves.toBeUndefined()
  })

  it('allows a legitimate re-create after the delete resolves', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = createClient(broker)

    await client.deleteRecord({ chatId: 'chat-1', expectedRevision: 0 })
    client.enqueue({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })
    await client.drain('chat-1')

    expect(namesOf(broker.commands)).toEqual(['thread.record.delete', 'thread.record.persist'])
  })

  it('treats a Host-reported success for a missing record as idempotent success', async () => {
    const broker = scriptedBroker((command) => [
      receiptFor(command, 'succeeded', { resultSummary: 'thread_record_absent' })
    ])
    const client = createClient(broker)

    await expect(
      client.deleteRecord({ chatId: 'chat-1', expectedRevision: 0 })
    ).resolves.toBeUndefined()
    await expect(
      client.deleteRecord({ chatId: 'chat-1', expectedRevision: 0 })
    ).resolves.toBeUndefined()
  })

  it('surfaces a revision conflict as the typed retryable error', async () => {
    const broker = scriptedBroker((command) => [
      receiptFor(command, 'failed', {
        errorCode: 'thread_record_revision_conflict',
        errorMessage: 'Thread persistence revision mismatch'
      })
    ])
    const client = createClient(broker)

    await expect(
      client.deleteRecord({ chatId: 'chat-1', expectedRevision: 9 })
    ).rejects.toMatchObject({
      code: 'revision_conflict',
      hostErrorCode: 'thread_record_revision_conflict'
    })
  })

  it.each([
    ['a missing chat id', { chatId: '', expectedRevision: 0 }],
    ['a negative revision', { chatId: 'chat-1', expectedRevision: -1 }],
    ['a fractional revision', { chatId: 'chat-1', expectedRevision: 1.5 }]
  ])('rejects %s before submitting anything', async (_label, input) => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = createClient(broker)

    await expect(
      client.deleteRecord(input as { chatId: string; expectedRevision: number })
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(broker.commands).toEqual([])
  })

  it('never publishes a transfer artifact for a delete', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const transfer = fakeTransfer()
    const client = createClient(broker, { transfer })

    await client.deleteRecord({ chatId: 'chat-1', expectedRevision: 0 })

    expect(transfer.published).toEqual([])
  })
})

/**
 * The production factory is what src/main/store/index.ts actually composes.
 * These tests drive THAT function — not a hand-built client — through the REAL
 * HostProductionAuthorityEvaluator, because thread.record.persist is restricted
 * to one exact identity and a mismatch is invisible to any test that supplies
 * its own actor.
 */
describe('production factory identity against the real authority gate', () => {
  async function persistThroughProductionFactory(): Promise<{
    command: HostCommand
    socketClientId: string
    socketClientClass: HostClientClass
    socketClientVersion: string
    brokerActor: HostActorIdentity
    brokerCapabilities: readonly string[] | undefined
  }> {
    const profile = createRealProfile()
    const client = createDesktopHostThreadRecordPersistClient({
      userDataPath: profile,
      appVersion: '1.9.6'
    })
    await client.persist({ chatId: 'chat-1', record: chatRecord(), expectedRevision: 0 })

    const brokerOptions = hoisted.brokerOptions[hoisted.brokerOptions.length - 1]
    const command = hoisted.submitted[hoisted.submitted.length - 1] as unknown as HostCommand
    return {
      command,
      socketClientId: brokerOptions.client.clientId,
      socketClientClass: brokerOptions.client.clientClass as HostClientClass,
      socketClientVersion: brokerOptions.client.clientVersion,
      brokerActor: brokerOptions.actor as HostActorIdentity,
      brokerCapabilities: brokerOptions.capabilities
    }
  }

  it('is ALLOWED by the real production authority evaluator', async () => {
    const composed = await persistThroughProductionFactory()
    expect(composed.command.name).toBe('thread.record.persist')

    // The real gate, not a double: isExactDesktopInternalActor compares the
    // authenticated socket client, the call-context actor, AND command.actor.
    const evaluate = createHostProductionAuthorityEvaluator()
    const evaluation = await evaluate(composed.command, {
      actor: composed.brokerActor,
      client: {
        clientId: composed.socketClientId,
        clientClass: composed.socketClientClass,
        clientVersion: composed.socketClientVersion
      }
    })

    expect(evaluation.decision).toBe('allowed')
  })

  it('composes the canonical desktop identity at all three sites the gate checks', async () => {
    const composed = await persistThroughProductionFactory()

    // 1. authenticated socket client id
    expect(composed.socketClientId).toBe(TASKWRAITH_DESKTOP_HOST_ACTOR.clientId)
    // 2. broker/call-context actor
    expect(composed.brokerActor).toMatchObject({ ...TASKWRAITH_DESKTOP_HOST_ACTOR })
    // 3. command actor
    expect(composed.command.actor).toMatchObject({ ...TASKWRAITH_DESKTOP_HOST_ACTOR })
  })

  /**
   * This client deliberately re-binds the ONE Host session shared by every
   * main-process consumer (HostProjectionBroker: "One authenticated Desktop
   * Host session shared by every main-process consumer"). HostSession.bind
   * only ever RETAINS/NARROWS an existing grant, so a narrower request here
   * silently strips `history`/`snapshot`/`deltas` from the desktop's own
   * session for the whole life of the Host process — thread.catalogue reads
   * then fail `unauthorized` forever and chats never hydrate.
   */
  it('requests the canonical desktop grant so it cannot narrow the shared session', async () => {
    const composed = await persistThroughProductionFactory()

    expect(composed.brokerCapabilities ?? TASKWRAITH_DESKTOP_HOST_CAPABILITIES).toEqual([
      ...TASKWRAITH_DESKTOP_HOST_CAPABILITIES
    ])
    // Named explicitly: these are the capabilities whose loss breaks the app.
    for (const capability of ['history', 'snapshot', 'deltas'] as const) {
      expect(composed.brokerCapabilities ?? TASKWRAITH_DESKTOP_HOST_CAPABILITIES).toContain(
        capability
      )
    }
  })
})

describe('Host persistence local observations', () => {
  function observed(
    script: Parameters<typeof scriptedBroker>[0],
    options: HostPersistenceDiagnosticOptions & {
      transfer?: HostThreadRecordTransferPort
      timeoutMs?: number
      recoverConflict?: (input: HostThreadRecordPersistInput) => HostThreadRecordPersistInput | null
    } = {}
  ) {
    const events: HostPersistenceObservation[] = []
    const calls: string[] = []
    const broker = scriptedBroker(script)
    let clock = 0
    let ids = 0
    let diagnosticIds = 0
    const transfer =
      options.transfer ??
      fakeTransfer({
        publish: ({ transferId }) => {
          calls.push('publish')
          clock += 3
          return { transferId, byteLength: 42, sha256: 'a'.repeat(64) }
        }
      })
    const client = new HostThreadRecordPersistClient({
      profilePath: PROFILE,
      broker: {
        submitCommand: (command) => {
          calls.push('submit')
          clock += 7
          return broker.submitCommand(command)
        },
        lookupReceipt: (commandId) => {
          calls.push('lookup')
          clock += 5
          return broker.lookupReceipt(commandId)
        }
      },
      transfer,
      createId: () => {
        calls.push('id')
        return `id-${++ids}`
      },
      nowMs: () => {
        calls.push('now')
        return clock
      },
      wait: async (requested) => {
        calls.push(`wait:${requested}`)
        clock += requested + 50
      },
      observer: (event) => {
        events.push(event)
      },
      diagnosticNowMs: () => clock,
      diagnosticCreateId: () => `diagnostic-${++diagnosticIds}`,
      ...options
    })
    return { client, broker, transfer, events, calls }
  }

  const request = () => ({
    chatId: 'chat-1',
    expectedRevision: 3,
    record: chatRecord({ messages: [{ content: 'DO-NOT-RECORD-BODY' }] }),
    diagnosticContext: { requestId: 'request-1', roundId: 'round-1' }
  })
  const ends = (events: HostPersistenceObservation[], phase: HostPersistenceObservation['phase']) =>
    events.filter((event) => event.phase === phase && event.outcome !== 'started')

  it('keeps exact operational IDs and immediate receipt behavior with body-free local timing', async () => {
    const { client, broker, events, calls } = observed((command) => [
      receiptFor(command, 'succeeded')
    ])
    await client.persist(request())
    expect(broker.commands[0]).toMatchObject({
      commandId: 'id-2',
      arguments: { transferId: 'id-1' }
    })
    expect(calls).toEqual(['id', 'publish', 'id', 'now', 'submit'])
    expect(ends(events, 'transfer_stage')).toMatchObject([
      { durationMs: 3, bytes: 42, timing: 'measured' }
    ])
    expect(ends(events, 'submit')).toMatchObject([{ durationMs: 7, commandId: 'id-2' }])
    expect(ends(events, 'client_receipt_wait')).toMatchObject([
      {
        durationMs: 7,
        receiptStatus: 'succeeded',
        commandName: 'thread.record.persist'
      }
    ])
    expect(ends(events, 'persist')).toMatchObject([
      { durationMs: 10, context: { requestId: 'request-1' } }
    ])
    expect(
      events.some((event) => ['poll_delay', 'poll_lookup', 'recovery_lookup'].includes(event.phase))
    ).toBe(false)
    expect(JSON.stringify(events)).not.toContain('DO-NOT-RECORD-BODY')
    expect(JSON.stringify(events)).not.toContain(PROFILE)
    expect(JSON.stringify(broker.commands)).not.toContain('diagnostic')
  })

  it('separates requested polling delay from actual local wait and lookup durations', async () => {
    const { client, events, calls } = observed((command) => [
      receiptFor(command, 'pending'),
      receiptFor(command, 'pending'),
      receiptFor(command, 'succeeded')
    ])
    await client.persist(request())
    expect(ends(events, 'poll_delay')).toMatchObject([
      { requestedDelayMs: 250, durationMs: 300 },
      { requestedDelayMs: 250, durationMs: 300 }
    ])
    expect(ends(events, 'poll_lookup')).toMatchObject([{ durationMs: 5 }, { durationMs: 5 }])
    expect(ends(events, 'client_receipt_wait')).toMatchObject([{ durationMs: 617 }])
    expect(calls.filter((call) => call.startsWith('wait'))).toEqual(['wait:250', 'wait:250'])
  })

  it('distinguishes resolved submission failure recovery from a thrown submission', async () => {
    const recovering = observed((command) => [
      { error: 'lost reply' },
      receiptFor(command, 'succeeded')
    ])
    await recovering.client.persist(request())
    expect(ends(recovering.events, 'submit')).toMatchObject([{ outcome: 'failed' }])
    expect(ends(recovering.events, 'recovery_lookup')).toMatchObject([{ outcome: 'succeeded' }])
    const original = new Error('PRIVATE failure')
    const thrown = observed(() => {
      throw original
    })
    await expect(thrown.client.persist(request())).rejects.toBe(original)
    expect(ends(thrown.events, 'submit')).toMatchObject([
      { outcome: 'failed', errorCode: 'unknown' }
    ])
    expect(ends(thrown.events, 'recovery_lookup')).toEqual([])
    expect(JSON.stringify(thrown.events)).not.toContain('PRIVATE')
    expect((thrown.transfer as ReturnType<typeof fakeTransfer>).removed).toEqual(['id-1'])
  })

  it('records staging failure before any command ID exists without consuming an ID', async () => {
    const f = observed(() => [], {
      transfer: fakeTransfer({
        publish: () => {
          throw new Error('disk')
        }
      })
    })
    await expect(f.client.persist(request())).rejects.toMatchObject({
      code: 'artifact_publish_failed'
    })
    expect(f.calls).toEqual(['id'])
    expect(f.broker.commands).toHaveLength(0)
    expect(ends(f.events, 'transfer_stage')).toMatchObject([
      { outcome: 'failed', errorCode: 'artifact_publish_failed' }
    ])
    expect(f.events.every((event) => event.commandId === undefined)).toBe(true)
  })

  it.each(['failed', 'denied', 'cancelled', 'indeterminate', 'conflict'] as const)(
    'keeps validated %s receipt status and original classified error',
    async (status) => {
      const f = observed((command) => [receiptFor(command, status)])
      await expect(f.client.persist(request())).rejects.toMatchObject({
        code: 'host_rejected',
        receipt: { status }
      })
      expect(ends(f.events, 'client_receipt_wait')).toMatchObject([
        { outcome: 'failed', receiptStatus: status }
      ])
    }
  )

  it('does not report mismatched receipts as a validated terminal outcome', async () => {
    const f = observed((command) => [receiptFor(command, 'succeeded', { commandId: 'wrong' })])
    await expect(f.client.persist(request())).rejects.toMatchObject({
      code: 'invalid_host_receipt'
    })
    expect(ends(f.events, 'client_receipt_wait')).toMatchObject([
      { outcome: 'failed', errorCode: 'invalid_host_receipt' }
    ])
    expect(ends(f.events, 'client_receipt_wait')[0].receiptStatus).toBeUndefined()
  })

  it.each(['throw', 'nan', 'backwards'] as const)(
    'contains a %s diagnostic clock and keeps business calls identical',
    async (mode) => {
      const control = observed((command) => [
        receiptFor(command, 'pending'),
        receiptFor(command, 'succeeded')
      ])
      await control.client.persist(request())
      let clock = 1000
      const f = observed(
        (command) => [receiptFor(command, 'pending'), receiptFor(command, 'succeeded')],
        {
          diagnosticNowMs: () => {
            if (mode === 'throw') throw new Error('clock')
            return mode === 'nan' ? NaN : clock--
          }
        }
      )
      await f.client.persist(request())
      expect(f.calls).toEqual(control.calls)
      expect(f.broker.commands).toEqual(control.broker.commands)
      for (const event of f.events.filter((event) => event.outcome !== 'started')) {
        expect(event.durationMs).toBeNull()
        expect(event.timing).toBe('unavailable')
      }
    }
  )

  it('does no diagnostic clock or ID work with the observer absent', async () => {
    const clock = vi.fn(() => {
      throw new Error('must not read')
    })
    const id = vi.fn(() => {
      throw new Error('must not read')
    })
    const f = observed((command) => [receiptFor(command, 'succeeded')], {
      observer: undefined,
      diagnosticNowMs: clock,
      diagnosticCreateId: id
    })
    const entry = request()
    Object.defineProperty(entry, 'diagnosticContext', {
      get: () => {
        throw new Error('not read')
      }
    })
    f.client.enqueue(entry)
    await f.client.drain('chat-1')
    expect(clock).not.toHaveBeenCalled()
    expect(id).not.toHaveBeenCalled()
    expect(f.events).toEqual([])
  })

  it.each(['throw', 'reject'] as const)(
    'contains an observer that will %s on every event',
    async (mode) => {
      const f = observed((command) => [receiptFor(command, 'succeeded')], {
        observer: () => {
          if (mode === 'throw') throw new Error('sink')
          return Promise.reject(new Error('sink'))
        }
      })
      await f.client.persist(request())
      expect(f.calls).toEqual(['id', 'publish', 'id', 'now', 'submit'])
      // Vitest also fails the suite on an unhandled rejected observer promise.
      await Promise.resolve()
    }
  )

  it('keeps null diagnostic IDs honest and bounds copied correlation fields', async () => {
    const f = observed((command) => [receiptFor(command, 'succeeded')], {
      diagnosticCreateId: () => {
        throw new Error('id')
      }
    })
    const context = { requestId: 'request', roundId: 'x'.repeat(257), secret: 'HIDDEN' }
    await f.client.persist({ ...request(), diagnosticContext: context })
    expect(f.events.every((event) => event.operationId === null)).toBe(true)
    expect(f.events[0].context).toEqual({ requestId: 'request' })
    context.requestId = 'changed'
    expect(f.events[0].context?.requestId).toBe('request')
    expect(JSON.stringify(f.events)).not.toContain('HIDDEN')
  })

  it('links superseded queue items and retries without creating phantom commands', async () => {
    let release!: () => void
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    const events: HostPersistenceObservation[] = []
    const commands: HostCommand[] = []
    let id = 0
    let observationId = 0
    const client = new HostThreadRecordPersistClient({
      profilePath: PROFILE,
      transfer: fakeTransfer(),
      createId: () => `id-${++id}`,
      observer: (event) => {
        events.push(event)
      },
      diagnosticCreateId: () => `obs-${++observationId}`,
      broker: {
        submitCommand: async (command) => {
          commands.push(command)
          if (commands.length === 1) await first
          return {
            ok: true,
            receipt: receiptFor(
              command,
              commands.length === 2 ? 'conflict' : 'succeeded',
              commands.length === 2 ? { errorCode: 'revision_conflict' } : {}
            )
          }
        },
        lookupReceipt: async () => ({ ok: false, error: 'unexpected' })
      },
      recoverConflict: (entry) => ({
        chatId: entry.chatId,
        expectedRevision: 4,
        record: entry.record
      })
    })
    client.enqueue(request())
    client.enqueue({ ...request(), diagnosticContext: { requestId: 'B' } })
    client.enqueue({ ...request(), diagnosticContext: { requestId: 'C' } })
    client.enqueue({ ...request(), expectedRevision: 4, diagnosticContext: { requestId: 'D' } })
    const drain = client.drain('chat-1')
    release()
    await drain
    expect(commands.map((command) => command.commandId)).toEqual(['id-2', 'id-4', 'id-6'])
    const enqueues = ends(events, 'enqueue')
    const attempts = events.filter(
      (event) => event.phase === 'persist' && event.outcome === 'started'
    )
    expect(
      attempts.map((event) => [event.context?.requestId, event.attempt, event.parentOperationId])
    ).toEqual([
      ['request-1', 0, enqueues[0].operationId],
      ['C', 0, enqueues[2].operationId],
      ['C', 1, enqueues[2].operationId]
    ])
    expect(ends(events, 'superseded').map((event) => event.relatedOperationId)).toEqual([
      enqueues[1].operationId,
      enqueues[3].operationId
    ])
    expect(ends(events, 'retry')).toHaveLength(1)
    expect(ends(events, 'drain')).toHaveLength(1)
  })

  it('reports a receipt-poll timeout separately from completed poll delays', async () => {
    const f = observed((command) => [receiptFor(command, 'pending')], { timeoutMs: 300 })
    await expect(f.client.persist(request())).rejects.toMatchObject({ code: 'host_timeout' })
    expect(ends(f.events, 'client_receipt_wait')).toMatchObject([
      { outcome: 'failed', errorCode: 'host_timeout' }
    ])
    expect(ends(f.events, 'poll_delay')).toMatchObject([{ outcome: 'succeeded', durationMs: 300 }])
    expect(ends(f.events, 'poll_lookup')).toHaveLength(1)
  })

  it('preserves failed recovery and emits no polling or synthetic terminal receipt', async () => {
    const f = observed(() => [{ error: 'private submit' }, { error: 'private lookup' }])
    await expect(f.client.persist(request())).rejects.toMatchObject({ code: 'host_unavailable' })
    expect(ends(f.events, 'recovery_lookup')).toMatchObject([{ outcome: 'failed' }])
    expect(ends(f.events, 'poll_delay')).toEqual([])
    expect(ends(f.events, 'client_receipt_wait')[0].receiptStatus).toBeUndefined()
    expect(JSON.stringify(f.events)).not.toContain('private')
  })

  it('forwards optional diagnostics through the production factory without changing actor identity', async () => {
    const events: HostPersistenceObservation[] = []
    const client = createDesktopHostThreadRecordPersistClient({
      userDataPath: createRealProfile(),
      appVersion: 'test',
      observer: (event) => {
        events.push(event)
      },
      diagnosticNowMs: () => 5,
      diagnosticCreateId: () => 'factory-observation'
    })
    await client.persist(request())
    expect(ends(events, 'persist')).toMatchObject([
      { operationId: 'factory-observation', durationMs: 0 }
    ])
    expect(hoisted.submitted.at(-1)?.actor).toEqual(TASKWRAITH_DESKTOP_HOST_ACTOR)
  })

  it.each([false, true])(
    'contains outer context failures on direct persist (observer=%s)',
    async (enabled) => {
      const f = observed(
        (command) => [receiptFor(command, 'succeeded')],
        enabled ? {} : { observer: undefined }
      )
      const entry = request()
      let reads = 0
      Object.defineProperty(entry, 'diagnosticContext', {
        get: () => {
          reads += 1
          throw new Error('diagnostic outer getter')
        }
      })
      await expect(f.client.persist(entry)).resolves.toMatchObject({ status: 'succeeded' })
      expect(f.broker.commands).toHaveLength(1)
      expect(f.calls).toEqual(['id', 'publish', 'id', 'now', 'submit'])
      expect(enabled ? reads > 0 : reads === 0).toBe(true)
    }
  )

  it.each([false, true])(
    'preserves a conflict retry despite both outer getters throwing (observer=%s)',
    async (enabled) => {
      const previous = request()
      const recovered = { chatId: previous.chatId, record: previous.record, expectedRevision: 4 }
      let reads = 0
      for (const value of [previous, recovered])
        Object.defineProperty(value, 'diagnosticContext', {
          enumerable: true,
          get: () => {
            reads += 1
            throw new Error('optional metadata')
          }
        })
      // No reconstruction may spread unrelated optional accessors either.
      Object.defineProperty(recovered, 'unrelated', {
        enumerable: true,
        get: () => {
          throw new Error('unrelated')
        }
      })
      let submissions = 0
      const f = observed(
        (command) => [
          receiptFor(
            command,
            ++submissions === 1 ? 'conflict' : 'succeeded',
            submissions === 1 ? { errorCode: 'revision_conflict' } : {}
          )
        ],
        {
          ...(enabled ? {} : { observer: undefined }),
          recoverConflict: () => recovered
        }
      )
      f.client.enqueue(previous)
      await expect(f.client.drain(previous.chatId)).resolves.toBeUndefined()
      expect(f.broker.commands.map((command) => command.commandId)).toEqual(['id-2', 'id-4'])
      expect(f.broker.commands.map((command) => command.arguments.expectedRevision)).toEqual([3, 4])
      expect(f.calls.filter((call) => call === 'id')).toHaveLength(4)
      expect(enabled ? reads > 0 : reads === 0).toBe(true)
    }
  )

  it('keeps the original submission error when reading diagnostic metadata also fails', async () => {
    const original = new Error('real submission')
    const f = observed(() => {
      throw original
    })
    const entry = request()
    Object.defineProperty(entry, 'diagnosticContext', {
      get: () => {
        throw new Error('metadata')
      }
    })
    await expect(f.client.persist(entry)).rejects.toBe(original)
    expect((f.transfer as ReturnType<typeof fakeTransfer>).removed).toEqual(['id-1'])
  })

  it('bounds and contains inner metadata getters reached through an outer accessor', async () => {
    const f = observed((command) => [receiptFor(command, 'succeeded')])
    const entry = request()
    const context = { runId: 'run-safe', requestId: 'x'.repeat(257) }
    Object.defineProperty(context, 'roundId', {
      get: () => {
        throw new Error('inner')
      }
    })
    Object.defineProperty(entry, 'diagnosticContext', { get: () => context })
    await f.client.persist(entry)
    expect(f.events.find((event) => event.phase === 'persist')?.context).toEqual({
      runId: 'run-safe'
    })
  })

  it('contains optional direct-call lineage getters without reading them when unobserved', async () => {
    for (const enabled of [false, true]) {
      let reads = 0
      const lineage = Object.defineProperties(
        {},
        {
          parentOperationId: {
            enumerable: true,
            get: () => {
              reads += 1
              throw new Error('lineage')
            }
          },
          attempt: {
            enumerable: true,
            get: () => {
              reads += 1
              throw new Error('lineage')
            }
          }
        }
      )
      const f = observed(
        (command) => [receiptFor(command, 'succeeded')],
        enabled ? {} : { observer: undefined }
      )
      await expect(f.client.persist(request(), lineage)).resolves.toMatchObject({
        status: 'succeeded'
      })
      expect(f.calls).toEqual(['id', 'publish', 'id', 'now', 'submit'])
      expect(reads).toBe(enabled ? 2 : 0)
    }
  })

  it('does not replace the original error when its diagnostic code getter throws', async () => {
    const original = new HostThreadRecordPersistError('host_rejected', 'real failure')
    Object.defineProperty(original, 'code', {
      get: () => {
        throw new Error('unreadable diagnostic code')
      }
    })
    const f = observed(() => {
      throw original
    })
    await expect(f.client.persist(request())).rejects.toBe(original)
    expect((f.transfer as ReturnType<typeof fakeTransfer>).removed).toEqual(['id-1'])
    expect(ends(f.events, 'persist')).toMatchObject([{ outcome: 'failed', errorCode: 'unknown' }])
  })

  it('labels deletion receipt waits separately from persistence', async () => {
    const f = observed((command) => [receiptFor(command, 'succeeded')])
    await f.client.deleteRecord({ chatId: 'chat-1', expectedRevision: 3 })
    expect(ends(f.events, 'client_receipt_wait')).toMatchObject([
      { commandName: 'thread.record.delete' }
    ])
    expect(ends(f.events, 'persist')).toEqual([])
  })
})
