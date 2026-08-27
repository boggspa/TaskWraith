import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  HOST_THREAD_RECORD_TRANSFER_DIRECTORY,
  consumeHostThreadRecordTransfer
} from '../../host-runtime/HostThreadRecordTransfer'
import type { HostCommand, HostCommandReceipt, HostReceiptStatus } from '../../shared/hostProtocol'
import { HOST_PROTOCOL_VERSION, decodeHostCommand } from '../../shared/hostProtocol'
import type { ChatRecord } from '../store/types'
import {
  HostThreadRecordPersistClient,
  HostThreadRecordPersistError,
  classifyHostPersistRejection,
  type HostThreadRecordPersistBrokerPort,
  type HostThreadRecordTransferPort
} from './HostThreadRecordPersistCommand'

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
    ...(options.nowMs ? { nowMs: options.nowMs } : {})
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

  it('classifies an unrelated rejection as host_rejected rather than a conflict', () => {
    const rejection = classifyHostPersistRejection({
      errorCode: 'authority_denied',
      errorMessage: 'Desktop actor required'
    } as unknown as HostCommandReceipt)
    expect(rejection).toEqual({ code: 'host_rejected', hostErrorCode: 'authority_denied' })
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

  it('coalesces latest-wins while an earlier entry is still queued', async () => {
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
    expect(statSync(artifact).mode & 0o777).toBe(0o600)

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
