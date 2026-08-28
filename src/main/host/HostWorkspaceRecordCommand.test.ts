import { describe, expect, it, vi } from 'vitest'

import { createHostProductionAuthorityEvaluator } from '../../host-runtime/HostProductionAuthorityEvaluator'
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
  decodeHostCommand
} from '../../shared/hostProtocol'
import {
  HostWorkspaceRecordClient,
  HostWorkspaceRecordError,
  createDesktopHostWorkspaceRecordClient,
  type HostWorkspaceRecordBrokerPort,
  type HostWorkspaceRecordUpsertInput
} from './HostWorkspaceRecordCommand'

/**
 * Captures exactly what the PRODUCTION factory composes. Hand-writing an actor
 * here would reproduce the blind spot that shipped the 9dcd59d16 blocker: every
 * unit test injected its own identity, so the factory's real identity never once
 * met the real gate.
 */
const hoisted = vi.hoisted(() => ({
  brokerOptions: [] as Array<{
    client: { clientId: string; clientClass: string; clientVersion: string }
    actor: { actorId: string; clientId: string; clientClass: string }
  }>,
  submitted: [] as Array<Record<string, unknown>>
}))

vi.mock('./HostProjectionBroker', () => ({
  createHostProjectionBroker: (options: {
    client: { clientId: string; clientClass: string; clientVersion: string }
    actor: { actorId: string; clientId: string; clientClass: string }
  }) => {
    hoisted.brokerOptions.push({ client: options.client, actor: options.actor })
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
            createdAt: '2026-08-28T00:00:00.000Z',
            updatedAt: '2026-08-28T00:00:00.000Z',
            resultSummary: 'workspace_record_upserted'
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
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...extra
  } as HostCommandReceipt
}

function scriptedBroker(
  script: (command: HostCommand) => Array<HostCommandReceipt | { error: string }>
): HostWorkspaceRecordBrokerPort & { commands: HostCommand[] } {
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

function createClient(
  broker: HostWorkspaceRecordBrokerPort,
  options: { nowMs?: () => number } = {}
): HostWorkspaceRecordClient {
  let id = 0
  return new HostWorkspaceRecordClient({
    broker,
    createId: () => `id-${++id}`,
    wait: async () => {},
    pollIntervalMs: 25,
    timeoutMs: 100,
    ...(options.nowMs ? { nowMs: options.nowMs } : {})
  })
}

function upsertInput(
  overrides: Partial<HostWorkspaceRecordUpsertInput> = {}
): HostWorkspaceRecordUpsertInput {
  return {
    workspaceId: 'ws-1',
    path: '/Users/me/project',
    displayName: 'project',
    createdAt: 1,
    lastOpenedAt: 2,
    pinned: false,
    ...overrides
  }
}

describe('workspace command shapes', () => {
  it('submits an upsert the real protocol decoder accepts', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = createClient(broker)

    await client.upsertWorkspaceRecord(upsertInput())

    const [command] = broker.commands
    expect(command.name).toBe('workspace.record.upsert')
    expect(command.target).toEqual({ workspaceId: 'ws-1' })
    expect(command.arguments).toEqual({
      path: '/Users/me/project',
      displayName: 'project',
      createdAt: 1,
      lastOpenedAt: 2,
      pinned: false
    })
    expect(decodeHostCommand(command).ok).toBe(true)
  })

  it('NEVER asserts realPath — the Host canonicalizes it and the wire forbids it', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = createClient(broker)

    await client.upsertWorkspaceRecord(
      upsertInput({ path: '/var/folders/ws' } as Partial<HostWorkspaceRecordUpsertInput>)
    )

    expect(Object.keys(broker.commands[0].arguments)).not.toContain('realPath')
    // A caller-asserted realPath would be rejected by the wire's key allowlist.
    expect(decodeHostCommand(broker.commands[0]).ok).toBe(true)
  })

  it('omits absent optional metadata so the Host preserves it on partial updates', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = createClient(broker)

    await client.upsertWorkspaceRecord(upsertInput())

    const keys = Object.keys(broker.commands[0].arguments)
    expect(keys).not.toContain('branch')
    expect(keys).not.toContain('geminiWorktree')
  })

  it('sends branch and geminiWorktree when supplied, dropping an absent worktree name', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = createClient(broker)

    await client.upsertWorkspaceRecord(
      upsertInput({ branch: 'main', geminiWorktree: { enabled: true } })
    )

    expect(broker.commands[0].arguments).toMatchObject({
      branch: 'main',
      geminiWorktree: { enabled: true }
    })
    expect(
      Object.keys((broker.commands[0].arguments as { geminiWorktree: object }).geminiWorktree)
    ).toEqual(['enabled'])
    expect(decodeHostCommand(broker.commands[0]).ok).toBe(true)
  })

  it('submits a remove with an empty argument map and a workspace target', async () => {
    const broker = scriptedBroker((command) => [
      receiptFor(command, 'succeeded', { resultSummary: 'workspace_record_removed' })
    ])
    const client = createClient(broker)

    const result = await client.removeWorkspaceRecord('ws-1')

    expect(broker.commands[0].name).toBe('workspace.record.remove')
    expect(broker.commands[0].target).toEqual({ workspaceId: 'ws-1' })
    expect(broker.commands[0].arguments).toEqual({})
    expect(decodeHostCommand(broker.commands[0]).ok).toBe(true)
    expect(result.removed).toBe(true)
  })

  it('submits a clear with BOTH an empty target and empty arguments', async () => {
    const broker = scriptedBroker((command) => [
      receiptFor(command, 'succeeded', { resultSummary: 'workspace_records_cleared' })
    ])
    const client = createClient(broker)

    const result = await client.clearWorkspaceRecords()

    expect(broker.commands[0].name).toBe('workspace.records.clear')
    expect(broker.commands[0].target).toEqual({})
    expect(broker.commands[0].arguments).toEqual({})
    expect(decodeHostCommand(broker.commands[0]).ok).toBe(true)
    expect(result.cleared).toBe(true)
  })
})

describe('idempotence signals', () => {
  it('reports removed=false when the record was already absent', async () => {
    const broker = scriptedBroker((command) => [
      receiptFor(command, 'succeeded', { resultSummary: 'workspace_record_already_absent' })
    ])

    const result = await createClient(broker).removeWorkspaceRecord('ws-1')

    // Still a success — the caller can distinguish, not fail.
    expect(result.removed).toBe(false)
  })

  it('reports cleared=false when the file was already empty', async () => {
    const broker = scriptedBroker((command) => [
      receiptFor(command, 'succeeded', { resultSummary: 'workspace_records_already_empty' })
    ])

    expect((await createClient(broker).clearWorkspaceRecords()).cleared).toBe(false)
  })
})

describe('failure paths', () => {
  it.each([
    ['a missing workspace id', { workspaceId: '' }],
    ['an empty path', { path: '' }],
    ['an empty display name', { displayName: '' }],
    ['a negative createdAt', { createdAt: -1 }],
    ['a fractional lastOpenedAt', { lastOpenedAt: 1.5 }],
    ['a non-boolean pinned', { pinned: 'yes' as unknown as boolean }],
    ['an empty branch', { branch: '' }]
  ])('rejects %s before submitting anything', async (_label, overrides) => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = createClient(broker)

    await expect(client.upsertWorkspaceRecord(upsertInput(overrides))).rejects.toMatchObject({
      code: 'invalid_input'
    })
    expect(broker.commands).toEqual([])
  })

  it('rejects a missing workspace id on remove before submitting anything', async () => {
    const broker = scriptedBroker((command) => [receiptFor(command, 'succeeded')])
    const client = createClient(broker)

    await expect(client.removeWorkspaceRecord('')).rejects.toMatchObject({ code: 'invalid_input' })
    expect(broker.commands).toEqual([])
  })

  it('surfaces a broker outage as host_unavailable', async () => {
    const broker = scriptedBroker(() => [{ error: 'socket closed' }, { error: 'still down' }])

    await expect(createClient(broker).clearWorkspaceRecords()).rejects.toMatchObject({
      code: 'host_unavailable'
    })
  })

  it('surfaces a never-settling receipt as host_timeout', async () => {
    let clock = 0
    const broker = scriptedBroker((command) => [receiptFor(command, 'pending')])

    await expect(
      createClient(broker, { nowMs: () => (clock += 60) }).upsertWorkspaceRecord(upsertInput())
    ).rejects.toMatchObject({ code: 'host_timeout' })
  })

  it('surfaces an authority denial with the raw Host code preserved', async () => {
    const broker = scriptedBroker((command) => [
      receiptFor(command, 'failed', {
        errorCode: 'authority_denied',
        errorMessage: 'Desktop actor required'
      })
    ])

    await expect(createClient(broker).removeWorkspaceRecord('ws-1')).rejects.toMatchObject({
      code: 'host_rejected',
      hostErrorCode: 'authority_denied'
    })
  })

  it('rejects a receipt belonging to another command', async () => {
    const broker = scriptedBroker((command) => [
      receiptFor(command, 'succeeded', { commandId: 'someone-elses-command' })
    ])

    await expect(createClient(broker).upsertWorkspaceRecord(upsertInput())).rejects.toBeInstanceOf(
      HostWorkspaceRecordError
    )
  })

  it('refuses construction without a broker', () => {
    expect(
      () =>
        new HostWorkspaceRecordClient({
          broker: undefined as unknown as HostWorkspaceRecordBrokerPort
        })
    ).toThrow(/requires a Host broker/)
  })
})

/**
 * The production factory is what the store wiring will compose. These drive THAT
 * function through the REAL authority evaluator, because all three commands sit
 * behind the exact-actor gate and a mismatch is invisible to any test that
 * supplies its own actor.
 */
describe('production factory identity against the real authority gate', () => {
  async function composedIdentity(): Promise<{
    command: HostCommand
    socketClientId: string
    socketClientClass: HostClientClass
    socketClientVersion: string
    brokerActor: HostActorIdentity
  }> {
    const client = createDesktopHostWorkspaceRecordClient({
      userDataPath: '/tmp/tw-workspace-profile',
      appVersion: '1.9.6'
    })
    await client.upsertWorkspaceRecord(upsertInput())
    const options = hoisted.brokerOptions[hoisted.brokerOptions.length - 1]
    return {
      command: hoisted.submitted[hoisted.submitted.length - 1] as unknown as HostCommand,
      socketClientId: options.client.clientId,
      socketClientClass: options.client.clientClass as HostClientClass,
      socketClientVersion: options.client.clientVersion,
      brokerActor: options.actor as HostActorIdentity
    }
  }

  it('is ALLOWED by the real production authority evaluator', async () => {
    const composed = await composedIdentity()
    expect(composed.command.name).toBe('workspace.record.upsert')

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
    const composed = await composedIdentity()

    expect(composed.socketClientId).toBe(TASKWRAITH_DESKTOP_HOST_ACTOR.clientId)
    expect(composed.brokerActor).toMatchObject({ ...TASKWRAITH_DESKTOP_HOST_ACTOR })
    expect(composed.command.actor).toMatchObject({ ...TASKWRAITH_DESKTOP_HOST_ACTOR })
  })
})

/**
 * Pins a KNOWN WIRE GAP so it cannot be forgotten. The Host computes and
 * persists realPath (HostProfileDomainStore.upsertWorkspaceRecord) but
 * HostNodeDomainPorts collapses the result to a constant resultSummary and
 * HostWorkspaceProjection has no realPath field — so Desktop cannot adopt the
 * Host's canonical path. When a Host-side slice carries it back, this test
 * should be updated deliberately rather than silently.
 */
describe('known gap: the Host canonical record does not return over the wire', () => {
  it('gives the caller only the constant success token, never a record', async () => {
    const broker = scriptedBroker((command) => [
      receiptFor(command, 'succeeded', { resultSummary: 'workspace_record_upserted' })
    ])

    const receipt = await createClient(broker).upsertWorkspaceRecord(upsertInput())

    expect(receipt.resultSummary).toBe('workspace_record_upserted')
    expect(receipt).not.toHaveProperty('record')
    expect(receipt).not.toHaveProperty('realPath')
  })
})
