import { describe, expect, it, vi } from 'vitest'

import {
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  createEmptyHostSnapshot,
  type HostCommand
} from '../../shared/hostProtocol'
import { createHostProjectionBroker, type HostProjectionClientPort } from './HostProjectionBroker'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('HostProjectionBroker', () => {
  it('requires a dedicated broker actor to match its authenticated client identity', () => {
    expect(() =>
      createHostProjectionBroker({
        userDataPath: '/tmp/taskwraith-host-broker-test',
        appVersion: 'test',
        client: {
          clientId: 'thread-kind-client',
          clientClass: 'desktop',
          clientVersion: 'test'
        },
        actor: TASKWRAITH_DESKTOP_HOST_ACTOR,
        createClient: vi.fn()
      })
    ).toThrow('actor must match')
  })

  it('single-flights one authenticated Desktop session across concurrent consumers', async () => {
    const gate = deferred()
    const snapshot = createEmptyHostSnapshot({ generation: 1, cursor: 0 })
    const client: HostProjectionClientPort = {
      connect: vi.fn(() => gate.promise),
      getSnapshot: vi.fn(async () => ({ snapshot })),
      getDeltasSince: vi.fn(async () => ({
        result: {
          kind: 'deltas' as const,
          generation: 1,
          fromCursor: 0,
          toCursor: 0,
          deltas: []
        }
      })),
      submitCommand: vi.fn(),
      lookupReceipt: vi.fn(),
      close: vi.fn()
    }
    const createClient = vi.fn(() => client)
    const broker = createHostProjectionBroker({
      userDataPath: '/tmp/taskwraith-host-broker-test',
      appVersion: 'test',
      createClient
    })

    const snapshotWork = broker.snapshot()
    const deltaWork = broker.deltasSince({ generation: 1, cursor: 0 })
    expect(createClient).toHaveBeenCalledTimes(1)
    gate.resolve()

    await expect(snapshotWork).resolves.toEqual({ ok: true, snapshot })
    await expect(deltaWork).resolves.toMatchObject({ ok: true })
    expect(client.connect).toHaveBeenCalledTimes(1)

    broker.close()
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it('replaces renderer-supplied actor identity before command submission', async () => {
    const submitCommand = vi.fn(async (_command: HostCommand) => {
      throw new Error('stop after actor observation')
    })
    const client = {
      connect: vi.fn(async () => undefined),
      getSnapshot: vi.fn(),
      getDeltasSince: vi.fn(),
      submitCommand,
      lookupReceipt: vi.fn(),
      close: vi.fn()
    } satisfies HostProjectionClientPort
    const broker = createHostProjectionBroker({
      userDataPath: '/tmp/taskwraith-host-broker-test',
      appVersion: 'test',
      createClient: () => client
    })
    const command: HostCommand = {
      type: 'host.command',
      protocolVersion: 2,
      commandId: '1b8ca3b7-f2cd-4997-9a5a-65ec35178ea4',
      idempotencyKey: 'actor-test',
      actor: { actorId: 'renderer', clientId: 'renderer', clientClass: 'test' },
      name: 'ping',
      target: {},
      arguments: {},
      issuedAt: '2026-08-12T00:00:00.000Z'
    }

    await expect(broker.submitCommand(command)).resolves.toMatchObject({ ok: false })
    expect(submitCommand).toHaveBeenCalledWith(
      expect.objectContaining({ actor: TASKWRAITH_DESKTOP_HOST_ACTOR })
    )
  })
})
